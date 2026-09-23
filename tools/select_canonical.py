#!/usr/bin/env python3
"""Step 4: pick one canonical run per identity, and record why it won.

    canonical(task) = max over runs of (
        wave_depth,          -- how far the run actually got
        outcome_rank,        -- accepted > rejected > running/queued > error
        decided_at           -- only separates runs tied on both axes
    )

It is a maximum, so it is idempotent and order-independent: replaying rows or
adding a rerun can only move a task forward, never flip it back and forth.

Progress leads and outcome breaks ties, not the other way round. A run that
reached harbor-check and errored got further than one rejected at intake, and
saying otherwise would let an early rejection outrank a nearly-finished run.

Waves, not stages: agent, e2b and modal run concurrently, so a run that
finished E2B is not ahead of one still in the gate. The verdict's own `stage`
field already names them that way ("agent+e2b+modal", "e2b+modal"), which is
what this reads.

Error is ranked below running at equal depth on purpose. A parked run and a
live run reached the same point, but the parked one stopped and needs a person;
the live one may still advance. Its resolution is pending, not worse.

Every non-canonical run stays attached to the identity. Nothing is discarded.

    python3 select_canonical.py --identities identities.json
"""
import argparse
import collections
import json
from datetime import datetime, timezone
from pathlib import Path

# The pipeline plan, collapsed to waves. Index is the wave depth.
WAVES = [
    ('intake', 0), ('oracle', 1), ('presolve', 2), ('gate', 3), ('pre-qc', 4),
    ('agent+e2b+modal', 5), ('agent', 5), ('e2b+modal', 5), ('e2b', 5), ('modal', 5),
    ('escalate', 6), ('post-gate', 7), ('harbor-check', 8), ('package', 9),
]
WAVE_DEPTH = {name: depth for name, depth in WAVES}
MAX_WAVE = max(WAVE_DEPTH.values())

OUTCOME_RANK = {'accepted': 3, 'rejected': 2, 'running': 1, 'queued': 1, 'error': 0}


def wave_depth(row):
    """How far this run got, and how we know. A decided run reached the end of
    the plan by definition; an undecided one is placed by its reported stage."""
    decision = (row.get('decision') or '').lower()
    if decision in ('accepted', 'rejected'):
        return MAX_WAVE, 'decided, so the plan completed'
    stage = (row.get('stage') or '')
    key = str(stage).strip().lower()
    if key in WAVE_DEPTH:
        return WAVE_DEPTH[key], f'reported stage {stage!r}'
    state = (row.get('state') or '').lower()
    if state in ('accepted', 'rejected'):
        return MAX_WAVE, 'submission-level decision, no stage reported'
    return 0, 'no stage reported'


def rank(row):
    depth, why = wave_depth(row)
    state = (row.get('state') or '').lower()
    outcome = OUTCOME_RANK.get(state, 0)
    when = str(row.get('decidedAt') or row.get('updatedAt') or '')
    return (depth, outcome, when), why


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--identities', default='identities.json')
    ap.add_argument('--out', default='canonical.json')
    args = ap.parse_args()

    payload = json.loads(Path(args.identities).read_text(encoding='utf-8'))
    rows = payload['rows']

    groups = collections.defaultdict(list)
    for row in rows:
        groups[row['identity']].append(row)

    tasks, reasons = [], collections.Counter()
    for identity, runs in groups.items():
        scored = []
        for run in runs:
            key, why = rank(run)
            scored.append((key, why, run))
        scored.sort(key=lambda s: s[0], reverse=True)
        (depth, outcome, when), why, winner = scored[0]

        # Which axis actually decided it - that is what the drill-down shows.
        if len(scored) == 1:
            reason = 'only run'
        else:
            runner_up = scored[1][0]
            reason = ('further through the plan' if depth > runner_up[0]
                      else 'better outcome at the same depth' if outcome > runner_up[1]
                      else 'later decision, tied on progress and outcome' if when > runner_up[2]
                      else 'tied on every axis; first by sort order')
        reasons[reason] += 1

        tasks.append({
            'identity': identity,
            'identityMethod': winner['identityMethod'],
            'identityConfidence': winner['identityConfidence'],
            # declared_name groups (step 3b) are joined on the name the package
            # itself declares, which is read rather than guessed - merged, not a
            # fallback key.
            'unmerged': winner['identityMethod'] not in ('family_id', 'declared_name'),
            'name': winner.get('taskName') or winner.get('submission'),
            # The task's own [task] name from task.toml, when any run's folder was
            # read. The `name` above is what the submitting tool called it, often
            # a placeholder; the page shows both when they differ.
            'declaredName': winner.get('declaredName') or next(
                (r['declaredName'] for r in runs if r.get('declaredName')), ''),
            'owner': winner.get('owner') or None,
            'state': winner.get('state'),
            'decision': winner.get('decision') or '',
            'decidedDay': winner.get('decidedDay'),
            # Full instant, not just the day: the gate eras are marked by
            # timestamps mid-day (GLM cutoff 20:05:59Z, KESTREL full 05:06:54Z).
            'decidedAt': winner.get('decidedAt') or winner.get('updatedAt') or '',
            'decidedAtInferred': winner.get('decidedAtInferred'),
            'waveDepth': depth,
            'waveEvidence': why,
            'outcomeRank': outcome,
            'canonicalSource': winner['source'],
            'canonicalReason': reason,
            'runs': len(runs),
            'everAccepted': any((r.get('state') or '').lower() == 'accepted' or
                                (r.get('decision') or '').lower() == 'accepted' for r in runs),
            'owners': sorted({r['owner'] for r in runs if r.get('owner')}),
            # Two different questions, and conflating them made an accepted task
            # read as though it had failed its gate checks. `findingCodes` is
            # what the CANONICAL run found - what the task's current verdict
            # actually says. `findingCodesAllRuns` is the union across every run,
            # which is what a filter like "ever tripped HARBOR-CHECK" needs.
            'findingCodes': sorted(winner.get('findingCodes') or []),
            'findingCodesAllRuns': sorted({c for r in runs for c in (r.get('findingCodes') or [])}),
            'findingsFromOtherRuns': sorted(
                {c for r in runs for c in (r.get('findingCodes') or [])} -
                set(winner.get('findingCodes') or [])),
            'firstDecidedDay': min((r.get('decidedDay') or '9999' for r in runs), default=''),
            'firstDecidedAt': min((r.get('decidedAt') or r.get('updatedAt') or '9999'
                                   for r in runs), default=''),
            'acceptedAt': max((r.get('decidedAt') or r.get('updatedAt') or ''
                               for r in runs
                               if (r.get('decision') or r.get('state') or '').lower() == 'accepted'),
                              default=''),
            'otherRuns': [{'source': r['source'], 'state': r.get('state'),
                           'decision': r.get('decision') or '',
                           'decidedDay': r.get('decidedDay'), 'owner': r.get('owner')}
                          for r in runs if r['source'] != winner['source']],
        })

    tasks.sort(key=lambda t: (t['decidedDay'] or '', t['name'] or ''), reverse=True)

    CUT = '2026-09-05'
    in_scope = [t for t in tasks if (t['decidedDay'] or '') >= CUT]
    states = collections.Counter(t['state'] for t in in_scope)
    decisions = collections.Counter(t['decision'] or '(none)' for t in in_scope)

    print(f'{len(rows):,} rows -> {len(tasks):,} identities, one canonical run each\n')
    print('why the canonical run won:')
    for r, n in reasons.most_common():
        print(f'  {n:>6,}  {r}')
    print(f'\nin scope (decision >= {CUT}): {len(in_scope):,}   legacy: {len(tasks) - len(in_scope):,}')
    print(f'  canonical state    : {dict(states)}')
    print(f'  canonical decision : {dict(decisions)}')
    print(f'  ever accepted      : {sum(1 for t in in_scope if t["everAccepted"]):,}')
    print(f'  unmerged identities: {sum(1 for t in in_scope if t["unmerged"]):,}')
    multi = [t for t in in_scope if t['runs'] > 1]
    print(f'  with >1 run        : {len(multi):,}  (max {max((t["runs"] for t in tasks), default=0)})')

    out = {
        'generatedAt': datetime.now(timezone.utc).isoformat(timespec='seconds'),
        'step': '4-canonical-run',
        'rule': 'max(waveDepth, outcomeRank, decidedAt)',
        'coverage': {
            'rows': len(rows), 'identities': len(tasks),
            'inScope': len(in_scope), 'legacy': len(tasks) - len(in_scope),
            'canonicalReasons': dict(reasons),
            'inScopeStates': dict(states), 'inScopeDecisions': dict(decisions),
        },
        'tasks': tasks,
    }
    Path(args.out).write_text(json.dumps(out, separators=(',', ':')), encoding='utf-8')
    print(f'\nwrote {args.out} ({Path(args.out).stat().st_size/1e6:.1f} MB)')


if __name__ == '__main__':
    main()
