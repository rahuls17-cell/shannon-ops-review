import json
from datetime import date, datetime
from pathlib import Path

import pandas as pd


SOURCE_WORKBOOK = Path(r"C:\Users\SHRUTI\Downloads\Shannon - Ops Review (P0).xlsx")
OUT_FILE = Path(__file__).resolve().parents[1] / "assets" / "data.js"
PAY_PER_TASK = 300


def clean_value(value):
    if pd.isna(value):
        return None
    if isinstance(value, (datetime, date, pd.Timestamp)):
        return value.isoformat()
    if hasattr(value, "item"):
        try:
            return value.item()
        except Exception:
            pass
    return value


def clean_text(value):
    value = clean_value(value)
    if value is None:
        return ""
    return str(value).strip()


def clean_num(value):
    value = clean_value(value)
    if value in (None, ""):
        return 0
    try:
        return float(value)
    except (TypeError, ValueError):
        return 0


def read_table(sheet_name, header=0):
    return pd.read_excel(SOURCE_WORKBOOK, sheet_name=sheet_name, header=header)


def read_raw(sheet_name):
    return pd.read_excel(SOURCE_WORKBOOK, sheet_name=sheet_name, header=None)


def records_from_df(df, limit=None):
    df = df.dropna(how="all")
    records = []
    for _, row in df.iterrows():
        item = {}
        for col, value in row.items():
            key = clean_text(col) or f"Column {len(item) + 1}"
            item[key] = clean_value(value)
        records.append(item)
        if limit and len(records) >= limit:
            break
    return records


def build_paid_lookup():
    df = read_table("paid out")
    rows = []
    lookup = {}
    for _, row in df.iterrows():
        email = clean_text(row.get("Turing Email")).lower()
        if not email:
            continue
        tasks = clean_num(row.get("Total Tasks Approved"))
        amount = clean_num(row.get("Total Payment Amount"))
        item = {
            "name": clean_text(row.get("Full Name")),
            "email": email,
            "approvedTasks": tasks,
            "paidAmount": amount,
        }
        rows.append(item)
        lookup[email] = item
    return rows, lookup


def build_trainers(paid_lookup):
    raw = pd.read_excel(SOURCE_WORKBOOK, sheet_name="Trainers", header=None)
    data = raw.iloc[5:].copy()
    rows = []
    for _, row in data.iterrows():
        email = clean_text(row.iloc[0]).lower()
        name = clean_text(row.iloc[1])
        if not email or email == "team member email":
            continue
        accepted = clean_num(row.iloc[25])
        paid_tasks = clean_num(row.iloc[10])
        paid_entry = paid_lookup.get(email)
        if paid_entry:
            paid_tasks = max(paid_tasks, paid_entry["approvedTasks"])
        paid_amount = paid_tasks * PAY_PER_TASK
        pending_tasks = max(accepted - paid_tasks, 0)
        item = {
            "email": email,
            "name": name,
            "team": clean_text(row.iloc[2]),
            "managerEmail": clean_text(row.iloc[3]).lower(),
            "managerName": clean_text(row.iloc[4]),
            "em": clean_text(row.iloc[5]),
            "status": clean_text(row.iloc[6]) or "Unknown",
            "notes": clean_text(row.iloc[7]),
            "glmSpend": clean_num(row.iloc[8]),
            "inferencePerAccepted": clean_num(row.iloc[9]),
            "paidTasks": paid_tasks,
            "paidAmount": paid_amount,
            "pendingTasks": pending_tasks,
            "pendingAmount": pending_tasks * PAY_PER_TASK,
            "acceptedTasks": accepted,
            "sepConnectorAccepted": clean_num(row.iloc[11]),
            "sepConnectorRejected": clean_num(row.iloc[12]),
            "sepNonConnectorAccepted": clean_num(row.iloc[13]),
            "sepNonConnectorRejected": clean_num(row.iloc[14]),
            "projectConnectorAccepted": clean_num(row.iloc[16]),
            "projectConnectorRejected": clean_num(row.iloc[17]),
            "projectNonConnectorAccepted": clean_num(row.iloc[18]),
            "projectNonConnectorRejected": clean_num(row.iloc[19]),
            "last24ConnectorAccepted": clean_num(row.iloc[21]),
            "last24ConnectorRejected": clean_num(row.iloc[22]),
            "last24NonConnectorAccepted": clean_num(row.iloc[23]),
            "last24NonConnectorRejected": clean_num(row.iloc[24]),
            "last24Accepted": clean_num(row.iloc[26]),
        }
        rows.append(item)
    return rows


def build_rollup():
    raw = read_raw("roll up view")
    sections = []
    for name, label_col, value_col in [
        ("Computer bench", 1, 3),
        ("Company bench", 13, 15),
    ]:
        metrics = []
        for _, row in raw.iterrows():
            label = clean_text(row.iloc[label_col]) if label_col < len(row) else ""
            value = clean_num(row.iloc[value_col]) if value_col < len(row) else 0
            if label and value:
                metrics.append({"label": label, "value": value})
        sections.append({"name": name, "metrics": metrics})
    return sections


def build_plan():
    raw = read_raw("New Task Mining Daily Plan")
    dates = [clean_text(v)[:10] for v in raw.iloc[1, 2:].tolist()]
    series = []
    for base_row, bench in [(2, "Company Bench"), (5, "Computer Bench")]:
        plan = [clean_num(v) for v in raw.iloc[base_row, 2:].tolist()]
        actual = [clean_num(v) for v in raw.iloc[base_row + 1, 2:].tolist()]
        series.append({"bench": bench, "dates": dates, "plan": plan, "actual": actual})
    return series


def build_people_sheet(sheet_name):
    return records_from_df(read_table(sheet_name), limit=1000)


def build_pipeline():
    dump_raw = read_raw("dump")
    header_row = 3
    dump = pd.read_excel(SOURCE_WORKBOOK, sheet_name="dump", header=header_row)
    dump = dump.dropna(how="all")
    tasks = []
    for _, row in dump.iterrows():
        trainer = clean_text(row.get("trainer")).lower()
        task = clean_text(row.get("task"))
        if not task:
            continue
        tasks.append(
            {
                "date": clean_text(row.get("clean_date"))[:10],
                "task": task,
                "trainer": trainer,
                "submittedAt": clean_text(row.get("submitted_at")),
                "taskType": clean_text(row.get("task_type")),
                "status": clean_text(row.get("pipeline_state")).title(),
            }
        )

    sheet9 = pd.read_excel(SOURCE_WORKBOOK, sheet_name="Sheet9", header=0)
    historical = []
    for _, row in sheet9.iloc[:, 0:6].dropna(how="all").iterrows():
        task = clean_text(row.get("Task name"))
        if not task:
            continue
        historical.append(
            {
                "date": clean_text(row.get("clean_date"))[:10],
                "task": task,
                "trainer": clean_text(row.get("Trainer email")).lower(),
                "submittedAt": clean_text(row.get("Submitted date")),
                "taskType": clean_text(row.get("Task type")),
                "status": clean_text(row.get("Pipeline status")).title(),
            }
        )
    return {"current": tasks, "historical": historical}


def summarize(trainers, pipeline):
    active_trainers = [t for t in trainers if t["status"].lower() == "active"]
    accepted = sum(t["acceptedTasks"] for t in trainers)
    paid_amount = sum(t["paidAmount"] for t in trainers)
    pending_amount = sum(t["pendingAmount"] for t in trainers)
    pending_tasks = sum(t["pendingTasks"] for t in trainers)
    status_counts = {}
    for task in pipeline["current"] + pipeline["historical"]:
        status = task["status"] or "Unknown"
        status_counts[status] = status_counts.get(status, 0) + 1
    team_counts = {}
    for trainer in trainers:
        team = trainer["team"] or "Unassigned"
        team_counts[team] = team_counts.get(team, 0) + 1
    return {
        "activeTrainers": len(active_trainers),
        "totalTrainers": len(trainers),
        "acceptedTasks": accepted,
        "paidAmount": paid_amount,
        "pendingTasks": pending_tasks,
        "pendingAmount": pending_amount,
        "payPerTask": PAY_PER_TASK,
        "pipelineStatusCounts": status_counts,
        "teamCounts": team_counts,
    }


def main():
    xl = pd.ExcelFile(SOURCE_WORKBOOK)
    paid_out, paid_lookup = build_paid_lookup()
    trainers = build_trainers(paid_lookup)
    pipeline = build_pipeline()
    glm = records_from_df(read_table("GLM Inference (daily refresh)"), limit=1000)
    payload = {
        "meta": {
            "sourceWorkbook": str(SOURCE_WORKBOOK),
            "generatedAt": datetime.now().isoformat(timespec="seconds"),
            "tabs": xl.sheet_names,
            "paymentModel": "Pending payment is calculated as max(v2 total accepted - paid out, 0) * $300/task.",
        },
        "summary": summarize(trainers, pipeline),
        "paidOut": paid_out,
        "trainers": trainers,
        "rollup": build_rollup(),
        "plan": build_plan(),
        "leaders": build_people_sheet("Leaders"),
        "generalEngineering": build_people_sheet("General Engg"),
        "roster": build_people_sheet("roster"),
        "offboardingTransfers": build_people_sheet("to be offboardedtransferred"),
        "glmInference": glm,
        "pipeline": pipeline,
        "sourceTabs": [
            {
                "name": sheet,
                "rows": int(pd.read_excel(SOURCE_WORKBOOK, sheet_name=sheet, header=None).shape[0]),
                "columns": int(pd.read_excel(SOURCE_WORKBOOK, sheet_name=sheet, header=None).shape[1]),
            }
            for sheet in xl.sheet_names
        ],
    }
    OUT_FILE.parent.mkdir(parents=True, exist_ok=True)
    OUT_FILE.write_text(
        "window.OPS_REVIEW_DATA = "
        + json.dumps(payload, ensure_ascii=False, allow_nan=False)
        + ";\n",
        encoding="utf-8",
    )
    print(f"Wrote {OUT_FILE}")


if __name__ == "__main__":
    main()
