#!/usr/bin/env python3
"""Step 3b: family_id OR declared task name, never two trainers on a name alone.

Hand-built rows, one case per rule, so the rules hold whatever the bucket holds.
Exits non-zero on failure.
"""
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from link_identity import link  # noqa: E402

SVC = 'harbor-autostart@delivery-g-obi.iam.gserviceaccount.com'
failures = []


def check(label, ok, detail=''):
    print(f"{'ok  ' if ok else 'FAIL'} {label}" + (f'  ({detail})' if detail and not ok else ''))
    if not ok:
        failures.append(label)


def row(identity, submission, owner):
    return {'identity': identity, 'submission': submission, 'owner': owner}


names = {
    # ann resubmitted alpha under a fresh family: one task
    's-a1': {'name': 'obi/alpha-task', 'instruction': 'T-alpha-1'},
    's-a2': {'name': 'obi/alpha-task', 'instruction': 'T-alpha-2'},
    # ann and bob both declare beta, different texts: two people, held
    's-b1': {'name': 'obi/beta-task', 'instruction': 'T-beta-ann'},
    's-b2': {'name': 'obi/beta-task', 'instruction': 'T-beta-bob'},
    # cat handed gamma to dan: identical text in their OWN runs -> one task
    's-g1': {'name': 'harbor/gamma-task', 'instruction': 'T-gamma'},
    's-g2': {'name': 'harbor/gamma-task', 'instruction': 'T-gamma'},
    # a service account re-ran delta, which only eve declares -> joins eve
    's-d1': {'name': 'obi/delta-task', 'instruction': 'T-delta'},
    's-d2': {'name': 'obi/delta-task', 'instruction': 'T-delta-rerun'},
    # a service account holds epsilon, which fay and gus both declare with
    # different texts: it must not bridge them
    's-e1': {'name': 'obi/epsilon-task', 'instruction': 'T-eps-fay'},
    's-e2': {'name': 'obi/epsilon-task', 'instruction': 'T-eps-gus'},
    's-e3': {'name': 'obi/epsilon-task', 'instruction': 'T-eps-svc'},
    # a generic name joins nothing
    's-t1': {'name': 'task', 'instruction': 'X1'},
    's-t2': {'name': 'task', 'instruction': 'X2'},
    # no name recorded (folder pruned before it was read): untouched
}
rows = [
    row('family:alpha-111', 's-a1', 'ann@turing.com'),
    row('family:alpha-111', 's-a1', 'ann@turing.com'),          # a second run, same family
    row('task:alpha-222-v1', 's-a2', 'ann@turing.com'),
    row('family:beta-1', 's-b1', 'ann@turing.com'),
    row('family:beta-2', 's-b2', 'bob@turing.com'),
    row('family:gamma-1', 's-g1', 'cat@turing.com'),
    row('family:gamma-2', 's-g2', 'dan@turing.com'),
    row('family:delta-1', 's-d1', 'eve@turing.com'),
    row('task:delta-svc', 's-d2', SVC),
    row('family:eps-fay', 's-e1', 'fay@turing.com'),
    row('family:eps-gus', 's-e2', 'gus@turing.com'),
    row('task:eps-svc', 's-e3', SVC),
    row('family:t-1', 's-t1', 'hal@turing.com'),
    row('family:t-2', 's-t2', 'hal@turing.com'),
    row('family:pruned', 's-gone', 'ivy@turing.com'),
]
new_id, held, unattached, joined = link(rows, names)
same = lambda a, b: new_id[a] == new_id[b]                                   # noqa: E731

check("one person's resubmission under a fresh family is one task", same('family:alpha-111', 'task:alpha-222-v1'))
check('and the joined task keeps an existing id - the family with most runs',
      new_id['task:alpha-222-v1'] == 'family:alpha-111', new_id['task:alpha-222-v1'])
check('two trainers sharing a name, with different texts, stay apart', not same('family:beta-1', 'family:beta-2'))
check('and they are listed for review', any(h['declaredName'] == 'beta-task' for h in held))
check('two trainers with identical text in their own runs are one task', same('family:gamma-1', 'family:gamma-2'))
check("a service account's re-run joins the one person with that name", same('family:delta-1', 'task:delta-svc'))
check('a service account never bridges two trainers',
      not same('family:eps-fay', 'family:eps-gus'), f"{new_id['family:eps-fay']} / {new_id['family:eps-gus']}")
check('and neither of them absorbs it', not same('task:eps-svc', 'family:eps-fay') and not same('task:eps-svc', 'family:eps-gus'))
check('the ambiguous one is listed for review', any(u['declaredName'] == 'epsilon-task' for u in unattached))
check('a generic name joins nothing', not same('family:t-1', 'family:t-2'))
check('a row with no recorded name is untouched', new_id['family:pruned'] == 'family:pruned')
check('declared names are carried on the rows',
      [r['declaredName'] for r in rows if r['submission'] == 's-g1'] == ['harbor/gamma-task'])
check('the count of joined groups is exact (alpha, gamma, delta)', joined == 3, str(joined))

if failures:
    print(f'\n{len(failures)} failed')
    sys.exit(1)
print('\nall link_identity rules hold')
