#!/usr/bin/env bash
# The four-trial GLM band for every pipeline task, read from the bucket.
#
# Once a day, not every tick: it walks about five objects per task and takes
# roughly a quarter of an hour, so inside publish.sh it would block the
# ten-minute cron behind its own flock and stall the dashboard.
#
# Reads only. Leaves its result beside publish.sh, which copies it into the
# repo on the next tick. Runs the scanner from the clone publish.sh keeps on
# PUBLISH_BRANCH; it does not reset that clone itself, so it can never pull the
# checkout out from under a publish that is running.
set -euo pipefail
BASE="/root/shannon-ops-publish"
cd "$BASE/repo"
exec 9>"$BASE/.scan-glm.lock"
flock -n 9 || { echo "a scan is already running"; exit 0; }
# Written to a temporary file and moved, so publish.sh can never copy a
# half-written index into the repo.
python3 tools/scan_glm_trials.py --workers 64 --out "$BASE/glm-index.json.new" \
  && mv "$BASE/glm-index.json.new" "$BASE/glm-index.json"
