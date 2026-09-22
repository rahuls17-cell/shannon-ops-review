#!/usr/bin/env python3
"""Read the four delivery manifests and turn them into evidence the page can use.

What these are
--------------
assets/manifests/batch-{1,2,3,4.1}.json are the files that were actually handed
over: 60 + 60 + 60 + 232 = 412 tasks. They are the delivery record, not a
report about it.

They agree with the Delivery tab exactly - same 412 names, same batch split,
no task in one and not the other - so they do not change WHICH tasks are
delivered. What they add is evidence the audit does not carry:

  * a sha256 per package, so a delivery can be checked rather than believed;
  * the exact GCS object each package was cut from, which names the BUCKET
    FOLDER the work sits in;
  * the batch, difficulty, connector status and category that were delivered.

The folder name is the valuable part. The pipeline records a lot of tasks under
machine names - harbor-single-task-7guod6fj, task2, code-C470 - and the audit
records the human name, so a name join can never connect them. The manifest
carries both, because it was written at the moment the human name was packaged
from that folder. That is how 13 rows sitting in "ready for delivery" turn out
to be work that has already gone out.

What this refuses to do
-----------------------
Not every match is a delivery. A row named `...-audit-v2` whose family id names
a delivered task may be rework after a rejection - genuinely new work that has
to ship. Marking it delivered means it never ships at all, which is worse than
shipping something twice, so those are flagged and left in ready for a person
to decide. The split is:

  claimed  - the row's own name is a machine placeholder, or is the delivered
             name exactly. The row IS that task, recorded under another name.
  flagged  - matched only through a family id, or the name is a version of a
             delivered name. Reported, never counted.

    python tools/build_manifest_index.py
"""
import argparse
import collections
import json
import pathlib
import re
from datetime import datetime, timezone

# Kept identical to build_delivered_index.py: the two indexes describe the same
# deliveries, and a name that normalises differently between them would let one
# say delivered while the other says ready.
SUFFIX = re.compile(r'(?:-(?:final|v\d+|\d{4,}|copy|new|fixed|updated))+$')

# Names the platform generates rather than a person choosing them. A row called
# one of these carries no claim about what the work is, so when a manifest says
# that folder was packaged under a human name, the manifest is the better
# evidence and there is nothing to contradict.
PLACEHOLDER = re.compile(
    r'^(harbor-single-task-|autorun-|content-[0-9a-f]{16,}|task\d*$|task[-_]|'
    r'g\d+_|code-c\d+$|tasks?$)', re.I)

OBJECT = re.compile(r'/tasks/([^/]+)/([^/]+)/([0-9a-f]{64})\.zip$')


def key(value):
    name = str(value or '').strip().lower()
    for prefix in ('harbor/', 'obi/'):
        if name.startswith(prefix):
            name = name[len(prefix):]
    return name


def norm(value):
    name, previous = key(value), None
    while name != previous:
        previous = name
        name = SUFFIX.sub('', name)
    return name


def read_manifests(folder):
    """One flat list of delivered tasks, with the batch each came from."""
    out = []
    for path in sorted(pathlib.Path(folder).glob('batch-*.json')):
        blob = json.loads(path.read_text(encoding='utf-8'))
        batch = path.stem.replace('batch-', 'Batch ')
        for task in blob.get('tasks', []):
            match = OBJECT.search(str(task.get('source_uri') or ''))
            out.append({
                'batch': batch,
                'name': task.get('task_name'),
                'taskId': task.get('task_id'),
                'sha256': task.get('sha256'),
                'sourceUri': task.get('source_uri'),
                'prefix': match.group(1) if match else None,
                'folder': match.group(2) if match else None,
                'objectHash': match.group(3) if match else None,
                'difficulty': task.get('difficulty'),
                'connector': task.get('is_connector') if task.get('is_connector') is not None
                             else (task.get('execution_type') == 'connector'
                                   or task.get('category_normalized') == 'connector'),
                'category': task.get('category') or task.get('category_normalized'),
                'reportedQc': task.get('reported_qc_verdict') or task.get('reported_qc')
                              or task.get('qc_status_reported'),
                # Batch 1 records the source object under a different field, and
                # batch 1 alone carries a short id whose tail is the first 12 of
                # the bucket package's own hash.
                'sourceVersion': task.get('source_version'),
                'originalFilename': task.get('original_filename'),
                'pipelineBatchId': task.get('pipeline_batch_id'),
            })
    return out


def check_bucket(tasks, scan_rows):
    """Does each delivered package still exist in the bucket, and as what?

    The scan is a listing of the bucket, so this is evidence about the bucket
    rather than about the manifest. Three outcomes, and the middle one matters:
    a folder whose archive now hashes differently has been REPACKAGED since
    delivery, which is not the same as missing and not the same as unchanged.
    """
    by_hash = {r['sha256']: r for r in scan_rows if r.get('sha256')}
    by_hash12 = {}
    by_folder = collections.defaultdict(list)
    for row in scan_rows:
        if row.get('sha256'):
            by_hash12.setdefault(row['sha256'][:12], row)
        if row.get('folder'):
            by_folder[key(row['folder'])].append(row)

    how = collections.Counter()
    for task in tasks:
        candidates = [task['sha256'], task['objectHash'], task['sourceVersion'],
                      str(task['originalFilename'] or '').replace('.zip', '')]
        hit = next((by_hash[c] for c in candidates if c and c in by_hash), None)
        if hit is None:
            tail = str(task['pipelineBatchId'] or '').split('-')[-1]
            hit = by_hash12.get(tail) if len(tail) == 12 else None
        if hit is not None:
            task['bucket'] = {'state': 'hash', 'outcome': hit.get('outcome'),
                              'cohort': hit.get('cohortLabel'), 'sha256': hit.get('sha256')}
            how['verified by content hash'] += 1
            continue
        here = by_folder.get(key(task['folder'])) if task['folder'] else None
        if here:
            task['bucket'] = {'state': 'folder', 'outcome': here[0].get('outcome'),
                              'cohort': here[0].get('cohortLabel'), 'sha256': here[0].get('sha256')}
            how['folder found, archive repackaged since'] += 1
            continue
        task['bucket'] = {'state': 'absent'}
        how['not in the published scan'] += 1
    return how


def check_live(tasks, listing_lines, previous):
    """Check each delivered package against a real listing of the bucket.

    The scan in check_bucket covers what the pipeline scanner walks, which is
    not everything; this takes a plain `gcloud storage ls -r` of the delivery
    prefix and asks the only question that settles it - is the exact object
    this manifest names still there?

    Four answers, and they are not degrees of the same thing:

      object      the exact URI is present. The delivered archive is there.
      moved       that same archive is under its folder at another path -
                  review_handoff/ and the like. Same bytes, different key.
      repackaged  the folder is there and that archive is not.
      absent      no folder.

    Listings need credentials, so CI cannot produce one. When none is supplied
    the previous answers are carried forward rather than erased, and each one
    keeps the date it was made on so nobody reads a stale check as a fresh one.
    """
    if not listing_lines:
        for task in tasks:
            was = previous.get(task['name'])
            if was:
                task['live'] = was
        return collections.Counter(t['live']['state'] for t in tasks if t.get('live'))

    prefix_of = {}
    folders = collections.defaultdict(list)
    for line in listing_lines:
        line = line.strip()
        if not line.startswith('gs://'):
            continue
        prefix_of[line] = True
        match = re.match(r'gs://[^/]+/tasks/[^/]+/([^/]+)/(.+)$', line)
        if match:
            folders[match.group(1)].append(match.group(2))

    checked = datetime.now(timezone.utc).date().isoformat()
    how = collections.Counter()
    for task in tasks:
        uri, folder, obj = task['sourceUri'], task['folder'], task['objectHash']
        if uri in prefix_of:
            state = 'object'
        elif folder in folders and obj and any(obj in name for name in folders[folder]):
            state = 'moved'
        elif folder in folders:
            state = 'repackaged'
        else:
            state = 'absent'
        task['live'] = {'state': state, 'checkedOn': checked}
        how[state] += 1
    return how


def build(tasks, scan_rows, listing_lines=(), previous_live=None):
    how = check_bucket(tasks, scan_rows)
    live = check_live(tasks, listing_lines, previous_live or {})
    return {
        'generatedAt': datetime.now(timezone.utc).isoformat(timespec='seconds'),
        'rule': 'the four delivery manifests are the record of what was handed over; '
                'a pipeline row is claimed only when its own name is a machine placeholder '
                'or the delivered name itself, never on a version suffix',
        'counts': {
            'tasks': len(tasks),
            'batches': dict(collections.Counter(t['batch'] for t in tasks)),
            'bucket': dict(how),
            'verified': sum(1 for t in tasks if t['bucket']['state'] == 'hash'),
            'repackaged': sum(1 for t in tasks if t['bucket']['state'] == 'folder'),
            'absent': sum(1 for t in tasks if t['bucket']['state'] == 'absent'),
            'connector': sum(1 for t in tasks if t['connector']),
            # The live check is the one that settles it: the scan above covers
            # what the pipeline scanner walks, a listing covers the bucket.
            'live': dict(live),
            'liveConfirmed': sum(1 for t in tasks
                                 if (t.get('live') or {}).get('state') in ('object', 'moved')),
            'liveCheckedOn': next((t['live']['checkedOn'] for t in tasks
                                   if t.get('live')), None),
        },
        'tasks': tasks,
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--manifests', default='assets/manifests')
    ap.add_argument('--scan', default='assets/gcs-pipeline.json')
    ap.add_argument('--listing', default=None,
                    help='a `gcloud storage ls -r` of the delivery prefix. Needs '
                         'credentials, so CI has none and the previous answers '
                         'are carried forward instead of erased.')
    ap.add_argument('--out', default='assets/manifest-index.json')
    args = ap.parse_args()

    tasks = read_manifests(args.manifests)
    if not tasks:
        raise SystemExit(f'no manifests found in {args.manifests}')

    out_path = pathlib.Path(args.out)
    previous_live = {}
    if out_path.exists():
        previous_live = {t['name']: t['live'] for t
                         in json.loads(out_path.read_text(encoding='utf-8'))['tasks']
                         if t.get('live')}
    listing_lines = (pathlib.Path(args.listing).read_text(encoding='utf-8').splitlines()
                     if args.listing else ())

    scan_path = pathlib.Path(args.scan)
    scan_rows = []
    if scan_path.exists():
        blob = json.loads(scan_path.read_text(encoding='utf-8'))
        scan_rows = blob.get('tasks') or (blob.get('finalisation') or {}).get('tasks') or []

    payload = build(tasks, scan_rows, listing_lines, previous_live)

    # These are stated on the page as a record of a delivery, so they have to be
    # complete and unambiguous before anything is published from them.
    c = payload['counts']
    assert c['verified'] + c['repackaged'] + c['absent'] == c['tasks'], 'bucket check lost a task'
    assert len({t['name'] for t in tasks}) == len(tasks), 'a task name appears in two manifests'

    out = out_path
    out.write_text(json.dumps(payload, separators=(',', ':')), encoding='utf-8')

    print(f"delivered tasks        : {c['tasks']:>5}   {c['batches']}")
    for state, n in c['bucket'].items():
        print(f"  {state:<38}: {n:>5}")
    print(f"  connector            : {c['connector']:>5}")
    if c['live']:
        print(f"against a live listing of the bucket ({c['liveCheckedOn']})")
        for state, n in c['live'].items():
            print(f"  {state:<38}: {n:>5}")
        print(f"  {'still in the bucket':<38}: {c['liveConfirmed']:>5}")
    print(f"wrote {out} ({out.stat().st_size/1e3:.0f} KB)")


if __name__ == '__main__':
    main()
