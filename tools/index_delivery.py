#!/usr/bin/env python3
"""Step 2: the delivery index. Read-only.

Lists the accepted folders and records, per task, which folders hold a package
for it right now. This is the only input to the accepted-versus-legacy split:

    accepted        = canonical decision accepted AND package in CURRENT_BAR today
    legacy accepted = ever accepted AND not accepted

Membership is a fact about the bucket at scan time, not about history, so this
must be re-read every cycle rather than cached.

`finalization_qc_rejected` is deliberately absent: it is a rejection cohort, it
holds ~2M objects, and nothing here needs it.

Runs on the Harbor VM beside scan_bucket.py. READ-ONLY.

    python3 index_delivery.py --out delivery.json
"""
import argparse
import collections
import json
import sys
import time
import urllib.error
import urllib.parse
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import scan_bucket as S  # noqa: E402

CURRENT_BAR = 'tasks/finalisation_client_qc_accepted_iteration_2/'
GATE_ONLY = 'tasks/finalisation_client_qc_accepted_iteration_2_glm52_gate_only/'

# role: what membership of this folder means for the split.
FOLDERS = [
    (CURRENT_BAR, 'current', 'Client QC accepted - iteration 2'),
    ('tasks/finalisation_client_qc_accepted_iteration_1/', 'retired', 'Client QC accepted - iteration 1'),
    ('tasks/finalization_qc_accepted/', 'retired', 'QC accepted'),
    (GATE_ONLY, 'gate_only', 'GLM-5.2 gate-only, moved out of the current bar 2026-09-16'),
]

TOKEN_TTL = 30 * 60


class Token:
    def __init__(self):
        self.value = S.token()
        self.minted = time.time()

    def get(self):
        if time.time() - self.minted > TOKEN_TTL:
            self.value = S.token()
            self.minted = time.time()
        return self.value

    def refresh(self):
        self.value = S.token()
        self.minted = time.time()


def read(tok, url):
    try:
        return S.http(url, tok.get())
    except urllib.error.HTTPError as err:
        if err.code != 401:
            raise
        tok.refresh()
        return S.http(url, tok.get())


def list_objects(tok, prefix):
    out, page = [], None
    while True:
        q = {'prefix': prefix, 'maxResults': '1000',
             'fields': 'items(name,size,updated),nextPageToken'}
        if page:
            q['pageToken'] = page
        payload = json.loads(read(tok, S.API + '?' + urllib.parse.urlencode(q)))
        out += payload.get('items', [])
        page = payload.get('nextPageToken')
        if not page:
            return out


def folder_prefixes(tok, prefix):
    """Directory names directly under `prefix`, via delimiter listing. Used to
    cross-check the object walk: the two must agree on the task count."""
    out, page = [], None
    while True:
        q = {'prefix': prefix, 'delimiter': '/', 'maxResults': '1000',
             'fields': 'prefixes,nextPageToken'}
        if page:
            q['pageToken'] = page
        payload = json.loads(read(tok, S.API + '?' + urllib.parse.urlencode(q)))
        out += payload.get('prefixes', [])
        page = payload.get('nextPageToken')
        if not page:
            return [p[len(prefix):].rstrip('/') for p in out]


def name_key(value):
    v = str(value or '').strip().lower()
    for p in ('harbor/', 'obi/'):
        if v.startswith(p):
            v = v[len(p):]
    return v


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', default='delivery.json')
    args = ap.parse_args()

    tok = Token()
    started = time.time()
    tasks = collections.defaultdict(dict)     # name_key -> {cohort: record}
    cohorts = []
    sentinels = []

    for prefix, role, label in FOLDERS:
        mark = time.time()
        objects = list_objects(tok, prefix)
        dirs = folder_prefixes(tok, prefix)
        packages = 0
        seen = set()
        for obj in objects:
            rest = obj['name'][len(prefix):]
            if '/' not in rest:
                # A file sitting directly in the cohort root is a sentinel or
                # manifest, not a task. The 569-vs-566 gap was exactly this.
                sentinels.append({'cohort': prefix, 'object': obj['name'],
                                  'size': int(obj.get('size') or 0)})
                continue
            task, _, tail = rest.partition('/')
            key = name_key(task)
            if not key:
                continue
            seen.add(key)
            record = tasks[key].setdefault(prefix, {
                'cohort': prefix, 'role': role, 'label': label,
                'task': task, 'packages': [], 'files': 0,
            })
            record['files'] += 1
            if tail.endswith('.zip'):
                packages += 1
                record['packages'].append({
                    'sha256': tail.rsplit('/', 1)[-1][:-4],
                    'size': int(obj.get('size') or 0),
                    'updated': obj.get('updated', ''),
                    'object': obj['name'],
                })
        cohorts.append({
            'prefix': prefix, 'role': role, 'label': label,
            'objects': len(objects), 'tasks': len(seen),
            'tasksByDelimiter': len(dirs), 'packages': packages,
            'seconds': round(time.time() - mark, 1),
            # The two listings answer the same question two ways. A mismatch
            # means a task folder holds no objects, or a name normalised into
            # another - either way it must not pass silently.
            'agrees': len(seen) == len(dirs),
        })
        print(f'{prefix:<62} {len(seen):>6,} tasks / {packages:>6,} packages '
              f'/ {len(objects):>7,} objects  agrees={len(seen) == len(dirs)}', flush=True)

    current = {k for k, v in tasks.items() if CURRENT_BAR in v}
    gate_only = {k for k, v in tasks.items() if GATE_ONLY in v}
    retired = {k for k, v in tasks.items()
               if any(rec['role'] == 'retired' for rec in v.values())}

    payload = {
        'generatedAt': datetime.now(timezone.utc).isoformat(timespec='seconds'),
        'bucket': f'gs://{S.BUCKET}/',
        'step': '2-delivery-index',
        'currentBar': CURRENT_BAR,
        'note': 'Folder membership as of this scan. Accepted is decided here, '
                'not by history: a package either sits at the current bar now '
                'or it does not.',
        'cohorts': cohorts,
        'sentinels': sentinels,
        'summary': {
            'distinctTasks': len(tasks),
            'atCurrentBar': len(current),
            'retiredOnly': len(retired - current),
            'gateOnly': len(gate_only),
            'gateOnlyAlsoCurrent': len(gate_only & current),
            'seconds': round(time.time() - started, 1),
        },
        'tasks': {k: list(v.values()) for k, v in tasks.items()},
    }
    Path(args.out).write_text(json.dumps(payload, separators=(',', ':')), encoding='utf-8')

    print(f'\ndistinct task names across accepted folders : {len(tasks):,}')
    print(f'  at the current bar (iteration 2)          : {len(current):,}')
    print(f'  in a retired bar only                     : {len(retired - current):,}')
    print(f'  in the GLM-5.2 gate-only folder           : {len(gate_only):,}')
    print(f'    of those, back at the current bar       : {len(gate_only & current):,}')
    print(f'  sentinel files (not tasks)                : {len(sentinels)}')
    for s in sentinels[:6]:
        print(f'      {s["object"]}')
    bad = [c for c in cohorts if not c['agrees']]
    if bad:
        print('\n  LISTING DISAGREEMENT:')
        for c in bad:
            print(f'      {c["prefix"]}: walk {c["tasks"]:,} vs delimiter {c["tasksByDelimiter"]:,}')
    print(f'\nwrote {args.out} ({Path(args.out).stat().st_size/1e6:.1f} MB) '
          f'in {payload["summary"]["seconds"]}s')


if __name__ == '__main__':
    main()
