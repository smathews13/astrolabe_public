"""Proves the live endpoint executes as its invoker, using the identity as the oracle.

Not a unit test, and deliberately not named ``test_*`` so pytest does not collect
it: it needs a real token and a deployed endpoint.

    uv run python tests/verify_identity_live.py --endpoint player-insights-agent

WHY THIS EXISTS RATHER THAN A TEST THAT LOOKS AT THE ANSWER. The demo workspace
cannot tell the principals apart. The demo catalog grants the ``account
users`` group ALL_PRIVILEGES and MANAGE, and that group holds service principals
as well as people, so the signed-in human, the app's service principal and the
model version's passthrough principal all read the twelve demo tables
identically. No row filter, no column mask, and no catalog in the workspace with
a differentiated grant. A check that asked a question and looked at the figures
would therefore pass on the day token forwarding breaks, which is the only day it
was needed. Every assertion below is about WHO THE ENDPOINT SAYS IT RAN AS. None
is about what came back.

THE PROOF, and why it takes two invocations rather than one. A refusal does not
name the account it observed, on purpose: telling an unauthorized caller which
principal the endpoint believes it is would be a disclosure. So the observed
identity is recovered by bracketing it. With ONE user token:

  - naming that token's own owner as `expected_user` is not refused, so the
    account the endpoint observed equals that owner;
  - naming anybody else is refused IDENTITY_MISMATCH, so the endpoint read a real
    invoker identity and compared it, rather than waving the field through.

Neither alone is worth much. The first passes if the gate is disabled; the second
passes if the gate refuses everything. Together they say the endpoint executed as
the holder of the token that called it, which is the property the workstream is
defending, and they say it without depending on the data.

WHAT THIS CANNOT TELL YOU. Two things, and both are load-bearing:

  1. It cannot show that the served model version ENFORCES its user auth policy.
     The endpoint payload has no auth field and the model version reports only
     table dependencies. That has to be asserted where the version is logged, by
     `log_model.py`, and this script must not be read as covering it.
  2. A CLI token carries `scope = all-apis`, so a direct invocation proves the
     endpoint honours whoever invoked it and proves NOTHING about whether the
     app's downscoped `x-forwarded-access-token` carries scopes the data tools
     can use. That second half is what caused a day-long outage before, and it
     stays unverified by anything automated. Exercise it through the app.

THE PROBE TABLE, which is the other kind of oracle. Everything above measures
what the endpoint SAYS about who it ran as. A probe table measures what a
principal can actually READ, and it only means anything on a table where the two
principals genuinely differ. Pass one with `--probe-table catalog.schema.table`,
or set PIA_PROBE_TABLE. It must be granted to the human and NOT to the app's
service principal, with no `account users` grant anywhere above it.

The script validates the instrument before it trusts it: the human must be able
to read the table and the service principal must be denied. IF THE SERVICE
PRINCIPAL CAN READ IT, THE RUN ABORTS. That is not a failing test, it is a void
instrument, and it is the demo catalog's condition reappearing: a probe both can
read reports success no matter which one executed, which is precisely the blind
spot it was built to remove. Treating that as a pass would be worse than having
no probe, because it would come with a green tick.

What the probe does NOT yet cover is the end-to-end path. The agent reaches data
through its semantic layer and Genie space, so it cannot be asked to read an
arbitrary throwaway table, and the probe therefore measures the two principals
directly rather than through a question. Closing that last gap means adding the
probe table to the agent's semantic layer, which is a decision for whoever owns
the catalog, not something to do quietly here.

THE SERVICE PRINCIPAL CASE IS SKIPPED UNLESS YOU SUPPLY ONE, and this script
never creates it. Cases 1 and 2 prove the endpoint runs as its caller; the SP
case proves a DIFFERENT principal cannot borrow a human's name, which is the
exact silent fallback `user_authorization.py` warns about in its header.

The principal worth using is THE APP'S OWN service principal, because that is the
one a fallback would actually fall back to, and the one the probe table is
deliberately not granted to. Its client id is not written down here: an app
service principal id is one of the values that must not be committed, so it comes
from the environment. Any other principal with CAN_QUERY still exercises the
identity cases, but only the app's own exercises the probe.

To run it, get approval first, then:

    databricks service-principals create --display-name pia-identity-negative
    # note the applicationId, then, as a workspace admin:
    databricks permissions update serving-endpoints <endpoint-id> --json '{
      "access_control_list": [
        {"service_principal_name": "<applicationId>", "permission_level": "CAN_QUERY"}
      ]
    }'
    databricks service-principal-secrets create <sp-id>

    export PIA_NEGATIVE_SP_CLIENT_ID=<applicationId>
    export PIA_NEGATIVE_SP_SECRET=<secret>

It needs CAN_QUERY on the endpoint and nothing else. Do not grant it access to
the probe table under any circumstances: being denied there is the whole
measurement, and granting it converts the instrument into the thing it exists to
detect.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import execution_identity  # noqa: E402

# An address that cannot resolve to anybody, for the mismatch half of the proof.
# `.invalid` is reserved by RFC 2606 precisely so it can never be registered, so
# this can never collide with a real account in any directory.
NOBODY = "not-the-invoker@player-insights.invalid"

# Cheap on purpose. Only the case that is expected to reach an answer sends it,
# and every other case is refused before the first model call.
QUESTION = "How many active players were there yesterday?"

#: A three-part Unity Catalog name and nothing else. Checked rather than trusted
#: because the value is interpolated into a statement: this is an operator tool
#: reading an operator's argument, but a validated identifier costs one regex and
#: removes the question entirely.
PROBE_TABLE_PATTERN = re.compile(r"^[A-Za-z0-9_]+\.[A-Za-z0-9_]+\.[A-Za-z0-9_]+$")

#: What Unity Catalog says when a principal is not granted. Matched loosely
#: because the wording carries the object name and has changed shape before,
#: while these tokens have not.
DENIAL_WORDING = re.compile(
    r"PERMISSION_DENIED|does not have permission|insufficient privileges|"
    r"cannot access|is not authorized",
    re.IGNORECASE,
)


@dataclass
class Case:
    name: str
    why: str
    #: The failure code this must come back with, or None if it must not refuse.
    expect: str | None
    custom_inputs: dict[str, Any]
    #: `user` or `service_principal`. Which token invokes.
    principal: str = "user"
    slow: bool = False


@dataclass
class Result:
    case: Case
    passed: bool
    detail: str
    identity: dict[str, Any] = field(default_factory=dict)


def cases(user_email: str) -> list[Case]:
    signed_in = execution_identity.SIGNED_IN_USER
    return [
        Case(
            name="executes as the invoker",
            why=(
                "Naming the token's own owner is not refused, so the account the "
                "endpoint observed is that owner. Half of the on-behalf-of proof."
            ),
            expect=None,
            custom_inputs={
                execution_identity.MODE_KEY: signed_in,
                execution_identity.EXPECTED_USER_KEY: user_email,
            },
            slow=True,
        ),
        Case(
            name="refuses a name that is not the invoker",
            why=(
                "The other half. A mismatch proves the endpoint read a real invoker "
                "identity and compared it, rather than accepting whatever it was told."
            ),
            expect=execution_identity.IDENTITY_MISMATCH,
            custom_inputs={
                execution_identity.MODE_KEY: signed_in,
                execution_identity.EXPECTED_USER_KEY: NOBODY,
            },
        ),
        Case(
            name="refuses a request that declares no mode",
            why="The mode cannot be escaped by omitting the field.",
            expect=execution_identity.IDENTITY_REQUIRED,
            custom_inputs={execution_identity.EXPECTED_USER_KEY: user_email},
        ),
        Case(
            name="refuses a request that names no user",
            why="A signed_in_user request with nobody to hold the invoker against.",
            expect=execution_identity.IDENTITY_REQUIRED,
            custom_inputs={execution_identity.MODE_KEY: signed_in},
        ),
        Case(
            name="refuses a request that asks for the service principal",
            why=(
                "A user-auth version has no service-principal path through it. If this "
                "is answered, the version is not the one you think is deployed."
            ),
            expect=execution_identity.IDENTITY_REQUIRED,
            custom_inputs={
                execution_identity.MODE_KEY: execution_identity.SERVICE_PRINCIPAL,
                execution_identity.EXPECTED_USER_KEY: user_email,
            },
        ),
        Case(
            name="refuses a service principal borrowing a human's name",
            why=(
                "The most valuable case here: the exact silent fallback the workstream "
                "deleted, asserted from outside. A different principal asserts the "
                "human's address and must be refused."
            ),
            expect=execution_identity.IDENTITY_MISMATCH,
            custom_inputs={
                execution_identity.MODE_KEY: signed_in,
                execution_identity.EXPECTED_USER_KEY: user_email,
            },
            principal="service_principal",
        ),
    ]


def invoke(host: str, endpoint: str, token: str, custom_inputs: dict[str, Any]) -> dict[str, Any]:
    """One direct invocation. Returns the parsed body, whatever the status."""

    import requests

    response = requests.post(
        f"{host.rstrip('/')}/serving-endpoints/{endpoint}/invocations",
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
        json={
            "input": [{"role": "user", "content": QUESTION}],
            "custom_inputs": custom_inputs,
        },
        timeout=300,
    )
    try:
        return {"status": response.status_code, "body": response.json()}
    except ValueError:
        return {"status": response.status_code, "body": {"raw": response.text[:2000]}}


def judge(case: Case, response: dict[str, Any]) -> Result:
    """Compare what came back against the identity this case expected.

    Reads `custom_outputs` and never the prose. The refusal sentence also appears
    as a text output item, and treating that as the signal is the bug this whole
    workstream is unpicking on the app side.
    """

    body = response.get("body") or {}
    outputs = body.get("custom_outputs") if isinstance(body, dict) else None
    outputs = outputs if isinstance(outputs, dict) else {}
    identity = outputs.get("execution_identity") or {}
    kind = outputs.get("type")
    code = outputs.get("code")

    # A 401 or 403 never reaches the gate, so it cannot be read as the gate
    # having decided anything. Usually a missing CAN_QUERY.
    if response.get("status") in (401, 403):
        return Result(
            case,
            passed=False,
            detail=(
                f"HTTP {response['status']} from the endpoint, so the invocation never "
                "reached the identity gate. Check CAN_QUERY for this principal."
            ),
        )

    if case.expect is None:
        if kind == "unavailable":
            return Result(
                case,
                passed=False,
                detail=(
                    f"Refused {code}, and this case must not be refused. If this is "
                    "IDENTITY_MISMATCH, the endpoint is not executing as the token you "
                    "used. If IDENTITY_REQUIRED, it could not read an invoker identity "
                    "at all, which is what a fallback to the passthrough principal "
                    "looks like from inside the container."
                ),
                identity=identity,
            )
        return Result(case, passed=True, detail=f"Answered as {kind}, not refused.")

    if kind != "unavailable":
        return Result(
            case,
            passed=False,
            detail=(
                f"Expected a refusal with {case.expect} and the endpoint answered as "
                f"{kind}. The gate did not fire. THIS IS THE FAILURE THAT MATTERS: the "
                "answer will look correct in this workspace regardless, because every "
                "principal reads the same tables."
            ),
            identity=identity,
        )
    if code != case.expect:
        return Result(
            case,
            passed=False,
            detail=f"Refused, but with {code} rather than {case.expect}.",
            identity=identity,
        )
    return Result(case, passed=True, detail=f"Refused {code}.", identity=identity)


def probe_read(host: str, token: str, warehouse: str, table: str) -> tuple[bool, str]:
    """Whether this token can read the probe table. Returns (allowed, wording).

    Runs the read directly rather than through the agent, because the agent
    reaches data through its semantic layer and cannot be pointed at an
    arbitrary table. So this measures the grant itself, which is the fact the
    demo catalog could not supply, and leaves the end-to-end path to the
    identity cases above.
    """

    from databricks.sdk import WorkspaceClient

    client = WorkspaceClient(host=host, token=token)
    try:
        response = client.statement_execution.execute_statement(
            warehouse_id=warehouse,
            statement=f"SELECT 1 FROM {table} LIMIT 1",
            wait_timeout="30s",
        )
    except Exception as error:  # noqa: BLE001 - any failure is reported, not raised
        return not DENIAL_WORDING.search(str(error)), str(error)[:400]

    # A statement can fail inside a successful API call, and the denial arrives
    # in the status rather than as an exception.
    status = getattr(response, "status", None)
    error = getattr(status, "error", None)
    if error is not None:
        message = str(getattr(error, "message", error))
        return not DENIAL_WORDING.search(message), message[:400]
    return True, "read succeeded"


def validate_instrument(
    host: str, warehouse: str, table: str, user_token: str, sp_token: str | None
) -> tuple[bool, list[str]]:
    """Check the probe table can tell the two principals apart, before trusting it.

    Returns (usable, lines). An instrument that both principals can read is not a
    failing test, it is a void measurement, and it is the exact condition that
    made the demo catalog useless: it would report success whichever principal
    executed. Better to abort and say so than to hand back a green tick.
    """

    lines: list[str] = []
    if not PROBE_TABLE_PATTERN.match(table):
        return False, [f"{table!r} is not a catalog.schema.table name."]
    if not warehouse:
        return False, [
            "No warehouse to run the probe on. Pass --warehouse or set "
            "PLAYER_INSIGHTS_WAREHOUSE_ID."
        ]

    human_allowed, human_says = probe_read(host, user_token, warehouse, table)
    lines.append(f"  human      {'CAN READ' if human_allowed else 'DENIED'}  {human_says}")
    if not human_allowed:
        lines.append(
            "  The human cannot read the probe table, so a denial through the agent would "
            "prove nothing about which principal executed. Fix the grant before reading "
            "anything below as evidence."
        )
        return False, lines

    if not sp_token:
        lines.append(
            "  service principal: no credentials, so the half of the instrument that "
            "matters is unchecked. The probe is not used."
        )
        return False, lines

    sp_allowed, sp_says = probe_read(host, sp_token, warehouse, table)
    lines.append(f"  principal  {'CAN READ' if sp_allowed else 'DENIED'}  {sp_says}")
    if sp_allowed:
        lines.append(
            "  INSTRUMENT VOID. Both principals can read the probe table, so it cannot "
            "distinguish them and any result from it would be theatre. This is the demo "
            "catalog's problem reappearing: check for an account users grant on the "
            "catalog or the schema above this table."
        )
        return False, lines

    lines.append("  The two principals differ here, so this table can detect a fallback.")
    return True, lines


def service_principal_token(host: str) -> tuple[str | None, str]:
    """An M2M token for the negative case, or a reason there is not one."""

    client_id = os.environ.get("PIA_NEGATIVE_SP_CLIENT_ID", "")
    secret = os.environ.get("PIA_NEGATIVE_SP_SECRET", "")
    if not client_id or not secret:
        return None, (
            "no PIA_NEGATIVE_SP_CLIENT_ID / PIA_NEGATIVE_SP_SECRET. This script does "
            "not create one; see the creation commands in the module docstring and get "
            "approval first."
        )
    from databricks.sdk import WorkspaceClient

    client = WorkspaceClient(host=host, client_id=client_id, client_secret=secret)
    token = client.config.oauth_token()
    return token.access_token, ""


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--endpoint", required=True, help="Serving endpoint name.")
    parser.add_argument(
        "--profile",
        # Read rather than defaulted to a workspace nickname: a profile name
        # identifies whose workspace this was written against, and it is one of
        # the things that should not be baked into a tracked file.
        default=os.environ.get("DATABRICKS_CONFIG_PROFILE", "DEFAULT"),
        help="CLI profile for the user token. Defaults to DATABRICKS_CONFIG_PROFILE.",
    )
    parser.add_argument(
        "--skip-slow",
        action="store_true",
        help="Skip the case that reaches a real answer. Leaves the proof incomplete.",
    )
    parser.add_argument(
        "--probe-table",
        default=os.environ.get("PIA_PROBE_TABLE", ""),
        help=(
            "catalog.schema.table granted to the human and NOT to the app's service "
            "principal. Adds a data-level oracle to the identity-level ones."
        ),
    )
    parser.add_argument(
        "--warehouse",
        default=os.environ.get("PLAYER_INSIGHTS_WAREHOUSE_ID", ""),
        help="Warehouse the probe read runs on.",
    )
    parser.add_argument("--out", type=Path, default=None)
    args = parser.parse_args()

    from databricks.sdk import WorkspaceClient

    # The user half. A U2M token whose subject is the person running this, which
    # is the only token here that stands for a human.
    user_client = WorkspaceClient(profile=args.profile)
    host = user_client.config.host
    user_token = user_client.config.oauth_token().access_token
    user_email = user_client.current_user.me().user_name

    print(f"host      {host}")
    print(f"endpoint  {args.endpoint}")
    print(f"invoker   {user_email}")
    print(f"policy    {execution_identity.POLICY_VERSION}\n")

    sp_token, sp_absent = service_principal_token(host)
    results: list[Result] = []
    skipped: list[str] = []

    # Before the cases, not after: an instrument nobody checked is how the demo
    # catalog came to be trusted for years.
    probe_usable = False
    if args.probe_table:
        print(f"{'=' * 78}\nprobe table {args.probe_table}")
        probe_usable, lines = validate_instrument(
            host, args.warehouse, args.probe_table, user_token, sp_token
        )
        for line in lines:
            print(line)
        print()
    else:
        skipped.append(
            "data-level probe: no --probe-table. Every case below has the identity as "
            "its oracle and none can observe a difference in what was read."
        )

    for case in cases(user_email):
        if case.slow and args.skip_slow:
            skipped.append(f"{case.name}: --skip-slow")
            continue
        if case.principal == "service_principal" and not sp_token:
            skipped.append(f"{case.name}: {sp_absent}")
            continue
        token = sp_token if case.principal == "service_principal" else user_token
        print(f"{'=' * 78}\n{case.name}\n  {case.why}")
        result = judge(case, invoke(host, args.endpoint, token or "", case.custom_inputs))
        results.append(result)
        print(f"  {'PASS' if result.passed else 'FAIL'}  {result.detail}")
        if result.identity:
            print(f"  claimed identity: {json.dumps(result.identity)}")

    failed = [r for r in results if not r.passed]
    print(f"\n{'=' * 78}")
    print(f"{len(results) - len(failed)} passed, {len(failed)} failed, {len(skipped)} skipped")
    for note in skipped:
        print(f"  skipped  {note}")

    # Said on every run, including a clean one, because the gap is easiest to
    # forget on the day everything passes.
    print(
        "\nNot covered by this run: that the served version enforces its user auth "
        "policy (unverifiable from outside; assert it at log time), and that the app's "
        "downscoped x-forwarded-access-token carries usable scopes (exercise the app)."
    )
    print(
        "  Data-level oracle: the probe table distinguishes the two principals, so a "
        "denial there is evidence rather than wording. The agent still reaches it only "
        "through its semantic layer, so the end-to-end read is not exercised."
        if probe_usable
        else "  Data-level oracle: NOT in use. Every result above rests on what the "
        "endpoint reported about who executed, which is sound but is not a measurement "
        "of what was read."
    )

    if args.out:
        args.out.write_text(
            json.dumps(
                [
                    {
                        "case": r.case.name,
                        "expected": r.case.expect,
                        "passed": r.passed,
                        "detail": r.detail,
                        "identity": r.identity,
                    }
                    for r in results
                ],
                indent=2,
            )
        )
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
