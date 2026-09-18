#!/usr/bin/env python3
"""Step 1: raw verdict ingest. Read-only, and deliberately un-opinionated.

Reads every object under tasks/qc_platform_sync/_verdicts/ (schema
harbor/pipeline-verdict/v2) and emits one row per submission x task, plus one
marked row per submission whose verdict names no tasks.

Nothing is interpreted here. No identity is assigned, no state is collapsed, no
scope filter is applied. Those are later steps, so that each can be checked on
its own. Every row keeps `source`, the GCS object it came from, so any figure
on the dashboard can be traced back to a readable path.

Runs on the Harbor VM, beside scan_bucket.py. READ-ONLY: lists and reads
objects, never writes to the bucket.

    python3 ingest_verdicts.py --out verdicts.json
    python3 ingest_verdicts.py --limit 200 --out sample.json
"""
import argparse
import collections
import json
import sys
import time
import urllib.error
import urllib.parse
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import scan_bucket as S  # noqa: E402

PREFIX = 'tasks/qc_platform_sync/_verdicts/'
SCHEMA = 'harbor/pipeline-verdict/v2'
WORKERS = 16
TOKEN_TTL = 30 * 60


class Token:
    """Re-mints before the ~1h expiry, so a long run does not die mid-read."""

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


def list_verdicts(tok):
    out, page = [], None
    while True:
        q = {'prefix': PREFIX, 'maxResults': '1000',
             'fields': 'items(name,size,updated),nextPageToken'}
        if page:
            q['pageToken'] = page
        payload = json.loads(read(tok, S.API + '?' + urllib.parse.urlencode(q)))
        out += payload.get('items', [])
        page = payload.get('nextPageToken')
        if not page:
            return out


def as_list(value):
    """`blocking_findings` is an int sitting next to `findings`, which is a
    list. Anything iterated must survive both."""
    return value if isinstance(value, list) else []


def finding_codes(task):
    codes = []
    for finding in as_list(task.get('findings')):
        if isinstance(finding, dict) and finding.get('code'):
            codes.append(finding['code'])
    return codes


def gate_hints(body):
    """Which gate and model judged this run. Read from the verdict itself - the
    live profile file describes only today and keeps no history."""
    blob = json.dumps(body).lower()
    return {
        'glm52': 'glm-5.2' in blob,
        'kestrel': 'kestrel' in blob,
        'calibration': 'calibration' in blob,
        'oracle': 'oracle' in blob,
    }


def rows_from(body, obj):
    """One row per submission x task; one marked row when a verdict names none."""
    source = obj['name']
    submission = source[len(PREFIX):-len('.json')] if source.endswith('.json') else source
    base = {
        'source': source,
        'submission': submission,
        'objectUpdated': obj.get('updated', ''),
        'schema': body.get('schema', ''),
        'state': body.get('state', ''),
        'stateRank': body.get('state_rank'),
        'stage': body.get('stage'),
        'decidedAt': body.get('decided_at') or '',
        'updatedAt': body.get('updated_at') or '',
        'decidedAtInferred': not bool(body.get('decided_at')),
        'owner': str(body.get('owner') or '').lower(),
        'delegatedBy': str(body.get('delegated_by') or '').lower(),
        'delivery': body.get('delivery') or '',
        'familyId': body.get('family_id') or '',
        'taskId': body.get('task_id') or '',
        'runId': body.get('run_id') or '',
        'version': body.get('version'),
        'submissionBatchId': body.get('submission_batch_id') or '',
        'pipelineBatchId': body.get('pipeline_batch_id') or '',
        'gate': gate_hints(body),
    }

    tasks = as_list(body.get('tasks'))
    if not tasks:
        # The verdict carries a submission-level state and no per-task decision.
        # Recorded as one row, explicitly flagged: never fan it across a batch
        # here, because that is what inflates every downstream count.
        return [dict(base, taskName='', decision='', status='',
                     perTaskDecision=False, findingCodes=[],
                     blockingFindings=None, steps=None, blockedAt='')]

    out = []
    for task in tasks:
        if not isinstance(task, dict):
            continue
        blocking = task.get('blocking_findings')
        out.append(dict(
            base,
            taskName=str(task.get('task') or ''),
            decision=str(task.get('decision') or ''),
            status=str(task.get('status') or ''),
            perTaskDecision=True,
            findingCodes=finding_codes(task),
            blockingFindings=blocking if isinstance(blocking, int) else None,
            steps=task.get('steps') if isinstance(task.get('steps'), int) else None,
            blockedAt=str(task.get('blocked_at') or ''),
        ))
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', default='verdicts.json')
    ap.add_argument('--limit', type=int, help='read only the first N objects (for testing)')
    args = ap.parse_args()

    tok = Token()
    started = time.time()
    objects = list_verdicts(tok)
    listed = time.time() - started
    print(f'listed {len(objects):,} verdict objects in {listed:.1f}s', flush=True)
    if args.limit:
        objects = objects[:args.limit]

    def fetch(obj):
        try:
            return obj, json.loads(read(tok, S.media_url(obj['name'])))
        except Exception as exc:                        # noqa: BLE001
            return obj, {'_error': str(exc)[:200]}

    rows, errors, skipped_schema = [], [], 0
    with ThreadPoolExecutor(max_workers=WORKERS) as pool:
        for done, (obj, body) in enumerate(pool.map(fetch, objects), 1):
            if '_error' in body:
                errors.append({'source': obj['name'], 'error': body['_error']})
                continue
            if body.get('schema') != SCHEMA:
                skipped_schema += 1
            rows.extend(rows_from(body, obj))
            if done % 2000 == 0:
                print(f'  {done:,}/{len(objects):,} objects -> {len(rows):,} rows', flush=True)

    elapsed = time.time() - started
    per_task = [r for r in rows if r['perTaskDecision']]
    no_task = [r for r in rows if not r['perTaskDecision']]

    payload = {
        'generatedAt': datetime.now(timezone.utc).isoformat(timespec='seconds'),
        'bucket': f'gs://{S.BUCKET}/',
        'prefix': PREFIX,
        'schema': SCHEMA,
        'step': '1-raw-verdict-ingest',
        'note': 'Raw rows. No identity, no scope filter, no state collapsing - '
                'those are separate steps so each can be checked alone.',
        'coverage': {
            'objectsListed': len(objects),
            'objectsRead': len(objects) - len(errors),
            'objectsFailed': len(errors),
            'unexpectedSchema': skipped_schema,
            'rows': len(rows),
            'rowsWithPerTaskDecision': len(per_task),
            'rowsWithoutPerTaskDecision': len(no_task),
            'walkSeconds': round(elapsed, 1),
        },
        'errors': errors[:50],
        'rows': rows,
    }
    Path(args.out).write_text(json.dumps(payload, separators=(',', ':')), encoding='utf-8')

    print(f'\nread {len(objects) - len(errors):,}/{len(objects):,} objects in {elapsed:.1f}s')
    print(f'  rows                     : {len(rows):,}')
    print(f'    with a per-task decision: {len(per_task):,}')
    print(f'    without one (flagged)   : {len(no_task):,}')
    print(f'  submission states        : {dict(collections.Counter(r["state"] for r in rows))}')
    print(f'  task decisions           : {dict(collections.Counter(r["decision"] for r in per_task))}')
    print(f'  decided_at inferred      : {sum(1 for r in rows if r["decidedAtInferred"]):,}')
    print(f'  family_id present        : {sum(1 for r in rows if r["familyId"]):,}')
    codes = collections.Counter(c for r in per_task for c in r['findingCodes'])
    print(f'  distinct finding codes   : {len(codes)}  top: {codes.most_common(5)}')
    if errors:
        print(f'  READ ERRORS              : {len(errors)}  first: {errors[0]}')
    print(f'\nwrote {args.out} ({Path(args.out).stat().st_size/1e6:.1f} MB)')


if __name__ == '__main__':
    main()
