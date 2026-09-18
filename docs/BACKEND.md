# Pipeline backend

How the Pipeline figures are derived from Google Cloud Storage, and why each
rule is what it is.

**Audience:** anyone maintaining the derivation chain, or anyone who needs to
defend a number on the dashboard.

Figures throughout are from build `2026-09-18T05:18:20Z`. The bucket is live, so
figures move between builds — every number on the dashboard carries its build
timestamp, and so should any number quoted from it.

---

## 1. Source of truth

The single source is **`gs://obi-harbor-pipeline`**:

- `tasks/qc_platform_sync/_verdicts/*.json` — schema `harbor/pipeline-verdict/v2`
  — for task state.
- The accepted folders — for delivery.

Nothing is read from the Harbor Console or from Postgres.

### Why not the Harbor Console

The console was the source until 2026-09-17. Reading GCS directly is not a
downgrade: the console itself answers from a GCS assembler and only compares
Postgres in the background (`metadata_adapter.py:769-846`). It was a proxy over
the same data that additionally required a signed-in human.

| | Harbor Console | GCS verdicts |
|---|---|---|
| Authentication | Google IAP; session expires; manual sign-in | VM service account; unattended |
| Cost of one refresh | 34–135 sequential API pages, ~20 min | 10 listings + ~10k small reads, **~35 s** |
| Automatable | No | Yes |

Postgres is in shadow mode and holds no delivery pointers, so it cannot answer
the accepted-versus-legacy question at all.

### Reference document

The design follows the **Harbor pipeline · accounting review** (canonical task
ledger). Section 9 records every point where measurements taken here differ from
that document, and why.

---

## 2. The chain

Eight steps. Each is a separate process reading and writing a JSON file, so any
single step can be re-run in isolation while investigating a figure.

```
ingest_verdicts → index_delivery → assign_identity → select_canonical
   → derive_state → build_tags → build_provenance → reconcile
```

| Step | Tool | Reads | Writes |
|---|---|---|---|
| 1 | `tools/ingest_verdicts.py` | `_verdicts/*.json` | `verdicts.json` |
| 2 | `tools/index_delivery.py` | the four accepted folders | `delivery.json` |
| 3 | `tools/assign_identity.py` | steps 1, 2 | `identities.json` |
| 4 | `tools/select_canonical.py` | step 3 | `canonical.json` |
| 5 | `tools/derive_state.py` | steps 4, 2 | `tasks.json` |
| 6 | `tools/build_tags.py` | step 5, bucket scan | `tagged.json` |
| 7 | `tools/build_provenance.py` | steps 6, 1, 2, 3 | `pipeline-truth.json` |
| 8 | `tools/reconcile.py` | step 7 | exit code |

Every step is read-only against GCS. The chain lists and reads objects; it never
writes to the bucket.

`tools/refresh_truth.sh` runs all eight and publishes the result. Total runtime
is approximately 35 seconds, of which step 1 accounts for 30.

---

## 3. Step 1 — raw verdict ingest

Reads every object under the verdicts prefix and emits one row per
submission × task, plus one explicitly marked row per submission whose verdict
names no tasks.

This step is deliberately un-opinionated. No identity is assigned, no scope
filter is applied, and no states are collapsed. Those happen in later steps so
that each can be verified on its own.

Every row carries `source`, the GCS object path it came from, so any figure on
the dashboard can be traced back to a readable location.

Fields carried forward: `state`, `state_rank`, `stage`, `decided_at`,
`updated_at`, `owner`, `family_id`, `task_id`, `run_id`, `version`,
`submission_batch_id`, `pipeline_batch_id`, `delivery`, and per-task `decision`,
`status` and `findings`.

> **Schema hazard.** `blocking_findings` is an **integer**, sitting directly
> beside `findings`, which is a list. Any code iterating findings must type-check
> first.

---

## 4. Step 2 — delivery index

Folder membership as of the scan. This is the only input to the
accepted-versus-legacy distinction.

| Folder | Role |
|---|---|
| `tasks/finalisation_client_qc_accepted_iteration_2/` | **current bar** |
| `tasks/finalisation_client_qc_accepted_iteration_1/` | retired |
| `tasks/finalization_qc_accepted/` | retired |
| `tasks/finalisation_client_qc_accepted_iteration_2_glm52_gate_only/` | withdrawn, awaiting re-gate |

`finalization_qc_rejected` is excluded deliberately: it is a rejection cohort
holding roughly 2 million objects, and no figure depends on it.

Each cohort is counted twice — by walking objects and by delimiter listing — and
a disagreement between the two is reported rather than passing silently.

Files sitting directly in a cohort root are **sentinels, not tasks**. Counting
them as tasks is what produced the 569-versus-566 discrepancy described in the
reference document.

### Gate sentinels

The bucket records its own gate history in these files. Gate eras are read from
them rather than inferred from model names appearing in verdict text.

| File | Timestamp | Meaning |
|---|---|---|
| `_GLM_CUTOFF.md` | `2026-09-13T20:05:59Z` | finalisation gate switched from Opus to GLM-5.2 |
| `_KESTREL_H_ON.md` | `2026-09-15T03:40:49Z` | KESTREL first switched on |
| `_KESTREL_FULL.md` | `2026-09-16T05:06:54Z` | KESTREL fully operating across both gates |
| `_INVALIDATED.md`, `_invalidation_manifest.json` | 2026-09-16 | the 365 withdrawn packages, each with its gate profile id, agent and model |

`_KESTREL_H_ON.md` is a zero-byte file. Its timestamp is knowable only from the
reference inside `_KESTREL_FULL.md`, so it is pinned in code with a comment
recording that provenance.

`config/final-qc-profiles/pipeline.json` is **not** used for era tagging. It is a
single 289-byte file describing the profile in force today and keeps no history.

---

## 5. Step 3 — identity

A task is a family of runs, not a name. The first method that yields a key wins,
and the method used is recorded on every row so that confidence is visible
downstream.

| Order | Method | Confidence | In scope |
|---|---|---|---|
| 1 | `family_id` | high | 2,209 |
| 2 | runnable content fingerprint | high | **not implemented** |
| 3 | `task_id` | low — marked `unmerged` | 2,368 |
| 4 | `name + owner` | lowest | 3 |

**Task name is never used as a key.** 1,221 names cover more than one identity;
the literal name `task` carries 36 unrelated tasks across 13 trainers. Keying on
name fuses different people's work.

### Why the fingerprint rung is not implemented

`gate.current_fingerprints` hashes a task's runnable content — `task.toml`,
`instruction.md`, `tests/`, `environment/`, `solution/`, `verifier.json`,
`golden_trajectory.json` — and excludes stored runs, which regenerate on every
execution. It is the theoretically correct key.

It is not built because of measured cost against measured benefit: of the rows
that fall through to a weak key, only **493 have a delivered package to hash at
all**. The rest have no archive anywhere. Implementing it requires ranged reads
inside archives to improve a minority of the weak-key population.

### What `family_id` is, and is not

It is **clean**: no family in this dataset spans two trainers.

It is **not complete**: a task can be issued a fresh `family_id` when it is
resubmitted, so one task can hold several families and appear several times.

This distinction matters. It is the reason duplicate detection (§7) keys on name
and owner rather than on `family_id` — keying on the identifier that failed to
group the runs would simply reproduce the failure.

---

## 6. Step 4 — canonical run

One run per identity, chosen by a maximum:

```
canonical(task) = max over runs of (
    wave_depth,          progress through the run's own plan
    outcome_rank,        accepted 3 > rejected 2 > running/queued 1 > error 0
    decided_at           breaks ties on both axes above
)
```

Because it is a maximum, selection is idempotent and order-independent: replaying
rows or adding a rerun can only move a task forward, never oscillate.

**Waves, not stages.** `agent`, `e2b` and `modal` execute as one concurrent wave,
so a run that finished E2B is not further along than one still in the gate. The
verdict's own `stage` field already names them this way (`agent+e2b+modal`), and
that naming is what the ranking reads.

**Progress leads, outcome breaks ties.** A run that reached `harbor-check` and
errored got further than one rejected at intake. Ranking outcome first would let
an early rejection outrank a nearly-complete run.

**Error ranks below running at equal depth.** Both reached the same point, but a
parked run has stopped and needs a person, whereas a live run may still advance.

Every non-canonical run stays attached to the identity and is available in the
drill-down. Nothing is discarded.

The reason a run won is recorded and displayed: *only run*, *further through the
plan*, *better outcome at the same depth*, or *later decision, tied on progress
and outcome*.

### Known limitation

Because the rule is progress-led, an older acceptance can outrank a newer
rejection. Measured on the current build: **69 tasks display `accepted` while
their most recent run is a rejection.** In all 69 the acceptance is the older
event; there are no counter-examples. 40 of them still hold a package at the
current bar.

A proposed correction — *latest decision wins* — is recorded in §12. Pure
latest-run-wins was rejected on measurement: it would discard a real QC decision
in 92 cases where the most recent run merely errored (73) or is still running
(19).

---

## 7. Step 5 — state derivation

Each task receives exactly one state, and records the predicate that produced it.

```
accepted        = canonical decision is accepted
                  AND ( a package sits in the current bar
                        OR now − decided_at < 30 minutes )

legacy accepted = ever accepted AND NOT accepted

rejected        = canonical decision is rejected

no QC decision  = the verdict reports a submission-level state only
```

**Acceptance is determined by folder membership, not by history.** This is
deliberately simpler than "present in a retired bar and absent from the current
one", which leaves a task that was accepted but never delivered anywhere reading
as plainly accepted. Under the folder rule such tasks fall to `legacy accepted`,
and the retired folders cease to be an input.

**The 30-minute grace window** exists because the Package stage runs *after* the
verdict is written. Without it, every fresh acceptance would appear as
`legacy accepted` for the few minutes before its archive lands.

### Duplicate detection

Keyed on **task name + owner**, across all identities regardless of identity
confidence.

| Tier | Rule | Count |
|---|---|---|
| `likely` | same name and owner, **and** the same decision day and outcome | 174 |
| `possible` | same name and owner | 726 |
| | total flagged | **900** |

Residual over-counting is approximately **501 rows of 4,577 — about 11%**.

An earlier implementation flagged only `task_id`-keyed rows, on the assumption
that `family_id` was a complete key. It missed 566 of the 896 identities
involved, most of them family-keyed. §5 explains why.

**Nothing is merged automatically.** A task name can legitimately cover unrelated
work, and 119 of the flagged groups contain members that disagree about the
outcome. Collapsing those would mean choosing a winner, which is a judgement
rather than a cleanup.

---

## 8. Step 6 — tags

Every filter offered by the dashboard maps to exactly one field read from GCS.
The filter vocabulary is emitted **from the data, with counts**, so a filter can
never offer a value that matches nothing, and step 8 fails the build if a value
exists in the data but is not offered.

### Finding codes

Two grammars, normalised differently:

```
HARBOR-CHECK-12                      numbered gate check   → family HARBOR-CHECK
GATE-ORACLE-REJECTED                 flat gate outcome     → itself
l1.realism_leakage:8653e0930c22420b  KESTREL review        → l1.realism_leakage
```

Without stripping the instance hash, KESTREL findings present as ~50 unique codes
each occurring once, which cannot be filtered on meaningfully.

### Findings are split three ways

| Field | Meaning |
|---|---|
| `findings` | what the **canonical run** found — the current verdict |
| `findingsPrior` | codes appearing only on **earlier** runs of the same task |
| `findingsAllRuns` | the union; this is what the filter searches |

Before this split, a task that failed a gate check, was fixed and then accepted
displayed the original failure alongside its acceptance, reading as though it had
been accepted *despite* failing. All 589 accepted tasks have a clean accepting
run; none was accepted with findings on the deciding run. The split affected 123
rows.

### Tag coverage

Coverage is stated rather than assumed, because two of these are thin enough to
mislead:

| Tag | Coverage | Source and limitation |
|---|---|---|
| `gateEra` | 100% | bucket sentinels |
| `domain` | **36%** | declared-name prefix; most task names carry no prefix |
| `connector` | **15%** | structural (`mcp_servers` in `task.toml`); known only where a package was scanned |
| provenance (real / synthetic) | **under 5%** | an external label from the audit sheet; not present in the bucket |

`_partition.json`, present per submission, carries `connector_gyms` per task and
would raise connector coverage to approximately 85% for around 50 seconds of
additional runtime. The verdict filename is the submission folder name, so these
can be fetched directly without listing. Not implemented; see §12.

---

## 9. Step 7 — provenance

**No figure is published without a derivation chain.** A figure is a value plus
the ordered list of predicates that narrowed the population to it, each with the
count that survived.

Chains are **computed by applying the predicates to the real rows**, not written
by hand, so a chain cannot drift away from the number it claims to explain.

```
Accepted = 589
  10,273  verdict objects read from tasks/qc_platform_sync/_verdicts/
  10,273  rows, one per submission × task
   6,742  grouped into identities (family_id, then task_id)
   6,742  one canonical run per identity
   4,577  decision on or after 2026-09-05
     943  canonical decision is accepted
     589  package is in the current bar today
```

The published payload is approximately 3 MB for 4,577 rows, replacing the 36 MB
`gcs-pipeline.json` the previous Pipeline view loaded.

### Differences from the reference document

| | Reference | Measured here | Explanation |
|---|---|---|---|
| Accepted | 566 | 589 | different snapshot, four days later; the KESTREL re-gate has returned packages |
| Scope | all time | since 2026-09-05, on `decided_at` | requirement of this dashboard |
| Verdict shape | "submission × task" fan-out | every verdict names **at most one** task | measured across 10,273 objects |
| `family_id` absent | 19% of rows | **27%** | measured |
| Identity key | runnable fingerprint recommended | `family_id`, fingerprint deferred | only 493 weak-key rows are fingerprintable |

---

## 10. Step 8 — reconciliation gate

`reconcile.py` exits non-zero when an invariant fails, and `refresh_truth.sh`
treats that as fatal: the previously published asset stays in place. A figure
that cannot explain itself is never published.

Verified by deliberately corrupting a figure — corrupted input exits 1, clean
input exits 0.

35 invariants, including:

- every state is a declared one, and the states **partition** the population
- no published row is dated before the scope cut
- every chain is **monotonically non-increasing** and ends at its published value
- every figure agrees with the row count it claims to describe
- every row cites a verdict object, states the predicate that set its state, and
  states why its run was canonical
- every filter value exists in the data, and every value present is offered
- the gap between bucket counts and verdict counts is **computed and attributed**,
  not left for a reader to notice

The last invariant currently reports:

```
628 folders at the current bar vs 526 distinct accepted names in scope
  86  task decided before the cut (out of scope)
  16  in scope, but the canonical state is rejected
```

---

## 11. Operation

```bash
# on the Harbor VM
./refresh_truth.sh                 # rebuild and publish
./refresh_truth.sh --no-publish    # rebuild only
```

From the dashboard, the **Rebuild from the bucket** button on the Pipeline tab
performs the same run over SSH via `tools/truth_server.py`, then copies the
result back. GCS credentials remain on the VM and never reach the browser.

The endpoint binds `127.0.0.1` and rejects any request whose `Host` is not
localhost, because it executes a command.

**No cron job is installed.** `refresh_truth.sh` is cron-ready. The VM already
runs three jobs on `*/5`; an offset schedule such as `2-59/5` avoids contending
with them.

### Tests

```bash
node tools/test-truth.cjs        # partition, filters, chains, refusal to render unreconciled data
node tools/test-views.cjs        # nav, .view sections and the VIEWS whitelist must agree
node tools/test-pipeline-view.cjs
node tools/test-payout-ledger.cjs
node tools/test-explorer.cjs
node tools/test-finalisation-filters.cjs
python tools/test_duplicate_sample.py
```

`test_duplicate_sample.py` exits 1 on a single group,
`a-fortnight-nobody-was-watching`, where the console emits two rows with
identical timestamp, `family_id` **and** `run_id` but conflicting states. This is
a defect in the source data and cannot be resolved here.

---

## 12. Open items

| Item | Detail |
|---|---|
| Latest-decision-wins | Corrects 69 stale acceptances. Designed, not implemented. |
| Duplicate collapse | Collapsing the 174 `likely` groups moves 94 rows out and reduces Accepted by 10. Collapsing all 900 moves 503 rows and reduces Accepted by 46, Rejected by 422. |
| Connector coverage | 15% → ~85% via `_partition.json`, ~50 s added runtime. |
| Bench attribution | Only available by joining the roster on owner email; reaches 61%. 178 roster rows carry no team, and 39% of task owners are absent from the roster. No field in the bucket distinguishes benches. |
| Real versus synthetic | Under 5% coverage; depends on the audit sheet being completed. |
| Scheduled refresh | Script ready; not installed. |
| Publication | The chain runs locally and on the VM. The published dashboard still serves the older console-derived figures. |

---

## 13. Defects found in source data

These are recorded because the dashboard surfaces them rather than smoothing
them over. None is fixable from this repository.

**40 packages are collectable at the current bar while their latest verdict is a
rejection.** Of these:

- **32** are stale artefacts — the package was written at the moment of
  acceptance and never withdrawn when a later run rejected the task. The
  2026-09-16 invalidation of 365 packages was performed once, by hand; nothing
  withdraws artefacts continuously.
- **5** had a package written *after* the rejection, in one case eight days
  later. This is not a cleanup failure; something delivered to the current bar
  for a task whose standing verdict was a rejection.
- **37** hold more than one archive at the current bar.
- **9** appear in both `iteration_2` and `glm52_gate_only` — two archives of the
  same task, one withdrawn and one not.

**1,086 verdicts report a submission-level state with no per-task decision.**
These fan out across a batch and are counted as their own bucket rather than
being forced into accepted or rejected.

**Non-human submitters appear as task owners:** `dev@localhost`,
`harbor-operator-e2e`, and a literal `unknown — no sidecar`. `companybench@turing.com`
is a shared account rather than an individual and will distort any per-person
attribution.
