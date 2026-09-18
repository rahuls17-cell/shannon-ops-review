#!/usr/bin/env python3
"""Step 5: derive the state every figure is counted from, one predicate at a time.

Each task records the predicate that fired, so "why is this legacy?" has a
literal answer on the row rather than an explanation in someone's head.

    accepted        = canonical decision accepted
                      AND ( package in the current bar
                            OR now - decided_at < grace )
    legacy accepted = ever accepted AND NOT accepted
    rejected        = canonical decision rejected
    no QC decision  = canonical run reports a submission state only

Accepted is decided by the folder, not by history. That is simpler than
"in a retired bar and not the current one", which leaves an accepted task with
no delivery anywhere reading as plain accepted. Under the folder rule those
fall to legacy, where they belong.

The grace window exists because the Package stage runs AFTER the verdict, so a
just-accepted task has no archive for a few minutes. Without it a fresh
acceptance flickers through legacy on its way to accepted.

Gate eras come from the bucket's own sentinel files, not from a text search for
a model name, and not from config/final-qc-profiles/pipeline.json, which holds
only today's profile and keeps no history.

    python3 derive_state.py --canonical canonical.json --delivery delivery.json
"""
import argparse
import collections
import json
from datetime import datetime, timedelta, timezone
from pathlib import Path

CUT = '2026-09-05'
CURRENT_BAR = 'tasks/finalisation_client_qc_accepted_iteration_2/'
GATE_ONLY = 'tasks/finalisation_client_qc_accepted_iteration_2_glm52_gate_only/'
GRACE = timedelta(minutes=30)

# Recorded in the bucket. _KESTREL_H_ON.md is a zero-byte file; its timestamp is
# only knowable from the reference inside _KESTREL_FULL.md, so it is pinned here
# with that provenance rather than read from an empty object.
GATE_ERAS = [
    ('2026-09-16T05:06:54Z', 'KESTREL full',
     'tasks/finalisation_client_qc_accepted_iteration_2/_KESTREL_FULL.md'),
    ('2026-09-15T03:40:49Z', 'KESTREL on',
     'referenced by _KESTREL_FULL.md; _KESTREL_H_ON.md is empty'),
    ('2026-09-13T20:05:59Z', 'GLM-5.2 gate only',
     'tasks/finalisation_client_qc_accepted_iteration_2/_GLM_CUTOFF.md'),
    ('', 'Opus gate', 'before the GLM cutoff'),
]


def name_key(value):
    v = str(value or '').strip().lower()
    for p in ('harbor/', 'obi/'):
        if v.startswith(p):
            v = v[len(p):]
    return v


def gate_era(when):
    for boundary, label, source in GATE_ERAS:
        if not boundary or str(when) >= boundary:
            return label, source
    return 'Opus gate', 'before the GLM cutoff'


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--canonical', default='canonical.json')
    ap.add_argument('--delivery', default='delivery.json')
    ap.add_argument('--out', default='tasks.json')
    ap.add_argument('--now', help='override the clock, for reproducible tests')
    args = ap.parse_args()

    canon = json.loads(Path(args.canonical).read_text(encoding='utf-8'))
    deliv = json.loads(Path(args.delivery).read_text(encoding='utf-8'))
    delivered = deliv['tasks']
    now = (datetime.fromisoformat(args.now) if args.now
           else datetime.now(timezone.utc))

    out, predicates, joins = [], collections.Counter(), collections.Counter()
    for task in canon['tasks']:
        key = name_key(task['name'])
        folders = delivered.get(key) or []
        cohorts = [f['cohort'] for f in folders]
        at_bar = CURRENT_BAR in cohorts
        gate_only = GATE_ONLY in cohorts
        joins['delivery joined by name' if folders else 'no delivery row'] += 1

        decision = (task.get('decision') or '').lower()
        state = (task.get('state') or '').lower()
        accepted_at = task.get('acceptedAt') or ''
        fresh = False
        if accepted_at and not at_bar:
            try:
                fresh = now - datetime.fromisoformat(accepted_at.replace('Z', '+00:00')) < GRACE
            except ValueError:
                fresh = False

        if decision == 'accepted' or state == 'accepted':
            if at_bar:
                final, why = 'accepted', 'accepted and its package is in the current bar'
            elif fresh:
                final, why = 'accepted', 'accepted within the grace window; package not written yet'
            elif gate_only:
                final, why = 'legacy accepted', 'acceptance withdrawn: GLM-5.2 gate only, awaiting KESTREL re-gate'
            elif cohorts:
                final, why = 'legacy accepted', 'delivered only to a retired bar'
            else:
                final, why = 'legacy accepted', 'accepted but no package delivered anywhere'
        elif decision == 'rejected' or state == 'rejected':
            final, why = 'rejected', 'reached a QC decision and failed it'
        elif state == 'running':
            final, why = 'running', 'in a stage, no decision yet'
        elif state == 'queued':
            final, why = 'queued', 'admitted, waiting on a slot'
        elif state == 'error':
            final, why = 'error', 'parked or crashed before a decision'
        else:
            final, why = 'no QC decision', 'verdict reports a submission state only'
        predicates[why] += 1

        era, era_source = gate_era(task.get('decidedAt') or '')
        first, dec = task.get('firstDecidedDay') or '', task.get('decidedDay') or ''
        out.append(dict(
            task,
            finalState=final,
            statePredicate=why,
            inScope=dec >= CUT,
            carriedOver=bool(first and first < CUT and dec >= CUT),
            atCurrentBar=at_bar,
            gateOnly=gate_only,
            deliveredAnywhere=bool(cohorts),
            cohorts=cohorts,
            packages=sum(len(f.get('packages') or []) for f in folders),
            gateEra=era,
            gateEraSource=era_source,
        ))

    scope = [t for t in out if t['inScope']]
    states = collections.Counter(t['finalState'] for t in scope)
    print(f'{len(out):,} identities -> {len(scope):,} in scope (decision >= {CUT})\n')
    print('in-scope state:')
    for s, n in states.most_common():
        print(f'  {n:>6,}  {s}')
    print('\npredicate that fired (in scope):')
    for p, n in collections.Counter(t['statePredicate'] for t in scope).most_common():
        print(f'  {n:>6,}  {p}')
    print('\ngate era of the deciding run (in scope):')
    for e, n in collections.Counter(t['gateEra'] for t in scope).most_common():
        print(f'  {n:>6,}  {e}')
    carried = [t for t in scope if t['carriedOver']]
    print(f'\ncarried over (first decided before the cut, settled after): {len(carried):,}')
    print(f'  of those still at the current bar : {sum(1 for t in carried if t["atCurrentBar"]):,}')
    print(f'delivery join: {dict(joins)}')

    Path(args.out).write_text(json.dumps({
        'generatedAt': datetime.now(timezone.utc).isoformat(timespec='seconds'),
        'step': '5-state',
        'cut': CUT, 'currentBar': CURRENT_BAR, 'graceMinutes': GRACE.total_seconds() / 60,
        'sources': {'canonical': canon['generatedAt'], 'delivery': deliv['generatedAt']},
        'coverage': {
            'identities': len(out), 'inScope': len(scope),
            'inScopeStates': dict(states),
            'predicates': dict(collections.Counter(t['statePredicate'] for t in scope)),
            'gateEras': dict(collections.Counter(t['gateEra'] for t in scope)),
            'carriedOver': len(carried),
        },
        'tasks': out,
    }, separators=(',', ':')), encoding='utf-8')
    print(f'\nwrote {args.out} ({Path(args.out).stat().st_size/1e6:.1f} MB)')


if __name__ == '__main__':
    main()
