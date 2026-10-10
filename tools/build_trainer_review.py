#!/usr/bin/env python3
"""The hand-reviewed trainer table, as the Delivery tab's most specific trainer source.

tools/data/trainer-review.tsv is the ops team's per-task review of Delivery rows
the bucket could not settle (Unattributed, or Contested between several people):
the task, its batch, the trainer the review settled on, the trainer's type, a
confidence and how it was found (Task Tracker, harbor, Data-OS). A row with no
trainer is a task the review found has none - an in-house or DataOS variant.

This writes assets/trainer-review.json from it. The page (delivery-audit.js)
gives a reviewed task the review's trainer ahead of the trainer credit sheet and
the bucket: a review names one task and says why, so it is the most specific
answer there is. Only those columns leave the table - no notes or evidence -
because the dashboard is public.

    python tools/build_trainer_review.py
"""
import csv
import json
import os
import pathlib
from datetime import datetime, timezone

ROOT = pathlib.Path(__file__).resolve().parent.parent


def main():
    src = ROOT / 'tools' / 'data' / 'trainer-review.tsv'
    out = ROOT / 'assets' / 'trainer-review.json'
    entries = []
    with open(src, encoding='utf-8') as handle:
        for row in csv.DictReader(handle, delimiter='\t'):
            trainer = (row.get('trainer') or '').strip().lower()
            entries.append({
                'task': row['task'].strip(),
                'batch': row['batch'].strip(),
                'trainer': trainer if '@' in trainer else None,
                'trainerType': (row.get('trainer_type') or '').strip() or None,
                'confidence': (row.get('confidence') or '').strip() or None,
                'mapping': (row.get('mapping') or '').strip() or None,
            })
    keys = [(e['batch'], e['task'].lower()) for e in entries]
    assert len(keys) == len(set(keys)), 'a task is reviewed twice'
    payload = {
        'generatedAt': datetime.now(timezone.utc).isoformat(timespec='seconds'),
        'source': 'ops review of unattributed and contested Delivery rows (tools/data/trainer-review.tsv)',
        'rule': 'a reviewed task takes the review\'s trainer, ahead of the trainer credit sheet and '
                'the bucket; a review with no trainer leaves the task without one and says why',
        'entries': entries,
    }
    partial = out.with_name(out.name + '.new')
    partial.write_text(json.dumps(payload, indent=1), encoding='utf-8')
    os.replace(partial, out)
    named = sum(1 for e in entries if e['trainer'])
    print(f'{len(entries)} reviewed tasks: {named} with a trainer, {len(entries) - named} without; wrote {out}')


if __name__ == '__main__':
    main()
