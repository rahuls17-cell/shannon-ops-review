# Dashboard reference

Every tab, card, tag and filter, and what each number means.

**Audience:** anyone reading a figure off this dashboard who needs to know what
it counts, and anyone changing the interface.

Figures throughout are from build `2026-09-18T05:18:20Z`. The bucket is live, so
figures move between builds; every page displays the build timestamp of the data
it is showing.

For the derivation behind these numbers, see [BACKEND.md](BACKEND.md).

---

## Running the dashboard

```bash
python tools/truth_server.py --port 8871
```

Use `truth_server.py` rather than `python -m http.server`. Only the former
exposes the rebuild endpoint that the Pipeline tab's button calls; a plain static
server answers that request with HTTP 501, and the button reports this.

---

## Tabs

| Tab | Question it answers | Data source |
|---|---|---|
| **Overview** (`command`) | headline position across all workstreams | workbook + bucket scan |
| **Payouts** | who was paid, for what | workbook only |
| **Delivery** | plan versus actual, by bench | workbook |
| **Pipeline** | what the pipeline says about every task | **GCS verdicts** |
| **Carried over** | pre-cut backlog settled by the current pipeline | GCS verdicts |
| **Bucket** (`explorer`) | file explorer over the bucket, metadata only | GCS listing |

> **When adding a tab**, it must be registered in three places that are checked
> against each other: the nav button, the `.view` section in `index.html`, and
> the `VIEWS` whitelist in `app.js`. A tab missing from the whitelist renders its
> data but `switchView` refuses to open it, with no error.
> `tools/test-views.cjs` asserts all three agree.

---

# Pipeline

Derived entirely from `gs://obi-harbor-pipeline`. The Harbor Console is not read.

## Rebuild from the bucket

Runs the full eight-step derivation on the Harbor VM and retrieves the result —
35 to 50 seconds. GCS credentials remain on the VM.

If the rebuild fails its own reconciliation checks, the page **keeps the
previously loaded data** and the status line names the invariant that failed.
Data that cannot explain itself is never displayed.

## Cards

Each card is clickable and opens its **derivation chain**: every predicate that
narrowed the population, with the count surviving each one, ending at the GCS
objects the figure was read from.

| Card | Current | Definition |
|---|---:|---|
| **Accepted** | 589 | The canonical verdict is accepted **and** a package sits in `iteration_2` now. A fresh acceptance also counts during a 30-minute grace window, because the Package stage runs after the verdict is written. |
| **Legacy accepted** | 354 | Accepted at some point, but no package at the current bar. Almost all are the GLM-5.2 withdrawal awaiting re-gate. |
| **Rejected** | 2,505 | Reached a QC decision and failed it. |
| **No QC decision** | 1,086 | Parked, crashed, or never decided. Recorded as its own bucket; classifying these as accepted or rejected would be a fabrication. |
| **Running** | 43 | In a stage, no decision yet. |
| **Carried over** | 252 | First decided before the cut, settled after it. **Included within the figures above, not added to them.** |

The first five **partition** the population: 589 + 354 + 2,505 + 1,086 + 43 =
4,577. The build fails if they ever do not.

Two further figures appear in chains and in the audit line:

- **Awaiting KESTREL re-gate — 707.** Present in the GLM-5.2 gate-only folder;
  acceptance withdrawn on 2026-09-16.
- **Packages at the current bar — 628.** Counted directly from the bucket with no
  verdict involved. This answers a different question from *Accepted*.

### Why 628 and 589 differ

Both are correct; they count different things.

| | |
|---|---:|
| Task folders at the current bar | 628 |
| less: task decided **before the cut**, so out of scope | −86 |
| less: in scope, but the canonical verdict is **rejected** | −16 |
| = distinct accepted task **names** in scope | **526** |
| plus: names carrying more than one accepted identity | +63 |
| = accepted **identities** | **589** |

No accepted name lacks a folder, so nothing is missing in the opposite
direction.

Three figures, three questions: **628** is what the folder holds, **589** is what
the verdicts say within the window, **526** is distinct tasks once a name counted
twice is counted once.

## What is counted

A panel stating the scope boundary, with an **outcome × day** heatmap.

- The cut is applied to the **decision date**, not the submission date. A task
  uploaded in August but judged by the current pipeline belongs to the current
  window, because the current bar is what judged it.
- **2,165 tasks** whose last decision precedes the cut are excluded entirely and
  appear nowhere on the page.
- Rows are outcomes, columns are days, cells are counts; the final row is the
  daily total. Hatched cells mean none that day.
- The colour ramp is sequential — one hue, light to dark — and validated against
  the page surface. It is violet rather than the blue used by the Delivery
  heatmap, so two unrelated measures never read as the same scale.

## Task table

One row per **task**, not per submission. Runs of the same task are grouped, the
row shows the canonical run, and every other run remains available in the
drill-down.

Columns: Task · State · Trainer · Decided · Gate era · Runs.

Long task names truncate with the full name on hover, so a tag is never pushed
onto a second line.

### Tags

Each tag carries the same explanation on hover.

| Tag | Meaning |
|---|---|
| **possible duplicate** | Another task in scope has the **same name and the same trainer**. Probably one task counted more than once. |
| **likely duplicate** | As above, **and** the same decision day and the same outcome. |
| **unmerged** | This submission carried no `family_id`, so the task is keyed on its own submission id and repeat runs of it may be counted separately. **No other task shares its name and trainer** — that is what distinguishes this from *possible duplicate*. |
| **carried over** | First decided before the cut and settled after it: backlog cleared by the current pipeline rather than new work. |
| **approx** | Shown against the date. The verdict carried no decision timestamp, so the row is dated from when the verdict was last updated. Applies to 1,129 rows; close to the cut, a small number could fall on the wrong side of it. |

### Evidence drawer

Expanding a row gives six lines, ending in the object the row was read from.

| Line | Example |
|---|---|
| Why this state | *accepted and its package is in the current bar* |
| Canonical run | *better outcome at the same depth of 2 runs* |
| Identity | *Keyed by the pipeline family id* — or, when unmerged, why not |
| Delivered | which accepted folders hold a package |
| Findings | *None on this run · HARBOR-CHECK on an earlier run of the same task* |
| Read from | `tasks/qc_platform_sync/_verdicts/pipeline-evaluation-…json` |

> **Findings are attributed to a run deliberately.** An accepted task showing
> HARBOR-CHECK was not accepted *despite* failing a check — it failed, was fixed,
> and passed. The line names which run each finding came from. Every accepted
> task has a clean accepting run.

### Filters

| Filter | Options | Notes |
|---|---|---|
| **State** | 5 | accepted · legacy accepted · rejected · error · running |
| **Gate era** | 4 | Opus · GLM-5.2 gate only · KESTREL on · KESTREL full. Read from bucket sentinels, not inferred. |
| **Finding** | 15 families | **Searches every run**, so a task that tripped a check, was fixed and accepted remains findable under that check. |
| **Delivery** | 3 | At the current bar · Awaiting KESTREL re-gate · No package |
| **Carried over** | 2 | |
| **Identity** | 2 | Keyed by family · Unmerged |
| **Duplicates** | 3 | Flagged as duplicate · Likely duplicate · Not flagged |
| **Domain** | 7 | **Attributed on only 36% of tasks** — derived from the declared-name prefix, which most task names lack. |
| **Trainer** | 353 | Includes `companybench@turing.com`, a shared account rather than an individual. |
| **Search** | — | task name, trainer, or the state predicate |

Every option displays its own count. The vocabulary is generated from the data,
so a filter cannot offer a value that matches nothing, and the build fails if a
value present in the data is not offered.

### Caveat line

Displayed permanently beneath the table heading so that qualifiers are not
buried:

> *2,368 of 4,577 shown are unmerged, so repeat runs of them may still count
> separately. 1,129 carry no decision timestamp and are dated from when the
> verdict was last updated.*

---

# Carried over

The 252 tasks first decided before the cut that the current pipeline has since
settled.

| Card | Current |
|---|---:|
| Carried over | 252 |
| Now accepted | 85 |
| Legacy accepted | 13 |
| Still unresolved | 10 |

The page states that these are **included in the Pipeline figures rather than
added to them**; the tab is a lens on that population, not a separate universe.

Filters: State · Trainer · Search.

---

# Bucket

A metadata-only file explorer over `gs://obi-harbor-pipeline` — names, sizes and
timestamps. No object contents are fetched, and nothing writes to the bucket.

Scope is seven prefixes: the finalisation cohorts and `trainer/`. The remainder
is not mirrored — the full bucket measured over 22.5 million objects and 9.3
million folders, a walk exceeding 35 minutes that cannot be served as a static
index. The page states this rather than appearing empty.

The index is built on the VM and published separately. It is 114 MB across 512
shards and is not committed, so this tab is populated only when running locally
with the index present.

---

# Overview, Payouts and Delivery

These tabs are unchanged by the Pipeline work and remain workbook-derived.

**Overview's *Accepted tasks* and *Finalisation v2* cards come from the bucket
scan rather than from verdicts.** They count what is stored, which is a different
question from what the pipeline accepted. This is the usual explanation when
Overview and Pipeline appear to disagree.

**Payouts is deliberately exempt from the shared date range.** The workbook
records what was *paid*, not when the work was performed, so a date filter there
would silently exclude people paid for older work.

---

# Known gaps

| Gap | Detail |
|---|---|
| Duplicates are flagged but not separated | A dedicated tab is designed, not built. |
| An older acceptance can outrank a newer rejection | 69 rows currently display a superseded verdict. Correction designed; see BACKEND.md §12. |
| No bench filter | Roster attribution reaches 61%; no field in the bucket distinguishes Company from Computer bench. |
| No connector or real/synthetic filter | 15% and under 5% coverage respectively. |
| Domain filter is thin | 36% attributed. |
| Bucket tab requires a local index | The index is not published. |
