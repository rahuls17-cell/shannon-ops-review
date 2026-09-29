#!/usr/bin/env python3
"""Which bench a task runs on, read from its Dockerfile in the bucket.

What decides it
---------------
The base image. A connector task runs in a harness image, and which harness it
is separates the benches:

    connectors-harness-aster                    company bench aster
    company-bench-private, benchmark-base,      company bench zeta
      anything under data-obi-rl-gym
    connectors-harness:real-data-*              computer bench real
    anything under connectors-rl-gym,           computer bench synth
      or connectors-harness otherwise

Order matters and is easy to get backwards: benchmark-base sits under
data-obi-rl-gym and is a COMPANY image, while obi-benchmark under
connectors-rl-gym is a COMPUTER one, so the registry path is tested before the
image name. Testing the name first scores 344 of the 348 labelled rows; testing
the path first scores all 348. assets/bench-reference.json holds those labelled
pairs and tools/test-task-toml.cjs checks the rule against every one.

Where it is read from
---------------------
    tasks/auto-<verdict stem>/<task folder>/environment/Dockerfile

The task folder is LISTED, not built from the pipeline row's name. It used to
be built from the name, and the name is often not the folder:

    autorun-e99e53...                      -> monthly-ledger-rollover-report-...
    which-visits-...-96bbed-v3-sna-ttkc    -> which-visits-still-need-a-room
    pipeline-evaluation-f19a47f5...        -> tech-b607-t5-nist-control-...
    autorun-2590bbc7...                    -> harbor-single-task-eo0wf7d_

So 1,478 rows were cached as having no Dockerfile when 29 of 30 sampled had
one, one level down under a different name. Listing costs one extra small
request per task and removes the guess. Entries starting with `_` are
bookkeeping (_oracle_gate and the like), not tasks, and are skipped.

When a batch holds several task folders and none is named for the row, the row
is recorded as ambiguous rather than given the first folder's bench.

Loose in the bucket, about 3 KB. Not inside the package: the delivery cohort
holds only zips, and reading the Dockerfile out of one of those means fetching
6-10 MB to reach three kilobytes. The task-source tree has it as its own
object, and it is the same `auto-<verdict stem>` path the GLM scan already
resolves, so this is one small GET per task.

Nothing is read twice
---------------------
A package is immutable - same content, same Dockerfile, forever - so a task
that has been read is never read again. The cache is the committed asset, the
page does a lookup, and the steady state is zero requests. Only genuinely new
tasks cost anything.

A MISS is remembered too, and this matters more than it sounds. About a fifth
of pipeline rows have no Dockerfile at their task-source path at all - the tree
was never written, or was written under a different batch. Recording only the
hits leaves those rows permanently in the to-read list, so an unattended run
re-reads the same dead paths on every tick and never converges. They are cached
with the reason and the date instead, and retried once a day in case a tree
lands late.

READ ONLY.

    python tools/scan_bench.py --out assets/bench-index.json
"""
import argparse
import collections
import json
import pathlib
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from list_delivery_prefix import access_token          # noqa: E402
from read_task_toml import bench_type, FROM_LINE       # noqa: E402

API = 'https://storage.googleapis.com/storage/v1/b/{bucket}/o/{obj}?alt=media'


def fetch(bucket, obj, token, timeout=30):
    url = API.format(bucket=urllib.parse.quote(bucket, safe=''),
                     obj=urllib.parse.quote(obj, safe=''))
    request = urllib.request.Request(url, headers={'Authorization': f'Bearer {token}'})
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return response.read().decode('utf-8', 'replace')
    except urllib.error.HTTPError as error:
        if error.code in (403, 404):
            return None
        raise


def batch_of(row):
    """The task-source tree this row was decided in.

    pipeline-truth records the verdict object each row came from, and the tree
    is that object's name with `auto-` in front - the same derivation the GLM
    scan uses, so no extra lookup is needed to find it.
    """
    stem = str(row.get('source') or '').rsplit('/', 1)[-1]
    return 'auto-' + stem[:-5] if stem.endswith('.json') else None


LIST = 'https://storage.googleapis.com/storage/v1/b/{bucket}/o?{query}'
# The version-and-run suffix the pipeline appends to a task name, which the
# folder in the batch tree does not carry.
RUN_SUFFIX = re.compile(r'-[0-9a-f]{6}-v\d+-sna-[a-z]{4}$')

# The reason every row was cached under while the folder name was guessed. Any
# miss still carrying it was recorded by the old path and is not evidence of
# anything, so it is dropped on load and read again. Nothing writes this string
# any more, so this clears the backlog once and then never matches again - on
# the VM as well as here, with no manual reset.
RETIRED_REASON = 'no Dockerfile at the task source path'


def task_folders(bucket, batch, token, timeout=30):
    """The task folders directly inside a batch tree, bookkeeping skipped."""
    base = f'tasks/{batch}/'
    query = urllib.parse.urlencode({'prefix': base, 'delimiter': '/',
                                    'fields': 'prefixes', 'maxResults': '100'})
    url = LIST.format(bucket=urllib.parse.quote(bucket, safe=''), query=query)
    request = urllib.request.Request(url, headers={'Authorization': f'Bearer {token}'})
    with urllib.request.urlopen(request, timeout=timeout) as response:
        prefixes = json.load(response).get('prefixes', [])
    names = [pre[len(base):].rstrip('/') for pre in prefixes]
    return [n for n in names if n and not n.startswith('_')]


def pick_folder(row_name, folders):
    """The folder this row's task lives in, or None when that is not decidable.

    An exact name wins. A single folder is unambiguous whatever it is called -
    that is the autorun and placeholder case. Among several, only the one that
    matches the name with its run suffix stripped is accepted; anything else
    would be picking a neighbour's bench.
    """
    if row_name in folders:
        return row_name
    if len(folders) == 1:
        return folders[0]
    bare = RUN_SUFFIX.sub('', row_name)
    return bare if bare in folders else None


def read_one(row, bucket, token):
    """(image, folder, reason) - reason is set only when there is no image."""
    batch = batch_of(row)
    if not batch:
        return None, None, 'the row names no verdict object'
    folders = task_folders(bucket, batch, token)
    if not folders:
        return None, None, 'the batch tree holds no task folder'
    folder = pick_folder(row['name'], folders)
    if folder is None:
        return None, None, f'{len(folders)} task folders in the batch, none named for this row'
    text = fetch(bucket, f'tasks/{batch}/{folder}/environment/Dockerfile', token)
    if text is None:
        return None, folder, 'a task folder with no environment/Dockerfile'
    found = FROM_LINE.search(text)
    if not found:
        return None, folder, 'the Dockerfile declares no FROM'
    return found.group(1), folder, None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--bucket', default='obi-harbor-pipeline')
    ap.add_argument('--truth', default='assets/pipeline-truth.json')
    ap.add_argument('--reads', default='assets/task-toml-reads.json',
                    help='packages opened directly; their image is reused here')
    ap.add_argument('--out', default='assets/bench-index.json')
    ap.add_argument('--workers', type=int, default=32)
    ap.add_argument('--max-new', type=int, default=2000,
                    help='cap on tasks read in one run, so a reorganised prefix '
                         'cannot turn into an unbounded crawl')
    ap.add_argument('--recheck-after-days', type=int, default=1,
                    help='how long a miss is trusted before the path is tried '
                         'again; 0 retries every run')
    args = ap.parse_args()

    truth = json.loads(pathlib.Path(args.truth).read_text(encoding='utf-8'))
    out = pathlib.Path(args.out)
    cached = json.loads(out.read_text(encoding='utf-8')) if out.exists() else {}
    known = cached.get('bench', {})
    misses = cached.get('misses', {})
    retired = [k for k, v in misses.items() if v.get('reason') == RETIRED_REASON]
    for k in retired:
        del misses[k]
    if retired:
        print(f'{len(retired):,} misses were recorded by the old name-guessing path '
              f'and will be read again', file=sys.stderr)

    # Anything a package read already told us, so the two never disagree.
    reads_path = pathlib.Path(args.reads)
    if reads_path.exists():
        for folder, read in json.loads(reads_path.read_text(encoding='utf-8')).get('reads', {}).items():
            if read.get('image') and folder not in known:
                known[folder] = {'image': read['image'], 'bench': read.get('bench'),
                                 'via': 'the package, opened directly'}

    # A miss is only trusted for a while: a task-source tree can land after the
    # verdict does, and a permanent skip would never notice.
    today = datetime.now(timezone.utc).date()
    def stale(folder):
        seen = misses.get(folder, {}).get('checkedOn')
        if not seen:
            return True
        try:
            return (today - datetime.fromisoformat(seen).date()).days >= args.recheck_after_days
        except ValueError:
            return True

    todo = [r for r in truth['tasks']
            if r['id'] not in known and stale(r['id'])][:args.max_new]
    print(f'{len(known):,} already known, {len(misses):,} cached as unreadable, '
          f'{len(todo):,} to read (of {len(truth["tasks"]):,} rows)', file=sys.stderr)

    token = access_token() if todo else None
    why = collections.Counter()
    done = 0

    def work(row):
        try:
            return row, read_one(row, args.bucket, token)
        except Exception as error:                      # noqa: BLE001
            return row, (None, None, f'{type(error).__name__}: {error}')

    if todo:
        with ThreadPoolExecutor(max_workers=args.workers) as pool:
            for row, (image, folder, reason) in pool.map(work, todo):
                done += 1
                if done % 500 == 0:
                    print(f'  {done:,}/{len(todo):,}', file=sys.stderr)
                if image is None:
                    why[reason] += 1
                    misses[row['id']] = {'reason': reason, 'folder': folder,
                                         'checkedOn': today.isoformat()}
                    continue
                known[row['id']] = {'image': image, 'bench': bench_type(image),
                                    'folder': folder,
                                    'via': 'the Dockerfile in the task source'}
                misses.pop(row['id'], None)
                why['read from the Dockerfile'] += 1

    benches = collections.Counter(v['bench'] for v in known.values() if v.get('bench'))
    payload = {
        'generatedAt': datetime.now(timezone.utc).isoformat(timespec='seconds'),
        'pipelineGeneratedAt': truth.get('generatedAt'),
        'rule': 'the bench is read from the FROM line of environment/Dockerfile; '
                'the registry path is tested before the image name',
        'counts': {
            'pipelineTasks': len(truth['tasks']),
            'known': len(known),
            'readThisRun': why.get('read from the Dockerfile', 0),
            'byBench': dict(benches.most_common()),
            'noBench': sum(1 for v in known.values() if not v.get('bench')),
            'unreadable': len(misses),
            'byReason': dict(why.most_common()),
        },
        'bench': known,
        'misses': misses,
    }
    out.write_text(json.dumps(payload, separators=(',', ':')), encoding='utf-8')

    c = payload['counts']
    print(f"pipeline rows        : {c['pipelineTasks']:>6,}")
    print(f"  image known        : {c['known']:>6,}   ({c['readThisRun']:,} read this run)")
    for bench, n in c['byBench'].items():
        print(f"    {bench:<22}: {n:>6,}")
    print(f"    no bench (plain base image): {c['noBench']:>6,}")
    print(f"  no Dockerfile to read: {c['unreadable']:>6,}   "
          f"(re-tried after {args.recheck_after_days}d)")
    for reason, n in c['byReason'].items():
        if reason != 'read from the Dockerfile':
            print(f"  {reason:<40}: {n:>6,}")
    print(f'wrote {out} ({out.stat().st_size/1e3:.0f} KB)')


if __name__ == '__main__':
    main()
