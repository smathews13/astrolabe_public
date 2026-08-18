#!/usr/bin/env bash
# Tests for bundle/decisions-gate.py.
#
# WHAT THIS IS FOR: a guard nobody has watched fail is worth very little. Three
# gates in this repo have gone permanently inert while still printing, and each
# was found by accident rather than by a test. So every case here asserts on the
# EXIT STATUS and on the words in the output, not on the command succeeding.
#
# The cases that matter most are the two that keep this rule alive across the
# removal of the thing it was written about:
#
#   - a target that sets synthetic_data=true is REFUSED (the failure of
#     2026-08-16, reproduced);
#   - a bundle with no synthetic_data variable at all PASSES, because a setting
#     that no longer exists cannot turn anything on. Without this case, deleting
#     the variable would look like a reason to delete the rule.
#
# No workspace is contacted. `databricks` is stubbed, as in bundle-var.test.sh.
#
# Run:  bundle/decisions-gate.test.sh

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GATE="$HERE/decisions-gate.py"
RECORD="$HERE/DECISIONS.md"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/decisions-gate-test.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

PASS=0
FAIL=0

# A resolved bundle, spliced together so each case states only what it is about.
# Both targets in this repo declare execution_identity, so the compliant baseline
# declares it too.
#
# Fixtures are built by concatenating "$COMPLIANT" with SINGLE-QUOTED literals.
# Writing the JSON inline with \" escapes instead looks tidier and is wrong: bash
# brace-expands {"a":"1","b":"2"} into two words, and the fixture reaches the gate
# with its braces stripped. That produced a test failure that read exactly like a
# gate defect. Single quotes are the fix and there is no reason to go back.
bundle_with() {
  printf '{"workspace":{"host":"https://fake.example.com"},"variables":{%s}}' "$1"
}

COMPLIANT='"execution_identity":{"default":"user-authorization"}'

# run <label> <expected-exit> <bundle-json> <must-contain>...
run() {
  local label="$1" want="$2" bundle="$3"; shift 3
  local out status
  out="$(printf '%s' "$bundle" \
    | DECISIONS_RECORD="$RECORD" python3 "$GATE" 2>&1)"
  status=$?

  if [[ "$status" != "$want" ]]; then
    FAIL=$((FAIL + 1))
    printf '  FAIL  %s\n        expected exit %s, got %s\n' "$label" "$want" "$status"
    printf '%s\n' "$out" | sed 's/^/          /'
    return
  fi
  local needle
  for needle in "$@"; do
    if [[ "$out" != *"$needle"* ]]; then
      FAIL=$((FAIL + 1))
      printf '  FAIL  %s\n        output did not contain %q\n' "$label" "$needle"
      printf '%s\n' "$out" | sed 's/^/          /'
      return
    fi
  done
  PASS=$((PASS + 1))
  printf '  ok    %s\n' "$label"
}

echo "D1: no synthetic-data framing"

run "refuses a target that sets synthetic_data=true" 1 \
  "$(bundle_with "$COMPLIANT"',"synthetic_data":{"default":"true"}')" \
  "REFUSED" \
  "D1. No synthetic-data or demo-data framing" \
  "decided 2026-08-16" \
  "Nothing has been logged, deployed or uploaded."

run "refuses regardless of case and padding" 1 \
  "$(bundle_with "$COMPLIANT"',"synthetic_data":{"default":" TRUE "}')" \
  "REFUSED" "D1."

# The value lands in `default` for a per-target override and in `value` for a
# top-level one. bundle-var.test.sh exists because reading only one of them was
# a silent defect; the same mistake here would be a gate that misses the setting
# on exactly the targets that override it.
run "reads a per-target override out of value as well as default" 1 \
  "$(bundle_with "$COMPLIANT"',"synthetic_data":{"default":"","value":"true"}')" \
  "REFUSED" "D1."

run "passes when synthetic_data is declared but empty" 0 \
  "$(bundle_with "$COMPLIANT"',"synthetic_data":{"default":""}')" \
  "Nothing contradicted."

run "passes when synthetic_data is declared false" 0 \
  "$(bundle_with "$COMPLIANT"',"synthetic_data":{"default":"false"}')" \
  "Nothing contradicted."

# The case that makes this rule survive its own subject. The variable is being
# removed; the rule must keep passing afterwards rather than needing deletion.
run "passes when the synthetic_data variable does not exist at all" 0 \
  "$(bundle_with "$COMPLIANT")" \
  "Nothing contradicted." \
  "no \`synthetic_data\` variable exists for this target"

echo
echo "D2: reads run under the asking user's grants"

run "refuses a target declaring system-passthrough" 1 \
  "$(bundle_with '"execution_identity":{"default":"system-passthrough"}')" \
  "REFUSED" "D2. The app never reads governed data as itself"

run "refuses when nothing declares an execution identity" 1 \
  "$(bundle_with '"catalog":{"default":"x"}')" \
  "REFUSED" "is not declared for this target"

run "passes a target that declares user-authorization" 0 \
  "$(bundle_with "$COMPLIANT")" \
  "Nothing contradicted."

echo
echo "D3: no untraceable figures"

run "refuses allow_unattributed_figures=true" 1 \
  "$(bundle_with "$COMPLIANT"',"allow_unattributed_figures":{"default":"true"}')" \
  "REFUSED" "D3. A figure a reader cannot trace"

run "passes on the default false" 0 \
  "$(bundle_with "$COMPLIANT"',"allow_unattributed_figures":{"default":"false"}')" \
  "Nothing contradicted."

echo
echo "The readout"

run "prints the enforced and displayed halves separately" 0 \
  "$(bundle_with "$COMPLIANT")" \
  "ENFORCED. This release stops if one of these is contradicted." \
  "DISPLAYED ONLY. Nothing checks these." \
  "D5  The role badge sits to the LEFT of the signed-in name" \
  "D6  Refused and failed are never summed, on any surface." \
  "D8  \"Not checked\" always means not checked yet, never broken."

run "names no bypass flag in the refusal" 1 \
  "$(bundle_with "$COMPLIANT"',"synthetic_data":{"default":"true"}')" \
  "There is no flag that releases past this, on purpose."

echo
echo "The record itself"

# A rule enforcing a decision the record no longer carries is the mirror image of
# the failure this gate exists for. It must refuse rather than skip.
sed 's/^### D1\./### REMOVED-D1./' "$RECORD" >"$WORK/record-without-d1.md"
out="$(printf '%s' "$(bundle_with "$COMPLIANT")" \
  | DECISIONS_RECORD="$WORK/record-without-d1.md" \
    python3 "$GATE" 2>&1)"
if [[ $? -eq 1 && "$out" == *"no entry in DECISIONS.md"* ]]; then
  PASS=$((PASS + 1)); printf '  ok    %s\n' "refuses when a rule outlived its entry in the record"
else
  FAIL=$((FAIL + 1)); printf '  FAIL  %s\n' "refuses when a rule outlived its entry in the record"
  printf '%s\n' "$out" | sed 's/^/          /'
fi

# Exit 2, not 1: "could not check" is a different answer from "checked and
# found a contradiction", and a caller must be able to tell them apart.
out="$(printf '%s' "$(bundle_with "$COMPLIANT")" \
  | DECISIONS_RECORD="$WORK/not-here.md" \
    python3 "$GATE" 2>&1)"
if [[ $? -eq 2 && "$out" == *"Could not read the decisions record"* ]]; then
  PASS=$((PASS + 1)); printf '  ok    %s\n' "exits 2 when the record is missing"
else
  FAIL=$((FAIL + 1)); printf '  FAIL  %s\n' "exits 2 when the record is missing"
  printf '%s\n' "$out" | sed 's/^/          /'
fi

out="$(printf 'not json' \
  | DECISIONS_RECORD="$RECORD" \
    python3 "$GATE" 2>&1)"
if [[ $? -eq 2 && "$out" == *"could not be read"* ]]; then
  PASS=$((PASS + 1)); printf '  ok    %s\n' "exits 2 on unreadable bundle configuration"
else
  FAIL=$((FAIL + 1)); printf '  FAIL  %s\n' "exits 2 on unreadable bundle configuration"
  printf '%s\n' "$out" | sed 's/^/          /'
fi

# Every id the gate enforces or prints must exist in the record, or the release
# log cites a decision a reader cannot look up.
missing=""
for ident in D1 D2 D3 D4 D5 D6 D7 D8 D9 D10 D11; do
  grep -q "^### $ident\." "$RECORD" || missing="$missing $ident"
done
if [[ -z "$missing" ]]; then
  PASS=$((PASS + 1)); printf '  ok    %s\n' "every id the gate names has an entry in DECISIONS.md"
else
  FAIL=$((FAIL + 1)); printf '  FAIL  %s\n        missing:%s\n' "every id the gate names has an entry in DECISIONS.md" "$missing"
fi

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]] || exit 1
# A FLOOR, NOT A TOTAL. `FAIL -eq 0` is also true of a run that asserted nothing,
# which is how a green check that matched nothing has got past this project three
# times. It matters most here: this is the test for the gate that stops a release,
# so a green run of it is what somebody trusts when they ship. Deliberately below
# the current count; raise it when cases are added.
readonly MIN_ASSERTIONS=14
[[ "$PASS" -ge "$MIN_ASSERTIONS" ]] || {
  printf '\nFAIL  only %d assertions ran; at least %d are expected.\n' "$PASS" "$MIN_ASSERTIONS" >&2
  printf '      Nothing failed, but this run did not check what it claims to.\n' >&2
  exit 1
}
