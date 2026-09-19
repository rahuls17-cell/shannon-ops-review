#!/usr/bin/env python3
"""Extract the delivery audit dataset from the published delivery dashboard.

The delivery dashboard (rahuls17-cell/shannon-delivery-dashboard) publishes a
single self-contained index.html with its data inline in a
<script type="application/json"> block. That page is rebuilt by a VM cron, so
the data moves; this pulls the block out and writes it as a plain asset the ops
dashboard can read like any other.

Only the data is taken. The page's own markup, styles and scripts are not used -
the Delivery tab renders these rows in its own design system.

    python tools/build_delivery_audit.py                 # from the published page
    python tools/build_delivery_audit.py --from <file>   # from a local copy
"""
import argparse
import json
import pathlib
import re
import urllib.request
from datetime import datetime, timezone

SOURCE = 'https://rahuls17-cell.github.io/shannon-delivery-dashboard/'
BLOCK = re.compile(r'<script[^>]*type="application/json"[^>]*>(.*?)</script>', re.S)

# Fields the Delivery tab actually renders. Everything else in the source row is
# dropped, so the asset stays small and the page cannot quietly depend on a
# field nobody reviewed.
KEEP = ('id', 'task', 'batch', 'category', 'type', 'difficulty', 'glm', 'bucket',
        'versions', 'trainer', 'source', 'sha', 'size_mb', 'connectors', 'dates',
        'priority', 'qc_result', 'acceptance', 'feedback_url',
        'ambiguous', 'unverified', 'version_dependent')

PIPELINE = 'assets/pipeline-truth.json'


def name_key(value):
    return str(value or '').strip().lower()


def resolve_owners(rows, pipeline_path):
    """Fill missing and contested attribution from the GCS verdicts.

    The audit workbook leaves 12 tasks unattributed and marks 6 as contested.
    The pipeline knows who submitted many of them, so those gaps can be closed
    without touching the Pipeline tab - this only reads it.

    Two rules keep it honest:
      - resolve only when the pipeline has EXACTLY ONE owner for that task name.
        A name with several owners is the same ambiguity in a different place,
        not an answer.
      - never overwrite an attribution the workbook already made, except where
        the workbook itself says the owner is contested.
    Every row that changes records where its new owner came from.
    """
    path = pathlib.Path(pipeline_path)
    if not path.exists():
        return rows, {'skipped': 'no pipeline asset'}

    truth = json.loads(path.read_text(encoding='utf-8'))
    owners = {}
    for row in truth['tasks']:
        if row.get('owner'):
            owners.setdefault(name_key(row['name']), set()).add(row['owner'])

    stats = {'resolved': 0, 'stillAmbiguous': 0, 'notInPipeline': 0, 'untouched': 0}
    for row in rows:
        trainer = row.get('trainer')
        missing = not trainer or str(trainer).strip().lower() == 'unattributed'
        contested = row.get('ambiguous') or row.get('source') == 'Contested'
        if not (missing or contested):
            stats['untouched'] += 1
            continue
        candidates = owners.get(name_key(row.get('task')))
        if not candidates:
            stats['notInPipeline'] += 1
        elif len(candidates) > 1:
            stats['stillAmbiguous'] += 1
            row['pipelineOwners'] = sorted(candidates)
        else:
            row['trainerFromWorkbook'] = trainer
            row['trainer'] = next(iter(candidates))
            row['trainerResolvedFrom'] = 'GCS verdicts'
            row['sourceFromWorkbook'] = row.get('source')
            row['source'] = 'GCS verdict owner'
            stats['resolved'] += 1
    stats['pipelineGeneratedAt'] = truth.get('generatedAt')
    return rows, stats


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--from', dest='src', help='local HTML file instead of the published page')
    ap.add_argument('--out', default='assets/delivery-audit.json')
    ap.add_argument('--pipeline', default=PIPELINE,
                    help='pipeline-truth.json, read to fill missing attribution')
    ap.add_argument('--no-resolve', action='store_true',
                    help='keep the workbook attribution exactly as published')
    args = ap.parse_args()

    if args.src:
        html = pathlib.Path(args.src).read_text(encoding='utf-8')
        origin = args.src
    else:
        with urllib.request.urlopen(SOURCE, timeout=60) as response:
            html = response.read().decode('utf-8')
        origin = SOURCE

    match = BLOCK.search(html)
    if not match:
        raise SystemExit('no inline JSON block found; the published page may have changed shape')
    data = json.loads(match.group(1))
    rows = data['rows']
    summary = data['summary']

    trimmed = [{k: row.get(k) for k in KEEP} for row in rows]
    if args.no_resolve:
        attribution = {'skipped': 'disabled with --no-resolve'}
    else:
        trimmed, attribution = resolve_owners(trimmed, args.pipeline)
    dropped = sorted(set(rows[0]) - set(KEEP)) if rows else []

    payload = {
        'generatedAt': datetime.now(timezone.utc).isoformat(timespec='seconds'),
        'source': origin,
        # The source page stamps when ITS data was built. That is the date that
        # matters for reading these figures, not when this extract ran.
        'dataGeneratedAt': summary.get('generated_at'),
        'statusGeneratedAt': summary.get('status_generated_at'),
        'statusSource': summary.get('status_source'),
        'summary': summary,
        'droppedFields': dropped,
        'attribution': attribution,
        'rows': trimmed,
    }
    out = pathlib.Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(payload, separators=(',', ':')), encoding='utf-8')

    print(f'{len(trimmed):,} rows from {origin}')
    print(f'  data built  : {payload["dataGeneratedAt"]}  (status {payload["statusGeneratedAt"]})')
    print(f'  kept fields : {len(KEEP)}   dropped: {", ".join(dropped) or "none"}')
    if 'resolved' in attribution:
        print(f'  attribution filled from the pipeline: {attribution["resolved"]}')
        print(f'    still ambiguous (several owners) : {attribution["stillAmbiguous"]}')
        print(f'    absent from the pipeline         : {attribution["notInPipeline"]}')
    print(f'  wrote {out} ({out.stat().st_size/1e3:.0f} KB)')


if __name__ == '__main__':
    main()
