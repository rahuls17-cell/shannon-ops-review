#!/usr/bin/env python3
"""Which Drive folders become Delivery rows, and what each row may claim.

The Deliveries folder mixes delivered batches with shipments, meta folders,
knowledge work, deprecated cuts and shortcuts, and new folders arrive without
anyone telling this code. The failure that matters is silent: a non-batch
folder published as a delivery, or a real batch quietly dropped. So both
directions are pinned here, together with the promise every row makes - no
trainer, no decision - and the published asset is checked against the same
rules.
"""
import json
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).parent))
from build_drive_deliveries import FOLDER_MIME, batch_label, build, normalise  # noqa: E402

failures = []


def check(condition, message):
    if not condition:
        failures.append(message)


# --- which names are batches ------------------------------------------------
for name, label in [('09-25-Batch5.1', 'Batch 5.1'), ('09-29 Batch 9.1', 'Batch 9.1'),
                    ('09-25 Batch6.1', 'Batch 6.1'), ('10-02 Batch 12.1', 'Batch 12.1'),
                    ('09-27 Batch1 CompanyBench 267', 'CompanyBench 1'),
                    ('09-28 Batch3 CompanyBench 963', 'CompanyBench 3')]:
    check(batch_label(name)[0] == label, f'{name!r} should read as {label}, got {batch_label(name)}')

for name in ['[Deprecated] 09-25 Batch5.1 - Partial v1', '08-14-Shipment-V2',
             '08-14-Shipment-V1-[Deprecated]', 'Meta - 0919', '08-28', '08-07-delivery',
             '09-24 KnowledgeWork (207 EKWBench / 320 SVC)', 'EKWBench-0908-Batch1-223']:
    check(batch_label(name)[0] is None, f'{name!r} is not a delivered batch')

# --- what a row may say -----------------------------------------------------
def task(path, **extra):
    stem = pathlib.PurePosixPath(path).stem
    return {'task_id': stem, 'task_name': f'harbor/{stem}-name',
            'package_path': path, 'sha256': 'a' * 64, 'size_bytes': 2_500_000,
            'difficulty': 'harder', 'trial_evidence': {'successes': 1}, **extra}


rows, reason = normalise({'tasks': [task('Non-Connector/Harder/Legal/x.zip'),
                                    task('Real Connector/Easier/y.zip', difficulty='easier'),
                                    task('Company Bench Zeta/z.zip', difficulty=None, trial_evidence={})]},
                         'Batch 5.1')
check(reason is None, f'a well-formed manifest must be accepted: {reason}')
by = {r['packageName']: r for r in rows or []}
check(by['x']['category'] == 'Non-Connector · Legal' and by['x']['type'] == 'Non-connector',
      'Non-Connector keeps its domain as the second level')
check(by['y']['category'] == 'Real Connector' and by['y']['type'] == 'Connector',
      'connector classes keep the manifest spelling')
check(by['z']['difficulty'] is None and by['z']['glm'] is None and by['z']['bucket'] is None,
      'no difficulty or trials recorded means none claimed, not zero')
check(by['x']['glm'] == 1 and by['x']['bucket'] == '1/4', 'GLM successes carried through')
check(by['x']['task'] == 'x-name',
      'a row is named by its declared name, without the harbor/ prefix, and keeps the package name')
same, _ = normalise({'tasks': [task('Connector/Easier/same.zip', task_name='same')]}, 'Batch 5.1')
check(same[0]['task'] == 'same' and same[0]['packageName'] is None,
      'no package name is kept when it is the declared name')
unnamed, _ = normalise({'tasks': [task('Connector/Easier/ASTR_1.zip', task_name=None)]}, 'Batch 5.1')
check(unnamed[0]['task'] == 'ASTR_1', 'without a declared name the package name is used')
for r in rows or []:
    check(r['trainer'] == 'Unattributed' and r['acceptance'] == 'Pending', 'no trainer, no decision')
    check(r['dates'] == [] and r['priority'] is None and r['qc_result'] is None
          and r['feedback_url'] is None, 'nothing the manifest does not record')
    check(r['sha'] == 'a' * 16 and r['size_mb'] == 2.5, 'hash and size as delivered')

for manifest, why in [({}, 'no task list'),
                      ({'tasks': [{'task_name': 'x'}]}, 'a task without a package'),
                      ({'tasks': [task('Connector/Easier/x.zip', sha256='nothex')]}, 'a bad hash'),
                      ({'tasks': [task('Connector/Easier/x.zip'), task('Connector/Harder/x.zip')]},
                       'the same package twice')]:
    check(normalise(manifest, 'Batch 5.1')[0] is None, f'must refuse {why}')

# --- which folders are read -------------------------------------------------
def folder(fid, name, manifest=True):
    kids = [{'id': f'm{fid}', 'name': 'manifest.json', 'mimeType': 'application/json'}] if manifest else []
    return {'id': fid, 'name': name, 'mimeType': FOLDER_MIME, 'children': kids}


def group(fid, name, *inside):
    return {'id': fid, 'name': name, 'mimeType': FOLDER_MIME, 'children': list(inside)}


good = json.dumps({'tasks': [task('Connector/Easier/p.zip')]}).encode()
other = json.dumps({'tasks': [task('Connector/Easier/q.zip')]}).encode()
listing = {'folder': {'id': 'root', 'name': 'Deliveries'}, 'items': [
    group('g1', 'ComputerBench',
          folder('1', '09-25-Batch5.1'), folder('1c', '09-25-Batch5.1 (dedup copy 2026-09-30)'),
          folder('3', '09-16-Batch4.1'),                    # the audit already has 4.1
          folder('4', '10-01 Batch 10.1', manifest=False),  # upload still in progress
          folder('5', '10-02 Batch 11.1'), folder('6', '10-02 Batch11.1 v2'),
          folder('7', '10-03 Batch 12.1'),
          {'id': '8', 'name': '09-08-Batch1', 'mimeType': 'application/vnd.google-apps.shortcut'}),
    group('g2', 'CompanyBench', folder('9', '09-27 Batch1 CompanyBench 267')),
    group('g3', '[Deprecated] Dupes or Partial', folder('2', '[Deprecated] 09-25 Batch5.1 - Partial v1')),
    group('g4', 'EKW / SVC'), group('g5', '[Meta] Meta - 0919'), group('g6', 'Empty group'),
    folder('10', '10-04 Batch 13.1'),                      # a batch still at the top level
]}
manifests = {'m1': good, 'm1c': good, 'm5': good, 'm6': other, 'm9': good, 'm10': good,
             'm7': b'{"tasks": [{"task_name": "x"}]}'}
out = build(listing, manifests, audited_batches={'Batch 4.1'})
check(list(out['counts']['batches']) == ['Batch 13.1', 'Batch 5.1', 'CompanyBench 1'],
      f'batches inside group folders and at the top level publish, got {out["counts"]}')
five = next(b for b in out['batches'] if b['batch'] == 'Batch 5.1')
check(five['folder'] == 'ComputerBench/09-25-Batch5.1' and five['notes'],
      'an identical copy is read once, from the plainer name, and noted')
skipped = {s['name']: s['reason'] for s in out['skipped']}
check('ComputerBench/10-01 Batch 10.1' in skipped, 'a batch folder with no manifest is reported, not dropped')
check('ComputerBench/10-02 Batch 11.1' in skipped and 'ComputerBench/10-02 Batch11.1 v2' in skipped,
      'two folders with different manifests for one batch publish neither')
check('ComputerBench/10-03 Batch 12.1' in skipped, 'an unrecognised layout is skipped with a reason')
ignored = {i['name'] for i in out['ignored']}
check({'[Deprecated] Dupes or Partial', 'EKW / SVC', '[Meta] Meta - 0919', 'Empty group',
       'ComputerBench/09-16-Batch4.1', 'ComputerBench/09-08-Batch1'} <= ignored,
      f'deprecated, meta and knowledge-work groups, audited batches and shortcuts are ignored: {ignored}')
check(not any(b['folder'].startswith('[Deprecated]') for b in out['batches']),
      'nothing inside a deprecated group is read')

# --- the live read, against a fake Drive -------------------------------------
# The VM is the only place with credentials, so the request side is exercised
# here instead: pagination is followed, only batch-like folders are opened, and
# a manifest that has not changed is not downloaded twice.
import tempfile                                   # noqa: E402
import urllib.parse                               # noqa: E402
import build_drive_deliveries as bdd              # noqa: E402

tree = {'root': [{'id': 'b5', 'name': '09-25-Batch5.1', 'mimeType': FOLDER_MIME, 'modifiedTime': 't'},
                 {'id': 'meta', 'name': 'Meta - 0919', 'mimeType': FOLDER_MIME, 'modifiedTime': 't'},
                 {'id': 'cb', 'name': 'CompanyBench', 'mimeType': FOLDER_MIME, 'modifiedTime': 't'}],
        'b5': [{'id': 'm5', 'name': 'manifest.json', 'mimeType': 'application/json', 'modifiedTime': 'v1'}],
        'cb': [{'id': 'cb1', 'name': '09-27 Batch1 CompanyBench 267', 'mimeType': FOLDER_MIME, 'modifiedTime': 't'}],
        'cb1': [{'id': 'mcb1', 'name': 'manifest.json', 'mimeType': 'application/json', 'modifiedTime': 'v1'}],
        'meta': [{'id': 'nope', 'name': 'manifest.json', 'mimeType': 'application/json', 'modifiedTime': 'v1'}]}
calls = []


def fake_get(url, token):
    calls.append(url)
    parsed = urllib.parse.urlparse(url)
    query = urllib.parse.parse_qs(parsed.query)
    if query.get('alt') == ['media']:
        return good
    if 'q' in query:
        parent = query['q'][0].split("'")[1]
        files = tree[parent]
        if parent == 'root' and 'pageToken' not in query:      # two pages
            return json.dumps({'files': files[:1], 'nextPageToken': 'p2'}).encode()
        return json.dumps({'files': files[1:] if parent == 'root' else files}).encode()
    return json.dumps({'id': 'root', 'name': 'Deliveries'}).encode()


real_get, bdd.drive_get = bdd.drive_get, fake_get
try:
    with tempfile.TemporaryDirectory() as cache:
        listing, got = bdd.snapshot_from_drive('root', 'token', cache=cache)
        check([i['name'] for i in listing['items']] == ['09-25-Batch5.1', 'Meta - 0919', 'CompanyBench'],
              'both pages of the folder listing are read')
        check(set(got) == {'m5', 'mcb1'},
              'batch folders are opened, also one level inside a group; ignored folders are not')
        bdd.save_snapshot(cache, listing, got)
        downloads = sum('alt=media' in c for c in calls)
        bdd.snapshot_from_drive('root', 'token', cache=cache)
        check(sum('alt=media' in c for c in calls) == downloads, 'an unchanged manifest is reused')
        tree['b5'][0]['modifiedTime'] = 'v2'
        bdd.snapshot_from_drive('root', 'token', cache=cache)
        check(sum('alt=media' in c for c in calls) == downloads + 1, 'a changed manifest is read again')
finally:
    bdd.drive_get = real_get

# --- the published asset ----------------------------------------------------
asset = pathlib.Path(__file__).resolve().parent.parent / 'assets' / 'drive-deliveries.json'
if asset.exists():
    blob = json.loads(asset.read_text(encoding='utf-8'))
    audit = json.loads((asset.parent / 'delivery-audit.json').read_text(encoding='utf-8'))
    audited = {r['batch'] for r in audit['rows']}
    published = {r['batch'] for r in blob['rows']}
    check(not (published & audited), f'batches listed twice: {sorted(published & audited)}')
    check(sum(blob['counts']['batches'].values()) == len(blob['rows']), 'batch counts add up')
    check(all(r['trainer'] == 'Unattributed' and r['acceptance'] == 'Pending' for r in blob['rows']),
          'published Drive rows carry no trainer and no decision')
    check(not any('@' in json.dumps(r) for r in blob['rows']), 'no email address in a Drive row')
    per = {}
    for r in blob['rows']:
        per.setdefault(r['batch'], set()).add(r.get('packageName') or r['task'])
    for b in blob['batches']:
        check(len(per.get(b['batch'], ())) == b['tasks'], f"{b['batch']}: one row per package")
    print(f"published: {len(blob['rows']):,} rows from {len(blob['batches'])} batches, "
          f"{len(blob['skipped'])} skipped, {len(blob['ignored'])} ignored")

if failures:
    print('\n'.join(f'FAIL {f}' for f in failures))
    sys.exit(1)
print('drive deliveries checks passed: folder rules, row contract, published asset')
