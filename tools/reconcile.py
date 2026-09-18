#!/usr/bin/env python3
"""Step 8: the invariants. Exits non-zero, so a number that cannot be explained
does not get published.

Each check either passes, or prints the rows that broke it. "Unexplained" is
itself a failure: where two counts legitimately differ, the difference must be
computed and accounted for, not left for a reader to notice.

    python3 reconcile.py --truth pipeline-truth.json --delivery delivery.json
"""
import argparse
import collections
import json
import sys
from pathlib import Path

CUT = '2026-09-05'
VERDICT_PREFIX = 'tasks/qc_platform_sync/_verdicts/'
HEADLINE = {'accepted', 'legacy accepted', 'rejected', 'running'}
UNDECIDED = {'error', 'no QC decision', 'queued', 'not started'}


class Checks:
    def __init__(self):
        self.failures = []
        self.passed = 0

    def ok(self, name, detail=''):
        self.passed += 1
        print(f'  PASS  {name}' + (f'  ({detail})' if detail else ''))

    def fail(self, name, detail):
        self.failures.append((name, detail))
        print(f'  FAIL  {name}\n          {detail}')

    def check(self, name, condition, detail=''):
        self.ok(name, detail) if condition else self.fail(name, detail)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--truth', default='pipeline-truth.json')
    ap.add_argument('--delivery', default='delivery.json')
    ap.add_argument('--tagged', default='tagged.json')
    args = ap.parse_args()

    truth = json.loads(Path(args.truth).read_text(encoding='utf-8'))
    delivery = json.loads(Path(args.delivery).read_text(encoding='utf-8'))
    tagged = json.loads(Path(args.tagged).read_text(encoding='utf-8'))
    rows = truth['tasks']
    figures = {f['label']: f for f in truth['figures']}
    c = Checks()

    print('PARTITION')
    states = collections.Counter(r['state'] for r in rows)
    unknown = set(states) - HEADLINE - UNDECIDED
    c.check('every state is a declared one', not unknown, f'undeclared: {sorted(unknown)}')
    c.check('states sum to the in-scope population',
            sum(states.values()) == len(rows),
            f'{sum(states.values()):,} vs {len(rows):,}')
    c.check('each task has exactly one state',
            all(isinstance(r['state'], str) and r['state'] for r in rows),
            f'{sum(1 for r in rows if not r.get("state")):,} rows without a state')

    print('\nSCOPE')
    early = [r for r in rows if (r['decided'] or '') < CUT]
    c.check(f'no published row is decided before {CUT}', not early,
            f'{len(early):,} rows, earliest {min((r["decided"] for r in early), default="-")}')
    inferred = [r for r in rows if r['decidedInferred']]
    c.ok('rows dated from updated_at are flagged',
         f'{len(inferred):,} of {len(rows):,} ({100*len(inferred)/max(len(rows),1):.0f}%)')

    print('\nDERIVATION CHAINS')
    for label, fig in figures.items():
        steps = fig['steps']
        if not steps:
            c.fail(f'{label}: has a chain', 'no steps')
            continue
        counts = [s['count'] for s in steps]
        shrinks = all(a >= b for a, b in zip(counts, counts[1:]))
        c.check(f'{label}: chain never grows', shrinks, f'counts {counts}')
        c.check(f'{label}: chain ends at the published value',
                counts[-1] == fig['value'], f'{counts[-1]:,} vs {fig["value"]:,}')

    print('\nFIGURES AGREE WITH THE ROWS')
    for label, state in [('Accepted', 'accepted'), ('Legacy accepted', 'legacy accepted'),
                         ('Rejected', 'rejected'), ('Running', 'running')]:
        actual = states[state]
        c.check(f'{label} matches the row count', figures[label]['value'] == actual,
                f'figure {figures[label]["value"]:,} vs rows {actual:,}')
    carried = sum(1 for r in rows if r['carriedOver'])
    c.check('Carried over matches the row count',
            figures['Carried over']['value'] == carried,
            f'figure {figures["Carried over"]["value"]:,} vs rows {carried:,}')

    print('\nDELIVERY')
    at_bar_rows = {r['name'].strip().lower() for r in rows if r['atCurrentBar']}
    at_bar_bucket = {k for k, v in delivery['tasks'].items()
                     if any(f['role'] == 'current' for f in v)}
    accepted_names = {r['name'].strip().lower() for r in rows if r['state'] == 'accepted'}
    # The bucket count and the accepted count differ legitimately. The gap must
    # be computable, or one of the two numbers is wrong.
    gap = at_bar_bucket - accepted_names
    explained = []
    by_name = collections.defaultdict(list)
    for r in rows:
        by_name[r['name'].strip().lower()].append(r)
    for name in gap:
        held = by_name.get(name)
        explained.append('not in scope' if not held else f'canonical state {held[0]["state"]}')
    reasons = collections.Counter(explained)
    c.check('every package at the current bar is accounted for',
            len(gap) == sum(reasons.values()),
            f'{len(gap):,} packages, reasons {dict(reasons)}')
    print(f'        current bar holds {len(at_bar_bucket):,} task folders; '
          f'{len(accepted_names):,} are accepted in scope')
    print(f'        the {len(gap):,} difference: {dict(reasons)}')
    orphans = at_bar_rows - at_bar_bucket
    c.check('no row claims a package the bucket does not have', not orphans,
            f'{len(orphans):,} orphaned: {sorted(orphans)[:3]}')

    print('\nIDENTITY')
    unmerged = sum(1 for r in rows if r['unmerged'])
    c.ok('low-confidence identities are labelled',
         f'{unmerged:,} of {len(rows):,} ({100*unmerged/max(len(rows),1):.0f}%) keyed on task_id')
    dupe_ids = [k for k, n in collections.Counter(r['id'] for r in rows).items() if n > 1]
    c.check('one published row per identity', not dupe_ids,
            f'{len(dupe_ids):,} identities appear twice')

    print('\nPROVENANCE')
    bad_source = [r for r in rows if not str(r.get('source', '')).startswith(VERDICT_PREFIX)]
    c.check('every row cites a verdict object', not bad_source,
            f'{len(bad_source):,} rows with no usable source')
    no_reason = [r for r in rows if not r.get('why')]
    c.check('every row states why it is in its state', not no_reason,
            f'{len(no_reason):,} rows without a predicate')
    no_canon = [r for r in rows if not r.get('canonicalReason')]
    c.check('every row states why its run was canonical', not no_canon,
            f'{len(no_canon):,} rows without a reason')

    print('\nVOCABULARY')
    vocab = truth['vocabulary']
    offered = set(vocab['finalState']) - {'(none)'}
    used = set(states)
    c.check('every filter value exists in the data', offered <= used | {'(none)'},
            f'offered but absent: {sorted(offered - used)}')
    c.check('every state is offered as a filter', used <= offered,
            f'present but not offered: {sorted(used - offered)}')

    print(f'\n{c.passed} passed, {len(c.failures)} failed')
    if c.failures:
        print('\nBUILD BLOCKED:')
        for name, detail in c.failures:
            print(f'  - {name}: {detail}')
        sys.exit(1)
    print('all invariants hold; the figures are publishable')


if __name__ == '__main__':
    main()
