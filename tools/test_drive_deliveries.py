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
from build_drive_deliveries import FOLDER_MIME, batch_label, bench_of, build, normalise  # noqa: E402

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

# --- which bench a delivered task belongs to --------------------------------
# By where it was delivered, never by who made it.
for label, klass, declared, bench in [
        ('CompanyBench 1', 'Connector', 'Company Bench', 'company'),
        ('CompanyBench 3', 'Company Bench Zeta', 'company bench zeta', 'company'),
        ('CompanyBench 3', 'Synthetic', 'computer bench synth', 'computer'),  # its manifest says so
        ('CompanyBench 2', 'Connector', None, 'company'),
        ('Batch 9.1', 'CompanyBench', 'company bench aster', 'company'),
        ('Batch 6.1', 'Connector', 'company bench aster', 'computer'),       # a Computer Bench delivery
        ('Batch 5.1', 'Real Connector', None, 'computer'),
        ('Batch 5.1', 'Non-Connector', None, 'computer')]:
    got = bench_of(label, klass, {'bench_type': declared} if declared else {})
    check(got == bench, f'{label} / {klass} / {declared}: expected {bench}, got {got}')
# Where the zip actually sits on Drive decides inside a Computer Bench batch: 5.1,
# 6.1 and 7.1 file their Company Bench connectors in CompanyBench/ while their
# manifests say Connector/.
for label, klass, location, bench in [
        ('Batch 6.1', 'Connector', 'CompanyBench/Harder', 'company'),
        ('Batch 5.1', 'Connector', 'Company Bench/Easier', 'company'),
        ('Batch 5.1', 'Real Connector', 'Real Connector/Easier', 'computer'),
        ('Batch 9.1', 'CompanyBench', 'Synthetic/Harder', 'computer'),
        ('CompanyBench 1', 'Connector', 'Connector/Harder', 'company')]:
    got = bench_of(label, klass, {}, location)
    check(got == bench, f'{label} at {location}: expected {bench}, got {got}')
from build_drive_deliveries import locate  # noqa: E402
spots = locate([{'package_path': 'Connector/Easier/ASTR_1.zip', 'task_id': 'ASTR_1', 'task_name': 'harbor/nice-name'},
                {'package_path': 'Connector/Easier/b.zip', 'original_filename': 'b-orig.zip'},
                {'package_path': 'Connector/Easier/gone.zip'}],
               [{'name': 'nice-name.zip', 'path': 'CompanyBench/Easier'}, {'name': 'b-orig.zip', 'path': 'Synthetic'}])
check(spots == {0: 'CompanyBench/Easier', 1: 'Synthetic'},
      f'a zip saved under its declared or original name is still found, got {spots}')

# --- which folders are read -------------------------------------------------
def folder(fid, name, manifest=True):
    kids = [{'id': f'm{fid}', 'name': 'manifest.json', 'mimeType': 'application/json'}] if manifest else []
    return {'id': fid, 'name': name, 'mimeType': FOLDER_MIME, 'children': kids}


def dedup(fid, name, packages):
    item = folder(fid, name)
    item['files'] = [{'name': n, 'path': 'CompanyBench/Easier' if n == 'a.zip' else 'Synthetic'} for n in packages]
    return item


def group(fid, name, *inside):
    return {'id': fid, 'name': name, 'mimeType': FOLDER_MIME, 'children': list(inside)}


good = json.dumps({'tasks': [task('Connector/Easier/p.zip')]}).encode()
other = json.dumps({'tasks': [task('Connector/Easier/q.zip')]}).encode()
three = json.dumps({'tasks': [task('Connector/Easier/a.zip'), task('Connector/Easier/b.zip'),
                              task('Synthetic/Harder/c.zip')]}).encode()
listing = {'folder': {'id': 'root', 'name': 'Deliveries'}, 'items': [
    group('g1', 'ComputerBench',
          folder('1', '09-25-Batch5.1'), dedup('1c', '09-25-Batch5.1 (dedup copy 2026-09-30)', ['a.zip', 'c.zip']),
          folder('14', '10-05 Batch 14.1'), folder('14c', '10-05 Batch 14.1 dedup'),  # packages never listed
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
manifests = {'m1': three, 'm1c': three, 'm14': good, 'm14c': good,
             'm5': good, 'm6': other, 'm9': good, 'm10': good,
             'm7': b'{"tasks": [{"task_name": "x"}]}'}
out = build(listing, manifests, audited_batches={'Batch 4.1'})
check(sorted(out['counts']['batches']) == ['Batch 13.1', 'Batch 5.1', 'CompanyBench 1'],
      f'batches inside group folders and at the top level publish, got {out["counts"]}')
five = next(b for b in out['batches'] if b['batch'] == 'Batch 5.1')
check(five['folder'] == 'ComputerBench/09-25-Batch5.1 (dedup copy 2026-09-30)',
      'the dedup copy is the batch, over the folder it was copied from')
check(five['tasks'] == 2 and five['leftOut'] == ['b.zip'] and len(five['notes']) == 2,
      f'a package taken out of the dedup copy is left out and named, got {five}')
ids = [r['id'] for r in out['rows'] if r['batch'] == 'Batch 5.1']
check(ids == ['B51-001', 'B51-003'], f'ids keep the manifest numbering when a package is left out, got {ids}')
benches = {r['packageName']: (r['bench'], r['driveFolder']) for r in out['rows'] if r['batch'] == 'Batch 5.1'}
check(benches == {'a': ('company', 'CompanyBench/Easier'), 'c': ('computer', 'Synthetic')},
      f'the Drive folder a zip sits in decides its bench, got {benches}')
skipped = {s['name']: s['reason'] for s in out['skipped']}
check('ComputerBench/10-01 Batch 10.1' in skipped, 'a batch folder with no manifest is reported, not dropped')
check('ComputerBench/10-02 Batch 11.1' in skipped and 'ComputerBench/10-02 Batch11.1 v2' in skipped,
      'two folders with different manifests for one batch publish neither')
check('ComputerBench/10-03 Batch 12.1' in skipped, 'an unrecognised layout is skipped with a reason')
check('ComputerBench/10-05 Batch 14.1 dedup' in skipped and 'Batch 14.1' not in out['counts']['batches'],
      'a dedup copy whose packages were not listed is not published, and its original is not used instead')
ignored = {i['name'] for i in out['ignored']}
check({'[Deprecated] Dupes or Partial', 'EKW / SVC', '[Meta] Meta - 0919', 'Empty group',
       'ComputerBench/09-16-Batch4.1', 'ComputerBench/09-08-Batch1'} <= ignored,
      f'deprecated, meta and knowledge-work groups, audited batches and shortcuts are ignored: {ignored}')
check(not any(b['folder'].startswith('[Deprecated]') for b in out['batches']),
      'nothing inside a deprecated group is read')

# --- the 3 Oct layout: Company Bench shares filed apart from their batch -----
# CompanyBench/CompanyBench - From Pipeline/Batch N - CompanyBench holds the
# Company Bench packages of Shannon's Batch N. It has no manifest: Batch N's
# manifest lists them. Its zips count for Batch N, filed under CompanyBench/,
# and a package whose zip is on Drive nowhere is left out.
def listed(fid, name, files, manifest=True):
    item = folder(fid, name, manifest)
    item['files'] = [{'name': n, 'path': p} for n, p in files]
    return item


nine = json.dumps({'tasks': [task('Non-Connector/Harder/Legal/n.zip'), task('CompanyBench/Easier/k.zip'),
                             task('Synthetic/Harder/s.zip'), task('Connector/Easier/gone.zip')]}).encode()
one = json.dumps({'tasks': [task('Connector/Easier/u.zip'), task('Non-Connector/Easier/v.zip')]}).encode()
cb = json.dumps({'tasks': [task('Connector/Easier/w.zip'), task('Connector/Easier/dup.zip')]}).encode()
layout = {'folder': {'id': 'root', 'name': 'Deliveries'}, 'items': [
    group('c', 'ComputerBench (NC 1616 RC 72 S 94)',
          listed('b9', '09-29 Batch 9.1 (NC 297 RC 0 S 13)',
                 [('n.zip', 'Non-Connector (NC 297 RC 0 S 0)/Harder'), ('s.zip', 'Synthetic (NC 0 RC 0 S 13)/Harder')]),
          listed('b1', '09-08-Batch1 (NC 46 RC 0 S 0)', [('v.zip', 'Non-Connector (NC 46 RC 0 S 0)/Easier')])),
    group('k', 'CompanyBench 1673',
          listed('cb1', '09-27 Batch1 CompanyBench 252', [('w.zip', 'Connector/Easier')]),
          group('p', 'CompanyBench - From Pipeline 350',
                listed('s9', 'Batch 9.1 - CompanyBench 89', [('k.zip', 'Easier 43')], manifest=False),
                listed('s1', 'Batch 1 - CompanyBench 12', [('u.zip', 'Easier')], manifest=False))),
    group('d', '[Deprecated]', listed('x', 'CompanyBench 1678 - removed duplicates', [('dup.zip', '')])),
]}
out = build(layout, {'mb9': nine, 'mb1': one, 'mcb1': cb}, audited_batches={'Batch 1'})
check(sorted(out['counts']['batches']) == ['Batch 9.1', 'CompanyBench 1'],
      f'a share folder is not a batch of its own, got {out["counts"]}')
b9 = {r['packageName']: (r['bench'], r['driveFolder']) for r in out['rows'] if r['batch'] == 'Batch 9.1'}
check(b9 == {'n': ('computer', 'Non-Connector (NC 297 RC 0 S 0)/Harder'), 'k': ('company', 'CompanyBench/Easier 43'),
             's': ('computer', 'Synthetic (NC 0 RC 0 S 13)/Harder')},
      f'a share folder\'s zips count for its batch, as Company Bench; got {b9}')
nine_batch = next(b for b in out['batches'] if b['batch'] == 'Batch 9.1')
check(nine_batch['leftOut'] == ['gone.zip'], 'a package no longer on Drive is left out and named')
check(out['counts']['batches']['CompanyBench 1'] == 1,
      'a package moved to [Deprecated] as a duplicate is no longer published')
check(out['auditedCompany'] == [{'batch': 'Batch 1', 'task': 'u-name', 'packageName': 'u',
                                 'driveFolder': 'CompanyBench/Easier'}],
      f"an audited batch's Company Bench share is named for the page, got {out['auditedCompany']}")
check(not any(r['batch'] == 'Batch 1' for r in out['rows']), 'an audited batch keeps its audited rows')
check(not any('CompanyBench 9.1' in str(s) for s in out['skipped']),
      'a share folder is never reported as a CompanyBench batch with no manifest')

# A zip filed in a share folder that its batch's manifest does not list - a
# CompanyBench 3 package put under "Batch 3 - CompanyBench" - counts for the
# CompanyBench batch whose manifest lists it, and is not left out there.
three_cb = json.dumps({'tasks': [task('Company Bench Zeta/z1.zip'), task('Company Bench Zeta/z2.zip')]}).encode()
three = json.dumps({'tasks': [task('Non-Connector/Easier/t.zip')]}).encode()
stray = {'folder': {'id': 'root', 'name': 'Deliveries'}, 'items': [
    group('c', 'ComputerBench', listed('b3', '09-08-Batch3 (NC 58 RC 0 S 0)', [('t.zip', 'Non-Connector/Easier')])),
    group('k', 'CompanyBench 1673',
          listed('cb3', '09-28 Batch3 CompanyBench 961', [('z1.zip', 'Company Bench 961')]),
          group('p', 'CompanyBench - From Pipeline 350',
                listed('s3', 'Batch 3 - CompanyBench 6', [('z2.zip', 'Harder 6')], manifest=False))),
]}
out = build(stray, {'mb3': three, 'mcb3': three_cb}, audited_batches={'Batch 3'})
check(out['counts']['batches'].get('CompanyBench 3') == 2,
      f'a stray zip counts for the CompanyBench batch that lists it, got {out["counts"]}')
cb3 = next(b for b in out['batches'] if b['batch'] == 'CompanyBench 3')
check(cb3['leftOut'] == [] and any('filed under Batch 3' in n for n in cb3['notes']),
      f'and is not left out, with a note saying where it is filed: {cb3}')
check(out['auditedCompany'] == [], 'a stray zip is not taken for the audited batch it is filed under')

# Batches 1 to 4.1 on Drive carry older manifest layouts: a wrapper folder
# first, and in Batches 1 to 3 the difficulty before the class; connectors as
# connector.services, as {name, image}, or as one string joined by |.
bdd_c = __import__('build_drive_deliveries')
check(bdd_c.package_parts('finalization_qc_accepted_zipped/harder/non-connector/engineering/a.zip')
      == ['non-connector', 'harder', 'Engineering', 'a.zip'],
      'a Batch 1-3 path reads as class, difficulty, domain')
# Batch 11.1 groups by bench, counts in the names.
check(bdd_c.class_of('Aster 180', {}) == 'Aster', 'Aster 180 is the Aster class')
check(bdd_c.class_of('Company Bench 4', {}) == 'CompanyBench', 'Company Bench 4 is Company Bench')
check(bdd_c.class_of('Computer Bench (NC 0 RC 0 S 90)', {'bench_type': 'computer bench synthetic'}) == 'Synthetic',
      'a Computer Bench group folder takes its class from the bench_type')
check(bdd_c.class_of('Non-Connector', {}) == 'Non-Connector', 'the older class folders read as before')
check(bdd_c.class_of('Computer Bench (NC 0 RC 0 S 90)', {'tracker_family': 'Synthetic (old)'}) == 'Synthetic',
      'with no bench_type, the tracker_family says the class')
# Batch 12.1 puts the class, with its count, under the bench group.
check(bdd_c.package_parts('Computer Bench (NC 39 RC 0 S 99)/Synthetic 99/Easier 34/a.zip') == ['Synthetic', 'Easier 34', 'a.zip'],
      'a counted class folder under a bench group names the class')
check(bdd_c.package_parts('Computer Bench (NC 39 RC 0 S 99)/Non-Connector 39/Harder 20/b.zip') == ['Non-Connector', 'Harder 20', 'b.zip'],
      'and its difficulty folder is not read as a domain')
check(bdd_c.package_parts('Aster 145/Easier 63/c.zip') == ['Aster 145', 'Easier 63', 'c.zip'], 'an Aster group is unchanged')
check([bdd_c.domain_of_name(n) for n in ('code-c39-x', 'tech-t1-y', 'fin-f2', 'health-h1', 'law-l3', 'edu-e1', 'gen-g9', 'x')]
      == ['Engineering', 'Engineering', 'Finance', 'Health', 'Legal', 'Other', 'Other', 'Other'],
      'a non-connector domain from the task name prefix')
check(bdd_c.bench_of('Batch 11.1', 'Aster', {}) == 'company', 'Aster is Company Bench')
check(bdd_c.bench_of('Batch 11.1', 'Aster', {}, 'Aster 180/Easier 89') == 'company', 'an Aster folder is Company Bench')
check(bdd_c.bench_of('Batch 11.1', 'Synthetic', {}, 'Computer Bench (NC 0 RC 0 S 90)/Easier 27') == 'computer',
      'a Computer Bench folder is Computer Bench')
check(bdd_c.harness_of({'bench_type': 'aster (company & computer bench, real)'}, 'Aster') == 'aster', 'Aster harness')
check(bdd_c.harness_of({'bench_type': 'company bench zeta (real)'}, 'CompanyBench') == 'zeta', 'Zeta harness')
check(bdd_c.package_parts('computerbench-batch-5/Connector/Easier/b.zip') == ['Connector', 'Easier', 'b.zip'],
      'a Batch 4.1 path drops its wrapper folder')
check(bdd_c.connector_names({'connector': {'services': ['notion-gym']}}) == ['notion-gym'], 'connector.services is read')
check(bdd_c.connector_names({'connector_services': 'confluence-gym | email-gym'}) == ['confluence-gym', 'email-gym'],
      'a | joined string is split')
check(bdd_c.connector_names({'connector_services': [{'name': 'slack-gym', 'image': 'x'}]}) == ['slack-gym'], 'object entries give names')
check(bdd_c.harness_of({'connector_services': [{'name': 'gws-gym', 'image': 'kuzphi/connectors-harness-aster:v6'}]}) == 'aster',
      "a connector's own image on Drive names the harness")

# A CompanyBench batch's task is placed by the image its manifest records, not by
# the label written from it: CompanyBench 3 labels 9 tasks computer bench synth on
# obi-benchmark@sha256:e76ff56a..., the Zeta V4 image.
v4 = ('image reference us-central1-docker.pkg.dev/delivery-g-obi/connectors-rl-gym/obi-benchmark@sha256:'
      'e76ff56a791502397586f102f90902e4a1aa0f9534625605bd31e64ed9f20f24 (environment/Dockerfile final FROM)')
mislabelled = {'bench_type': 'computer bench synth', 'bench_basis': v4}
check(bdd_c.bench_of('CompanyBench 3', 'Synthetic', mislabelled) == 'company', 'the recorded Zeta V4 image wins over the label')
check(bdd_c.harness_of(mislabelled) == 'zeta', 'and names the harness')
check(bdd_c.bench_of('CompanyBench 3', 'Synthetic', {'bench_type': 'computer bench synth'}) == 'computer',
      'with no image recorded the label still decides')
check(bdd_c.bench_of('CompanyBench 3', 'Synthetic', {'bench_type': 'computer bench synth',
      'bench_basis': 'image reference kuzphi/connectors-harness@sha256:b1374cd8a392ea66f9a649e700a1498e8fcb03ee35776362db7cc15dc3049b89'}) == 'computer',
      'a recorded Computer Bench image keeps a task on the Computer bench')

# The class a Drive folder names wins over the manifest's folder: Batch 10.1's
# CompanyBench folder became "Real ComputerBench" in the 3 Oct layout.
import build_drive_deliveries as bdd_classes      # noqa: E402
check(bdd_classes.folder_class('Real ComputerBench (NC 0 RC 37 S 0)/Easier 24') == 'Real Connector', 'Real ComputerBench is Real Connector')
check(bdd_classes.folder_class('Synthetic ComputerBench (NC 0 RC 0 S 21)/Harder') == 'Synthetic', 'Synthetic ComputerBench is Synthetic')
check(bdd_classes.folder_class('Non-Connector (NC 297 RC 0 S 0)/Harder/Legal') == 'Non-Connector', 'counts in brackets are dropped')
check(bdd_classes.folder_class('Easier 43') is None and bdd_classes.folder_class(None) is None, 'a difficulty folder names no class')
ten = json.dumps({'tasks': [task('CompanyBench/Easier/r.zip', bench_type='company bench aster')]}).encode()
rows, _ = normalise(json.loads(ten), 'Batch 10.1', [{'name': 'r.zip', 'path': 'Real ComputerBench (NC 0 RC 37 S 0)/Easier 24'}])
check(rows[0]['bench'] == 'computer' and rows[0]['category'] == 'Real Connector' and rows[0]['type'] == 'Connector',
      f"a package filed under Real ComputerBench is Computer Bench Real Connector, got {rows[0]['bench'], rows[0]['category']}")

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
        'cb': [{'id': 'cb1', 'name': '09-27 Batch1 CompanyBench 267', 'mimeType': FOLDER_MIME, 'modifiedTime': 't'},
               {'id': 'cbd', 'name': '09-27 Batch2 CompanyBench 110 (dedup copy)', 'mimeType': FOLDER_MIME, 'modifiedTime': 't'},
               {'id': 'pipe', 'name': 'CompanyBench - From Pipeline 350', 'mimeType': FOLDER_MIME, 'modifiedTime': 't'}],
        'pipe': [{'id': 'sh', 'name': 'Batch 9.1 - CompanyBench 89', 'mimeType': FOLDER_MIME, 'modifiedTime': 't'}],
        'sh': [{'id': 'shz', 'name': 'share.zip', 'mimeType': 'application/zip', 'modifiedTime': 't'}],
        'cbd': [{'id': 'mcbd', 'name': 'manifest.json', 'mimeType': 'application/json', 'modifiedTime': 'v1'},
                {'id': 'sub', 'name': 'Connector', 'mimeType': FOLDER_MIME, 'modifiedTime': 't'},
                {'id': 'z0', 'name': 'top.zip', 'mimeType': 'application/zip', 'modifiedTime': 't'}],
        'sub': [{'id': 'sub2', 'name': 'Harder', 'mimeType': FOLDER_MIME, 'modifiedTime': 't'}],
        'sub2': [{'id': 'z1', 'name': 'deep.zip', 'mimeType': 'application/zip', 'modifiedTime': 't'}],
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
        check(set(got) == {'m5', 'mcb1', 'mcbd'},
              'batch folders are opened, also one level inside a group; ignored folders are not')
        copy = next(c for c in listing['items'][2]['children'] if c['id'] == 'cbd')
        check(copy.get('files') == [{'name': 'top.zip', 'path': ''}, {'name': 'deep.zip', 'path': 'Connector/Harder'}],
              f"a batch folder's zips are listed at every depth with their folder, got {copy.get('files')}")
        pipe = next(c for c in listing['items'][2]['children'] if c['id'] == 'pipe')
        share = next(c for c in pipe.get('children', []) if c['id'] == 'sh')
        check(share.get('files') == [{'name': 'share.zip', 'path': ''}],
              'a share folder two levels down - a group inside a group - is opened and its zips listed')
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
    # The current file is the Drive alone, Batches 1 to 4.1 included, read from
    # their Drive folders; the GLM 5.3 cutoff file leaves those to the audit.
    check(audited <= published, f'the current Drive file carries the audited batches from Drive: {sorted(audited - published)}')
    cutoff = asset.with_name('drive-deliveries-glm53-cutoff.json')
    if cutoff.exists():
        before = {r['batch'] for r in json.loads(cutoff.read_text(encoding='utf-8'))['rows']}
        check(not (before & audited), f'the GLM 5.3 cutoff file lists audited batches twice: {sorted(before & audited)}')
    check(sum(blob['counts']['batches'].values()) == len(blob['rows']), 'batch counts add up')
    check(all(r['trainer'] == 'Unattributed' and r['acceptance'] == 'Pending' for r in blob['rows']),
          'published Drive rows carry no trainer and no decision')
    check(not any('@' in json.dumps(r) for r in blob['rows']), 'no email address in a Drive row')
    check(all(r.get('bench') in ('company', 'computer') for r in blob['rows']), 'every Drive row has a bench')
    check(all((r['category'] == 'CompanyBench') == (r['bench'] == 'company') for r in blob['rows']),
          'a row is in the CompanyBench category exactly when it is a Company Bench task')
    for r in blob['rows']:
        if not r['batch'].startswith('Batch'):
            continue
        where = (r.get('driveFolder') or r['packagePath']).split('/')[0]
        # Batch 11.1 files Aster on its own ("Aster 180"): Company Bench, Aster.
        flat = where.lower().replace(' ', '')
        expected = 'company' if flat.startswith('companybench') or flat.startswith('aster') else 'computer'
        if r['bench'] != expected:
            check(False, f"{r['batch']} {r['task']} in {where} should be {expected}, is {r['bench']}")
            break
    per = {}
    for r in blob['rows']:
        per.setdefault(r['batch'], set()).add(r.get('packageName') or r['task'])
    for b in blob['batches']:
        check(len(per.get(b['batch'], ())) == b['tasks'], f"{b['batch']}: one row per package")
    # The source folder is what the Pipeline tab's delivered join reads first.
    for r in blob['rows']:
        if r.get('sourceFolder'):
            check(r.get('sourceKind') == 'pipeline' and r.get('sourcePrefix'),
                  f"{r['batch']} {r['task']}: a source folder must come with its prefix")
    check(any(r.get('sourceFolder') for r in blob['rows']), 'some manifest names the folder it was cut from')
    print(f"published: {len(blob['rows']):,} rows from {len(blob['batches'])} batches, "
          f"{len(blob['skipped'])} skipped, {len(blob['ignored'])} ignored")

# --- the folder a package was cut from -------------------------------------
check(bdd.source_folder({'source_uri': 'gs://obi-harbor-pipeline/tasks/finalisation_client_qc_accepted_iteration_2/ASTR_1/'
                                       + 'a' * 64 + '.zip'}) == ('finalisation_client_qc_accepted_iteration_2', 'ASTR_1'),
      'a pipeline source names its prefix and folder')
check(bdd.source_folder({'source_uri': 'gs://yogesh-harbor-deliveries/ready-for-delivery/x.zip'}) == (None, None),
      'another bucket names no pipeline folder')
check(bdd.source_kind({'source_uri': 'gs://yogesh-harbor-deliveries/ready-for-delivery/x.zip'}) == 'elsewhere',
      'another bucket is elsewhere')
check(bdd.source_kind({'source': 'Final DELIVERY.zip : batch_0/x/'}) == 'elsewhere', 'a named archive is elsewhere')
check(bdd.source_kind({}) is None, 'no source is no source')

# --- Aster or Zeta, for a Company Bench package -----------------------------
check(bdd.harness_of({'bench_type': 'company bench aster'}) == 'aster', 'a declared Aster bench is Aster')
check(bdd.harness_of({'bench_type': 'company bench zeta'}) == 'zeta', 'a declared Zeta bench is Zeta')
check(bdd.harness_of({'image_ref': 'kuzphi/connectors-harness-aster:company-aster-v6-20260917',
                      'bench_type': 'company bench zeta'}) == 'aster', 'the image the manifest names comes first')
check(bdd.harness_of({}, 'Company Bench Zeta') == 'zeta', 'the folder class is the last word')
check(bdd.harness_of({'bench_type': 'computer bench synth'}) is None, 'a computer bench has no company harness')

if failures:
    print('\n'.join(f'FAIL {f}' for f in failures))
    sys.exit(1)
print('drive deliveries checks passed: folder rules, row contract, published asset')
