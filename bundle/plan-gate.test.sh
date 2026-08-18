#!/usr/bin/env bash
# Proof that bundle/plan-gate.py refuses what it claims to refuse.
#
# Feeds fabricated plan documents to the gate and asserts on the exit code and
# the wording. No workspace, no CLI, no network, so it runs anywhere and gives the
# same answer every time.
#
# WHY THIS EXISTS AT ALL. "It exited 0 against today's deployment" is not evidence
# that a gate works -- this repository has shipped four release suites that passed
# while asserting nothing, a leak rule that matched nothing for months, and a
# substitution script whose every rule was a silent no-op because BSD `sed`
# ignores `\b` and exits 0 regardless. Every one of them was green. So each case
# below makes the gate say no, and the two that make it say yes are there to prove
# it is not simply refusing everything.
#
#   bundle/plan-gate.test.sh

set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GATE="$HERE/plan-gate.py"

PASS=0
FAIL=0

# Runs the gate over a plan document and checks the exit code, then optionally
# that the output contains each remaining argument. Asserting on the WORDING as
# well as the code, because an exit 1 for the wrong reason is a gate that will
# pass the case it was written for.
check() {
  local label="$1" expected_status="$2" plan="$3"; shift 3
  local out status
  out="$(printf '%s' "$plan" | TARGET=testtarget python3 "$GATE" 2>&1)"
  status=$?

  if [[ "$status" != "$expected_status" ]]; then
    printf '  FAIL  %s\n        expected exit %s, got %s\n' "$label" "$expected_status" "$status"
    printf '%s\n' "$out" | sed 's/^/          /'
    FAIL=$((FAIL + 1))
    return
  fi
  local needle
  for needle in "$@"; do
    if ! printf '%s' "$out" | grep -qF -- "$needle"; then
      printf '  FAIL  %s\n        exit %s was right but the output never said %q\n' \
        "$label" "$status" "$needle"
      printf '%s\n' "$out" | sed 's/^/          /'
      FAIL=$((FAIL + 1))
      return
    fi
  done
  printf '  ok    %s\n' "$label"
  PASS=$((PASS + 1))
}

plan() { printf '{"plan":{%s}}' "$1"; }
res() { printf '"%s":{"action":"%s"}' "$1" "$2"; }

printf '\n==> a plan that changes nothing dangerous\n'
check "an all-skip plan passes" 0 \
  "$(plan "$(res resources.jobs.a skip),$(res resources.schemas.b skip)")" \
  "this deploy destroys nothing"

check "update and create are not destruction" 0 \
  "$(plan "$(res resources.jobs.a update),$(res resources.apps.b create)")" \
  "this deploy destroys nothing" "1 create, 1 update"

printf '\n==> the case the gate exists for\n'
check "a delete fails and is named" 1 \
  "$(plan "$(res resources.jobs.a skip),$(res resources.schemas.player_insights_schema delete)")" \
  "WOULD DESTROY DATA" "delete" "resources.schemas.player_insights_schema"

check "a replace fails: a delete wearing one word" 1 \
  "$(plan "$(res resources.postgres_databases.d replace)")" \
  "WOULD DESTROY DATA" "replace" "resources.postgres_databases.d"

check "one destructive resource among many safe ones still fails" 1 \
  "$(plan "$(res resources.jobs.a skip),$(res resources.jobs.b update),$(res resources.volumes.c delete)")" \
  "resources.volumes.c"

printf '\n==> failing closed on what it has not been taught\n'
check "an unrecognised action is refused, not waved through" 1 \
  "$(plan "$(res resources.jobs.a some_new_verb)")" \
  "UNRECOGNISED PLAN ACTION" "some_new_verb"

check "a null action is refused too" 1 \
  '{"plan":{"resources.jobs.a":{"remote_state":{}}}}' \
  "UNRECOGNISED PLAN ACTION"

printf '\n==> a broken plan is not a clean plan\n'
check "output that is not JSON is exit 2, not 0" 2 \
  'Error: cannot resolve target' \
  "COULD NOT RUN" "not read this as permission to deploy"

check "a plan document with no plan key is exit 2, not 0" 2 \
  '{"plan_version":1,"cli_version":"9.9.9"}' \
  "COULD NOT RUN" "output shape has probably changed"

check "an empty plan object is a clean plan, not a broken one" 0 \
  '{"plan":{}}' \
  "no resources" "destroys nothing"

printf '\n==> acknowledging a deletion by name\n'
PIA_PLAN_ALLOW_DESTROY=resources.jobs.old \
check "a named acknowledgement lets its own resource through" 0 \
  "$(plan "$(res resources.jobs.old delete)")" \
  "ALLOWED" "resources.jobs.old"

PIA_PLAN_ALLOW_DESTROY=resources.jobs.old \
check "an acknowledgement covers only what it names" 1 \
  "$(plan "$(res resources.jobs.old delete),$(res resources.schemas.keep delete)")" \
  "ALLOWED" "FAIL" "resources.schemas.keep"

PIA_PLAN_ALLOW_DESTROY=resources.jobs.gone \
check "an acknowledgement matching nothing is reported as stale" 0 \
  "$(plan "$(res resources.jobs.a skip)")" \
  "STALE ACKNOWLEDGEMENT" "resources.jobs.gone"

printf '\n'
if (( FAIL )); then
  printf 'FAIL  %d of %d assertions failed.\n' "$FAIL" "$((PASS + FAIL))"
  exit 1
fi
# A floor, not a formality. A refactor that makes `check` a no-op would otherwise
# print this same line with nothing behind it, which is the failure this file was
# written to rule out.
if (( PASS < 13 )); then
  printf 'FAIL  only %d assertions ran; this suite has 13. Something is being skipped.\n' "$PASS"
  exit 1
fi
printf 'PASS  %d assertions.\n' "$PASS"
