"""Prove tools/scan_bucket.py reproduces the original scanner exactly.

assets/gcs-pipeline.json was produced by the scanner this module replaces, so
its finalisation rows are the only ground truth available. Every archive it
names is re-read from the bucket and re-classified; any field that differs is a
failure. Read-only: the bucket is listed and range-read, never written.

    python3 tools/test_scan_bucket.py                 # every archive
    python3 tools/test_scan_bucket.py --sample 60     # deterministic subset
"""
import argparse
import json
import random
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import scan_bucket as S

FIELDS = ('connector_provenance', 'connector_services', 'declared_name',
          'declared_short', 'domain', 'image', 'is_connector', 'prefix')
# Only task_zip cohorts store <task>/<sha>.zip; the others are not archives.
ARCHIVE_COHORTS = ('finalisation_client_qc_accepted_iteration_1',
                   'finalisation_client_qc_accepted_iteration_2',
                   'finalization_qc_accepted')


def task_toml_member(directory):
    """The task's own task.toml, not one vendored inside a fixture tree."""
    top = [k for k in directory if k.endswith('/task.toml') and k.count('/') == 1]
    if top:
        return top[0]
    rest = sorted((k for k in directory if k.endswith('task.toml')), key=lambda k: k.count('/'))
    return rest[0] if rest else None


def check(row, tok):
    name = 'tasks/%s/%s/%s.zip' % (row['cohort'], row['folder'], row['sha256'])
    try:
        url = S.media_url(name)
        directory = S.central_directory(url, tok, row['sizeBytes'])
        member = task_toml_member(directory)
        if member is None:
            return row, None, 'no task.toml in archive'
        method, compressed, offset = directory[member]
        facts = S.classify(S.read_entry(url, tok, method, compressed, offset), row['folder'])
    except Exception as error:
        return row, None, '%s: %s' % (type(error).__name__, str(error)[:120])
    return row, facts, None


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--sample', type=int, default=0, help='check N archives instead of all')
    parser.add_argument('--seed', type=int, default=20260917)
    parser.add_argument('--workers', type=int, default=8)
    args = parser.parse_args()

    known = json.loads(Path('assets/gcs-pipeline.json').read_text(encoding='utf-8'))
    rows = [r for r in known['finalisation']['tasks']
            if r['cohort'] in ARCHIVE_COHORTS and r.get('sha256') and r.get('sizeBytes')]
    if args.sample and args.sample < len(rows):
        rows = random.Random(args.seed).sample(rows, args.sample)

    print('checking %d archives against the original scanner output' % len(rows), flush=True)
    tok = S.token()
    matched, diffs, errors = 0, [], []
    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        for index, (row, facts, error) in enumerate(pool.map(lambda r: check(r, tok), rows), 1):
            if error:
                errors.append((row['folder'], error))
            elif all(facts[f] == row.get(f) for f in FIELDS):
                matched += 1
            else:
                diffs.append((row['folder'], {f: (facts[f], row.get(f))
                                              for f in FIELDS if facts[f] != row.get(f)}))
            if index % 200 == 0:
                print('  %d/%d' % (index, len(rows)), flush=True)

    print('\nmatched %d / %d' % (matched, len(rows)))
    for folder, fields in diffs[:20]:
        print('DIFF %s' % folder)
        for field, (got, want) in fields.items():
            print('     %-22s got=%r want=%r' % (field, got, want))
    if len(diffs) > 20:
        print('... and %d more differing archives' % (len(diffs) - 20))
    for folder, error in errors[:20]:
        print('ERROR %s  %s' % (folder, error))
    if len(errors) > 20:
        print('... and %d more errors' % (len(errors) - 20))

    if diffs or errors:
        print('\nFAIL: %d differ, %d errored' % (len(diffs), len(errors)))
        return 1
    print('\nPASS: every archive classified identically to the original scanner')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
