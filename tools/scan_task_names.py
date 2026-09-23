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


def packages_in(folder, listing):
    """The package archives in a folder, from a listing of the whole prefix."""
    start = f'{PREFIX}{folder}/'
    return sorted(n for n in listing
                  if n.startswith(start) and n.endswith('.zip') and '/review_handoff/' not in n)


def read_one(folder, token, packages=None):
    """Every package in the folder, not only the first.

    152 folders hold more than one archive - a re-cut left beside the original -
    and in 3 of them the archives declare DIFFERENT tasks: the folder literally
    named `task` holds three. Reading one archive saw one of the three and never
    knew about the others. The folder's task stays the first archive's name, so
    the figures do not move under anyone; the other names are returned too, and
    the folder is reported as holding several tasks.
    """
    objects = packages if packages is not None else [
        n for n in list_objects(BUCKET, f'{PREFIX}{folder}/', token)
        if n.endswith('.zip') and '/review_handoff/' not in n]
    if not objects:
        return None, None, 'no package in the folder', []
    names, config, reason = [], None, None
    for obj in objects:
        with zipfile.ZipFile(RemoteZip(BUCKET, obj, token)) as archive:
            members = [n for n in archive.namelist() if n.endswith('task.toml')]
            if not members:
                reason = reason or 'package holds no task.toml'
                continue
            text = archive.read(members[0]).decode('utf-8', 'replace')
        name, cfg = identity(text)
        config = config or cfg
        if not name:
            reason = reason or 'task.toml declares no [task] name'
        elif name not in names:
            names.append(name)
    if not names:
        return None, config, reason, []
    return names[0], config, None, names


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', default='task-names.json',
                    help='the cache: every folder read, with a reason for each '
                         'one that could not be')
    ap.add_argument('--asset', default=None,
                    help='the page-facing file, holding only folder -> task for '
                         'folders still in the prefix')
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
    # A folder is re-read when the archives in it change: a package never
    # changes, but a folder can gain one (a re-cut dropped beside the original),
    # and a cache keyed on the folder alone would never look at it.
    current = {f: packages_in(f, everything) for f in folders}
    todo = [f for f in folders
            if f not in known or known[f].get('packages') != [p.rsplit('/', 1)[-1] for p in current[f]]]
    if args.limit:
        todo = todo[:args.limit]
    print(f'{len(known):,} cached, {len(todo):,} to read', file=sys.stderr)

    why = collections.Counter()
    done = 0

    def work(folder):
        try:
            return folder, read_one(folder, token, current[folder])
        except Exception as error:                     # noqa: BLE001
            return folder, (None, None, f'{type(error).__name__}: {error}', [])

    if todo:
        with ThreadPoolExecutor(max_workers=args.workers) as pool:
            for folder, (name, config, reason, names) in pool.map(work, todo):
                done += 1
                if done % 100 == 0:
                    print(f'  {done:,}/{len(todo):,}', file=sys.stderr)
                packages = [p.rsplit('/', 1)[-1] for p in current[folder]]
                if name is None:
                    why[reason] += 1
                    known[folder] = {'task': None, 'sourceConfig': config,
                                     'why': reason, 'packages': packages}
                    continue
                why['read'] += 1
                known[folder] = {'task': name, 'sourceConfig': config, 'packages': packages}
                if len(names) > 1:
                    known[folder]['tasks'] = names

    # Only folders still in the prefix. The cache remembers everything it has
    # ever read, which is what makes the steady state free, but a folder that
    # has been removed must not keep a duplicate group alive.
    live = set(folders)
    groups = collections.defaultdict(list)
    for folder, entry in known.items():
        if entry.get('task') and folder in live:
            groups[entry['task']].append(folder)
    multi = {t: sorted(f) for t, f in groups.items() if len(f) > 1}
    extra = sum(len(f) - 1 for f in multi.values())
    unreadable = [f for f, e in known.items() if not e.get('task') and f in live]
    # Folders whose archives declare more than one task. Reported, not split:
    # which archive is the folder's is a question for whoever filed them.
    mixed = {f: e['tasks'] for f, e in sorted(known.items()) if f in live and len(e.get('tasks') or []) > 1}

    payload = {
        'generatedAt': datetime.now(timezone.utc).isoformat(timespec='seconds'),
        'prefix': f'gs://{BUCKET}/{PREFIX}',
        'rule': 'the task is the [task] name declared in the package task.toml; '
                'the folder name and the package bytes both fail to identify it',
        'counts': {
            'folders': len(folders),
            'read': sum(1 for f, e in known.items() if e.get('task') and f in live),
            'unreadable': len(unreadable),
            'distinctTasks': len(groups),
            'tasksUnderMoreThanOneFolder': len(multi),
            'foldersInThoseGroups': sum(len(f) for f in multi.values()),
            'foldersAboveTheFirst': extra,
            'foldersHoldingSeveralTasks': len(mixed),
            'byReason': dict(why.most_common()),
        },
        'duplicates': multi,
        'mixed': mixed,
        'names': known,
    }
    out.write_text(json.dumps(payload, indent=1), encoding='utf-8')

    # The page's copy: the map it looks folders up in, the groups, and the
    # counts that describe them. Derived here rather than by a step in the
    # publish script, so the two shapes cannot drift apart.
    if args.asset:
        asset = pathlib.Path(args.asset)
        asset.write_text(json.dumps({
            'generatedAt': payload['generatedAt'],
            'prefix': payload['prefix'],
            'rule': payload['rule'],
            'counts': payload['counts'],
            'duplicates': multi,
            'mixed': mixed,
            'task': {f: known[f]['task'] for f in sorted(live)
                     if known.get(f, {}).get('task')},
        }, separators=(',', ':')), encoding='utf-8')
        print(f'wrote {asset} for the page')

    c = payload['counts']
    print(f"\nfolders in the prefix            : {c['folders']:>6,}")
    print(f"  task.toml read                 : {c['read']:>6,}")
    print(f"  unreadable                     : {c['unreadable']:>6,}")
    print(f"  DISTINCT TASKS                 : {c['distinctTasks']:>6,}")
    print(f"  tasks under >1 folder          : {c['tasksUnderMoreThanOneFolder']:>6,}")
    print(f"  folders in those groups        : {c['foldersInThoseGroups']:>6,}")
    print(f"  folders above the first        : {c['foldersAboveTheFirst']:>6,}")
    print(f"  folders holding several tasks  : {c['foldersHoldingSeveralTasks']:>6,}")
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
