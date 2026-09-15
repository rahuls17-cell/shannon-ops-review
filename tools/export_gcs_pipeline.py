"""Read-only export on the Harbor VM. No bucket writes or credential export."""
import argparse
import json
import sys
import urllib.parse
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path

SCANNER = '/root/harbor_gce/delivery-candidates-20260908-codex/pipeline-dashboard'
sys.path.insert(0, SCANNER)


def iso(value):
    if isinstance(value, (int, float)):
        return datetime.fromtimestamp(value, timezone.utc).isoformat()
    return str(value or '')


def status_of(cycle):
    submission = cycle.get('submission') or {}
    verdict = submission.get('pipeline_verdict') or {}
    explicit = {str(submission.get('status') or '').lower(), str(verdict.get('decision') or '').lower()}
    if 'accepted' in explicit and 'rejected' in explicit:
        return 'Conflicting verdict'
    if 'accepted' in explicit:
        return 'Accepted'
    if 'rejected' in explicit:
        return 'Rejected'
    return str(cycle.get('status') or 'Unknown').replace('_', ' ').title()


def category_of(task, task_type=''):
    if task_type and task_type != 'Unknown':
        return task_type
    name = str(task or '').lower()
    prefix = name.split('-', 1)[0] if '-' in name else ''
    return {'code': 'Code', 'fin': 'Finance', 'health': 'Health', 'law': 'Law', 'gen': 'General', 'bus': 'Business'}.get(prefix, 'General')


def latest_families(cycles):
    latest = {}
    for row in cycles:
        key = (row['ownerKey'], row['familyId'] or row['taskId'])
        if not key[1]:
            raise ValueError('Evaluation lacks a stable task identity')
        rank = (row['sequence'], row['submittedAt'], row['attempt'], row['id'])
        if key not in latest or rank > latest[key][0]:
            latest[key] = (rank, row)
    return [value[1] for value in latest.values()]


def main():
    import scan_bucket as S
    parser = argparse.ArgumentParser()
    parser.add_argument('--out', required=True)
    args = parser.parse_args()
    tok = S.token()
    def listing(prefix):
        items, page = [], None
        while True:
            params = {'prefix': prefix, 'maxResults': 1000, 'fields': 'items(name,generation,updated),nextPageToken'}
            if page:
                params['pageToken'] = page
            payload = json.loads(S.http(S.API + '?' + urllib.parse.urlencode(params), tok))
            items.extend(payload.get('items', []))
            page = payload.get('nextPageToken')
            if not page:
                return items
    objects = []
    for prefix, suffix in [('trainer/evaluations/', '/ledger.json'), ('trainer/history/', '/snapshot.json')]:
        objects.extend(item for item in listing(prefix) if item['name'].endswith(suffix))
    owner_objects = [item for item in listing('trainer/records/tasks/') if item['name'].endswith('.json')]
    print('Scanning %d ledger/history objects and %d trainer records' % (len(objects), len(owner_objects)), flush=True)
    def read(item):
        url = S.API + '/' + urllib.parse.quote(item['name'], safe='') + '?' + urllib.parse.urlencode({'alt': 'media', 'generation': item['generation']})
        document = json.loads(S.http(url, tok))
        owner_key = item['name'].split('/')[2]
        if item['name'].endswith('/ledger.json'):
            rows = []
            for c in document['cycles']:
                submission = c.get('submission') or {}
                rows.append({'id': c['run_id'], 'taskId': c.get('task_id'), 'familyId': c.get('family_id'), 'ownerKey': owner_key,
                             'task': c.get('task_name') or c.get('task_id'), 'trainer': submission.get('submitted_by') or '',
                             'status': status_of(c), 'rawStatus': c.get('status'), 'sequence': int(c.get('sequence') or 0),
                             'attempt': int(c.get('attempt') or 0), 'submittedAt': iso(c.get('enqueued_at') or c.get('started_at')),
                             'updatedAt': iso((submission.get('pipeline_verdict') or {}).get('updated_at') or c.get('completed_at')),
                             'taskType': category_of(c.get('task_name') or c.get('task_id')), 'date': iso(c.get('enqueued_at') or c.get('started_at'))[:10]})
            return 'cycles', owner_key, '', rows, None
        email = str(document.get('owner_email') or '').lower()
        rows = []
        for wrapper in document.get('records', []):
            record = wrapper.get('record') or {}
            if wrapper.get('kind') != 'run':
                continue
            stamp = iso(record.get('created_at'))
            rows.append({'id': wrapper.get('object_name'), 'taskId': record.get('task_id'), 'task': record.get('task_name') or record.get('task_id') or 'Unknown',
                         'trainer': email, 'status': str(record.get('status') or 'Unknown').replace('_', ' ').title(),
                         'taskType': record.get('mode') or 'Unknown', 'submittedAt': stamp, 'date': stamp[:10],
                         'updatedAt': iso(record.get('finished_at')), 'ownerKey': owner_key})
        return 'legacy', owner_key, email, rows, {'ownerKey': owner_key, 'lastSuccess': document.get('last_success_at'), 'frozenAt': document.get('frozen_at'), 'hasError': bool(document.get('error'))}
    cycles, legacy, owners, snapshots = [], [], {}, []
    with ThreadPoolExecutor(max_workers=8) as pool:
        for index, (kind, key, email, rows, snapshot) in enumerate(pool.map(read, objects), 1):
            (cycles if kind == 'cycles' else legacy).extend(rows)
            if email:
                owners[key] = email
            if snapshot:
                snapshots.append(snapshot)
            if index % 100 == 0:
                print('Read %d/%d' % (index, len(objects)), flush=True)
    def read_owner_record(item):
        url = S.API + '/' + urllib.parse.quote(item['name'], safe='') + '?' + urllib.parse.urlencode({'alt': 'media', 'generation': item['generation']})
        document = json.loads(S.http(url, tok))
        email = str(document.get('owner_email') or '').lower()
        task_name = document.get('task_name')
        family_id = document.get('family_id')
        if not task_name:
            for wrapper in document.get('records', []):
                record = wrapper.get('record') or {}
                task_name = task_name or record.get('task_name')
                family_id = family_id or record.get('family_id')
        return {'task': task_name, 'familyId': family_id, 'trainer': email, 'sourceObject': item['name']}
    trainer_records = []
    with ThreadPoolExecutor(max_workers=8) as pool:
        for record in pool.map(read_owner_record, owner_objects):
            if record['task'] and record['trainer']:
                trainer_records.append(record)
    for row in cycles:
        row['trainer'] = owners.get(row['ownerKey']) or row['trainer'].lower()
    def unique(rows):
        out = {}
        for row in rows:
            key = (row['ownerKey'], row['id'])
            if not row['id'] or (key in out and out[key] != row):
                raise ValueError('Missing or conflicting run identity')
            out[key] = row
        return list(out.values())
    cycles, legacy = unique(cycles), unique(legacy)
    payload = {'schemaVersion': 2, 'generatedAt': datetime.now(timezone.utc).isoformat(), 'source': 'gs://obi-harbor-pipeline/trainer/',
               'current': latest_families(cycles), 'historical': cycles, 'legacy': legacy,
               'trainerRecords': trainer_records,
               'coverage': {'objectsRead': len(objects), 'trainerRecordsRead': len(owner_objects), 'historySnapshots': snapshots, 'currentScope': 'Latest evaluation cycle per owner and family; unevaluated uploads excluded', 'historyScope': 'Evaluation cycles, not every status transition; legacy QC runs are separate'}}
    output = Path(args.out)
    temporary = output.with_suffix('.tmp')
    temporary.write_text(json.dumps(payload, separators=(',', ':')), encoding='utf-8')
    temporary.replace(output)
    print(json.dumps({key: len(payload[key]) for key in ['current', 'historical', 'legacy']}), flush=True)


if __name__ == '__main__':
    main()
