# Shannon Ops Review Dashboard

Local executive dashboard draft built from `Shannon - Ops Review (P0).xlsx`.

## What is included

- Executive overview for VP, CXO, and delivery-manager review.
- Person-level payout table showing accepted tasks, paid tasks, paid amount, pending tasks, and pending amount.
- Team and manager summary.
- Current and historical task pipeline view.
- Daily plan versus actual view.
- People ops and workbook-tab traceability sections.

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
