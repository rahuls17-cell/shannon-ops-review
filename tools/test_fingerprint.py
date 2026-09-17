"""Check that the content fingerprint actually identifies tasks.

Two halves. First, properties of the recipe itself, on constructed inputs: a
rerun must not change the fingerprint, a rename must not change it, and a real
edit must. Second, the same properties measured against the delivered corpus in
assets/task-fingerprints.json, where the headline comparison is how often a
repeat delivery of one task is recognised by its archive digest versus by its
fingerprint.

Offline: reads only local files. Run tools/build_fingerprints.py first.

    python3 tools/test_fingerprint.py
"""
import json
import sys
from collections import defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import fingerprint as F

DATA = Path('assets/task-fingerprints.json')

# A minimal package: what defines the task, plus the run evidence beside it.
BASE = [
    {'name': 'my-task/task.toml', 'size': 900, 'crc': 111},
    {'name': 'my-task/instruction.md', 'size': 2400, 'crc': 222},
    {'name': 'my-task/tests/manifest.json', 'size': 300, 'crc': 333},
    {'name': 'my-task/environment/Dockerfile', 'size': 150, 'crc': 444},
    {'name': 'my-task/solution/solve.py', 'size': 800, 'crc': 555},
    {'name': 'my-task/evaluations/difficulty/r1/verifier/reward.txt', 'size': 4, 'crc': 666},
    {'name': 'my-task/client_qc/result.json', 'size': 90, 'crc': 777},
]

failures = []


def check(label, condition):
    print('%-4s %s' % ('ok' if condition else 'FAIL', label))
    if not condition:
        failures.append(label)


def rename(members, root):
    return [{**m, 'name': root + '/' + F.strip_root(m['name'])} for m in members]


def properties():
    print('--- recipe properties ---')
    base = F.fingerprint(BASE)
    check('a package fingerprints to something', bool(base))

    # A rerun regenerates evaluations and QC artifacts and nothing else.
    rerun = [m if not F.strip_root(m['name']).startswith(('evaluations/', 'client_qc/'))
             else {**m, 'crc': m['crc'] + 1, 'size': m['size'] + 10} for m in BASE]
    check('a rerun does not change the fingerprint', F.fingerprint(rerun) == base)

    check('a rename does not change the fingerprint',
          F.fingerprint(rename(BASE, 'my-task-v2')) == base)

    edited = [m if F.strip_root(m['name']) != 'instruction.md' else {**m, 'crc': 999}
              for m in BASE]
    check('editing the instructions changes it', F.fingerprint(edited) != base)

    retested = [m if F.strip_root(m['name']) != 'tests/manifest.json' else {**m, 'crc': 888}
                for m in BASE]
    check('editing the tests changes it', F.fingerprint(retested) != base)

    added = BASE + [{'name': 'my-task/tests/extra_check.py', 'size': 40, 'crc': 1234}]
    check('adding a test changes it', F.fingerprint(added) != base)

    noise = BASE + [{'name': 'my-task/evaluations/r2/reward.txt', 'size': 4, 'crc': 4321},
                    {'name': 'my-task/.DS_Store', 'size': 6148, 'crc': 5678}]
    check('adding run evidence and OS junk does not', F.fingerprint(noise) == base)

    check('an unreadable package has no fingerprint', F.fingerprint([]) is None)


def corpus():
    print('\n--- delivered corpus ---')
    if not DATA.exists():
        print('SKIP %s missing; run tools/build_fingerprints.py first' % DATA)
        return
    rows = json.loads(DATA.read_text(encoding='utf-8'))['tasks']
    print('archives: %d' % len(rows))

    usable = [r for r in rows if r['fingerprint']]
    check('every archive produced a fingerprint', len(usable) == len(rows))

    # Repeat deliveries of one task: same folder name, more than one archive.
    by_task = defaultdict(list)
    for row in usable:
        by_task[row['folder']].append(row)
    repeats = {name: rows_ for name, rows_ in by_task.items() if len(rows_) > 1}

    digest_pairs = fingerprint_pairs = pairs = 0
    for rows_ in repeats.values():
        for i in range(len(rows_)):
            for j in range(i + 1, len(rows_)):
                pairs += 1
                digest_pairs += rows_[i]['sha256'] == rows_[j]['sha256']
                fingerprint_pairs += rows_[i]['fingerprint'] == rows_[j]['fingerprint']

    print('tasks delivered more than once : %d' % len(repeats))
    print('pairs of repeat deliveries     : %d' % pairs)
    if pairs:
        print('  recognised by archive digest : %d  (%.1f%%)'
              % (digest_pairs, 100.0 * digest_pairs / pairs))
        print('  recognised by fingerprint    : %d  (%.1f%%)'
              % (fingerprint_pairs, 100.0 * fingerprint_pairs / pairs))
        check('the fingerprint recognises more repeats than the archive digest',
              fingerprint_pairs > digest_pairs)

    identities = {r['fingerprint'] for r in usable}
    print('\ndistinct identities            : %d from %d archives' % (len(identities), len(usable)))
    collapsed = len(usable) - len(identities)
    print('archives folded into a sibling : %d' % collapsed)
    check('fingerprinting collapses duplicate archives', collapsed > 0)

    # A fingerprint spanning unrelated task names would mean over-merging.
    names_per = defaultdict(set)
    for row in usable:
        names_per[row['fingerprint']].add(row['folder'])
    spanning = {f: names for f, names in names_per.items() if len(names) > 1}
    print('identities spanning >1 folder  : %d' % len(spanning))
    for f, names in list(spanning.items())[:5]:
        print('   %s  %s' % (f[:12], ', '.join(sorted(names)[:3])[:88]))


def main():
    properties()
    corpus()
    print('')
    if failures:
        print('FAIL: %d check(s) failed' % len(failures))
        for label in failures:
            print('  - %s' % label)
        return 1
    print('PASS: fingerprint identity holds')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
