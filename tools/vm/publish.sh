#!/usr/bin/env bash
# Rebuild the derived pipeline on this VM and push it to shannon-ops-review.
#
# Why this exists: the GitHub schedule is best-effort and delivers about 2% of
# what the cron asks for - a run every three hours against every five minutes.
# This box's own cron is reliable, so the work happens here and the result is
# pushed. A deploy workflow on the repo publishes it, because that Pages site
# builds from a workflow and a bare push would not deploy on its own.
#
# The chain runs in the VM's own directory, not in the repo clone: it imports
# scan_bucket, which lives here and is not in the repository. Only the finished
# asset is copied across. That is the same split the GitHub workflow uses - it
# ssh's in, runs the chain here, and scp's the result out.
#
# Reads GCS only. Never writes to the bucket. Pushes assets, never code.
#
# On yogesh-audit-vm, the dashboard's one hub since 2026-10-05 (moved from
# task-mining-node-1). Kept in the repo as tools/vm/publish.sh; the copy that
# runs is /root/shannon-ops-publish/publish.sh. Beyond node 1's version it
#   - publishes to PUBLISH_BRANCH (main unless the cron says otherwise), so the
#     new hub can be tested on staging while node 1 still publishes main;
#   - runs the bucket scan the pipeline's tags read (pipeline-stats.json), which
#     node 1 got from a separate dashboard's cron;
#   - publishes the bucket export (gcs-pipeline.json) and the Drive trainer
#     names, which GitHub used to pull over SSH - a route IT closed on 09-28.
set -euo pipefail
BRANCH="${PUBLISH_BRANCH:-main}"

CHAIN="/root/harbor_gce/delivery-candidates-20260908-codex/pipeline-dashboard"
BASE="/root/shannon-ops-publish"
REPO="$BASE/repo"
LOG="$BASE/publish.log"
LOCK="$BASE/.publish.lock"

log() { printf '%s  %s\n' "$(date -u '+%Y-%m-%d %H:%M:%S')" "$*" | tee -a "$LOG"; }

# A slow chain must never race the next cron tick into a push.
exec 9>"$LOCK"
if ! flock -n 9; then
  log "another publish is running - exiting"
  exit 0
fi

# Keep the log bounded on a 10-minute cron.
if [ -f "$LOG" ] && [ "$(stat -c%s "$LOG")" -gt 5000000 ]; then
  tail -c 1000000 "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"
fi

log "=== publish start ==="

cd "$REPO"
# Start from what is published, so a human push is never clobbered and a failed
# run leaves nothing behind.
# Fetched by full refspec: the clone may track main only, and a bare
# `git fetch origin <branch>` would then leave origin/<branch> missing.
git fetch -q origin "+refs/heads/$BRANCH:refs/remotes/origin/$BRANCH"
git reset -q --hard "origin/$BRANCH"
git clean -qfd
BEFORE=$(python3 -c "import json;print(json.load(open('assets/pipeline-truth.json'))['generatedAt'])" 2>/dev/null || echo none)

# The bucket scan the chain's tags read (build_tags --gcs pipeline-stats.json).
# Cached by archive sha256, so a tick reads only new archives - about two
# seconds. A failed scan keeps the previous file, so the chain still runs.
log "scanning the bucket"
( cd "$CHAIN" && python3 scan_bucket.py --out pipeline-stats.json.new --cache scan-cache.json >>"$LOG" 2>&1 \
    && mv pipeline-stats.json.new pipeline-stats.json ) \
  || log "bucket scan failed - the chain reads the previous pipeline-stats.json"

log "running the chain in $CHAIN"
cd "$CHAIN"
if ! ./refresh_truth.sh --no-publish >>"$LOG" 2>&1; then
  log "FAIL: the chain did not finish - its own reconciliation gates it, so nothing is published"
  exit 1
fi

BUILT="$CHAIN/truth-work/pipeline-truth.json"
if ! python3 - "$BUILT" <<'CHECK' >>"$LOG" 2>&1; then
import json, sys
p = json.load(open(sys.argv[1]))
assert p.get('reconciles') is True, 'asset did not reconcile'
assert p.get('tasks'), 'asset carries no rows'
for f in p.get('figures', []):
    counts = [s['count'] for s in f['steps']]
    assert counts and counts[-1] == f['value'], f"figure {f['label']!r} has no chain ending at its value"
print(p['generatedAt'], len(p['tasks']), 'rows')
CHECK
  log "FAIL: the rebuilt asset failed its checks - keeping the published one"
  exit 1
fi

cd "$REPO"
cp "$BUILT" assets/pipeline-truth.json

# These read JSON only - no bucket, no scan_bucket - so the repo's own copies
# are the right ones to run, and they stay in step with what the page expects.
log "rejoining the indexes"
# The delivery manifests against the bucket itself, and the folder set that
# Accepted is counted from. Listed every run at about six seconds: it is the
# headline figure and a stale listing is a stale headline.
# The delivery manifests against the bucket itself: is the exact object each
# manifest names still there? That is what turns "delivered" from a claim into
# a check. The listing walks ~3,800 objects and already-delivered packages
# barely move, so it is refreshed once a day rather than on every ten-minute
# tick. If it fails, the builder carries the previous answer forward and the
# page keeps printing the date that answer was taken - stale, but never wrong.
#
# Reads the bucket. Never writes to it: list_delivery_prefix.py asks for the
# read_only scope and issues GET, and the test suite fails if it ever gains a
# write verb.
LISTING="$BASE/delivery-listing.txt"
if true; then
  log "listing the delivery prefix"
  python3 tools/list_delivery_prefix.py --out "$LISTING" >>"$LOG" 2>&1 \
    || log "listing failed - keeping the previous one"
fi
# The GLM band, produced by the separate daily scan. Copied in rather than run
# here: the scan reads about five objects per pipeline task and takes a quarter
# of an hour, which would block the ten-minute tick this script runs on. With no
# scan yet there is simply no file and the column reads "not recorded".
if [ -f "$BASE/glm-index.json" ]; then
  cp "$BASE/glm-index.json" assets/glm-index.json
fi
python3 tools/build_manifest_index.py --listing "$LISTING" >>"$LOG" 2>&1
# The accepted cohort, counted by bucket folder. It uses the same daily
# listing the manifest check does, so the folder set cannot move between the
# two, and the verdicts it joins on are the ones just rebuilt above.
python3 tools/build_cohort_index.py --listing "$LISTING" >>"$LOG" 2>&1
# Any folder the scan and the manifests both miss gets its package opened and
# its task.toml read. Cached and capped, so the steady state is a no-op.
bash tools/resolve-unknown-connectors.sh "$REPO" "$LISTING" >>"$LOG" 2>&1 \
  || log "connector resolve failed - the index keeps its previous answers"
# Which bench each task runs on, read from the FROM line of its Dockerfile in
# the task-source tree. One small GET per task and never the same task twice, so
# the steady state is a handful of reads for genuinely new tasks; --max-new caps
# a cold or reorganised run so it can never turn into an unbounded crawl on a
# ten-minute tick.
#
# The cache lives in $BASE, not in the clone, because the clone is reset --hard
# on every run. It is copied into assets/ and committed, so the page reads a
# fresh index and a failed run still leaves the previous one published.
#
# Reads the bucket. Never writes to it.
log "topping up the bench index"
# The repo's own copy now that it is on main; the staged one stays as a
# fallback for a run that starts before a checkout has it.
BENCH_SCAN=tools/scan_bench.py
[ -f "$BENCH_SCAN" ] || BENCH_SCAN="$BASE/bench/scan_bench.py"
if python3 "$BENCH_SCAN" \
      --truth assets/pipeline-truth.json \
      --reads assets/task-toml-reads.json \
      --out "$BASE/bench-index.json" \
      --max-new 600 >>"$LOG" 2>&1; then
  cp "$BASE/bench-index.json" assets/bench-index.json
else
  log "bench scan failed - the published index keeps its previous answers"
fi
# Which task each accepted folder actually holds, read from the [task] name in
# its package task.toml. Accepted counts folders, and the same task is re-cut
# under a new folder name after a review, so folders and tasks are not the same
# number - 1,169 folders held 1,118 tasks when this was first measured. Without
# this the page can only count folders and cannot say which ones are the same
# work.
#
# The cache lives in $BASE and is a different shape from the published file: it
# keeps a reason for every folder it could not read, so a folder is opened once
# and never again. Publishing that shape and reading it back would re-open all
# 1,169 packages on every tick, which is why --asset is separate from --out.
#
# Reads the bucket over HTTP Range - about 40 KB per new folder rather than the
# 6-10 MB the archive weighs. Never writes to it.
NAME_SCAN=tools/scan_task_names.py
[ -f "$NAME_SCAN" ] || NAME_SCAN="$BASE/bench/scan_task_names.py"
log "reading task names for new accepted folders"
if python3 "$NAME_SCAN" \
      --out "$BASE/task-names-cache.json" \
      --asset assets/task-names.json >>"$LOG" 2>&1; then
  :
else
  log "task-name scan failed - the published index keeps its previous answers"
  git checkout -q -- assets/task-names.json 2>/dev/null || true
fi
python3 tools/build_delivered_index.py >>"$LOG" 2>&1
python3 tools/build_connector_index.py >>"$LOG" 2>&1

# The bucket export the Overview reads - accepted folders across all three
# prefixes, evaluations, trainer records. export-gcs.sh writes it beside this
# script on its own 30-minute cron (a run takes minutes); it is copied in here
# only when it is a newer export than the one published, and checked first.
GCS="$BASE/gcs-pipeline.json"
if [ -f "$GCS" ] && python3 - "$GCS" assets/gcs-pipeline.json <<'NEWER' >>"$LOG" 2>&1; then
import json, sys
new = json.load(open(sys.argv[1]))
assert new.get('schemaVersion') == 3 and new['finalisation']['tasks'], 'export is not a usable snapshot'
try:
    old = json.load(open(sys.argv[2]))['generatedAt']
except Exception:
    old = ''
sys.exit(0 if new['generatedAt'] > old else 1)
NEWER
  log "publishing the bucket export"
  cp "$GCS" assets/gcs-pipeline.json
  python3 -c 'import json; p=json.load(open("assets/gcs-pipeline.json")); json.dump({"generatedAt":p["generatedAt"]},open("assets/pipeline-version.json","w"))'
fi
# Trainers for the Drive batches, from that export and the pipeline. Reads the
# checkout only.
if [ -f assets/drive-deliveries.json ]; then
  python3 tools/build_drive_owners.py >>"$LOG" 2>&1 \
    || log "Drive owner index failed - keeping the previous drive-owners.json"
fi

AFTER=$(python3 -c "import json;print(json.load(open('assets/pipeline-truth.json'))['generatedAt'])")

if git diff --quiet -- assets/; then
  log "nothing changed since $BEFORE - no commit"
  log "=== publish complete ==="
  exit 0
fi

SUMMARY=$(python3 -c "
import json, collections
t = json.load(open('assets/pipeline-truth.json'))
s = collections.Counter(r['state'] for r in t['tasks'])
print(f\"{len(t['tasks'])} tasks, {s['accepted']} accepted, {s['rejected']} rejected\")
")

git add assets/pipeline-truth.json assets/delivered-index.json assets/connector-index.json assets/manifest-index.json assets/glm-index.json assets/cohort-index.json assets/task-toml-reads.json assets/bench-index.json assets/task-names.json
git add assets/gcs-pipeline.json assets/pipeline-version.json assets/drive-owners.json 2>/dev/null || true
git commit -q -m "Refresh from the VM: $SUMMARY"

# A human push between the fetch above and here is rejected rather than
# overwritten; the next tick starts again from whatever landed.
if git push -q origin "HEAD:$BRANCH" 2>>"$LOG"; then
  log "pushed: $BEFORE -> $AFTER ($SUMMARY)"
else
  log "push rejected - $BRANCH moved under us; the next run will start from it"
  git reset -q --hard "origin/$BRANCH"
  exit 1
fi

log "=== publish complete ==="
