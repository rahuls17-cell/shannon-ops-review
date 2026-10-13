#!/usr/bin/env python3
"""Read every delivered batch's manifest.json off the shared Drive folder.

What this is for
----------------
The Delivery tab lists what was handed to the client. Batches 1 to 4.1 come
from the delivery audit (assets/delivery-audit.json), which carries trainer
attribution and the client's decisions. Every batch after that is recorded in
one place only: a manifest.json at the top of its folder in the shared
"Deliveries" folder on Drive. That manifest is the receipt of what was sent,
so it is reproduced, not corrected.

This walks the folder, keeps the folders that are delivered batches, reads each
one's manifest and writes one row per delivered package to
assets/drive-deliveries.json. The page adds those rows to the audit's. A new
batch folder is picked up on the next run with nothing else to change.

Which folders count
-------------------
The folder also holds work that is not a delivered batch - shipments, meta,
knowledge work, deprecated partial cuts, zips, sheets, shortcuts - so a folder
is read only when all of these hold:

  * it is a folder, not a shortcut or a file, either at the top of the
    Deliveries folder or one level down inside a group folder such as
    ComputerBench/ or CompanyBench/ (a folder whose name is not itself a batch
    and carries none of the IGNORE words);
  * its name says which batch it is: "Batch 5.1", "Batch6.1", or
    "Batch2 CompanyBench 110", read as "CompanyBench 2" so it never collides
    with Shannon's own Batch 2;
  * its name carries none of the IGNORE words;
  * the batch is not one the audit already lists - those keep their audited
    rows, trainer and decisions included;
  * it has a manifest.json at its top level.

The 3 Oct layout gathered Company Bench into one CompanyBench/ folder, and
under it "CompanyBench - From Pipeline/" holds the Company Bench share of each
Shannon batch, one folder per batch: "Batch 9.1 - CompanyBench 89". Such a
share has no manifest of its own - the batch's manifest lists those packages -
so its zips count for that batch, filed under CompanyBench/. For the audited
Batches 1 to 4.1, which keep their audited rows, the shares are published as
auditedCompany so the page can put those tasks on the Company bench. A zip in a
share that its batch's manifest does not list (CompanyBench 3 packages filed
under "Batch 3 - CompanyBench") counts for whichever CompanyBench batch's
manifest lists it. Group folders nest two levels at most.

A package is published only when its zip is on Drive, whenever the folder's
zips were listed: the cleanup took duplicates out of folders and left their
manifests as they were. The class a Drive folder names - "Real ComputerBench",
"Synthetic ComputerBench", "Non-Connector (NC 297 ...)" - wins over the
manifest's own folder.

Anything else is listed in the output with the reason, so a folder that was
left out can be seen to have been left out. When two folders claim one batch
and one of them is a dedup copy ("dedup" in its name), the dedup copy is the
batch. Otherwise they are read once when their manifests are byte-identical - a
copy made while tidying the folder - and skipped with a warning when they
differ, because then there is no telling which is the receipt.

A dedup copy has had packages taken out of it while its manifest.json was
copied unchanged, so for a dedup copy the packages actually in the folder
decide: a manifest row is published only when its zip is still there, and the
rows left out are listed on the batch.

What each row says
------------------
Only what the manifest records. Each row is named by the name its task.toml
declares (the manifest's task_name, without the harbor/ or obi/ prefix), which
is the task's real name; the package file name - sometimes an id such as
ASTR_101554 or 100601-... - is kept beside it as packageName. The manifest names
no trainer and the client
has not decided anything yet, so every row is Unattributed and Pending, with
no priority, QC result, feedback link or dates. Category is the manifest's own
folder layout - Connector, Real Connector, Synthetic, CompanyBench,
Non-Connector - with the domain as a second level under Non-Connector.

Manifests have been written in several layouts. A layout is accepted when every
task gives a package_path, a sha256 and a size; difficulty and the four-trial
GLM count are optional and read "not recorded" when absent. A manifest that
does not meet that is skipped with a warning rather than guessed at, and the
other batches still publish.

Credentials
-----------
READ ONLY: it issues GET on the Drive API and nothing else. The token comes
from, in order:

  1. DRIVE_CREDENTIALS, a service account key file, via google-auth;
  2. the GCE metadata server, if the VM's service account has a Drive scope;
  3. the gcloud application-default sign-in on this machine, when it was made
     with the drive.readonly scope.

The service account has to be given read access to the Deliveries folder.

    python tools/build_drive_deliveries.py                       # from Drive
    python tools/build_drive_deliveries.py --from-dir <snapshot> # offline
    python tools/build_drive_deliveries.py --save-dir <snapshot> # keep what was read,
                                                                 # and reuse it next run
"""
import argparse
import collections
import json
import os
import pathlib
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from read_task_toml import bench_type                    # noqa: E402

FOLDER = '1_ZA8ckJfXtaGV4OpqZ0a4f5XZbx4brXO'   # "Deliveries"
API = 'https://www.googleapis.com/drive/v3/files'
SCOPE = 'https://www.googleapis.com/auth/drive.readonly'
METADATA = ('http://metadata.google.internal/computeMetadata/v1/'
            'instance/service-accounts/default/token')
FOLDER_MIME = 'application/vnd.google-apps.folder'
# How deep group folders nest: ComputerBench/<batch>, and
# CompanyBench/CompanyBench - From Pipeline/<Batch N - CompanyBench>.
GROUP_DEPTH = 2
# The Company Bench share of a Shannon batch, filed apart from it since the
# 3 Oct layout: "Batch 9.1 - CompanyBench 89". It has no manifest of its own -
# the batch's manifest lists these packages - so its zips belong to Batch 9.1,
# filed under CompanyBench/. A CompanyBench batch proper is named the other way
# round, "09-27 Batch1 CompanyBench 252", and carries its own manifest.
SHARE = re.compile(r'^\s*batch\s*(\d+(?:\.\d+)?)\s*[-\u2013:]\s*company\s*bench', re.I)

# Words that mark a folder as something other than a delivered batch. Matched
# against the name with spaces, dashes and underscores removed.
IGNORE = ('deprecated', 'partial', 'dupes', 'shipment', 'meta', 'knowledgework', 'ekw', 'svc')
NOT_A_BATCH_NAME = 'name does not say which batch it is'
BATCH = re.compile(r'batch\s*(\d+(?:\.\d+)?)', re.I)
SHA256 = re.compile(r'^[0-9a-f]{64}$')
# The bucket object a package was cut from: gs://.../tasks/<prefix>/<folder>/<hash>.zip
SOURCE_OBJECT = re.compile(r'/([0-9a-f]{64})\.zip$')
# The pipeline bucket's own layout, tasks/<prefix>/<folder>/<archive>. A package
# cut from there names the very folder it came from, which is how the Pipeline
# tab tells an accepted folder that has gone out from one that has not.
SOURCE_FOLDER = re.compile(r'^gs://obi-harbor-pipeline/tasks/([^/]+)/([^/]+)/[^/]+$')

# The first level of the Drive layout, spelled the way the manifests spell it.
CLASSES = {'connector': 'Connector', 'real connector': 'Real Connector',
           'synthetic': 'Synthetic', 'non-connector': 'Non-Connector',
           'companybench': 'CompanyBench', 'company bench zeta': 'Company Bench Zeta'}


# ------------------------------------------------------------ the task family
#
# Which family a delivered package is - the tree the dashboard reports:
#
#   Company Bench   - Aster, Zeta
#   Computer Bench
#   +- Connector
#   |   +- Real      - Real Aster, Real Zeta (the manifest's Real Connector class)
#   |   +- Synthetic
#   +- Non-connector
#
# Decided by the manifest and the package, never by the Drive folder the zip
# sits in (folders get renamed and moved; the 3 Oct layout turned Batch 10.1's
# CompanyBench/ into "Real ComputerBench"). In order:
#   1. the image the manifest records - image, image_ref, the image named in
#      bench_basis, or a connector's image - read with the image tracker's rule;
#   2. what the manifest declares - bench_type, tracker_family, bench_group and
#      the class in its own package_path (the packager's grouping, not Drive's);
#   3. the image in the package itself, from the bucket scan (Dockerfile FROM),
#      when the manifest names none - Batch 5.1 lists only "harbor";
#   4. otherwise not classified, and reported rather than guessed.
# A manifest that says real but names neither Aster nor Zeta, with no image to
# settle it, is Real with the harness unknown.
FAMILY_OF_BENCH = {'company bench zeta': 'real-zeta', 'company bench aster': 'real-aster',
                   'computer bench synth': 'synthetic', 'computer bench real': 'real'}
# Computer Bench connector categories; a Company Bench package's category is
# CompanyBench, and the page names it Aster or Zeta as before.
FAMILY_LABELS = {'real-aster': 'Real Aster', 'real-zeta': 'Real Zeta',
                 'real': 'Real · Aster or Zeta not recorded', 'synthetic': 'Synthetic'}
# name -> every Dockerfile image the bucket scan holds under it, and archive
# sha256 -> image; filled by load_package_images().
PACKAGE_IMAGES = {}
OBJECT_IMAGES = {}
# (batch, zip) -> (image, 'delivered zip' | 'earlier copy'), read by hand from the
# package zips on Drive where the bucket has no package (Batch 5.1's Company
# Bench share): tools/data/drive-package-images.tsv. A delivered zip's sha256
# matched the manifest; an earlier copy is the same task before the repair pass,
# used only when the delivered zip was too large to read.
DRIVE_IMAGES = {}
# Task names (every spelling) that Hussain's "Connector Accepted Data Computer
# Bench" sheet lists as Computer Bench: tools/data/computer-bench-sheet.tsv.
# Yogesh's call (2026-10-12): the sheet is the source for what is Computer Bench,
# so a real (Aster or Zeta) task it lists is Computer Bench Real, not Company Bench.
COMPUTER_BENCH_SHEET = set()


def sheet_variants(value):
    v = re.sub(r'\.zip$', '', re.sub(r'^(harbor|obi)/', '', str(value or '').strip().lower()))
    out = {v, v.replace('_', '-')}
    for x in list(out):
        y = re.sub(r'^task-', '', x)
        out |= {y, re.sub(r'-[0-9a-f]{6}-v\d+$', '', y)}
    return {x for x in out if len(x) > 6}


def load_computer_bench_sheet(path):
    COMPUTER_BENCH_SHEET.clear()
    if not path or not pathlib.Path(path).exists():
        return 0
    import csv
    with open(path, encoding='utf-8') as handle:
        rows = list(csv.DictReader(handle, delimiter='	'))
    for row in rows:
        COMPUTER_BENCH_SHEET.update(sheet_variants(row['task']))
    return len(rows)


def on_computer_bench_sheet(*names):
    return any(v in COMPUTER_BENCH_SHEET for n in names for v in sheet_variants(n))


def load_drive_images(path):
    DRIVE_IMAGES.clear()
    if not path or not pathlib.Path(path).exists():
        return 0
    import csv
    with open(path, encoding='utf-8') as handle:
        for row in csv.DictReader(handle, delimiter='	'):
            DRIVE_IMAGES[(row['batch'], row['zip'].lower())] = (row['image'], row['read_from'])
    return len(DRIVE_IMAGES)


def image_of_package(label, zip_name, archive, *names):
    """(image, how it was read). The delivered zip on Drive; the bucket archive
    the manifest names (source_version); the bucket scan by name, only when every
    version under the name runs the same family; an earlier copy on Drive.
    When the bucket holds versions of the task on different families and nothing
    names the delivered one, (None, 'package versions disagree')."""
    drive = DRIVE_IMAGES.get((label, str(zip_name or '').lower()))
    if drive and drive[1] == 'delivered zip':
        return drive[0], 'the image in the package (delivered zip on Drive)'
    if archive and archive in OBJECT_IMAGES:
        return OBJECT_IMAGES[archive], 'the image in the package (the archive the manifest names)'
    bucket = package_image(*names)
    if bucket:
        return bucket, 'the image in the package'
    if drive:
        return drive[0], 'the image in the package (earlier copy on Drive)'
    if package_images(*names):
        return None, 'package versions disagree'
    return None, None


def load_package_images(bench_index=None, toml_reads=None, truth=None):
    """The image each package in the bucket runs, by task name and folder.

    The bench index is keyed by pipeline family; the pipeline's verdict records
    name each family's task, so a task name reaches its image through them. A
    name whose families run different images is left out rather than guessed."""
    PACKAGE_IMAGES.clear()
    OBJECT_IMAGES.clear()
    for path, keyed in ((toml_reads, 'reads'), (bench_index, 'bench')):
        if not path or not pathlib.Path(path).exists():
            continue
        table = json.loads(pathlib.Path(path).read_text(encoding='utf-8')).get(keyed) or {}
        for key, value in table.items():
            image = value.get('image') if isinstance(value, dict) else None
            if not image:
                continue
            name = re.sub(r'^(task|family):', '', key)
            PACKAGE_IMAGES.setdefault(re.sub(r'^(harbor|obi)/', '', name.strip().lower()), set()).add(image)
            archive = SOURCE_OBJECT.search(str(value.get('object') or ''))
            if archive:
                OBJECT_IMAGES.setdefault(archive.group(1), image)
    if truth and bench_index and pathlib.Path(truth).exists() and pathlib.Path(bench_index).exists():
        bench = json.loads(pathlib.Path(bench_index).read_text(encoding='utf-8')).get('bench') or {}
        by_name = collections.defaultdict(set)
        for record in json.loads(pathlib.Path(truth).read_text(encoding='utf-8')).get('tasks') or []:
            image = (bench.get(record.get('id')) or {}).get('image')
            if image and record.get('name'):
                by_name[re.sub(r'^(harbor|obi)/', '', str(record['name']).strip().lower())].add(image)
        for name, images in by_name.items():
            PACKAGE_IMAGES.setdefault(name, set()).update(images)
    return len(PACKAGE_IMAGES)


def package_images(*names):
    """Every image the bucket scan holds under any of these names."""
    found = set()
    for name in names:
        key = re.sub(r'^(harbor|obi)/', '', str(name or '').strip().lower())
        found |= PACKAGE_IMAGES.get(key, set()) if key else set()
    return found


def package_image(*names):
    """One image, when every image under these names is the same family; else None."""
    images = package_images(*names)
    families = {FAMILY_OF_BENCH.get(bench_type(i)) for i in images}
    return sorted(images)[0] if images and len(families) == 1 else None


def family_of(task, klass, image=None, image_from='the image in the package'):
    """(family, how it was decided); family None when nothing says."""
    recorded = [manifest_image(task), task.get('image'),
                *[s.get('image') for s in connector_entries(task) if isinstance(s, dict)]]
    partial = None
    for value in recorded:
        family = FAMILY_OF_BENCH.get(bench_type(str(value))) if value else None
        if family == 'real':
            partial = partial or ('real', 'the image the manifest records')
        elif family:
            return family, 'the image the manifest records'
    if task.get('connector') is False or klass == 'Non-Connector':
        return 'non-connector', 'the manifest'
    declared = ' '.join(str(task.get(k) or '') for k in
                        ('bench_type', 'tracker_family', 'bench_family', 'bench_group', 'bench_class'))
    declared = f'{declared} {klass}'.lower()
    if 'zeta' in declared:
        return 'real-zeta', 'the manifest'
    if 'aster' in declared:
        return 'real-aster', 'the manifest'
    if 'synth' in declared:
        return 'synthetic', 'the manifest'
    real = partial or (('real', 'the manifest') if re.search(r'real|company\s*bench', declared) else None)
    family = FAMILY_OF_BENCH.get(bench_type(str(image))) if image else None
    if family in ('real-aster', 'real-zeta'):
        return family, image_from
    if family == 'synthetic' and not real:
        return 'synthetic', image_from
    if family == 'synthetic' and real:
        return 'real', f'the manifest says real, {image_from} is synthetic'
    if real:
        # Real, the harness not recorded: the connector gyms the manifest lists.
        # Zeta's own SQL gym is Zeta; among real packages only Aster mounts
        # GitHub, Notion, Linear, Outlook, Gmail + Calendar or Google Workspace.
        gyms = [str(g).lower() for g in connector_names(task)]
        if any(re.match(r'^zeta3-sql(-gym)?$', g) for g in gyms):
            return 'real-zeta', 'the connectors the manifest lists'
        if any(re.match(r'^(github|notion|linear|outlook|email-calendar|gws)(-gym)?$', g) for g in gyms):
            return 'real-aster', 'the connectors the manifest lists'
        return real
    if image and family is None:
        # A plain base image runs no connector gym.
        return 'non-connector', 'the image in the package (no connector harness)'
    return None, None


def class_of(head, task):
    """The class a manifest's first package_path folder names.

    Batch 11.1 groups by bench instead of by class, with counts in the names:
    "Aster 180" (Company Bench, Aster), "Company Bench 4" (Company Bench, Zeta)
    and "Computer Bench (NC 0 RC 0 S 90)", whose class the package's own
    bench_type then says (synthetic, real, or non-connector) - or, in Batch
    12.1's manifest, which has no bench_type, its tracker_family.
    """
    known = CLASSES.get(head.lower())
    if known:
        return known
    name = re.sub(r'\(.*?\)', '', head)
    name = re.sub(r'\s+\d+\s*$', '', name).strip().lower()
    if name == 'aster':
        return 'Aster'
    if name in ('company bench', 'companybench'):
        return 'CompanyBench'
    if name in ('computer bench', 'computerbench'):
        declared = str(task.get('bench_type') or task.get('tracker_family') or '').lower()
        if 'synth' in declared:
            return 'Synthetic'
        if 'real' in declared:
            return 'Real Connector'
        return 'Non-Connector' if task.get('connector') is False else 'Connector'
    return head


# ---------------------------------------------------------------- Drive reads

def token_from_key():
    path = os.environ.get('DRIVE_CREDENTIALS')
    if not path:
        raise FileNotFoundError('DRIVE_CREDENTIALS is not set')
    from google.oauth2 import service_account             # noqa: PLC0415
    from google.auth.transport.requests import Request    # noqa: PLC0415
    credentials = service_account.Credentials.from_service_account_file(path, scopes=[SCOPE])
    credentials.refresh(Request())
    return credentials.token


def token_from_metadata():
    request = urllib.request.Request(f'{METADATA}?scopes={urllib.parse.quote(SCOPE)}',
                                     headers={'Metadata-Flavor': 'Google'})
    with urllib.request.urlopen(request, timeout=5) as response:
        return json.load(response)['access_token']


def token_from_gcloud():
    """An access token from the gcloud application-default sign-in on this
    machine. It carries Drive only when that sign-in asked for the Drive scope:

        gcloud auth application-default login --scopes=https://www.googleapis.com/auth/drive.readonly,https://www.googleapis.com/auth/cloud-platform
    """
    import shutil                                          # noqa: PLC0415
    import subprocess                                      # noqa: PLC0415
    gcloud = shutil.which('gcloud') or shutil.which('gcloud.cmd')
    if not gcloud:
        raise FileNotFoundError('gcloud is not on PATH')
    out = subprocess.run([gcloud, 'auth', 'application-default', 'print-access-token'],
                         capture_output=True, text=True, timeout=60, check=True)
    return out.stdout.strip()


def access_token():
    tried = []
    for name, get in (('a service account key', token_from_key),
                      ('the GCE metadata server', token_from_metadata),
                      ('the gcloud application-default sign-in', token_from_gcloud)):
        try:
            value = get()
            if value:
                print(f'authenticated through {name}', file=sys.stderr)
                return value
        except Exception as error:                      # noqa: BLE001
            tried.append(f'  {name}: {type(error).__name__}: {error}')
    raise SystemExit('no Drive credentials this host can use:\n' + '\n'.join(tried))


def drive_get(url, token):
    request = urllib.request.Request(url, headers={'Authorization': f'Bearer {token}'})
    try:
        with urllib.request.urlopen(request, timeout=120) as response:
            return response.read()
    except urllib.error.HTTPError as error:
        raise SystemExit(f'Drive returned HTTP {error.code} for {url.split("?")[0]}: '
                         f'{error.read().decode("utf-8", "replace")[:300]}') from error


def children(folder_id, token):
    """Every item directly inside a folder, following pagination to the end.

    A truncated page would read as a batch having vanished, so a failed page is
    an error rather than the end of the list.
    """
    items, page = [], None
    while True:
        query = {'q': f"'{folder_id}' in parents and trashed = false",
                 'fields': 'nextPageToken,files(id,name,mimeType,modifiedTime)',
                 'pageSize': '1000', 'supportsAllDrives': 'true',
                 'includeItemsFromAllDrives': 'true'}
        if page:
            query['pageToken'] = page
        body = json.loads(drive_get(f'{API}?{urllib.parse.urlencode(query)}', token))
        items.extend(body.get('files', []))
        page = body.get('nextPageToken')
        if not page:
            return items


def snapshot_from_drive(folder_id, token, cache=None):
    """The folder listing, one level into each batch-like folder, plus manifests.

    Returned in the same shape --from-dir reads, so the offline path and the
    live one run exactly the same code from here on. With a cache - a snapshot
    saved by an earlier run - a manifest whose Drive modifiedTime has not moved
    is reused rather than downloaded again, which is what makes running this on
    every ten-minute tick cheap.
    """
    known = {}
    if cache and (pathlib.Path(cache) / 'listing.json').exists():
        previous, saved = snapshot_from_dir(cache)
        for entry in walk(previous.get('items', [])):
            if entry['id'] in saved:
                known[entry['id']] = (entry.get('modifiedTime'), saved[entry['id']])
    meta = json.loads(drive_get(f'{API}/{folder_id}?fields=id,name&supportsAllDrives=true', token))
    items = children(folder_id, token)
    manifests, reused = {}, 0

    def open_batch(folder):
        nonlocal reused
        folder['children'] = children(folder['id'], token)
        folder['files'] = zip_files(folder['id'], token)
        for child in folder['children']:
            if child['name'] != 'manifest.json':
                continue
            stamp, raw = known.get(child['id'], (None, None))
            if raw is not None and stamp == child.get('modifiedTime'):
                reused += 1
            else:
                raw = drive_get(f'{API}/{child["id"]}?alt=media&supportsAllDrives=true', token)
            manifests[child['id']] = raw

    # Groups hold batches, and since the 3 Oct layout a group can hold a group:
    # CompanyBench/CompanyBench - From Pipeline/Batch 9.1 - CompanyBench 89. Two
    # levels, never deeper, so a batch's own subfolders are never taken for one.
    def open_group(group, depth):
        group['children'] = children(group['id'], token)
        for child in group['children']:
            role = folder_role(child)
            if role == 'batch':
                open_batch(child)
            elif role == 'group' and depth < GROUP_DEPTH:
                open_group(child, depth + 1)

    for item in items:
        role = folder_role(item)
        if role == 'batch':
            open_batch(item)
        elif role == 'group':
            open_group(item, 1)
    if reused:
        print(f'{reused} unchanged manifests reused from {cache}', file=sys.stderr)
    return {'folder': meta, 'items': items}, manifests


def snapshot_from_dir(path):
    base = pathlib.Path(path)
    listing = json.loads((base / 'listing.json').read_text(encoding='utf-8'))
    manifests = {p.stem: p.read_bytes() for p in (base / 'manifests').glob('*.json')}
    return listing, manifests


def save_snapshot(path, listing, manifests):
    base = pathlib.Path(path)
    (base / 'manifests').mkdir(parents=True, exist_ok=True)
    for stale in (base / 'manifests').glob('*.json'):
        if stale.stem not in manifests:
            stale.unlink()
    for file_id, raw in manifests.items():
        (base / 'manifests' / f'{file_id}.json').write_bytes(raw)
    # The listing last: a run cut short leaves the previous listing, which only
    # names manifests that are already on disk.
    (base / 'listing.json').write_text(json.dumps(listing, indent=1), encoding='utf-8')


def walk(items):
    """Every entry of a saved listing, at any depth."""
    for item in items:
        yield item
        yield from walk(item.get('children', []))


# ------------------------------------------------------------ interpretation

def is_dedup(name):
    return 'dedup' in re.sub(r'[\s_\-]+', '', str(name).lower())


def zip_files(folder_id, token):
    """Every .zip under a folder, at any depth, with the folder path it sits in.

    The path is relative to the batch folder - "CompanyBench/Harder" - because
    where a package was put on Drive is what says which bench it was delivered
    as, and it does not always match the manifest's own package_path.
    """
    files, pending = [], [(folder_id, '')]
    while pending:
        current, path = pending.pop()
        for entry in children(current, token):
            if entry['mimeType'] == FOLDER_MIME:
                pending.append((entry['id'], f"{path}/{entry['name']}".strip('/')))
            elif entry['name'].lower().endswith('.zip'):
                files.append({'name': entry['name'], 'path': path})
    return sorted(files, key=lambda f: (f['path'], f['name']))


def folder_role(item):
    """'batch', 'group' (a folder of batches, looked into once) or None."""
    if item['mimeType'] != FOLDER_MIME:
        return None
    label, reason = batch_label(item['name'])
    if label:
        return 'batch'
    return 'group' if reason == NOT_A_BATCH_NAME else None


def batch_label(name):
    """(label, reason) for a top-level name; label is None when it is not a batch."""
    flat = re.sub(r'[\s_\-]+', '', name.lower())
    hit = next((word for word in IGNORE if word in flat), None)
    if hit:
        return None, f'name marks it as {hit}, not a delivered batch'
    match = BATCH.search(name)
    if not match:
        return None, NOT_A_BATCH_NAME
    if 'companybench' in flat:
        return f'CompanyBench {match.group(1)}', None
    return f'Batch {match.group(1)}', None


def first(*values):
    return next((v for v in values if v not in (None, '')), None)


def drive_keys(task):
    """The file names a task's zip can have on Drive, lower-cased.

    Usually the manifest's package file; sometimes the zip was saved under the
    declared name or its original filename instead.
    """
    declared = re.sub(r'^(harbor|obi)/', '', str(task.get('task_name') or '').strip())
    names = {pathlib.PurePosixPath(str(task.get('package_path') or '')).name,
             f"{task.get('task_id')}.zip" if task.get('task_id') else '',
             f'{declared}.zip' if declared else '', str(task.get('original_filename') or '')}
    return {n.lower() for n in names if n}


def locate(tasks, files):
    """{task index: Drive folder path} for the tasks whose zip was found."""
    where = {f['name'].lower(): f.get('path', '') for f in files or []}
    found = {}
    for index, task in enumerate(tasks):
        hit = next((where[k] for k in sorted(drive_keys(task)) if k in where), None)
        if hit is not None:
            found[index] = hit
    return found


def normalise(manifest, label, files=None, require_present=False):
    """Rows for one manifest, or (None, reason) when its layout is not usable.

    `files` are the zips actually in the batch folder on Drive; each task found
    among them carries the folder it sits in, which decides its bench. With
    `require_present` - a dedup copy - a task whose zip is not there is left out.
    Ids keep the manifest's numbering, so a row's id does not move when its
    neighbours are removed.
    """
    tasks = manifest.get('tasks') if isinstance(manifest, dict) else None
    if not isinstance(tasks, list) or not tasks:
        return None, 'manifest has no task list'
    bad = [i for i, t in enumerate(tasks)
           if not isinstance(t, dict) or not t.get('package_path')
           or not SHA256.match(str(t.get('sha256') or ''))
           or not isinstance(t.get('size_bytes'), int)]
    if bad:
        return None, (f'{len(bad)} of {len(tasks)} tasks lack a package_path, sha256 or '
                      f'size_bytes (first at index {bad[0]}); layout not recognised')

    prefix = ('CB' if label.startswith('CompanyBench') else 'B') + re.sub(r'\D', '', label)
    located = locate(tasks, files) if files is not None else {}
    rows, seen = [], set()
    for index, task in enumerate(tasks, 1):
        parts = package_parts(task['package_path'])
        location = located.get(index - 1)
        if require_present and location is None:
            continue
        stem = pathlib.PurePosixPath(parts[-1]).stem
        package = first(task.get('task_id'), stem)
        if package in seen:
            return None, f'package {package} appears twice in the manifest'
        seen.add(package)
        declared = re.sub(r'^(harbor|obi)/', '', str(task.get('task_name') or '').strip())
        name = declared or package
        klass = class_of(parts[0], task)
        # The family comes from the manifest and the package, never from the
        # Drive folder the zip sits in (see family_of); the folder is kept only
        # as where the package was found.
        image, image_from = image_of_package(label, parts[-1], source_object(task), source_folder(task)[1],
                                             name, package, task.get('original_folder'))
        family, family_from = family_of(task, klass, image, image_from or 'the image in the package')
        if image_from == 'package versions disagree' and family_from in (None, 'the manifest'):
            family_from = ('the manifest; the bucket holds versions of the task on different images'
                           if family else 'not classified: the bucket holds versions of the task on different images')
        domain = parts[2] if klass == 'Non-Connector' and len(parts) > 3 else first(task.get('domain'))
        if family == 'non-connector' and not domain:
            domain = domain_of_name(name)
        # The bench is the manifest's too. A package its manifest classes Real
        # Connector is Computer Bench, its real data split by image into Real
        # Aster and Real Zeta; any other Aster or Zeta package is Company Bench.
        computer_real = klass == 'Real Connector'
        listed = on_computer_bench_sheet(name, package, source_folder(task)[1])
        bench = ('company' if family in ('real-aster', 'real-zeta', 'real') and not computer_real and not listed
                 else 'computer')
        band = first(task.get('difficulty'), parts[1] if len(parts) > 2 else None)
        trials = task.get('trial_evidence') if isinstance(task.get('trial_evidence'), dict) else {}
        glm = trials.get('successes') if isinstance(trials.get('successes'), int) else None
        services = task.get('connector_services')
        rows.append({
            'id': f'{prefix}-{index:03d}',
            'task': name,
            'packageName': package if package != name else None,
            'batch': label,
            # The family (family_of): Real Aster / Real Zeta (the Company Bench
            # view), Synthetic, or Non-connector; and which source decided it.
            'category': ((f'Non-Connector · {domain}' if domain else 'Non-Connector') if family == 'non-connector'
                         else 'CompanyBench' if bench == 'company'
                         else FAMILY_LABELS.get(family, 'Connector · not classified')),
            'class': klass,
            'family': family,
            'familyFrom': family_from,
            'domain': domain if family == 'non-connector' else None,
            'type': 'Non-connector' if family == 'non-connector' else 'Connector',
            'bench': bench,
            'benchFrom': ("the Computer Bench sheet" if listed and family in ('real-aster', 'real-zeta', 'real')
                          else "the manifest's Real Connector class" if computer_real else None),
            'harness': {'real-aster': 'aster', 'real-zeta': 'zeta'}.get(family) if bench == 'company' else None,
            'driveFolder': location,
            'difficulty': band.capitalize() if band else None,
            'glm': glm,
            'bucket': f'{glm}/4' if glm is not None else None,
            'versions': 1,
            'trainer': 'Unattributed',
            'source': 'Delivery manifest',
            'sha': task['sha256'][:16],
            'size_mb': round(task['size_bytes'] / 1e6, 2),
            # Some manifests list each service as {name, transport, url}; the page
            # shows names, so an object is reduced to its name.
            'connectors': connector_names(task),
            # How many connectors the package's task.toml declares, where the
            # manifest records it: Batches 1 to 5.1 and 11.1 to 13.1 had it
            # filled in from each zip on 13 Oct (filled_from_package). Batch
            # 5.1's own connector list says only "harbor", so this is its count.
            'connectorCount': task.get('connector_count') if isinstance(task.get('connector_count'), int) else None,
            'dates': [],
            'priority': None,
            'qc_result': None,
            'acceptance': 'Pending',
            'feedback_url': None,
            'ambiguous': False,
            'unverified': False,
            'version_dependent': False,
            'packagePath': task['package_path'],
            # Where the manifest says the package came from, when it says. The
            # owner index joins on it: it names one archive, not one task name.
            'sourceObject': source_object(task),
            # The pipeline folder it was cut from, when the manifest names one;
            # 'elsewhere' when it names another bucket or an archive handed over
            # outside the pipeline, so "not in the prefix" can say which.
            'sourcePrefix': source_folder(task)[0],
            'sourceFolder': source_folder(task)[1],
            'sourceKind': source_kind(task),
            # What the Delivery tab's manifest.json export needs to restate the
            # entry as the batch manifest wrote it: the package's full checksum
            # and size, where it was cut from, and the names and labels it gave.
            'sha256': task['sha256'],
            'sizeBytes': task['size_bytes'],
            'sourceUri': first(task.get('source_uri')),
            'taskName': first(task.get('task_name')),
            'benchType': first(task.get('bench_type')),
            'glmModel': first(trials.get('model')),
        })
    return rows, None


DIFFICULTIES = ('easier', 'harder')

# The domain of a non-connector package whose manifest names none - Batch 12.1
# files them under Non-Connector/<difficulty> with no domain folder. Read from
# the task name's prefix, as the delivery team's domain folders follow it in
# every earlier batch (all but 2 of about 1,350 packages): code- and tech- are
# Engineering, fin- Finance, health- Health, law- Legal, anything else Other.
NAME_DOMAINS = {'code': 'Engineering', 'tech': 'Engineering', 'fin': 'Finance',
                'health': 'Health', 'law': 'Legal'}


def domain_of_name(name):
    prefix = re.match(r'^([a-z]+)-', str(name or '').lower())
    return NAME_DOMAINS.get(prefix.group(1), 'Other') if prefix else 'Other'


def package_parts(path):
    """A manifest's package_path as class/difficulty/[domain/]file.

    The current manifests write it that way. Batches 1 to 4.1, re-filed on Drive
    in the 3 Oct layout, carry their older layouts: a wrapper folder first -
    finalization_qc_accepted_zipped/, computerbench-batch-5/ - and in Batches 1
    to 3 the difficulty before the class: harder/non-connector/engineering/x.zip.
    """
    parts = [p for p in str(path).split('/') if p]
    # Batch 12.1: the bench group, then the class with its count -
    # "Computer Bench (NC 39 RC 0 S 99)/Synthetic 99/Easier 34/x.zip". The class
    # folder names the class, so the group folder is dropped.
    if len(parts) > 3:
        counted = re.sub(r'\s+\d+\s*$', '', parts[1]).strip()
        if counted != parts[1] and counted.lower() in CLASSES:
            parts = [counted] + parts[2:]
    if len(parts) > 2 and parts[0].lower() not in CLASSES and (
            parts[1].lower() in CLASSES or parts[1].lower() in DIFFICULTIES):
        parts = parts[1:]
    if len(parts) > 2 and parts[0].lower() in DIFFICULTIES and parts[1].lower() in CLASSES:
        parts = [parts[1], parts[0]] + parts[2:]
    if len(parts) > 3 and parts[2] == parts[2].lower():
        parts = parts[:2] + [parts[2].capitalize()] + parts[3:]
    return parts


COMPANY_FOLDER = re.compile(r'^company\s*bench', re.I)
ASTER_FOLDER = re.compile(r'^aster\b', re.I)
NON_CONNECTOR_FOLDER = re.compile(r'^non[\s_-]*connector', re.I)


def type_of(klass, location=None):
    """Connector or Non-connector, by the Drive folder when the zip was found.

    Both benches can hold both kinds, so the type is read on its own, from the
    same place as the bench: a Non-Connector folder anywhere in the batch."""
    if location is not None:
        return 'Non-connector' if any(NON_CONNECTOR_FOLDER.match(part) for part in location.split('/')) else 'Connector'
    return 'Non-connector' if klass == 'Non-Connector' else 'Connector'


def bench_of(label, klass, task, location=None):
    """'company' or 'computer', by where the package was delivered.

    Company Bench is what was delivered as Company Bench: everything in a
    CompanyBench batch, and whatever sits in the CompanyBench/ folder of a
    Computer Bench batch on Drive. That folder is read where the package was
    found - 5.1, 6.1 and 7.1 file their Company Bench connectors there while
    their manifests call the same packages Connector/. Only when the zip was
    not found does the manifest's own folder stand in. The one exception is a
    task its own manifest calls a Computer Bench one - the synthetic tasks
    shipped inside CompanyBench 3. Who made the task plays no part: people work
    on both benches and the roster moves.
    """
    declared = str(task.get('bench_type') or task.get('bench_family') or '').lower()
    if label.startswith('CompanyBench'):
        # The image the manifest records, read with the scanner's rule, before
        # the label it wrote from that image: CompanyBench 3 labels 9 tasks
        # computer bench synth from obi-benchmark@sha256:e76ff56a..., which is the
        # Zeta V4 image under another name.
        recorded = bench_type(manifest_image(task)) if manifest_image(task) else None
        if recorded:
            return 'company' if recorded.startswith('company') else 'computer'
        return 'computer' if 'computer' in declared else 'company'
    if location is not None:
        head = location.split('/')[0]
        return 'company' if COMPANY_FOLDER.match(head) or ASTER_FOLDER.match(head) else 'computer'
    return 'company' if klass in ('CompanyBench', 'Company Bench Zeta', 'Aster') else 'computer'


def source_object(task):
    """The sha256 of the bucket archive this package was cut from, or None."""
    version = str(task.get('source_version') or '')
    if SHA256.match(version):
        return version
    match = SOURCE_OBJECT.search(str(task.get('source_uri') or ''))
    return match.group(1) if match else None


def source_folder(task):
    """(prefix, folder) in the pipeline bucket this package was cut from, or
    (None, None) when the manifest names another bucket or no source at all."""
    match = SOURCE_FOLDER.match(str(task.get('source_uri') or '').strip())
    return (match.group(1), match.group(2)) if match else (None, None)


def connector_entries(task):
    """The connectors a manifest lists, however it writes them: a list of names,
    a list of {name, image, ...}, one string joined by | or commas (Batch 6.1),
    or under connector.services (Batches 1 to 3)."""
    services = task.get('connector_services')
    if services is None and isinstance(task.get('connector'), dict):
        services = task['connector'].get('services')
    if isinstance(services, str):
        services = [part.strip() for part in re.split(r'[|,;]', services) if part.strip()]
    return services if isinstance(services, list) else []


def connector_names(task):
    return [str(s.get('name') or '') if isinstance(s, dict) else str(s) for s in connector_entries(task)]


IMAGE_REFERENCE = re.compile(r'image reference\s+(\S+)', re.I)


def manifest_image(task):
    """The Dockerfile image a manifest records for the task: image_ref, or the
    image named in bench_basis ("image reference <image> (environment/Dockerfile
    final FROM)"). None when it records neither."""
    if task.get('image_ref'):
        return str(task['image_ref'])
    match = IMAGE_REFERENCE.search(str(task.get('bench_basis') or ''))
    return match.group(1) if match else None


def harness_of(task, klass=None):
    """'aster' or 'zeta': the Company Bench harness, from the image the manifest
    names when it names one - for the task, or for its connectors (Batch 2 lists
    each connector with its image) - then the bench it declares, then its folder
    class. Read with the scanner's own image rule, so the two cannot disagree."""
    images = [s.get('image') for s in connector_entries(task) if isinstance(s, dict) and s.get('image')]
    for value in (manifest_image(task), *images, task.get('bench_type'), task.get('bench_family'),
                  task.get('bench_class'), klass):
        bench = bench_type(str(value)) if value else None
        if bench and bench.startswith('company bench '):
            return bench.split()[-1]
    return None


def source_kind(task):
    """'pipeline' when the package names a folder in the pipeline bucket,
    'elsewhere' when it names some other source, None when it names none."""
    if source_folder(task)[0]:
        return 'pipeline'
    named = str(task.get('source_uri') or task.get('source') or '').strip()
    return 'elsewhere' if named else None


def declared_total(manifest):
    """The task count the manifest's own summary states, where it states one."""
    summary = manifest.get('summary') if isinstance(manifest.get('summary'), dict) else {}
    for key in ('task_count', 'total', 'tasks'):
        if isinstance(summary.get(key), int):
            return summary[key]
    return None


def build(listing, manifests, audited_batches):
    batches, skipped, ignored, rows = [], [], [], []
    candidates = collections.defaultdict(list)
    shares = collections.defaultdict(list)     # Batch N -> its Company Bench share folders

    def consider(item, path):
        if item['mimeType'] != FOLDER_MIME:
            kind = 'a shortcut' if item['mimeType'].endswith('.shortcut') else 'a file'
            ignored.append({'name': path, 'reason': f'{kind}, not a batch folder'})
            return
        label, reason = batch_label(item['name'])
        if not label:
            ignored.append({'name': path, 'reason': reason})
            return
        manifest = next((c for c in item.get('children', []) if c['name'] == 'manifest.json'), None)
        share = SHARE.match(item['name'])
        if manifest is None and share:
            shares[f'Batch {share.group(1)}'].append(dict(item, name=path))
            return
        if label in audited_batches:
            ignored.append({'name': path, 'reason': f'{label} keeps its audited rows'})
            return
        if manifest is None:
            skipped.append({'name': path, 'batch': label,
                            'reason': 'no manifest.json at the top of the folder'})
            return
        candidates[label].append((dict(item, name=path), manifest))

    def visit(item, path, depth):
        if folder_role(item) == 'group' and depth <= GROUP_DEPTH:
            # A folder of batches, such as ComputerBench/, or of Company Bench
            # shares, such as CompanyBench - From Pipeline/. A batch's own
            # subfolders are never looked into, so none is taken for a batch.
            inside = sorted(item.get('children', []), key=lambda i: i['name'])
            if not any(folder_role(child) in ('batch', 'group') for child in inside):
                ignored.append({'name': path, 'reason': 'no batch folder inside'})
            for child in inside:
                visit(child, f"{path}/{child['name']}", depth + 1)
        else:
            consider(item, path)

    for item in sorted(listing['items'], key=lambda i: i['name']):
        visit(item, item['name'], 1)

    def share_files(label):
        """The zips of a batch's Company Bench share, filed under CompanyBench/."""
        return [{'name': f['name'], 'path': f"CompanyBench/{f.get('path', '')}".rstrip('/')}
                for folder in shares.get(label, []) for f in (folder.get('files') or [])]

    def tasks_of(label):
        """The task list of a batch's own manifest on Drive, or []."""
        folder = next((c for c in walk(listing['items'])
                       if c.get('mimeType') == FOLDER_MIME and not SHARE.match(c['name'])
                       and batch_label(c['name'])[0] == label
                       and any(x['name'] == 'manifest.json' for x in c.get('children', []))), None)
        manifest = next(x for x in folder['children'] if x['name'] == 'manifest.json') if folder else None
        raw = manifests.get(manifest['id']) if manifest else None
        try:
            return (json.loads(raw).get('tasks') if raw else None) or []
        except ValueError:
            return []

    # A zip in a share folder that its batch's manifest does not list is filed
    # there by hand, not delivered in that batch: "Batch 3 - CompanyBench" holds
    # five CompanyBench 3 packages, the folder named after Shannon's Batch 3
    # rather than CompanyBench's own "Batch3". Such a zip is offered to the
    # CompanyBench batches, and counts wherever a manifest lists it.
    strays, share_tasks = [], {}
    for label in sorted(shares):
        tasks = tasks_of(label)
        share_tasks[label] = tasks
        files = share_files(label)
        found = locate(tasks, files)
        matched = {pathlib.PurePosixPath(n).name.lower() for i in found for n in drive_keys(tasks[i])}
        strays.extend(dict(f, path=f"{f['path']} (filed under {label})") for f in files
                      if f['name'].lower() not in matched)

    # The audited batches keep their audited rows. What Drive adds is which of
    # their packages are filed as Company Bench, read against the batch's own
    # manifest on Drive by the zips in its share folder.
    audited_company = []
    for label in sorted(shares):
        if label not in audited_batches:
            continue
        tasks = share_tasks[label]
        found = locate(tasks, share_files(label))
        for index in sorted(found):
            task = tasks[index]
            stem = pathlib.PurePosixPath(str(task.get('package_path') or '')).stem
            audited_company.append({
                'batch': label,
                'task': re.sub(r'^(harbor|obi)/', '', str(task.get('task_name') or '').strip()) or stem,
                'packageName': stem, 'driveFolder': found[index]})
        if not tasks:
            skipped.append({'name': ', '.join(f['name'] for f in shares[label]), 'batch': label,
                            'reason': f'no {label} manifest on Drive to read its Company Bench share against'})
    claimed = set()

    for label, found in sorted(candidates.items()):
        notes = []
        dedup = [pair for pair in found if is_dedup(pair[0]['name'])]
        if len(found) > 1 and len(dedup) == 1:
            # The dedup copy is the batch with duplicates taken out; the folder
            # it was copied from is not delivered as well.
            notes.append('the dedup copy is used; ' +
                         ', '.join(i['name'] for i, _ in found if i is not dedup[0][0]) +
                         ' also claims ' + label + ' and is not read')
            found = dedup
        if len(found) > 1:
            # A copy made while tidying the folder carries the same receipt, so
            # it is read once. Different receipts for one batch cannot both be
            # it, and neither is published until one is renamed or removed.
            contents = {manifests.get(m['id']) for _, m in found}
            if len(contents) == 1 and None not in contents:
                found = sorted(found, key=lambda pair: (len(pair[0]['name']), pair[0]['name']))
                notes.append('also in ' + ', '.join(i['name'] for i, _ in found[1:]) +
                             ' with an identical manifest; read once')
            else:
                for item, _ in found:
                    skipped.append({'name': item['name'], 'batch': label,
                                    'reason': f'{len(found)} folders claim {label} with different manifests; '
                                              'none published until one is renamed'})
                continue
        item, manifest = found[0]
        raw = manifests.get(manifest['id'])
        if raw is None:
            skipped.append({'name': item['name'], 'batch': label, 'reason': 'manifest.json could not be read'})
            continue
        try:
            blob = json.loads(raw)
        except ValueError as error:
            skipped.append({'name': item['name'], 'batch': label, 'reason': f'manifest.json is not valid JSON: {error}'})
            continue
        files = item.get('files')
        if files is None and isinstance(item.get('packages'), list):     # older snapshots
            files = [{'name': n, 'path': ''} for n in item['packages']]
        # Whether every zip of the batch folder itself was listed. A live read
        # always lists them all; a snapshot assembled by hand may list only the
        # folders that moved, and says so - then the zips give locations but no
        # package is left out for being absent.
        complete = files is not None and item.get('filesComplete', True)
        if shares.get(label):
            files = (files or []) + share_files(label)
            notes.append('Company Bench share read from ' + ', '.join(f['name'] for f in shares[label]))
        if label.startswith('CompanyBench') and strays and files is not None:
            files = files + strays
        dedup_copy = is_dedup(item['name'])
        if dedup_copy and files is None:
            skipped.append({'name': item['name'], 'batch': label,
                            'reason': 'a dedup copy whose packages were not listed; not published '
                                      'until they are, so a removed package is never shown'})
            continue
        # The packages actually on Drive decide whenever the folder was listed:
        # the 3 Oct cleanup took duplicates out of folders and left their
        # manifests as they were, as a dedup copy always has.
        present_only = complete
        batch_rows, reason = normalise(blob, label, files, require_present=present_only)
        if batch_rows is None:
            skipped.append({'name': item['name'], 'batch': label, 'reason': reason})
            continue
        left_out = []
        placed = locate(blob['tasks'], files)
        moved = sorted({placed[i] for i in placed if '(filed under ' in placed[i]})
        if moved:
            claimed.update(f['name'].lower() for f in strays
                           if any(f['name'].lower() in drive_keys(t) for i, t in enumerate(blob['tasks']) if i in placed))
            notes.append(f"{sum(1 for i in placed if '(filed under ' in placed[i])} of its packages are filed in "
                         + ', '.join(moved))
        if present_only:
            found = placed
            left_out = sorted(pathlib.PurePosixPath(str(t['package_path'])).name
                              for i, t in enumerate(blob['tasks']) if i not in found)
            if left_out:
                notes.append(f'{len(left_out)} of the manifest\'s {len(blob["tasks"])} packages are not '
                             'in the folder on Drive and are left out')
        models = collections.Counter(
            (t.get('trial_evidence') or {}).get('model') for t in blob['tasks']
            if isinstance(t.get('trial_evidence'), dict) and t['trial_evidence'].get('model'))
        stated = declared_total(blob)
        if stated is not None and stated != len(batch_rows) + len(left_out):
            notes.append(f'summary states {stated} tasks, the task list holds {len(batch_rows)}')
        batches.append({
            'batch': label, 'folder': item['name'], 'folderId': item['id'],
            'folderModified': item.get('modifiedTime'),
            'manifestId': manifest['id'], 'manifestModified': manifest.get('modifiedTime'),
            'schema': first(blob.get('schema'), blob.get('schema_version')),
            'tasks': len(batch_rows), 'glmModels': dict(models), 'notes': notes,
            'leftOut': left_out,
        })
        rows.extend(batch_rows)

    unclaimed = [f for f in strays if f['name'].lower() not in claimed]
    if unclaimed:
        skipped.append({'name': ', '.join(sorted({f['path'] for f in unclaimed})), 'batch': None,
                        'reason': f'{len(unclaimed)} Company Bench zips in a share folder match no manifest: '
                                  + ', '.join(sorted(f['name'] for f in unclaimed))})

    return {
        'generatedAt': datetime.now(timezone.utc).isoformat(timespec='seconds'),
        'folder': listing['folder'],
        'rule': 'one row per package a batch manifest lists; batches the audit already '
                'covers keep their audited rows',
        'counts': {'tasks': len(rows), 'batches': {b['batch']: b['tasks'] for b in batches},
                   'skipped': len(skipped), 'ignored': len(ignored)},
        'batches': batches, 'skipped': skipped, 'ignored': ignored, 'rows': rows,
        # Packages of the audited Batches 1 to 4.1 that Drive files as Company Bench.
        'auditedCompany': audited_company,
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--folder', default=FOLDER, help='Drive id of the Deliveries folder')
    ap.add_argument('--from-dir', help='read a saved snapshot instead of Drive')
    ap.add_argument('--save-dir', help='save what was read from Drive, for --from-dir; also '
                                       'used as a cache so unchanged manifests are not re-downloaded')
    ap.add_argument('--audit', default='assets/delivery-audit.json')
    ap.add_argument('--out', default='assets/drive-deliveries.json')
    ap.add_argument('--bench-index', default='assets/bench-index.json',
                    help="the bucket scan's package images, by task name")
    ap.add_argument('--toml-reads', default='assets/task-toml-reads.json',
                    help="the bucket scan's package images, by folder")
    ap.add_argument('--computer-bench-sheet', default='tools/data/computer-bench-sheet.tsv',
                    help="the task names Hussain's sheet lists as Computer Bench")
    ap.add_argument('--drive-images', default='tools/data/drive-package-images.tsv',
                    help='package images read by hand from the zips on Drive')
    ap.add_argument('--truth', default='assets/pipeline-truth.json',
                    help="the pipeline's verdict records: which task name each family is")
    args = ap.parse_args()
    print(f'package images: {load_package_images(args.bench_index, args.toml_reads, args.truth)} names from the bucket scan, '
          f'{load_drive_images(args.drive_images)} zips read on Drive, '
          f'{load_computer_bench_sheet(args.computer_bench_sheet)} tasks on the Computer Bench sheet')

    if args.from_dir:
        listing, manifests = snapshot_from_dir(args.from_dir)
    else:
        listing, manifests = snapshot_from_drive(args.folder, access_token(), cache=args.save_dir)
        if args.save_dir:
            save_snapshot(args.save_dir, listing, manifests)

    audit_path = pathlib.Path(args.audit)
    audited = set()
    if audit_path.exists():
        audited = {r.get('batch') for r in json.loads(audit_path.read_text(encoding='utf-8'))['rows']}

    payload = build(listing, manifests, audited)

    # A published row has to be traceable to exactly one package in exactly one
    # batch; anything else is a bug here, not a fact about the delivery.
    ids = [r['id'] for r in payload['rows']]
    assert len(ids) == len(set(ids)), 'two rows share an id'
    assert sum(payload['counts']['batches'].values()) == len(payload['rows']), 'a batch lost rows'

    # Written whole or not at all: the page must never read half an asset, and a
    # failed run above has already exited, leaving the previous one in place.
    out = pathlib.Path(args.out)
    partial = out.with_name(out.name + '.new')
    partial.write_text(json.dumps(payload, separators=(',', ':')), encoding='utf-8')
    os.replace(partial, out)

    print(f"Drive folder           : {payload['folder'].get('name')} ({len(listing['items'])} items)")
    for b in payload['batches']:
        print(f"  {b['batch']:<18} {b['tasks']:>5}   {b['folder']}")
        for note in b['notes']:
            print(f"    note: {note}")
    for s in payload['skipped']:
        print(f"  SKIPPED {s['name']}: {s['reason']}")
    print(f"ignored                : {len(payload['ignored'])}")
    print(f"rows                   : {len(payload['rows']):>5}")
    print(f"wrote {out} ({out.stat().st_size/1e3:.0f} KB)")


if __name__ == '__main__':
    main()
