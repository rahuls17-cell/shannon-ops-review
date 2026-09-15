"""Serve the dashboard and expose a localhost-only manual GCS refresh endpoint."""

import argparse
import json
import os
import subprocess
import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


class Handler(SimpleHTTPRequestHandler):
    def do_POST(self):
        if self.path != '/api/refresh-gcs':
            self.send_error(404)
            return
        root = Path(self.server.root).resolve()
        exporter = root / 'tools' / 'export_gcs_pipeline.py'
        output = root / 'assets' / 'gcs-pipeline.json'
        try:
            result = subprocess.run(
                [sys.executable, str(exporter), '--out', str(output)],
                cwd=root,
                capture_output=True,
                text=True,
                timeout=300,
                check=True,
            )
            payload = {'ok': True, 'message': result.stdout[-2000:]}
            body = json.dumps(payload).encode('utf-8')
            self.send_response(200)
        except Exception as exc:
            body = json.dumps({'ok': False, 'error': str(exc)}).encode('utf-8')
            self.send_response(500)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format, *args):
        sys.stdout.write('%s - %s\n' % (self.address_string(), format % args))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--root', default=str(Path(__file__).resolve().parents[1]))
    parser.add_argument('--port', type=int, default=8787)
    args = parser.parse_args()
    root = Path(args.root).resolve()
    os.chdir(root)
    server = ThreadingHTTPServer(('127.0.0.1', args.port), Handler)
    server.root = str(root)
    print('Serving %s at http://127.0.0.1:%d/' % (root, args.port), flush=True)
    server.serve_forever()


if __name__ == '__main__':
    main()
