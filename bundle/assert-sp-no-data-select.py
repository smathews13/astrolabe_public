#!/usr/bin/env python3
"""Assert the app's service principal cannot read the governed data schema.

WHY THIS EXISTS. The app reads Lakebase as itself and governed tables as the
signed-in caller (agent/execution_identity.py enforces the second at runtime).
That is a design promise, and a promise about a grant is only worth what a
release checks. This is the check.

WHAT MAKES IT DIFFERENT FROM `SHOW GRANTS`. An assertion that reads only DIRECT
grants would pass this deployment today while the capability is wide open, which
is worse than having no assertion at all, because it converts an open door into a
green tick. On 2026-08-17 the app SP's explicit grant on the data schema was
revoked and its read access DID NOT CLOSE: the `account users` group holds
ALL_PRIVILEGES on the catalog, every service principal in the account is in that
group, and privileges flow down from catalog to schema to table. `SHOW GRANTS ON
SCHEMA` shows none of that.

So this reads Unity Catalog's EFFECTIVE permissions
(`/api/2.1/unity-catalog/effective-permissions/...?principal=...`), which is the
only interface that answers the question actually being asked. Given a principal
it returns every privilege that principal can exercise, whether granted to the
principal itself or to a group it belongs to, and whether granted on the object
or inherited from an ancestor -- each finding labelled with the group it arrived
through and the securable it descended from. Verified against this workspace: the
app SP's SELECT is reported via `account users`, both as a direct grant on the
schema and as ALL_PRIVILEGES inherited from the catalog. Both are findings here.

WHAT IT DOES NOT COVER, stated so nobody reads more into a pass than is there:

  * Row filters and column masks. A principal that holds SELECT may still be
    unable to see rows. This check says "can reach the table", not "can see the
    data in it", and a pass means no read privilege was found rather than no read
    was possible.
  * Privileges reachable by a path Unity Catalog does not model as a privilege:
    ownership transfer, a job or pipeline running as another identity, a share, a
    materialisation into a schema the SP CAN read, or credentials in a secret
    scope. Those are real routes to the same bytes and none of them appear here.
  * Anything outside the securables listed below. It checks the catalog, the data
    schema, and every table in that schema. It does not sweep the workspace.
  * Whether the app actually uses a privilege it holds. This is a capability
    check. The runtime control is a separate mechanism and stays load-bearing.

EXCEPTIONS EXPIRE. `sp-data-access-exceptions.json` records findings that are
known and accepted. Every entry needs a reason, an owner, and a review date, and
an entry past its review date STOPS BEING AN EXCEPTION and fails the run. That is
the point: the one finding recorded today is not revocable without a
catalog-level change affecting hundreds of schemas and dozens of owners, which is
a decision for a human, but "we decided not to fix it" must not quietly become
"nobody has looked at this since August".

AN EXCEPTION COVERS ONE GRANT, not one object. It names the privilege, the
principal holding it, and the securable it was granted ON -- because that triple
is what somebody has to go and change, and it is the unit the decision was
actually made about. One ALL_PRIVILEGES grant to a group on the catalog reaches
the catalog, the schema and every table under it; asking for sixteen identical
exception entries would teach the reader to stop reading them.

There is deliberately no wildcard. A different group, a grant on a different
securable, or a direct grant to the service principal is a different triple, so it
is a new finding and it fails -- including on a table added tomorrow. That is what
makes carrying the recorded one safe.

Usage:
  bundle/assert-sp-no-data-select.py --app <name> --catalog <cat> --schema <sch>
                                     --profile <profile>
  ... --shadow    report findings and exit 0 (for a first run on a new estate)
  ... --json      machine-readable findings, for the drift-check aggregator

Exit codes:
  0  no read privilege reaches the app SP that is not a recorded exception
  1  a finding: it can reach the governed data, or the exception file is broken
  2  the check could not run, which is NOT a clean bill of health

1 AND 2 ARE BOTH BLOCKING and they are separated because the remedy differs
completely: 1 is a grant somebody has to revoke, 2 is a credential, a network or
a shape problem that leaves the question unanswered. They shared exit 1 until a
caller needed to say which had happened, and a caller that cannot tell them
apart will eventually report the wrong one -- or, worse, be written to tolerate
"the check failed" and swallow both.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import pathlib
import subprocess
import sys

#: Privileges that let a principal read table data, or imply that it can.
#: ALL_PRIVILEGES is here because it CONTAINS select without naming it, which is
#: exactly how the finding on this deployment is spelled.
READ_PRIVILEGES = frozenset({"SELECT", "ALL_PRIVILEGES"})

EXCEPTIONS_FILE = pathlib.Path(__file__).with_name("sp-data-access-exceptions.json")

EXIT_OK, EXIT_FINDING, EXIT_COULD_NOT_RUN = 0, 1, 2


class CheckError(RuntimeError):
    """A failure to reach an answer, as distinct from a finding."""


def cli(profile: str, path: str) -> dict:
    """One authenticated GET against the workspace, as parsed JSON."""

    argv = ["databricks"]
    if profile:
        argv += ["--profile", profile]
    argv += ["api", "get", path]
    proc = subprocess.run(argv, capture_output=True, text=True)
    if proc.returncode != 0:
        raise CheckError(
            f"GET {path} failed: {(proc.stderr or proc.stdout).strip()[:400]}"
        )
    try:
        return json.loads(proc.stdout or "{}")
    except json.JSONDecodeError as error:
        raise CheckError(f"GET {path} returned no JSON: {error}") from error


def app_service_principal(profile: str, app: str) -> tuple[str, str]:
    """The app's service principal, as (client id, display name).

    Read from the LIVE app rather than from the bundle, because the bundle does
    not name it: the platform mints it when the app is created. That also means
    this cannot be checked without a deployed app, which is correct for a
    release-time assertion.
    """

    body = cli(profile, f"/api/2.0/apps/{app}")
    client_id = body.get("service_principal_client_id") or ""
    name = body.get("service_principal_name") or ""
    if not client_id:
        raise CheckError(
            f"app '{app}' reports no service_principal_client_id, so there is no "
            "principal to check. A pass here would mean nothing."
        )
    return client_id, name


def tables_in(profile: str, catalog: str, schema: str) -> list[str]:
    """Every table in the data schema, by full name."""

    body = cli(
        profile,
        f"/api/2.1/unity-catalog/tables?catalog_name={catalog}&schema_name={schema}"
        "&max_results=200&omit_columns=true",
    )
    return sorted(t["full_name"] for t in (body.get("tables") or []) if t.get("full_name"))


def findings_for(profile: str, kind: str, name: str, principal: str) -> list[dict]:
    """Read privileges this principal can exercise on one securable.

    `principal` is the SP's client id. Unity Catalog resolves group membership on
    its side, so an assignment attributed to a GROUP in the response is one this
    principal reaches THROUGH that group -- that is the inherited case, and it is
    the case that matters.
    """

    body = cli(
        profile,
        f"/api/2.1/unity-catalog/effective-permissions/{kind}/{name}"
        f"?principal={principal}",
    )
    out: list[dict] = []
    for assignment in body.get("privilege_assignments") or []:
        via = assignment.get("principal") or "?"
        for entry in assignment.get("privileges") or []:
            privilege = entry.get("privilege") or ""
            if privilege not in READ_PRIVILEGES:
                continue
            out.append(
                {
                    "securable_type": kind,
                    "securable": name,
                    "privilege": privilege,
                    # The group the privilege arrives through, or the principal
                    # itself when granted directly to the SP.
                    "via_principal": via,
                    "direct_to_sp": via == principal,
                    # Absent for a grant made on this object; set to the ancestor
                    # the privilege descends from otherwise.
                    "inherited_from": entry.get("inherited_from_name") or "",
                    "inherited_from_type": entry.get("inherited_from_type") or "",
                }
            )
    return out


def describe(privilege: str, via: str, origin: str, reached: list[dict]) -> str:
    """One grant, and the blast radius it produced."""

    direct = any(f["direct_to_sp"] for f in reached)
    who = (
        "granted directly to the app service principal"
        if direct
        else f"held by the group '{via}', which the app service principal is in"
    )
    kinds: dict[str, int] = {}
    for finding in reached:
        kinds[finding["securable_type"]] = kinds.get(finding["securable_type"], 0) + 1
    radius = ", ".join(f"{count} {kind}(s)" for kind, count in sorted(kinds.items()))
    return f"{privilege} on {origin}\n      {who}\n      reaches: {radius}"


def cause(finding: dict) -> tuple[str, str, str]:
    """The root cause of a finding: one grant somebody actually made.

    Findings outnumber causes badly. On this deployment a single ALL_PRIVILEGES
    grant to `account users` on the catalog produced a finding on the catalog, on
    the schema, and on all fourteen tables -- 47 findings from 4 grants. Printing
    47 lines invites the reader to skim past the four that can be acted on, so
    they are grouped by the grant they descend from. The privilege, the principal
    it arrives through, and the securable it was granted ON are what identify
    that grant; the object it landed on is what varies.
    """

    return (
        finding["privilege"],
        finding["via_principal"],
        # Empty inherited_from means the grant was made on the object itself, so
        # the object IS the origin.
        finding["inherited_from"] or finding["securable"],
    )


def load_exceptions(today: dt.date, catalog: str, schema: str) -> tuple[dict, list[str]]:
    """Recorded exceptions, and the complaints about the file itself.

    An entry missing a reason, an owner or a review date is NOT an exception. A
    half-filled entry is how an exception file turns into an allowlist.

    `granted_on` IS PARAMETERISED. It is written as `${catalog}` or
    `${catalog}.${schema}` and resolved here against the target being released.
    This file publishes, so a literal catalog name in it is a disclosure about our
    estate that the leak check is right to stop -- and a placeholder that did not
    resolve would be worse than the disclosure, because the entry would silently
    match nothing and the check would report a finding as uncovered while somebody
    believed it was recorded.
    """

    if not EXCEPTIONS_FILE.exists():
        return {}, []
    try:
        raw = json.loads(EXCEPTIONS_FILE.read_text())
    except json.JSONDecodeError as error:
        return {}, [f"{EXCEPTIONS_FILE.name} is not valid JSON: {error}"]

    live: dict = {}
    problems: list[str] = []
    for n, entry in enumerate(raw.get("exceptions") or [], 1):
        missing = [
            field
            for field in ("granted_on", "privilege", "via_principal", "reason", "owner", "review_by")
            if not str(entry.get(field) or "").strip()
        ]
        if missing:
            problems.append(
                f"exception {n} is incomplete (missing {', '.join(missing)}), so it "
                "grants nothing. Fill it in or delete it."
            )
            continue
        try:
            review_by = dt.date.fromisoformat(entry["review_by"])
        except ValueError:
            problems.append(
                f"exception {n} has review_by='{entry['review_by']}', which is not a "
                "YYYY-MM-DD date."
            )
            continue
        if review_by < today:
            problems.append(
                f"exception for {entry['privilege']} on {entry['granted_on']} lapsed on "
                f"{review_by.isoformat()} and is no longer an exception. Re-examine it "
                f"and move the date, or close the finding. Owner: {entry['owner']}."
            )
            continue
        granted_on = (
            entry["granted_on"]
            .replace("${catalog}", catalog)
            .replace("${schema}", schema)
        )
        if "${" in granted_on:
            problems.append(
                f"exception {n} has granted_on='{entry['granted_on']}', which still "
                "contains an unresolved placeholder. Only ${catalog} and ${schema} are "
                "substituted. Left as it is, this entry would match no finding while "
                "reading as though it covered one."
            )
            continue
        live[(entry["privilege"], entry["via_principal"], granted_on)] = entry
    return live, problems


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--app", required=True)
    parser.add_argument("--catalog", required=True)
    parser.add_argument("--schema", required=True)
    parser.add_argument("--profile", default="")
    parser.add_argument("--shadow", action="store_true", help="report, always exit 0")
    parser.add_argument("--json", action="store_true", help="findings as JSON")
    parser.add_argument("--today", default="", help="override the date, for tests")
    args = parser.parse_args()

    today = dt.date.fromisoformat(args.today) if args.today else dt.date.today()

    try:
        client_id, sp_name = app_service_principal(args.profile, args.app)
        securables = [("catalog", args.catalog), ("schema", f"{args.catalog}.{args.schema}")]
        securables += [
            ("table", name) for name in tables_in(args.profile, args.catalog, args.schema)
        ]
        findings: list[dict] = []
        for kind, name in securables:
            findings += findings_for(args.profile, kind, name, client_id)
    except CheckError as error:
        # Fails CLOSED, because the whole point is a claim about access. An
        # unreachable answer is not a clean bill of health, and this assertion is
        # cheap to re-run.
        #
        # EXIT 2, NOT 1. Still blocking -- the only difference is that a caller can
        # now say which of the two happened. No credentials, no network, a renamed
        # app, an API that answered something other than JSON: all of them land
        # here, and none of them are "the service principal cannot reach the data".
        print("\nCOULD NOT RUN: the app SP's data access was not established.")
        print(f"  {error}")
        print(
            "  Nothing was checked. This is NOT a pass and NOT a finding: the "
            "question was never answered, so treat the access as unknown."
        )
        return EXIT_OK if args.shadow else EXIT_COULD_NOT_RUN

    live_exceptions, file_problems = load_exceptions(today, args.catalog, args.schema)

    causes: dict[tuple[str, str, str], list[dict]] = {}
    for finding in findings:
        causes.setdefault(cause(finding), []).append(finding)
    uncovered = {k: v for k, v in causes.items() if k not in live_exceptions}
    covered = {k: v for k, v in causes.items() if k in live_exceptions}

    if args.json:
        json.dump(
            {
                "app": args.app,
                "service_principal": sp_name,
                "securables_checked": len(securables),
                "grants": [
                    {
                        "privilege": privilege,
                        "via_principal": via,
                        "granted_on": origin,
                        "reaches": [f["securable"] for f in reached],
                        "recorded_exception": (privilege, via, origin) in live_exceptions,
                    }
                    for (privilege, via, origin), reached in sorted(causes.items())
                ],
                "findings": findings,
                "exception_problems": file_problems,
            },
            sys.stdout,
            indent=2,
        )
        print()

    if not args.json:
        print("\n==> App service principal data access")
        print(f"  app                  {args.app}")
        print(f"  service principal    {sp_name or client_id}")
        print(f"  securables checked   {len(securables)} "
              f"(catalog, schema, {len(securables) - 2} table(s))")
        print(f"  read grants found    {len(causes)} "
              f"({len(uncovered)} uncovered, {len(covered)} under a recorded exception), "
              f"reaching {len(findings)} securable(s)")
        for (privilege, via, origin), reached in sorted(covered.items()):
            entry = live_exceptions[(privilege, via, origin)]
            print(f"\n  RECORDED  {describe(privilege, via, origin, reached)}")
            print(f"      reason: {entry['reason']}")
            print(f"      owner: {entry['owner']}  review by: {entry['review_by']}")
        for (privilege, via, origin), reached in sorted(uncovered.items()):
            print(f"\n  FINDING   {describe(privilege, via, origin, reached)}")

    # UNDER --json, THE PROSE GOES TO STDERR. It used to follow the JSON document
    # on stdout, which made `--json` unparseable -- so the "machine-readable
    # findings, for the drift-check aggregator" the header promises had never once
    # been consumed by anything. The exit code is unchanged; only the stream is.
    def say(text: str) -> None:
        print(text, file=sys.stderr if args.json else sys.stdout)

    if file_problems:
        say("\n  EXCEPTION FILE:")
        for problem in file_problems:
            say(f"    - {problem}")

    if not uncovered and not file_problems:
        say(
            "\n  PASS: no read privilege reaches the app service principal on the "
            "catalog, the data schema, or any table in it -- directly or through a "
            "group. Read the list above of what this does not cover."
        )
        return EXIT_OK

    say(
        "\nREFUSED: the app service principal can read the governed data schema.\n"
        "\nThe app is designed to read governed tables AS THE CALLER, never as\n"
        "itself, so a read privilege here is a capability the design says should\n"
        "not exist. Close it, or record it as an exception with a reason, an owner\n"
        "and a review date.\n"
        "\nA finding reached through a GROUP is not closed by revoking the service\n"
        "principal's own grant. Check which group, and whether the privilege was\n"
        "granted on the object or inherited from an ancestor -- the lines above say\n"
        "which. Revoking the wrong one changes nothing and looks like a fix.\n"
        f"\nExceptions live in {EXCEPTIONS_FILE.name}. Do not widen READ_PRIVILEGES\n"
        "to get past this, and do not add a wildcard: both make the check agree\n"
        "with the thing it was written to find."
    )
    return EXIT_OK if args.shadow else EXIT_FINDING


if __name__ == "__main__":
    sys.exit(main())
