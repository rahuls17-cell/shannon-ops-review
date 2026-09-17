"""Receive a Harbor Console pull from the browser and write it to assets/.

The console is behind IAP, so only a signed-in browser can read it, and the
browser pane blocks file downloads. This listens on localhost so the pull can
be POSTed straight from the console tab:

    python tools/console_ingest.py            # then run tools/console-pull.js

It accepts one POST of JSON to /console-pull, validates the shape, and writes
assets/harbor-console-live.json. Localhost only, no auth material touched, and
it exits after a successful write so nothing is left listening.
"""
import json
from datetime import datetime
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "assets" / "harbor-console-live.json"
PORT = 8799
REQUIRED = ("coverage", "counts", "owners", "tasks")


class Ingest(BaseHTTPRequestHandler):
    def _cors(self):
        # The console is a different origin, so the browser needs these to POST.
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "content-type")
        self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_POST(self):
        length = int(self.headers.get("content-length") or 0)
        raw = self.rfile.read(length)
        try:
            payload = json.loads(raw)
            missing = [key for key in REQUIRED if key not in payload]
            if missing:
                raise ValueError(f"payload is missing {', '.join(missing)}")
            if not isinstance(payload["tasks"], list) or not payload["tasks"]:
                raise ValueError("payload carries no tasks")
        except Exception as error:
            body = json.dumps({"ok": False, "error": str(error)}).encode()
            self.send_response(400)
            self._cors()
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return

        payload.setdefault("receivedAt", datetime.now().isoformat(timespec="seconds"))
        OUT.write_text(json.dumps(payload, separators=(",", ":")), encoding="utf-8")
        summary = {"ok": True, "tasks": len(payload["tasks"]),
                   "owners": len(payload.get("owners") or {}),
                   "bytes": OUT.stat().st_size, "wrote": str(OUT)}
        body = json.dumps(summary).encode()
        self.send_response(200)
        self._cors()
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)
        print(json.dumps(summary, indent=1), flush=True)
        self.server.received = True

    def log_message(self, *args):
        pass


def main():
    server = HTTPServer(("127.0.0.1", PORT), Ingest)
    server.received = False
    print(f"listening on http://127.0.0.1:{PORT}/console-pull - run tools/console-pull.js on the console tab", flush=True)
    while not server.received:
        server.handle_request()
    print("pull received; shutting down", flush=True)


if __name__ == "__main__":
    main()
