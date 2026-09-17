"""Duplicate-collapse test, on timestamp and trainer only.

The pipeline treats two console rows as the same task when their normalised name
matches, and shows the latest submission. This checks that rule using the full
`submitted_at` timestamp (the earlier pull truncated it to a date, which made the
winner arbitrary whenever a task was submitted twice in one day) and reports who
submitted each one.

No scores here: Harbor has no difficulty score, and qc_score grades quality on
about 1% of rows, so neither belongs in a duplicate test.

Usage: python tools/test_duplicate_sample.py [--seed N] [--sample N] [--live-only]
"""
import argparse
import collections
import datetime as dt
import json
import pathlib
import random
import statistics
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
LEGACY_BEFORE = '2026-09-05'


def name_key(value):
    v = str(value or '').strip().lower()
    for prefix in ('harbor/', 'obi/'):
        if v.startswith(prefix):
            v = v[len(prefix):]
    return v


def when(value):
    try:
        return dt.datetime.fromisoformat(str(value))
    except ValueError:
        return None


def gap_hours(first, last):
    a, b = when(first), when(last)
    return round((b - a).total_seconds() / 3600, 2) if a and b else None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--seed', type=int, default=20260916)
    ap.add_argument('--sample', type=int, default=100)
    ap.add_argument('--live-only', action='store_true',
                    help='restrict to tasks last submitted on/after 5 Sept')
    args = ap.parse_args()

    path = ROOT / 'assets' / 'harbor-console-rich.json'
    if not path.exists():
        sys.exit(f'missing {path} - run the rich console pull first')
    payload = json.loads(path.read_text(encoding='utf-8'))
    rows = payload['rows']
    failures = []

    # Precondition: without a time component, ordering inside a day is arbitrary.
    dateless = [r for r in rows if 'T' not in str(r['submittedAt'])]
    if dateless:
        failures.append(f'{len(dateless)} rows carry a date with no time')

    groups = collections.defaultdict(list)
    for r in rows:
        groups[name_key(r['name'])].append(r)
    for g in groups.values():
        g.sort(key=lambda r: str(r['submittedAt']))

    dupes = {k: v for k, v in groups.items() if len(v) > 1}
    if args.live_only:
        dupes = {k: v for k, v in dupes.items()
                 if str(v[-1]['submittedAt'])[:10] >= LEGACY_BEFORE}

    print(f'pull {payload["pulledAt"]}')
    print(f'{len(rows):,} submissions -> {len(groups):,} task keys -> '
          f'{len(dupes):,} keys with duplicates'
          + (' (live only)' if args.live_only else ''))

    # T1 - with a full timestamp, is "latest wins" still ambiguous?
    ties, tie_disagree = [], []
    for k, v in dupes.items():
        top = v[-1]['submittedAt']
        same = [r for r in v if r['submittedAt'] == top]
        if len(same) > 1:
            ties.append(k)
            if len({r['state'] for r in same}) > 1:
                tie_disagree.append(k)
    print(f'\nT1 ordering   : {len(ties)} groups tie on the exact latest timestamp, '
          f'{len(tie_disagree)} of those disagree on state')
    if tie_disagree:
        failures.append(f'{len(tie_disagree)} groups still resolve arbitrarily')

    # T2 - same-day duplicates: the population the old date-only pull could not order.
    same_day = [k for k, v in dupes.items()
                if len({str(r['submittedAt'])[:10] for r in v}) < len(v)]
    print(f'T2 same day   : {len(same_day)} groups have two or more submissions on one '
          f'calendar day (these were unorderable before the timestamp fix)')

    # T3 - trainer consistency across a duplicate group.
    contested = [k for k, v in dupes.items()
                 if len({r['trainer'] for r in v if '@' in r['trainer']}) > 1]
    print(f'T3 attribution: {len(contested)} groups name more than one trainer')

    # T4 - resubmission by someone other than the original submitter.
    handover = []
    for k in contested:
        v = dupes[k]
        named = [r for r in v if '@' in r['trainer']]
        if named and named[0]['trainer'] != named[-1]['trainer']:
            handover.append(k)
    print(f'T4 handover   : {len(handover)} groups where the last submitter differs '
          f'from the first')

    # ---- sample -----------------------------------------------------------
    rng = random.Random(args.seed)
    picked = rng.sample(sorted(dupes), min(args.sample, len(dupes)))

    report, by_trainer = [], collections.defaultdict(list)
    for k in picked:
        g = dupes[k]
        first, last = g[0], g[-1]
        trainers = sorted({r['trainer'] for r in g if '@' in r['trainer']})
        who = last['trainer'] or '(unattributed)'
        entry = {
            'task': k,
            'trainer': who,
            'trainers_in_group': trainers,
            'contested': len(trainers) > 1,
            'submissions': len(g),
            'first_submitted': first['submittedAt'],
            'last_submitted': last['submittedAt'],
            'span_hours': gap_hours(first['submittedAt'], last['submittedAt']),
            'same_day_repeats': len(g) - len({str(r['submittedAt'])[:10] for r in g}),
            'final_state': last['state'],
            'states_seen': sorted({r['state'] for r in g}),
            'timeline': [{'at': r['submittedAt'], 'by': r['trainer'] or '(none)',
                          'state': r['state']} for r in g],
        }
        report.append(entry)
        by_trainer[who].append(entry)

    for e in report:
        assert e['submissions'] > 1, 'sampled a non-duplicate'
        assert e['first_submitted'] <= e['last_submitted'], 'timeline out of order'

    print(f'\n--- sample of {len(report)} duplicate groups (seed {args.seed}) across '
          f'{len(by_trainer)} trainers ---')
    subs = [e['submissions'] for e in report]
    spans = [e['span_hours'] for e in report if e['span_hours'] is not None]
    print(f'submissions per task : min {min(subs)} / median '
          f'{statistics.median(subs):.0f} / mean {statistics.mean(subs):.1f} / max {max(subs)}')
    print(f'first-to-last span   : median {statistics.median(spans):.1f}h / '
          f'max {max(spans):.1f}h')
    print(f'contested trainer    : {sum(1 for e in report if e["contested"])} / '
          f'unattributed {sum(1 for e in report if e["trainer"] == "(unattributed)")}')
    print(f'same-day repeats     : {sum(1 for e in report if e["same_day_repeats"])} tasks')

    print('\ntrainers by resubmission load in the sample:')
    for who, entries in sorted(by_trainer.items(),
                               key=lambda kv: (-sum(e['submissions'] for e in kv[1]), kv[0]))[:15]:
        tot = sum(e['submissions'] for e in entries)
        worst = max(entries, key=lambda e: e['submissions'])
        print(f'  {who:<32} {len(entries):>2} task(s) / {tot:>3} submissions / '
              f'worst {worst["submissions"]}x over {worst["span_hours"]}h  '
              f'{worst["task"][:38]}')

    out = ROOT / 'assets' / 'duplicate-sample.json'
    out.write_text(json.dumps({
        'pulledAt': payload['pulledAt'],
        'seed': args.seed,
        'liveOnly': args.live_only,
        'basis': 'normalised task name; ordered by full submitted_at timestamp',
        'population': {'submissions': len(rows), 'taskKeys': len(groups),
                       'duplicateKeys': len(dupes)},
        'checks': {'ties': len(ties), 'tieDisagreements': len(tie_disagree),
                   'sameDayGroups': len(same_day), 'contestedTrainer': len(contested),
                   'handover': len(handover)},
        'sample': report,
    }, indent=2), encoding='utf-8')
    print(f'\nwrote {out}')

    if failures:
        print('\nFAILURES:')
        for f in failures:
            print('  -', f)
        sys.exit(1)
    print('\nall checks passed')


if __name__ == '__main__':
    main()
