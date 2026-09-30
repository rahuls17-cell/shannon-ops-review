#!/usr/bin/env python3
"""Who made each package in the Drive batches, read from the bucket.

A batch manifest names no trainer. The bucket does: the pipeline's trainer
records (trainer/records/tasks/...), the owner the VM scan gives each
finalisation folder, and the submitter on each QC verdict. This joins every
row of assets/drive-deliveries.json onto those and writes
assets/drive-owners.json; the Delivery tab lays it over the manifest rows.

It is a separate index, not part of the Drive read, for the same reason the
connector and delivered indexes are: it depends on the bucket scan, which
refreshes far more often than batches arrive, so it is rebuilt with the scan.

The order, strongest first, and why
-----------------------------------
  1. package owner  - the manifest names the exact bucket archive the package
                      was cut from, and the scan has that archive's folder with
                      an owner. One archive, one folder: nothing is guessed.
  2. trainer records - the pipeline's own record of who submitted the task,
                      matched on the package name or the name its task.toml
                      declares.
  3. verdict owner  - the submitter on a QC verdict for that task name. Weakest:
                      verdicts are also written by operators and shared
                      accounts, and task names are not unique in this bucket.

The first route that names anyone decides. When it names exactly one person
that is the trainer; when it names several, the row is contested and the
candidates are listed rather than one being picked - the same rule the audit
rows follow. A later, weaker route never overrides an earlier one.

Service accounts and shared logins are not people, so they are never a
trainer: *.gserviceaccount.com, companybench@turing.com, dev@localhost and the
harbor operator accounts.

Reads only files already in the repository; no credentials.

    python tools/build_drive_owners.py
"""
import argparse
import collections
import json
import os
import pathlib
import re
from datetime import datetime, timezone

NOT_A_PERSON = re.compile(r'gserviceaccount\.com$|^companybench@|^dev@localhost$|harbor-operator', re.I)
LABELS = {'object': 'GCS package owner', 'records': 'GCS trainer records', 'verdict': 'GCS verdict owner'}


def person(value):
    return bool(value) and '@' in str(value) and not NOT_A_PERSON.search(str(value))


def key(value):
    return re.sub(r'^(harbor|obi)/', '', str(value or '').strip().lower())


def indexes(scan, truth):
    folders = {}
    for folder in (scan.get('finalisation') or {}).get('tasks') or []:
        if folder.get('sha256'):
            folders[folder['sha256']] = folder
    records = collections.defaultdict(set)
    for record in scan.get('trainerRecords') or []:
        if person(record.get('trainer')):
            records[key(record.get('task'))].add(record['trainer'])
    verdicts = collections.defaultdict(set)
    for task in (truth or {}).get('tasks') or []:
        if person(task.get('owner')):
            verdicts[key(task.get('name'))].add(task['owner'])
    return folders, records, verdicts


def attribute(row, folders, records, verdicts):
    """(route, [people]) for one Drive row; route None when nothing names anyone."""
    folder = folders.get(row.get('sourceObject')) if row.get('sourceObject') else None
    if folder and person(folder.get('owner')) and not folder.get('ownerContested'):
        return 'object', [folder['owner']]
    names = {key(row.get('task')), key(row.get('packageName'))} - {''}
    for route, index in (('records', records), ('verdict', verdicts)):
        people = set().union(*(index.get(n, set()) for n in names))
        if people:
            return route, sorted(people)
    return None, []


def build(drive, scan, truth):
    folders, records, verdicts = indexes(scan, truth)
    owners, counts, per_batch = {}, collections.Counter(), collections.defaultdict(collections.Counter)
    for row in drive.get('rows') or []:
        route, people = attribute(row, folders, records, verdicts)
        if not route:
            state = 'unattributed'
        elif len(people) == 1:
            state = 'attributed'
            owners[row['id']] = {'trainer': people[0], 'source': LABELS[route], 'route': route}
        else:
            state = 'contested'
            owners[row['id']] = {'trainer': None, 'source': 'Contested', 'route': route,
                                 'candidates': people}
        counts[state] += 1
        counts[f'{state}:{route}'] += 1 if route else 0
        per_batch[row['batch']][state] += 1
    return {
        'generatedAt': datetime.now(timezone.utc).isoformat(timespec='seconds'),
        'driveGeneratedAt': drive.get('generatedAt'),
        'scanGeneratedAt': scan.get('generatedAt'),
        'truthGeneratedAt': (truth or {}).get('generatedAt'),
        'rule': 'package owner, then trainer records, then verdict owner; the first route '
                'naming anyone decides, and several people make the row contested',
        'counts': {k: v for k, v in counts.items() if v},
        'batches': {b: dict(c) for b, c in sorted(per_batch.items())},
        'owners': owners,
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--drive', default='assets/drive-deliveries.json')
    ap.add_argument('--scan', default='assets/gcs-pipeline.json')
    ap.add_argument('--truth', default='assets/pipeline-truth.json')
    ap.add_argument('--out', default='assets/drive-owners.json')
    args = ap.parse_args()

    drive = json.loads(pathlib.Path(args.drive).read_text(encoding='utf-8'))
    scan = json.loads(pathlib.Path(args.scan).read_text(encoding='utf-8'))
    truth_path = pathlib.Path(args.truth)
    truth = json.loads(truth_path.read_text(encoding='utf-8')) if truth_path.exists() else None

    payload = build(drive, scan, truth)
    ids = {r['id'] for r in drive.get('rows') or []}
    assert set(payload['owners']) <= ids, 'an owner names a row that is not in the Drive asset'
    assert all(person(o['trainer']) for o in payload['owners'].values() if o['trainer']), \
        'a service account or shared login was named as a trainer'

    out = pathlib.Path(args.out)
    partial = out.with_name(out.name + '.new')
    partial.write_text(json.dumps(payload, separators=(',', ':')), encoding='utf-8')
    os.replace(partial, out)

    c = payload['counts']
    total = len(ids)
    print(f"Drive rows             : {total:>5}")
    print(f"  attributed           : {c.get('attributed', 0):>5}   "
          f"(package {c.get('attributed:object', 0)}, records {c.get('attributed:records', 0)}, "
          f"verdicts {c.get('attributed:verdict', 0)})")
    print(f"  contested            : {c.get('contested', 0):>5}")
    print(f"  unattributed         : {c.get('unattributed', 0):>5}")
    for batch, n in payload['batches'].items():
        print(f"    {batch:<16} {n}")
    print(f"wrote {out} ({out.stat().st_size/1e3:.0f} KB)")


if __name__ == '__main__':
    main()
