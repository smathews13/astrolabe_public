#!/usr/bin/env bash
# Proof that the semantic leg of bundle/genie-drift-check.py can go red.
#
# The leg compares the definitions Unity Catalog holds against the definitions the
# index is serving. Both sides come from captured JSON, so every case here is a pair
# of fabricated documents and nothing needs a workspace. It never reaches the network:
# `--semantic-evidence` on its own does not read the resolved bundle either.
#
# WHY THIS SUITE IS SEPARATE from genie-drift-check.test.sh. That suite drives the
# space legs, which need a profile and a bundle body on stdin. This one needs
# neither, so it runs in CI where that one cannot -- and a check that only runs
# where there is a workspace is a check that does not run.
#
#   bundle/semantic-drift.test.sh

set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GATE="$HERE/genie-drift-check.py"

PASS=0
FAIL=0
WORK="$(mktemp -d "${TMPDIR:-/tmp}/pia-semantic-drift-test.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT INT TERM

# The healthy pair: two tables, three described columns, and index entries carrying
# exactly those words. Everything below is a mutation of this.
healthy() {
  local dir="$WORK/$1"
  mkdir -p "$dir"
  cat > "$dir/uc-columns.json" <<'JSON'
[
  {"full_name": "cat.sch.gold_title_daily_summary",
   "comment": "Engagement and bookings by title and day.",
   "columns": [
     {"name": "event_date", "comment": "The calendar date the activity was recorded against."},
     {"name": "active_players", "comment": "Distinct players with at least one session, counted once per day."}
   ]},
  {"full_name": "cat.sch.gold_player_180d_summary",
   "comment": "One row per player over the reporting window.",
   "columns": [
     {"name": "player_id", "comment": "The player this row describes."}
   ]}
]
JSON
  cat > "$dir/semantic-entries.json" <<'JSON'
[
  {"entry_id": "t1c1", "source_ref": "cat.sch.gold_title_daily_summary",
   "generated_at": "2026-08-17T10:00:00Z",
   "content": "Engagement and bookings by title and day. event_date: The calendar date the activity was recorded against. active_players: Distinct players with at least one session, counted once per day."},
  {"entry_id": "t2c1", "source_ref": "cat.sch.gold_player_180d_summary",
   "generated_at": "2026-08-17T10:00:00Z",
   "content": "One row per player over the reporting window. player_id: The player this row describes."}
]
JSON
  printf '%s' "$dir"
}

check_says() {
  local label="$1" expected="$2" needle="$3" dir="$4"
  local out status
  out="$(python3 "$GATE" --profile unused --semantic-evidence "$dir" 2>&1)"
  status=$?
  if [[ "$status" != "$expected" ]] || ! printf '%s' "$out" | grep -qF -- "$needle"; then
    printf '  FAIL  %s\n        wanted exit %s and %q; got exit %s\n' \
      "$label" "$expected" "$needle" "$status"
    printf '%s\n' "$out" | sed 's/^/          /'
    FAIL=$((FAIL + 1)); return
  fi
  printf '  ok    %s\n' "$label"
  PASS=$((PASS + 1))
}

# perl, not sed: BSD sed ignores `\b`, exits 0 and changes nothing. The count is
# asserted so an edit matching nothing fails here rather than passing as a check
# that found no fault in a document it never changed.
edit() {
  local file="$1" expr="$2" n
  n="$(perl -0777 -pe "\$c += s${expr}; END { print STDERR \$c + 0 }" -i "$file" 2>&1 >/dev/null)"
  if [[ "${n:-0}" -lt 1 ]]; then
    printf '  FAIL  the test edit %s matched nothing in %s\n' "$expr" "$(basename "$file")"
    FAIL=$((FAIL + 1)); return 1
  fi
}

printf '\n==> the healthy pair\n'
D="$(healthy base)"
check_says "definitions that match are in sync" 0 "are being served as Unity Catalog holds them" "$D"

printf '\n==> the failure this leg exists for: a comment rewritten after the build\n'
# The exact shape of the real risk. 15_governed_metadata.sql rewords a column
# comment; nothing rebuilds the semantic layer; the index goes on serving the old
# wording and the agent quotes it as the governed meaning.
D="$(healthy reworded)"
edit "$D/uc-columns.json" \
  "{Distinct players with at least one session, counted once per day\.}{Distinct players with at least one session. Not a headcount across dates.}" && \
  check_says "a column comment reworded in the catalog and not rebuilt fails" 1 \
    "is not in the indexed entry" "$D"

# And the same for the table's own comment, which is a separate field on both sides.
D="$(healthy tablereworded)"
edit "$D/uc-columns.json" \
  "{Engagement and bookings by title and day\.}{Engagement, bookings and live-event activity by title and day.}" && \
  check_says "a table comment reworded in the catalog fails" 1 \
    "is not the text the index is serving" "$D"

printf '\n==> reflowing is NOT drift\n'
# A comment rewrapped across lines, or with different spacing, has the same words. A
# check that called that drift would be reported as noisy and switched off, which is
# how a check dies without anyone deciding to remove it.
D="$(healthy reflowed)"
edit "$D/semantic-entries.json" \
  "{Distinct players with at least one session, counted once per day\.}{Distinct   players with at least one   session, counted once per day}" && \
  check_says "whitespace and trailing punctuation folded, so a reflow is not drift" 0 \
    "in sync" "$D"

printf '\n==> a table nobody indexed, and an entry for a table nobody has\n'
D="$(healthy unindexed)"
python3 - "$D/semantic-entries.json" <<'PY'
import json, sys
p = sys.argv[1]; d = json.load(open(p))
json.dump([e for e in d if "player_180d" not in e["source_ref"]], open(p, "w"))
PY
check_says "a governed table with no indexed entry fails" 1 \
  "holds no entry derived from it" "$D"

D="$(healthy stale)"
python3 - "$D/uc-columns.json" <<'PY'
import json, sys
p = sys.argv[1]; d = json.load(open(p))
json.dump([t for t in d if "player_180d" not in t["full_name"]], open(p, "w"))
PY
check_says "an entry for a table the schema no longer has fails" 1 \
  "is not a table in the governed schema any more" "$D"

printf '\n==> an entry with no record of when it was derived\n'
D="$(healthy undated)"
python3 - "$D/semantic-entries.json" <<'PY'
import json, sys
p = sys.argv[1]; d = json.load(open(p))
for entry in d:
    entry.pop("generated_at", None)
json.dump(d, open(p, "w"))
PY
check_says "an entry carrying no generated_at fails" 1 "nothing records" "$D"

printf '\n==> a check that could not run must not report agreement\n'
D="$(healthy nouc)"; rm -f "$D/uc-columns.json"
check_says "a missing catalog document is exit 2" 2 \
  "is not an absence of drift" "$D"

D="$(healthy noentries)"; rm -f "$D/semantic-entries.json"
check_says "a missing entries document is exit 2" 2 \
  "is not an absence of drift" "$D"

D="$(healthy emptyuc)"; printf '[]' > "$D/uc-columns.json"
check_says "an empty catalog document is exit 2, not a clean schema" 2 \
  "failed capture rather than a clean one" "$D"

# The one most likely to be got wrong: an empty semantic table means retrieval
# returns nothing, and it is indistinguishable here from a capture that failed.
# Either way it is not agreement.
D="$(healthy emptyentries)"; printf '[]' > "$D/semantic-entries.json"
check_says "an empty entries document is exit 2, not zero drift" 2 \
  "look the same here" "$D"

D="$(healthy badjson)"; printf 'not json' > "$D/semantic-entries.json"
check_says "an unreadable document is exit 2" 2 "not readable JSON" "$D"

D="$(healthy wrongshape)"; printf '{"tables": []}' > "$D/uc-columns.json"
check_says "a document of the wrong shape is exit 2" 2 \
  "not a non-empty list" "$D"

check_says "a directory that does not exist is exit 2" 2 \
  "is not in" "$WORK/no-such-directory"

printf '\n==> and a run that compares nothing must not exit 0\n'
out="$(printf '{}' | python3 "$GATE" --profile unused 2>&1)"; status=$?
if [[ "$status" == 2 ]] && printf '%s' "$out" | grep -qF "must not exit 0"; then
  printf '  ok    no --space and no --semantic-evidence is exit 2\n'
  PASS=$((PASS + 1))
else
  printf '  FAIL  a run with nothing to compare gave exit %s\n' "$status"
  printf '%s\n' "$out" | sed 's/^/          /'
  FAIL=$((FAIL + 1))
fi

printf '\n'
if (( FAIL )); then
  printf 'FAIL  %d of %d assertions failed.\n' "$FAIL" "$((PASS + FAIL))"
  exit 1
fi
if (( PASS < 15 )); then
  printf 'FAIL  only %d assertions ran; this suite has 15. Something is being skipped.\n' "$PASS"
  exit 1
fi
printf 'PASS  %d assertions.\n' "$PASS"
