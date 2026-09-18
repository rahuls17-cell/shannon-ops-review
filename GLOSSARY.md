# Glossary

Every term the dashboard displays, defined once, as an exact predicate.

Code imports these from `taxonomy.js` / `tools/taxonomy.py`; the UI cites this
file by name. **No term may be redefined locally.** If a number on the page
cannot be expressed as a chain of the predicates below, it does not ship.

Source of truth is `gs://obi-harbor-pipeline`. Specifically
`tasks/qc_platform_sync/_verdicts/*.json` (schema `harbor/pipeline-verdict/v2`)
for state, and the accepted folders for delivery. Nothing is read from the
Harbor Console, and nothing from Postgres.

---

## Constants

| Name | Value | Why |
|---|---|---|
| `CUT` | `2026-09-05` | The current pipeline's start. Work decided before this is history. |
| `CURRENT_BAR` | `tasks/finalisation_client_qc_accepted_iteration_2/` | The only folder that means "collectable today". |
| `RETIRED_BARS` | `..._iteration_1/`, `tasks/finalization_qc_accepted/` | Passed a gate that no longer applies. |
| `GATE_ONLY` | `..._iteration_2_glm52_gate_only/` | 365 task folders moved out of the current bar on 2026-09-16. |
| `DELIVERY_GRACE` | 30 minutes | Package runs *after* the verdict, so a fresh acceptance has no archive yet. Without this a new acceptance flickers through `legacy accepted`. |

## Scope

```
in_scope(task)  =  canonical_run(task).decided_at >= CUT
legacy_scope(task)  =  NOT in_scope(task)
```

**The cut is on `decided_at`, not on first submission.** A task uploaded in
August but judged by today's pipeline is in scope, because the current bar is
what judged it. Cutting on submission would hide exactly the re-gated work we
most need to see.

Where `decided_at` is absent (20% of verdicts), fall back to `updated_at` and
mark the row `decided_at_inferred = true`.

## Identity

A task is a **family of runs**, not a name. Assigned by the first method that
yields a key, and the method is recorded on every row:

| Order | Method | Confidence | Note |
|---|---|---|---|
| 1 | `family_id` | high | 100% populated in sampled verdicts; no family observed spans two trainers. |
| 2 | runnable fingerprint | high | sha256 of `task.toml`, `instruction.md`, `tests/`, `environment/`, `solution/`, `verifier.json`, `golden_trajectory.json`. Excludes stored runs and QC artifacts, which regenerate on every run. |
| 3 | `task_id` | low | Over-splits: ~1 identity per row. Rows keyed this way are marked `unmerged`. |
| 4 | `name + owner + date` | lowest | Labelled a guess. **Never `name` alone** — the literal name `task` carries 55 runs across 31 families and 14 trainers. |

## Canonical run

One run per identity, chosen by a maximum, so the result is idempotent and
order-independent — replaying events can only move a task forward:

```
canonical(task) = max over runs of (
    wave_depth,          -- fully cleared waves of THIS run's own plan
    outcome_rank,        -- accepted 3 > rejected 2 > running/queued 1 > error 0
    decided_at           -- only separates runs tied on both axes
)
```

`wave_depth` counts waves, not stages: `agent`, `e2b` and `modal` run as one
concurrent wave, so a run that finished E2B is not ahead of one still in the
gate. It must be computed against the run's own plan — there are two profiles,
a twelve-stage full plan and a six-stage trainer subset.

Every non-canonical run stays attached to the identity. Nothing is deleted.

## States

Ordered by how far the run actually got. A task has exactly one.

| Rank | State | Predicate |
|---|---|---|
| — | `discarded` | A disposition marker exists. **Excluded from ranking and from all counts.** |
| 0 | `not started` | Known to the catalog, never dispatched. |
| 1 | `queued` | Admitted, waiting on a slot. |
| 2 | `running` | In a stage. Refine by stage index. |
| 3 | `error` | Parked or crashed. Ranked `(3, stage_index)` — it is a stop, not a stage, so a run that errored after the gate got further than one that errored at intake. |
| 4 | `rejected` | Reached a QC decision and failed it. |
| 5 | `legacy accepted` | Ever accepted, but not `accepted` now. |
| 6 | `accepted` | See below. |

```
accepted(task)        =  canonical_run(task).decision == 'accepted'
                         AND ( package_in(CURRENT_BAR)
                               OR now - decided_at < DELIVERY_GRACE )

legacy_accepted(task) =  ever_accepted(task) AND NOT accepted(task)
```

**Accepted is defined by the folder, not by history.** This is deliberately
simpler than computing legacy as "in a retired bar minus the current one",
which leaves an accepted task with *no* delivery anywhere reading as plain
accepted. Under the folder rule those fall to legacy, where they belong, and
the retired folders stop being an input at all.

`legacy accepted` outranks `rejected` but **must never mask a current-bar
rejection of the same task** — the situation the 365 gate-only packages are in.

## Carried over

```
carried_over(task) =  first_run(task).decided_at  <  CUT
                      AND accepting_run(task).decided_at >= CUT
```

Old work cleared by the pipeline running today. Not new, not settled history.

A task may be both `carried over` and `legacy accepted`; the two are orthogonal
and both are shown. Carried-over tasks **are** included in the in-scope figures
— they were decided in the window — and the tab is a lens on that population,
not a separate universe. Any card that would double-count says which.

## Tags

All read from the bucket. Every filter on the page maps to exactly one.

| Tag | Source |
|---|---|
| finding codes | `verdict.tasks[].findings[].code` — `HARBOR-CHECK-1..15`, `DIFFICULTY-GLM-TOO-EASY`, `GATE-MODEL-UNSOLVABLE`, `GATE-ORACLE-REJECTED`, `GATE-VERIFIER-UNSTABLE`, `GATE-ORACLE-BROKEN` |
| gate / model | parsed per verdict (`glm-5.2`, `kestrel`). **Not** from `config/final-qc-profiles/pipeline.json`, which is a single file with no history and describes only today. |
| cohort | folder membership, including `GATE_ONLY` |
| connector | `mcp_servers` present in `task.toml` — structural, never the name prefix |
| domain | declared-name prefix (`code-`, `fin-`, `health-`, `law-`, `gen-`) |
| owner | `verdict.owner` |

## Counting bases

Three different questions. Every figure states which it answers.

| Basis | Unit | Use |
|---|---|---|
| verdict rows | submission × task | raw evidence; reconciling against the console's own cards |
| canonical tasks | identity | **every headline figure** |
| delivered packages | task name in a folder | what is collectable |

## Known data defects

Carried, not hidden. Each is surfaced on the page rather than smoothed over.

- **~20% of verdicts list no tasks** (`state` `error`/`running`). They fan out
  across the batch. Emit one row per task marked `no per-task decision`; never
  silently multiply an accepted count by them.
- **`blocking_findings` is an integer**, sitting beside `findings`, which is a
  list. Type-check before iterating.
- **A disposition marker overwrites an acceptance** on the read path whether or
  not the write flag is set.
- **A partial task list zeroes the rest**: tasks a verdict does not name resolve
  to `not_started`, not to their previous state.
