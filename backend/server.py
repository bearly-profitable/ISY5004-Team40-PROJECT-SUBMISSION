from __future__ import annotations

import json
import os
import threading
import uuid
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

from dotenv import load_dotenv
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from lumina_pipeline import LuminaPipeline
from face_analysis import FaceAnalyzer

load_dotenv()

ROOT = Path(__file__).resolve().parent
JOBS_DIR = ROOT / "jobs"
JOBS_DIR.mkdir(parents=True, exist_ok=True)

pipeline = LuminaPipeline()
face_analyzer = FaceAnalyzer()

job_store: dict[str, dict[str, Any]] = {}
job_lock = threading.Lock()

face_job_store: dict[str, dict[str, Any]] = {}
face_job_lock = threading.Lock()


@asynccontextmanager
async def lifespan(app: FastAPI):
    print("[Lumina] Preloading ML models at startup …")
    pipeline._load_models()
    print("[Lumina] All models loaded — ready to serve requests.")
    yield


class AnalyzeJobResponse(BaseModel):
    jobId: str


class AnalyzeStatusResponse(BaseModel):
    jobId: str
    status: str
    stepKey: str
    stepLabel: str
    progress: int
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

app = FastAPI(title="Lumina Analysis Service", version="1.0.0", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=_allowed_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


def safe_filename(name: str) -> str:
    keep = [c if c.isalnum() or c in ("-", "_", ".") else "_" for c in name.strip()]
    cleaned = "".join(keep).strip("._")
    return cleaned or "image"


def update_job(job_id: str, **fields: Any) -> None:
    with job_lock:
        if job_id not in job_store:
            return
        job_store[job_id].update(fields)


def run_job(job_id: str, image_paths: list[Path], photo_ids: list[str]) -> None:
    try:
        update_job(job_id, status="running", stepKey="loading_models", stepLabel="Loading models", progress=1)

        def callback(step_key: str, step_label: str, progress: int) -> None:
            update_job(job_id, stepKey=step_key, stepLabel=step_label, progress=max(0, min(progress, 100)))

        result = pipeline.run(image_paths=image_paths, photo_ids=photo_ids, callback=callback)
        update_job(
            job_id,
            status="completed",
            stepKey="completed",
            stepLabel="Analysis complete",
            progress=100,
            result=result,
        )
    except Exception as exc:
        update_job(
            job_id,
            status="failed",
            stepKey="failed",
            stepLabel="Analysis failed",
            error=str(exc),
        )


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

    thread = threading.Thread(target=run_job, args=(job_id, image_paths, photo_ids), daemon=True)
    thread.start()
    return AnalyzeJobResponse(jobId=job_id)


@app.get("/api/analyze/{job_id}", response_model=AnalyzeStatusResponse)
def analyze_status(job_id: str) -> AnalyzeStatusResponse:
    with job_lock:
        job = job_store.get(job_id)
        if job is None:
            raise HTTPException(status_code=404, detail="Unknown job id.")
        return AnalyzeStatusResponse(**job)


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
