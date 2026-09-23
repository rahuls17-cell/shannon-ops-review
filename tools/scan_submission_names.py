#!/usr/bin/env python3
"""The [task] name every submission declares, kept before the bucket forgets it.

Why this exists
---------------
A task is re-submitted under a fresh family_id often enough that family_id
alone splits one task into several identities, and the task_id of a
family-keyed row is only "<family_id>-vN", so it adds nothing a family does not
already say. What stays the same across those submissions is the task's own
name, declared in its task.toml:

    family fin-f45-repo-haircut-recompute-3ce01b   declares obi/fin-f45-repo-haircut-recompute
    family fin-f45-repo-haircut-recompute-257981   declares obi/fin-f45-repo-haircut-recompute

The verdict does not carry that name - its `task` field is whatever the
submitting tool called it, often a placeholder such as
harbor-single-task-ehe2ll09 - so it has to be read from the submission folder,
tasks/qc_platform_sync/<submission>/<task dir>/task.toml.

The cache is the point
----------------------
The bucket is pruned: on 2026-09-23, 2,543 of 13,920 verdicts (18%) no longer
had a submission folder to read. A name read once is therefore KEPT: this tool
only ever adds to the cache, never removes an entry and never replaces a name
with a failure. Run it every refresh and the names outlive the folders.

Alongside the name it records a fingerprint of instruction.md (whitespace and
case folded), which link_identity.py uses as evidence that two trainers
submitted the same task rather than two tasks that share a name.

READ ONLY against GCS: object listings and object reads, nothing else.

    python3 scan_submission_names.py --verdicts verdicts.json --cache submission-names.json
"""
import argparse
import hashlib
import json
import pathlib
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from list_delivery_prefix import access_token  # noqa: E402
from scan_task_names import identity           # noqa: E402

BUCKET = 'obi-harbor-pipeline'
PREFIX = 'tasks/qc_platform_sync/'
API = f'https://storage.googleapis.com/storage/v1/b/{BUCKET}/o'


class Reader:
    """GET-only access to the bucket, with the token refreshed before it expires."""

    def __init__(self):
        self.token, self.at = access_token(), time.time()

    def _auth(self):
        if time.time() - self.at > 1800:
            self.token, self.at = access_token(), time.time()
        return {'Authorization': f'Bearer {self.token}'}

    def get(self, url):
        """Body of a GET, None on 404, and an exception after retries otherwise."""
        for attempt in range(4):
            try:
                request = urllib.request.Request(url, headers=self._auth())
                with urllib.request.urlopen(request, timeout=60) as response:
                    return response.read()
            except urllib.error.HTTPError as error:
                if error.code == 404:
                    return None
                if error.code == 401:
                    self.at = 0
            except (urllib.error.URLError, TimeoutError):
                pass
            time.sleep(2 ** attempt)
        raise RuntimeError(f'gave up reading {url[:120]}')

    def dirs(self, prefix):
        query = urllib.parse.urlencode({'prefix': prefix, 'delimiter': '/', 'fields': 'prefixes'})
        return json.loads(self.get(f'{API}?{query}') or b'{}').get('prefixes', [])

    def media(self, name):
        return self.get(f'{API}/{urllib.parse.quote(name, safe="")}?alt=media')


def fingerprint(text):
    return hashlib.sha1(re.sub(r'\s+', ' ', text).strip().lower().encode()).hexdigest()[:12]


def read_submission(reader, submission):
    """The declared name and instruction fingerprint of one submission folder."""
    try:
        # The task lives in a subdirectory; the _underscore entries beside it are
        # the pipeline's own bookkeeping.
        dirs = [d for d in reader.dirs(f'{PREFIX}{submission}/')
                if not d.rstrip('/').rsplit('/', 1)[-1].startswith('_')]
        for folder in dirs:
            toml = reader.media(folder + 'task.toml')
            if toml is None:
                continue
            name = identity(toml.decode('utf-8', 'replace'))[0]
            instruction = reader.media(folder + 'instruction.md')
            return {
                'name': name,
                'instruction': fingerprint(instruction.decode('utf-8', 'replace')) if instruction else None,
                'taskDir': folder.rstrip('/').rsplit('/', 1)[-1],
                'readAt': datetime.now(timezone.utc).isoformat(timespec='seconds'),
            }
        return {'missing': 'no submission folder' if not dirs else 'no task.toml in the folder'}
    except Exception as error:                              # noqa: BLE001
        return {'missing': f'{type(error).__name__}: {error}'[:160]}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--verdicts', default='verdicts.json', help='step 1 output; its submissions are read')
    ap.add_argument('--cache', default='submission-names.json', help='kept between runs and only ever added to')
    ap.add_argument('--workers', type=int, default=32)
    ap.add_argument('--retry-missing', action='store_true',
                    help='also re-read submissions that previously had no folder (a folder can reappear)')
    args = ap.parse_args()

    rows = json.loads(pathlib.Path(args.verdicts).read_text(encoding='utf-8'))['rows']
    submissions = sorted({r['submission'] for r in rows if r.get('submission')})
    cache_path = pathlib.Path(args.cache)
    cache = json.loads(cache_path.read_text(encoding='utf-8'))['submissions'] if cache_path.exists() else {}

    todo = [s for s in submissions
            if s not in cache or ('name' not in cache[s] and args.retry_missing)]
    print(f'{len(submissions):,} submissions, {len(cache):,} cached, reading {len(todo):,}', flush=True)

    reader = Reader()
    added = kept = 0
    started = time.time()
    with ThreadPoolExecutor(args.workers) as pool:
        for submission, found in zip(todo, pool.map(lambda s: read_submission(reader, s), todo)):
            if 'name' in found or submission not in cache:
                cache[submission] = found
                added += 'name' in found
            else:
                kept += 1                       # never replace what we had with a failure

    named = sum(1 for v in cache.values() if v.get('name'))
    print(f'read {len(todo):,} in {time.time() - started:.0f}s: {added:,} newly named, '
          f'{kept:,} kept from before; cache now names {named:,} of {len(cache):,}', flush=True)

    out = {
        'generatedAt': datetime.now(timezone.utc).isoformat(timespec='seconds'),
        'prefix': f'gs://{BUCKET}/{PREFIX}',
        'rule': 'the [task] name declared in the submission folder task.toml; entries are never removed',
        'counts': {'submissions': len(cache), 'named': named, 'missing': len(cache) - named},
        'submissions': cache,
    }
    tmp = cache_path.with_suffix(cache_path.suffix + '.new')
    tmp.write_text(json.dumps(out, separators=(',', ':')), encoding='utf-8')
    tmp.replace(cache_path)


if __name__ == '__main__':
    main()
