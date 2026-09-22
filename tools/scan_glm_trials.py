#!/usr/bin/env python3
"""Read each pipeline task's four GLM trials out of the bucket.

What the figure is
------------------
Every task is run four times by the same GLM-5.2 battery before it is offered.
A run passes only at a reward of exactly 1.0, so a task scores 0/4 to 4/4, and
the band that gets accepted is 1/4 to 3/4: 4/4 is too easy and 0/4 has not been
shown to be solvable at all. That is the number this produces.

Where it comes from
-------------------
Not from a name and not from a report about the bucket - from the trial files
themselves:

  tasks/auto-<verdict stem>/_gate_report.json
      -> tasks[<task>].glm_result_ids, four trial directories
  <trial dir>/verifier/reward.txt
      -> one reward per trial

The gate report is read rather than the paths being guessed, because the
trials do not live where a guess would put them: they sit under
tasks/trainer-evaluation-<id>-a1/, not under the auto- batch that names them.
A guessed path happens to work for some tasks and silently finds nothing for
others, which would read as "no GLM evidence" for work that has plenty.

The batch is derived from the verdict each pipeline row was read from -
`pipeline-evaluation-abc.json` becomes `auto-pipeline-evaluation-abc` - so no
extra lookup is needed to find it.

Checked against the bucket's own cross-trial report, which states the same
count in prose: "GLM strict-pass count 2/4 (r1=1.0, r2=0.0, r3=0.0, r4=1.0)".

READ ONLY. GET on the storage JSON API and nothing else.

    python tools/scan_glm_trials.py --out assets/glm-index.json
"""
import argparse
import collections
import json
import pathlib
import sys
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from list_delivery_prefix import access_token          # noqa: E402

API = 'https://storage.googleapis.com/storage/v1/b/{bucket}/o/{obj}?alt=media'


def fetch(bucket, obj, token, timeout=30):
    url = API.format(bucket=urllib.parse.quote(bucket, safe=''),
                     obj=urllib.parse.quote(obj, safe=''))
    request = urllib.request.Request(url, headers={'Authorization': f'Bearer {token}'})
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return response.read()
    except urllib.error.HTTPError as error:
        if error.code in (403, 404):
            return None
        raise


def batch_of(row):
    """The results batch a pipeline row was decided in.

    pipeline-truth records the verdict object each row came from, and the
    batch is that object's name with `auto-` in front. Every spelling in the
    verdicts follows it - pipeline-evaluation-, autorun-, and the ones named
    after the task itself.
    """
    stem = str(row.get('source') or '').rsplit('/', 1)[-1]
    return 'auto-' + stem[:-5] if stem.endswith('.json') else None


def trials_for(row, bucket, token):
    batch = batch_of(row)
    if not batch:
        return None, 'the row names no verdict object'
    report = fetch(bucket, f'tasks/{batch}/_gate_report.json', token)
    if report is None:
        return None, 'no gate report for this batch'
    try:
        tasks = json.loads(report).get('tasks') or {}
    except json.JSONDecodeError:
        return None, 'the gate report is not readable'
    if not tasks:
        return None, 'the gate report lists no tasks'

    entry = tasks.get(row['name'])
    if entry is None:
        # The gate report keys on the task folder, which is not always the
        # name the pipeline shows. One task in the batch is unambiguous; more
        # than one and a guess could attach another task's trials to this row,
        # so it is refused instead.
        if len(tasks) != 1:
            return None, 'the batch holds several tasks and none matches this name'
        entry = next(iter(tasks.values()))

    dirs = entry.get('glm_result_ids') or []
    if not dirs:
        return None, 'the gate report records no GLM trials'

    rewards = []
    for one in dirs:
        path = one.replace(f'gs://{bucket}/', '', 1)
        raw = fetch(bucket, f'{path}/verifier/reward.txt', token)
        rewards.append(None if raw is None else raw.decode('utf-8', 'replace').strip())
    return rewards, None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--bucket', default='obi-harbor-pipeline')
    ap.add_argument('--truth', default='assets/pipeline-truth.json')
    ap.add_argument('--out', default='assets/glm-index.json')
    ap.add_argument('--workers', type=int, default=32)
    ap.add_argument('--limit', type=int, default=0, help='first N rows only, for a trial run')
    args = ap.parse_args()

    truth = json.loads(pathlib.Path(args.truth).read_text(encoding='utf-8'))
    rows = truth['tasks'][:args.limit] if args.limit else truth['tasks']
    token = access_token()

    glm, why = {}, collections.Counter()
    done = 0

    def work(row):
        try:
            return row, trials_for(row, args.bucket, token)
        except Exception as error:                      # noqa: BLE001
            return row, (None, f'{type(error).__name__}: {error}')

    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        for row, (rewards, reason) in pool.map(work, rows):
            done += 1
            if done % 250 == 0:
                print(f'  {done:,}/{len(rows):,}', file=sys.stderr)
            if rewards is None:
                why[reason] += 1
                continue
            values = [None if r is None else float(r) for r in rewards]
            read = [v for v in values if v is not None]
            if not read:
                why['trial directories found, no reward recorded'] += 1
                continue
            # A run passes only at exactly 1.0. Anything else is a fail, and a
            # partial reward is a fail with detail, not a half pass.
            glm[row['id']] = {
                'passes': sum(1 for v in read if v == 1.0),
                'trials': len(values),
                'read': len(read),
                'rewards': values,
            }
            why['read from the trial files'] += 1

    band = collections.Counter(f"{v['passes']}/{v['trials']}" for v in glm.values())
    payload = {
        'generatedAt': datetime.now(timezone.utc).isoformat(timespec='seconds'),
        'pipelineGeneratedAt': truth.get('generatedAt'),
        'rule': 'four GLM-5.2 trials per task, read from verifier/reward.txt; a run '
                'passes only at a reward of exactly 1.0',
        'counts': {
            'pipelineTasks': len(rows),
            'withTrials': len(glm),
            'withoutTrials': len(rows) - len(glm),
            'byReason': dict(why.most_common()),
            'band': dict(sorted(band.items())),
        },
        'glm': glm,
    }
    out = pathlib.Path(args.out)
    out.write_text(json.dumps(payload, separators=(',', ':')), encoding='utf-8')

    c = payload['counts']
    print(f"pipeline tasks      : {c['pipelineTasks']:>6,}")
    print(f"  with GLM trials   : {c['withTrials']:>6,}")
    print(f"  without           : {c['withoutTrials']:>6,}")
    for reason, n in c['byReason'].items():
        print(f"    {reason:<52}: {n:>6,}")
    print('  band:', c['band'])
    print(f'wrote {out} ({out.stat().st_size/1e3:.0f} KB)')


if __name__ == '__main__':
    main()
