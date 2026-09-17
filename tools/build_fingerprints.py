"""Compute a content fingerprint for every delivered task archive.

Two stages, deliberately separated:

  1. Read each archive's ZIP index once and cache it. Costs two ranged requests
     per archive and transfers no file content. An archive is named by the
     sha256 of its bytes, so a cached index can never go stale - it is re-read
     only if the archive is new.
  2. Compute fingerprints from the cache. This touches no network at all, so
     changing the recipe in tools/fingerprint.py and recomputing is seconds of
     work rather than another full pass over the bucket.

Read-only. Lists and range-reads bucket objects; writes only local files.

    python3 tools/build_fingerprints.py                  # full run
    python3 tools/build_fingerprints.py --limit 50       # quick check
    python3 tools/build_fingerprints.py --offline        # recompute from cache
"""
import argparse
import gzip
import json
import sys
import urllib.parse
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import fingerprint as F
import scan_bucket as S

# Cohorts stored as <task>/<sha>.zip. The others hold extracted trees or flat
# zips and carry no per-task archive to fingerprint.
COHORTS = ('finalisation_client_qc_accepted_iteration_1',
           'finalisation_client_qc_accepted_iteration_2',
           'finalisation_client_qc_accepted_iteration_2_glm52_gate_only',
           'finalization_qc_accepted')

DEFAULT_CACHE = Path.home() / 'harbor_gce' / 'fingerprint-index-cache.json.gz'
OUT = Path('assets/task-fingerprints.json')


def list_archives(tok, cohort):
    """Every <task>/<sha>.zip under one cohort, review_handoff excluded."""
    prefix = 'tasks/%s/' % cohort
    items, page = [], None
    while True:
        params = {'prefix': prefix, 'maxResults': 1000,
                  'fields': 'items(name,size,updated),nextPageToken'}
        if page:
            params['pageToken'] = page
        payload = json.loads(S.http(S.API + '?' + urllib.parse.urlencode(params), tok))
        items.extend(payload.get('items', []))
        page = payload.get('nextPageToken')
        if not page:
            break

    archives = []
    for item in items:
        name = item['name']
        if not name.endswith('.zip') or '/review_handoff/' in name:
            continue
        parts = name[len(prefix):].split('/')
        if len(parts) != 2 or not parts[0]:
            continue
        archives.append({'cohort': cohort, 'folder': parts[0], 'sha256': parts[1][:-4],
                         'object': name, 'size': int(item.get('size') or 0),
                         'updated': item.get('updated') or ''})
    return archives


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--cache', default=str(DEFAULT_CACHE))
    parser.add_argument('--limit', type=int, default=0, help='only read N new archives')
    parser.add_argument('--offline', action='store_true', help='recompute from cache only')
    parser.add_argument('--workers', type=int, default=12)
    args = parser.parse_args()

    cache_path = Path(args.cache)
    cache_path.parent.mkdir(parents=True, exist_ok=True)
    try:
        cache = json.loads(gzip.decompress(cache_path.read_bytes()).decode('utf-8'))
    except Exception:
        cache = {}
    print('cache: %s (%d archives already indexed)' % (cache_path, len(cache)), flush=True)

    tok = S.token()
    archives = []
    for cohort in COHORTS:
        found = list_archives(tok, cohort)
        print('  %-58s %5d archives' % (cohort, len(found)), flush=True)
        archives.extend(found)

    missing = [a for a in archives if a['sha256'] not in cache]
    if args.offline:
        print('offline: %d archives not in cache will be skipped' % len(missing), flush=True)
        missing = []
    elif args.limit:
        missing = missing[:args.limit]
    print('reading ZIP index for %d new archives' % len(missing), flush=True)

    def index(archive):
        try:
            members = S.member_table(S.media_url(archive['object']), tok, archive['size'])
            return archive['sha256'], members, None
        except Exception as error:
            return archive['sha256'], None, '%s: %s' % (type(error).__name__, str(error)[:120])

    errors = []
    if missing:
        with ThreadPoolExecutor(max_workers=args.workers) as pool:
            for done, (sha, members, error) in enumerate(pool.map(index, missing), 1):
                if error:
                    errors.append((sha, error))
                else:
                    cache[sha] = members
                if done % 100 == 0:
                    print('  indexed %d/%d' % (done, len(missing)), flush=True)
        cache_path.write_bytes(gzip.compress(json.dumps(cache).encode('utf-8'), 6))
        print('cache written: %d archives, %.1f MB' %
              (len(cache), cache_path.stat().st_size / 1e6), flush=True)

    rows, skipped = [], 0
    for archive in archives:
        members = cache.get(archive['sha256'])
        if members is None:
            skipped += 1
            continue
        rows.append({**{k: archive[k] for k in ('cohort', 'folder', 'sha256', 'updated')},
                     **F.describe(members)})

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps({'recipeVersion': F.RECIPE_VERSION,
                               'archives': len(rows), 'tasks': rows}, indent=1), encoding='utf-8')
    print('\nwrote %s: %d archives, %d not indexed' % (OUT, len(rows), skipped))

    # The property the whole approach rests on: repeat deliveries of one task
    # must fingerprint the same. Report it rather than assume it.
    by_folder = defaultdict(set)
    for row in rows:
        if row['fingerprint']:
            by_folder[(row['cohort'], row['folder'])].add(row['fingerprint'])
    repeats = {k: v for k, v in by_folder.items() if len(v) >= 1}
    multi = [k for k, v in by_folder.items() if len(v) > 1]
    counts = defaultdict(int)
    for row in rows:
        counts[row['fingerprint']] += 1

    print('\n--- identity ---')
    print('distinct fingerprints        : %d' % len({r['fingerprint'] for r in rows if r['fingerprint']}))
    print('archives sharing an identity : %d' % sum(c for c in counts.values() if c > 1))
    print('folders with >1 archive      : %d' % len([k for k, v in by_folder.items() if v]))
    print('  of those, disagreeing      : %d' % len(multi))
    print('archives with no fingerprint : %d' % len([r for r in rows if not r['fingerprint']]))
    for sha, error in errors[:10]:
        print('ERROR %s %s' % (sha[:16], error))
    if len(errors) > 10:
        print('... and %d more read errors' % (len(errors) - 10))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
