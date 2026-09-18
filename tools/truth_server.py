"""Serve the dashboard with a live Rebuild button for the derived pipeline.

The page is static, so it cannot read GCS itself. This runs beside it on
localhost and exposes one endpoint:

    POST /api/refresh-truth   run the eight-step chain on the Harbor VM,
                              then copy the rebuilt asset back here

The VM does the work because that is where the GCS credentials live; they never
come to this machine. The chain is read-only against the bucket, and its own
reconciliation step gates it - if an invariant fails, the VM keeps the previous
asset and nothing is copied down, so a failed rebuild cannot replace good data
with bad.

    python tools/truth_server.py --port 8823

Localhost only: it binds 127.0.0.1 and refuses a request whose Host is anything
else, because the endpoint runs a command.
"""
import argparse
import json
import shlex
import subprocess
import sys
import time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

VM = 'root@35.253.35.165'
VM_PORT = '2222'
VM_KEY = '~/.ssh/id_ed25519_gcp_taskmining'
VM_DIR = '/root/harbor_gce/delivery-candidates-20260908-codex/pipeline-dashboard'
TIMEOUT = 600


def ssh(command, *, capture=True):
    key = str(Path(VM_KEY).expanduser())
    argv = ['ssh', '-i', key, '-o', 'StrictHostKeyChecking=no',
            '-o', 'ConnectTimeout=30', '-p', VM_PORT, VM, command]
    return subprocess.run(argv, capture_output=capture, text=True, timeout=TIMEOUT)


class Handler(SimpleHTTPRequestHandler):
    def _json(self, status, payload):
        body = json.dumps(payload).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        if self.path != '/api/refresh-truth':
            self.send_error(404)
            return
        host = (self.headers.get('Host') or '').split(':')[0]
        if host not in ('127.0.0.1', 'localhost'):
            self._json(403, {'ok': False, 'error': 'This endpoint is localhost only.'})
            return

        root = Path(self.server.root).resolve()
        target = root / 'assets' / 'pipeline-truth.json'
        started = time.time()
        try:
            run = ssh(f'cd {shlex.quote(VM_DIR)} && ./refresh_truth.sh --no-publish')
            if run.returncode != 0:
                # The chain's own reconciliation refused to publish. Say which
                # invariant failed rather than reporting a generic failure.
                tail = (run.stdout or '')[-1500:] + (run.stderr or '')[-1500:]
                self._json(409, {'ok': False, 'blocked': True,
                                 'error': 'The rebuild failed its reconciliation, so the '
                                          'previous data was kept.',
                                 'detail': tail})
                return

            remote = f'{VM_DIR}/truth-work/pipeline-truth.json'
            key = str(Path(VM_KEY).expanduser())
            fetch = subprocess.run(
                ['scp', '-i', key, '-o', 'StrictHostKeyChecking=no', '-P', VM_PORT,
                 f'{VM}:{remote}', str(target)],
                capture_output=True, text=True, timeout=TIMEOUT)
            if fetch.returncode != 0:
                raise RuntimeError(fetch.stderr.strip()[:400] or 'scp failed')

            payload = json.loads(target.read_text(encoding='utf-8'))
            self._json(200, {
                'ok': True,
                'generatedAt': payload.get('generatedAt'),
                'seconds': round(time.time() - started, 1),
                'figures': {f['label']: f['value'] for f in payload.get('figures', [])},
                'log': (run.stdout or '')[-1500:],
            })
        except subprocess.TimeoutExpired:
            self._json(504, {'ok': False, 'error': f'The rebuild ran past {TIMEOUT}s.'})
        except Exception as exc:                                  # noqa: BLE001
            self._json(500, {'ok': False, 'error': str(exc)[:400]})

    def end_headers(self):
        # The working files change under the page; never serve them from cache.
        if self.path.endswith('.json'):
            self.send_header('Cache-Control', 'no-store')
        super().end_headers()

    def log_message(self, fmt, *args):
        sys.stderr.write('%s - %s\n' % (self.address_string(), fmt % args))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--port', type=int, default=8823)
    ap.add_argument('--root', default=str(Path(__file__).resolve().parent.parent))
    args = ap.parse_args()

    handler = lambda *a, **kw: Handler(*a, directory=args.root, **kw)  # noqa: E731
    server = ThreadingHTTPServer(('127.0.0.1', args.port), handler)
    server.root = args.root
    print(f'dashboard  http://127.0.0.1:{args.port}/')
    print(f'rebuild    POST http://127.0.0.1:{args.port}/api/refresh-truth  '
          f'(runs the chain on {VM})')
    server.serve_forever()


if __name__ == '__main__':
    main()
