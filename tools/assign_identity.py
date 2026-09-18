#!/usr/bin/env python3
"""Step 3: give every verdict row an identity, and record how it was decided.

A task is a family of runs, not a name. The ladder is tried in order and the
method that succeeded is written onto the row, so the dashboard can state how
much of a figure rests on a strong key and how much on a guess:

    1 family_id            high     caller-supplied but stable across reruns
    2 runnable fingerprint high     content hash; needs the package, so costly
    3 task_id              low      over-splits: ~1 identity per row, marked unmerged
    4 name + owner         lowest   labelled a guess. Never name alone.

Name alone is excluded deliberately: the literal name `task` carries dozens of
runs across unrelated families and trainers, so keying on it silently fuses
different people's work.

This step does the three cheap rungs and reports exactly how many rows would
need rung 2, so the expensive path is only paid where it changes an answer.

    python3 assign_identity.py --verdicts verdicts.json --delivery delivery.json
"""
import argparse
import collections
import json
from datetime import datetime, timezone
from pathlib import Path


def name_key(value):
    v = str(value or '').strip().lower()
    for p in ('harbor/', 'obi/'):
        if v.startswith(p):
            v = v[len(p):]
    return v


def decided_day(row):
    """Scope is cut on the decision, not the upload. 20% of verdicts carry no
    decided_at, so updated_at stands in and the row says so."""
    return str(row.get('decidedAt') or row.get('updatedAt') or '')[:10]


def assign(rows):
    out = []
    for row in rows:
        if row.get('familyId'):
            key, method, confidence = f"family:{row['familyId']}", 'family_id', 'high'
        elif row.get('taskId'):
            key, method, confidence = f"task:{row['taskId']}", 'task_id', 'low'
        else:
            who = row.get('owner') or 'unowned'
            key = f"declared:{name_key(row.get('taskName') or row.get('submission'))}|{who}"
            method, confidence = 'name+owner', 'lowest'
        out.append(dict(row, identity=key, identityMethod=method,
                        identityConfidence=confidence, decidedDay=decided_day(row)))
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--verdicts', default='verdicts.json')
    ap.add_argument('--delivery', default='delivery.json')
    ap.add_argument('--out', default='identities.json')
    args = ap.parse_args()

    payload = json.loads(Path(args.verdicts).read_text(encoding='utf-8'))
    rows = assign(payload['rows'])
    delivery = json.loads(Path(args.delivery).read_text(encoding='utf-8'))
    delivered = set(delivery['tasks'])

    methods = collections.Counter(r['identityMethod'] for r in rows)
    identities = collections.defaultdict(list)
    for r in rows:
        identities[r['identity']].append(r)

    print(f'{len(rows):,} verdict rows -> {len(identities):,} identities\n')
    print('by method (rows):')
    for m, n in methods.most_common():
        ids = len({r['identity'] for r in rows if r['identityMethod'] == m})
        print(f'  {m:<12} {n:>6,} rows  ->  {ids:>6,} identities  ({100*n/len(rows):.0f}% of rows)')

    # --- does the strong key actually hold? ---------------------------------
    fam = {k: v for k, v in identities.items() if k.startswith('family:')}
    multi_owner = [k for k, v in fam.items()
                   if len({r['owner'] for r in v if r['owner']}) > 1]
    print(f'\nfamilies spanning more than one owner : {len(multi_owner)} of {len(fam):,}')
    for k in multi_owner[:3]:
        print(f'    {k[:46]}  owners={sorted({r["owner"] for r in fam[k] if r["owner"]})}')

    # --- what the discarded alternative would have done ----------------------
    by_name = collections.defaultdict(set)
    for r in rows:
        n = name_key(r.get('taskName') or '')
        if n:
            by_name[n].add(r['identity'])
    fused = {n: ids for n, ids in by_name.items() if len(ids) > 1}
    print(f'\nif keyed on NAME alone, names fusing several identities: {len(fused):,}')
    for n, ids in sorted(fused.items(), key=lambda kv: -len(kv[1]))[:5]:
        print(f'    {len(ids):>3} identities under the one name {n[:52]!r}')

    # --- how much would rung 2 (fingerprint) actually buy? -------------------
    weak = [r for r in rows if r['identityMethod'] != 'family_id']
    weak_delivered = [r for r in weak if name_key(r.get('taskName')) in delivered]
    weak_ids = {r['identity'] for r in weak}
    print(f'\nrows on a weak key                    : {len(weak):,} -> {len(weak_ids):,} identities')
    print(f'  of those, the task has a package      : {len(weak_delivered):,}'
          f'  <- fingerprintable without guessing')
    print(f'  no package, so unfingerprintable      : {len(weak) - len(weak_delivered):,}')

    # --- scope, on the decision date ----------------------------------------
    CUT = '2026-09-05'
    in_scope = {k for k, v in identities.items()
                if max(decided_day(r) for r in v) >= CUT}
    print(f'\nidentities whose latest decision >= {CUT}: {len(in_scope):,}'
          f'   (legacy: {len(identities) - len(in_scope):,})')
    inferred = sum(1 for r in rows if r['decidedAtInferred'])
    print(f'  rows dating off updated_at rather than decided_at: {inferred:,}'
          f' ({100*inferred/len(rows):.0f}%)')

    out = {
        'generatedAt': datetime.now(timezone.utc).isoformat(timespec='seconds'),
        'step': '3-identity',
        'source': {'verdicts': payload['generatedAt'], 'delivery': delivery['generatedAt']},
        'ladder': ['family_id', 'runnable_fingerprint', 'task_id', 'name+owner'],
        'coverage': {
            'rows': len(rows),
            'identities': len(identities),
            'byMethod': dict(methods),
            'familiesSpanningOwners': len(multi_owner),
            'namesFusingIdentities': len(fused),
            'weakRows': len(weak),
            'weakRowsWithPackage': len(weak_delivered),
            'inScopeIdentities': len(in_scope),
            'legacyIdentities': len(identities) - len(in_scope),
            'decidedAtInferredRows': inferred,
        },
        'rows': rows,
    }
    Path(args.out).write_text(json.dumps(out, separators=(',', ':')), encoding='utf-8')
    print(f'\nwrote {args.out} ({Path(args.out).stat().st_size/1e6:.1f} MB)')


if __name__ == '__main__':
    main()
