#!/usr/bin/env bash
# Close the connector gap without anyone having to notice it opened.
#
# build_cohort_index.py classifies a folder from the bucket scan, or from the
# delivery manifest that packaged it. A folder in neither is left unknown and
# listed by name in counts.unresolved. This opens those packages, reads their
# task.toml, and rebuilds the index with the answer.
#
# Three properties make it safe to run unattended:
#
#   cached   assets/task-toml-reads.json keeps every answer. A task.toml does
#            not change once its package is written, so a folder is read once
#            and never again. In the steady state there is nothing to do.
#   capped   at most MAX packages per run. A bad day - a prefix reorganised, a
#            scan that failed - cannot turn into a thousand downloads. Whatever
#            is left over stays unknown, honestly, and the next run takes the
#            next batch.
#   honest   if a package cannot be read, the folder stays unknown rather than
#            being guessed. The name is never consulted.
#
# Reads the bucket. Writes only into the repo.
set -euo pipefail

REPO="${1:-/root/shannon-ops-publish/repo}"
LISTING="${2:-/root/shannon-ops-publish/delivery-listing.txt}"
MAX="${MAX:-25}"
# python3 on the VM, python on a Windows checkout - so this can be exercised
# where it is written as well as where it runs.
PY="${PY:-$(command -v python3 || command -v python)}"

cd "$REPO"

unresolved=$("$PY" -c "
import json, sys
try:
    c = json.load(open('assets/cohort-index.json'))['counts']
except (OSError, KeyError, ValueError):
    sys.exit(0)
print(','.join(c.get('unresolved') or [])[:20000])
")

if [ -z "$unresolved" ]; then
  echo "no unclassified folders - nothing to read"
  exit 0
fi

batch=$(printf '%s' "$unresolved" | tr ',' '\n' | head -n "$MAX" | paste -sd, -)
count=$(printf '%s' "$batch" | tr ',' '\n' | grep -c . || true)
echo "reading task.toml for $count folder(s) the scan and the manifests do not cover"

"$PY" tools/read_task_toml.py --folders "$batch"

# Rebuild so the answers reach the page. The listing is the same one the
# manifest check uses, so the folder set does not move between the two.
if [ -f "$LISTING" ]; then
  "$PY" tools/build_cohort_index.py --listing "$LISTING"
else
  "$PY" tools/build_cohort_index.py
fi

"$PY" -c "
import json
c = json.load(open('assets/cohort-index.json'))['counts']
left = c.get('unresolved') or []
print(f\"connector: {c['connectorTasks']} / {c['nonConnectorTasks']} / {c['connectorUnknown']} unknown\")
if left:
    print(f'  {len(left)} still unresolved, next run takes the next batch: ' + ', '.join(left[:5]))
"
