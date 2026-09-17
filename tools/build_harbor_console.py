"""Build the Harbor Console attribution and status asset (PRD C5 / F2).

The console itself sits behind Google IAP and cannot be read from here. The
`harbor dump` tab of the Shannon PPT workbook is an export of it, so this reads
that tab and publishes two things:

  * owners  - task name -> trainer, the console's own record of who submitted.
              Stronger than the GCS trainer-record name match, which is
              evidence rather than proof.
  * tasks   - the console verdict per task: run_state, decision, stage, error.

Only unambiguous owners are published; where the export disagrees with itself
the task stays contested rather than being assigned to whoever came first.

    python tools/build_harbor_console.py
"""
import json
import re
from collections import Counter, defaultdict
from datetime import datetime
from pathlib import Path

import openpyxl

WORKBOOK = Path(r"C:\Users\SHRUTI\Downloads\Shannon PPT - Sep 9.xlsx")
SHEET = "harbor dump"
OUT = Path(__file__).resolve().parent.parent / "assets" / "harbor-console.json"
CONSOLE_URL = "https://harbor-console-713053229214.us-central1.run.app/trainer-tasks"
# The console's own vocabulary, which the PRD glossary is taken from.
RUN_STATES = {"done": "Accepted", "rejected": "Rejected", "parked": "Failed", "running": "Running"}
NAME_FIELDS = ("declared_name", "task_id", "family_id", "submission_batch_id")


def name_key(value):
    return re.sub(r"^(harbor|obi)/", "", str(value or "").strip().lower())


def build():
    sheet = openpyxl.load_workbook(WORKBOOK, data_only=True, read_only=True)[SHEET]
    rows = list(sheet.iter_rows(values_only=True))
    header = [str(cell) if cell is not None else "" for cell in rows[0]]
    index = {name: position for position, name in enumerate(header) if name}
    for required in ("trainer", "declared_name", "finalisation.run_state", "submitted_at"):
        if required not in index:
            raise SystemExit(f"The {SHEET} tab has no {required} column - is this still a console export?")

    def field(row, name):
        position = index.get(name)
        return row[position] if position is not None and position < len(row) else None

    owners, tasks, dates = defaultdict(set), {}, []
    for row in rows[1:]:
        trainer = str(field(row, "trainer") or "").strip().lower()
        submitted = str(field(row, "submitted_at") or "")[:10]
        if submitted.startswith("20"):
            dates.append(submitted)
        keys = {name_key(field(row, name)) for name in NAME_FIELDS}
        keys.discard("")
        if trainer and "@" in trainer:
            for key in keys:
                owners[key].add(trainer)
        declared = name_key(field(row, "declared_name"))
        if not declared:
            continue
        run_state = str(field(row, "finalisation.run_state") or "").strip().lower()
        previous = tasks.get(declared)
        # Latest submission wins; the console row is a submission, not a task.
        if previous and previous["submittedAt"] >= (str(field(row, "submitted_at") or "")):
            continue
        tasks[declared] = {
            "task": declared,
            "trainer": trainer if "@" in trainer else None,
            "submittedAt": str(field(row, "submitted_at") or ""),
            "runState": run_state or None,
            "status": RUN_STATES.get(run_state, run_state.title() if run_state else None),
            "decision": str(field(row, "decision") or "") or None,
            "workflowStatus": str(field(row, "workflow_status") or "") or None,
            "failedStage": str(field(row, "pipeline_failed_stage") or "") or None,
            "taskType": str(field(row, "task_type") or "") or None,
        }

    resolved = {key: sorted(value)[0] for key, value in owners.items() if len(value) == 1}
    contested = sorted(key for key, value in owners.items() if len(value) > 1)
    payload = {
        "generatedAt": datetime.now().isoformat(timespec="seconds"),
        "source": CONSOLE_URL,
        "sourceFile": f"{WORKBOOK.name} / {SHEET}",
        # The export is a point-in-time dump; say how stale it is rather than
        # letting the page imply it is live.
        "coverage": {"rows": len(rows) - 1, "from": min(dates) if dates else None,
                     "to": max(dates) if dates else None,
                     "sinceSept5": sum(1 for date in dates if date >= "2026-09-05")},
        "owners": resolved,
        "contested": contested,
        "statuses": dict(Counter(task["status"] for task in tasks.values() if task["status"]).most_common()),
        "tasks": sorted(tasks.values(), key=lambda task: task["task"]),
    }
    OUT.write_text(json.dumps(payload, separators=(",", ":")), encoding="utf-8")
    print(json.dumps({"rows": payload["coverage"]["rows"], "coverage": payload["coverage"],
                      "ownersResolved": len(resolved), "ownersContested": len(contested),
                      "tasks": len(payload["tasks"]), "statuses": payload["statuses"]}, indent=1))
    print(f"wrote {OUT} ({OUT.stat().st_size // 1024} KB)")


if __name__ == "__main__":
    build()
