#!/usr/bin/env python3
"""Classify pipeline tasks as connector or non-connector, from the bucket.

What decides it
---------------
A task is a connector task when its `task.toml` declares `[[environment.mcp_servers]]`
- the gym services it mounts. Never a name prefix: `gen-`, `code-` and the rest
say nothing about whether a task talks to Slack or Jira, and the finalisation
dashboard settled on the same structural rule.

That marker only exists inside a package. So a task with no archive in the
bucket has no answer, and this records it as unknown rather than guessing. Of
6,288 pipeline tasks, 1,563 have a package at the current bar and 99% of those
can be classified; the 4,725 without one mostly cannot, and saying so is the
point.

Why a separate step
-------------------
The ingest chain already sets `connector` in build_tags.py, but it is fed
pipeline-stats.json on the VM, which covers one cohort. The published bucket
scan in gcs-pipeline.json covers three, so it classifies 620 more tasks. The two
agree on every task they both cover - same scanner, same rule - so this widens
coverage without contradicting the chain.

    python tools/build_connector_index.py
"""
import argparse
import collections
import json
import pathlib
import re
from datetime import datetime, timezone

# Kept identical to tools/build_delivered_index.py: the bucket appends these to
# a folder name that the declared task name does not carry.
SUFFIX = re.compile(r'(?:-(?:final|v\d+|\d{4,}|copy|new|fixed|updated))+$')


def key(value):
    name = str(value or '').strip().lower()
    for prefix in ('harbor/', 'obi/'):
        if name.startswith(prefix):
            name = name[len(prefix):]
    return name


def norm(value):
    name = key(value)
    previous = None
    while name != previous:
        previous = name
        name = SUFFIX.sub('', name)
    return name


def build(truth, scan_rows):
    # One entry per spelling the scan offers, so a pipeline task matches whether
    # it is recorded under the declared name or the folder name.
    exact, loose, services = {}, {}, {}
    for row in scan_rows:
        if row.get('is_connector') is None:
            continue
        flag = bool(row['is_connector'])
        svc = sorted(row.get('connector_services') or [])
        for spelling in (row.get('declared_short'), row.get('folder'), row.get('declared_name')):
            if not spelling:
                continue
            exact.setdefault(key(spelling), flag)
            loose.setdefault(norm(spelling), flag)
            if svc:
                services.setdefault(key(spelling), svc)
                services.setdefault(norm(spelling), svc)

    connector, how = {}, collections.Counter()
    used_services = collections.Counter()
    for task in truth['tasks']:
        name, stem = key(task['name']), norm(task['name'])
        if name in exact:
            connector[task['id']] = {'isConnector': exact[name], 'via': 'name'}
        elif stem in loose:
            connector[task['id']] = {'isConnector': loose[stem], 'via': 'normalised name'}
        else:
            how['no package scanned'] += 1
            continue
        found = services.get(name) or services.get(stem)
        if connector[task['id']]['isConnector'] and found:
            connector[task['id']]['services'] = found
            for one in found:
                used_services[one] += 1
        how[connector[task['id']]['via']] += 1

    rows = truth['tasks']
    at_bar = [r for r in rows if r.get('atCurrentBar')]
    classified_at_bar = sum(1 for r in at_bar if r['id'] in connector)
    yes = sum(1 for v in connector.values() if v['isConnector'])

    return {
        'generatedAt': datetime.now(timezone.utc).isoformat(timespec='seconds'),
        'pipelineGeneratedAt': truth.get('generatedAt'),
        'rule': 'connector when task.toml declares [[environment.mcp_servers]]; '
                'never inferred from the task name',
        'counts': {
            'pipelineTasks': len(rows),
            'scannedPackages': sum(1 for r in scan_rows if r.get('is_connector') is not None),
            'classified': len(connector),
            'connector': yes,
            'nonConnector': len(connector) - yes,
            'unknown': len(rows) - len(connector),
            # The honest denominator: a package is the only place the marker
            # lives, so coverage is only meaningful against tasks that have one.
            'withPackageAtBar': len(at_bar),
            'classifiedAtBar': classified_at_bar,
            'byMethod': dict(how),
            'services': dict(used_services.most_common()),
        },
        'connector': connector,
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--truth', default='assets/pipeline-truth.json')
    ap.add_argument('--scan', default='assets/gcs-pipeline.json')
    ap.add_argument('--out', default='assets/connector-index.json')
    args = ap.parse_args()

    truth = json.loads(pathlib.Path(args.truth).read_text(encoding='utf-8'))
    blob = json.loads(pathlib.Path(args.scan).read_text(encoding='utf-8'))
    scan_rows = blob.get('tasks') or (blob.get('finalisation') or {}).get('tasks') or []
    payload = build(truth, scan_rows)

    out = pathlib.Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(payload, separators=(',', ':')), encoding='utf-8')

    c = payload['counts']
    print(f"pipeline tasks        : {c['pipelineTasks']:>6,}")
    print(f"  scanned packages    : {c['scannedPackages']:>6,}")
    print(f"  classified          : {c['classified']:>6,}   {c['byMethod']}")
    print(f"    connector         : {c['connector']:>6,}")
    print(f"    non-connector     : {c['nonConnector']:>6,}")
    print(f"  unknown             : {c['unknown']:>6,}   (no package to read)")
    print(f"  of those with a package at the bar: "
          f"{c['classifiedAtBar']:,}/{c['withPackageAtBar']:,} classified")
    print(f"  services seen       : {len(c['services'])}")
    print(f"wrote {out} ({out.stat().st_size/1e3:.0f} KB)")


if __name__ == '__main__':
    main()
