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

# Every finalisation cohort in the bucket, counted the way it is actually stored.
# The dashboard used to show only accepted iteration 2, which is one of seven.
COHORTS = [
    ('finalisation_client_qc_accepted_iteration_1', 'task_zip', 'accepted', 'Client QC accepted - iteration 1'),
    ('finalisation_client_qc_accepted_iteration_2', 'task_zip', 'accepted', 'Client QC accepted - iteration 2'),
    ('finalisation_client_qc_rejected_iteration_2', 'extracted', 'rejected', 'Client QC rejected - iteration 2'),
    ('finalization_qc_accepted', 'task_zip', 'accepted', 'QC accepted'),
    ('finalization_qc_rejected', 'run_task', 'rejected', 'QC rejected'),
    ('finalization_unsubmitted_tasks_company_bench', 'flat_zip', 'unsubmitted', 'Unsubmitted - Company Bench'),
    ('hs-finalization-20260904', 'extracted', 'promoted', 'Handshake batch - oracle promoted'),
]
# Classification is keyed by archive sha256, which is the object name, so an
# archive is read once ever. Kept apart from the Harbor scanner cache so the two
# cron jobs never write the same file.
FINALISATION_CACHE = Path('/root/shannon-refresh/finalisation-cache.json')


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


def folder_prefixes(S, tok, prefix):
    """Task folders under a cohort. Delimiter listing returns directories rather
    than objects, which matters: finalization_qc_rejected holds 2.07M objects
    behind about 5k tasks."""
    names, page = [], None
    while True:
        params = {'prefix': prefix, 'delimiter': '/', 'maxResults': 1000, 'fields': 'prefixes,nextPageToken'}
        if page:
            params['pageToken'] = page
        payload = json.loads(S.http(S.API + '?' + urllib.parse.urlencode(params), tok))
        names.extend(payload.get('prefixes', []))
        page = payload.get('nextPageToken')
        if not page:
            return [name[len(prefix):].rstrip('/') for name in names]


def cohort_objects(S, tok, prefix, delimiter=None):
    items, page = [], None
    while True:
        params = {'prefix': prefix, 'maxResults': 1000, 'fields': 'items(name,size,updated),nextPageToken'}
        if delimiter:
            params['delimiter'] = delimiter
        if page:
            params['pageToken'] = page
        payload = json.loads(S.http(S.API + '?' + urllib.parse.urlencode(params), tok))
        items.extend(payload.get('items', []))
        page = payload.get('nextPageToken')
        if not page:
            return items


def archives_by_folder(prefix, items):
    """Canonical task archives only: <task>/<sha>.zip, never review_handoff/."""
    folders = {}
    for item in items:
        name = item['name']
        if not name.endswith('.zip') or '/review_handoff/' in name:
            continue
        parts = name[len(prefix):].split('/')
        if len(parts) != 2 or not parts[0]:
            continue
        folders.setdefault(parts[0], []).append({'sha': parts[1][:-4], 'name': name,
                                                 'size': int(item.get('size') or 0),
                                                 'updated': item.get('updated') or ''})
    return folders


def classify_archive(S, tok, cache, folder, archive):
    """Read the zip central directory, then only its task.toml member."""
    if archive['sha'] in cache:
        return dict(cache[archive['sha']]), False
    url = S.media_url(archive['name'])
    directory = S.central_directory(url, tok, archive['size'])
    key = next((k for k in directory if k.endswith('/task.toml') and k.count('/') == 1), None)
    if key is None:
        key = next((k for k in directory if k.endswith('task.toml')), None)
    if key is None:
        raise ValueError('no task.toml in archive')
    method, compressed, offset = directory[key]
    return S.classify(S.read_entry(url, tok, method, compressed, offset), folder), True


def scan_cohort_tasks(S, tok, cache, prefix, name, label, outcome, errors):
    folders = folder_prefixes(S, tok, prefix)
    archives = archives_by_folder(prefix, cohort_objects(S, tok, prefix))
    work = [(folder, sorted(archives[folder], key=lambda a: a['updated'])[-1])
            for folder in sorted(folders) if archives.get(folder)]

    def classified(pair):
        folder, archive = pair
        try:
            facts, is_new = classify_archive(S, tok, cache, folder, archive)
        except Exception as error:
            return folder, archive, None, str(error)[:160], False
        return folder, archive, facts, None, is_new

    rows, fetched = [], 0
    with ThreadPoolExecutor(max_workers=8) as pool:
        for folder, archive, facts, error, is_new in pool.map(classified, work):
            if error:
                errors.append({'cohort': name, 'folder': folder, 'error': error})
                continue
            if is_new:
                cache[archive['sha']] = facts
                fetched += 1
            rows.append({**facts, 'folder': folder, 'cohort': name, 'cohortLabel': label,
                         'outcome': outcome, 'sha256': archive['sha'], 'sizeBytes': archive['size'],
                         'updated': archive['updated'], 'archives': len(archives[folder])})
    return folders, archives, rows, fetched


def scan_finalisation(S, tok):
    try:
        cache = json.loads(FINALISATION_CACHE.read_text(encoding='utf-8'))
    except Exception:
        cache = {}
    cohorts, tasks, errors, fetched = [], [], [], 0
    for name, layout, outcome, label in COHORTS:
        prefix = 'tasks/%s/' % name
        record = {'prefix': name, 'layout': layout, 'outcome': outcome, 'label': label,
                  'tasks': 0, 'scanned': 0}
        if layout == 'task_zip':
            folders, archives, rows, new = scan_cohort_tasks(S, tok, cache, prefix, name, label, outcome, errors)
            record['tasks'] = len(folders)
            record['archives'] = sum(len(value) for value in archives.values())
            record['scanned'] = len(rows)
            tasks.extend(rows)
            fetched += new
        elif layout == 'extracted':
            record['tasks'] = len(folder_prefixes(S, tok, prefix))
        elif layout == 'run_task':
            record['tasks'] = record['runs'] = len(folder_prefixes(S, tok, prefix))
            record['note'] = 'one task per run, verified on a 25-run sample'
        elif layout == 'flat_zip':
            objects = [item for item in cohort_objects(S, tok, prefix, delimiter='/') if item['name'].endswith('.zip')]
            record['tasks'] = len(objects)
            record['bytes'] = sum(int(item.get('size') or 0) for item in objects)
        else:
            raise SystemExit('Unknown cohort layout: %s' % layout)
        cohorts.append(record)
        print('cohort %-46s %-12s %6d' % (name, outcome, record['tasks']), flush=True)
    try:
        FINALISATION_CACHE.write_text(json.dumps(cache, sort_keys=True), encoding='utf-8')
    except Exception as error:
        print('cache not written: %s' % error, flush=True)
    # A Handshake batch is promoted through its own oracle gate, not client QC,
    # so it is counted and listed but never folded into the accepted total.
    totals = {'accepted': 0, 'rejected': 0, 'unsubmitted': 0, 'promoted': 0}
    for record in cohorts:
        if record['outcome'] in totals:
            totals[record['outcome']] += record['tasks']
    return {'bucket': 'gs://obi-harbor-pipeline/tasks/', 'cohorts': cohorts, 'totals': totals,
            'graded': totals['accepted'] + totals['rejected'], 'tasks': tasks,
            'newArchivesRead': fetched, 'errors': errors[:25]}


def attribute(tasks, trainer_records):
    """Join finalisation tasks to owners by declared task name. Finalisation
    repackages archives, so a bucket sha never equals the trainer record archive
    digest - the name is the only join that works, and it is not proof."""
    owners = {}
    for record in trainer_records:
        key = str(record['task'] or '').strip().lower().replace('harbor/', '')
        if key:
            owners.setdefault(key, set()).add(record['trainer'])
    for row in tasks:
        key = str(row.get('declared_short') or row.get('folder') or '').strip().lower()
        candidates = sorted(owners.get(key) or ())
        row['owner'] = candidates[0] if len(candidates) == 1 else None
        row['ownerContested'] = len(candidates) > 1
        row['ownerBasis'] = 'name match' if len(candidates) == 1 else 'contested' if candidates else 'unattributed'
    return tasks


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
    finalisation = scan_finalisation(S, tok)
    attribute(finalisation['tasks'], trainer_records)
    payload = {'schemaVersion': 3, 'generatedAt': datetime.now(timezone.utc).isoformat(), 'source': 'gs://obi-harbor-pipeline/trainer/',
               'current': latest_families(cycles), 'historical': cycles, 'legacy': legacy,
               'trainerRecords': trainer_records, 'finalisation': finalisation,
               'coverage': {'objectsRead': len(objects), 'trainerRecordsRead': len(owner_objects), 'historySnapshots': snapshots, 'currentScope': 'Latest evaluation cycle per owner and family; unevaluated uploads excluded', 'historyScope': 'Evaluation cycles, not every status transition; legacy QC runs are separate'}}
    output = Path(args.out)
    temporary = output.with_suffix('.tmp')
    temporary.write_text(json.dumps(payload, separators=(',', ':')), encoding='utf-8')
    temporary.replace(output)
    print(json.dumps({**{key: len(payload[key]) for key in ['current', 'historical', 'legacy']},
                      'finalisationTasks': len(finalisation['tasks']), **finalisation['totals']}), flush=True)


if __name__ == '__main__':
    main()
