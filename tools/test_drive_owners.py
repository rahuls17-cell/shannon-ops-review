#!/usr/bin/env python3
"""Which trainer a Drive package gets from the bucket, and when it gets none.

The page is public and a name on a row reads as authorship, so a wrong name is
worse than no name. These pin the three routes in their order, the rule that a
weaker route never overrides a stronger one, the refusal to pick between
several people, and that accounts which are not people are never a trainer.
"""
import json
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).parent))
from build_drive_owners import attribute, build, indexes, person  # noqa: E402

failures = []


def check(condition, message):
    if not condition:
        failures.append(message)


H = 'a' * 64
scan = {
    'generatedAt': 't',
    'finalisation': {'tasks': [
        {'sha256': H, 'folder': 'pkg-one', 'owner': 'one@turing.com', 'ownerContested': False},
        {'sha256': 'b' * 64, 'folder': 'pkg-contested', 'owner': None, 'ownerContested': True},
    ]},
    'trainerRecords': [
        {'task': 'pkg-one', 'trainer': 'records@turing.com'},
        {'task': 'shared', 'trainer': 'x@turing.com'}, {'task': 'shared', 'trainer': 'y@turing.com'},
        {'task': 'harbor/declared-name', 'trainer': 'declared@turing.com'},
        {'task': 'bot-only', 'trainer': 'task-mining-operator@delivery-g-obi.iam.gserviceaccount.com'},
    ],
}
truth = {'tasks': [
    {'name': 'verdict-only', 'owner': 'verdict@turing.com'},
    {'name': 'shared', 'owner': 'z@turing.com'},
    {'name': 'bot-only', 'owner': 'companybench@turing.com'},
]}
ix = indexes(scan, truth)

check(attribute({'task': 'pkg-one', 'sourceObject': H}, *ix) == ('object', ['one@turing.com']),
      'the exact source archive decides first, over trainer records')
check(attribute({'task': 'pkg-one'}, *ix) == ('records', ['records@turing.com']),
      'without a source object, trainer records by name')
check(attribute({'task': 'renamed', 'declaredName': 'declared-name'}, *ix) == ('records', ['declared@turing.com']),
      'the task.toml declared name is matched too, without its harbor/ prefix')
check(attribute({'task': 'shared'}, *ix) == ('records', ['x@turing.com', 'y@turing.com']),
      'several people in the records are all kept, and verdicts do not add a third')
check(attribute({'task': 'verdict-only'}, *ix) == ('verdict', ['verdict@turing.com']),
      'verdict owner is the last route')
check(attribute({'task': 'pkg-contested', 'sourceObject': 'b' * 64}, *ix) == (None, []),
      'a contested folder names nobody by itself')
check(attribute({'task': 'bot-only'}, *ix) == (None, []), 'service accounts and shared logins are not trainers')
for who in ('harbor-autostart@delivery-g-obi.iam.gserviceaccount.com', 'companybench@turing.com',
            'dev@localhost', 'harbor-operator-e2e@turing.com', 'Unattributed', ''):
    check(not person(who), f'{who!r} is not a person')

drive = {'rows': [{'id': 'B51-001', 'batch': 'Batch 5.1', 'task': 'pkg-one', 'sourceObject': H},
                  {'id': 'B51-002', 'batch': 'Batch 5.1', 'task': 'shared'},
                  {'id': 'B51-003', 'batch': 'Batch 5.1', 'task': 'nobody'}]}
out = build(drive, scan, truth)
check(out['owners']['B51-001'] == {'trainer': 'one@turing.com', 'source': 'GCS package owner', 'route': 'object'},
      'an attributed row says which route named it')
check(out['owners']['B51-002']['trainer'] is None and out['owners']['B51-002']['source'] == 'Contested'
      and out['owners']['B51-002']['candidates'] == ['x@turing.com', 'y@turing.com'],
      'a contested row names no trainer and lists the candidates')
check('B51-003' not in out['owners'], 'a row nothing names is left out, so it stays Unattributed')
check(out['counts']['attributed'] == 1 and out['counts']['contested'] == 1 and out['counts']['unattributed'] == 1,
      f'counts partition the rows: {out["counts"]}')

# --- the published index ----------------------------------------------------
assets = pathlib.Path(__file__).resolve().parent.parent / 'assets'
if (assets / 'drive-owners.json').exists() and (assets / 'drive-deliveries.json').exists():
    owners = json.loads((assets / 'drive-owners.json').read_text(encoding='utf-8'))
    rows = json.loads((assets / 'drive-deliveries.json').read_text(encoding='utf-8'))['rows']
    ids = {r['id'] for r in rows}
    check(set(owners['owners']) <= ids, 'every owner belongs to a published Drive row')
    check(all(person(o['trainer']) for o in owners['owners'].values() if o['trainer']),
          'no published trainer is a service account or shared login')
    check(all(len(o.get('candidates', [])) > 1 for o in owners['owners'].values() if not o['trainer']),
          'a row without a trainer is only listed when it is contested')
    c = owners['counts']
    check(c.get('attributed', 0) + c.get('contested', 0) + c.get('unattributed', 0) == len(rows),
          'published counts cover every Drive row')
    print(f"published: {c.get('attributed', 0):,} attributed, {c.get('contested', 0):,} contested, "
          f"{c.get('unattributed', 0):,} unattributed of {len(rows):,}")

if failures:
    print('\n'.join(f'FAIL {f}' for f in failures))
    sys.exit(1)
print('drive owner checks passed: route order, contested, not-a-person, published index')
