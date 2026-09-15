#!/usr/bin/env bash
set -euo pipefail
cd /root/shannon-refresh
exec 9>/root/shannon-refresh/export.lock
flock -w 1200 9
PYTHONPATH=/root/harbor_gce/delivery-candidates-20260908-codex/pipeline-dashboard \
  python3 export_gcs_pipeline.py --out pipeline.json >&2
gzip -c pipeline.json
