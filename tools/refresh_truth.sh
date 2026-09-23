#!/usr/bin/env bash
# Rebuild the derived pipeline from the bucket, end to end.
#
#   verdicts -> delivery -> identity -> declared names -> linked identity
#            -> canonical -> state -> tags -> provenance -> reconcile -> publish
#
# The reconcile step is a gate, not a report: if any invariant fails the run
# stops and the previous pipeline-truth.json stays published. A figure that
# cannot explain itself is never shipped.
#
# READ-ONLY against GCS throughout. Writes only into its own working directory
# and, on success, the published copy.
#
#   ./refresh_truth.sh              rebuild and publish locally
#   ./refresh_truth.sh --no-publish rebuild only

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORK="${TRUTH_WORK:-$HERE/truth-work}"
PUBLISH="${TRUTH_PUBLISH:-$HERE/repo/assets}"
LOG="$WORK/refresh.log"
PUBLISH_ENABLED=1
[ "${1:-}" = "--no-publish" ] && PUBLISH_ENABLED=0

mkdir -p "$WORK"
cd "$WORK"

say() { printf '%s  %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" | tee -a "$LOG"; }

started=$(date +%s)
say "=== refresh start ==="

# Each step writes into $WORK and reads the previous step's output. They are
# separate processes on purpose: any one can be re-run alone while debugging a
# number, without re-reading the bucket.
say "step 1  verdict ingest"
python3 "$HERE/ingest_verdicts.py"      --out verdicts.json    >>"$LOG" 2>&1
say "step 2  delivery index"
python3 "$HERE/index_delivery.py"       --out delivery.json    >>"$LOG" 2>&1
say "step 3  identity"
python3 "$HERE/assign_identity.py"      --verdicts verdicts.json --delivery delivery.json \
                                        --out identities.json  >>"$LOG" 2>&1
# Step 3a keeps the name each submission declares in its task.toml. The cache
# lives in $WORK and is only ever added to, because the bucket prunes submission
# folders and a name not read in time is gone. A failed read is not fatal: the
# names already cached still apply.
say "step 3a declared names"
python3 "$HERE/scan_submission_names.py" --verdicts verdicts.json \
                                        --cache submission-names.json >>"$LOG" 2>&1 \
    || say "step 3a failed - continuing with the names already cached"
say "step 3b link identities by declared name"
python3 "$HERE/link_identity.py"        --identities identities.json --names submission-names.json \
                                        --out identities-linked.json --review link-review.json >>"$LOG" 2>&1
say "step 4  canonical run"
python3 "$HERE/select_canonical.py"     --identities identities-linked.json \
                                        --out canonical.json   >>"$LOG" 2>&1
say "step 5  state"
python3 "$HERE/derive_state.py"         --canonical canonical.json --delivery delivery.json \
                                        --out tasks.json       >>"$LOG" 2>&1
say "step 6  tags"
python3 "$HERE/build_tags.py"           --tasks tasks.json --gcs "$HERE/pipeline-stats.json" \
                                        --out tagged.json      >>"$LOG" 2>&1
say "step 7  provenance"
python3 "$HERE/build_provenance.py"     --tagged tagged.json --delivery delivery.json \
                                        --verdicts verdicts.json --identities identities-linked.json \
                                        --out pipeline-truth.json >>"$LOG" 2>&1

# The gate. A non-zero exit here leaves the published asset untouched.
say "step 8  reconcile"
if ! python3 "$HERE/reconcile.py" --truth pipeline-truth.json --delivery delivery.json \
        --tagged tagged.json >>"$LOG" 2>&1; then
    say "RECONCILIATION FAILED - keeping the previously published asset"
    tail -30 "$LOG" >&2
    exit 1
fi

summary=$(python3 - <<'PY'
import json
d = json.load(open('pipeline-truth.json'))
print(' / '.join(f"{f['label']} {f['value']:,}" for f in d['figures'][:6]))
PY
)
say "figures: $summary"

if [ "$PUBLISH_ENABLED" = 1 ]; then
    mkdir -p "$PUBLISH"
    # Write beside the target then move, so a reader never sees a half-written file.
    cp pipeline-truth.json "$PUBLISH/pipeline-truth.json.new"
    mv "$PUBLISH/pipeline-truth.json.new" "$PUBLISH/pipeline-truth.json"
    say "published -> $PUBLISH/pipeline-truth.json ($(du -h pipeline-truth.json | cut -f1))"
else
    say "not published (--no-publish)"
fi

say "=== refresh complete in $(( $(date +%s) - started ))s ==="
