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

# The base image a task runs in, taken from the FROM line of
# environment/Dockerfile. It is the only place the bench shows: task.toml does
# not carry it and the bucket scan records it for none of the 2,022 packages
# it covers.
#
# FROM takes flags before the image - `FROM --platform=linux/amd64 <image>` is
# common here - so the flags have to be skipped. Reading the first token instead
# captured `--platform=linux/amd64` as the image for 106 of the tasks scanned,
# every one of which then classified as no bench at all.
# A leading byte order mark (a Dockerfile saved by a Windows editor) must not hide the FROM line.
FROM_LINE = re.compile(r'^\ufeff?\s*FROM\s+(?:--\S+\s+)*(\S+)', re.M | re.I)

# Which bench a connector task belongs to, derived from that image. Checked
# against the 348 labelled rows in the reference sheet, which it reproduces
# exactly. Order matters: benchmark-base sits under data-obi-rl-gym and is a
# company image, while obi-benchmark under connectors-rl-gym is a computer one,
# so the registry path is tested before the image name.
def bench_type(image):
    im = str(image or '').lower()
    if not im:
        return None
    if 'connectors-harness-aster' in im:
        return 'company bench aster'
    if 'real-data' in im:
        return 'computer bench real'
    if 'connectors-rl-gym' in im:
        return 'computer bench synth'
    if 'company-bench-private' in im or 'benchmark-base' in im or 'data-obi-rl-gym' in im:
        return 'company bench zeta'
    if 'connectors-harness' in im:
        return 'computer bench synth'
    return None


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


def media_url(bucket, name):
    return (f'https://storage.googleapis.com/storage/v1/b/{urllib.parse.quote(bucket, safe="")}'
            f'/o/{urllib.parse.quote(name, safe="")}?alt=media')


class RemoteZip(io.RawIOBase):
    """A seekable file over a GCS object, fetched in ranges.

    A package is 6-10 MB and the two files worth reading are a few kilobytes.
    Downloading the whole archive to reach them would be about 2.7 GB across
    the cohort - enough that the read would only ever be done once, by hand,
    and would then rot.

    A zip keeps its directory at the END, so zipfile seeks there first and then
    seeks straight to the member it wants. Serving those seeks with HTTP Range
    requests means only the bytes actually needed cross the wire: about 40 KB
    per package rather than 8 MB. That is what makes this cheap enough to run
    unattended for new folders instead of as a one-off migration.
    """

    def __init__(self, bucket, name, token, timeout=120):
        self._url = media_url(bucket, name)
        self._headers = {'Authorization': f'Bearer {token}'}
        self._timeout = timeout
        self._pos = 0
        self.bytes_fetched = 0
        request = urllib.request.Request(self._url, headers=self._headers, method='HEAD')
        with urllib.request.urlopen(request, timeout=timeout) as response:
            self._size = int(response.headers['Content-Length'])

    def readable(self):
        return True

    def seekable(self):
        return True

    def tell(self):
        return self._pos

    def seek(self, offset, whence=io.SEEK_SET):
        base = {io.SEEK_SET: 0, io.SEEK_CUR: self._pos, io.SEEK_END: self._size}[whence]
        self._pos = max(0, min(self._size, base + offset))
        return self._pos

    def read(self, size=-1):
        if size is None or size < 0:
            size = self._size - self._pos
        size = min(size, self._size - self._pos)
        if size <= 0:
            return b''
        last = self._pos + size - 1
        headers = dict(self._headers, Range=f'bytes={self._pos}-{last}')
        request = urllib.request.Request(self._url, headers=headers)
        with urllib.request.urlopen(request, timeout=self._timeout) as response:
            chunk = response.read()
        self._pos += len(chunk)
        self.bytes_fetched += len(chunk)
        return chunk

    def readinto(self, buffer):
        chunk = self.read(len(buffer))
        buffer[:len(chunk)] = chunk
        return len(chunk)


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
        remote = RemoteZip(args.bucket, objects[0], token)
        with zipfile.ZipFile(remote) as archive:
            names = [n for n in archive.namelist() if n.endswith('task.toml')]
            if not names:
                print(f'  {folder}: package holds no task.toml', file=sys.stderr)
                continue
            text = archive.read(names[0]).decode('utf-8', 'replace')
            docker = [n for n in archive.namelist() if n.endswith('environment/Dockerfile')]
            image = None
            if docker:
                found = FROM_LINE.search(archive.read(docker[0]).decode('utf-8', 'replace'))
                image = found.group(1) if found else None
        is_connector, gyms, how = classify(text)
        reads[folder] = {'connector': is_connector, 'services': gyms, 'basis': how,
                         'image': image, 'bench': bench_type(image),
                         'object': f'gs://{args.bucket}/{objects[0]}',
                         'bytesRead': remote.bytes_fetched,
                         'readOn': datetime.now(timezone.utc).date().isoformat()}
        print(f'  {folder}: {"connector" if is_connector else "non-connector" if is_connector is False else "unreadable"}'
              f' - {how}' + (f' | {reads[folder]["bench"]}' if reads[folder]['bench'] else ''))

    out.write_text(json.dumps({
        'generatedAt': datetime.now(timezone.utc).isoformat(timespec='seconds'),
        'rule': 'connector when task.toml declares at least one mcp_servers entry; '
                'an empty list is a declaration of nothing',
        'reads': reads,
    }, indent=1), encoding='utf-8')
    print(f'wrote {out} ({len(reads)} packages read)')


if __name__ == '__main__':
    main()
