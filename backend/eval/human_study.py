"""Human preference study.

Testers only pick which photo they would keep. Learning runs afterwards, on
the saved picks, with the same PreferenceModel the app uses.

    cd backend
    ..\\venv\\Scripts\\python.exe eval\\human_study.py prepare
    ..\\venv\\Scripts\\python.exe eval\\human_study.py serve
    ..\\venv\\Scripts\\python.exe eval\\human_study.py score

prepare reads the evaluation cache and writes report/human_study/config.json.
serve shows the grids and appends each pick to responses.csv.
score applies one learning step per training disagreement and compares the
learned pick with the tester's pick on the held-out events.
"""

from __future__ import annotations

import csv
import io
import json
import random
import socket
import sys
import threading
import uuid
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import quote, unquote, urlparse

BACKEND_DIR = Path(__file__).resolve().parents[1]
REPO_DIR = BACKEND_DIR.parent
DATASET_DIR = REPO_DIR / "report" / "Test Images"
CACHE_PATH = BACKEND_DIR / "eval" / "experiments_cache_dinov3.db"
STUDY_DIR = REPO_DIR / "report" / "human_study"
FORM_DIR = STUDY_DIR / "form"
CONFIG_PATH = STUDY_DIR / "config.json"
RESPONSES_PATH = STUDY_DIR / "responses.csv"
SESSIONS_DIR = STUDY_DIR / "sessions"
RESULTS_PATH = STUDY_DIR / "results.csv"
DETAILS_PATH = STUDY_DIR / "result_details.csv"

N_TRAIN = 8
N_HELDOUT = 4
N_EXTRA_TRAIN = 4
N_RETEST = 2
MAX_SHOWN = 4
HOST = "0.0.0.0"
PORT = 8765

RESPONSE_FIELDS = ["session_id", "tester", "phase", "event_id", "photo_id", "answered_at"]
_write_lock = threading.Lock()


PAGE = """<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Which photo would you keep?</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: Georgia, "Times New Roman", serif; background: #f6f4f0; color: #1c1a17; }
  main { max-width: 1100px; margin: 0 auto; padding: 24px 16px 48px; }
  h1 { font-size: 1.6rem; font-weight: 500; margin: 0 0 8px; }
  p { line-height: 1.45; }
  .muted { color: #5c564e; font-family: "Segoe UI", sans-serif; font-size: 0.95rem; }
  label { display: block; font-family: "Segoe UI", sans-serif; font-size: 0.9rem; margin-bottom: 6px; }
  input[type=text] { width: 100%; font-size: 1.05rem; padding: 12px; border: 1px solid #c8c2b8; border-radius: 8px; }
  button { font-family: "Segoe UI", sans-serif; font-size: 1rem; padding: 12px 18px; border-radius: 8px; border: 0; background: #1c1a17; color: white; }
  button.secondary { background: transparent; color: #1c1a17; border: 1px solid #c8c2b8; }
  button:disabled { opacity: 0.4; }
  .row { display: flex; gap: 8px; margin-top: 16px; }
  .grid { display: grid; gap: 12px; margin-top: 16px; }
  .grid.n2 { grid-template-columns: 1fr 1fr; }
  .grid.n3, .grid.n4 { grid-template-columns: 1fr 1fr; }
  .tile { padding: 0; border: 4px solid transparent; border-radius: 12px; overflow: hidden; background: #e7e2da; cursor: pointer; }
  .tile img { display: block; width: 100%; height: auto; max-height: 72vh; object-fit: contain; background: #e7e2da; }
  .tile.selected { border-color: #1c1a17; }
  .choice-image { display: block; width: 100%; height: auto; max-height: 72vh; object-fit: contain; background: #e7e2da; border-radius: 12px; margin-top: 12px; }
  .choices { display: grid; gap: 10px; margin-top: 16px; }
  .choices button { width: 100%; text-align: left; font-size: 1.05rem; padding: 16px 18px; background: white; color: #1c1a17; border: 2px solid #c8c2b8; }
  .choices button.selected { border-color: #1c1a17; background: #1c1a17; color: white; }
  @media (max-width: 700px) {
    .grid.n2, .grid.n3, .grid.n4 { grid-template-columns: 1fr; }
    .tile img, .choice-image { max-height: none; }
  }
  .progress { font-family: "Segoe UI", sans-serif; font-size: 0.85rem; letter-spacing: 0.04em; text-transform: uppercase; color: #5c564e; }
  .error { color: #8a2b2b; font-family: "Segoe UI", sans-serif; }
</style>
</head>
<body>
<main id="app"></main>
<script>
const app = document.getElementById("app");
let session = null;
let step = 0;
const answers = {};

function startScreen() {
  app.innerHTML = `
    <h1>Photo study</h1>
    <p class="muted">There are 25 questions. For most of them, tap the one photo you would keep. For the last few, look at the picture and pick one of the two answers. There is no right answer.</p>
    <label for="name">Your name</label>
    <input id="name" type="text" maxlength="40" autocomplete="name" placeholder="So we can tell responses apart">
    <div class="row"><button id="go">Start</button></div>
    <p id="err" class="error"></p>`;
  document.getElementById("go").onclick = start;
  document.getElementById("name").addEventListener("keydown", (e) => { if (e.key === "Enter") start(); });
}

async function start() {
  const name = document.getElementById("name").value.trim();
  const err = document.getElementById("err");
  if (!name) { err.textContent = "Please enter your name."; return; }
  err.textContent = "";
  const res = await fetch("/api/session", {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify({name})
  });
  if (!res.ok) { err.textContent = "Could not start. Is the study page still running?"; return; }
  session = await res.json();
  step = 0;
  show();
}

function show() {
  const current = session.steps[step];
  const chosen = answers[step];
  if (current.kind === "choice") return showChoice(current, chosen);
  app.innerHTML = `
    <div class="progress">Question ${step + 1} of ${session.steps.length}</div>
    <h1>${current.prompt}</h1>
    <div class="grid n${current.photos.length}" id="grid"></div>
    <div class="row">
      <button class="secondary" id="back" ${step === 0 ? "disabled" : ""}>Back</button>
      <button id="next" ${chosen ? "" : "disabled"}>Next</button>
    </div>
    <p id="err" class="error"></p>`;
  const grid = document.getElementById("grid");
  for (const photo of current.photos) {
    const tile = document.createElement("button");
    tile.className = "tile" + (photo.id === chosen ? " selected" : "");
    tile.type = "button";
    const img = document.createElement("img");
    img.src = photo.src;
    img.alt = "Photo in this question";
    tile.appendChild(img);
    tile.onclick = () => { answers[step] = photo.id; show(); };
    grid.appendChild(tile);
  }
  document.getElementById("back").onclick = () => { step -= 1; show(); };
  document.getElementById("next").onclick = saveAndAdvance;
}

function showChoice(current, chosen) {
  app.innerHTML = `
    <div class="progress">Question ${step + 1} of ${session.steps.length}</div>
    <h1>${current.prompt}</h1>
    <img class="choice-image" src="${current.image}" alt="Photos for this question">
    <div class="choices" id="choices"></div>
    <div class="row">
      <button class="secondary" id="back" ${step === 0 ? "disabled" : ""}>Back</button>
      <button id="next" ${chosen ? "" : "disabled"}>Next</button>
    </div>
    <p id="err" class="error"></p>`;
  const box = document.getElementById("choices");
  for (const choice of current.choices) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = choice;
    if (choice === chosen) button.className = "selected";
    button.onclick = () => { answers[step] = choice; show(); };
    box.appendChild(button);
  }
  document.getElementById("back").onclick = () => { step -= 1; show(); };
  document.getElementById("next").onclick = saveAndAdvance;
}

async function saveAndAdvance() {
  const err = document.getElementById("err");
  const res = await fetch("/api/answer", {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify({sessionId: session.sessionId, index: step, photoId: answers[step]})
  });
  if (!res.ok) { err.textContent = "Could not save that answer. Please try Next again."; return; }
  if (step + 1 >= session.steps.length) return thanks();
  step += 1;
  show();
}

function thanks() {
  app.innerHTML = `
    <h1>Thank you.</h1>
    <p class="muted">Your choices are saved. You can close this page.</p>`;
}

startScreen();
</script>
</body>
</html>
"""


def _now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def load_config() -> dict:
    if not CONFIG_PATH.is_file():
        raise SystemExit(f"No study config at {CONFIG_PATH}. Run: python eval/human_study.py prepare")
    return json.loads(CONFIG_PATH.read_text(encoding="utf-8"))


def prepare() -> None:
    sys.path.insert(0, str(BACKEND_DIR))
    from eval.experiments import (  # noqa: WPS433
        IMAGE_EXTS,
        cluster_identities,
        event_label_from_name,
        load_features,
        score_truth_events,
    )
    from curation import PreferenceModel  # noqa: WPS433
    from lumina_pipeline import LuminaPipeline, PipelineConfig  # noqa: WPS433
    from store import LuminaStore  # noqa: WPS433

    paths = sorted(
        (p for p in DATASET_DIR.iterdir() if p.suffix.lower() in IMAGE_EXTS),
        key=lambda p: p.name.lower(),
    )
    if not paths:
        raise SystemExit(f"No images in {DATASET_DIR}")
    ids = [p.name for p in paths]
    truth = {pid: event_label_from_name(pid) for pid in ids}
    pipe = LuminaPipeline(
        config=PipelineConfig(enable_captions=False, enable_clip=False),
        store=LuminaStore(CACHE_PATH),
    )
    features = load_features(pipe, paths, ids, truth)
    nima = list(features.nima.values())
    if max(nima) - min(nima) == 0:
        raise SystemExit("NIMA scores have no range. Refusing to build a study on a dead signal.")
    faces, persons, _ = cluster_identities(pipe, features, pipe.cfg)
    scored = score_truth_events(pipe, features, pipe.cfg, {"faces": faces, "persons": persons})

    ranked = []
    for event_id, members in scored.items():
        if len(members) < 2:
            continue
        signed = float(members[0]["finalScore"]) - float(members[1]["finalScore"])
        ranked.append((abs(signed), signed, event_id, members))
    ranked.sort(key=lambda item: (item[0], int(item[2]) if item[2].isdigit() else item[2]))
    if len(ranked) < N_TRAIN + N_HELDOUT:
        raise SystemExit(f"Need {N_TRAIN + N_HELDOUT} events with at least 2 photos, found {len(ranked)}.")

    def pack(event_id: str, members: list, phase: str, gap: float, signed: float) -> dict:
        return {
            "eventId": event_id,
            "phase": phase,
            "margin": round(gap, 4),
            "topTwoScoreGap": round(signed, 4),
            "defaultPhotoId": members[0]["photoId"],
            "shownPhotoIds": [m["photoId"] for m in members[:MAX_SHOWN]],
            "photos": [
                {
                    "photoId": m["photoId"],
                    "finalScore": m["finalScore"],
                    "normSignals": m["normSignals"],
                }
                for m in members
            ],
        }

    train = [pack(eid, members, "train", gap, signed) for gap, signed, eid, members in ranked[:N_TRAIN]]
    heldout = [pack(eid, members, "heldout", gap, signed) for gap, signed, eid, members in ranked[N_TRAIN:N_TRAIN + N_HELDOUT]]
    extra_start = N_TRAIN + N_HELDOUT
    train += [
        pack(eid, members, "train", gap, signed)
        for gap, signed, eid, members in ranked[extra_start:extra_start + N_EXTRA_TRAIN]
    ]
    retest_ids = [event["eventId"] for event in train[:N_RETEST]]
    config = {
        "createdAt": _now(),
        "dataset": str(DATASET_DIR),
        "cache": str(CACHE_PATH),
        "sceneModel": pipe.dino_model_id_in_use,
        "preference": {"lr": PreferenceModel.lr, "l2_to_prior": PreferenceModel.l2_to_prior},
        "selection": (
            f"Of the events with at least 2 photos, the {N_TRAIN} smallest gaps between "
            f"Lumina's top two photos are the training set. The next {N_HELDOUT} are held out. "
            f"The {N_RETEST} closest training events are shown a second time and are not used for learning. "
            f"The next {N_EXTRA_TRAIN} events are extra training and are not repeated. "
            f"A group is shown with at most {MAX_SHOWN} photos, Lumina's highest ranked."
        ),
        "train": train,
        "heldout": heldout,
        "retestEventIds": retest_ids,
        "unusedEventIds": [eid for _, _, eid, _ in ranked[extra_start + N_EXTRA_TRAIN:]],
    }
    STUDY_DIR.mkdir(parents=True, exist_ok=True)
    CONFIG_PATH.write_text(json.dumps(config, indent=2), encoding="utf-8")
    print(f"Wrote {CONFIG_PATH}")
    print("Training events (closest top-two gaps first):")
    for event in train:
        mark = "  retest" if event["eventId"] in retest_ids else ""
        print(f"  event {event['eventId']:>3}  showing {len(event['shownPhotoIds'])} of {len(event['photos'])}  margin {event['margin']:.3f}{mark}")
    print("Held-out events:")
    for event in heldout:
        print(f"  event {event['eventId']:>3}  showing {len(event['shownPhotoIds'])} of {len(event['photos'])}  margin {event['margin']:.3f}")


def _events_by_id(config: dict) -> dict:
    return {event["eventId"]: event for event in config["train"] + config["heldout"]}


def _form_steps() -> list:
    """Questions 1-25, in form order, from the assembled folders."""
    key_path = FORM_DIR / "key.csv"
    if not key_path.is_file():
        raise SystemExit(f"No form key at {key_path}")
    grouped: dict = {}
    with key_path.open(newline="", encoding="utf-8") as handle:
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
    pair_path = FORM_DIR / "events_people.csv"
    if pair_path.is_file():
        with pair_path.open(newline="", encoding="utf-8") as handle:
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


def _apply_shown_photos(config: dict) -> None:
    """Learned picks may only use the photos the tester actually saw."""
    shown: dict = {}
    key_path = FORM_DIR / "key.csv"
    if not key_path.is_file():
        return
    with key_path.open(newline="", encoding="utf-8") as handle:
        for row in csv.DictReader(handle):
            if row["phase"] not in ("train", "heldout"):
                continue
            shown.setdefault((row["phase"], row["event_id"]), []).append(row["photo_id"])
    for event in config.get("train", []):
        photos = shown.get(("train", event["eventId"]))
        if photos:
            event["shownPhotoIds"] = photos
    for event in config.get("heldout", []):
        photos = shown.get(("heldout", event["eventId"]))
        if photos:
            event["shownPhotoIds"] = photos


def _new_session(config: dict, tester: str) -> dict:
    rng = random.Random()
    steps = []
    for step in _form_steps():
        step = dict(step)
        if step["kind"] == "photos":
            photos = list(step["photos"])
            rng.shuffle(photos)
            step["photos"] = photos
        else:
            choices = list(step["choices"])
            rng.shuffle(choices)
            step["choices"] = choices
        steps.append(step)
    session = {"sessionId": uuid.uuid4().hex[:12], "tester": tester, "startedAt": _now(), "steps": steps}
    SESSIONS_DIR.mkdir(parents=True, exist_ok=True)
    (SESSIONS_DIR / f"{session['sessionId']}.json").write_text(json.dumps(session), encoding="utf-8")
    return session


def _load_session(session_id: str) -> dict:
    path = SESSIONS_DIR / f"{session_id}.json"
    if not path.is_file():
        raise KeyError(session_id)
    return json.loads(path.read_text(encoding="utf-8"))


def _append_response(row: dict) -> None:
    with _write_lock:
        new_file = not RESPONSES_PATH.is_file()
        with RESPONSES_PATH.open("a", newline="", encoding="utf-8") as handle:
            writer = csv.DictWriter(handle, fieldnames=RESPONSE_FIELDS)
            if new_file:
                writer.writeheader()
            writer.writerow(row)


def _lan_ip() -> str:
    probe = None
    try:
        probe = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        probe.connect(("8.8.8.8", 80))
        return probe.getsockname()[0]
    except OSError:
        return "127.0.0.1"
    finally:
        if probe is not None:
            probe.close()


class StudyHandler(BaseHTTPRequestHandler):
    config: dict = {}

    def log_message(self, fmt: str, *args) -> None:
        print(f"[study] {self.address_string()} {fmt % args}")

    def _send(self, status: int, body: bytes, content_type: str) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _json(self, status: int, payload: dict) -> None:
        self._send(status, json.dumps(payload).encode("utf-8"), "application/json")

    def do_GET(self) -> None:  # noqa: N802
        path = urlparse(self.path).path
        if path in ("/", "/index.html"):
            page = STUDY_DIR / "public" / "index.html"
            body = page.read_bytes() if page.is_file() else PAGE.encode("utf-8")
            self._send(200, body, "text/html; charset=utf-8")
            return
        if path.startswith("/photo/"):
            self._photo(unquote(path[len("/photo/"):]))
            return
        self._json(404, {"error": "not found"})

    def do_POST(self) -> None:  # noqa: N802
        path = urlparse(self.path).path
        length = int(self.headers.get("Content-Length", "0"))
        try:
            payload = json.loads(self.rfile.read(length) or b"{}")
        except json.JSONDecodeError:
            self._json(400, {"error": "invalid JSON"})
            return
        if path == "/api/session":
            self._start_session(payload)
            return
        if path == "/api/answer":
            self._save_answer(payload)
            return
        self._json(404, {"error": "not found"})

    def _photo(self, name: str) -> None:
        rel = name.replace("\\", "/").lstrip("/")
        if not rel or ".." in rel.split("/"):
            self._json(404, {"error": "unknown photo"})
            return
        path = (FORM_DIR / rel).resolve()
        form_root = FORM_DIR.resolve()
        if path != form_root and form_root not in path.parents:
            self._json(404, {"error": "unknown photo"})
            return
        if not path.is_file():
            self._json(404, {"error": "missing photo"})
            return
        body, kind = _display_image(path)
        self._send(200, body, kind)

    def _start_session(self, payload: dict) -> None:
        tester = str(payload.get("name", "")).strip()
        if not tester or len(tester) > 40:
            self._json(400, {"error": "name is required"})
            return
        session = _new_session(self.config, tester)
        steps = []
        for index, step in enumerate(session["steps"]):
            if step["kind"] == "photos":
                steps.append({
                    "index": index,
                    "kind": "photos",
                    "prompt": step["prompt"],
                    "photos": [{"id": photo["id"], "src": "/photo/" + quote(photo["file"])} for photo in step["photos"]],
                })
            else:
                steps.append({
                    "index": index,
                    "kind": "choice",
                    "prompt": step["prompt"],
                    "image": "/photo/" + quote(step["image"]),
                    "choices": step["choices"],
                })
        self._json(200, {"sessionId": session["sessionId"], "steps": steps})

    def _save_answer(self, payload: dict) -> None:
        try:
            session = _load_session(str(payload.get("sessionId", "")))
            index = int(payload["index"])
            step = session["steps"][index]
        except (KeyError, ValueError, IndexError, TypeError):
            self._json(400, {"error": "unknown session or step"})
            return
        photo_id = str(payload.get("photoId", ""))
        allowed = [photo["id"] for photo in step["photos"]] if step["kind"] == "photos" else step["choices"]
        if photo_id not in allowed:
            self._json(400, {"error": "that answer is not in this question"})
            return
        _append_response({
            "session_id": session["sessionId"],
            "tester": session["tester"],
            "phase": step["phase"],
            "event_id": step["eventId"],
            "photo_id": photo_id,
            "answered_at": _now(),
        })
        self._json(200, {"ok": True})


def _display_image(path: Path) -> tuple[bytes, str]:
    """Send a sharp preview, not the original multi-megabyte file."""
    from PIL import Image, ImageOps

    image = ImageOps.exif_transpose(Image.open(path))
    image.thumbnail((2000, 2000))
    if image.mode != "RGB":
        image = image.convert("RGB")
    buffer = io.BytesIO()
    image.save(buffer, format="JPEG", quality=86)
    return buffer.getvalue(), "image/jpeg"


def serve(host: str = HOST, port: int = PORT) -> None:
    config = load_config()
    _apply_shown_photos(config)
    StudyHandler.config = config
    server = ThreadingHTTPServer((host, port), StudyHandler)
    print(f"Study page: http://{_lan_ip()}:{port}")
    print("On this computer: http://127.0.0.1:%d" % port)
    print("Leave this running while people answer. Ctrl+C stops it.")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")


def _latest_answers(rows: list) -> dict:
    """Last answer for each session, phase and event. A tester can go back and change a pick."""
    latest = {}
    order = []
    for row in rows:
        key = (row["session_id"], row["phase"], row["event_id"])
        if key not in latest:
            order.append(key)
        latest[key] = row
    return latest, order


def score() -> None:
    sys.path.insert(0, str(BACKEND_DIR))
    from curation import PreferenceModel  # noqa: WPS433

    config = load_config()
    _apply_shown_photos(config)
    if not RESPONSES_PATH.is_file():
        raise SystemExit(f"No responses yet at {RESPONSES_PATH}")
    with RESPONSES_PATH.open(newline="", encoding="utf-8") as handle:
        rows = list(csv.DictReader(handle))
    latest, order = _latest_answers(rows)
    by_session: dict = {}
    for key in order:
        row = latest[key]
        by_session.setdefault(row["session_id"], []).append(row)

    events = _events_by_id(config)
    expected = [("train", e["eventId"]) for e in config["train"]]
    expected += [("retest", eid) for eid in config["retestEventIds"]]
    expected += [("heldout", e["eventId"]) for e in config["heldout"]]
    lr = float(config["preference"]["lr"])
    l2 = float(config["preference"]["l2_to_prior"])

    summaries = []
    details = []
    for session_id, answers in by_session.items():
        got = {(row["phase"], row["event_id"]): row for row in answers}
        tester = answers[0]["tester"]
        if any(key not in got for key in expected):
            print(f"  {tester} ({session_id}): incomplete, skipped")
            continue
        model = PreferenceModel(lr=lr, l2_to_prior=l2)
        swaps = 0
        # Learn in the order the answers were given, one pass. Retests are not updates.
        for row in answers:
            if row["phase"] != "train":
                continue
            event = events[row["event_id"]]
            if row["photo_id"] == event["defaultPhotoId"]:
                continue
            signals = {photo["photoId"]: photo["normSignals"] for photo in event["photos"]}
            model.update(signals[row["photo_id"]], signals[event["defaultPhotoId"]])
            swaps += 1

        def pick(event_id: str) -> str:
            event = events[event_id]
            shown = set(event.get("shownPhotoIds") or [photo["photoId"] for photo in event["photos"]])
            candidates = [photo for photo in event["photos"] if photo["photoId"] in shown]
            return max(candidates, key=lambda photo: model.score(photo["normSignals"]))["photoId"]

        retest_hits = held_default = held_learned = 0
        for phase, event_id in expected:
            event = events[event_id]
            user_pick = got[(phase, event_id)]["photo_id"]
            learned_pick = pick(event_id)
            match_default = int(user_pick == event["defaultPhotoId"])
            match_learned = int(user_pick == learned_pick)
            if phase == "retest":
                retest_hits += int(user_pick == got[("train", event_id)]["photo_id"])
            if phase == "heldout":
                held_default += match_default
                held_learned += match_learned
            details.append({
                "session_id": session_id,
                "tester": tester,
                "phase": phase,
                "event_id": event_id,
                "user_pick": user_pick,
                "default_pick": event["defaultPhotoId"],
                "learned_pick": learned_pick,
                "match_default": match_default,
                "match_learned": match_learned,
                "swaps_so_far": model.n_updates if phase != "train" else swaps,
            })
        n_held = len(config["heldout"])
        n_retest = len(config["retestEventIds"])
        summaries.append({
            "session_id": session_id,
            "tester": tester,
            "training_swaps": swaps,
            "retest_same": f"{retest_hits}/{n_retest}",
            "heldout_match_default": f"{held_default}/{n_held}",
            "heldout_match_learned": f"{held_learned}/{n_held}",
            "learned_minus_default": held_learned - held_default,
            "nima_weight_after": round(model.weights["nimaScore"], 3),
            "sharpness_weight_after": round(model.weights["faceSharpness"], 3),
            "centrality_weight_after": round(model.weights["centrality"], 3),
        })
        print(
            f"  {tester}: {swaps} corrections, retest {retest_hits}/{n_retest}, "
            f"held-out default {held_default}/{n_held}, learned {held_learned}/{n_held}"
        )

    if not summaries:
        raise SystemExit("No completed sessions to score.")
    _write_csv(RESULTS_PATH, summaries)
    _write_csv(DETAILS_PATH, details)
    gained = sum(1 for row in summaries if row["learned_minus_default"] > 0)
    print(f"\n{gained} of {len(summaries)} testers matched the learned pick more often than the default.")
    print(f"Wrote {RESULTS_PATH}")
    print(f"Wrote {DETAILS_PATH}")


def _write_csv(path: Path, rows: list) -> None:
    with path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=list(rows[0].keys()))
        writer.writeheader()
        writer.writerows(rows)


def main() -> None:
    command = sys.argv[1] if len(sys.argv) > 1 else ""
    if command == "prepare":
        prepare()
    elif command == "serve":
        serve()
    elif command == "score":
        score()
    else:
        raise SystemExit(__doc__)


if __name__ == "__main__":
    main()
