#!/usr/bin/env python3
"""Open a task's package and read what its task.toml declares.

Why this exists
---------------
Connector status is structural: a task is a connector when its task.toml
declares connector gyms under `mcp_servers`. The bucket scan reads that for
most packages, and a delivery manifest recorded it for anything that shipped -
but a handful of folders are in neither, and were left "not known".

Not knowing is the right answer when there is nothing to read. It is the wrong
answer when the package is sitting right there. This opens it.

The trap this exists to avoid
-----------------------------
All four of the folders that prompted this contain the string `mcp_servers`,
and all four are NON-connectors, because what they actually say is:

    mcp_servers = []

A check for "does task.toml mention mcp_servers" calls every one of them a
connector. The test is whether the list has anything IN it.

The name is never consulted. Among these same folders,
`appointment-backlog-placeholder-and-duplicate-audit` is a connector and
`gen-g91-hotel-rate-parity-audit` is not; no prefix separates them.

READ ONLY - it downloads objects and opens them in memory.

    python tools/read_task_toml.py --folders a,b,c --out assets/task-toml-reads.json
"""
import argparse
import io
import json
import pathlib
import re
import sys
import urllib.parse
import urllib.request
import zipfile
from datetime import datetime, timezone

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from list_delivery_prefix import access_token, list_objects      # noqa: E402

# A bare `mcp_servers = []` is a declaration of nothing. Inline tables and the
# [[environment.mcp_servers]] table form both count only when they carry an
# entry, so the empty list has to be recognised rather than matched as a
# mention of the key.
EMPTY = re.compile(r'^\s*mcp_servers\s*=\s*\[\s*\]\s*$', re.M)
INLINE = re.compile(r'^\s*mcp_servers\s*=\s*\[([^\]]*)\]', re.M)
TABLE = re.compile(r'^\s*\[\[\s*(?:environment\.)?mcp_servers\s*\]\]', re.M)
NAMED = re.compile(r'name\s*=\s*"([^"]+)"')


def classify(text):
    """(is_connector, gyms, how it was read) for one task.toml."""
    if TABLE.search(text):
        gyms = sorted({m for block in re.split(r'\[\[\s*(?:environment\.)?mcp_servers\s*\]\]', text)[1:]
                       for m in NAMED.findall(block.split('[', 1)[0])})
        return True, gyms, 'a [[mcp_servers]] table with entries'
    if EMPTY.search(text):
        return False, [], 'mcp_servers declared and empty'
    inline = INLINE.search(text)
    if inline and inline.group(1).strip():
        return True, sorted(set(NAMED.findall(inline.group(1)))
                            or re.findall(r'"([^"]+)"', inline.group(1))), 'a non-empty mcp_servers list'
    if inline is not None:
        return False, [], 'mcp_servers declared and empty'
    if 'mcp_servers' not in text:
        return False, [], 'task.toml declares no mcp_servers at all'
    return None, [], 'mcp_servers present but not readable'


def fetch(bucket, name, token):
    url = (f'https://storage.googleapis.com/storage/v1/b/{urllib.parse.quote(bucket, safe="")}'
           f'/o/{urllib.parse.quote(name, safe="")}?alt=media')
    request = urllib.request.Request(url, headers={'Authorization': f'Bearer {token}'})
    with urllib.request.urlopen(request, timeout=300) as response:
        return response.read()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--bucket', default='obi-harbor-pipeline')
    ap.add_argument('--prefix', default='tasks/finalisation_client_qc_accepted_iteration_2/')
    ap.add_argument('--folders', required=True, help='comma separated folder names')
    ap.add_argument('--out', default='assets/task-toml-reads.json')
    args = ap.parse_args()

    wanted = [f.strip() for f in args.folders.split(',') if f.strip()]
    token = access_token()

    out = pathlib.Path(args.out)
    reads = (json.loads(out.read_text(encoding='utf-8')).get('reads', {})
             if out.exists() else {})

    for folder in wanted:
        objects = [n for n in list_objects(args.bucket, f'{args.prefix}{folder}/', token)
                   if n.endswith('.zip') and '/review_handoff/' not in n]
        if not objects:
            print(f'  {folder}: no package', file=sys.stderr)
            continue
        with zipfile.ZipFile(io.BytesIO(fetch(args.bucket, objects[0], token))) as archive:
            names = [n for n in archive.namelist() if n.endswith('task.toml')]
            if not names:
                print(f'  {folder}: package holds no task.toml', file=sys.stderr)
                continue
            text = archive.read(names[0]).decode('utf-8', 'replace')
        is_connector, gyms, how = classify(text)
        reads[folder] = {'connector': is_connector, 'services': gyms, 'basis': how,
                         'object': f'gs://{args.bucket}/{objects[0]}',
                         'readOn': datetime.now(timezone.utc).date().isoformat()}
        print(f'  {folder}: {"connector" if is_connector else "non-connector" if is_connector is False else "unreadable"}'
              f' - {how}')

    out.write_text(json.dumps({
        'generatedAt': datetime.now(timezone.utc).isoformat(timespec='seconds'),
        'rule': 'connector when task.toml declares at least one mcp_servers entry; '
                'an empty list is a declaration of nothing',
        'reads': reads,
    }, indent=1), encoding='utf-8')
    print(f'wrote {out} ({len(reads)} packages read)')


if __name__ == '__main__':
    main()
