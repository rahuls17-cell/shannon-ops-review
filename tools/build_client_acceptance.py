"""Snapshot client acceptance from the Harbor 240 dashboard.

A task is client accepted when the audit sheet marks it priority Low. That
layer is published on the public 240 dashboard, so this reads the published
page rather than the sheet, and writes a small counts-only asset - no task
names, no owners, nothing that could carry a person.

    python tools/build_client_acceptance.py
"""
import json
import re
from collections import Counter
from datetime import datetime
from pathlib import Path

DASHBOARD = Path(r"D:\repos\harbor-240-dashboard\index.html")
SOURCE_URL = "https://rahuls17-cell.github.io/harbor-240-dashboard/"
OUT = Path(__file__).resolve().parent.parent / "assets" / "client-acceptance.json"
ACCEPTED_PRIORITY = "Low"


def build():
    html = DASHBOARD.read_text(encoding="utf-8")
    match = re.search(r'id="dashboard-data"[^>]*>(.*?)</script>', html, re.S)
    if not match:
        raise SystemExit(f"No dashboard payload in {DASHBOARD}")
    payload = json.loads(match.group(1))
    rows = payload["rows"]
    if not rows:
        raise SystemExit("The 240 dashboard published no rows")

    priorities = Counter(row.get("priority") or "Not set" for row in rows)
    accepted = [row for row in rows if row.get("priority") == ACCEPTED_PRIORITY]
    # The published acceptance layer is derived from the same sheet, so it is a
    # free cross-check on the priority rule rather than a second source.
    layer = {row["id"] for row in rows if row.get("acceptance") == "Accepted"}
    if layer and layer != {row["id"] for row in accepted}:
        raise SystemExit("Priority Low and the published acceptance layer disagree")

    snapshot = {
        "generatedAt": datetime.now().isoformat(timespec="seconds"),
        "source": SOURCE_URL,
        "sheetScannedAt": payload.get("summary", {}).get("generated_at"),
        "rule": "A task is client accepted when the audit sheet marks it priority Low.",
        "tasks": len(rows),
        "accepted": len(accepted),
        "priorities": dict(priorities.most_common()),
        "qcResults": dict(Counter(row.get("qc_result") or "Not set" for row in rows).most_common()),
    }
    OUT.write_text(json.dumps(snapshot, indent=1), encoding="utf-8")
    print(json.dumps({k: v for k, v in snapshot.items() if k != "rule"}, indent=1))
    print(f"wrote {OUT}")


if __name__ == "__main__":
    build()
