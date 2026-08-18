#!/usr/bin/env bash
# advisory-suite: app service principal holds no data-schema read privilege
#
# Proves bundle/assert-sp-no-data-select.py CAN FAIL, and fails for the right
# reasons. That is the whole point of this file rather than a nice-to-have: this
# repository has shipped a release suite that passed without asserting anything
# and a leak rule that matched nothing for months while exiting 0. A grant check
# that cannot fail is worse than no grant check, because a green tick is read as
# a statement about access.
#
# THE ASSERTION THAT MATTERS MOST is `inherited via group fails`. Revoking the app
# SP's own grant on 2026-08-17 did not close its read access, because a group it
# belongs to holds ALL_PRIVILEGES on the catalog. A check reading only direct
# grants would have passed that deployment while the capability was wide open. If
# you are about to simplify this script, that assertion is the one to keep.
#
# NO WORKSPACE NEEDED. `databricks` is stubbed on PATH, so every case here is a
# fixture and the suite is deterministic. Nothing below reaches a real estate,
# which also means a passing run says nothing about the live deployment -- run the
# script itself for that.

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$HERE/assert-sp-no-data-select.py"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/pia-sp-assert.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

PASS=0
FAIL=0
# Every case below has to run. A suite that silently stopped after case 2 would
# still print PASS lines and still exit 0.
MIN_ASSERTIONS=13

ok()   { PASS=$((PASS + 1)); printf '  ok    %s\n' "$1"; }
bad()  { FAIL=$((FAIL + 1)); printf '  FAIL  %s\n' "$1"; }

# A stub `databricks` that answers from fixture files, so the cases differ only
# in what Unity Catalog is pretending to report.
make_stub() {
  local dir="$1"
  mkdir -p "$dir/bin"
  cat > "$dir/bin/databricks" <<'STUB'
#!/usr/bin/env bash
# Fixture-backed stand-in for the CLI. $STUB_DIR/<key>.json is the reply.
path=""
for arg in "$@"; do path="$arg"; done
case "$path" in
  */apps/*)                    key="app" ;;
  */tables\?*)                 key="tables" ;;
  */effective-permissions/catalog/*) key="eff_catalog" ;;
  */effective-permissions/schema/*)  key="eff_schema" ;;
  */effective-permissions/table/*)   key="eff_table" ;;
  *)                           key="unknown" ;;
esac
file="$STUB_DIR/$key.json"
if [ ! -f "$file" ]; then
  echo "stub has no fixture for $key ($path)" >&2
  exit 1
fi
cat "$file"
STUB
  chmod +x "$dir/bin/databricks"
}

# One securable each, so a finding count is readable.
write_fixtures() {
  local dir="$1" eff_catalog="$2" eff_schema="$3"
  mkdir -p "$dir"
  printf '%s\n' '{"service_principal_client_id":"sp-client-id","service_principal_name":"app sp"}' \
    > "$dir/app.json"
  printf '%s\n' '{"tables":[{"full_name":"cat.sch.silver_player_profiles"}]}' > "$dir/tables.json"
  printf '%s\n' "$eff_catalog" > "$dir/eff_catalog.json"
  printf '%s\n' "$eff_schema" > "$dir/eff_schema.json"
  printf '%s\n' '{"privilege_assignments":[]}' > "$dir/eff_table.json"
}

NOTHING='{"privilege_assignments":[]}'
# Granted straight to the service principal. The easy case.
DIRECT='{"privilege_assignments":[{"principal":"sp-client-id","privileges":[{"privilege":"SELECT"}]}]}'
# Held by a group the SP is in. The case that actually happened.
VIA_GROUP='{"privilege_assignments":[{"principal":"account users","privileges":[{"privilege":"SELECT"}]}]}'
# Held by a group AND inherited from the catalog: what this deployment reports.
INHERITED='{"privilege_assignments":[{"principal":"account users","privileges":[{"privilege":"ALL_PRIVILEGES","inherited_from_name":"cat","inherited_from_type":"CATALOG"}]}]}'
# A privilege that is not a read. Must not be reported.
WRITE_ONLY='{"privilege_assignments":[{"principal":"sp-client-id","privileges":[{"privilege":"MODIFY"}]}]}'

# run <fixture-dir> <exceptions-json-or-empty> -> writes $OUT, sets $STATUS
run() {
  local dir="$1" exceptions="$2"
  local sandbox="$WORK/sandbox"
  rm -rf "$sandbox"
  mkdir -p "$sandbox"
  cp "$SCRIPT" "$sandbox/assert-sp-no-data-select.py"
  # The script reads its exceptions from a file beside itself, so the copy is how
  # a case controls them without editing the committed one.
  [ -n "$exceptions" ] && printf '%s\n' "$exceptions" > "$sandbox/sp-data-access-exceptions.json"
  make_stub "$sandbox"
  OUT="$WORK/out.txt"
  STUB_DIR="$dir" PATH="$sandbox/bin:$PATH" \
    python3 "$sandbox/assert-sp-no-data-select.py" \
      --app the-app --catalog cat --schema sch --today 2026-08-17 \
      > "$OUT" 2>&1
  STATUS=$?
}

printf '\n==> no read privilege anywhere\n'
write_fixtures "$WORK/f1" "$NOTHING" "$NOTHING"
run "$WORK/f1" ""
if [ "$STATUS" -eq 0 ] && grep -q "PASS: no read privilege" "$OUT"; then
  ok "a principal with nothing passes"
else
  bad "a clean estate should pass, got status $STATUS"; cat "$OUT"
fi

printf '\n==> a non-read privilege is not a finding\n'
write_fixtures "$WORK/f2" "$WRITE_ONLY" "$WRITE_ONLY"
run "$WORK/f2" ""
if [ "$STATUS" -eq 0 ]; then
  ok "MODIFY alone does not trip a read assertion"
else
  bad "MODIFY was reported as a read finding"; cat "$OUT"
fi

printf '\n==> direct grant to the service principal\n'
write_fixtures "$WORK/f3" "$NOTHING" "$DIRECT"
run "$WORK/f3" ""
if [ "$STATUS" -ne 0 ] && grep -q "REFUSED" "$OUT" \
   && grep -q "granted directly to the app service principal" "$OUT"; then
  ok "a direct SELECT fails, and is named as direct"
else
  bad "a direct SELECT did not fail"; cat "$OUT"
fi

printf '\n==> inherited via group (the case a direct-only check would miss)\n'
write_fixtures "$WORK/f4" "$NOTHING" "$VIA_GROUP"
run "$WORK/f4" ""
if [ "$STATUS" -ne 0 ] && grep -q "REFUSED" "$OUT" \
   && grep -q "held by the group 'account users'" "$OUT"; then
  ok "a group-held SELECT fails, and names the group"
else
  bad "a group-held SELECT did not fail: THIS IS THE ONE THAT MATTERS"; cat "$OUT"
fi

printf '\n==> inherited from an ancestor securable\n'
write_fixtures "$WORK/f5" "$INHERITED" "$INHERITED"
run "$WORK/f5" ""
if [ "$STATUS" -ne 0 ] && grep -q "ALL_PRIVILEGES on cat" "$OUT"; then
  ok "ALL_PRIVILEGES inherited from the catalog fails, attributed to the catalog"
else
  bad "catalog-inherited ALL_PRIVILEGES did not fail"; cat "$OUT"
fi

printf '\n==> a recorded exception covers its finding\n'
write_fixtures "$WORK/f6" "$NOTHING" "$VIA_GROUP"
run "$WORK/f6" '{"exceptions":[{"granted_on":"${catalog}.${schema}","privilege":"SELECT",
  "via_principal":"account users","reason":"known","owner":"a role","review_by":"2026-12-31"}]}'
if [ "$STATUS" -eq 0 ] && grep -q "RECORDED" "$OUT"; then
  ok "a complete, in-date exception passes and prints as RECORDED"
else
  bad "a valid exception did not cover its finding"; cat "$OUT"
fi

printf '\n==> a lapsed exception stops being one\n'
write_fixtures "$WORK/f7" "$NOTHING" "$VIA_GROUP"
run "$WORK/f7" '{"exceptions":[{"granted_on":"${catalog}.${schema}","privilege":"SELECT",
  "via_principal":"account users","reason":"known","owner":"a role","review_by":"2026-08-16"}]}'
if [ "$STATUS" -ne 0 ] && grep -q "lapsed on 2026-08-16" "$OUT"; then
  ok "an exception one day past review_by fails the run"
else
  bad "a lapsed exception still suppressed its finding"; cat "$OUT"
fi

printf '\n==> an incomplete exception covers nothing\n'
write_fixtures "$WORK/f8" "$NOTHING" "$VIA_GROUP"
run "$WORK/f8" '{"exceptions":[{"granted_on":"${catalog}.${schema}","privilege":"SELECT",
  "via_principal":"account users","review_by":"2026-12-31"}]}'
if [ "$STATUS" -ne 0 ] && grep -q "is incomplete (missing reason, owner)" "$OUT"; then
  ok "an exception with no reason or owner is refused, not honoured"
else
  bad "an exception missing its reason still suppressed a finding"; cat "$OUT"
fi

printf '\n==> an unresolved placeholder is refused rather than silently matching nothing\n'
write_fixtures "$WORK/f9" "$NOTHING" "$VIA_GROUP"
run "$WORK/f9" '{"exceptions":[{"granted_on":"${warehouse}","privilege":"SELECT",
  "via_principal":"account users","reason":"known","owner":"a role","review_by":"2026-12-31"}]}'
if [ "$STATUS" -ne 0 ] && grep -q "unresolved placeholder" "$OUT"; then
  ok "a placeholder the script cannot resolve fails loudly"
else
  bad "an unresolvable placeholder passed quietly"; cat "$OUT"
fi

printf '\n==> a finding and a failure to look are different exit codes\n'
# THE GATE IN agent-release.sh BRANCHES ON THESE NUMBERS, so they are asserted
# exactly rather than as "non-zero". Both block. They are separated because the
# remedy is completely different -- 1 is a grant to revoke, 2 is a question that
# was never asked -- and because a caller that cannot tell them apart is one
# refactor away from being taught to tolerate "the check failed".
write_fixtures "$WORK/f9" "$NOTHING" "$VIA_GROUP"
run "$WORK/f9" ""
if [ "$STATUS" -eq 1 ]; then
  ok "a finding is exit 1, exactly"
else
  bad "a finding should be exit 1, got $STATUS"; cat "$OUT"
fi

# An EMPTY fixture directory makes the stub exit non-zero for every call, which
# is what no credentials, no network and a revoked token all look like from here.
mkdir -p "$WORK/f10"
run "$WORK/f10" ""
if [ "$STATUS" -eq 2 ] && grep -q "COULD NOT RUN" "$OUT" \
   && ! grep -q "PASS:" "$OUT"; then
  ok "a workspace that cannot be reached is exit 2, and never prints PASS"
else
  bad "an unreachable workspace should be exit 2 and no PASS, got $STATUS"; cat "$OUT"
fi

# The app answered, but with no service principal in it. Reading that as "no
# principal, therefore no access" would be the purest form of the bug this whole
# file exists for: a green tick over a question nobody asked.
mkdir -p "$WORK/f11"
printf '%s\n' '{"name":"the-app"}' > "$WORK/f11/app.json"
run "$WORK/f11" ""
if [ "$STATUS" -eq 2 ] && grep -q "no principal to check" "$OUT"; then
  ok "an app reporting no service principal is exit 2, not a pass"
else
  bad "an app with no SP should be exit 2, got $STATUS"; cat "$OUT"
fi

# The CLI printed something that is not JSON -- an auth prompt, a warning banner,
# an HTML error page from a proxy. Parsed as "no privilege_assignments" this
# would pass.
mkdir -p "$WORK/f12"
printf '%s\n' 'Error: cannot configure default credentials' > "$WORK/f12/app.json"
run "$WORK/f12" ""
if [ "$STATUS" -eq 2 ] && grep -q "COULD NOT RUN" "$OUT"; then
  ok "output that is not JSON is exit 2, not an empty grant list"
else
  bad "non-JSON output should be exit 2, got $STATUS"; cat "$OUT"
fi

printf '\n'
# A REAL FAILURE IS REPORTED AS A FAILURE, and the floor is checked after it.
# These two were the other way round, and a case that went red therefore also
# dropped PASS below the floor, so the last line of the run said "this run did
# not check what it claims to" about a run that checked exactly what it claims to
# and found a fault. Weakening READ_PRIVILEGES to drop ALL_PRIVILEGES was summed
# up as a suite that had not run. The floor answers "did the cases execute", so
# it is only worth asking once nothing has actually failed.
if [ "$FAIL" -ne 0 ]; then
  printf 'FAIL  %d of %d assertions failed.\n' "$FAIL" "$((PASS + FAIL))" >&2
  exit 1
fi
if [ "$PASS" -lt "$MIN_ASSERTIONS" ]; then
  printf 'FAIL  only %d assertions ran; at least %d are expected.\n' "$PASS" "$MIN_ASSERTIONS" >&2
  printf '      Nothing failed, but this run did not check what it claims to.\n' >&2
  exit 1
fi
printf 'PASS  %d assertions.\n' "$PASS"
