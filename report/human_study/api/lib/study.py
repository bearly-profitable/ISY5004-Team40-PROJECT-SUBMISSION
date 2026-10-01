"""Question list and answer storage for the Vercel study site."""

from __future__ import annotations

import base64
import csv
import hashlib
import hmac
import json
import os
import random
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path

DATA = Path(__file__).resolve().parents[1] / "data"
TOKEN_TTL = 60 * 60 * 12


def read_json(handler) -> dict:
    length = int(handler.headers.get("Content-Length", "0") or 0)
    raw = handler.rfile.read(length) if length else b"{}"
    payload = json.loads(raw or b"{}")
    if not isinstance(payload, dict):
        raise ValueError("expected an object")
    return payload


def send_json(handler, status: int, payload: dict) -> None:
    body = json.dumps(payload).encode("utf-8")
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json")
    handler.send_header("Content-Length", str(len(body)))
    handler.end_headers()
    handler.wfile.write(body)


def _secret() -> str:
    secret = os.environ.get("STUDY_SECRET") or os.environ.get("GOOGLE_SHEET_URL")
    if not secret:
        raise RuntimeError("GOOGLE_SHEET_URL is not set")
    return secret


def _sign(payload: dict) -> str:
    raw = json.dumps(payload, separators=(",", ":"), sort_keys=True).encode("utf-8")
    signature = hmac.new(_secret().encode("utf-8"), raw, hashlib.sha256).hexdigest()
    body = base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")
    return f"{body}.{signature}"


def open_token(token: str) -> dict:
    body, signature = str(token).split(".", 1)
    padded = body + "=" * (-len(body) % 4)
    raw = base64.urlsafe_b64decode(padded.encode("ascii"))
    expected = hmac.new(_secret().encode("utf-8"), raw, hashlib.sha256).hexdigest()
    if not hmac.compare_digest(expected, signature):
        raise ValueError("bad token")
    payload = json.loads(raw)
    if float(payload.get("exp", 0)) < time.time():
        raise ValueError("expired")
    return payload


def _templates() -> list:
    grouped: dict = {}
    with (DATA / "key.csv").open(newline="", encoding="utf-8") as handle:
        for row in csv.DictReader(handle):
            grouped.setdefault(int(row["question"]), []).append(row)
    steps = []
    for question in sorted(grouped):
        items = grouped[question]
        steps.append({
            "kind": "photos",
            "phase": items[0]["phase"],
            "eventId": items[0]["event_id"],
            "prompt": "Which one photo would you keep?",
            "photos": [
                {"id": item["photo_id"], "file": f"{item['folder']}/{item['file']}"}
                for item in items
            ],
        })
    with (DATA / "events_people.csv").open(newline="", encoding="utf-8") as handle:
        for row in csv.DictReader(handle):
            steps.append({
                "kind": "choice",
                "phase": row["kind"],
                "eventId": f"Q{int(row['question']):02d}",
                "prompt": row["prompt"],
                "image": f"{row['folder']}/{row['file']}",
                "choices": [part.strip() for part in row["choices"].split("|")],
            })
    return steps


def create_session(tester: str) -> dict:
    rng = random.Random()
    public_steps = []
    sealed_steps = []
    for step in _templates():
        if step["kind"] == "photos":
            photos = list(step["photos"])
            rng.shuffle(photos)
            public_steps.append({
                "kind": "photos",
                "prompt": step["prompt"],
                "photos": [{"id": photo["id"], "src": "/photo/" + photo["file"]} for photo in photos],
            })
            sealed_steps.append({
                "phase": step["phase"],
                "eventId": step["eventId"],
                "allowed": [photo["id"] for photo in photos],
            })
        else:
            choices = list(step["choices"])
            rng.shuffle(choices)
            public_steps.append({
                "kind": "choice",
                "prompt": step["prompt"],
                "image": "/photo/" + step["image"],
                "choices": choices,
            })
            sealed_steps.append({
                "phase": step["phase"],
                "eventId": step["eventId"],
                "allowed": choices,
            })
    session_id = uuid.uuid4().hex[:12]
    token = _sign({
        "sid": session_id,
        "tester": tester,
        "steps": sealed_steps,
        "exp": int(time.time()) + TOKEN_TTL,
    })
    return {"sessionId": session_id, "token": token, "steps": public_steps}


def save_answer(payload: dict) -> None:
    token = open_token(str(payload.get("token", "")))
    index = int(payload["index"])
    step = token["steps"][index]
    photo_id = str(payload.get("photoId", ""))
    if photo_id not in step["allowed"] or str(payload.get("sessionId", "")) != token["sid"]:
        raise ValueError("that answer is not in this question")
    row = {
        "session_id": token["sid"],
        "tester": token["tester"],
        "phase": step["phase"],
        "event_id": step["eventId"],
        "photo_id": photo_id,
        "answered_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }
    _insert(row)


def _insert(row: dict) -> None:
    url = os.environ.get("GOOGLE_SHEET_URL", "").strip()
    if not url:
        raise RuntimeError("GOOGLE_SHEET_URL is not set")
    request = urllib.request.Request(
        url,
        data=json.dumps(row).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            response.read()
    except urllib.error.HTTPError as exc:
        # Apps Script accepts the row, then redirects. That redirect is success.
        if exc.code in (301, 302, 303, 307, 308):
            return
        detail = exc.read().decode("utf-8", errors="replace")[:300]
        raise RuntimeError(f"The spreadsheet rejected the answer ({exc.code}): {detail}") from exc
