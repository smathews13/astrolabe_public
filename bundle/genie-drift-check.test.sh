#!/usr/bin/env bash
# Tests for bundle/genie-drift-check.py.
#
# WHAT THIS IS FOR. The check exists because a Genie change was committed,
# deployed, reported successful and never landed, and the thing that agreed it
# had landed was `serialized_space.version` -- a tag nobody bumped sitting above
# rewritten text. So the case that matters most here is CASE 2: same version,
# same instruction id, different words. A check that passes that case is the
# original bug with more output.
#
# The other half is the direction people forget. `bundle deploy` overwrites these
# bodies whole, so a table that is live and NOT committed is drift too: the next
# deploy deletes it and somebody's analysts lose a table nobody meant to remove.
# That is CASE 3, and it is the more expensive of the two.
#
# Every case asserts on the VERDICT and the EXIT STATUS rather than on the check
# having run, because "unreadable" reported as "in sync" is precisely the failure
# a green exit code hides.
#
# Run:  bundle/genie-drift-check.test.sh

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STUBS="$(mktemp -d "${TMPDIR:-/tmp}/genie-drift-test.XXXXXX")"
trap 'rm -rf "$STUBS"' EXIT

PASS=0
FAIL=0

# The live side. Each test writes the JSON it wants the workspace to return into
# $STUBS/live.json; the stub just hands it back. Writing a file rather than
# baking cases into the stub keeps each case readable on its own.
cat >"$STUBS/databricks" <<'STUB'
#!/usr/bin/env bash
if [[ "$1 $2" == "api get" ]]; then
  if [[ -f "$GENIE_STUB_LIVE" ]]; then cat "$GENIE_STUB_LIVE"; exit 0; fi
  echo "the workspace said no" >&2; exit 1
fi
echo '{}'
STUB
chmod +x "$STUBS/databricks"
PATH="$STUBS:$PATH"
export GENIE_STUB_LIVE="$STUBS/live.json"

# A committed space and a live space that agree, as the baseline every case
# perturbs by exactly one thing. Built as Python dicts and serialized, so a case
# can change one field without restating 40 lines of JSON.
python3 - "$STUBS" <<'PY'
import json, sys
stubs = sys.argv[1]

body = {
    "version": 2,
    "instructions": {"text_instructions": [
        {"id": "aaa1", "content": ["Prefer gold tables for behavioural questions."]},
    ]},
    "data_sources": {"tables": [
        {"identifier": "cat.sch.gold_player"},
        {"identifier": "cat.sch.gold_session"},
    ]},
    "config": {"sample_questions": [{"id": "q1", "question": ["Churn risk this week?"]}]},
}
space = {
    "title": "Data",
    "description": "Player data",
    "warehouse_id": "wh1",
    "parent_path": "/Workspace/Shared",
    "serialized_space": json.dumps(body),
}
json.dump({"resources": {"genie_spaces": {"data_genie_space": space}}},
          open(f"{stubs}/bundle.json", "w"))

live = {
    "space_id": "01abc",
    "etag": "e1",
    "create_time": "2026-01-01T00:00:00Z",
    "update_time": "2026-08-01T00:00:00Z",
    "title": "Data",
    "description": "Player data",
    "warehouse_id": "wh1",
    "parent_path": "/Shared",
    "serialized_space": json.dumps(body),
}
json.dump(live, open(f"{stubs}/live-base.json", "w"))
PY

# Rewrite the live JSON for one case. Takes python source that mutates `live`
# (and may re-serialize `body`), so a case reads as the one thing it changes.
mutate_live() {
  python3 - "$STUBS" "$1" <<'PY'
import json, sys
stubs, src = sys.argv[1], sys.argv[2]
live = json.load(open(f"{stubs}/live-base.json"))
body = json.loads(live["serialized_space"])
exec(src)
live["serialized_space"] = json.dumps(body)
json.dump(live, open(f"{stubs}/live.json", "w"))
PY
}

# label | expected verdict word | expected exit status
run_case() {
  local label="$1" expect_word="$2" expect_status="$3"
  local out status
  out="$(python3 "$HERE/genie-drift-check.py" --profile p \
          --space "space" data_genie_space "01abc" <"$STUBS/bundle.json" 2>&1)"
  status=$?
  if [[ "$out" == *"$expect_word"* && "$status" -eq "$expect_status" ]]; then
    PASS=$((PASS + 1)); printf '  ok    %s\n' "$label"
  else
    FAIL=$((FAIL + 1))
    printf '  FAIL  %s\n        wanted %q and exit %d, got exit %d\n' \
      "$label" "$expect_word" "$expect_status" "$status"
    printf '        %s\n' "$out" | head -20
  fi
}

echo "in sync"
mutate_live 'pass'
run_case "identical content is in sync" "IN SYNC" 0

mutate_live 'live["parent_path"] = "/Shared"'
run_case "/Workspace prefix is not drift" "IN SYNC" 0

mutate_live 'live["etag"] = "different"; live["update_time"] = "2026-09-09T00:00:00Z"; live["space_id"] = "other"'
run_case "server bookkeeping fields are not drift" "IN SYNC" 0

mutate_live 'body["instructions"]["text_instructions"][0]["content"] = ["Prefer gold tables\n   for behavioural questions."]'
run_case "a re-wrapped line is not drift" "IN SYNC" 0

echo "drift"
mutate_live 'body["instructions"]["text_instructions"][0]["content"] = ["Prefer SILVER tables for behavioural questions."]'
run_case "changed text under an unchanged id and version IS drift" "DRIFTED" 1

mutate_live 'body["data_sources"]["tables"].append({"identifier": "cat.sch.someone_elses_table"})'
run_case "a table live but not committed IS drift" "DRIFTED" 1

mutate_live 'body["data_sources"]["tables"] = body["data_sources"]["tables"][:1]'
run_case "a table committed but not live IS drift" "DRIFTED" 1

mutate_live 'live["parent_path"] = "/Shared/SomewhereElse"'
run_case "a genuine folder move IS drift" "DRIFTED" 1

mutate_live 'body["config"]["sample_questions"][0]["question"] = ["Something else entirely?"]'
run_case "a changed sample question IS drift" "DRIFTED" 1

mutate_live 'live["title"] = "Renamed"'
run_case "a changed title IS drift" "DRIFTED" 1

echo "not established"
rm -f "$STUBS/live.json"
run_case "an unreadable space is neither pass nor drift" "UNREADABLE" 2

mutate_live 'pass'
out="$(python3 "$HERE/genie-drift-check.py" --profile p \
        --space "space" data_genie_space "" <"$STUBS/bundle.json" 2>&1)"; status=$?
if [[ "$out" == *"SKIP"* && "$status" -eq 2 ]]; then
  PASS=$((PASS + 1)); printf '  ok    %s\n' "a space with no id is not reported as in sync"
else
  FAIL=$((FAIL + 1)); printf '  FAIL  %s (exit %d)\n' "a space with no id is not reported as in sync" "$status"
fi

out="$(python3 "$HERE/genie-drift-check.py" --profile p \
        --space "space" no_such_space "01abc" <"$STUBS/bundle.json" 2>&1)"; status=$?
if [[ "$out" == *"unmanaged"* && "$status" -eq 2 ]]; then
  PASS=$((PASS + 1)); printf '  ok    %s\n' "a live space the bundle no longer declares is called unmanaged"
else
  FAIL=$((FAIL + 1)); printf '  FAIL  %s (exit %d)\n' "a live space the bundle no longer declares is called unmanaged" "$status"
fi

echo "shape tolerance"
# The API documents serialized_space as an object and returns a string. If a CLI
# release ever starts returning the object, that must not read as every space
# having drifted on the same morning.
python3 - "$STUBS" <<'PY'
import json, sys
stubs = sys.argv[1]
live = json.load(open(f"{stubs}/live-base.json"))
live["serialized_space"] = json.loads(live["serialized_space"])
json.dump(live, open(f"{stubs}/live.json", "w"))
PY
run_case "serialized_space as an object compares the same as a string" "IN SYNC" 0

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]] || exit 1
# A FLOOR, NOT A TOTAL. `FAIL -eq 0` is also true of a run that asserted nothing --
# every `run_case` here builds its stubs in a heredoc, and a python stanza that
# died would leave the count at zero and the exit status at green. Deliberately
# below the current count; raise it when cases are added.
readonly MIN_ASSERTIONS=11
[[ "$PASS" -ge "$MIN_ASSERTIONS" ]] || {
  printf '\nFAIL  only %d assertions ran; at least %d are expected.\n' "$PASS" "$MIN_ASSERTIONS" >&2
  printf '      Nothing failed, but this run did not check what it claims to.\n' >&2
  exit 1
}
