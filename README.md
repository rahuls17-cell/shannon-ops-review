# Shannon Ops Review

An operations dashboard for the Harbor task pipeline, built for VPs, CXOs and
delivery managers.

**Live:** https://rahuls17-cell.github.io/shannon-ops-review/

Static HTML, CSS and vanilla JavaScript. No bundler, no framework, no
`package.json`. GitHub Pages serves the repository root.

---

## What it shows

| Tab | Question | Source |
|---|---|---|
| **Overview** | headline position across all workstreams | workbook + bucket scan |
| **Payouts** | who was paid, for what | workbook |
| **Delivery** | plan versus actual, by bench | workbook |
| **Pipeline** | what the pipeline says about every task | **GCS verdicts** |
| **Carried over** | pre-cut backlog settled by the current pipeline | GCS verdicts |
| **Bucket** | file explorer over the storage bucket, metadata only | GCS listing |

---

## The central idea

**Every figure carries the chain that produced it.**

Click any number on the Pipeline tab and it opens the list of predicates that
narrowed the population down to it, with the count surviving each step, ending
at the Cloud Storage objects the figure was read from:

```
Accepted = 591
  10,293  verdict objects read from tasks/qc_platform_sync/_verdicts/
  10,293  rows, one per submission × task
   6,755  grouped into identities
   6,755  one canonical run per identity
   4,590  decision on or after 2026-09-05
     945  canonical decision is accepted
     591  package is in the current bar today
```

Every row likewise states why it holds its status, why one of its runs was
chosen as canonical, and which verdict object it came from.

Chains are **computed** — each step is the predicate applied to real rows and
counted — so a chain cannot drift away from the number it claims to explain.

`tools/reconcile.py` enforces this as a build gate. It checks 35 invariants and
exits non-zero on failure, and the publishing workflow treats that as fatal. A
figure that cannot explain itself is never published.

---

## Source of truth

**`gs://obi-harbor-pipeline`**, and nothing else, for the Pipeline figures:

- `tasks/qc_platform_sync/_verdicts/*.json` for task state
- the accepted folders for delivery

The Harbor Console is not read, and neither is Postgres. The console was the
source until 2026-09-17; it was dropped because it answers from a Cloud Storage
assembler itself, so reading the bucket directly removes a proxy that
additionally required a signed-in human. A full refresh went from roughly twenty
minutes to thirty-five seconds.

Payouts remains workbook-derived and is deliberately unaffected by any of this.

---

## How a refresh works

An eight-step chain, each step a separate process writing a JSON file, so any
one can be re-run in isolation while investigating a number:

```
ingest_verdicts → index_delivery → assign_identity → select_canonical
   → derive_state → build_tags → build_provenance → reconcile
```

It runs on the Harbor VM, where the storage credentials live. They never reach
a browser.

**From the published site:** the *Rebuild from the bucket* button opens the
**Refresh derived pipeline** workflow. That asks the VM for a rebuild over a key
restricted to a single script, validates what comes back, commits it and
deploys. The page then polls and loads the new data when it lands.

**Locally:**

```bash
python tools/truth_server.py --port 8871
```

Use this rather than `python -m http.server`: only this serves the rebuild
endpoint the button calls. A plain static server answers it with HTTP 501, and
the button will say so.

---

## Reading the numbers

Three figures answer three different questions and will not match. Each is
correct for its own question. The bucket is live, so these move between
refreshes; the page always shows the build timestamp of the data it is
displaying, and figures quoted here are from `2026-09-18T06:08Z`.

| | Current | Counts |
|---|---:|---|
| Packages at the current bar | 630 | task folders in the delivery folder |
| Accepted | 591 | tasks whose verdict is accepted, within the window |
| Distinct accepted names | 528 | tasks once a name counted twice is counted once |

The scope is **tasks decided on or after 2026-09-05**, cut on the decision date
rather than the submission date: a task uploaded in August but judged by the
current pipeline belongs to the current window. 2,165 tasks decided before the
cut are excluded entirely.

### Qualifiers shown on the page

These are displayed rather than smoothed over, because they affect how much
weight a figure carries:

- **unmerged** (2,373) — the submission carried no lineage id, so repeat runs of
  that task may be counted separately.
- **possible / likely duplicate** (904) — another task in scope shares its name
  and trainer. Flagged, never merged: one name in this bucket covers 36
  genuinely unrelated tasks.
- **approx** (1,137) — no decision timestamp on the verdict, so the row is dated
  from when the verdict was last updated.

### Delivered, and what is left to deliver

The Pipeline tab carries a **Delivered** filter, joining the 412 audited tasks
on the Delivery tab onto the pipeline. The two datasets share only the task
name, so that is the key: matched exactly first, then with version and status
suffixes stripped, and never when that would pull in more than one task.

The audit also carries the first 16 hex of each package's sha256. It reaches
only 66 of the 412 — that scan covers what sits at the current bar — so it
cannot be the join, but it can check it. On all 66 rows where both keys exist
they agree, so a name match does not invent a delivery.

| | |
|---|---:|
| Audited tasks matched into the pipeline | 319 of 412 |
| Unmatched, of which accepted | 93, **2** |
| Pipeline rows marked delivered | 452 (319 names) |
| **New unique tasks ready for delivery** | **369** |

*Ready* means accepted, package collectable at the current bar, and not matched
to anything already delivered. The 93 unmatched are reported on the page rather
than hidden; they barely touch accepted work, which is what makes the split
usable. `tools/build_delivered_index.py` does the join once, outside the
browser, and the workflow re-runs it whenever the pipeline is rebuilt — the
index resolves to pipeline task ids, and the page says so if the two ever drift
apart.

---

## What the tooltips mean, in plain words

Hovering the small **?** beside a heading, or any tag on a row, gives the full
explanation in place. Here is the short version of each.

### Tags on a task row

| Tag | In plain words |
|---|---|
| **unmerged** | We are not certain we grouped all of this task's attempts together. The pipeline usually stamps each task with a lineage id; this one arrived without it, so if it was submitted more than once those attempts may be sitting on the page as separate tasks. Nothing else on the page looks like a copy of it. |
| **possible duplicate** | Another task in the list has the same name and the same trainer. It is probably the same piece of work counted twice. We show it rather than merging it, because task names are not unique — one name here covers 36 completely different tasks. |
| **likely duplicate** | The same, but it also matches on the day it was decided and on the outcome. There is not really a story where these are different pieces of work. |
| **carried over** | This task was first judged before 5 September, and the pipeline running today is what finally settled it. It is old backlog being cleared, not new work. |
| **approx** (next to a date) | The record did not say when the decision was made, so we used the last time the record was touched. It is close, but for a task near the 5 September boundary it could sit on the wrong side of it. |

### The ? beside each heading

| Where | In plain words |
|---|---|
| **Tasks** | One row is one task, not one attempt. If a task was submitted five times, you see one row, and it shows the attempt that got furthest. The other four are inside the row, not lost. |
| **Gate era** | Which reviewer judged this task. The reviewer changed twice in September — Opus, then GLM-5.2, then KESTREL — and the dates come from markers the pipeline itself left in storage, not from guesswork. |
| **Identity** | How sure we are that a task's attempts were grouped correctly. *Keyed by family* means the pipeline gave us its own id for the task, which is reliable. *Unmerged* means it did not, so we fell back to a weaker method. |
| **Duplicates** | Why a task is flagged as a probable copy, and why we flag rather than merge. |
| **Finding** | What the reviewer objected to. The filter looks across every attempt, so a task that failed a check, was fixed and then passed is still findable under that check — but the row tells you which attempt each objection came from, so an accepted task is never made to look as though it passed while failing. |
| **What is counted** | Why the cut is on the date a task was *decided* rather than *submitted*: a task uploaded in August but judged this week belongs to this week, because this week's reviewer is what judged it. |
| **Date range** | One date filter drives Overview, Delivery and Pipeline. Payouts is deliberately left out, because the workbook records when someone was *paid*, not when the work happened — filtering it would quietly hide people paid for older work. |
| **Reading from** | Where every number on the page came from, and whether it was read live during this visit or came from a saved copy. |

### Two phrases that appear on every row

- **Why this state** — the exact rule that put this task in its bucket, for
  example *"accepted and its package is in the current bar"*.
- **Canonical run** — why this attempt was chosen over the others, for example
  *"better outcome at the same depth of 2 runs"*.

---

## Known limitations

| | |
|---|---|
| An older acceptance can outrank a newer rejection | 69 tasks display a superseded verdict |
| Residual duplicate counting | approximately 11% |
| Domain attribution | 36% — derived from a name prefix most tasks lack |
| Connector attribution | 15% — known only where a package was scanned |
| Bench attribution | not implemented; the roster covers 61% of task owners |
| Bucket tab | needs a 114 MB index that is not committed, so it is populated only when running locally |

### Defects in the source data, surfaced rather than hidden

**40 packages are collectable at the current bar while their latest verdict is a
rejection** — 32 are artefacts left behind when a re-run failed, and 5 had a
package written *after* the rejection.

**1,086 verdicts report a submission state with no per-task decision.** They are
counted as their own bucket rather than forced into accepted or rejected.

**Some task owners are not people** — `dev@localhost`, `harbor-operator-e2e`, and
`companybench@turing.com`, a shared account.

---

## Repository layout

```
index.html              the page; loads each module in order
app.js                  all DOM rendering and event wiring
truth.js                read model for the GCS-derived Pipeline
pipeline-view.js        earlier console-era model, still used by Overview
sources.js              provenance registry: every figure maps to a source
finalisation.js         bucket cohort model
payout-ledger.js        workbook payout model
explorer.js             bucket file explorer
assets/                 published data
tools/                  the chain, the builders, and the tests
.github/workflows/      refresh-gcs.yml, refresh-truth.yml
```

### Tests

Plain Node and Python, no runner, no dependencies. Each file is self-contained
and exits non-zero on failure.

```bash
node tools/test-truth.cjs        # partition, filters, chains
node tools/test-delivered.cjs    # the delivered / ready-for-delivery join
node tools/test-views.cjs        # nav, sections and the view whitelist must agree
node tools/test-pipeline-view.cjs
node tools/test-payout-ledger.cjs
node tools/test-explorer.cjs
node tools/test-finalisation-filters.cjs
python tools/test_duplicate_sample.py
```

`test_duplicate_sample.py` exits 1 on one group where the source data carries two
verdicts with identical timestamp, lineage id and run id but conflicting states.
That is a defect upstream and cannot be resolved here.
