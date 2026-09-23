"""The task each accepted folder actually holds, read from its task.toml.

Why this exists
---------------
Accepted is counted by bucket folder, on the principle that one folder is one
delivered package. That is true of packages and false of tasks: the same task is
re-cut under a new folder name after a review, and shows up again as
`harbor-single-task-<id>` when the console assigned a placeholder.

Neither the name nor the bytes can tell you. A normaliser loose enough to join
`gen-g236-...` to `gen-g236-...-review-resolved-20260918-rerun` also joins
ASTR_101198 to ASTR_101214, which are six different tasks. And no two packages
in the prefix are byte-identical - a re-cut differs - so the object MD5 finds
nothing.

`[task] name` inside task.toml does say it, exactly and without inference:

    fin-f45-repo-haircut-recompute   name = "obi/fin-f45-repo-haircut-recompute"
    harbor-single-task-2sy38tlg      name = "obi/fin-f45-repo-haircut-recompute"

Cost: the package is opened over HTTP Range, so ~40 KB crosses the wire per
folder rather than the 6-10 MB the archive weighs. Results are cached by folder
and a package never changes, so a folder is read once, ever.

READ ONLY.

    python3 scan_task_names.py --out task-names.json
"""
import argparse
import collections
import json
import pathlib
import re
import sys
import zipfile
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from list_delivery_prefix import access_token, list_objects  # noqa: E402
from read_task_toml import RemoteZip                          # noqa: E402

BUCKET = 'obi-harbor-pipeline'
PREFIX = 'tasks/finalisation_client_qc_accepted_iteration_2/'
# `name` inside the [task] table, not a name anywhere in the file: several other
# tables carry one too.
TASK_NAME = re.compile(r'^\s*\[task\]\s*$(.*?)(?=^\s*\[|\Z)', re.M | re.S)
NAME = re.compile(r'^\s*name\s*=\s*"([^"]+)"', re.M)
SOURCE_CONFIG = re.compile(r'^\s*source_config\s*=\s*"([^"]+)"', re.M)


def identity(text):
    block = TASK_NAME.search(text)
    name = NAME.search(block.group(1)) if block else None
    config = SOURCE_CONFIG.search(text)
    return (name.group(1) if name else None,
            config.group(1) if config else None)


def read_one(folder, token):
    objects = [n for n in list_objects(BUCKET, f'{PREFIX}{folder}/', token)
               if n.endswith('.zip') and '/review_handoff/' not in n]
    if not objects:
        return None, None, 'no package in the folder'
    remote = RemoteZip(BUCKET, objects[0], token)
    with zipfile.ZipFile(remote) as archive:
        members = [n for n in archive.namelist() if n.endswith('task.toml')]
        if not members:
            return None, None, 'package holds no task.toml'
        text = archive.read(members[0]).decode('utf-8', 'replace')
    name, config = identity(text)
    if not name:
        return None, config, 'task.toml declares no [task] name'
    return name, config, None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', default='task-names.json')
    ap.add_argument('--workers', type=int, default=24)
    ap.add_argument('--limit', type=int, default=0, help='0 = every folder')
    args = ap.parse_args()

    token = access_token()
    everything = list_objects(BUCKET, PREFIX, token)
    folders = sorted({n[len(PREFIX):].split('/')[0] for n in everything
                      if len(n) > len(PREFIX)})
    print(f'{len(folders):,} folders in the prefix', file=sys.stderr)

    out = pathlib.Path(args.out)
    known = (json.loads(out.read_text(encoding='utf-8')).get('names', {})
             if out.exists() else {})
    todo = [f for f in folders if f not in known]
    if args.limit:
        todo = todo[:args.limit]
    print(f'{len(known):,} cached, {len(todo):,} to read', file=sys.stderr)

    why = collections.Counter()
    done = 0

    def work(folder):
        try:
            return folder, read_one(folder, token)
        except Exception as error:                     # noqa: BLE001
            return folder, (None, None, f'{type(error).__name__}: {error}')

    if todo:
        with ThreadPoolExecutor(max_workers=args.workers) as pool:
            for folder, (name, config, reason) in pool.map(work, todo):
                done += 1
                if done % 100 == 0:
                    print(f'  {done:,}/{len(todo):,}', file=sys.stderr)
                if name is None:
                    why[reason] += 1
                    known[folder] = {'task': None, 'sourceConfig': config,
                                     'why': reason}
                    continue
                why['read'] += 1
                known[folder] = {'task': name, 'sourceConfig': config}

    groups = collections.defaultdict(list)
    for folder, entry in known.items():
        if entry.get('task'):
            groups[entry['task']].append(folder)
    multi = {t: sorted(f) for t, f in groups.items() if len(f) > 1}
    extra = sum(len(f) - 1 for f in multi.values())
    unreadable = [f for f, e in known.items() if not e.get('task')]

    payload = {
        'generatedAt': datetime.now(timezone.utc).isoformat(timespec='seconds'),
        'prefix': f'gs://{BUCKET}/{PREFIX}',
        'rule': 'the task is the [task] name declared in the package task.toml; '
                'the folder name and the package bytes both fail to identify it',
        'counts': {
            'folders': len(folders),
            'read': len(known) - len(unreadable),
            'unreadable': len(unreadable),
            'distinctTasks': len(groups),
            'tasksUnderMoreThanOneFolder': len(multi),
            'foldersInThoseGroups': sum(len(f) for f in multi.values()),
            'foldersAboveTheFirst': extra,
            'byReason': dict(why.most_common()),
        },
        'duplicates': multi,
        'names': known,
    }
    out.write_text(json.dumps(payload, indent=1), encoding='utf-8')

    c = payload['counts']
    print(f"\nfolders in the prefix            : {c['folders']:>6,}")
    print(f"  task.toml read                 : {c['read']:>6,}")
    print(f"  unreadable                     : {c['unreadable']:>6,}")
    print(f"  DISTINCT TASKS                 : {c['distinctTasks']:>6,}")
    print(f"  tasks under >1 folder          : {c['tasksUnderMoreThanOneFolder']:>6,}")
    print(f"  folders in those groups        : {c['foldersInThoseGroups']:>6,}")
    print(f"  folders above the first        : {c['foldersAboveTheFirst']:>6,}")
    for reason, n in c['byReason'].items():
        if reason != 'read':
            print(f"  {reason:<32}: {n:>6,}")
    print(f'\nwrote {out}')
    for task, folders_ in sorted(multi.items(), key=lambda kv: -len(kv[1]))[:10]:
        print(f'\n  {task}  ({len(folders_)} folders)')
        for n in folders_:
            print(f'      {n[:76]}')


if __name__ == '__main__':
    main()
