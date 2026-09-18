# LLM.md

Context for an AI agent working in this repository. Read this before changing
anything; several rules here exist because breaking them has already caused
incidents, and the reasons are not visible in the code.

---

## What this is

A static dashboard — HTML, CSS, vanilla JavaScript. No bundler, no framework, no
`package.json`, no build step. GitHub Pages serves the repository root.

It reports on the Harbor task pipeline for VPs, CXOs and delivery managers.

---

## The rule that governs everything

**No figure ships without the chain that produced it.**

A figure is not a number. It is a number plus the ordered list of predicates
that narrowed the population down to it, each with the count that survived.
Chains are *computed* by applying those predicates to real rows, never written by
hand, so a chain cannot drift from the number it claims to explain.

`tools/reconcile.py` enforces this: 35 invariants, non-zero exit, and both the
local runner and the publishing workflow treat that exit as fatal.

If a change would introduce a number that cannot produce such a chain, the change
is wrong — find another way.

---

## Source of truth

| Data | Source | Notes |
|---|---|---|
| Pipeline state | `gs://obi-harbor-pipeline/tasks/qc_platform_sync/_verdicts/*.json` | schema `harbor/pipeline-verdict/v2` |
| Delivery | the accepted folders in the same bucket | folder membership decides acceptance |
| Payouts | the workbook (`assets/data.js`, `payout-ledger.json`) | unrelated to the above |

**Do not read the Harbor Console.** It was the source until 2026-09-17 and was
dropped deliberately: it answers from a Cloud Storage assembler itself, so it was
a proxy over the same data that additionally required a signed-in human and took
twenty minutes per refresh. `pipeline-view.js` and the `harbor-console-*.json`
assets survive only because Overview still uses them for owner attribution.

**Do not read Postgres.** It is in shadow mode and holds no delivery pointers.

---

## Hard constraints

- **The bucket is read-only.** List and read objects; never write. The chain and
  every tool honour this.
- **The Harbor Console sits behind Google IAP.** No API key exists and a service
  account is rejected. Only a signed-in browser session can read it. Never enter
  anyone's credentials; if console data is ever needed, the human signs in and
  the agent reads from the authenticated tab.
- **The deploy key is pinned to one script.** `authorized_keys` forces
  `/root/shannon-refresh/vm-export.sh` regardless of what the client asks for, and
  puts the request in `SSH_ORIGINAL_COMMAND`. Every capability of that key must
  therefore be a mode inside that script. Do not attempt to run other commands
  over it; that restriction is the security boundary.
- **Credentials stay on the VM.** They must never reach a browser or this repo.

---

## Architecture

### Module pattern

Every module is an IIFE assigning to `window` and, when present, `module.exports`:

```js
(function (root) { /* … */
  root.prepareTruth = prepareTruth;
  if (typeof module !== 'undefined') module.exports = {prepareTruth, filterTruth};
})(typeof window === 'undefined' ? globalThis : window);
```

This is what lets the `.cjs` tests require the exact file the browser loads.
**Keep it.** Converting to ES modules breaks every test.

Each module splits into a pure `prepareX(source)` — shape the data — and
`filterX(rows, filters)` — select and tally. `app.js` does all DOM rendering and
never re-derives what a prepare/filter pair already returned.

### Load order in `index.html` matters

```
assets/data.js → sources.js → finalisation.js → pipeline-view.js
  → truth.js → payout-ledger.js → explorer.js → app.js
```

### The derivation chain

Runs on the Harbor VM, where the credentials are. Eight separate processes, each
writing a JSON file, so any one can be re-run while investigating a number:

```
ingest_verdicts → index_delivery → assign_identity → select_canonical
   → derive_state → build_tags → build_provenance → reconcile
```

`tools/refresh_truth.sh` runs all eight in about 35 seconds.

The browser never derives a status. Every state, predicate and tag is decided by
the chain and carried on the row, so the page and the reconciliation harness
cannot disagree about what a number means.

---

## Decisions that look wrong until you know why

**A task is a family of runs, never a name.** One literal name in this bucket,
`task`, carries 36 unrelated tasks across 13 trainers. Keying on name fuses
different people's work. This is the single biggest correctness trap here.

**`family_id` is clean but not complete.** No family spans two trainers, so it is
trustworthy as far as it goes — but a task can be issued a *fresh* family when it
is resubmitted, so one task can hold several. This is why duplicate detection
keys on **name + owner** and not on `family_id`: keying on the identifier that
failed to group the runs would simply reproduce the failure. An earlier version
made exactly that mistake and missed 566 of 896 affected identities.

**Acceptance is decided by folder membership today, not by history.** A task is
accepted if its package sits in the current bar now. There is a 30-minute grace
window because the Package stage runs *after* the verdict is written; without it
every fresh acceptance flickers through `legacy accepted`.

**Findings are attributed to the run that raised them.** Showing the union across
runs made 123 accepted tasks read as though they had been accepted *despite*
failing their gate checks. `findings` is the canonical run's; `findingsPrior` is
earlier runs'; `findingsAllRuns` is what the filter searches.

**`no QC decision` is its own bucket.** 1,086 verdicts report a submission state
with no per-task decision. Forcing them into accepted or rejected would be a
fabrication.

**Gate eras come from sentinel files in the bucket**, not from searching verdict
text for model names, and not from `config/final-qc-profiles/pipeline.json`,
which describes only today and keeps no history.

---

## Traps that have already bitten

**A tab must be registered in three places** — the nav button, the `.view`
section in `index.html`, and the `VIEWS` whitelist in `app.js`. Miss the
whitelist and the tab renders its data but `switchView` silently refuses to open
it. `tools/test-views.cjs` now asserts all three agree.

**`submitted_at` and `decided_at` carry full timestamps.** Slicing them to a
date makes same-day resubmissions unorderable. Rows carry both `date` (the
instant, for ordering) and `day` (the calendar day, for grouping and range
filters). An anchored `/^\d{4}-\d{2}-\d{2}$/` against a timestamp matches
nothing, which once emptied a chart and silently made every date range return
zero rows.

**`blocking_findings` is an integer** sitting directly beside `findings`, which
is a list. Type-check before iterating.

**Never edit JavaScript with brace-matching scripts.** Template literals contain
braces, and a naive matcher has already deleted adjacent functions. Use explicit,
anchored string replacement, and run `node --check` afterwards.

**GitHub Pages does not deploy on push.** Pages is configured as `build_type:
workflow`, so only a workflow run deploys. A push alone changes nothing on the
live site.

**Pages caches aggressively.** Published asset URLs are stamped with the commit
sha at publish time; without that, returning visitors run the previous build's
JavaScript against new data. This has already made a fixed chart look broken.

**Never rebase a regenerated file.** The snapshots are rewritten wholesale, so
rebasing one onto a moved branch conflicts on every line. Both workflows reset
onto `origin/main`, re-apply the file, commit and retry.

---

## Verifying a change

```bash
python tools/truth_server.py --port 8871      # serves the page AND the rebuild endpoint
```

Use this rather than `python -m http.server`, which answers the rebuild request
with HTTP 501.

```bash
node tools/test-truth.cjs
node tools/test-views.cjs
node tools/test-pipeline-view.cjs
node tools/test-payout-ledger.cjs
node tools/test-explorer.cjs
node tools/test-finalisation-filters.cjs
python tools/test_duplicate_sample.py
```

`test_duplicate_sample.py` exits 1 on one group where the source data itself
carries two verdicts with identical timestamp, lineage id **and** run id but
conflicting states. That is an upstream defect, not a regression.

**Serve on a fresh port after editing.** Browser caching will otherwise hand you
the previous build and you will debug a file that is no longer running.

---

## Known open work

| | |
|---|---|
| An older acceptance can outrank a newer rejection | 69 tasks show a superseded verdict. The fix is *latest decision wins* — a later `error` or `running` must not overturn a decision, which pure latest-run-wins would do in 92 cases. |
| Duplicates are flagged, not separated | Collapsing the 174 `likely` groups reduces Accepted by 10; collapsing all 904 reduces it by 46 and Rejected by 422. |
| Connector coverage 15% | `_partition.json` per submission carries `connector_gyms` and would reach ~85% for ~50 s. The verdict filename is the submission folder name, so these can be fetched directly without listing. |
| Bench attribution | Only available by joining the roster on owner email; reaches 61%. Nothing in the bucket distinguishes benches. |
| Bucket tab index | 114 MB, gitignored, so that tab is populated only when running locally. |

---

## Data defects that are not fixable here

Surface them; do not smooth them over.

- **40 packages are collectable at the current bar while their latest verdict is
  a rejection.** 32 are artefacts left behind when a re-run failed; 5 had a
  package written *after* the rejection; 37 hold more than one archive.
- **Some owners are not people:** `dev@localhost`, `harbor-operator-e2e`,
  `unknown — no sidecar`, and `companybench@turing.com`, a shared account. Exclude
  them from per-person attribution.
- **The bucket is pruned.** Folder counts under-report: 359 task folders
  disappeared in one 30-minute window on 2026-09-16 while the verdicts kept every
  record. Never read "no folder" as "never delivered".

---

## Working style expected here

- **Measure, do not assume.** Every figure in this repository was verified against
  the data before it was written down. Several confident estimates were wrong by
  large factors — residual duplication was estimated at 4% and measured at 11%.
- **State coverage as a number.** "Domain is 36% attributed" is useful; "domain is
  available" is misleading.
- **Prefer a visible qualifier to a clean number that is quietly untrue.** The
  `unmerged`, `possible duplicate` and `approx` tags all exist for this reason.
- **Flag rather than merge** when the evidence is probabilistic.
