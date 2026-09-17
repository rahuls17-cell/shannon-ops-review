"""Pull the GCS bucket index from the Harbor VM into ./gcs-index for local use.

The index is ~117 MB across 512 shards, but a refresh usually changes fewer than
half of them, so copying the whole thing every time would be wasteful. There is
no rsync on Windows here, so this does the same job in one SSH round trip:

  1. hash every local shard
  2. send those hashes to the VM on stdin
  3. the VM tars up only the files that differ (or are missing) and streams it back
  4. extract, and delete any local file the VM no longer has

Typical refresh moves ~9 MB instead of 117 MB.

Read-only with respect to GCS: this copies an index the VM already built.

    python tools/sync_index.py            # sync once
    python tools/sync_index.py --status   # show what the local copy holds
"""
import argparse
import hashlib
import json
import pathlib
import shutil
import subprocess
import sys
import tarfile
import tempfile
import time

ROOT = pathlib.Path(__file__).resolve().parent.parent
LOCAL = ROOT / 'gcs-index'
HOST = 'root@35.253.35.165'
PORT = '2222'
KEY = str(pathlib.Path.home() / '.ssh' / 'id_ed25519_gcp_taskmining')
REMOTE = '/root/harbor_gce/delivery-candidates-20260908-codex/pipeline-dashboard/gcs-index'

# Runs on the VM. Reads {path: sha1} on stdin, writes a tar of the files that
# differ to stdout, and a manifest of what should exist to fd 3... except fd
# juggling over ssh is fragile, so the file list is embedded in the tar instead.
REMOTE_DIFF = r'''
import hashlib, json, os, sys, tarfile, io
root = sys.argv[1]
have = json.loads(sys.stdin.read() or "{}")
want = {}
for base, _, files in os.walk(root):
    for name in files:
        full = os.path.join(base, name)
        rel = os.path.relpath(full, root).replace(os.sep, "/")
        with open(full, "rb") as fh:
            want[rel] = hashlib.sha1(fh.read()).hexdigest()
changed = [rel for rel, digest in want.items() if have.get(rel) != digest]
buf = io.BytesIO()
with tarfile.open(fileobj=buf, mode="w:gz", compresslevel=6) as tar:
    listing = json.dumps(sorted(want)).encode()
    info = tarfile.TarInfo("__index_listing__.json")
    info.size = len(listing)
    tar.addfile(info, io.BytesIO(listing))
    for rel in changed:
        tar.add(os.path.join(root, rel), arcname=rel)
sys.stdout.buffer.write(buf.getvalue())
'''


def local_hashes():
    out = {}
    if not LOCAL.exists():
        return out
    for path in LOCAL.rglob('*'):
        if path.is_file():
            rel = path.relative_to(LOCAL).as_posix()
            out[rel] = hashlib.sha1(path.read_bytes()).hexdigest()
    return out


def status():
    manifest = LOCAL / 'manifest.json'
    if not manifest.exists():
        print('no local index - run without --status to fetch one')
        return 1
    meta = json.loads(manifest.read_text(encoding='utf-8'))
    size = sum(f.stat().st_size for f in LOCAL.rglob('*') if f.is_file())
    print(f'local index : {LOCAL}')
    print(f'  built     : {meta["generatedAt"]}')
    print(f'  objects   : {meta["objects"]:,} in {meta["folders"]:,} folders')
    print(f'  scope     : {len(meta["scope"])} prefixes')
    print(f'  on disk   : {size/1e6:.1f} MB across {len(list((LOCAL / "shards").glob("*.json")))} shards')
    return 0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--status', action='store_true')
    args = ap.parse_args()
    if args.status:
        return status()

    started = time.time()
    have = local_hashes()
    print(f'local: {len(have)} files' if have else 'local: no index yet, fetching everything')

    LOCAL.mkdir(parents=True, exist_ok=True)
    command = ['ssh', '-i', KEY, '-o', 'StrictHostKeyChecking=no', '-o', 'ConnectTimeout=30',
               '-p', PORT, HOST, f'python3 -c {json_quote(REMOTE_DIFF)} {REMOTE}']
    result = subprocess.run(command, input=json.dumps(have).encode(),
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if result.returncode != 0:
        sys.exit(f'sync failed: {result.stderr.decode()[:400]}')
    if not result.stdout:
        sys.exit('sync failed: the VM sent nothing')

    with tempfile.TemporaryDirectory() as tmp:
        archive = pathlib.Path(tmp) / 'delta.tgz'
        archive.write_bytes(result.stdout)
        with tarfile.open(archive, 'r:gz') as tar:
            members = tar.getmembers()
            listing = json.loads(tar.extractfile('__index_listing__.json').read())
            wanted = [m for m in members if m.name != '__index_listing__.json']
            for member in wanted:
                tar.extract(member, LOCAL, filter='data')

    # Anything the VM no longer holds was pruned; drop it so the explorer does
    # not show folders that have gone.
    expected = set(listing)
    removed = 0
    for path in sorted(LOCAL.rglob('*'), reverse=True):
        if path.is_file() and path.relative_to(LOCAL).as_posix() not in expected:
            path.unlink()
            removed += 1

    meta = json.loads((LOCAL / 'manifest.json').read_text(encoding='utf-8'))
    print(f'pulled {len(wanted)} changed file(s), {len(result.stdout)/1e6:.1f} MB over the wire, '
          f'{removed} removed, in {time.time() - started:.0f}s')
    print(f'index built {meta["generatedAt"]} / {meta["objects"]:,} objects / {meta["folders"]:,} folders')
    return 0


def json_quote(script):
    # Keep the here-doc out of the shell's way: a single-quoted argument with
    # any embedded single quotes escaped the POSIX way.
    return "'" + script.replace("'", "'\\''") + "'"


if __name__ == '__main__':
    sys.exit(main())
