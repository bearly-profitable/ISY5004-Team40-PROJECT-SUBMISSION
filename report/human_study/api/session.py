"""Start a study session. Vercel routes POST /api/session here."""

import sys
from http.server import BaseHTTPRequestHandler
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from lib.study import create_session, read_json, send_json


class handler(BaseHTTPRequestHandler):
    def do_POST(self) -> None:  # noqa: N802
        try:
            payload = read_json(self)
            tester = str(payload.get("name", "")).strip()
            if not tester or len(tester) > 40:
                send_json(self, 400, {"error": "name is required"})
                return
            send_json(self, 200, create_session(tester))
        except Exception as exc:  # noqa: BLE001
            send_json(self, 500, {"error": str(exc)})
