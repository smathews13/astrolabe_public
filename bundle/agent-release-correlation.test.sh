#!/usr/bin/env bash
# Tests for the correlation gate in bundle/agent-release.sh.
#
# WHAT THESE ARE FOR: the gate refuses a release when a value somebody saved in
# the app disagrees with what the release would log. It has two ways to be wrong
# and only one of them is visible. Refusing a legitimate release is loud and gets
# fixed within the hour. PASSING something it was built to catch is silent, and
# it has been silent twice. Once for a day, when the 401 branch (the one every CI
# caller takes, because the endpoint cannot identify a service principal) printed
# a warning and returned success. Once for longer, when the wizard was deleted
# and the gate went on calling /api/setup: that route answers 410 by design, the
# gate read it as "did not answer" and passed every run for months. Case 8 is
# there so the second one cannot recur silently.
#
# So each case below asserts an EXIT STATUS as well as the text. A gate that
# prints "REFUSED" and returns 0 satisfies any assertion made on output alone,
# which is exactly how the original defect survived review.
#
# HOW: the real script is run, unmodified, with `databricks`, `curl` and `uv`
# replaced by stubs on PATH. Nothing here reimplements the gate. A test that
# restates the logic it is checking passes when the logic is wrong. Stubbing the
# CLI is also what lets a 401 be tested at all: the live app answers a human 200,
# and the branch that matters cannot be reached from this machine.
#
# Run:  bundle/agent-release-correlation.test.sh

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Overridable so the suite can be pointed at an older copy of the script to prove
# it catches the defect it was written for. A copy has to sit in this directory to
# find _lib.sh, which is how it is sourced. Used once, by hand:
#   git show <ref>:bundle/agent-release.sh > bundle/.old.sh
#   AGENT_RELEASE_SH=bundle/.old.sh bundle/agent-release-correlation.test.sh
SCRIPT="${AGENT_RELEASE_SH:-$HERE/agent-release.sh}"
[[ -x "$SCRIPT" ]] || { echo "not found: $SCRIPT" >&2; exit 1; }

STUBS="$(mktemp -d "${TMPDIR:-/tmp}/agent-release-test.XXXXXX")"
OUT_DIR="$(mktemp -d "${TMPDIR:-/tmp}/agent-release-out.XXXXXX")"
trap 'rm -rf "$STUBS" "$OUT_DIR"' EXIT

PASS=0
FAIL=0

# --- Stubs -------------------------------------------------------------------
#
# Driven by environment variables so each case can move one fact and leave the
# rest alone.
#
#   FAKE_HTTP_STATUS    what /api/settings returns
#   FAKE_SETTINGS_BODY  the body it returns with it
#   FAKE_APP_URL        empty to simulate an app that is not serving yet

cat >"$STUBS/databricks" <<'STUB'
#!/usr/bin/env bash
# A LEADING `--profile <value>` is shifted off before dispatch. Every typed
# subcommand this stub answers takes the flag at the END (`apps get NAME
# --profile P`), but assert-sp-no-data-select.py builds `databricks --profile P
# api get PATH` with the flag FIRST, so `$1 $2` was "--profile test-profile" and
# fell through to the `*)` arm. That arm exits 1, which the SP gate correctly
# reads as "could not run", which stops the release -- 25 of this suite's cases
# failed on it and not one of them said the word profile.
if [ "$1" = "--profile" ]; then shift 2; fi
case "$1 $2" in
  "bundle validate")
    # Only the fields agent-release.sh reads. Every variable it calls bundle_var
    # on must be present, and every one it calls bundle_var_or_empty on must be
    # DECLARED even when empty. That distinction is the point of the helper.
    #
    # A VARIABLE ADDED TO THE SCRIPT AND NOT ADDED HERE KILLS THE WHOLE SUITE,
    # not one case: the script exits during variable resolution, long before the
    # gate, so all nine cases fail with "not in output" and none of them is
    # about the gate. That is how it read when `allow_unattributed_figures` was
    # added, and again when `semantic_index_endpoint` was, for about fifty commits.
    # The failure is loud enough to notice but says nothing about its cause, so it
    # is written down here instead. To re-derive the list:
    #   rg -o 'bundle_var(_or_empty)? [a-z_]+' bundle/agent-release.sh | sort -u
    #
    # `execution_identity` will NOT appear in that command's output. The decisions
    # gate reads it straight out of the resolved bundle rather than through those
    # helpers, and D2 is a `must_be` rule, so an UNDECLARED variable CONTRADICTS it:
    # nothing in such a deployment asserts the decision. A target that omits it is
    # meant to be refused, so the value here is the one a real target carries.
    cat <<'JSON'
{
  "workspace": { "host": "https://fake-workspace.cloud.databricks.com" },
  "variables": {
    "catalog":                  { "value": "test_catalog" },
    "schema":                   { "value": "test_schema" },
    "warehouse_id":             { "value": "wh-test" },
    "model_name":               { "value": "test_catalog.test_schema.model" },
    "serving_endpoint_name":    { "value": "test-endpoint" },
    "serving_rollbacks_kept":   { "value": "0" },
    "experiment_path":          { "value": "/Shared/test" },
    "llm_endpoint":             { "value": "test-llm" },
    "llm_gateway":              { "value": "" },
    "catalog_allowlist":        { "value": "test_catalog" },
    "catalog_denylist":         { "value": "" },
    "max_output_tokens":        { "value": "4096" },
    "genie_data_space_id":      { "value": "" },
    "genie_dictionary_space_id":{ "value": "" },
    "manifest_source":          { "value": "" },
    "app_name":                 { "value": "test-app" },
    "allow_unattributed_figures": { "value": "" },
    "semantic_index_endpoint":  { "value": "" },
    "execution_identity":       { "value": "user-authorization" }
  },
  "resources": { "apps": { "player_insights_app": { "name": "test-app" } } }
}
JSON
    ;;
  "apps get")
    printf '{"url": "%s"}\n' "${FAKE_APP_URL-https://fake.databricksapps.com}"
    ;;
  # The SP data-access gate, which reaches the workspace through `databricks api
  # get` rather than a typed subcommand. Its default answers are the CLEAN estate:
  # an app with a service principal, no tables, no privileges. A case that wants
  # the gate to fire sets FAKE_SP_SCHEMA_PRIVS.
  #
  # SAME WARNING AS THE VARIABLE LIST ABOVE, and it is how this suite went 25-red
  # the first time the gate was wired: a NEW CLI CALL IN THE SCRIPT THAT IS NOT
  # ANSWERED HERE kills every case downstream of it, and none of the failures
  # mentions the call that caused them. The `*)` arm exits 1, the gate reads that
  # as "could not run", and the release stops before the gate each case is about.
  "api get")
    # One knob for the whole call family, so a case can reproduce the estate this
    # gate cannot see: no credentials, no network, a revoked token. It has to be
    # separate from an empty privilege list, because those two must not end the
    # release the same way.
    if [ -n "${FAKE_SP_UNREACHABLE-}" ]; then
      echo "stub databricks: $FAKE_SP_UNREACHABLE" >&2
      exit 1
    fi
    case "$3" in
      "")
        echo "stub databricks api get: no path argument" >&2
        exit 1
        ;;
      */api/2.0/apps/*)
        echo '{"service_principal_client_id":"sp-client-id","service_principal_name":"stub app sp"}'
        ;;
      */unity-catalog/tables*)
        echo '{"tables":[]}'
        ;;
      */effective-permissions/schema/*)
        printf '{"privilege_assignments":%s}\n' \
          "${FAKE_SP_SCHEMA_PRIVS-[]}"
        ;;
      */effective-permissions/*)
        echo '{"privilege_assignments":[]}'
        ;;
      *)
        echo "stub databricks api get: unexpected path: $3" >&2
        exit 1
        ;;
    esac
    ;;
  "auth token")
    echo '{"access_token": "fake-token"}'
    ;;
  "auth describe")
    echo '{"details": {"host": "https://fake-workspace.cloud.databricks.com"}}'
    ;;
  *)
    echo "stub databricks: unexpected: $*" >&2
    exit 1
    ;;
esac
STUB

# The real call is `curl -sS --max-time 20 -w '\n%{http_code}' ...`, so the status
# arrives appended after a newline and the script splits on the LAST one. The stub
# has to reproduce that shape exactly, including the absence of a trailing newline
# on the body.
cat >"$STUBS/curl" <<'STUB'
#!/usr/bin/env bash
printf '%s\n%s' "${FAKE_SETTINGS_BODY-}" "${FAKE_HTTP_STATUS-200}"
STUB

# Needed only by `require_cmd uv`. Every uv call is past the gate, and no case
# here gets that far, because all of them are dry runs.
cat >"$STUBS/uv" <<'STUB'
#!/usr/bin/env bash
echo "stub uv should not have been reached: $*" >&2
exit 1
STUB

chmod +x "$STUBS/databricks" "$STUBS/curl" "$STUBS/uv"

# --- Harness -----------------------------------------------------------------

# run_release <name> -> writes combined output to $OUT_DIR/<name>, returns the
# script's exit status. Dry run: no --apply, so nothing is logged or deployed
# whatever the gate decides.
LAST_OUT=""
run_release() {
  local name="$1"; shift
  LAST_OUT="$OUT_DIR/$name"
  PATH="$STUBS:$PATH" \
  TARGET=testtarget \
  PROFILE=test-profile \
  PLAYER_INSIGHTS_DATA_GENIE_ID=data-space-id \
  PLAYER_INSIGHTS_DICTIONARY_GENIE_ID=dict-space-id \
    bash "$SCRIPT" "$@" >"$LAST_OUT" 2>&1
  return $?
}

ok()   { PASS=$((PASS + 1)); printf '  ok    %s\n' "$1"; }
bad()  { FAIL=$((FAIL + 1)); printf '  FAIL  %s\n' "$1"; }

expect_status() {
  local want="$1" got="$2" what="$3"
  if [[ "$want" == nonzero ]]; then
    (( got != 0 )) && ok "$what (exit $got)" || bad "$what: expected nonzero, got $got"
  elif [[ "$got" == "$want" ]]; then
    ok "$what (exit $got)"
  else
    bad "$what: expected exit $want, got $got"
  fi
}

expect_text()  { grep -qF -- "$2" "$LAST_OUT" && ok "$1" || bad "$1: not in output"; }
expect_absent(){ grep -qF -- "$2" "$LAST_OUT" && bad "$1: present and should not be" || ok "$1"; }

# --- Fixtures ----------------------------------------------------------------

# The /api/settings shape: one entry per connected resource, the resource nested
# inside it, and `intended` set only when somebody saved a value that is not in
# force. `catalog`/`catalog` are the real id and agentKey from
# shared/deployment-config.ts, so a rename there fails these rather than passing
# against a shape the app never sends.
#
# The app agrees with the bundle: same catalog, and it publishes an agentKey, so
# the comparison is live rather than inert.
AGREES='{"resources":[{"resource":{"id":"catalog","agentKey":"catalog","label":"Catalog"},
        "intended":"test_catalog","intendedBy":"someone@example.com",
        "intendedAt":"2026-08-06T10:00:00Z"}]}'
# Same shape, one value moved.
DISAGREES='{"resources":[{"resource":{"id":"catalog","agentKey":"catalog","label":"Catalog"},
        "intended":"someone_elses_catalog","intendedBy":"someone@example.com",
        "intendedAt":"2026-08-06T10:00:00Z"}]}'
# Nothing outstanding: the resource is published, but nobody has saved a value
# against it. This is the ordinary state of a healthy deployment, and it must
# read as a pass that looked rather than a pass that could not look.
NOTHING_SAVED='{"resources":[{"resource":{"id":"catalog","agentKey":"catalog","label":"Catalog"},
        "intended":null,"intendedBy":"","intendedAt":""}]}'

echo
echo "=== 1. service principal (401), no flag: must REFUSE and stop the release ==="
FAKE_HTTP_STATUS=401 FAKE_SETTINGS_BODY='{"error":"unauthorized"}' \
  run_release 401-no-flag; status=$?
expect_status nonzero "$status" "the release fails"
expect_text  "says the check was not read, with the status"  "NOT READ"
expect_text  "names the reason a CI caller hits this"        "service principal"
expect_text  "refuses in as many words"                      "REFUSED."
expect_text  "offers running it as a person"                 "run it as yourself"
expect_text  "names the flag as the deliberate way through"  "--ignore-app-intentions"
# The gate must STOP the run, not print its warning and carry on to the dry-run
# summary, which would report the release as having succeeded.
expect_absent "the run stopped at the gate, not after it"    "Dry run"
expect_absent "did not claim it released"                    "Released anyway"

echo
echo "=== 2. service principal (401) WITH the flag: releases, and says what it let through ==="
FAKE_HTTP_STATUS=401 FAKE_SETTINGS_BODY='{"error":"unauthorized"}' \
  run_release 401-with-flag --ignore-app-intentions; status=$?
expect_status 0 "$status" "the release proceeds"
expect_text  "the loud note is still in the log"             "NOT READ"
expect_text  "still explains the service principal case"     "service principal"
expect_text  "records that the flag did the releasing"       "Released anyway on --ignore-app-intentions"
expect_text  "reached the rest of the run"                   "Dry run"

echo
echo "=== 3. a 403 is the same finding as a 401 ==="
FAKE_HTTP_STATUS=403 FAKE_SETTINGS_BODY='{"error":"forbidden"}' \
  run_release 403-no-flag; status=$?
expect_status nonzero "$status" "the release fails"
expect_text  "reports the status it actually got"            "returned 403"

echo
echo "=== 4. a human caller whose app agrees: still passes ==="
FAKE_HTTP_STATUS=200 FAKE_SETTINGS_BODY="$AGREES" \
  run_release 200-agrees; status=$?
expect_status 0 "$status" "the release proceeds"
expect_text  "reports the agreement"                         "and that is what this release logs"
expect_absent "nothing was refused"                          "REFUSED"

echo
echo "=== 5. a human caller whose app disagrees: still refuses ==="
FAKE_HTTP_STATUS=200 FAKE_SETTINGS_BODY="$DISAGREES" \
  run_release 200-disagrees; status=$?
expect_status nonzero "$status" "the release fails"
expect_text  "refuses"                                       "REFUSED."
expect_text  "quotes the app's value"                        "someone_elses_catalog"
expect_absent "the run stopped at the gate"                  "Dry run"

echo
echo "=== 6. disagreement WITH the flag: releases, and the disagreement is on the record ==="
FAKE_HTTP_STATUS=200 FAKE_SETTINGS_BODY="$DISAGREES" \
  run_release 200-disagrees-with-flag --ignore-app-intentions; status=$?
expect_status 0 "$status" "the release proceeds"
# The flag must not skip the check itself: the disagreement is still printed, so
# the log says what was released over rather than only that something was.
expect_text  "the disagreement is still printed"             "someone_elses_catalog"
expect_text  "records that the flag did the releasing"        "Released anyway on --ignore-app-intentions"
expect_text  "reached the rest of the run"                    "Dry run"

echo
echo "=== 7. app not serving yet: a legitimate pass, unchanged ==="
FAKE_APP_URL="" FAKE_HTTP_STATUS=200 FAKE_SETTINGS_BODY="$AGREES" \
  run_release no-app-url; status=$?
expect_status 0 "$status" "the release proceeds"
expect_text  "says why it could not look"                    "is not serving yet"

echo
echo "=== 8. a route that is GONE must not read as an app with nothing to say ==="
# The defect this case exists for: the gate went on calling /api/setup after the
# first-run wizard was deleted. That route answers 410 by design, so the gate
# took "the endpoint is not there" for "the deployment has no intentions" and
# passed, on every run, for months. It still passes here -- the check can only
# ever add a refusal -- but it must SAY that a missing route is a stale build,
# because a pass that reads like every other pass is how it stayed unnoticed.
FAKE_HTTP_STATUS=410 FAKE_SETTINGS_BODY='{"error":"setup_removed"}' \
  run_release 410-gone; status=$?
expect_status 0 "$status" "the release proceeds"
expect_text  "reports the status it actually got"            "(HTTP 410)"
expect_text  "names it as a stale build, not as silence"     "STALE APP"
expect_text  "says what would fix it"                        "bundle/app-release.sh"
expect_absent "did not claim the app agreed with anything"   "and that is what this release logs"

echo
echo "=== 9. published resource with nothing saved: a pass that LOOKED ==="
FAKE_HTTP_STATUS=200 FAKE_SETTINGS_BODY="$NOTHING_SAVED" \
  run_release nothing-saved; status=$?
expect_status 0 "$status" "the release proceeds"
expect_text  "says it had nothing to disagree with"          "no outstanding intentions"
expect_absent "nothing was refused"                          "REFUSED"
# The inert-build note is for a payload with no agentKey anywhere. A resource
# that publishes one and simply has no saved value must not trip it.
expect_absent "did not misreport a healthy app as a stale build"  "predates the correlation contract"

echo
echo "=== 10. the SP data-access gate STOPS the re-log, and is not a no-op ==="
# Every case above leaves this gate clean, which proves it does not block a
# healthy release and proves nothing about whether it blocks anything at all.
# A gate is only a gate if something makes it say no, so this case makes it.
#
# The estate here is the one this deployment actually has: SELECT held by
# `account users` on the data schema, which the app service principal is in.
# Against example on 2026-08-17 the real gate refused on exactly this.
FAKE_SP_SCHEMA_PRIVS='[{"principal":"account users","privileges":[{"privilege":"SELECT"}]}]' \
  run_release sp-finding; status=$?
expect_status nonzero "$status" "a reachable governed schema stops the release"
expect_text  "names the group the privilege arrives through"  "account users"
expect_text  "refuses in as many words"                       "can reach the governed data schema"
expect_text  "says a group grant is not closed by revoking the SP's own"  "is not closed by revoking"
expect_text  "points at the exceptions file rather than a flag"  "sp-data-access-exceptions.json"
# The release must stop AT the gate. Reaching the dry-run summary would mean the
# gate printed a refusal and let the run carry on regardless, which is the exact
# shape of every check this repository has had to go back and fix.
expect_absent "stopped at the gate, did not reach the dry-run summary"  "Re-run with --apply to:"

echo
echo "=== 11. a gate that could not run must not read like a gate that passed ==="
# The other half, and the one this repository keeps getting wrong. No
# credentials, no network, a renamed app: the question was never answered, and
# an unanswered question is not a clean bill of health.
FAKE_SP_UNREACHABLE='Error: cannot configure default credentials' \
  run_release sp-unreachable; status=$?
expect_status nonzero "$status" "an unreachable workspace stops the release"
expect_text  "says the access could not be established"  "COULD NOT BE ESTABLISHED"
expect_text  "says plainly that this is not a pass"      "not a finding and it is not a pass"
# Distinguishable from case 10. Reporting a credential failure as a governance
# finding sends somebody to revoke a grant that was never there.
expect_absent "did not report it as a grant to go and revoke"  "can reach the governed data schema"
expect_absent "stopped at the gate, did not reach the dry-run summary"  "Re-run with --apply to:"

echo
printf '\n%s passed, %s failed\n' "$PASS" "$FAIL"
(( FAIL == 0 )) || exit 1
# A FLOOR, NOT A TOTAL. `FAIL == 0` is also true of a run that asserted nothing:
# a stub the script could not build, a `run_release` that died before the first
# case, an early `exit` in a helper. This project has shipped three checks that
# passed while matching nothing, so the count is held to a floor here rather than
# left implied. Raise it when cases are added; it is deliberately below the
# current count so adding one case is not a two-file change.
readonly MIN_ASSERTIONS=40
(( PASS >= MIN_ASSERTIONS )) || {
    printf '\nFAIL  only %s assertions ran; at least %s are expected.\n' "$PASS" "$MIN_ASSERTIONS" >&2
    printf '      Nothing failed, but this run did not check what it claims to.\n' >&2
    exit 1
}
