#!/usr/bin/env bash
# Is the live Genie estate what this repository says it is?
#
# WHAT THIS REPLACES. `resources/*.genie_space.yml` used to carry a paragraph
# telling the operator to deploy, then read the live body back by hand and
# compare it, because a deploy that exits 0 is not evidence the instructions
# changed. That instruction was correct and nobody followed it, which is the
# ordinary fate of a manual comparison of two 10KB JSON blobs. The same file also
# carries a `version` and a set of instruction ids, and the obvious thing to do
# with those -- treat them as what decides whether a deploy is needed -- is
# exactly wrong: a version nobody bumped sits happily above rewritten text, so
# the tag agrees with the deploy rather than with the workspace.
#
# So the comparison is done here, on the content, by bundle/genie-drift-check.py.
#
# THIS READS. It makes no change to any workspace object and takes no deployment
# lock, so it is safe to run against a live deployment, including one somebody is
# mid-deploy on or demonstrating. It never deploys anything itself: it tells you
# whether a deploy would change something, and the deploy stays a decision a
# person makes.
#
# Usage:
#   TARGET=<your-target> bundle/genie-drift.sh
#   TARGET=example PROFILE="<your profile>" bundle/genie-drift.sh
#
# TARGET has no default. PROFILE is optional for a target that names its profile
# in databricks.yml; every other target must state one.
#
# Exit status:
#   0  in sync: a deploy would change nothing
#   1  drifted: what is committed is not what is running
#   2  at least one space could not be read, so nothing was established

set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/_lib.sh"

require_cmd databricks
require_cmd python3

require_target
resolve_profile

# The same three routes, in the same order, that agent-release.sh and
# preflight.sh resolve a space id by. Duplicated in shape rather than shared
# because these two lines are the whole of it; what must NOT diverge is the
# order, since a check that compared a different space from the one a release
# would use is worse than no check at all.
#
#   1. the environment      2. an ADOPTED id in the bundle      3. the bundle's own output
DATA_ADOPTED="$(bundle_var_or_empty genie_data_space_id 2>/dev/null)" || DATA_ADOPTED=""
DICT_ADOPTED="$(bundle_var_or_empty genie_dictionary_space_id 2>/dev/null)" || DICT_ADOPTED=""
DATA_BUILT="$(bundle_resource_id genie_spaces data_genie_space 2>/dev/null)" || DATA_BUILT=""
DICT_BUILT="$(bundle_resource_id genie_spaces dictionary_genie_space 2>/dev/null)" || DICT_BUILT=""
DATA_ID="${PLAYER_INSIGHTS_DATA_GENIE_ID:-${DATA_ADOPTED:-$DATA_BUILT}}"
DICT_ID="${PLAYER_INSIGHTS_DICTIONARY_GENIE_ID:-${DICT_ADOPTED:-$DICT_BUILT}}"

step "Genie content: this repository vs. the live workspace (target: $TARGET)"

bundle_json | python3 "$BUNDLE_ROOT/bundle/genie-drift-check.py" \
  --profile "$PROFILE" \
  --space "data genie space      " data_genie_space       "$DATA_ID" \
  --space "dictionary genie space" dictionary_genie_space "$DICT_ID"
