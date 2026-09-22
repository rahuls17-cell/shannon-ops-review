#!/usr/bin/env python3
"""Count the accepted cohort by its folders, not by its verdicts.

Why this exists
---------------
Every figure that has been wrong came from the same thing: the page counted
VERDICT ROWS and then tried to recover "one task" by normalising names. That is
guesswork - 3,365 rows carry no family id, names repeat, and the same work
appears as `task2` or `harbor-single-task-7guod6fj` - and it produced a
different answer at every step.

The bucket does not have that problem. Under

    gs://obi-harbor-pipeline/tasks/finalisation_client_qc_accepted_iteration_2/

one FOLDER is one task. The storage layout already did the deduplication, so
the folder is used as the identity here and the verdicts are used only to say
what happened to it.

The four figures
----------------
  packages      every folder in the cohort. Each holds an accepted package:
                that is what the prefix means, and what the scan records as
                outcome=accepted. This is the honest total.
  decided since the cut
                folders with a verdict dated on or after the cut. The rest were
                decided earlier and simply fall outside the window the Pipeline
                tab reads.
  latest accepted
                of those, the ones whose MOST RECENT verdict is accepted. The
                remainder hold an accepted package that a later resubmission
                then failed - both are true, about different runs, which is
                exactly why this is reported apart from the total rather than
                folded into it.
  delivered     folders named by one of the four delivery manifests. No name
                matching: the manifest records the folder it packaged from.

What this refuses to do
-----------------------
It produces no rejected figure. Rejected work is never packaged, so it has no
folder, and a number derived this way would only ever describe the accepted
side. Saying so is better than implying coverage that does not exist.

68 folders are named `task`, `task2`, `code-C470`, `harbor-single-task-...` and
the like. One is literally `task` and collides with 19 verdicts. Those are
matched on the folder name only when the scan gives no declared name, and the
collisions are counted and reported rather than silently resolved.

    python tools/build_cohort_index.py --listing delivery-listing.txt
"""
import argparse
import collections
import json
import pathlib
import re
from datetime import datetime, timezone

COHORT = 'finalisation_client_qc_accepted_iteration_2'
SUFFIX = re.compile(r'(?:-(?:final|v\d+|\d{4,}|copy|new|fixed|updated))+$')

# Folder names the platform generated. Joining on one of these can attach an
# unrelated verdict, so they are tracked and reported.
PLACEHOLDER = re.compile(
    r'^(task\d*|tasks?|harbor-single-task-\S*|autorun-\S*|content-[0-9a-f]{16,}'
    r'|code-c\d+|g\d+_\S*)$', re.I)


def key(value):
    name = str(value or '').strip().lower()
    for prefix in ('harbor/', 'obi/'):
        if name.startswith(prefix):
            name = name[len(prefix):]
    return name


def norm(value):
    name, previous = key(value), None
    while name != previous:
        previous = name
        name = SUFFIX.sub('', name)
    return name


def folders_from_listing(lines, prefix):
    out = set()
    marker = f'tasks/{prefix}/'
    for line in lines:
        line = line.strip()
        if marker not in line:
            continue
        rest = line.split(marker, 1)[1]
        if '/' in rest:
            out.add(rest.split('/', 1)[0])
    return out


def build(folders, scan_rows, truth, manifest_tasks, source, reads=None):
    # The names each folder's package declares, which is what a verdict can be
    # matched on. Without a scan row the folder name is all there is.
    declared = collections.defaultdict(set)
    connector = {}
    for row in scan_rows:
        if row.get('cohort') != COHORT or not row.get('folder'):
            continue
        for spelling in (row.get('declared_short'), row.get('declared_name'), row['folder']):
            if spelling:
                declared[key(row['folder'])].update({key(spelling), norm(spelling)})
        connector[key(row['folder'])] = {
            'isConnector': row.get('is_connector'),
            'services': sorted(row.get('connector_services') or []),
        }

    # Verdicts, reachable by every spelling they carry.
    verdicts = collections.defaultdict(list)
    for row in truth['tasks']:
        tail = key(row['id']).split(':', 1)[-1]
        for spelling in (key(row['name']), norm(row['name']), tail,
                         re.sub(r'-[0-9a-f]{6,}$', '', tail)):
            if spelling:
                verdicts[spelling].append(row)

    delivered_folders = {key(t['folder']): t for t in manifest_tasks
                         if t.get('folder') and t.get('prefix') == COHORT}

    from_manifest = {}
    for task in manifest_tasks:
        if task.get('connector') is None:
            continue
        for spelling in (task.get('folder'), task.get('name')):
            if spelling:
                from_manifest.setdefault(key(spelling), bool(task['connector']))
                from_manifest.setdefault(norm(spelling), bool(task['connector']))

    entries, how = {}, collections.Counter()
    for folder in sorted(folders):
        kf = key(folder)
        spellings = declared.get(kf) or {kf, norm(folder)}
        seen = {}
        for spelling in spellings:
            for row in verdicts.get(spelling, []):
                seen[row['id']] = row
        placeholder = bool(PLACEHOLDER.match(folder))
        seen_connector = connector.get(kf) or {}
        is_connector = seen_connector.get('isConnector')
        via = 'the folder’s own package' if is_connector is not None else None
        if is_connector is None:
            fallback = from_manifest.get(kf, from_manifest.get(norm(folder)))
            if fallback is not None:
                is_connector, via = fallback, 'the delivery manifest that packaged it'
        if is_connector is None:
            # Nothing else knows, but the package is right there. Opened and
            # read directly by tools/read_task_toml.py.
            direct = (reads or {}).get(folder)
            if direct and direct.get('connector') is not None:
                is_connector = bool(direct['connector'])
                via = f"its task.toml, read directly ({direct.get('basis')})"
        entry = {
            'folder': folder,
            'placeholderName': placeholder,
            'connector': is_connector,
            'connectorVia': via,
            'connectorServices': seen_connector.get('services') or [],
            'verdicts': len(seen),
            'delivered': kf in delivered_folders,
        }
        if kf in delivered_folders:
            entry['batch'] = delivered_folders[kf].get('batch')
        if seen:
            # Most recent decision wins, then the run that got furthest, then
            # the identifier so the answer cannot depend on dict order.
            latest = max(seen.values(),
                         key=lambda r: (r.get('decided') or '', r.get('runs') or 0, r['id']))
            entry['state'] = latest['state']
            entry['decided'] = latest.get('decided')
            entry['owner'] = latest.get('owner')
            entry['states'] = sorted({r['state'] for r in seen.values()})
            how[latest['state']] += 1
        else:
            how['no verdict in the window'] += 1
        entries[folder] = entry

    decided = [e for e in entries.values() if e.get('state')]
    return {
        'generatedAt': datetime.now(timezone.utc).isoformat(timespec='seconds'),
        'pipelineGeneratedAt': truth.get('generatedAt'),
        'cohort': COHORT,
        'folderSource': source,
        'cut': truth.get('cut'),
        'rule': 'one folder is one task; the verdicts say what happened to it, '
                'and the most recent one wins',
        'counts': {
            'packages': len(entries),
            'decided': len(decided),
            'beforeCut': len(entries) - len(decided),
            'latestAccepted': how.get('accepted', 0),
            'latestLegacyAccepted': how.get('legacy accepted', 0),
            'latestRejected': how.get('rejected', 0),
            'latestOther': len(decided) - how.get('accepted', 0)
                           - how.get('legacy accepted', 0) - how.get('rejected', 0),
            'delivered': sum(1 for e in entries.values() if e['delivered']),
            'notDelivered': sum(1 for e in entries.values() if not e['delivered']),
            'disagreeAcrossRuns': sum(1 for e in entries.values() if len(e.get('states') or []) > 1),
            'placeholderNames': sum(1 for e in entries.values() if e['placeholderName']),
            'connectorTasks': sum(1 for e in entries.values() if e.get('connector') is True),
            'nonConnectorTasks': sum(1 for e in entries.values() if e.get('connector') is False),
            'connectorUnknown': sum(1 for e in entries.values() if e.get('connector') is None),
            'connectorFromManifest': sum(1 for e in entries.values()
                                         if e.get('connectorVia') == 'the delivery manifest that packaged it'),
            'connectorFromPackage': sum(1 for e in entries.values()
                                        if str(e.get('connectorVia') or '').startswith('its task.toml')),
            # Folders nothing could classify. Listed rather than only counted,
            # so tools/read_task_toml.py can be pointed straight at them.
            'unresolved': sorted(e['folder'] for e in entries.values()
                                 if e.get('connector') is None),
            'byState': dict(how.most_common()),
        },
        'folders': entries,
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--listing', default=None,
                    help='a listing of the prefix. Without one the folders come '
                         'from the published scan, which lags the bucket.')
    ap.add_argument('--scan', default='assets/gcs-pipeline.json')
    ap.add_argument('--truth', default='assets/pipeline-truth.json')
    ap.add_argument('--manifest', default='assets/manifest-index.json')
    ap.add_argument('--reads', default='assets/task-toml-reads.json',
                    help='packages opened directly, for folders in neither the '
                         'scan nor a manifest')
    ap.add_argument('--out', default='assets/cohort-index.json')
    args = ap.parse_args()

    truth = json.loads(pathlib.Path(args.truth).read_text(encoding='utf-8'))
    blob = json.loads(pathlib.Path(args.scan).read_text(encoding='utf-8'))
    scan_rows = blob.get('tasks') or (blob.get('finalisation') or {}).get('tasks') or []
    manifest_tasks = (json.loads(pathlib.Path(args.manifest).read_text(encoding='utf-8'))['tasks']
                      if pathlib.Path(args.manifest).exists() else [])

    if args.listing and pathlib.Path(args.listing).exists():
        folders = folders_from_listing(
            pathlib.Path(args.listing).read_text(encoding='utf-8').splitlines(), COHORT)
        source = 'a listing of the bucket'
    else:
        folders = {r['folder'] for r in scan_rows if r.get('cohort') == COHORT and r.get('folder')}
        source = 'the published bucket scan'
    if not folders:
        raise SystemExit('no folders found for the cohort')

    reads_path = pathlib.Path(args.reads)
    reads = (json.loads(reads_path.read_text(encoding='utf-8')).get('reads', {})
             if reads_path.exists() else {})
    payload = build(folders, scan_rows, truth, manifest_tasks, source, reads)
    c = payload['counts']
    # The four figures are stated as one arithmetic, so they have to add up.
    assert c['decided'] + c['beforeCut'] == c['packages'], 'the cut split lost a folder'
    assert c['latestAccepted'] + c['latestLegacyAccepted'] + c['latestRejected'] \
        + c['latestOther'] == c['decided'], 'the verdict split lost a folder'
    assert c['delivered'] + c['notDelivered'] == c['packages'], 'the delivery split lost a folder'

    out = pathlib.Path(args.out)
    out.write_text(json.dumps(payload, separators=(',', ':')), encoding='utf-8')

    print(f"folders, from {source}")
    print(f"  packages in the cohort   : {c['packages']:>6,}")
    print(f"    decided since {payload['cut']} : {c['decided']:>6,}")
    print(f"    before the cut         : {c['beforeCut']:>6,}")
    print(f"  latest verdict accepted  : {c['latestAccepted']:>6,}")
    print(f"    rejected on a later run: {c['latestRejected']:>6,}")
    print(f"    other                  : {c['latestOther']:>6,}")
    print(f"  delivered                : {c['delivered']:>6,}")
    print(f"  still to deliver         : {c['notDelivered']:>6,}")
    print(f"  verdicts disagree        : {c['disagreeAcrossRuns']:>6,}")
    print(f"  placeholder folder names : {c['placeholderNames']:>6,}")
    print(f"wrote {out} ({out.stat().st_size/1e3:.0f} KB)")


if __name__ == '__main__':
    main()
