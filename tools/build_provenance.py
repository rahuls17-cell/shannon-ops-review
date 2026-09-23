#!/usr/bin/env python3
"""Step 7: emit every headline figure with the chain that produced it.

No number ships without one. A figure is not a value, it is a value plus the
ordered list of predicates that narrowed the population down to it, each with
the count that survived. The dashboard renders the chain as a drill-down, so a
reader can follow any figure back to GCS object paths without asking anyone.

The chains are COMPUTED, not written down. Each step is a predicate applied to
the real rows and counted, so a chain cannot drift away from the number it
claims to explain - if the code changes, the chain changes with it.

Also trims the published payload: the working files carry every field for every
identity, which the browser does not need.

    python3 build_provenance.py --tagged tagged.json --delivery delivery.json
"""
import argparse
import collections
import json
from datetime import datetime, timezone
from pathlib import Path

CUT = '2026-09-05'
VERDICT_PREFIX = 'gs://obi-harbor-pipeline/tasks/qc_platform_sync/_verdicts/'
CURRENT_BAR = 'gs://obi-harbor-pipeline/tasks/finalisation_client_qc_accepted_iteration_2/'


def chain(rows, steps):
    """Apply predicates cumulatively, recording what survived each one."""
    out, population = [], rows
    for label, predicate, source in steps:
        population = [r for r in population if predicate(r)] if predicate else population
        out.append({'step': label, 'count': len(population), 'source': source})
    return out, population


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--tagged', default='tagged.json')
    ap.add_argument('--delivery', default='delivery.json')
    ap.add_argument('--verdicts', default='verdicts.json')
    ap.add_argument('--identities', default='identities.json')
    ap.add_argument('--out', default='pipeline-truth.json')
    args = ap.parse_args()

    tagged = json.loads(Path(args.tagged).read_text(encoding='utf-8'))
    delivery = json.loads(Path(args.delivery).read_text(encoding='utf-8'))
    verdicts = json.loads(Path(args.verdicts).read_text(encoding='utf-8'))
    identities = json.loads(Path(args.identities).read_text(encoding='utf-8'))
    rows = tagged['tasks']

    # The two steps before identity happen upstream, so their counts are read
    # from those runs rather than recomputed here. Named so the chain is honest
    # about where each number came from.
    prelude = [
        {'step': f'verdict objects read from {VERDICT_PREFIX}',
         'count': verdicts['coverage']['objectsRead'], 'source': 'step 1'},
        {'step': 'rows, one per submission x task',
         'count': verdicts['coverage']['rows'], 'source': 'step 1'},
        {'step': 'grouped into identities (family_id, then task_id)',
         'count': identities['coverage']['identities'], 'source': 'step 3'},
    ] + ([
        {'step': 'joined where they declare the same task name (never two trainers on a name alone)',
         'count': identities['linkCounts']['after'], 'source': 'step 3b'},
    ] if identities.get('linkCounts') else []) + [
        {'step': 'one canonical run per identity: max(progress, outcome, decided_at)',
         'count': len(rows), 'source': 'step 4'},
    ]

    # Residual duplication: flagged, never merged.
    #
    # Keyed on task name + owner, NOT on identity confidence. An earlier version
    # only flagged task_id-keyed rows, on the reasoning that family_id is a
    # reliable key. It is clean - no family in this data spans two trainers -
    # but it is not complete: a task can acquire a fresh family_id on
    # resubmission, so three runs of one task by one person can hold three
    # families and be counted three times. That version missed 566 of the 896
    # identities involved, most of them family-keyed.
    #
    # Two tiers, because they warrant different confidence:
    #   possible - same task name and owner, more than one identity
    #   likely   - and the same decision day and the same outcome as well
    # Still never merged: a task name can legitimately cover unrelated work.
    by_owner = collections.defaultdict(list)
    for row in [r for r in rows if r['inScope']]:
        by_owner[((row['name'] or '').strip().lower(), row['owner'])].append(row)
    duplicates = {}
    for (name, owner), group in by_owner.items():
        if len(group) < 2:
            continue
        same_day = len({r['decidedDay'] for r in group}) == 1
        same_state = len({r['finalState'] for r in group}) == 1
        tier = 'likely' if (same_day and same_state) else 'possible'
        for row in group:
            duplicates[row['identity']] = {
                'siblings': len(group) - 1, 'tier': tier, 'name': name,
                'sameOwner': True, 'sameDay': same_day, 'sameState': same_state,
                'allFamilyKeyed': all(r['identityConfidence'] == 'high' for r in group),
            }
    for row in rows:
        row['possibleDuplicate'] = row['identity'] in duplicates
        row['duplicateOf'] = duplicates.get(row['identity'])

    in_scope = ('decision on or after ' + CUT, lambda r: r['inScope'], 'step 5')
    figures = []

    def figure(label, steps, note=None):
        body, survivors = chain(rows, steps)
        figures.append({'label': label, 'value': body[-1]['count'],
                        'steps': prelude + body, 'note': note})
        return survivors

    figure('Accepted', [
        in_scope,
        ('canonical decision is accepted', lambda r: r['everAccepted'], 'step 4'),
        ('package is in the current bar today', lambda r: r['finalState'] == 'accepted', 'step 5'),
    ], note='Collectable at the current bar right now. A fresh acceptance counts '
            'during a 30 minute grace window, because the Package stage runs after '
            'the verdict.')

    figure('Legacy accepted', [
        in_scope,
        ('canonical decision is accepted', lambda r: r['everAccepted'], 'step 4'),
        ('no package at the current bar', lambda r: r['finalState'] == 'legacy accepted', 'step 5'),
    ], note='Accepted, but the package is not at the current bar. Almost all of '
            'these are the GLM-5.2 gate-only withdrawal awaiting a KESTREL re-gate.')

    figure('Rejected', [
        in_scope,
        ('reached a QC decision and failed it', lambda r: r['finalState'] == 'rejected', 'step 5'),
    ])

    figure('No QC decision', [
        in_scope,
        ('verdict reports a submission state only',
         lambda r: r['finalState'] in ('error', 'no QC decision'), 'step 5'),
    ], note='Parked, crashed or never decided. Counting these as either accepted '
            'or rejected would be a fabrication, so they are their own bucket.')

    figure('Running', [
        in_scope,
        ('in a stage, no decision yet', lambda r: r['finalState'] == 'running', 'step 5'),
    ])

    figure('Carried over', [
        in_scope,
        ('first decided before the cut', lambda r: r['carriedOver'], 'step 5'),
    ], note='Old work cleared by the pipeline running today. Counted inside the '
            'in-scope figures above, not in addition to them.')

    figure('Awaiting KESTREL re-gate', [
        in_scope,
        ('in the GLM-5.2 gate-only folder', lambda r: r['gateOnly'], 'step 2'),
    ], note='Acceptance withdrawn on 2026-09-16 pending re-gate under KESTREL.')

    figure('Possible duplicates', [
        in_scope,
        ('same task name and owner as another task in scope',
         lambda r: r.get('possibleDuplicate'), 'step 7'),
    ], note='Flagged, not merged: one task counted more than once. Most of these '
            'carry a family id - it is clean but not complete, because a task can '
            'be given a fresh family on resubmission. A task name can also '
            'legitimately cover unrelated work, so these are shown for review '
            'rather than combined.')

    # Delivery is a fact about the bucket, independent of any verdict, so its
    # chain does not run through the verdict prelude.
    figures.append({
        'label': 'Packages at the current bar',
        'value': delivery['summary']['atCurrentBar'],
        'steps': [
            {'step': f'task folders under {CURRENT_BAR}',
             'count': delivery['summary']['atCurrentBar'], 'source': 'step 2'},
        ],
        'note': 'Counted straight from the bucket, not from any verdict. This is '
                'what a gsutil listing of that folder returns, minus sentinel files.',
    })

    scope = [r for r in rows if r['inScope']]
    states = collections.Counter(r['finalState'] for r in scope)


    # The population must be partitioned: every in-scope task lands in exactly
    # one state, and the states must sum back to the whole.
    headline = {'Accepted': 'accepted', 'Legacy accepted': 'legacy accepted',
                'Rejected': 'rejected', 'Running': 'running'}
    covered = sum(states[v] for v in headline.values())
    undecided = states['error'] + states['no QC decision'] + states['queued']
    reconciles = covered + undecided == len(scope)

    print(f'{len(rows):,} identities / {len(scope):,} in scope\n')
    for f in figures:
        print(f'{f["value"]:>7,}  {f["label"]}')
    dupes = [r for r in scope if r['possibleDuplicate']]
    print(f'possible duplicates: {len(dupes):,} rows across '
          f'{len({d["duplicateOf"]["name"] for d in dupes}):,} names  '
          f'(likely {sum(1 for d in dupes if d["duplicateOf"]["tier"] == "likely"):,} / '
          f'possible {sum(1 for d in dupes if d["duplicateOf"]["tier"] == "possible"):,}; '
          f'{sum(1 for d in dupes if d["duplicateOf"]["allFamilyKeyed"]):,} all family-keyed)')
    print(f'\npartition check: {covered:,} headline + {undecided:,} undecided '
          f'= {covered + undecided:,} of {len(scope):,}  -> {"OK" if reconciles else "MISMATCH"}')

    published = [{
        'id': r['identity'], 'name': r['name'], 'declaredName': r.get('declaredName') or '',
        'state': r['finalState'],
        'why': r['statePredicate'], 'owner': r['owner'], 'decided': r['decidedDay'],
        'decidedInferred': r['decidedAtInferred'], 'runs': r['runs'],
        'carriedOver': r['carriedOver'], 'atCurrentBar': r['atCurrentBar'],
        'gateOnly': r['gateOnly'], 'gateEra': r['gateEra'], 'domain': r['domain'],
        'connector': r['isConnector'], 'findings': r['findingFamilies'],
        'findingsAllRuns': r['findingFamiliesAllRuns'],
        'findingsPrior': r['findingFamiliesPrior'],
        'cohorts': r['cohortLabels'], 'confidence': r['identityConfidence'],
        'unmerged': r['unmerged'], 'canonicalReason': r['canonicalReason'],
        'possibleDuplicate': r['possibleDuplicate'],
        'duplicateSiblings': (r['duplicateOf'] or {}).get('siblings', 0),
        'duplicateTier': (r['duplicateOf'] or {}).get('tier', ''),
        'duplicateSameDay': (r['duplicateOf'] or {}).get('sameDay', False),
        'duplicateSameState': (r['duplicateOf'] or {}).get('sameState', False),
        'source': r['canonicalSource'],
    } for r in scope]

    out = {
        'generatedAt': datetime.now(timezone.utc).isoformat(timespec='seconds'),
        'step': '7-provenance',
        'cut': CUT,
        'bucket': 'gs://obi-harbor-pipeline',
        'sources': {
            'verdicts': verdicts['generatedAt'],
            'delivery': delivery['generatedAt'],
            'tagged': tagged['generatedAt'],
        },
        'figures': figures,
        'vocabulary': tagged['vocabulary'],
        'reconciles': reconciles,
        'counts': {'identities': len(rows), 'inScope': len(scope),
                   'states': dict(states)},
        'tasks': published,
    }
    Path(args.out).write_text(json.dumps(out, separators=(',', ':')), encoding='utf-8')
    print(f'\nwrote {args.out} ({Path(args.out).stat().st_size/1e6:.1f} MB, '
          f'{len(published):,} published rows)')


if __name__ == '__main__':
    main()
