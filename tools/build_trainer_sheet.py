#!/usr/bin/env python3
"""The CompanyBench Trainer Credit sheet, as the Delivery tab's trainer fallback.

The bucket names no one, or several people, for many delivered packages: a
manifest names no trainer, a task can be reworked by a second person, and a
service account or lead can re-run it. The ops team's "CompanyBench Trainer
Credit Analysis Report" (Drive, owner jagadeesh.g) says who the trainer is for
the tasks it covers, in three tabs:

  Zeta - Trainer Mapping      Company Bench (Zeta)   Task Name, DataOS folder, TT Task ID
  Astr - Trainer Mapping      Company Bench (Aster)  Task Name, Harbor Task Name, TT Task ID
  Non-Company Bench Mapping   Computer Bench         Task Name, Harbor Task Name, TT Task ID

This reads those tabs from a downloaded copy of the workbook and writes
assets/trainer-sheet.json: per sheet row, the tab, the names it can be matched
on and the trainer's email - nothing else from the sheet (no payment status,
POD lead or review notes), because the dashboard is public.

The page (delivery-audit.js) uses it only where the bucket's owner index names
no one or several people; a trainer the bucket names is never replaced. The
names are matched in every spelling the Drive manifests use for one task:
namespace and .zip dropped, underscores as hyphens, a task_ prefix, a
-<hash>-vN tail, a version suffix, and a leading Task Tracker id (100601-...).
delivery-audit.js trainerSheetKeys repeats that for the Drive row's side.

    python tools/build_trainer_sheet.py --xlsx "CompanyBench Trainer Credit Analysis Report.xlsx"
"""
import argparse
import collections
import json
import os
import pathlib
import re
from datetime import datetime, timezone

TABS = {
    'Zeta - Trainer Mapping': ('zeta', ['Task Name', 'Delivered As (DataOS folder)']),
    'Astr - Trainer Mapping': ('aster', ['Task Name', 'Harbor Task Name']),
    'Non-Company Bench Mapping': ('non-company', ['Task Name', 'Harbor Task Name']),
}
NOT_A_PERSON = re.compile(r'gserviceaccount\.com$|^companybench@|^dev@localhost$|harbor-operator', re.I)


def variants(value):
    """Every spelling of one task name a manifest or the sheet may use."""
    v = str(value or '').strip().lower()
    if not v or v == 'none':
        return set()
    v = re.sub(r'^(harbor|obi)/', '', v)
    v = re.sub(r'\.zip$', '', v)
    out = {v, v.replace('_', '-')}
    for x in list(out):
        y = re.sub(r'^task-', '', x)
        z = re.sub(r'-[0-9a-f]{6}-v\d+$', '', y)
        out |= {y, z, re.sub(r'(-v\d+|-fixed|-final)+$', '', z)}
        m = re.match(r'^\d{6}-(.+)$', z)
        if m:
            out.add(m.group(1))
    # Very short strings are ids or fragments, not names; they would match by accident.
    return {x for x in out if len(x) > 6}


def tracker_id(value):
    v = str(value or '').strip().lower()
    if v.endswith('.0'):
        v = v[:-2]
    return f'tt:{v}' if v and v != 'none' else None


def entries_of(xlsx):
    import openpyxl
    book = openpyxl.load_workbook(xlsx, read_only=True, data_only=True)
    out = []
    for tab, (short, columns) in TABS.items():
        rows = book[tab].iter_rows(values_only=True)
        head = next(rows)
        for values in rows:
            if not any(v not in (None, '') for v in values):
                continue
            record = dict(zip(head, values))
            keys = set()
            for column in columns:
                for part in str(record.get(column) or '').split(','):
                    keys |= variants(part)
            tt = tracker_id(record.get('TT Task ID'))
            if tt:
                keys.add(tt)
            email = str(record.get('Trainer Email') or '').strip().lower()
            out.append({
                'tab': short,
                'task': str(record.get('Task Name') or '').strip() or None,
                'trainer': email if '@' in email and not NOT_A_PERSON.search(email) else None,
                'keys': sorted(keys),
            })
    return out


def row_keys(row):
    """The Drive row's side - mirrored by delivery-audit.js trainerSheetKeys."""
    keys = set()
    parts = [p for p in str(row.get('sourceUri') or '').split('/') if p]
    for value in (row.get('task'), row.get('packageName'), row.get('sourceFolder'),
                  str(row.get('packagePath') or '').split('/')[-1],
                  parts[-1] if parts else None, parts[-2] if len(parts) > 1 else None):
        keys |= variants(value)
    for value in (row.get('packageName'), row.get('sourceFolder')):
        text = str(value or '').lower()
        m = re.match(r'^(\d{6})-', text) or re.match(r'^(astr_\d+|cb\d_\d+)', text)
        if m:
            keys.add(f'tt:{m.group(1)}')
    return keys


def coverage(entries, drive, owners):
    index = collections.defaultdict(set)
    for entry in entries:
        for key in entry['keys']:
            index[key].add(entry['trainer'])
    counts = collections.Counter()
    gaps = []
    for row in drive.get('rows') or []:
        owner = owners.get(row['id']) or {}
        state = 'attributed' if owner.get('trainer') else 'contested' if owner else 'unattributed'
        named = set().union(*(index.get(k, set()) for k in row_keys(row)))
        people = sorted(p for p in named if p)
        if state != 'attributed':
            outcome = ('filled' if len(people) == 1 else 'sheet names several' if people
                       else 'sheet row with no trainer' if named else 'not in the sheet')
            counts[f"{row['bench']}:{state}:{outcome}"] += 1
            if outcome != 'filled':
                gaps.append({'id': row['id'], 'batch': row['batch'], 'bench': row['bench'],
                             'task': row['task'], 'package': row.get('packageName'),
                             'state': state, 'candidates': owner.get('candidates') or [],
                             'outcome': outcome, 'sheet': people})
        elif len(people) == 1 and people[0] != str(owner['trainer']).lower():
            counts[f"{row['bench']}:attributed:sheet disagrees"] += 1
            gaps.append({'id': row['id'], 'batch': row['batch'], 'bench': row['bench'],
                         'task': row['task'], 'package': row.get('packageName'), 'state': state,
                         'candidates': [owner['trainer']], 'outcome': 'sheet disagrees (kept)',
                         'sheet': people})
    return dict(sorted(counts.items())), gaps


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--xlsx', required=True)
    ap.add_argument('--drive', default='assets/drive-deliveries.json')
    ap.add_argument('--owners', default='assets/drive-owners.json')
    ap.add_argument('--out', default='assets/trainer-sheet.json')
    ap.add_argument('--gaps', help='write the rows the sheet does not settle to this CSV')
    ap.add_argument('--source-id', default='1fx8qLOfwBQIg_8wqdJxuflpa-xc-_9rL')
    ap.add_argument('--source-modified', default=None)
    args = ap.parse_args()

    entries = entries_of(args.xlsx)
    drive = json.loads(pathlib.Path(args.drive).read_text(encoding='utf-8'))
    owners = json.loads(pathlib.Path(args.owners).read_text(encoding='utf-8')).get('owners') or {}
    counts, gaps = coverage(entries, drive, owners)
    payload = {
        'generatedAt': datetime.now(timezone.utc).isoformat(timespec='seconds'),
        'source': {'title': 'CompanyBench Trainer Credit Analysis Report', 'driveFileId': args.source_id,
                   'modified': args.source_modified},
        'rule': 'used only where the bucket names no trainer or several; a trainer the bucket '
                'names is kept. One sheet trainer for the task fills it; several leave it contested.',
        'tabs': dict(collections.Counter(e['tab'] for e in entries)),
        'withoutTrainer': sum(1 for e in entries if not e['trainer']),
        'ownersGeneratedAt': json.loads(pathlib.Path(args.owners).read_text(encoding='utf-8')).get('generatedAt'),
        'coverage': counts,
        'entries': [{k: v for k, v in e.items() if v not in (None, [])} for e in entries],
    }
    out = pathlib.Path(args.out)
    partial = out.with_name(out.name + '.new')
    partial.write_text(json.dumps(payload, separators=(',', ':')), encoding='utf-8')
    os.replace(partial, out)
    print(f'{len(entries)} sheet rows ({payload["tabs"]}), {payload["withoutTrainer"]} without a trainer')
    for key, n in counts.items():
        print(f'  {key:<55} {n:>5}')
    print(f'wrote {out} ({out.stat().st_size / 1e3:.0f} KB)')
    if args.gaps:
        import csv
        with open(args.gaps, 'w', newline='', encoding='utf-8-sig') as handle:
            writer = csv.writer(handle)
            writer.writerow(['batch', 'bench', 'task', 'package', 'dashboard now', 'bucket candidates',
                             'sheet', 'why not filled'])
            for g in sorted(gaps, key=lambda g: (g['bench'], g['batch'], g['task'])):
                writer.writerow([g['batch'], g['bench'], g['task'], g['package'] or '', g['state'],
                                 '; '.join(g['candidates']), '; '.join(g['sheet']), g['outcome']])
        print(f'wrote {args.gaps} ({len(gaps)} rows)')


if __name__ == '__main__':
    main()
