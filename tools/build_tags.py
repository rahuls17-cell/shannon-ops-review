#!/usr/bin/env python3
"""Step 6: turn bucket fields into the filter vocabulary, built from the data.

Every filter offered on the page maps to exactly one field read from GCS. The
vocabulary is emitted with counts rather than hardcoded, so a filter can never
offer a value that does not exist, or miss one that appears tomorrow.

Finding codes come in two grammars and must be normalised differently:

    HARBOR-CHECK-12                     gate checks, numbered; 34 in play
    GATE-ORACLE-REJECTED                gate outcomes, flat
    l1.realism_leakage:8653e0930c22420b KESTREL review findings, per-instance
                                        hash - the layer and dimension are the
                                        tag, the hash is one occurrence

Without stripping the hash suffix the KESTREL findings look like 50 unique
codes that each occur once, which is unfilterable and meaningless. Grouped,
they become a handful of review dimensions.

    python3 build_tags.py --tasks tasks.json --gcs gcs-pipeline.json
"""
import argparse
import collections
import json
import re
from datetime import datetime, timezone
from pathlib import Path

HASH_SUFFIX = re.compile(r':[0-9a-f]{8,}$')
NUMBER_SUFFIX = re.compile(r'-(\d+)$')
DOMAINS = {'code': 'Engineering', 'fin': 'Finance', 'health': 'Health',
           'law': 'Legal', 'gen': 'General', 'bus': 'Business'}


def name_key(value):
    v = str(value or '').strip().lower()
    for p in ('harbor/', 'obi/'):
        if v.startswith(p):
            v = v[len(p):]
    return v


def normalise(code):
    """(family, code) for one raw finding code."""
    raw = str(code)
    stripped = HASH_SUFFIX.sub('', raw)
    if stripped != raw:
        # KESTREL review finding: layer.dimension:<instance hash>
        return stripped, stripped
    m = NUMBER_SUFFIX.search(raw)
    if m and raw.upper().startswith('HARBOR-CHECK'):
        return 'HARBOR-CHECK', raw
    return raw, raw


def domain_of(name):
    prefix = str(name or '').split('-', 1)[0].lower()
    return DOMAINS.get(prefix, 'Not recorded')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--tasks', default='tasks.json')
    ap.add_argument('--gcs', default='pipeline-stats.json',
                    help='bucket scan carrying is_connector per delivered task')
    ap.add_argument('--out', default='tagged.json')
    args = ap.parse_args()

    payload = json.loads(Path(args.tasks).read_text(encoding='utf-8'))
    tasks = payload['tasks']

    # Connector status is structural - mcp_servers in task.toml - so it is only
    # known for tasks whose package was actually scanned. Anything else is
    # recorded as unknown rather than guessed from the name.
    connector = {}
    gcs_path = Path(args.gcs)
    if gcs_path.exists():
        blob = json.loads(gcs_path.read_text(encoding='utf-8'))
        rows = blob.get('tasks') or (blob.get('finalisation') or {}).get('tasks') or []
        for row in rows:
            key = name_key(row.get('declared_short') or row.get('folder') or row.get('declared_name'))
            if key and row.get('is_connector') is not None:
                connector[key] = bool(row['is_connector'])

    out = []
    for task in tasks:
        families, codes = set(), set()
        for raw in (task.get('findingCodes') or []):
            fam, code = normalise(raw)
            families.add(fam)
            codes.add(code)
        # The filter searches every run, so a task that tripped a check on an
        # earlier attempt is still findable after it was fixed and accepted.
        all_families = set()
        for raw in (task.get('findingCodesAllRuns') or []):
            all_families.add(normalise(raw)[0])
        prior_families = set()
        for raw in (task.get('findingsFromOtherRuns') or []):
            prior_families.add(normalise(raw)[0])
        key = name_key(task['name'])
        known = key in connector
        out.append(dict(
            task,
            findingFamilies=sorted(families),
            findingFamiliesAllRuns=sorted(all_families),
            findingFamiliesPrior=sorted(prior_families),
            findingCodesNormalised=sorted(codes),
            domain=domain_of(task['name']),
            isConnector=connector.get(key),
            connectorKnown=known,
            cohortLabels=[c.rstrip('/').rsplit('/', 1)[-1] for c in (task.get('cohorts') or [])],
        ))

    scope = [t for t in out if t['inScope']]

    def tally(field, rows=scope):
        counts = collections.Counter()
        for row in rows:
            value = row.get(field)
            if isinstance(value, list):
                counts.update(value or ['(none)'])
            else:
                counts[value if value not in (None, '') else '(none)'] += 1
        return counts

    vocab = {
        'finalState': tally('finalState'),
        'gateEra': tally('gateEra'),
        'findingFamilies': tally('findingFamiliesAllRuns'),
        'domain': tally('domain'),
        'cohortLabels': tally('cohortLabels'),
        'identityConfidence': tally('identityConfidence'),
        'owner': tally('owner'),
    }

    print(f'{len(out):,} identities / {len(scope):,} in scope\n')
    for field in ('finalState', 'gateEra', 'domain', 'identityConfidence'):
        print(f'{field}:')
        for value, n in vocab[field].most_common(8):
            print(f'  {n:>6,}  {value}')
        print()
    print('finding families (the filter):')
    for value, n in vocab['findingFamilies'].most_common(14):
        print(f'  {n:>6,}  {value}')
    print(f'\ncohorts: {dict(vocab["cohortLabels"].most_common(6))}')
    print(f'distinct owners in scope: {len([k for k in vocab["owner"] if k != "(none)"]):,}')
    known = sum(1 for t in scope if t['connectorKnown'])
    print(f'connector status known for: {known:,}/{len(scope):,} '
          f'({sum(1 for t in scope if t["isConnector"]):,} are connector tasks)')

    Path(args.out).write_text(json.dumps({
        'generatedAt': datetime.now(timezone.utc).isoformat(timespec='seconds'),
        'step': '6-tags',
        'sources': payload.get('sources', {}),
        'vocabulary': {k: dict(v.most_common()) for k, v in vocab.items()},
        'tasks': out,
    }, separators=(',', ':')), encoding='utf-8')
    print(f'\nwrote {args.out} ({Path(args.out).stat().st_size/1e6:.1f} MB)')


if __name__ == '__main__':
    main()
