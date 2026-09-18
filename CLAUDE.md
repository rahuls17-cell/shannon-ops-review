# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Shannon Ops Review — a static, build-free dashboard (vanilla HTML/CSS/JS, no bundler,
no `package.json`) for VPs, CXOs and delivery managers. Published to
https://rahuls17-cell.github.io/shannon-ops-review/ via GitHub Pages from the repo root.

`README.md` is **stale**: it describes a separate Finalisation view, a global people
filter bar and an embedded-feed loader, all of which have been removed. Trust the code
and this file over it.

## Commands

```bash
# Serve locally. Use truth_server.py, not http.server: it serves the same files
# AND exposes the rebuild endpoint the Pipeline tab's button calls. A plain
# static server answers that POST with 501 and the button cannot work.
python tools/truth_server.py --port 8787

# Rebuild the derived pipeline by hand (the button does this over SSH)
ssh <harbor-vm> 'cd <pipeline-dashboard> && ./refresh_truth.sh'

# Tests - plain node, no runner, no deps
node tools/test-pipeline-view.cjs          # merged pipeline: spine, ledger, evidence, legacy, dual-basis counts
node tools/test-payout-ledger.cjs
node tools/test-finalisation-filters.cjs
node tools/test-explorer.cjs               # bucket explorer: JS/Python shard agreement, sha1, path resolution
node tools/test-truth.cjs                  # derived pipeline: partition, filters, chains, unreconciled refusal
node tools/test-views.cjs                  # nav / .view sections / VIEWS whitelist must agree
python tools/test_duplicate_sample.py      # duplicate-collapse checks + seeded 100-task sample
python tools/test_duplicate_sample.py --live-only --seed 123 --sample 50

# Browser checks (Playwright + Microsoft Edge; PLAYWRIGHT_MODULE / DASHBOARD_URL override)
node tools/check-command-browser.cjs
node tools/check-finalisation-browser.cjs

# Rebuild assets from sources
python tools/build_data.py                 # workbook -> assets/data.js (ALL other builders assume this ran)
python tools/build_payout_ledger.py        # workbook -> assets/payout-ledger.json
python tools/build_client_acceptance.py    # 240 dashboard -> assets/client-acceptance.json (counts only)
python tools/build_harbor_console.py       # `harbor dump` tab / console pull -> assets/harbor-console.json
python tools/export_duplicate_tables.py    # duplicate CSVs -> assets/ and ~/Downloads
```

A single test is just its own file — each script is self-contained and exits non-zero
on failure. `tools/build_data.py` reads an absolute path into `C:\Users\SHRUTI\Downloads\`;
workbooks are gitignored, so builders fail cleanly when the file is absent.

Two known-red checks, neither a regression you introduced:

- `tools/test-command.cjs` **is broken** — it requires `accepted-tasks.js`, deleted when
  Finalisation merged into Pipeline. Port it onto `pipeline-view.js` or delete it.
- `tools/test_duplicate_sample.py` exits 1 on one group, `a-fortnight-nobody-was-watching`,
  where the console itself emits two rows with identical timestamp, `family_id` *and*
  `run_id` but conflicting states. That is a Harbor data defect; nothing here can resolve it.

**Browser caching bites constantly.** Edits to `app.js` and the other modules are served
stale on a port you have already loaded. Start a *new* port rather than hard-reloading.

## The derived pipeline (GCS as the source of truth)

Pipeline, Carried over and their figures come from `assets/pipeline-truth.json`,
built by an eight-step chain on the Harbor VM. **The Harbor Console is not read.**

```
ingest_verdicts -> index_delivery -> assign_identity -> select_canonical
   -> derive_state -> build_tags -> build_provenance -> reconcile
```

Each step is a separate process writing a JSON file, so any one can be re-run
alone while chasing a number. `refresh_truth.sh` runs the lot in ~35s.

`reconcile.py` is a **gate, not a report**: non-zero exit leaves the previously
published asset in place. A figure that cannot explain itself is never shipped.

Every published figure carries a computed derivation chain, and every row cites
the verdict object it came from. `GLOSSARY.md` holds the predicates; nothing may
redefine a term locally.

Two counts are deliberately flagged rather than fixed: identities with no
`family_id` are `unmerged`, and unmerged identities sharing a task name are
`possible duplicate`. Both are shown, neither is silently merged - a task name
in this bucket can cover 36 unrelated tasks.

## Architecture

### Three feeds, three trust levels

| Feed | Asset | Authority |
|---|---|---|
| GCS verdicts + delivery | `assets/pipeline-truth.json` | **Source of truth for the pipeline**: state, identity, tags |
| GCS bucket scan | `assets/gcs-pipeline.json` (~36 MB) | Overview's finalisation counts; connector status |
| Workbook | `assets/data.js`, `payout-ledger.json` | Source of truth for **payouts only** |
| Harbor Console | `assets/harbor-console-*.json` | **Retired from Pipeline.** Kept only to supply owner attribution to Overview's finalisation join |

The console was the spine until 2026-09-17. It is not any more: the console itself
answers from a GCS assembler, so reading the bucket directly removes a proxy that
needed a human signed into IAP. `pipeline-view.js` still exists for the Overview
join; the Pipeline view uses `truth.js`.

Nothing is derived twice. If a number can come from two feeds, the code picks one and
the page says which.

### Module pattern

Every module is an IIFE assigning to `window` and, when present, `module.exports`:

```js
(function (root) { /* … */
  root.preparePipeline = preparePipeline;
  if (typeof module !== 'undefined') module.exports = {preparePipeline, filterPipeline};
})(typeof window === 'undefined' ? globalThis : window);
```

This is what lets `.cjs` tests require the same file the browser loads. Keep it.
Load order in `index.html` matters: `data.js` → `sources.js` → `finalisation.js` →
`pipeline-view.js` → `truth.js` → `payout-ledger.js` → `explorer.js` → `app.js`.

Each module splits into a pure `prepareX(source, …)` (shape the data) and `filterX(rows, filters)`
(select and tally). `app.js` holds all DOM rendering and never recomputes what a
`prepare`/`filter` pair already returned.

### Views

Six: **Overview** (`command`), **Payouts**, **Delivery**, **Pipeline**, **Carried over**
(`carried`), **Bucket** (`explorer`). Finalisation is no longer a tab — delivery is the
`Delivered` evidence line on each Pipeline row.

A view exists in **three** places that must agree: the nav button, the `.view` section,
and the `VIEWS` whitelist in `app.js`. Miss the whitelist and the tab renders its data
but `switchView` refuses to open it — silently. `tools/test-views.cjs` asserts all three
agree and that every script `index.html` loads exists on disk.

`sources.js` is the provenance registry (PRD C2/X2): every figure traces to one of nine
sources, each with what/why/how and the views it feeds. A source with no URL carries an
`hrefNote` explaining why rather than an invented link. When you add a data source, add
it here or the source panel will under-report.

### Shared date range (PRD X1)

`dateRange` in `app.js` with `inRange()` / `rangeLabel()` / `applyRange()`. Drives
Overview, Delivery and Pipeline. **Payouts is deliberately exempt** — the workbook
records what was *paid*, not when work happened, so filtering it would silently drop
people paid for older work. `renderEverything()` must include any renderer that reads
the range, or it will not redraw.

## Constraints that are not visible in the code

- **The Harbor Console is behind Google IAP.** No API key exists. A service-account
  identity token is rejected (`JWT 'email' claim isn't a string`). Only the user's
  signed-in browser session can read it. Never enter their credentials — they sign in,
  you read from the authenticated tab.
- **The console is read GET-only.** `/api/trainer/tasks` with `page_size=50` (the cap;
  larger returns 0) and `defer_details=false` (`true` blanks `pipeline_state` and
  `submitted_by`). Never click Retry, Sync or any batch mutation.
- **The pull must be resumable.** 135 pages at ~3s each exceeds any single execution
  budget; drive it in chunks carrying the page token. `tools/console-pull.js` is the
  documented one-shot version and *will* time out — it needs folding back onto the
  resumable form.
- **`submitted_at` carries a full timestamp.** Slicing it to a date (`.slice(0, 10)`)
  makes same-day resubmissions unorderable and manufactured 99 arbitrary statuses.
  Keep the time.
- **`gs://obi-harbor-pipeline/` is read-only, and it gets pruned.** 359 task folders
  disappeared in one 30-minute window on 2026-09-16 while the console kept every
  record. Folder counts under-report delivery; never read "no folder" as "not delivered".
- **Task identity is unresolved.** Name collides (784 names span multiple families;
  one literally called `task` covers 32). `family_id` over-merges (57 batch containers
  such as `repaired-tasks-20260903` fuse unrelated work). The current key is the
  normalised name; a name+family pair is the untested candidate. Do not claim a task
  count is correct without saying which key produced it.
- **`dev@localhost`, `harbor-operator-e2e` and `unknown — no sidecar`** appear in
  `submitted_by`. They are not trainers; exclude them from attribution and payout work.
- **Never commit GCS credentials or service-account keys.** The refresh workflow SSHes
  to the Harbor VM whose key is restricted to `tools/vm-export.sh`; credentials stay there.

## Refresh paths

`.github/workflows/refresh-gcs.yml` runs every 30 minutes, reads GCS via the VM,
validates `schemaVersion == 3` plus non-empty `current`/`historical`/`legacy`, commits
the snapshot and deploys Pages. The page polls `assets/pipeline-version.json` every
minute and reloads when it changes. `Refresh from GCS` posts to a localhost endpoint
when on 127.0.0.1, otherwise opens that workflow. `Refresh from Console` only re-reads
the pulled JSON — it cannot reach the console (IAP).

A VM cron (`7,37 * * * *`) separately publishes the older
`rahuls17-cell/harbor-pipeline-dashboard`, which counts *bucket folders* and therefore
swings by hundreds when a sweep runs. It is not this dashboard.

## Publishing

Payload is already ~39 MB plus ~8 MB of console assets (PRD B1, unresolved and getting
worse). Check size before adding another asset. The public Pages site is pseudonymised —
the duplicate CSVs and console pulls carry real trainer emails and must not be published there.

The governing spec is the PRD in `ACTION_ITEMS (1).docx` (item IDs X1–X3, C1–C6, F1–F4,
D1–D3, T1–T4, H1–H4, B1–B3). Its status glossary is frozen: `done`→Accepted,
`rejected`→Rejected, `parked`/`error`→Failed, `running`→Running, pre-5-Sept→Legacy.
`Done` maps to **Submitted**, never Accepted.
