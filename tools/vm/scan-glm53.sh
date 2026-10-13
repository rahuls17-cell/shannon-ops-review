#!/usr/bin/env bash
# The GLM-5.3 runs per task, for the Pipeline's "GLM-5.3 failed" label.
#
# Downloads the README and results files at the top of each run folder in
# gs://obi-harbor-pipeline/glm53-runs/ - not the attempts, which the results
# file already records - and indexes them with tools/build_glm53_index.py.
# Reads only. Leaves glm53-index.json beside publish.sh, which copies it into
# the repo on the next tick, the way scan-glm.sh does for GLM-5.2.
set -euo pipefail
BASE="/root/shannon-ops-publish"
RUNS="$BASE/work/glm53"
SRC="gs://obi-harbor-pipeline/glm53-runs"
exec 9>"$BASE/.scan-glm53.lock"
flock -n 9 || { echo "a GLM-5.3 scan is already running"; exit 0; }
mkdir -p "$RUNS"
for run in $(gcloud storage ls "$SRC/" | sed "s#^$SRC/##; s#/\$##"); do
  mkdir -p "$RUNS/$run"
  files=$(gcloud storage ls "$SRC/$run/" | grep -v '/$' || true)
  [ -n "$files" ] && gcloud storage cp -q $files "$RUNS/$run/"
done
# The builder from the clone publish.sh keeps on PUBLISH_BRANCH; until that
# branch carries it, the copy installed beside this script.
TOOL="$BASE/repo/tools/build_glm53_index.py"
[ -f "$TOOL" ] || TOOL="$BASE/build_glm53_index.py"
python3 "$TOOL" --runs "$RUNS" --out "$BASE/glm53-index.json.new" \
  && mv "$BASE/glm53-index.json.new" "$BASE/glm53-index.json"
