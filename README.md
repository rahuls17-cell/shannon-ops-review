# Shannon Ops Review Dashboard

Local executive dashboard draft built from `Shannon - Ops Review (P0).xlsx`.

## What is included

- Executive overview for VP, CXO, and delivery-manager review.
- Person-level payout table showing accepted tasks, paid tasks, paid amount, pending tasks, and pending amount.
- Team and manager summary.
- Current and historical task pipeline view.
- Daily plan versus actual view.
- Pipeline date range and status filters.
- Harbor finalisation accepted iteration-2 inventory with trainer and bench filters.

## Finalisation feed

The Finalisation view loads the embedded `pipeline-data` JSON from
https://rahuls17-cell.github.io/harbor-pipeline-dashboard/ on page load or Refresh data.
It parses data only; source-page scripts are never executed. If unavailable, it uses
`assets/finalisation.json` and labels it as a saved snapshot with its scan timestamp.

Counts match Harbor task folders, not unique task names. Distinct names are shown
separately because folders can represent different versions. Owner labels match
normalized roster names or email usernames only when exactly one record matches.
Contested owners are not allocated; name-match-only evidence stays flagged.
Bench derives from the linked trainer team. Unresolved records remain visible in
the unfiltered inventory. This view does not modify workbook accepted counts,
paid amounts, pending amounts, or the Command view's workbook metrics.

## Payment logic

The workbook implies `$300` per approved task in the `paid out` tab. The dashboard uses:

```text
pending tasks = max(v2 total accepted - paid out tasks, 0)
pending amount = pending tasks * 300
```

## Run locally

From this folder:

```powershell
python -m http.server 8787 --bind 127.0.0.1
```

Then open:

```text
http://127.0.0.1:8787/
```

## Refresh data

If the workbook changes, regenerate the embedded data:

```powershell
python tools/build_data.py
```

## GitHub Pages path

This draft is static HTML, CSS, and JavaScript. For GitHub Pages, commit this folder as the repository root or move these files to `/docs`, then enable Pages from the selected branch and folder.

## Visual system

The current interface follows the Harbor 240 dashboard language: pale blue-gray canvas, deep teal active navigation and controls, compact white panels with 8px corners, light shadows, Inter/system typography, and dense analytical layouts designed for leadership review.

## Published pipeline refresh

Command uses current GCS evaluations and the Finalisation inventory. Its accepted
headline counts reconciled task groups once, including unassigned groups when no
person filter is selected. Separate cards show pipeline acceptance, Finalisation
folders and duplicate records. Pending estimates and the owner ranking use the
same roster-linked reconciliation and Paid Out records as Payouts. Both accepted
sources must be available before these estimates are shown. The current-state
chart and bench breakdown follow the global people filters, independently of
the Pipeline tab's history, date and status controls. Active headcount and paid
records remain workbook snapshots, labelled accordingly.

Run `node tools/test-command.cjs` for focused calculation checks. Browser checks
are in `tools/check-command-browser.cjs` (Playwright with Microsoft Edge;
`PLAYWRIGHT_MODULE` and `DASHBOARD_URL` can override local defaults).

The Refresh GCS pipeline GitHub workflow reads GCS through the existing Harbor VM,
commits a validated snapshot, and deploys Pages. It runs every 30 minutes and supports
Run workflow for an immediate refresh. The dashboard's Refresh from GCS button opens
that authenticated GitHub control. An open dashboard checks the published version
every minute and loads new data automatically.

The SSH key stored in repository secrets is restricted on the VM to
`tools/vm-export.sh`. It cannot run arbitrary commands or forward ports. GCS
credentials remain on the VM, and the exporter performs only reads.

`tools/refresh_server.py` provides the local endpoint when run in the VM environment.
The exporter depends on the Harbor scanner installed there.
