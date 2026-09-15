"""Build the task-level payout ledger.

Payout truth is the workbook alone - the Harbor 240 dashboard is deliberately
not consulted here:
  * accepted tasks - the "task wise" tab of the Shannon PPT workbook, deduplicated
  * paid tasks     - the Paid Out tab and the Live Import payment tracker

The Paid Out tab carries counts, not task identities, so paid and pending stay
person-level; the ledger enumerates the tasks themselves.
"""
import json
from datetime import datetime
from pathlib import Path

import openpyxl

PPT_WORKBOOK = Path(r"C:\Users\SHRUTI\Downloads\Shannon PPT - Sep 9.xlsx")
OPS_WORKBOOK = Path(r"C:\Users\SHRUTI\Downloads\Shannon - Ops Review (P0).xlsx")
OUT =Path(__file__).resolve().parent.parent / "assets" / "payout-ledger.json"
PAY_PER_TASK = 300


def text(value):
    if value is None:
        return None
    # CJ ids and similar identifiers arrive as floats; they are labels, not quantities.
    if isinstance(value, float) and value.is_integer():
        value = int(value)
    value = str(value).strip()
    return value or None


def load_task_wise():
    sheet = openpyxl.load_workbook(PPT_WORKBOOK, data_only=True)["task wise"]
    header = [text(sheet.cell(2, col).value) for col in range(1, 5)]
    if header != ["Task name", "Email", "Task Type", "Valid"]:
        raise SystemExit(f"Unexpected task wise header: {header}")
    records = []
    for index in range(3, sheet.max_row + 1):
        values = [sheet.cell(index, col).value for col in range(1, 10)]
        if all(value is None for value in values):
            continue
        task, email = text(values[0]), text(values[1])
        if not task or not email:
            raise SystemExit(f"task wise row {index} is missing a task or an email")
        records.append({
            "row": index,
            "task": task,
            "email": email.lower(),
            "type": text(values[2]),
            "valid": values[3] == 1,
            "harborLink": text(values[4]),
            "cj": text(values[5]),
            "secondaryOwner": text(values[7]),
            "note": text(values[8]),
        })
    return records


def load_paid_out():
    sheet = openpyxl.load_workbook(OPS_WORKBOOK, data_only=True)["paid out"]
    if text(sheet.cell(1, 3).value) != "Total Tasks Approved":
        raise SystemExit("Unexpected paid out header")
    people = []
    for index in range(2, sheet.max_row + 1):
        email = text(sheet.cell(index, 2).value)
        if not email:
            continue
        tasks = int(sheet.cell(index, 3).value or 0)
        amount = float(sheet.cell(index, 4).value or 0)
        if amount != tasks * PAY_PER_TASK:
            raise SystemExit(f"Paid Out row {index} does not price at {PAY_PER_TASK} per task")
        people.append({"name": text(sheet.cell(index, 1).value), "email": email.lower(),
                       "paidTasks": tasks, "paidAmount": amount})
    return people


def load_payment_requests():
    """The Live Import tab is the actual payment tracker: one row per payment request."""
    sheet = openpyxl.load_workbook(PPT_WORKBOOK, data_only=True)["Live Import (Turing PPT tracker"]
    header = [text(sheet.cell(1, col).value) for col in (7, 15, 16, 19)]
    if header != ["Child Job", "# of tasks approved", "Payment amount", "Turing Email"]:
        raise SystemExit(f"Unexpected payment tracker header: {header}")
    requests = []
    for index in range(2, sheet.max_row + 1):
        email = text(sheet.cell(index, 19).value)
        if not email:
            continue
        tasks = int(sheet.cell(index, 15).value or 0)
        amount = float(sheet.cell(index, 16).value or 0)
        if amount != tasks * PAY_PER_TASK:
            raise SystemExit(f"Payment tracker row {index} does not price at {PAY_PER_TASK} per task")
        requests.append({"row": index, "email": email.lower(), "name": text(sheet.cell(index, 18).value),
                         "cj": text(sheet.cell(index, 7).value), "requestedOn": str(sheet.cell(index, 1).value)[:10],
                         "paidTasks": tasks, "paidAmount": amount})
    return requests


def load_cj_owners():
    """The CJs tab maps a person to their child job and payment model."""
    sheet = openpyxl.load_workbook(PPT_WORKBOOK, data_only=True)["CJs"]
    owners = {}
    for index in range(2, sheet.max_row + 1):
        email = text(sheet.cell(index, 1).value)
        if email:
            owners[email.lower()] = {"cj": text(sheet.cell(index, 2).value),
                                     "paymentModel": text(sheet.cell(index, 3).value)}
    return owners


def collapse(records):
    """One accepted task per task name per trainer. A task listed twice was still
    only done once, so the repeat rows are kept for audit and never counted."""
    tasks = {}
    for record in records:
        key = (record["task"].lower(), record["email"])
        entry = tasks.get(key)
        if entry is None:
            entry = {**{k: v for k, v in record.items() if k != "row"},
                     "rows": [], "duplicateRows": 0,
                     # Every unique task counts; the workbook Valid column is kept for
                     # audit and filtering but does not decide what is payable.
                     "accepted": True}
            tasks[key] = entry
        else:
            entry["duplicateRows"] += 1
            # A duplicate row only ever fills gaps; it never overwrites the kept row.
            for field in ("type", "cj", "harborLink", "secondaryOwner", "note"):
                entry[field] = entry[field] or record[field]
        entry["rows"].append(record["row"])
    return sorted(tasks.values(), key=lambda row: (row["email"], row["task"]))


def resolve_requests(requests, cj_owners):
    """The tracker records one email as monty.d@ where every other tab says monty.d2@,
    so the child job - which is issued per person - decides who a request paid."""
    by_cj = {info["cj"]: email for email, info in cj_owners.items() if info["cj"]}
    resolved = []
    for request in requests:
        owner = by_cj.get(request["cj"])
        resolved.append({**request, "email": owner or request["email"],
                         "trackerEmail": request["email"],
                         "emailMismatch": bool(owner) and owner != request["email"]})
    return resolved


def build():
    records = load_task_wise()
    paid_out = load_paid_out()
    cj_owners = load_cj_owners()
    requests = resolve_requests(load_payment_requests(), cj_owners)
    ledger = collapse(records)

    accepted_by_email, listed_by_email = {}, {}
    for row in ledger:
        listed_by_email[row["email"]] = listed_by_email.get(row["email"], 0) + 1
        if row["accepted"]:
            accepted_by_email[row["email"]] = accepted_by_email.get(row["email"], 0) + 1
    paid_by_email = {person["email"]: person for person in paid_out}
    tracked_by_email = {}
    for request in requests:
        tracked_by_email[request["email"]] = tracked_by_email.get(request["email"], 0) + request["paidTasks"]

    people = []
    for email in sorted(set(paid_by_email) | set(accepted_by_email) | set(listed_by_email)):
        paid_row = paid_by_email.get(email)
        paid = int(paid_row["paidTasks"]) if paid_row else 0
        listed = listed_by_email.get(email, 0)
        accepted = accepted_by_email.get(email, 0)
        pending = max(accepted - paid, 0)
        people.append({
            "name": paid_row["name"] if paid_row else None,
            "email": email,
            "cj": cj_owners.get(email, {}).get("cj"),
            "paymentModel": cj_owners.get(email, {}).get("paymentModel"),
            "listedTasks": listed,
            "acceptedTasks": accepted,
            "paidTasks": paid,
            "paidAmount": paid * PAY_PER_TASK,
            # Paid tasks beyond the tasks actually listed for this person cannot name a task.
            "itemisedPaidTasks": min(paid, listed),
            "unitemisedPaidTasks": max(paid - listed, 0),
            "paymentRequests": sum(1 for request in requests if request["email"] == email),
            "trackerTasks": tracked_by_email.get(email, 0),
            "trackerMismatch": tracked_by_email.get(email, 0) != paid,
            "pendingTasks": pending,
            "pendingAmount": pending * PAY_PER_TASK,
        })

    # A person paid for every task listed against them has each of those tasks paid;
    # a partly paid person's workbook rows do not say which of their tasks the payment covered.
    state = {}
    for person in people:
        state[person["email"]] = ("Paid" if person["paidTasks"] >= person["listedTasks"] and person["paidTasks"]
                                  else "Not itemised" if person["paidTasks"] else "Not paid")
    for row in ledger:
        row["paymentState"] = state.get(row["email"], "Not paid")

    totals = {
        "sourceRows": len(records),
        "ledgerTasks": len(ledger),
        "duplicateRows": sum(row["duplicateRows"] for row in ledger),
        "acceptedTasks": sum(accepted_by_email.values()),
        "paidTasks": sum(person["paidTasks"] for person in people),
        "paidAmount": sum(person["paidAmount"] for person in people),
        "paymentRequests": len(requests),
        "itemisedPaidTasks": sum(person["itemisedPaidTasks"] for person in people),
        "unitemisedPaidTasks": sum(person["unitemisedPaidTasks"] for person in people),
        "unitemisedPaidAmount": sum(person["unitemisedPaidTasks"] for person in people) * PAY_PER_TASK,
        "pendingTasks": sum(person["pendingTasks"] for person in people),
        "pendingAmount": sum(person["pendingAmount"] for person in people),
        "invalidTasks": sum(1 for row in ledger if not row["valid"]),
        "trackerMismatches": sum(1 for person in people if person["trackerMismatch"]),
    }
    if totals["sourceRows"] - totals["duplicateRows"] != totals["ledgerTasks"]:
        raise SystemExit("Duplicate collapse does not reconcile")
    if totals["paidTasks"] != sum(person["paidTasks"] for person in paid_out):
        raise SystemExit("Paid task totals do not reconcile with the paid out tab")

    payload = {
        "generatedAt": datetime.now().isoformat(timespec="seconds"),
        "payPerTask": PAY_PER_TASK,
        "sources": {
            "tasks": f"{PPT_WORKBOOK.name} / task wise",
            "acceptance": f"{PPT_WORKBOOK.name} / task wise, deduplicated",
            "paid": f"{OPS_WORKBOOK.name} / paid out",
            "tracker": f"{PPT_WORKBOOK.name} / Live Import (Turing PPT tracker",
        },
        "totals": totals,
        "people": sorted(people, key=lambda row: (-row["pendingTasks"], -row["paidTasks"], row["email"])),
        "requests": requests,
        "tasks": ledger,
    }
    OUT.write_text(json.dumps(payload, indent=1), encoding="utf-8")
    print(json.dumps(totals, indent=1))
    print(f"wrote {OUT}")


if __name__ == "__main__":
    build()
