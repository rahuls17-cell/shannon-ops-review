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

Anything else is listed in the output with the reason, so a folder that was
left out can be seen to have been left out. Two folders claiming one batch are
read once when their manifests are byte-identical - a copy made while tidying
the folder - and skipped with a warning when they differ, because then there is
no telling which is the receipt.

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
  2. the GCE metadata server, if the VM's service account has a Drive scope.

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

FOLDER = '1_ZA8ckJfXtaGV4OpqZ0a4f5XZbx4brXO'   # "Deliveries"
API = 'https://www.googleapis.com/drive/v3/files'
SCOPE = 'https://www.googleapis.com/auth/drive.readonly'
METADATA = ('http://metadata.google.internal/computeMetadata/v1/'
            'instance/service-accounts/default/token')
FOLDER_MIME = 'application/vnd.google-apps.folder'

# Words that mark a folder as something other than a delivered batch. Matched
# against the name with spaces, dashes and underscores removed.
IGNORE = ('deprecated', 'partial', 'dupes', 'shipment', 'meta', 'knowledgework', 'ekw', 'svc')
NOT_A_BATCH_NAME = 'name does not say which batch it is'
BATCH = re.compile(r'batch\s*(\d+(?:\.\d+)?)', re.I)
SHA256 = re.compile(r'^[0-9a-f]{64}$')
# The bucket object a package was cut from: gs://.../tasks/<prefix>/<folder>/<hash>.zip
SOURCE_OBJECT = re.compile(r'/([0-9a-f]{64})\.zip$')

# The first level of the Drive layout, spelled the way the manifests spell it.
CLASSES = {'connector': 'Connector', 'real connector': 'Real Connector',
           'synthetic': 'Synthetic', 'non-connector': 'Non-Connector',
           'companybench': 'CompanyBench', 'company bench zeta': 'Company Bench Zeta'}


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


def access_token():
    tried = []
    for name, get in (('a service account key', token_from_key),
                      ('the GCE metadata server', token_from_metadata)):
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
        for child in folder['children']:
            if child['name'] != 'manifest.json':
                continue
            stamp, raw = known.get(child['id'], (None, None))
            if raw is not None and stamp == child.get('modifiedTime'):
                reused += 1
            else:
                raw = drive_get(f'{API}/{child["id"]}?alt=media&supportsAllDrives=true', token)
            manifests[child['id']] = raw

    for item in items:
        role = folder_role(item)
        if role == 'batch':
            open_batch(item)
        elif role == 'group':
            item['children'] = children(item['id'], token)
            for child in item['children']:
                if folder_role(child) == 'batch':
                    open_batch(child)
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


def normalise(manifest, label):
    """Rows for one manifest, or (None, reason) when its layout is not usable."""
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
    rows, seen = [], set()
    for index, task in enumerate(tasks, 1):
        parts = str(task['package_path']).split('/')
        stem = pathlib.PurePosixPath(parts[-1]).stem
        package = first(task.get('task_id'), stem)
        if package in seen:
            return None, f'package {package} appears twice in the manifest'
        seen.add(package)
        declared = re.sub(r'^(harbor|obi)/', '', str(task.get('task_name') or '').strip())
        name = declared or package
        klass = CLASSES.get(parts[0].lower(), parts[0])
        domain = parts[2] if klass == 'Non-Connector' and len(parts) > 3 else first(task.get('domain'))
        band = first(task.get('difficulty'), parts[1] if len(parts) > 2 else None)
        trials = task.get('trial_evidence') if isinstance(task.get('trial_evidence'), dict) else {}
        glm = trials.get('successes') if isinstance(trials.get('successes'), int) else None
        services = task.get('connector_services')
        rows.append({
            'id': f'{prefix}-{index:03d}',
            'task': name,
            'packageName': package if package != name else None,
            'batch': label,
            'category': f'Non-Connector · {domain}' if klass == 'Non-Connector' and domain else klass,
            'class': klass,
            'domain': domain,
            'type': 'Non-connector' if klass == 'Non-Connector' else 'Connector',
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
            'connectors': [str(s.get('name') or '') if isinstance(s, dict) else str(s)
                           for s in services] if isinstance(services, list) else [],
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
        })
    return rows, None


def source_object(task):
    """The sha256 of the bucket archive this package was cut from, or None."""
    version = str(task.get('source_version') or '')
    if SHA256.match(version):
        return version
    match = SOURCE_OBJECT.search(str(task.get('source_uri') or ''))
    return match.group(1) if match else None


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

    def consider(item, path):
        if item['mimeType'] != FOLDER_MIME:
            kind = 'a shortcut' if item['mimeType'].endswith('.shortcut') else 'a file'
            ignored.append({'name': path, 'reason': f'{kind}, not a batch folder'})
            return
        label, reason = batch_label(item['name'])
        if not label:
            ignored.append({'name': path, 'reason': reason})
            return
        if label in audited_batches:
            ignored.append({'name': path, 'reason': f'{label} keeps its audited rows'})
            return
        manifest = next((c for c in item.get('children', []) if c['name'] == 'manifest.json'), None)
        if manifest is None:
            skipped.append({'name': path, 'batch': label,
                            'reason': 'no manifest.json at the top of the folder'})
            return
        candidates[label].append((dict(item, name=path), manifest))

    for item in sorted(listing['items'], key=lambda i: i['name']):
        if folder_role(item) == 'group':
            # A folder of batches, such as ComputerBench/: looked into once,
            # never deeper, so a batch's own subfolders are not mistaken for one.
            inside = sorted(item.get('children', []), key=lambda i: i['name'])
            if not any(folder_role(child) == 'batch' for child in inside):
                ignored.append({'name': item['name'], 'reason': 'no batch folder inside'})
            for child in inside:
                consider(child, f"{item['name']}/{child['name']}")
        else:
            consider(item, item['name'])

    for label, found in sorted(candidates.items()):
        notes = []
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
        batch_rows, reason = normalise(blob, label)
        if batch_rows is None:
            skipped.append({'name': item['name'], 'batch': label, 'reason': reason})
            continue
        models = collections.Counter(
            (t.get('trial_evidence') or {}).get('model') for t in blob['tasks']
            if isinstance(t.get('trial_evidence'), dict) and t['trial_evidence'].get('model'))
        stated = declared_total(blob)
        if stated is not None and stated != len(batch_rows):
            notes.append(f'summary states {stated} tasks, the task list holds {len(batch_rows)}')
        batches.append({
            'batch': label, 'folder': item['name'], 'folderId': item['id'],
            'folderModified': item.get('modifiedTime'),
            'manifestId': manifest['id'], 'manifestModified': manifest.get('modifiedTime'),
            'schema': first(blob.get('schema'), blob.get('schema_version')),
            'tasks': len(batch_rows), 'glmModels': dict(models), 'notes': notes,
        })
        rows.extend(batch_rows)

    return {
        'generatedAt': datetime.now(timezone.utc).isoformat(timespec='seconds'),
        'folder': listing['folder'],
        'rule': 'one row per package a batch manifest lists; batches the audit already '
                'covers keep their audited rows',
        'counts': {'tasks': len(rows), 'batches': {b['batch']: b['tasks'] for b in batches},
                   'skipped': len(skipped), 'ignored': len(ignored)},
        'batches': batches, 'skipped': skipped, 'ignored': ignored, 'rows': rows,
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--folder', default=FOLDER, help='Drive id of the Deliveries folder')
    ap.add_argument('--from-dir', help='read a saved snapshot instead of Drive')
    ap.add_argument('--save-dir', help='save what was read from Drive, for --from-dir; also '
                                       'used as a cache so unchanged manifests are not re-downloaded')
    ap.add_argument('--audit', default='assets/delivery-audit.json')
    ap.add_argument('--out', default='assets/drive-deliveries.json')
    args = ap.parse_args()

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
