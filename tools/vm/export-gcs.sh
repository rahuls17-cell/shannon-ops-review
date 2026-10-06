#!/usr/bin/env bash
# The bucket export the dashboard's Overview reads (assets/gcs-pipeline.json):
# accepted folders across all three accepted prefixes, evaluation runs and
# trainer records. GitHub used to fetch it over SSH from task-mining-node-1;
# that route closed on 2026-09-28, so the hub now makes it and publish.sh
# publishes it.
#
# Every 30 minutes: a run reads tens of thousands of objects and takes
# minutes, too long for publish.sh's ten-minute tick. Written to a temporary
# file, checked, then moved, so publish.sh never copies a partial export.
#
# Reads GCS only. Never writes to the bucket.
set -euo pipefail
BASE="/root/shannon-ops-publish"
CHAIN="/root/harbor_gce/delivery-candidates-20260908-codex/pipeline-dashboard"
LOG="$BASE/export-gcs.log"
exec 9>"$BASE/.export-gcs.lock"
flock -n 9 || exit 0
log() { printf '%s  %s\n' "$(date -u '+%Y-%m-%d %H:%M:%S')" "$*" >>"$LOG"; }
if [ -f "$LOG" ] && [ "$(stat -c%s "$LOG")" -gt 2000000 ]; then
  tail -c 500000 "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"
fi
log "export start"
# The repo's copy of the exporter (it refreshes its token mid-run); it imports
# scan_bucket from the chain directory and keeps its archive cache in
# /root/shannon-refresh.
if PYTHONPATH="$CHAIN" python3 "$BASE/repo/tools/export_gcs_pipeline.py" --out "$BASE/gcs-pipeline.json.new" >>"$LOG" 2>&1 \
   && python3 -c 'import json,sys; p=json.load(open(sys.argv[1])); assert p["schemaVersion"]==3 and p["finalisation"]["tasks"]' "$BASE/gcs-pipeline.json.new" >>"$LOG" 2>&1; then
  mv "$BASE/gcs-pipeline.json.new" "$BASE/gcs-pipeline.json"
  log "export done"
else
  rm -f "$BASE/gcs-pipeline.json.new"
  log "export FAILED - the previous export stays in place"
  exit 1
fi
