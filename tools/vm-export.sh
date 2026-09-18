#!/usr/bin/env bash
# Forced command for the restricted deploy key.
#
# The key in repository secrets is pinned in authorized_keys to this one script:
#
#   restrict,command="/bin/bash /root/shannon-refresh/vm-export.sh" <key>
#
# so whatever a client asks for, sshd runs this and puts the request in
# SSH_ORIGINAL_COMMAND. Everything the key can do therefore has to be a mode
# here, and nothing else is reachable - no shell, no port forwarding, no
# arbitrary commands.
#
# Modes:
#   (no argument), "export"  the GCS pipeline snapshot   -> gzipped pipeline.json
#   "truth"                  the derived pipeline        -> gzipped pipeline-truth.json
#
# Both write only inside /root/shannon-refresh and read GCS read-only. The lock
# is shared so the two modes cannot interleave and corrupt each other's output.
#
# Progress goes to stderr; stdout carries the gzip stream and nothing else.
set -euo pipefail

DASH=/root/harbor_gce/delivery-candidates-20260908-codex/pipeline-dashboard
cd /root/shannon-refresh
exec 9>/root/shannon-refresh/export.lock
flock -w 1200 9

MODE="${SSH_ORIGINAL_COMMAND:-export}"

case "$MODE" in
  truth)
    # The eight-step chain. Its own reconciliation step gates it: on a failed
    # invariant refresh_truth.sh exits non-zero, set -e stops here, and nothing
    # is written to stdout - so a caller can never receive unreconciled data.
    "$DASH/refresh_truth.sh" --no-publish >&2
    gzip -c "$DASH/truth-work/pipeline-truth.json"
    ;;
  export|"")
    PYTHONPATH="$DASH" python3 export_gcs_pipeline.py --out pipeline.json >&2
    gzip -c pipeline.json
    ;;
  *)
    echo "vm-export: unknown mode '$MODE' (expected 'export' or 'truth')" >&2
    exit 64
    ;;
esac
