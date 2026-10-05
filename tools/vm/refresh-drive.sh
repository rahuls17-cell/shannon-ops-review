#!/usr/bin/env bash
# The Delivery tab's Current view, refreshed from the shared Drive "Deliveries"
# folder: assets/drive-deliveries.json (every delivered package, Batches 1 to
# 4.1 included, read from Drive alone) and assets/drive-owners.json (their
# trainers, from those rows and the bucket export).
#
# Every 15 minutes. Each run:
#   1. reads the folder (GET only; manifests that have not changed come from
#      the cache in /root/shannon-refresh/drive-snapshot);
#   2. rebuilds the trainer names;
#   3. runs both Drive test suites - nothing is committed unless they pass;
#   4. commits and pushes those two files only, and only when they changed.
# The frozen GLM 5.3 cutoff files are never touched.
#
# Credentials, in the reader's own order: the key at
# /root/shannon-refresh/drive-reader.json when it exists (DRIVE_CREDENTIALS),
# otherwise the VM's service account through the metadata server, which works
# only once that account has the drive.readonly scope and Viewer on the folder.
# Neither is created here.
#
# A failed run changes nothing that is published; it is logged, and the last
# result is written to refresh-drive.status for anyone checking on it.
set -euo pipefail
BASE="/root/shannon-ops-publish"
REPO="$BASE/repo"
BRANCH="${PUBLISH_BRANCH:-main}"
LOG="$BASE/refresh-drive.log"
STATUS="$BASE/refresh-drive.status"
CACHE="/root/shannon-refresh/drive-snapshot"
KEY="/root/shannon-refresh/drive-reader.json"
FILES="assets/drive-deliveries.json assets/drive-owners.json"

log() { printf '%s  %s\n' "$(date -u '+%Y-%m-%d %H:%M:%S')" "$*" >>"$LOG"; }
status() { printf '%s %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$*" >"$STATUS"; }
fail() {
  log "FAIL: $* - the published Drive files stay as they were"
  status "FAILED $*"
  cd "$REPO" && git checkout -q -- assets/ 2>/dev/null || true
  exit 1
}

if [ -f "$LOG" ] && [ "$(stat -c%s "$LOG")" -gt 2000000 ]; then
  tail -c 500000 "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"
fi

# publish.sh works in the same clone and resets it every run, so the two take
# the same lock and wait for each other rather than share a checkout.
exec 9>"$BASE/.publish.lock"
if ! flock -w 600 9; then
  log "publish.sh held the clone for ten minutes - skipping this run"
  exit 0
fi

[ -f "$KEY" ] && export DRIVE_CREDENTIALS="$KEY"
mkdir -p "$CACHE"

log "=== drive refresh start ==="
cd "$REPO"
git fetch -q origin "+refs/heads/$BRANCH:refs/remotes/origin/$BRANCH"
git reset -q --hard "origin/$BRANCH"
git clean -qfd

# 1. Drive alone: --audit none, so Batches 1 to 4.1 come from their Drive
#    folders too rather than from the delivery audit.
python3 tools/build_drive_deliveries.py --audit none --save-dir "$CACHE" >>"$LOG" 2>&1 \
  || fail "Drive read"

# Folders the reader skipped (no manifest, unrecognised layout) are not errors;
# they are listed so someone sees them.
SKIPPED=$(python3 - <<'PY'
import json
d = json.load(open('assets/drive-deliveries.json'))
print('; '.join('%s: %s' % (s.get('name'), s.get('reason')) for s in d.get('skipped', [])))
PY
)
[ -n "$SKIPPED" ] && log "skipped folders: $SKIPPED"

# 2. Trainer names for those rows.
python3 tools/build_drive_owners.py >>"$LOG" 2>&1 || fail "trainer names"

# 3. Both suites must pass before anything is committed.
python3 tools/test_drive_deliveries.py >>"$LOG" 2>&1 || fail "test_drive_deliveries.py"
python3 tools/test_drive_owners.py >>"$LOG" 2>&1 || fail "test_drive_owners.py"

# 4. Those two files only, and only when they changed.
if git diff --quiet -- $FILES; then
  log "no change on Drive"
  status "OK unchanged${SKIPPED:+ | skipped: $SKIPPED}"
  exit 0
fi
SUMMARY=$(python3 - <<'PY'
import json
d = json.load(open('assets/drive-deliveries.json'))
print('%d packages from %d batches' % (len(d['rows']), len(d['batches'])))
PY
)
git add $FILES
git commit -q -m "Drive refresh: $SUMMARY"
if git push -q origin "HEAD:$BRANCH" 2>>"$LOG"; then
  log "pushed: $SUMMARY"
  status "OK pushed $SUMMARY${SKIPPED:+ | skipped: $SKIPPED}"
else
  git reset -q --hard "origin/$BRANCH"
  fail "push rejected ($BRANCH moved); the next run starts from it"
fi
