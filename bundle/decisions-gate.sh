#!/usr/bin/env bash
# Thin wrapper around bundle/decisions-gate.py. Sourced, not executed.
#
# The reasoning, and the three properties this check has to keep, are in
# decisions-gate.py. The split is so the logic can be tested directly with a
# fixture instead of only through a release script.
#
# Call it AFTER the configuration readout and BEFORE anything irreversible.
# Callers must exit on a non-zero return. There is deliberately no bypass flag:
# see bundle/DECISIONS.md.

decisions_gate() {
  step "Decisions this release is held against (bundle/DECISIONS.md)"
  bundle_json | DECISIONS_RECORD="$BUNDLE_ROOT/bundle/DECISIONS.md" \
    python3 "$BUNDLE_ROOT/bundle/decisions-gate.py"
}
