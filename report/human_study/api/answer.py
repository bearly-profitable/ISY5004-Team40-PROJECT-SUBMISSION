"""Save one study answer. Vercel routes POST /api/answer here."""

import sys
from http.server import BaseHTTPRequestHandler
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from lib.study import read_json, save_answer, send_json


class handler(BaseHTTPRequestHandler):
    def do_POST(self) -> None:  # noqa: N802
        try:
            save_answer(read_json(self))
        except (KeyError, ValueError, IndexError, TypeError):
            send_json(self, 400, {"error": "that answer is not in this question"})
            return
        except Exception as exc:  # noqa: BLE001
            send_json(self, 500, {"error": str(exc)})
            return
        send_json(self, 200, {"ok": True})
