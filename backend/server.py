from __future__ import annotations

import hmac
import io as io_mod
import json
import math
import os
import queue
import re
import shutil
import tempfile
import threading
import time
import traceback
import uuid
import zipfile
from collections import deque
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, List, Optional
from urllib.parse import urlparse

import numpy as np
from dotenv import load_dotenv
import asyncio

from fastapi import FastAPI, File, Form, Header, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, Response, StreamingResponse
from pydantic import BaseModel, Field
from starlette.background import BackgroundTask

import collage as collage_mod
import mascot
import corrections as corrections_mod
import auth
import enhance as enhance_mod
import openrouter
from curation import DEFAULT_WEIGHTS, PreferenceModel, rescore_members
from face_analysis import FaceAnalyzer
from lumina_pipeline import LuminaPipeline
from store import LuminaStore

load_dotenv()

ROOT = Path(__file__).resolve().parent
# A container's filesystem is wiped on every deploy. When Railway mounts a
# volume it sets RAILWAY_VOLUME_MOUNT_PATH; sessions and photos live there.
DATA_DIR = Path(os.getenv("RAILWAY_VOLUME_MOUNT_PATH") or ROOT)
JOBS_DIR = Path(os.getenv("LUMINA_JOBS_DIR", DATA_DIR / "jobs"))
JOBS_DIR.mkdir(parents=True, exist_ok=True)

DB_PATH = Path(os.getenv("LUMINA_DB_PATH", DATA_DIR / "lumina.db"))
# Built frontend (the root Dockerfile copies frontend/dist here). When it
# exists this server also hosts the web app, so one service runs everything.
_static = Path(os.getenv("LUMINA_STATIC_DIR", ROOT / "static"))
STATIC_DIR: Path | None = _static.resolve() if (_static / "index.html").is_file() else None
JOB_TTL_HOURS = float(os.getenv("JOB_TTL_HOURS", "24"))
# Sessions of signed-in users are kept longer than anonymous ones.
USER_JOB_TTL_HOURS = float(os.getenv("USER_JOB_TTL_HOURS", "720"))
MAX_PHOTOS = int(os.getenv("MAX_PHOTOS", "300"))
API_KEY = (os.getenv("LUMINA_API_KEY") or "").strip()  # empty = auth disabled

# Upload limits. Uploads are decoded by several ML models, so anything that is
# not a real image is refused at the door rather than deep in the pipeline.
MAX_UPLOAD_MB = float(os.getenv("MAX_UPLOAD_MB", "30"))
MAX_REQUEST_MB = float(os.getenv("MAX_REQUEST_MB", "2048"))
_IMAGE_EXTS = {"JPEG": ".jpg", "PNG": ".png", "WEBP": ".webp", "GIF": ".gif", "BMP": ".bmp",
               "MPO": ".jpg", "TIFF": ".tif", "HEIF": ".heic", "AVIF": ".avif"}

# Per-caller rate limits (count per window). Enhancement and AI captions spend
# OpenRouter credit, so they also share a server-wide ceiling.
RATE_ANALYZE_PER_HOUR = int(os.getenv("RATE_ANALYZE_PER_HOUR", "30"))
RATE_ENHANCE_PER_HOUR = int(os.getenv("RATE_ENHANCE_PER_HOUR", "20"))
RATE_ENHANCE_GLOBAL_PER_HOUR = int(os.getenv("RATE_ENHANCE_GLOBAL_PER_HOUR", "100"))
RATE_COLLAGE_PER_HOUR = int(os.getenv("RATE_COLLAGE_PER_HOUR", "60"))
RATE_FACE_PER_MINUTE = int(os.getenv("RATE_FACE_PER_MINUTE", "10"))

# Interactive API docs list every route; opt in for local exploration only.
ENABLE_DOCS = os.getenv("LUMINA_ENABLE_DOCS", "").strip() == "1"

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
        threading.Thread(target=prewarm_thumbs, args=(job_id,), daemon=True).start()
    except Exception:
        # The traceback stays in the server log; the client gets no internals.
        print(f"[Lumina] Job {job_id} failed:\n{traceback.format_exc()}")
        update_job(
            job_id,
            persist=True,
            status="failed",
            stepKey="failed",
            stepLabel="Analysis failed",
            error="Analysis failed. Check that every file is a valid photo and try again.",
        )


def worker_loop() -> None:
    while True:
        job_id, image_paths, photo_ids = job_queue.get()
        try:
            run_job(job_id, image_paths, photo_ids)
        finally:
            job_queue.task_done()


def cleanup_loop() -> None:
    """TTL cleanup: drop job rows + on-disk inputs older than JOB_TTL_HOURS
    (USER_JOB_TTL_HOURS for signed-in users' sessions)."""
    while True:
        try:
            expired = store.delete_jobs_older_than(JOB_TTL_HOURS * 3600, USER_JOB_TTL_HOURS * 3600)
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
            _prune_memory_jobs()
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
if not _frontend_url and os.getenv("RAILWAY_PUBLIC_DOMAIN"):
    # Single-service deploy: this server hosts the frontend on its own domain.
    _frontend_url = f"https://{os.environ['RAILWAY_PUBLIC_DOMAIN'].strip()}"
# Local development: no deployed frontend, or one on this machine. Only then do
# the localhost origins get CORS access and pre-account sessions get listed.
DEV_MODE = (not _frontend_url) or urlparse(_frontend_url).hostname in ("localhost", "127.0.0.1")
_allowed_origins = (_DEV_ORIGINS if DEV_MODE else []) + ([_frontend_url] if _frontend_url else [])

app = FastAPI(
    title="Lumina Analysis Service", version="2.0.0", lifespan=lifespan,
    docs_url="/docs" if ENABLE_DOCS else None,
    redoc_url="/redoc" if ENABLE_DOCS else None,
    openapi_url="/openapi.json" if ENABLE_DOCS else None,
)
app.add_middleware(
    CORSMiddleware,
    allow_origins=_allowed_origins,
    # Auth is a bearer header, never a cookie, so credentials stay off.
    allow_credentials=False,
    allow_methods=["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type", "X-Client-Id", "X-API-Key"],
    expose_headers=["Content-Disposition"],
)

_SECURITY_HEADERS = {
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
}

# The web app (served below when a built frontend is present) needs its own
# scripts, Google Fonts, and https/wss for photos, Supabase and OpenRouter.
_PAGE_SECURITY_HEADERS = {
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Content-Security-Policy": (
        # 'wasm-unsafe-eval': the video exporter's WebAssembly AAC encoder.
        "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; "
        "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; "
        "font-src 'self' https://fonts.gstatic.com data:; img-src 'self' data: blob: https:; "
        "media-src 'self' data: blob: https:; connect-src 'self' blob: data: https: wss:; "
        "worker-src 'self' blob:; object-src 'none'; base-uri 'self'; form-action 'self'; "
        "frame-ancestors 'none'" + ("" if DEV_MODE else "; upgrade-insecure-requests")
    ),
    "Cross-Origin-Opener-Policy": "same-origin-allow-popups",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=()",
}
if not DEV_MODE:
    _PAGE_SECURITY_HEADERS["Strict-Transport-Security"] = "max-age=31536000"


@app.middleware("http")
async def security_headers(request: Request, call_next):
    """Refuse oversized bodies up front, and harden every response."""
    length = request.headers.get("content-length")
    if length and length.isdigit() and int(length) > MAX_REQUEST_MB * 1024 * 1024:
        return Response(
            content=json.dumps({"detail": f"Request too large (max {MAX_REQUEST_MB:.0f} MB)."}),
            status_code=413,
            media_type="application/json",
        )
    response = await call_next(request)
    path = request.url.path
    is_page = STATIC_DIR is not None and not path.startswith("/api") and path not in ("/docs", "/redoc", "/openapi.json")
    for name, value in (_PAGE_SECURITY_HEADERS if is_page else _SECURITY_HEADERS).items():
        # Swagger UI (opt-in) needs its own scripts and styles.
        if name == "Content-Security-Policy" and path in ("/docs", "/redoc"):
            continue
        response.headers.setdefault(name, value)
    if is_page and response.status_code == 200 and "cache-control" not in response.headers:
        # Vite's hashed bundles never change; everything else must revalidate
        # so a deploy is picked up.
        response.headers["Cache-Control"] = (
            "public, max-age=31536000, immutable" if path.startswith("/assets/") else "no-cache"
        )
    if (response.headers.get("content-type", "").startswith("application/json")
            and "cache-control" not in response.headers):
        response.headers["Cache-Control"] = "no-store"  # sessions are personal
    return response


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
        supplied = request.headers.get("x-api-key", "")
        if request.method != "OPTIONS" and not hmac.compare_digest(supplied.encode(), API_KEY.encode()):
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


def _owner(authorization: Optional[str], client_id: Optional[str]) -> auth.Owner:
    """The signed-in user (verified Supabase token) or the anonymous browser."""
    return auth.resolve_owner(authorization, client_id)


_JOB_ID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")


def _valid_job_id(job_id: str) -> str:
    """Job ids are server-minted UUIDs. Anything else (``..``, ``C:\\``, …)
    never reaches a filesystem path or the database."""
    if not _JOB_ID_RE.match(job_id or ""):
        raise HTTPException(status_code=404, detail="Unknown session id.")
    return job_id


def _require_job(job_id: str, authorization: Optional[str], client_id: Optional[str]) -> None:
    """404 unless the caller owns this job.

    Jobs made before accounts existed have no owner and stay reachable by
    their unguessable id. Someone else's job is reported as missing, not
    forbidden, so ids can't be probed.
    """
    _valid_job_id(job_id)
    exists, job_owner = store.job_owner(job_id)
    if not exists:
        raise HTTPException(status_code=404, detail="Unknown session id.")
    if job_owner is None:
        return
    owner = auth.resolve_owner(authorization, client_id, required=False)
    allowed = {owner.id} if owner else set()
    # A signed-in browser still reaches what it made before its claim ran.
    if auth.valid_client_id((client_id or "").strip()):
        allowed.add((client_id or "").strip())
    if job_owner not in allowed:
        raise HTTPException(status_code=404, detail="Unknown session id.")


class _RateLimiter:
    """Sliding-window counter per key, in memory (one backend process)."""

    def __init__(self) -> None:
        self._hits: dict[str, deque] = {}
        self._lock = threading.Lock()

    def check(self, key: str, limit: int, window_s: float) -> None:
        if limit <= 0:
            return
        now = time.monotonic()
        with self._lock:
            hits = self._hits.setdefault(key, deque())
            while hits and hits[0] <= now - window_s:
                hits.popleft()
            if len(hits) >= limit:
                retry = int(hits[0] + window_s - now) + 1
                raise HTTPException(
                    status_code=429,
                    detail="Too many requests. Please wait a little and try again.",
                    headers={"Retry-After": str(retry)},
                )
            hits.append(now)
            if len(self._hits) > 10000:  # drop idle keys
                for stale in [k for k, v in self._hits.items() if not v or v[-1] <= now - 3600]:
                    self._hits.pop(stale, None)


rate_limiter = _RateLimiter()


def _read_image_upload(payload: bytes, filename: str) -> str:
    """The extension for a verified image upload, or 400/413.

    The extension comes from the decoded format, never from the client's
    filename, so a stored upload can't masquerade as HTML or a script.
    """
    if len(payload) > MAX_UPLOAD_MB * 1024 * 1024:
        raise HTTPException(status_code=413, detail=f"'{safe_filename(filename)[:60]}' is larger than {MAX_UPLOAD_MB:.0f} MB.")
    from PIL import Image

    try:
        with Image.open(io_mod.BytesIO(payload)) as img:
            fmt = (img.format or "").upper()
            img.verify()
    except Exception:
        raise HTTPException(status_code=400, detail=f"'{safe_filename(filename)[:60]}' is not a supported image.")
    if fmt not in _IMAGE_EXTS:
        raise HTTPException(status_code=400, detail=f"'{safe_filename(filename)[:60]}' is not a supported image.")
    return _IMAGE_EXTS[fmt]


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
    authorization: Optional[str] = Header(default=None),
    x_client_id: Optional[str] = Header(default=None),
) -> AnalyzeJobResponse:
    # Every session has an owner; ownerless ones would be listed to everybody.
    owner_id = _owner(authorization, x_client_id).id
    if not files:
        raise HTTPException(status_code=400, detail="At least one image is required.")
    if len(files) > MAX_PHOTOS:
        raise HTTPException(status_code=400, detail=f"At most {MAX_PHOTOS} photos per analysis.")

    try:
        meta = json.loads(photoMeta)
    except json.JSONDecodeError as exc:
        raise HTTPException(status_code=400, detail="Invalid photoMeta JSON.") from exc

    if not isinstance(meta, list):
        raise HTTPException(status_code=400, detail="photoMeta must be a JSON array.")
    if len(meta) != len(files):
        raise HTTPException(status_code=400, detail="photoMeta length must match uploaded files.")

    rate_limiter.check(f"analyze:{owner_id}", RATE_ANALYZE_PER_HOUR, 3600)

    job_id = str(uuid.uuid4())
    input_dir = JOBS_DIR / job_id / "input"
    input_dir.mkdir(parents=True, exist_ok=True)

    image_paths: list[Path] = []
    photo_ids: list[str] = []
    photo_map: dict[str, str] = {}  # photoId -> {file, name}

    try:
        for idx, upload in enumerate(files):
            row = meta[idx] if isinstance(meta[idx], dict) else {}
            photo_id = str(row.get("id", "")).strip()
            if not photo_id or len(photo_id) > 128:
                raise HTTPException(status_code=400, detail=f"Missing or invalid photo id at index {idx}.")
            if photo_id in photo_map:
                raise HTTPException(status_code=400, detail=f"Duplicate photo id at index {idx}.")
            original_name = str(row.get("name") or upload.filename or f"image_{idx}.jpg")[:255]

            payload = await upload.read(int(MAX_UPLOAD_MB * 1024 * 1024) + 1)
            ext = _read_image_upload(payload, original_name)
            final_name = f"{idx:04d}_{safe_filename(photo_id)}{ext}"
            save_path = input_dir / final_name
            save_path.write_bytes(payload)

            image_paths.append(save_path)
            photo_ids.append(photo_id)
            photo_map[photo_id] = json.dumps({"file": final_name, "name": original_name})
    except HTTPException:
        shutil.rmtree(JOBS_DIR / job_id, ignore_errors=True)
        raise

    store.create_job(job_id, num_photos=len(files), photo_map=photo_map, owner=owner_id)
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
def analyze_status(
    job_id: str,
    authorization: Optional[str] = Header(default=None),
    x_client_id: Optional[str] = Header(default=None),
) -> AnalyzeStatusResponse:
    _require_job(job_id, authorization, x_client_id)
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
    the job runs, ends with the completed/failed frame. Replaces polling.

    EventSource cannot send headers, so the stream is reachable by job id
    alone and never carries the result; the client fetches that from the
    authenticated GET /api/analyze/{job_id} once it sees "completed"."""
    _valid_job_id(job_id)
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
                status.pop("result", None)
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
def list_sessions(
    authorization: Optional[str] = Header(default=None),
    x_client_id: Optional[str] = Header(default=None),
) -> dict:
    """The caller's own sessions. Anonymous browsers also still see the
    ownerless sessions made before accounts existed, as everyone did then."""
    owner = auth.resolve_owner(authorization, x_client_id, required=False)
    # Ownerless sessions predate accounts. On a deployed server nobody can
    # prove they made them, so they are never listed to arbitrary callers.
    if owner is None:
        legacy = store.list_sessions(limit=200, owner=None) if DEV_MODE else []
        return {"sessions": legacy, "signedIn": False}
    return {
        "sessions": store.list_sessions(limit=200, owner=owner.id,
                                        include_legacy=DEV_MODE and not owner.signed_in),
        "signedIn": owner.signed_in,
    }


@app.post("/api/account/claim")
def claim_account(
    authorization: Optional[str] = Header(default=None),
    x_client_id: Optional[str] = Header(default=None),
) -> dict:
    """Move what this browser made while signed out into the account."""
    owner = _owner(authorization, x_client_id)
    if not owner.signed_in:
        raise HTTPException(status_code=401, detail="Sign in first.")
    anon = (x_client_id or "").strip()
    if not anon or anon.startswith("user:"):
        return {"sessions": 0, "feedback": 0, "preferences": 0}
    return store.claim_anonymous(anon, owner.id)


@app.delete("/api/sessions/{job_id}")
def delete_session(
    job_id: str,
    authorization: Optional[str] = Header(default=None),
    x_client_id: Optional[str] = Header(default=None),
) -> dict:
    """Delete a stored session: DB row, CLIP search index, and the job's
    photos/thumbnails on disk. Re-analysing the same images afterwards runs
    a completely fresh job (per-image features stay cached by content hash,
    so the re-run is fast but re-scored from scratch)."""
    _require_job(job_id, authorization, x_client_id)
    if not store.delete_job(job_id):
        raise HTTPException(status_code=404, detail="Unknown session id.")
    with job_lock:
        job_store.pop(job_id, None)
    shutil.rmtree(JOBS_DIR / job_id, ignore_errors=True)
    return {"ok": True}


@app.get("/api/sessions/{job_id}")
def get_session(
    job_id: str,
    authorization: Optional[str] = Header(default=None),
    x_client_id: Optional[str] = Header(default=None),
) -> dict:
    _require_job(job_id, authorization, x_client_id)
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
    _valid_job_id(job_id)
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
    if not path.is_relative_to((JOBS_DIR / job_id).resolve()):
        raise HTTPException(status_code=400, detail="Invalid photo path.")
    if not path.is_file():
        raise HTTPException(status_code=404, detail="Photo file no longer exists (expired).")
    return path


# 1920 feeds the 1080p "Create video" export.
_THUMB_WIDTHS = {200, 400, 800, 1920}


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

    try:
        thumb_path = _ensure_thumb(job_id, path, w)
    except Exception as exc:
        print(f"[Lumina] Thumbnail failed for {job_id}/{photo_id}: {exc}")
        raise HTTPException(status_code=500, detail="Thumbnail failed.") from exc
    return FileResponse(thumb_path, media_type="image/jpeg",
                        headers={"Cache-Control": "public, max-age=86400"})


def _ensure_thumb(job_id: str, path: Path, w: int) -> Path:
    """The cached `w`-wide JPEG of `path`, generating it if needed.

    Written to a temp file and renamed into place, so the prewarm thread and a
    request for the same thumbnail can never serve each other half a file.
    """
    thumb_dir = JOBS_DIR / job_id / "thumbs"
    thumb_path = thumb_dir / f"{w}_{path.stem}.jpg"
    if thumb_path.is_file():
        return thumb_path
    from PIL import Image, ImageOps

    # No `parents`: a job deleted mid-prewarm must not have its folder recreated.
    thumb_dir.mkdir(exist_ok=True)
    tmp_path = thumb_dir / f".{w}_{path.stem}.{uuid.uuid4().hex}.tmp"
    with Image.open(path) as img:
        img.draft("RGB", (w, w))  # JPEG: decode at a reduced scale, much faster
        img = ImageOps.exif_transpose(img).convert("RGB")
        if img.width > w:
            img = img.resize((w, max(1, round(img.height * w / img.width))), Image.LANCZOS)
        img.save(tmp_path, format="JPEG", quality=82, optimize=True, progressive=True)
    os.replace(tmp_path, thumb_path)
    return thumb_path


def prewarm_thumbs(job_id: str) -> None:
    """Build every grid thumbnail right after an analysis, so the gallery's
    first paint does not wait on dozens of on-demand resizes."""
    photo_map = store.get_photo_map(job_id)
    for w in (400, 800):
        for photo_id in photo_map:
            try:
                _ensure_thumb(job_id, _photo_path(job_id, photo_id), w)
            except Exception:
                continue  # the on-demand path reports real errors
    # Deleted while we were writing: finish the removal the delete started.
    if not store.job_owner(job_id)[0]:
        shutil.rmtree(JOBS_DIR / job_id, ignore_errors=True)


# ---------------------------------------------------------------------------
# CLIP cross-modal search
# ---------------------------------------------------------------------------

class SearchRequest(BaseModel):
    query: str = Field(max_length=500)
    topK: int = Field(default=12, ge=1, le=50)
    personId: Optional[str] = Field(default=None, max_length=128)  # restrict to one identity's photos


@app.post("/api/search/{job_id}")
def search(
    job_id: str,
    body: SearchRequest,
    authorization: Optional[str] = Header(default=None),
    x_client_id: Optional[str] = Header(default=None),
) -> dict:
    _require_job(job_id, authorization, x_client_id)
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
    jobId: str = Field(max_length=64)
    eventId: str = Field(max_length=128)
    winnerPhotoId: str = Field(max_length=128)
    loserPhotoId: str = Field(max_length=128)


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
    authorization: Optional[str] = Header(default=None),
    x_client_id: Optional[str] = Header(default=None),
) -> dict:
    client_id = _owner(authorization, x_client_id).id
    _require_job(body.jobId, authorization, x_client_id)
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
def get_preferences(
    authorization: Optional[str] = Header(default=None),
    x_client_id: Optional[str] = Header(default=None),
) -> dict:
    client_id = _owner(authorization, x_client_id).id
    model = PreferenceModel.from_dict(store.get_preferences(client_id))
    return {
        "weights": model.weights,
        "nUpdates": model.n_updates,
        "defaultWeights": DEFAULT_WEIGHTS,
        "feedbackCount": store.count_feedback(client_id),
    }


@app.post("/api/preferences/reset")
def reset_preferences(
    authorization: Optional[str] = Header(default=None),
    x_client_id: Optional[str] = Header(default=None),
) -> dict:
    client_id = _owner(authorization, x_client_id).id
    model = PreferenceModel()
    store.save_preferences(client_id, model.to_dict())
    return {"weights": model.weights, "nUpdates": 0}


class PreferenceWeightsRequest(BaseModel):
    weights: dict[str, float] = Field(max_length=32)


@app.put("/api/preferences")
def set_preferences(
    body: PreferenceWeightsRequest,
    authorization: Optional[str] = Header(default=None),
    x_client_id: Optional[str] = Header(default=None),
) -> dict:
    """Hand-tuned weights from the profile page. They're normalised onto the
    same simplex the learner uses, and later swaps keep learning from them."""
    client_id = _owner(authorization, x_client_id).id
    if set(body.weights) != set(DEFAULT_WEIGHTS):
        raise HTTPException(status_code=400, detail=f"weights must have exactly: {sorted(DEFAULT_WEIGHTS)}")
    if not all(math.isfinite(v) for v in body.weights.values()):
        raise HTTPException(status_code=400, detail="weights must be finite numbers.")
    raw = [max(0.0, float(body.weights[k])) for k in DEFAULT_WEIGHTS]
    if sum(raw) <= 0:
        raise HTTPException(status_code=400, detail="At least one weight must be above zero.")
    model = PreferenceModel.from_dict(store.get_preferences(client_id))
    projected = model._project(np.array(raw, dtype=np.float64))
    model.weights = {k: float(projected[i]) for i, k in enumerate(DEFAULT_WEIGHTS)}
    store.save_preferences(client_id, model.to_dict())
    return {"weights": model.weights, "nUpdates": model.n_updates, "defaultWeights": DEFAULT_WEIGHTS}


@app.post("/api/rescore/{job_id}")
def rescore(
    job_id: str,
    authorization: Optional[str] = Header(default=None),
    x_client_id: Optional[str] = Header(default=None),
) -> dict:
    """Re-rank every event under the caller's personalised weights.

    Returns per-event rankings; the canonical stored result keeps the default
    weighting so different users can each see their own view.
    """
    client_id = _owner(authorization, x_client_id).id
    _require_job(job_id, authorization, x_client_id)
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
    action: str = Field(max_length=32)  # rename_person | merge_persons | move_photo | set_best | rename_event | delete_event
    personId: Optional[str] = Field(default=None, max_length=128)
    targetPersonId: Optional[str] = Field(default=None, max_length=128)
    photoId: Optional[str] = Field(default=None, max_length=128)
    eventId: Optional[str] = Field(default=None, max_length=128)
    label: Optional[str] = Field(default=None, max_length=120)


@app.post("/api/corrections/{job_id}")
def apply_correction(
    job_id: str,
    body: CorrectionRequest,
    authorization: Optional[str] = Header(default=None),
    x_client_id: Optional[str] = Header(default=None),
) -> dict:
    _require_job(job_id, authorization, x_client_id)
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
            raise HTTPException(status_code=400, detail="Unknown action.")
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    store.save_result(job_id, result)
    store.add_correction(job_id, body.action, body.model_dump(exclude_none=True))
    return {"ok": True, "result": result}


# ---------------------------------------------------------------------------
# Album export
# ---------------------------------------------------------------------------

class ExportRequest(BaseModel):
    photoIds: List[str] = Field(max_length=MAX_PHOTOS)
    albumName: str = Field(default="lumina-album", max_length=120)


@app.post("/api/export/{job_id}")
def export_album(
    job_id: str,
    body: ExportRequest,
    authorization: Optional[str] = Header(default=None),
    x_client_id: Optional[str] = Header(default=None),
):
    _require_job(job_id, authorization, x_client_id)
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
    return _enhanced_dir(_valid_job_id(job_id)) / f"{safe_filename(photo_id)}.jpg"


def list_enhanced(job_id: str) -> list[str]:
    """Photo ids in this job that already have an enhanced version on disk."""
    directory = _enhanced_dir(job_id)
    if not directory.is_dir():
        return []
    stems = {path.stem for path in directory.glob("*.jpg")}
    return [pid for pid in store.get_photo_map(job_id) if safe_filename(pid) in stems]


class EnhanceRequest(BaseModel):
    jobId: str = Field(max_length=64)
    photoId: str = Field(max_length=128)
    style: str = Field(default=enhance_mod.DEFAULT_STYLE, max_length=32)


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
    except openrouter.OpenRouterError as exc:
        update_enhance_job(enhance_id, status="failed", error=str(exc))
    except Exception:
        print(f"[Lumina] Enhancement {enhance_id} failed:\n{traceback.format_exc()}")
        update_enhance_job(enhance_id, status="failed", error="Enhancement failed. Please try again.")


@app.post("/api/enhance", response_model=EnhanceJobResponse)
def start_enhance(
    body: EnhanceRequest,
    authorization: Optional[str] = Header(default=None),
    x_client_id: Optional[str] = Header(default=None),
) -> EnhanceJobResponse:
    owner = _owner(authorization, x_client_id)
    _require_job(body.jobId, authorization, x_client_id)
    if not openrouter.is_configured():
        raise HTTPException(
            status_code=503,
            detail="AI enhancement is not configured. Set OPENROUTER_API_KEY in backend/.env.",
        )
    if not openrouter.can_edit_images():
        raise HTTPException(
            status_code=503,
            detail=(
                f"OPENROUTER_IMAGE_MODEL is set to '{openrouter.image_model()}', which is a "
                f"text-to-image model on OpenRouter: it ignores the photo you send and "
                f"returns an invented one. Set it to an image-editing model such as "
                f"'{openrouter.DEFAULT_IMAGE_MODEL}'."
            ),
        )
    _get_result_or_404(body.jobId)
    source = _photo_path(body.jobId, body.photoId)
    # Each edit spends OpenRouter credit: cap it per caller and server-wide.
    rate_limiter.check(f"enhance:{owner.id}", RATE_ENHANCE_PER_HOUR, 3600)
    rate_limiter.check("enhance:*", RATE_ENHANCE_GLOBAL_PER_HOUR, 3600)

    enhance_id = uuid.uuid4().hex
    with enhance_job_lock:
        enhance_job_store[enhance_id] = {
            "enhanceId": enhance_id,
            "status": "queued",
            "jobId": body.jobId,
            "photoId": body.photoId,
            "owner": owner.id,
            "createdAt": time.time(),
        }
    threading.Thread(
        target=run_enhance,
        args=(enhance_id, body.jobId, body.photoId, source, body.style),
        daemon=True,
    ).start()
    return EnhanceJobResponse(enhanceId=enhance_id)


@app.get("/api/enhance/{enhance_id}", response_model=EnhanceStatusResponse)
def enhance_status(
    enhance_id: str,
    authorization: Optional[str] = Header(default=None),
    x_client_id: Optional[str] = Header(default=None),
) -> EnhanceStatusResponse:
    owner = _owner(authorization, x_client_id)
    with enhance_job_lock:
        job = enhance_job_store.get(enhance_id)
        if job is None or job.get("owner") not in (owner.id, (x_client_id or "").strip()):
            raise HTTPException(status_code=404, detail="Unknown enhancement id.")
        return EnhanceStatusResponse(**job)


@app.get("/api/enhanced/{job_id}/{photo_id}")
def get_enhanced(job_id: str, photo_id: str) -> FileResponse:
    path = _enhanced_path(job_id, photo_id)
    if not path.is_file():
        raise HTTPException(status_code=404, detail="No enhanced version for this photo.")
    return FileResponse(path, media_type="image/jpeg")


@app.delete("/api/enhanced/{job_id}/{photo_id}")
def delete_enhanced(
    job_id: str,
    photo_id: str,
    authorization: Optional[str] = Header(default=None),
    x_client_id: Optional[str] = Header(default=None),
) -> dict:
    """Revert to the original - the enhanced file is a derived artefact."""
    _require_job(job_id, authorization, x_client_id)
    _enhanced_path(job_id, photo_id).unlink(missing_ok=True)
    return {"ok": True}


# ---------------------------------------------------------------------------
# PDF collage export
# ---------------------------------------------------------------------------

class CollageRequest(BaseModel):
    photoIds: List[str] = Field(max_length=MAX_PHOTOS)
    title: str = Field(default="", max_length=120)
    subtitle: str = Field(default="", max_length=160)
    theme: str = Field(default=collage_mod.DEFAULT_THEME, max_length=32)
    autoTitle: bool = False
    captions: bool = True
    aiCaptions: bool = False
    useEnhanced: bool = True
    #: Divider pages between events, and a page introducing the people found.
    chapters: bool = True
    cast: bool = True
    #: Lumi on the divider and cast pages and in the corner of photo pages,
    #: and which outfit (colourway) Lumi wears.
    character: bool = False
    characterOutfit: str = Field(default=mascot.DEFAULT_OUTFIT, max_length=32)


@app.get("/api/collage/themes")
def collage_themes() -> dict:
    return {
        "themes": [
            {"key": t.key, "name": t.name, "dark": t.dark,
             "swatch": [t.bg_top, t.accent, t.ink],
             "bgTop": t.bg_top, "bgBottom": t.bg_bottom, "ink": t.ink,
             "muted": t.muted, "accent": t.accent, "frame": t.frame,
             "grain": t.grain, "serif": t.display_serif,
             "shadowAlpha": t.shadow_alpha, "flat": t.flat}
            for t in collage_mod.THEMES.values()
        ],
        "default": collage_mod.DEFAULT_THEME,
        "aiTitles": openrouter.is_configured(),
        "aiCaptions": openrouter.is_configured(),
        # Lumi's outfits, with the CSS filter values that reproduce each one,
        # so the picker and the web UI have one source of truth.
        "characterOutfits": [
            {"key": key, "name": name, "hue": hue, "saturate": sat}
            for key, (name, hue, sat) in mascot.OUTFITS.items()
        ],
    }


def _photo_scenes(job_id: str, photo_ids: list[str]) -> dict[str, str]:
    """photoId -> CLIP zero-shot scene label, from the job's search index.

    Reuses the embeddings the pipeline already computed, so this costs one
    matrix multiply. Photos below the confidence floor get no label, and a
    server without CLIP (or an expired index) gets none at all — Lumi then
    falls back to the chapter label or a work pose.
    """
    if pipeline.clip is None:
        return {}
    try:
        index = store.cache_get(job_id, kind="clip_index")
        if index is None:
            return {}
        row = {pid: i for i, pid in enumerate(index["photoIds"])}
        matrix = np.asarray(index["matrix"], dtype=np.float32)
        scenes: dict[str, str] = {}
        for pid in photo_ids:
            if pid in row:
                named = pipeline.clip.name_event(matrix[row[pid]:row[pid] + 1])
                if named:
                    scenes[pid] = named["label"]
        return scenes
    except Exception:
        return {}                   # scenes are a nicety, never a failed export


def _collage_spec(job_id: str, body: CollageRequest) -> collage_mod.CollageSpec:
    """Resolve a collage request into the spec the PDF is built from."""
    if not body.photoIds:
        raise HTTPException(status_code=400, detail="photoIds must not be empty.")
    result = _get_result_or_404(job_id)

    # photoId -> event label, and photoId -> people in it, for captions.
    labels: dict[str, str] = {}
    people: dict[str, list[str]] = {}
    for event in result.get("events", []):
        for pid in event.get("photoIds", []):
            labels[pid] = event.get("label") or ""
    faces: dict[str, list[tuple[float, float, float, float]]] = {}
    for ident in result.get("identities", []):
        for pid in ident.get("photoIds", []):
            people.setdefault(pid, []).append(ident.get("label") or "")
        for pid, box in (ident.get("faceBoxes") or {}).items():
            if isinstance(box, (list, tuple)) and len(box) == 4:
                faces.setdefault(pid, []).append(tuple(float(v) for v in box))

    # (photoId, file, whether the file is still the original frame)
    resolved: list[tuple[str, Path, bool]] = []
    for photo_id in body.photoIds:
        try:
            path = _photo_path(job_id, photo_id)
        except HTTPException:
            continue
        is_original = True
        if body.useEnhanced:
            enhanced = _enhanced_path(job_id, photo_id)
            if enhanced.is_file():
                path = enhanced
                is_original = False
        resolved.append((photo_id, path, is_original))

    if not resolved:
        raise HTTPException(status_code=404, detail="None of those photos are available.")

    # Captions: the text model writes one title per photo when asked, otherwise
    # the event label is used. A model failure degrades to labels, never a 500.
    ai_captions: list[str] = []
    if body.captions and body.aiCaptions and openrouter.is_configured():
        scenes = ", ".join(dict.fromkeys(
            label for label in (labels.get(pid, "") for pid, _, _ in resolved) if label))
        ai_captions = collage_mod.caption_photos(
            [path for _, path, _ in resolved],
            context=f"scenes: {scenes}" if scenes else "",
        )

    # What each photo shows, so Lumi can dress for the page it lands on.
    scenes = _photo_scenes(job_id, [pid for pid, _, _ in resolved]) if body.character else {}

    photos: list[collage_mod.CollagePhoto] = []
    for i, (photo_id, path, is_original) in enumerate(resolved):
        if not body.captions:
            caption = subcaption = ""
        else:
            caption = (ai_captions[i] if i < len(ai_captions) else "") or labels.get(photo_id, "")
            subcaption = " · ".join(dict.fromkeys(people.get(photo_id, [])))[:48]
        photos.append(collage_mod.CollagePhoto(
            path=path, photo_id=photo_id, enhanced=not is_original,
            caption=caption, subcaption=subcaption,
            chapter=labels.get(photo_id, "") if body.chapters else "",
            # Face boxes are measured against the original frame. An AI edit can
            # re-render at a different size, so they no longer apply to it.
            faces=tuple(faces.get(photo_id, ())) if is_original else (),
            scene=scenes.get(photo_id, ""),
        ))

    title, subtitle = body.title.strip(), body.subtitle.strip()
    if body.autoTitle and openrouter.is_configured():
        try:
            names = [i.get("label") for i in result.get("identities", []) if i.get("label")]
            title, subtitle = collage_mod.suggest_title(
                len(photos), [labels.get(pid, "") for pid, _, _ in resolved], names
            )
        except Exception:
            pass  # a title is never worth failing the export over
    if not title:
        title = "Lumina Album"
    if not subtitle:
        subtitle = f"{len(photos)} photo{'s' if len(photos) != 1 else ''}"

    # The cast: one portrait per identity, taken from a photo that is actually
    # in this album so the page introduces people the reader is about to meet.
    chosen_order = {pid: i for i, (pid, _, _) in enumerate(resolved)}
    cast: list[collage_mod.CastMember] = []
    if body.cast:
        for ident in result.get("identities", []):
            name = ident.get("label") or ""
            boxes = ident.get("faceBoxes") or {}
            candidates = [pid for pid in ident.get("photoIds", []) if pid in chosen_order]
            if not name or not candidates:
                continue
            # Prefer a photo we have a face box for; otherwise any of theirs.
            pid = next((p for p in candidates if p in boxes), candidates[0])
            try:
                path = _photo_path(job_id, pid)
            except HTTPException:
                continue
            raw = boxes.get(pid)
            face = (tuple(float(v) for v in raw)
                    if isinstance(raw, (list, tuple)) and len(raw) == 4 else None)
            cast.append(collage_mod.CastMember(
                name=name, path=path, face=face, photo_id=pid))

    # Cover stat rail, counted over what actually made it into the album.
    chosen = {pid for pid, _, _ in resolved}
    num_people = len({ident.get("id") for ident in result.get("identities", [])
                      if chosen & set(ident.get("photoIds", []))})
    num_events = len({event.get("id") for event in result.get("events", [])
                      if chosen & set(event.get("photoIds", []))})
    stats = [(str(len(photos)), "photos")]
    if num_people:
        stats.append((str(num_people), "people" if num_people != 1 else "person"))
    if num_events:
        stats.append((str(num_events), "events" if num_events != 1 else "event"))

    return collage_mod.CollageSpec(
        title=title, subtitle=subtitle, theme=body.theme,
        photos=photos, stats=stats, cast=cast,
        character=body.character,
        character_outfit=(body.characterOutfit if body.characterOutfit in mascot.OUTFITS
                          else mascot.DEFAULT_OUTFIT),
    )


@app.post("/api/collage/{job_id}")
def build_collage(
    job_id: str,
    body: CollageRequest,
    authorization: Optional[str] = Header(default=None),
    x_client_id: Optional[str] = Header(default=None),
):
    owner = _owner(authorization, x_client_id)
    _require_job(job_id, authorization, x_client_id)
    # PDFs are CPU-heavy and AI captions/titles spend credit.
    rate_limiter.check(f"collage:{owner.id}", RATE_COLLAGE_PER_HOUR, 3600)
    spec = _collage_spec(job_id, body)
    try:
        pdf = collage_mod.build_collage_pdf(spec)
    except Exception as exc:
        print(f"[Lumina] Collage failed for {job_id}:\n{traceback.format_exc()}")
        raise HTTPException(status_code=500, detail="Collage failed.") from exc

    name = safe_filename(spec.title) or "lumina-album"
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


# Face analysis runs one at a time; the rate limit keeps the queue short.
_face_slots = threading.Semaphore(1)


def run_face_analysis(job_id: str, image_path: Path) -> None:
    try:
        with _face_slots:
            update_face_job(job_id, status="running", progress=10)
            result = face_analyzer.analyze(image_path)
        update_face_job(job_id, status="completed", progress=100, result=result)
    except Exception:
        print(f"[Lumina] Face analysis {job_id} failed:\n{traceback.format_exc()}")
        update_face_job(job_id, status="failed", error="Face analysis failed for this photo.")


@app.post("/api/face-analysis", response_model=FaceAnalysisJobResponse)
async def face_analysis(
    file: UploadFile = File(...),
    authorization: Optional[str] = Header(default=None),
    x_client_id: Optional[str] = Header(default=None),
) -> FaceAnalysisJobResponse:
    owner = _owner(authorization, x_client_id)
    if not file.filename:
        raise HTTPException(status_code=400, detail="An image file is required.")
    rate_limiter.check(f"face:{owner.id}", RATE_FACE_PER_MINUTE, 60)
    payload = await file.read(int(MAX_UPLOAD_MB * 1024 * 1024) + 1)
    ext = _read_image_upload(payload, file.filename)

    job_id = str(uuid.uuid4())
    input_dir = JOBS_DIR / job_id / "face_input"
    input_dir.mkdir(parents=True, exist_ok=True)
    save_path = input_dir / f"photo{ext}"
    save_path.write_bytes(payload)

    with face_job_lock:
        face_job_store[job_id] = {
            "jobId": job_id,
            "status": "queued",
            "progress": 0,
            "result": None,
            "error": None,
            "owner": owner.id,
            "createdAt": time.time(),
        }

    thread = threading.Thread(target=run_face_analysis, args=(job_id, save_path), daemon=True)
    thread.start()
    return FaceAnalysisJobResponse(jobId=job_id)


@app.get("/api/face-analysis/{job_id}", response_model=FaceAnalysisStatusResponse)
def face_analysis_status(
    job_id: str,
    authorization: Optional[str] = Header(default=None),
    x_client_id: Optional[str] = Header(default=None),
) -> FaceAnalysisStatusResponse:
    owner = _owner(authorization, x_client_id)
    with face_job_lock:
        job = face_job_store.get(job_id)
        if job is None or job.get("owner") not in (owner.id, (x_client_id or "").strip()):
            raise HTTPException(status_code=404, detail="Unknown face analysis job id.")
        return FaceAnalysisStatusResponse(**job)


def _prune_memory_jobs(max_age_s: float = 6 * 3600) -> None:
    """Drop finished enhancement / face-analysis records (they only back
    short polling loops) so the in-memory stores can't grow without bound."""
    cutoff = time.time() - max_age_s
    for lock, jobs in ((enhance_job_lock, enhance_job_store), (face_job_lock, face_job_store)):
        with lock:
            for key in [k for k, v in jobs.items() if v.get("createdAt", 0) < cutoff
                        and v.get("status") in ("completed", "failed")]:
                jobs.pop(key, None)


# ---------------------------------------------------------------------------
# Web app (single-service deploys). Registered last so every /api route wins.
# ---------------------------------------------------------------------------

if STATIC_DIR is not None:
    import mimetypes

    # Slim images and Windows registries don't always know these.
    for _ext, _type in ((".webp", "image/webp"), (".woff2", "font/woff2"), (".mjs", "text/javascript"),
                        (".wasm", "application/wasm"), (".webmanifest", "application/manifest+json")):
        mimetypes.add_type(_type, _ext)

    @app.get("/{path:path}", include_in_schema=False)
    def web_app(path: str) -> FileResponse:
        if path == "api" or path.startswith("api/"):
            raise HTTPException(status_code=404, detail="Not found.")
        file = (STATIC_DIR / path).resolve()
        if (path and file.is_file() and file.is_relative_to(STATIC_DIR)
                and not any(part.startswith(".") for part in file.relative_to(STATIC_DIR).parts)):
            return FileResponse(file)
        if path.startswith("assets/"):
            raise HTTPException(status_code=404, detail="Not found.")  # stale bundle, not a route
        # Client-side routes all load the app shell.
        return FileResponse(STATIC_DIR / "index.html")
