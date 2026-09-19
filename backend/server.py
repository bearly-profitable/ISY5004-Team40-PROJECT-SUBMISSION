from __future__ import annotations

import io as io_mod
import json
import os
import queue
import shutil
import tempfile
import threading
import time
import uuid
import zipfile
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, List, Optional

import numpy as np
from dotenv import load_dotenv
import asyncio

from fastapi import FastAPI, File, Form, Header, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, Response, StreamingResponse
from pydantic import BaseModel
from starlette.background import BackgroundTask

import collage as collage_mod
import corrections as corrections_mod
import enhance as enhance_mod
import openrouter
from curation import DEFAULT_WEIGHTS, PreferenceModel, rescore_members
from face_analysis import FaceAnalyzer
from lumina_pipeline import LuminaPipeline
from store import LuminaStore

load_dotenv()

ROOT = Path(__file__).resolve().parent
JOBS_DIR = Path(os.getenv("LUMINA_JOBS_DIR", ROOT / "jobs"))
JOBS_DIR.mkdir(parents=True, exist_ok=True)

DB_PATH = Path(os.getenv("LUMINA_DB_PATH", ROOT / "lumina.db"))
JOB_TTL_HOURS = float(os.getenv("JOB_TTL_HOURS", "24"))
MAX_PHOTOS = int(os.getenv("MAX_PHOTOS", "300"))
API_KEY = (os.getenv("LUMINA_API_KEY") or "").strip()  # empty = auth disabled

store = LuminaStore(DB_PATH)
pipeline = LuminaPipeline(store=store)
face_analyzer = FaceAnalyzer()

# In-memory mirror of active jobs for cheap progress polling; SQLite holds
# the durable record (status transitions + final result).
job_store: dict[str, dict[str, Any]] = {}
job_lock = threading.Lock()

face_job_store: dict[str, dict[str, Any]] = {}
face_job_lock = threading.Lock()

enhance_job_store: dict[str, dict[str, Any]] = {}
enhance_job_lock = threading.Lock()

# The pipeline's model objects are shared and not thread-safe. Analysis holds
# this for the whole run; enhancement takes it only for its short ArcFace
# verification, keeping the slow OpenRouter call outside the lock.
model_lock = threading.Lock()

# Single-worker queue: the ML models are shared, non-thread-safe objects, so
# analysis jobs run strictly one at a time.
job_queue: "queue.Queue[tuple[str, list[Path], list[str]]]" = queue.Queue()


# ---------------------------------------------------------------------------
# Job bookkeeping
# ---------------------------------------------------------------------------

def update_job(job_id: str, persist: bool = False, **fields: Any) -> None:
    with job_lock:
        if job_id in job_store:
            job_store[job_id].update(fields)
    if persist:
        db_fields: dict[str, Any] = {}
        mapping = {"status": "status", "stepKey": "step_key", "stepLabel": "step_label",
                   "progress": "progress", "error": "error", "result": "result"}
        for key, val in fields.items():
            if key in mapping:
                db_fields[mapping[key]] = val
        store.update_job(job_id, **db_fields)


def run_job(job_id: str, image_paths: list[Path], photo_ids: list[str]) -> None:
    try:
        update_job(job_id, persist=True, status="running", stepKey="loading_models",
                   stepLabel="Loading models", progress=1)

        def callback(step_key: str, step_label: str, progress: int, meta: dict | None = None) -> None:
            fields: dict[str, Any] = {
                "stepKey": step_key,
                "stepLabel": step_label,
                "progress": max(0, min(progress, 100)),
            }
            if meta:
                if "imagesDone" in meta:
                    fields["imagesDone"] = int(meta["imagesDone"])
                if "imagesTotal" in meta:
                    fields["imagesTotal"] = int(meta["imagesTotal"])
            update_job(job_id, **fields)

        with model_lock:
            result = pipeline.run(image_paths=image_paths, photo_ids=photo_ids, callback=callback)

        # CLIP index is server-side state for /api/search, not client payload.
        clip_index = result.pop("_clipIndex", None)
        if clip_index is not None:
            try:
                store.cache_put(job_id, clip_index, kind="clip_index")
            except Exception:
                pass

        update_job(
            job_id,
            persist=True,
            status="completed",
            stepKey="completed",
            stepLabel="Analysis complete",
            progress=100,
            result=result,
        )
    except Exception as exc:
        update_job(
            job_id,
            persist=True,
            status="failed",
            stepKey="failed",
            stepLabel="Analysis failed",
            error=str(exc),
        )


def worker_loop() -> None:
    while True:
        job_id, image_paths, photo_ids = job_queue.get()
        try:
            run_job(job_id, image_paths, photo_ids)
        finally:
            job_queue.task_done()


def cleanup_loop() -> None:
    """TTL cleanup: drop job rows + on-disk inputs older than JOB_TTL_HOURS."""
    while True:
        try:
            expired = store.delete_jobs_older_than(JOB_TTL_HOURS * 3600)
            for job_id in expired:
                job_dir = JOBS_DIR / job_id
                if job_dir.exists():
                    shutil.rmtree(job_dir, ignore_errors=True)
                with job_lock:
                    job_store.pop(job_id, None)
            # Orphaned dirs (e.g. from before persistence existed)
            known = {row["jobId"] for row in store.list_sessions(limit=10000)}
            cutoff = time.time() - JOB_TTL_HOURS * 3600
            for child in JOBS_DIR.iterdir():
                if child.is_dir() and child.name not in known:
                    try:
                        if child.stat().st_mtime < cutoff:
                            shutil.rmtree(child, ignore_errors=True)
                    except OSError:
                        pass
            store.cache_prune(max_entries=5000)
        except Exception as exc:
            print(f"[Lumina] Cleanup pass failed: {exc}")
        time.sleep(3600)


@asynccontextmanager
async def lifespan(app: FastAPI):
    interrupted = store.mark_interrupted_jobs_failed()
    if interrupted:
        print(f"[Lumina] Marked {interrupted} interrupted job(s) as failed.")
    threading.Thread(target=worker_loop, daemon=True).start()
    threading.Thread(target=cleanup_loop, daemon=True).start()
    print("[Lumina] Preloading ML models at startup …")
    pipeline._load_models()
    print("[Lumina] All models loaded — ready to serve requests.")
    yield


# ---------------------------------------------------------------------------
# App + middleware
# ---------------------------------------------------------------------------

class AnalyzeJobResponse(BaseModel):
    jobId: str


class AnalyzeStatusResponse(BaseModel):
    jobId: str
    status: str
    stepKey: str
    stepLabel: str
    progress: int
    imagesDone: int | None = None
    imagesTotal: int | None = None
    error: str | None = None
    result: dict[str, Any] | None = None


_DEV_ORIGINS = [
    "http://localhost:3000",
    "http://127.0.0.1:3000",
    "http://localhost:3001",
    "http://127.0.0.1:3001",
    "http://localhost:5173",
    "http://127.0.0.1:5173",
]
_frontend_url = os.getenv("FRONTEND_URL", "").strip().rstrip("/")
_allowed_origins = _DEV_ORIGINS + ([_frontend_url] if _frontend_url else [])

app = FastAPI(title="Lumina Analysis Service", version="2.0.0", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=_allowed_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.middleware("http")
async def api_key_guard(request: Request, call_next):
    """Optional shared-secret auth for public deployments.

    Enabled by setting LUMINA_API_KEY on the backend (and VITE_API_KEY on the
    frontend). Health stays open for platform probes; CORS preflights pass.
    /api/photos is exempt because <img> tags cannot send headers — the
    unguessable job UUID in the path acts as the bearer token there.
    """
    open_paths = ("/api/health", "/api/photos/")
    is_sse = request.url.path.startswith("/api/analyze/") and request.url.path.endswith("/stream")
    if (
        API_KEY
        and request.url.path.startswith("/api")
        and not request.url.path.startswith(open_paths)
        and not is_sse  # EventSource cannot send headers; job UUID is the bearer
    ):
        if request.method != "OPTIONS" and request.headers.get("x-api-key", "") != API_KEY:
            return Response(
                content=json.dumps({"detail": "Invalid or missing API key."}),
                status_code=401,
                media_type="application/json",
            )
    return await call_next(request)


def safe_filename(name: str) -> str:
    keep = [c if c.isalnum() or c in ("-", "_", ".") else "_" for c in name.strip()]
    cleaned = "".join(keep).strip("._")
    return cleaned or "image"


def _client_id_or_400(client_id: Optional[str]) -> str:
    cid = (client_id or "").strip()
    if not cid or len(cid) > 128:
        raise HTTPException(status_code=400, detail="X-Client-Id header is required.")
    return cid


def _get_result_or_404(job_id: str) -> dict:
    result = store.get_result(job_id)
    if result is None:
        raise HTTPException(status_code=404, detail="No completed analysis for this job id.")
    return result


# ---------------------------------------------------------------------------
# Core analysis endpoints
# ---------------------------------------------------------------------------

@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/api/analyze", response_model=AnalyzeJobResponse)
async def analyze(
    files: list[UploadFile] = File(...),
    photoMeta: str = Form(...),
) -> AnalyzeJobResponse:
    if not files:
        raise HTTPException(status_code=400, detail="At least one image is required.")
    if len(files) > MAX_PHOTOS:
        raise HTTPException(status_code=400, detail=f"At most {MAX_PHOTOS} photos per analysis.")

    try:
        meta = json.loads(photoMeta)
    except json.JSONDecodeError as exc:
        raise HTTPException(status_code=400, detail=f"Invalid photoMeta JSON: {exc}") from exc

    if not isinstance(meta, list):
        raise HTTPException(status_code=400, detail="photoMeta must be a JSON array.")
    if len(meta) != len(files):
        raise HTTPException(status_code=400, detail="photoMeta length must match uploaded files.")

    job_id = str(uuid.uuid4())
    input_dir = JOBS_DIR / job_id / "input"
    input_dir.mkdir(parents=True, exist_ok=True)

    image_paths: list[Path] = []
    photo_ids: list[str] = []
    photo_map: dict[str, str] = {}  # photoId -> {file, name}

    for idx, upload in enumerate(files):
        row = meta[idx]
        photo_id = str(row.get("id", "")).strip()
        if not photo_id:
            raise HTTPException(status_code=400, detail=f"Missing photo id at index {idx}.")

        original_name = str(row.get("name", upload.filename or f"image_{idx}.jpg"))
        ext = Path(original_name).suffix or ".jpg"
        final_name = f"{idx:04d}_{safe_filename(photo_id)}{ext}"
        save_path = input_dir / final_name

        payload = await upload.read()
        save_path.write_bytes(payload)

        image_paths.append(save_path)
        photo_ids.append(photo_id)
        photo_map[photo_id] = json.dumps({"file": final_name, "name": original_name})

    store.create_job(job_id, num_photos=len(files), photo_map=photo_map)
    with job_lock:
        job_store[job_id] = {
            "jobId": job_id,
            "status": "queued",
            "stepKey": "queued",
            "stepLabel": "Queued",
            "progress": 0,
            "result": None,
            "error": None,
        }

    job_queue.put((job_id, image_paths, photo_ids))
    return AnalyzeJobResponse(jobId=job_id)


@app.get("/api/analyze/{job_id}", response_model=AnalyzeStatusResponse)
def analyze_status(job_id: str) -> AnalyzeStatusResponse:
    with job_lock:
        job = job_store.get(job_id)
        if job is not None:
            return AnalyzeStatusResponse(**job)
    # Fall back to the durable record (e.g. after a restart)
    db_job = store.get_job(job_id)
    if db_job is None:
        raise HTTPException(status_code=404, detail="Unknown job id.")
    return AnalyzeStatusResponse(
        jobId=db_job["jobId"],
        status=db_job["status"],
        stepKey=db_job["stepKey"],
        stepLabel=db_job["stepLabel"],
        progress=db_job["progress"],
        error=db_job["error"],
        result=db_job["result"],
    )


def _current_status(job_id: str) -> Optional[dict[str, Any]]:
    with job_lock:
        job = job_store.get(job_id)
        if job is not None:
            return dict(job)
    db_job = store.get_job(job_id)
    if db_job is None:
        return None
    return {
        "jobId": db_job["jobId"], "status": db_job["status"],
        "stepKey": db_job["stepKey"], "stepLabel": db_job["stepLabel"],
        "progress": db_job["progress"], "error": db_job["error"],
        "result": db_job["result"],
    }


@app.get("/api/analyze/{job_id}/stream")
async def analyze_stream(job_id: str) -> StreamingResponse:
    """Server-Sent Events progress stream — pushes status ~4x/second while
    the job runs, ends with the completed/failed payload. Replaces polling."""
    if _current_status(job_id) is None:
        raise HTTPException(status_code=404, detail="Unknown job id.")

    async def event_source():
        last_sent = None
        while True:
            status = _current_status(job_id)
            if status is None:
                break
            # Don't spam identical frames; always send terminal frames
            terminal = status.get("status") in ("completed", "failed")
            frame_key = (status.get("progress"), status.get("stepKey"),
                         status.get("imagesDone"), status.get("status"))
            if terminal or frame_key != last_sent:
                last_sent = frame_key
                yield f"data: {json.dumps(status)}\n\n"
            if terminal:
                break
            await asyncio.sleep(0.25)

    return StreamingResponse(
        event_source(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


# ---------------------------------------------------------------------------
# Sessions (persisted analyses) + photo serving
# ---------------------------------------------------------------------------

@app.get("/api/sessions")
def list_sessions() -> dict:
    return {"sessions": store.list_sessions(limit=50)}


@app.delete("/api/sessions/{job_id}")
def delete_session(job_id: str) -> dict:
    """Delete a stored session: DB row, CLIP search index, and the job's
    photos/thumbnails on disk. Re-analysing the same images afterwards runs
    a completely fresh job (per-image features stay cached by content hash,
    so the re-run is fast but re-scored from scratch)."""
    if not store.delete_job(job_id):
        raise HTTPException(status_code=404, detail="Unknown session id.")
    with job_lock:
        job_store.pop(job_id, None)
    shutil.rmtree(JOBS_DIR / job_id, ignore_errors=True)
    return {"ok": True}


@app.get("/api/sessions/{job_id}")
def get_session(job_id: str) -> dict:
    job = store.get_job(job_id)
    if job is None or job["status"] != "completed" or job["result"] is None:
        raise HTTPException(status_code=404, detail="No completed session with this id.")
    photo_map = store.get_photo_map(job_id)
    photos = []
    for photo_id, raw in photo_map.items():
        try:
            info = json.loads(raw)
        except (TypeError, json.JSONDecodeError):
            info = {"file": raw, "name": photo_id}
        photos.append({"id": photo_id, "name": info.get("name", photo_id)})
    return {
        "jobId": job_id,
        "createdAt": job["createdAt"],
        "result": job["result"],
        "photos": photos,
        # Reopened sessions need to know which photos already have an AI edit.
        "enhancedPhotoIds": list_enhanced(job_id),
    }


_MEDIA_TYPES = {".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
                ".webp": "image/webp", ".gif": "image/gif", ".bmp": "image/bmp"}


def _photo_path(job_id: str, photo_id: str) -> Path:
    photo_map = store.get_photo_map(job_id)
    raw = photo_map.get(photo_id)
    if raw is None:
        raise HTTPException(status_code=404, detail="Unknown photo id for this job.")
    try:
        info = json.loads(raw)
        file_name = info.get("file", "")
    except (TypeError, json.JSONDecodeError):
        file_name = str(raw)
    path = (JOBS_DIR / job_id / "input" / file_name).resolve()
    # photo_map filenames are server-generated, but never trust a path join
    if not str(path).startswith(str((JOBS_DIR / job_id).resolve())):
        raise HTTPException(status_code=400, detail="Invalid photo path.")
    if not path.is_file():
        raise HTTPException(status_code=404, detail="Photo file no longer exists (expired).")
    return path


_THUMB_WIDTHS = {200, 400, 800}


@app.get("/api/photos/{job_id}/{photo_id}")
def get_photo(job_id: str, photo_id: str, w: int | None = None) -> FileResponse:
    """Serve a stored photo; `?w=` returns a cached JPEG thumbnail.

    Grids ask for w=400 instead of pulling multi-MB originals into 200px
    tiles; thumbnails are generated on first request and cached on disk next
    to the job inputs (so TTL cleanup removes them with the job).
    """
    path = _photo_path(job_id, photo_id)
    if w is None:
        media_type = _MEDIA_TYPES.get(path.suffix.lower(), "application/octet-stream")
        return FileResponse(path, media_type=media_type)

    if w not in _THUMB_WIDTHS:
        raise HTTPException(status_code=400, detail=f"w must be one of {sorted(_THUMB_WIDTHS)}.")

    thumb_dir = JOBS_DIR / job_id / "thumbs"
    thumb_path = thumb_dir / f"{w}_{path.stem}.jpg"
    if not thumb_path.is_file():
        from PIL import Image, ImageOps

        thumb_dir.mkdir(parents=True, exist_ok=True)
        try:
            with Image.open(path) as img:
                img = ImageOps.exif_transpose(img).convert("RGB")
                if img.width > w:
                    img = img.resize((w, max(1, round(img.height * w / img.width))), Image.LANCZOS)
                img.save(thumb_path, format="JPEG", quality=82)
        except Exception as exc:
            raise HTTPException(status_code=500, detail=f"Thumbnail failed: {exc}") from exc
    return FileResponse(thumb_path, media_type="image/jpeg",
                        headers={"Cache-Control": "public, max-age=86400"})


# ---------------------------------------------------------------------------
# CLIP cross-modal search
# ---------------------------------------------------------------------------

class SearchRequest(BaseModel):
    query: str
    topK: int = 12
    personId: Optional[str] = None  # restrict to one identity's photos


@app.post("/api/search/{job_id}")
def search(job_id: str, body: SearchRequest) -> dict:
    query = body.query.strip()
    if not query:
        raise HTTPException(status_code=400, detail="Query must not be empty.")
    if pipeline.clip is None:
        raise HTTPException(status_code=503, detail="CLIP search is disabled on this server.")

    index = store.cache_get(job_id, kind="clip_index")
    if index is None:
        raise HTTPException(status_code=404, detail="No search index for this job (expired or still running).")

    matrix = np.asarray(index["matrix"], dtype=np.float32)
    photo_ids = list(index["photoIds"])

    # Person-scoped search: intersect the index with the identity's photos
    if body.personId:
        result = _get_result_or_404(job_id)
        ident = next((i for i in result.get("identities", []) if i["id"] == body.personId), None)
        if ident is None:
            raise HTTPException(status_code=400, detail="Unknown person id.")
        allowed = set(ident.get("photoIds", []))
        keep = [k for k, pid in enumerate(photo_ids) if pid in allowed]
        if not keep:
            return {"query": query, "results": [], "personId": body.personId}
        matrix = matrix[keep]
        photo_ids = [photo_ids[k] for k in keep]

    results = pipeline.clip.search(query, matrix, photo_ids, top_k=max(1, min(body.topK, 50)))
    return {"query": query, "results": results, "personId": body.personId}


# ---------------------------------------------------------------------------
# Feedback + preference learning
# ---------------------------------------------------------------------------

class FeedbackRequest(BaseModel):
    jobId: str
    eventId: str
    winnerPhotoId: str
    loserPhotoId: str


def _norm_signals_for(result: dict, event_id: str, photo_id: str) -> Optional[dict]:
    for evt in result.get("events", []):
        if evt["id"] != event_id:
            continue
        for member in evt.get("members", []):
            if member["photoId"] == photo_id:
                return member.get("normSignals")
    return None


@app.post("/api/feedback")
def submit_feedback(
    body: FeedbackRequest,
    x_client_id: Optional[str] = Header(default=None),
) -> dict:
    client_id = _client_id_or_400(x_client_id)
    result = _get_result_or_404(body.jobId)

    winner_sig = _norm_signals_for(result, body.eventId, body.winnerPhotoId)
    loser_sig = _norm_signals_for(result, body.eventId, body.loserPhotoId)
    if winner_sig is None or loser_sig is None:
        raise HTTPException(status_code=400, detail="Unknown photo/event combination.")

    # 1. Pin the user's choice on the stored result
    try:
        result = corrections_mod.set_best_photo(result, body.eventId, body.winnerPhotoId)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    store.save_result(body.jobId, result)

    # 2. Log the pairwise observation
    store.add_feedback(client_id, body.jobId, body.eventId, body.winnerPhotoId, body.loserPhotoId)
    store.add_correction(body.jobId, "set_best", body.model_dump())

    # 3. One Bradley-Terry SGD step on the personal weights
    model = PreferenceModel.from_dict(store.get_preferences(client_id))
    model.update(winner_sig, loser_sig)
    store.save_preferences(client_id, model.to_dict())

    return {
        "ok": True,
        "weights": model.weights,
        "nUpdates": model.n_updates,
        "defaultWeights": DEFAULT_WEIGHTS,
    }


@app.get("/api/preferences")
def get_preferences(x_client_id: Optional[str] = Header(default=None)) -> dict:
    client_id = _client_id_or_400(x_client_id)
    model = PreferenceModel.from_dict(store.get_preferences(client_id))
    return {
        "weights": model.weights,
        "nUpdates": model.n_updates,
        "defaultWeights": DEFAULT_WEIGHTS,
        "feedbackCount": store.count_feedback(client_id),
    }


@app.post("/api/preferences/reset")
def reset_preferences(x_client_id: Optional[str] = Header(default=None)) -> dict:
    client_id = _client_id_or_400(x_client_id)
    model = PreferenceModel()
    store.save_preferences(client_id, model.to_dict())
    return {"weights": model.weights, "nUpdates": 0}


@app.post("/api/rescore/{job_id}")
def rescore(job_id: str, x_client_id: Optional[str] = Header(default=None)) -> dict:
    """Re-rank every event under the caller's personalised weights.

    Returns per-event rankings; the canonical stored result keeps the default
    weighting so different users can each see their own view.
    """
    client_id = _client_id_or_400(x_client_id)
    result = _get_result_or_404(job_id)
    model = PreferenceModel.from_dict(store.get_preferences(client_id))

    events_out = []
    for evt in result.get("events", []):
        members = rescore_members(evt.get("members", []), model.weights)
        events_out.append({
            "eventId": evt["id"],
            "topPhotoId": members[0]["photoId"] if members else None,
            "ranking": [
                {"photoId": m["photoId"], "finalScore": m["finalScore"]}
                for m in members
            ],
        })
    return {"jobId": job_id, "weights": model.weights, "nUpdates": model.n_updates, "events": events_out}


# ---------------------------------------------------------------------------
# Cluster corrections
# ---------------------------------------------------------------------------

class CorrectionRequest(BaseModel):
    action: str  # rename_person | merge_persons | move_photo | set_best | rename_event | delete_event
    personId: Optional[str] = None
    targetPersonId: Optional[str] = None
    photoId: Optional[str] = None
    eventId: Optional[str] = None
    label: Optional[str] = None


@app.post("/api/corrections/{job_id}")
def apply_correction(job_id: str, body: CorrectionRequest) -> dict:
    result = _get_result_or_404(job_id)
    try:
        if body.action == "rename_person":
            result = corrections_mod.rename_person(result, body.personId or "", body.label or "")
        elif body.action == "merge_persons":
            result = corrections_mod.merge_persons(result, body.personId or "", body.targetPersonId or "")
        elif body.action == "move_photo":
            result = corrections_mod.move_photo(result, body.photoId or "", body.personId, body.targetPersonId or "")
        elif body.action == "set_best":
            result = corrections_mod.set_best_photo(result, body.eventId or "", body.photoId or "")
        elif body.action == "rename_event":
            result = corrections_mod.rename_event(result, body.eventId or "", body.label or "")
        elif body.action == "delete_event":
            result = corrections_mod.delete_event(result, body.eventId or "")
        else:
            raise HTTPException(status_code=400, detail=f"Unknown action: {body.action}")
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    store.save_result(job_id, result)
    store.add_correction(job_id, body.action, body.model_dump(exclude_none=True))
    return {"ok": True, "result": result}


# ---------------------------------------------------------------------------
# Album export
# ---------------------------------------------------------------------------

class ExportRequest(BaseModel):
    photoIds: List[str]
    albumName: str = "lumina-album"


@app.post("/api/export/{job_id}")
def export_album(job_id: str, body: ExportRequest):
    if not body.photoIds:
        raise HTTPException(status_code=400, detail="photoIds must not be empty.")
    _get_result_or_404(job_id)

    photo_map = store.get_photo_map(job_id)
    tmp = tempfile.NamedTemporaryFile(suffix=".zip", delete=False)
    tmp_path = Path(tmp.name)
    tmp.close()

    try:
        with zipfile.ZipFile(tmp_path, "w", zipfile.ZIP_STORED) as zf:
            for photo_id in body.photoIds:
                raw = photo_map.get(photo_id)
                if raw is None:
                    continue
                try:
                    info = json.loads(raw)
                except (TypeError, json.JSONDecodeError):
                    info = {"file": str(raw), "name": photo_id}
                src = JOBS_DIR / job_id / "input" / info.get("file", "")
                if src.is_file():
                    arcname = safe_filename(info.get("name") or src.name)
                    zf.write(src, arcname=arcname)
    except Exception:
        tmp_path.unlink(missing_ok=True)
        raise

    album = safe_filename(body.albumName) or "lumina-album"
    return FileResponse(
        tmp_path,
        media_type="application/zip",
        filename=f"{album}.zip",
        background=BackgroundTask(lambda: tmp_path.unlink(missing_ok=True)),
    )


# ---------------------------------------------------------------------------
# AI enhancement (OpenRouter image edit + ArcFace identity guard)
# ---------------------------------------------------------------------------

def _enhanced_dir(job_id: str) -> Path:
    return JOBS_DIR / job_id / "enhanced"


def _enhanced_path(job_id: str, photo_id: str) -> Path:
    """Enhanced files live beside the job inputs, so TTL cleanup removes them."""
    return _enhanced_dir(job_id) / f"{safe_filename(photo_id)}.jpg"


def list_enhanced(job_id: str) -> list[str]:
    """Photo ids in this job that already have an enhanced version on disk."""
    directory = _enhanced_dir(job_id)
    if not directory.is_dir():
        return []
    stems = {path.stem for path in directory.glob("*.jpg")}
    return [pid for pid in store.get_photo_map(job_id) if safe_filename(pid) in stems]


class EnhanceRequest(BaseModel):
    jobId: str
    photoId: str
    style: str = enhance_mod.DEFAULT_STYLE


class EnhanceJobResponse(BaseModel):
    enhanceId: str


class EnhanceStatusResponse(BaseModel):
    enhanceId: str
    status: str
    jobId: str
    photoId: str
    error: Optional[str] = None
    warning: Optional[str] = None
    identityScore: Optional[float] = None
    numFaces: Optional[int] = None
    costUsd: Optional[float] = None
    model: Optional[str] = None
    url: Optional[str] = None


def update_enhance_job(enhance_id: str, **fields: Any) -> None:
    with enhance_job_lock:
        if enhance_id in enhance_job_store:
            enhance_job_store[enhance_id].update(fields)


def run_enhance(enhance_id: str, job_id: str, photo_id: str, source: Path, style: str) -> None:
    try:
        update_enhance_job(enhance_id, status="running")
        original = source.read_bytes()

        # Identity verification needs InsightFace. Loading is idempotent and is
        # normally already done by the analysis that produced this gallery.
        face_app = pipeline.face_app
        if face_app is None:
            try:
                with model_lock:
                    pipeline._load_models()
                face_app = pipeline.face_app
            except Exception:
                face_app = None  # verification is skipped, not fatal

        # The slow OpenRouter round-trip runs without the model lock held.
        outcome = enhance_mod.enhance_photo(original, face_app=None, style=style)

        score, num_faces = None, 0
        if face_app is not None:
            with model_lock:
                score, num_faces = enhance_mod.identity_similarity(
                    face_app, original, outcome.image_bytes
                )

        warning = outcome.warning
        if score is not None:
            if score < enhance_mod.IDENTITY_REJECT:
                raise openrouter.OpenRouterError(
                    f"Enhancement discarded - the result no longer matched the original "
                    f"face closely enough (similarity {score:.2f}, needs "
                    f"{enhance_mod.IDENTITY_REJECT:.2f}). Try the natural style, or a "
                    f"photo where faces are larger."
                )
            warning = (
                f"Faces drifted a little in this edit (similarity {score:.2f}). "
                f"Compare against the original before using it."
                if score < enhance_mod.IDENTITY_WARN
                else None
            )
        elif num_faces == 0:
            warning = "No face was detected, so the identity check was skipped."

        from PIL import Image

        out_path = _enhanced_path(job_id, photo_id)
        out_path.parent.mkdir(parents=True, exist_ok=True)
        with Image.open(io_mod.BytesIO(outcome.image_bytes)) as img:
            img.convert("RGB").save(out_path, format="JPEG", quality=94)

        update_enhance_job(
            enhance_id,
            status="completed",
            identityScore=score,
            numFaces=num_faces,
            warning=warning,
            costUsd=outcome.cost_usd,
            model=outcome.model,
            url=f"/api/enhanced/{job_id}/{photo_id}",
        )
    except Exception as exc:
        update_enhance_job(enhance_id, status="failed", error=str(exc))


@app.post("/api/enhance", response_model=EnhanceJobResponse)
def start_enhance(body: EnhanceRequest) -> EnhanceJobResponse:
    if not openrouter.is_configured():
        raise HTTPException(
            status_code=503,
            detail="AI enhancement is not configured. Set OPENROUTER_API_KEY in backend/.env.",
        )
    _get_result_or_404(body.jobId)
    source = _photo_path(body.jobId, body.photoId)

    enhance_id = uuid.uuid4().hex
    with enhance_job_lock:
        enhance_job_store[enhance_id] = {
            "enhanceId": enhance_id,
            "status": "queued",
            "jobId": body.jobId,
            "photoId": body.photoId,
        }
    threading.Thread(
        target=run_enhance,
        args=(enhance_id, body.jobId, body.photoId, source, body.style),
        daemon=True,
    ).start()
    return EnhanceJobResponse(enhanceId=enhance_id)


@app.get("/api/enhance/{enhance_id}", response_model=EnhanceStatusResponse)
def enhance_status(enhance_id: str) -> EnhanceStatusResponse:
    with enhance_job_lock:
        job = enhance_job_store.get(enhance_id)
        if job is None:
            raise HTTPException(status_code=404, detail="Unknown enhancement id.")
        return EnhanceStatusResponse(**job)


@app.get("/api/enhanced/{job_id}/{photo_id}")
def get_enhanced(job_id: str, photo_id: str) -> FileResponse:
    path = _enhanced_path(job_id, photo_id)
    if not path.is_file():
        raise HTTPException(status_code=404, detail="No enhanced version for this photo.")
    return FileResponse(path, media_type="image/jpeg")


@app.delete("/api/enhanced/{job_id}/{photo_id}")
def delete_enhanced(job_id: str, photo_id: str) -> dict:
    """Revert to the original - the enhanced file is a derived artefact."""
    _enhanced_path(job_id, photo_id).unlink(missing_ok=True)
    return {"ok": True}


# ---------------------------------------------------------------------------
# PDF collage export
# ---------------------------------------------------------------------------

class CollageRequest(BaseModel):
    photoIds: List[str]
    title: str = ""
    subtitle: str = ""
    theme: str = collage_mod.DEFAULT_THEME
    autoTitle: bool = False
    captions: bool = True
    useEnhanced: bool = True


@app.get("/api/collage/themes")
def collage_themes() -> dict:
    return {
        "themes": [
            {"key": t.key, "name": t.name, "dark": t.dark,
             "swatch": [t.bg_top, t.accent, t.ink]}
            for t in collage_mod.THEMES.values()
        ],
        "default": collage_mod.DEFAULT_THEME,
        "aiTitles": openrouter.is_configured(),
    }


@app.post("/api/collage/{job_id}")
def build_collage(job_id: str, body: CollageRequest):
    if not body.photoIds:
        raise HTTPException(status_code=400, detail="photoIds must not be empty.")
    result = _get_result_or_404(job_id)

    # photoId -> event label, and photoId -> people in it, for captions.
    labels: dict[str, str] = {}
    people: dict[str, list[str]] = {}
    for event in result.get("events", []):
        for pid in event.get("photoIds", []):
            labels[pid] = event.get("label") or ""
    for ident in result.get("identities", []):
        for pid in ident.get("photoIds", []):
            people.setdefault(pid, []).append(ident.get("label") or "")

    photos: list[collage_mod.CollagePhoto] = []
    for photo_id in body.photoIds:
        try:
            path = _photo_path(job_id, photo_id)
        except HTTPException:
            continue
        if body.useEnhanced:
            enhanced = _enhanced_path(job_id, photo_id)
            if enhanced.is_file():
                path = enhanced
        photos.append(
            collage_mod.CollagePhoto(
                path=path,
                caption=(labels.get(photo_id, "") if body.captions else ""),
                subcaption=(" - ".join(people.get(photo_id, [])[:3]) if body.captions else ""),
            )
        )

    if not photos:
        raise HTTPException(status_code=404, detail="None of those photos are available.")

    title, subtitle = body.title.strip(), body.subtitle.strip()
    if body.autoTitle and openrouter.is_configured():
        try:
            names = [i.get("label") for i in result.get("identities", []) if i.get("label")]
            title, subtitle = collage_mod.suggest_title(
                len(photos), [labels.get(p, "") for p in body.photoIds], names
            )
        except Exception:
            pass  # a title is never worth failing the export over
    if not title:
        title = "Lumina Album"
    if not subtitle:
        subtitle = f"{len(photos)} photo{'s' if len(photos) != 1 else ''}"

    try:
        pdf = collage_mod.build_collage_pdf(
            collage_mod.CollageSpec(
                title=title, subtitle=subtitle, theme=body.theme, photos=photos
            )
        )
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Collage failed: {exc}") from exc

    name = safe_filename(title) or "lumina-album"
    return Response(
        content=pdf,
        media_type="application/pdf",
        headers={"Content-Disposition": f'attachment; filename="{name}.pdf"'},
    )


# ---------------------------------------------------------------------------
# Face Analysis endpoints
# ---------------------------------------------------------------------------

class FaceAnalysisJobResponse(BaseModel):
    jobId: str


class FaceAnalysisStatusResponse(BaseModel):
    jobId: str
    status: str
    progress: int
    error: str | None = None
    result: dict[str, Any] | None = None


def update_face_job(job_id: str, **fields: Any) -> None:
    with face_job_lock:
        if job_id in face_job_store:
            face_job_store[job_id].update(fields)


def run_face_analysis(job_id: str, image_path: Path) -> None:
    try:
        update_face_job(job_id, status="running", progress=10)
        result = face_analyzer.analyze(image_path)
        update_face_job(job_id, status="completed", progress=100, result=result)
    except Exception as exc:
        update_face_job(job_id, status="failed", error=str(exc))


@app.post("/api/face-analysis", response_model=FaceAnalysisJobResponse)
async def face_analysis(file: UploadFile = File(...)) -> FaceAnalysisJobResponse:
    if not file.filename:
        raise HTTPException(status_code=400, detail="An image file is required.")

    job_id = str(uuid.uuid4())
    input_dir = JOBS_DIR / job_id / "face_input"
    input_dir.mkdir(parents=True, exist_ok=True)

    ext = Path(file.filename).suffix or ".jpg"
    save_path = input_dir / f"photo{ext}"
    payload = await file.read()
    save_path.write_bytes(payload)

    with face_job_lock:
        face_job_store[job_id] = {
            "jobId": job_id,
            "status": "queued",
            "progress": 0,
            "result": None,
            "error": None,
        }

    thread = threading.Thread(target=run_face_analysis, args=(job_id, save_path), daemon=True)
    thread.start()
    return FaceAnalysisJobResponse(jobId=job_id)


@app.get("/api/face-analysis/{job_id}", response_model=FaceAnalysisStatusResponse)
def face_analysis_status(job_id: str) -> FaceAnalysisStatusResponse:
    with face_job_lock:
        job = face_job_store.get(job_id)
        if job is None:
            raise HTTPException(status_code=404, detail="Unknown face analysis job id.")
        return FaceAnalysisStatusResponse(**job)
