# Shannon Ops Review

Operations dashboard for the Harbor task pipeline.
Static HTML, CSS and vanilla JS. No build step. GitHub Pages serves the repo root.

- **Live:** https://rahuls17-cell.github.io/shannon-ops-review/
- **Staging:** https://rahuls17-cell.github.io/shannon-ops-review-staging/
- **Run locally:** `python3 tools/truth_server.py --port 8787` then open http://127.0.0.1:8787
- **Tests:** `for t in tools/test-*.cjs; do node "$t"; done`

This file explains where every number on the **Overview**, **Pipeline** and **Delivery** pages comes from and how it is counted. Payouts and Carried over are documented in `CHANGELOG.md`.

---

## 1. Where the data comes from

Everything the page shows is read from a JSON asset in `assets/`. A VM rebuilds the assets and commits them to `main` roughly every 10 minutes (`.github/workflows/refresh-truth.yml`, `refresh-gcs.yml`). The page never calls an API.

| Asset | Built by | What it holds |
|---|---|---|
| `pipeline-truth.json` | VM: `ingest_verdicts.py` → `assign_identity.py` → `select_canonical.py` → `derive_state.py` → `build_tags.py` | One row per **task** (not per submission) with its state, decision date, gate, findings, flags, domain, bench image. Cut date `2026-09-05`. |
| `cohort-index.json` | `build_cohort_index.py` | Every folder under the accepted finalisation prefix in the bucket. One folder = one accepted package. |
| `delivered-index.json` | `build_delivered_index.py` | The join of delivered tasks onto pipeline tasks, by name, done once and tested. |
| `connector-index.json` | `build_connector_index.py` / `read_task_toml.py` | Per task: does `task.toml` declare `[[environment.mcp_servers]]`, and which gyms. |
| `bench-index.json` | `scan_bench.py` | Per task: the `FROM` image in its Dockerfile. |
| `delivery-audit.json` | `build_delivery_audit.py` | Batches 1 to 4.1, pulled from the delivery dashboard: trainer, category, GLM trials, client decision. |
| `drive-deliveries.json` | `build_drive_deliveries.py` | Batch 5.1 onward and CompanyBench 1 to 3, one row per package from each batch's `manifest.json` on Drive. |
| `drive-owners.json` | `build_drive_owners.py` | Trainer for Drive rows, recovered from the bucket's owner records. |
| `manifest-index.json`, `task-names.json`, `glm-index.json` | `build_manifest_index.py`, `scan_task_names.py`, `scan_glm_trials.py` | Package → task name, declared names, GLM trial results. |
| `client-acceptance.json` | `build_client_acceptance.py` | Counts only, from the Harbor 240 dashboard. |
| `payout-ledger.json`, `data.js` | `build_payout_ledger.py`, `build_data.py` | Workbook export: paid, pending, roster, plan. |
| `gcs-pipeline.json` | `export_gcs_pipeline.py` | Raw evaluation ledger and finalisation folders. |

Click the `?` on any card to see the predicate chain that produced its number.

---

## 2. Vocabulary used everywhere

**Task state** (set by `derive_state.py`, one row per task):

| State | Rule |
|---|---|
| Accepted | Canonical decision accepted **and** package sits in the current bar (or decided within the grace window). |
| Legacy accepted | Was accepted at some point, but not Accepted now: GLM-5.2 gate only, retired bar, or never delivered. |
| Rejected | Canonical decision rejected. |
| No QC decision | Run reports only a submission state: error, queued, not started. |
| Running | In a stage. |

**Bench and segment** (the top switch: All · Computer Bench: Connector, Non-connector · Company Bench: Aster, Zeta). Decided by the task, never by its trainer. Strongest rule first:

1. **Image** in the task's Dockerfile. Aster or Zeta image → Company Bench. Synthetic (`connectors-rl-gym`) or real-data image → Computer Bench connector. Plain base image → Computer Bench non-connector.
2. **Where it was delivered**: the Drive folder its package sits in (`CompanyBench/`, `Non-Connector/`, …), used only when no image was read.
3. **Name lookup** against delivered and built tasks, only when unambiguous.

**Connector** (`connectorType` in `truth.js`): `task.toml` declares MCP servers → connector. Else the delivered folder type. Else the image, as above. Never inferred from the name. Unknown stays unknown.

**Harness** (Aster vs Zeta): the image first, then what the delivery manifest records, then for Zeta only whether the task mounts `zeta3-sql-gym`.

**Domain**: the prefix on a non-connector task's name. `code-` Engineering, `fin-` Finance, `health-` Health, `law-` Legal, `gen-`/`bus-` Other. Connector tasks have no domain prefix, so the Domain dropdown names them by kind instead: Synthetic, Real Connector or Connector on Computer Bench; harness plus single or multi connector on Company Bench.

The segment switch, the date range and the global filter strip apply to every page. Payouts ignores the date range on purpose: the workbook records when money was paid, not when work happened.

---

## 3. Overview

### Summary pane

| Card | Number | Counted as | Shown as |
|---|---|---|---|
| **The split** (segment tiles) | Pipeline tasks per leaf segment | `pipeline-truth` rows whose segment is that leaf; accepted = Accepted + Legacy accepted; people = roster rows with a task in that segment; paid of ledger = ledger tasks marked Paid. | One tile per segment, verdict bar, click to filter the whole dashboard. |
| **In scope** | Tasks decided | `pipeline-truth` rows (the published in-scope count under All, the segment's rows under a segment). | Headline + 14-day sparkline of tasks decided per day with the daily average and half-over-half change. |
| **Accepted tasks** | Distinct task names | Folders in the three accepted finalisation prefixes (`gcs-pipeline` finalisation rows) in the date range and segment, deduplicated by task name. A current-prefix folder takes the bench of its own Pipeline row; older prefixes go by name. | Ring = accepted ÷ in scope. |
| **Client accepted** | Tasks the client accepted | Under All: `client-acceptance.json`, tasks at priority Low out of the audited 240. Under a segment: `delivery-audit` rows with acceptance Accepted in that segment, because the 240 snapshot has no per-task bench. | Ring = accepted ÷ audited. |
| **Finalisation v2** | Accepted folders in iteration 2 | Finalisation rows whose cohort is `finalisation_client_qc_accepted_iteration_2`, in range and segment. | Bar = v2 ÷ all accepted folders. |
| **Payout balance** | Paid and upcoming money | `payout-ledger` totals under All; per-row sums under a segment. Pending per person = accepted − paid, floored at 0, × $300. | Two-sided balance bar, tag = % settled. |
| **Active trainers** | Roster rows marked Active | `data.js` roster. | Bar = active ÷ roster. |

### Pipeline pane

- **Current evaluations**: `gcs-pipeline` current rows by status, in range and segment.
- **Where the work sits / By bench**: the same evaluations grouped by the task's bench (Computer, Company, Unassigned), with accepted rate per bench and distinct accepted task names per bench.

### Payout balance pane

- **By bench**: each person's paid and pending split between benches by the share of their accepted ledger tasks on each bench.
- **Largest upcoming payments**: people ranked by pending amount.

### Daily delta pane

- One point per task per day it reached its state, from `decided` on `pipeline-truth` rows. A task resubmitted five times moves the line once. Movement, not a running total. Dates the chain had to infer are counted and said to be inferred.

---

## 4. Pipeline

Source for everything on this page: `pipeline-truth.json` rows, filtered by the segment and the filter bar (State, Delivered, and Gate / Package / GLM / Finding / Domain / Carried over / Identity / Duplicates under More filters). Search matches task name, owner, the why line and finding codes.

### States pane

| Card | Number | Counted as | Shown as |
|---|---|---|---|
| **In scope** | Tasks decided | Sum of the five state counts over the filtered rows. | Headline, accepted share, 14-day sparkline of decisions per day. |
| **Accepted** | Accepted packages | Folders in `cohort-index` (the accepted prefix) in the segment and filters. The bucket, not the verdicts, is the acceptance decision. Falls back to Accepted verdict rows if the index has not loaded. | Ring = Accepted verdict rows ÷ all decided. |
| **Rejected / No QC decision** | Verdict rows in that state. | Ring = share of decided. |
| **Running / Legacy accepted** | Verdict rows in that state. | Bar = share of decided. |
| **Delivery join** | Delivered packages found in the bucket | Every batch the Delivery page lists, in the segment, traced into the accepted prefix: Batches 1 to 4.1 by the exact object the manifest names, Drive batches by the folder the manifest names or the folder whose package declares the same task. Follows the segment, not the filters. **Not found** splits into gone from the prefix, packaged from elsewhere, no source named. None is a failed delivery. | Found vs not found balance, split track, foot line with packages and batches. |
| **Accepted packages** | Delivered of accepted | The same folders the Accepted card counts, split by whether any delivery reached them. Delivered + still to deliver = packages, by construction. | Progress track, foot line with still to deliver and later rejected. |

### Delivery & makeup pane

| Card | Number | Counted as | Shown as |
|---|---|---|---|
| **In the accepted cohort** | Packages in the cohort | `cohort-index` folders in the segment, no date range. Steps: **packages** (every folder), **decided** (verdict dated on or after the cut), **accepted** (latest run accepted), **delivered** (reached by a delivery). | Bar list on one axis; tag = distinct tasks among these folders, folded by the `[task]` name each package declares, so folders = tasks + extra copies. |
| **What the shown tasks are** | Shown tasks | Filtered rows split by `connectorType`: connector / non-connector / not known. Counted in tasks, not rows. | Bar list, connector and non-connector highlighted. |
| **Flag cards** | Carried over · Awaiting re-gate · Possible duplicates · Packages at the bar | Flags set by `derive_state.py` on each row: first decided before the cut; accepted under the GLM-5.2 gate only; shares name and trainer with another task; package collectable from the bucket today. Flags overlap, so they do not add up. | Count, % of shown, sparkline per day. Click opens the chain. |
| **Domain** | Tasks with a domain | Same names as the Domain dropdown, so it follows the segment: the five name-prefix domains under Non-connector; Synthetic, Real Connector or Connector under Computer Bench Connector; harness plus single or multi connector under Company Bench. Not recorded excluded. | Column chart ordered by count, tag = % of shown. |

Every dropdown in the filter bar shows the counts for the current segment, so the list only offers values that exist there.

---

## 5. Delivery

Source: `delivery-audit.json` (Batches 1 to 4.1, with trainer and client decision) plus `drive-deliveries.json` (Batch 5.1 onward and CompanyBench 1 to 3, from each batch's `manifest.json`). Drive rows carry no client decision, so they are Pending by construction, and get a trainer from `drive-owners.json` when the bucket names one.

Row rules:

- **Bench**: the image first, then the Drive folder the package sits in. A package in a `CompanyBench/` folder inside a Computer Bench batch is Company Bench. A manifest marking it computer bench keeps it there.
- **Category**: a Company Bench package is `CompanyBench`. Computer Bench categories come from the manifest with `Non-Connector ·` stripped and Code → Engineering, Law → Legal, General and Other/unclassified → Other.
- **GLM bucket**: `n/4` trials solved from the audit or manifest. No run recorded → `(not recorded)`.
- **Trainer**: `Unattributed` when none is recorded; rows with more than one candidate owner are contested and name nobody.

| Card | Number | Counted as | Shown as |
|---|---|---|---|
| **Delivered tasks** | Rows matching the filters | Every audit and Drive row in the segment and filters. | Share of all delivered. |
| **Accepted / Rejected / Pending** | Rows by client acceptance | `acceptance` on the row. Pending = no decision recorded. | Share of shown; click to filter. |
| **Trainers** | Distinct attributed trainers | Rows with an email trainer; note shows the unattributed count. | Count. |
| **Batch scope** | Tasks per batch | All batches, no pagination. **Rate = accepted ÷ (accepted + rejected)**, the tasks the client has decided, never ÷ all tasks. A batch with no decisions reads "awaiting decisions". | One row per batch with count, rate line and verdict bar. |
| **Category mix** | Rows per category | Grouped by category. | Ranked bars, click to filter. |
| **Category × GLM** | Rows per category and GLM bucket | Columns are the GLM buckets present, plus **Not recorded** (no run) and **Sum**, so each row adds up to its category. | Heat map, click a cell to filter both. |
| **Trainer concentration** | Rows per trainer | Attributed rows grouped by trainer, top accounts shown. | Ranked bars. |
| **Verdicts by batch** | Accepted / Rejected / Pending per batch | Same `verdicts()` split as the batch rail. | Stacked bars. |
| **Current view** | Shown · trainer coverage · accepted · rejected · pending | Coverage = attributed ÷ shown. | Strip under the charts. |

The search box at the top filters every card and the table on task, package name, sha, trainer, category and batch. **Export** writes the table as CSV in its current sort and filter.

---

## 6. Layout of the code

| File | Role |
|---|---|
| `index.html` | All markup for every page. |
| `app.js` | Rendering, segment and filter state, every card. |
| `truth.js` | `prepareTruth`, `filterTruth`, `collapseByTask`, `joinDeliveries`, `connectorType`. Pure, tested. |
| `delivery-audit.js` | Merges audit and Drive rows, category and trainer rules, `filterDeliveryAudit`. |
| `daily-delta.js` | Tasks reaching each state per day. |
| `sources.js` | Registry of every feed, with sheet gids and bucket prefixes, for the source panel. |
| `styles.css` | Design tokens and components. |
| `tools/` | Builders the VM runs, and `test-*.cjs` checks. |
