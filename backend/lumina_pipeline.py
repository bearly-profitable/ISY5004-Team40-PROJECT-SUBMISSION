from __future__ import annotations

import base64
import hashlib
import io
import os
import random
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Dict, List, Optional, Tuple

import cv2
import hdbscan
import numpy as np
import torch
import torch.nn.functional as F
import torchvision.transforms as T
from PIL import Image
from sklearn.cluster import AgglomerativeClustering
from sklearn.metrics import silhouette_score as _sil
from transformers import AutoImageProcessor, AutoModel

from blink import BlinkDetector, match_eyes_open
from captioner import EventCaptioner
from clip_search import EVENT_PROMPT_BANK, ClipEngine
import openrouter
from curation import (
    MMR_MODES,
    REJECT_EAR_CLOSED,
    SIGNAL_ORDER,
    SIGNAL_SPAN_FLOORS,
    blend_time_distance,
    build_explanation,
    ear_to_openness,
    face_confidence_alpha,
    find_duplicate_stacks,
    floored_minmax,
    fuse_embeddings,
    is_prominent_identity,
    match_faces_to_persons,
    mmr_select,
    reject_flags,
)


def _when_label(ts: Optional[float]) -> Optional[str]:
    """A readable name for an event from its start time: "Sat 14 Jun · Evening"."""
    if ts is None:
        return None
    import datetime as _dt
    dt = _dt.datetime.fromtimestamp(ts)
    part = ("Night" if dt.hour < 5 else "Morning" if dt.hour < 12
            else "Afternoon" if dt.hour < 17 else "Evening" if dt.hour < 21 else "Night")
    return f"{dt.strftime('%a')} {dt.day} {dt.strftime('%b')} · {part}"

SEED = 42
random.seed(SEED)
np.random.seed(SEED)
torch.manual_seed(SEED)
BASE_DIR = Path(__file__).resolve().parent

# (step_key, step_label, progress_pct, meta?) — meta carries optional extras
# like per-image completion counts for the live processing grid.
ProgressCallback = Callable[..., None]

# NIMA input size (VGG-16 based, trained on AVA at 224×224)
_NIMA_SIZE = (224, 224)


@dataclass
class PipelineConfig:
    # DINOv3 — scene embeddings + event clustering
    dino_model_id: str = "facebook/dinov3-vits16-pretrain-lvd1689m"
    dino_fallback_id: str = "facebook/dinov2-base"
    dino_batch_size: int = 12

    # InsightFace (buffalo_l / ArcFace) — face detection + landmarks
    insightface_model: str = "buffalo_l"
    insightface_det_size: Tuple[int, int] = (320, 320)  # reduced from 640 for CPU speed

    # YOLO person detection
    yolo_model: str = "yolov8n.pt"
    yolo_batch_size: int = 8  # images per YOLO forward pass

    # torchreid OSNet — body re-identification embeddings
    reid_model_name: str = "osnet_x1_0"
    reid_input_size: Tuple[int, int] = (256, 128)  # (height, width)
    reid_batch_size: int = 32  # batched GPU inference

    # CLIP — cross-modal search + zero-shot event naming
    clip_batch_size: int = 16
    enable_clip: bool = True

    # BLIP — one natural-language caption per event's best shot
    enable_captions: bool = True

    # EXIF-time-aware event clustering: blend capture-time proximity into the
    # visual distance matrix (photos hours apart are different events even
    # when they look alike).
    event_time_weight: float = 0.35
    event_time_tau_seconds: float = 6 * 3600.0

    # Near-duplicate (burst) grouping within an event, on DINO embeddings
    duplicate_sim_threshold: float = 0.965

    # Parallel image loading (disk + JPEG decode dominate cold-start I/O)
    image_load_workers: int = 8

    # Image cache — long edge capped before any model sees the image
    max_image_dim: int = 1280

    # Face detection — downscale to this long edge before InsightFace
    face_det_max_dim: int = 640

    # NIMA — batched aesthetic scoring
    nima_batch_size: int = 16

    # HDBSCAN identity clustering (body-only fallback / ablation mode)
    hdbscan_min_cluster_size: int = 2
    hdbscan_min_samples: int = 1  # lenient — fewer noise singletons

    # Identity clustering mode: "fused" (confidence-weighted face+body),
    # "face_only", or "body_only". Non-default modes exist for ablations.
    identity_mode: str = "fused"

    # ArcFace clustering: cosine distance threshold for AgglomerativeClustering.
    # Same person across photos ≈ 0.1-0.5 cosine dist; different persons > 0.6.
    face_cluster_distance: float = 0.6

    # Fused-space clustering threshold. Fused cosine similarity between two
    # entities is sqrt(a_i*a_j)*sim_face + sqrt((1-a_i)(1-a_j))*sim_body; with
    # the alpha floor at 0.7 the worst-case face-term shrink for a mixed
    # (with-body vs without-body) pair is ~0.84, so the threshold sits a bit
    # looser than the face-only one to absorb it.
    fused_cluster_distance: float = 0.58

    # Identity prominence — background bystanders are clustered but hidden.
    # Keep an identity if it appears in >= identity_min_appearances photos OR
    # its largest face covers >= identity_min_face_ratio of the image.
    identity_min_appearances: int = 2
    identity_min_face_ratio: float = 0.004

    # Minimum containment for a face to be matched to a person box
    face_match_min_containment: float = 0.5

    # ReID fallback: max euclidean distance to attach a faceless person to a known identity
    reid_assign_threshold: float = 0.75

    # Agglomerative event clustering — silhouette sweep range
    # Blended event distances live in [0, ~1]; a 0.25 step jumped past the
    # silhouette peak (~0.2) and over-split events.
    event_sweep_start: float = 0.05
    event_sweep_stop: float = 1.0
    event_sweep_step: float = 0.025
    event_sweep_patience: int = 10  # stop if no improvement for N consecutive thresholds

    # MMR diversity picks per event
    mmr_max_picks: int = 6

    # 7-signal scoring weights (sum to 1.0). EAR carries real weight — a
    # blink is the single most human-obvious reason to reject a photo —
    # while raw detector confidence says little about photo quality.
    w_centrality: float = 0.25
    w_nima: float = 0.25
    w_face_sharpness: float = 0.15
    w_face_size: float = 0.10
    w_det_score: float = 0.05
    w_pose: float = 0.10
    w_ear: float = 0.10

    # Bump when extraction logic changes so stale cache entries are ignored
    cache_version: str = "v6"  # v6: NIMA no longer cached as 0.0 under NumPy 2

    def weights_dict(self) -> Dict[str, float]:
        return {
            "centrality": self.w_centrality,
            "nimaScore": self.w_nima,
            "faceSharpness": self.w_face_sharpness,
            "faceSize": self.w_face_size,
            "detScore": self.w_det_score,
            "poseQuality": self.w_pose,
            "ear": self.w_ear,
        }


def minmax_norm(arr: np.ndarray) -> np.ndarray:
    arr = np.asarray(arr, dtype=np.float32)
    if arr.size == 0:
        return arr
    mn, mx = arr.min(), arr.max()
    if float(mx - mn) < 1e-12:
        return np.ones_like(arr)
    return (arr - mn) / (mx - mn)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def compute_pose_penalty(pose: list) -> float:
    """1.0 = perfectly frontal, 0.0 = extreme non-frontal.
    pose = [pitch, yaw, roll] in degrees."""
    pitch, yaw, roll = [abs(v) for v in pose]
    penalty = 1.0 - (yaw / 90.0) * 0.5 - (pitch / 90.0) * 0.3 - (roll / 45.0) * 0.2
    return float(np.clip(penalty, 0.0, 1.0))


def compute_ear(landmarks_68: Optional[np.ndarray]) -> float:
    """Eye Aspect Ratio from 68-point landmarks (points 36-47).
    Low EAR = eyes closed."""
    if landmarks_68 is None:
        return 0.5
    pts = np.array(landmarks_68)[:, :2]

    def _eye_ear(p: np.ndarray) -> float:
        vertical1 = np.linalg.norm(p[1] - p[5])
        vertical2 = np.linalg.norm(p[2] - p[4])
        horizontal = np.linalg.norm(p[0] - p[3])
        if horizontal < 1e-6:
            return 0.5
        return (vertical1 + vertical2) / (2.0 * horizontal)

    left_ear = _eye_ear(pts[36:42])
    right_ear = _eye_ear(pts[42:48])
    return float((left_ear + right_ear) / 2.0)


def hash_image_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def extract_exif_timestamp(pil_image) -> Optional[float]:
    """Capture time (unix epoch) from EXIF DateTimeOriginal, if present."""
    try:
        exif = pil_image.getexif()
        if not exif:
            return None
        # 36867 DateTimeOriginal (in the Exif IFD), 306 DateTime as fallback
        raw = None
        try:
            raw = exif.get_ifd(0x8769).get(36867)
        except Exception:
            raw = None
        if not raw:
            raw = exif.get(306)
        if not raw:
            return None
        import datetime as _dt

        return _dt.datetime.strptime(str(raw).strip(), "%Y:%m:%d %H:%M:%S").timestamp()
    except Exception:
        return None


class LuminaPipeline:
    def __init__(self, config: PipelineConfig | None = None, store=None):
        self.cfg = config or PipelineConfig()
        self.store = store  # optional LuminaStore for the embedding cache
        self.device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
        # Models — lazy loaded
        self.processor = None
        self.dino_model = None
        self.dino_model_id_in_use: str | None = None
        self.face_app = None
        self.yolo = None
        self.reid_model = None
        self.reid_transform = None
        self.nima_metric = None
        self.clip = ClipEngine(device=self.device) if self.cfg.enable_clip else None
        self.captioner = EventCaptioner(device=self.device) if self.cfg.enable_captions else None
        self.blink = BlinkDetector()

    # ------------------------------------------------------------------ models
    def _load_models(self) -> None:
        if self.processor is not None:
            return

        hf_token = (os.getenv("HF_TOKEN") or os.getenv("HUGGINGFACE_HUB_TOKEN") or "").strip() or None
        proc_kw: dict = {"use_fast": False}
        mdl_kw: dict = {}
        if hf_token:
            proc_kw["token"] = hf_token
            mdl_kw["token"] = hf_token

        # DINOv3
        try:
            self.processor = AutoImageProcessor.from_pretrained(self.cfg.dino_model_id, **proc_kw)
            self.dino_model = AutoModel.from_pretrained(self.cfg.dino_model_id, **mdl_kw).to(self.device).eval()
            self.dino_model_id_in_use = self.cfg.dino_model_id
        except Exception:
            self.processor = AutoImageProcessor.from_pretrained(self.cfg.dino_fallback_id, **proc_kw)
            self.dino_model = AutoModel.from_pretrained(self.cfg.dino_fallback_id, **mdl_kw).to(self.device).eval()
            self.dino_model_id_in_use = self.cfg.dino_fallback_id

        # InsightFace
        from insightface.app import FaceAnalysis
        providers = (
            ["CUDAExecutionProvider", "CPUExecutionProvider"]
            if torch.cuda.is_available()
            else ["CPUExecutionProvider"]
        )
        self.face_app = FaceAnalysis(name=self.cfg.insightface_model, providers=providers)
        self.face_app.prepare(
            ctx_id=0 if torch.cuda.is_available() else -1,
            det_size=self.cfg.insightface_det_size,
        )

        # YOLO
        from ultralytics import YOLO
        self.yolo = YOLO(self.cfg.yolo_model)

        # torchreid OSNet
        import torchreid
        self.reid_model = torchreid.models.build_model(
            name=self.cfg.reid_model_name,
            num_classes=1000,
            pretrained=True,
            use_gpu=torch.cuda.is_available(),
        )
        self.reid_model.eval()
        if torch.cuda.is_available():
            self.reid_model = self.reid_model.cuda()
        self.reid_transform = T.Compose([
            T.Resize(self.cfg.reid_input_size),
            T.ToTensor(),
            T.Normalize(mean=[0.485, 0.456, 0.406], std=[0.229, 0.224, 0.225]),
        ])

        # NIMA
        import pyiqa
        self.nima_metric = pyiqa.create_metric("nima", device=self.device)

        # CLIP — loaded eagerly with everything else so first-search is instant
        if self.clip is not None:
            self.clip._ensure_loaded()

    # -------------------------------------------------------- image cache
    def _build_image_cache(
        self,
        image_paths: list[Path],
        callback: ProgressCallback | None = None,
    ) -> Tuple[Dict[str, np.ndarray], Dict[str, str], Dict[str, Optional[float]]]:
        """Load every image once, in parallel, reading each file's bytes a
        single time to produce three things per image: the downsampled pixel
        cache, the SHA-256 content hash (embedding-cache key), and the EXIF
        capture timestamp. Disk + JPEG decode dominate cold-start I/O, so the
        thread pool is a real wall-clock win on multi-photo runs."""
        cache: Dict[str, np.ndarray] = {}
        hashes: Dict[str, str] = {}
        exif_times: Dict[str, Optional[float]] = {}
        max_dim = self.cfg.max_image_dim
        total = len(image_paths)

        def load_one(path: Path):
            try:
                data = path.read_bytes()
            except OSError:
                return path, None, None, None
            digest = hashlib.sha256(data).hexdigest()

            ts = None
            try:
                ts = extract_exif_timestamp(Image.open(io.BytesIO(data)))
            except Exception:
                ts = None

            img = cv2.imdecode(np.frombuffer(data, dtype=np.uint8), cv2.IMREAD_COLOR)
            if img is None:
                return path, None, digest, ts
            h, w = img.shape[:2]
            long_edge = max(h, w)
            if long_edge > max_dim:
                scale = max_dim / long_edge
                img = cv2.resize(img, (int(w * scale), int(h * scale)), interpolation=cv2.INTER_AREA)
            return path, img, digest, ts

        done = 0
        with ThreadPoolExecutor(max_workers=self.cfg.image_load_workers) as pool:
            for path, img, digest, ts in pool.map(load_one, image_paths):
                path_str = str(path)
                if img is not None:
                    cache[path_str] = img
                if digest is not None:
                    hashes[path_str] = digest
                exif_times[path_str] = ts
                done += 1
                if callback and done % max(1, total // 20) == 0:
                    ratio = int((done / total) * 100)
                    callback("loading_models", "Loading images", 2 + int(ratio * 0.03))
        return cache, hashes, exif_times

    # --------------------------------------------------------- face detection
    def _detect_faces(
        self,
        image_paths: list[Path],
        photo_ids: list[str],
        img_cache: Dict[str, np.ndarray],
        callback: ProgressCallback | None = None,
        done_offset: int = 0,
        images_total: int | None = None,
    ) -> Tuple[list[dict], list[str]]:
        face_records: list[dict] = []
        no_face_ids: list[str] = []

        face_max_dim = self.cfg.face_det_max_dim

        for i, (path, photo_id) in enumerate(zip(image_paths, photo_ids)):
            img_bgr = img_cache.get(str(path))
            if img_bgr is None:
                no_face_ids.append(photo_id)
                continue

            h, w = img_bgr.shape[:2]
            img_area = max(h * w, 1)

            # Downscale for InsightFace — detection + ArcFace embeddings
            # are accurate at 640px; sharpness is computed from full-res cache.
            long_edge = max(h, w)
            if long_edge > face_max_dim:
                face_scale = face_max_dim / long_edge
                img_small = cv2.resize(
                    img_bgr,
                    (int(w * face_scale), int(h * face_scale)),
                    interpolation=cv2.INTER_AREA,
                )
            else:
                face_scale = 1.0
                img_small = img_bgr

            faces = self.face_app.get(img_small)
            if not faces:
                no_face_ids.append(photo_id)
                continue

            # One MediaPipe pass per image: trained eyeBlink blendshapes are
            # the primary eyes-open signal (geometric EAR is the fallback).
            mp_faces = self.blink.detect(cv2.cvtColor(img_small, cv2.COLOR_BGR2RGB))

            # Scale factor to map small-image coords back to cache coords
            inv_scale = 1.0 / face_scale

            for fi, face in enumerate(faces):
                if face.embedding is None:
                    continue
                emb = face.embedding.astype(np.float32)
                norm = np.linalg.norm(emb)
                if norm > 0:
                    emb = emb / norm

                # Scale bbox back to full cache resolution
                bbox_small = face.bbox.tolist()
                bbox = [v * inv_scale for v in bbox_small]
                x1, y1, x2, y2 = (int(v) for v in bbox)
                x1, y1 = max(0, x1), max(0, y1)
                x2, y2 = min(w, x2), min(h, y2)

                # Face sharpness — computed from full-res cache image
                face_sharpness = 0.0
                if x2 > x1 and y2 > y1:
                    crop = img_bgr[y1:y2, x1:x2]
                    if crop.size > 0:
                        gray = cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY)
                        face_sharpness = float(cv2.Laplacian(gray, cv2.CV_64F).var())

                face_size_ratio = float((x2 - x1) * (y2 - y1)) / img_area

                # Pose penalty
                pose_penalty = 0.5
                if hasattr(face, 'pose') and face.pose is not None:
                    pose_penalty = compute_pose_penalty(face.pose.tolist() if hasattr(face.pose, 'tolist') else list(face.pose))

                # EAR — must come from a 68-point (iBUG) layout: compute_ear
                # indexes eyes at points 36-47. buffalo_l's landmark_3d_68
                # provides exactly that; landmark_2d_106 uses a different
                # 106-point layout where those indices are NOT the eyes.
                ear = 0.5
                lmk68 = getattr(face, 'landmark_3d_68', None)
                if lmk68 is not None and len(lmk68) >= 48:
                    ear = compute_ear(lmk68)

                # Eyes-open score in [0, 1]: MediaPipe blendshapes when a
                # matching face exists, geometric-EAR ramp otherwise.
                eyes_open = match_eyes_open(bbox_small, mp_faces)
                if eyes_open is None:
                    eyes_open = float(ear_to_openness(ear))

                face_records.append({
                    "photo_id": photo_id,
                    "photo_path": path,
                    "face_idx": fi,
                    "embedding": emb,
                    "bbox": bbox,
                    "det_score": float(face.det_score),
                    "face_sharpness": face_sharpness,
                    "face_size_ratio": face_size_ratio,
                    "pose_penalty": pose_penalty,
                    "ear": ear,
                    "eyes_open": eyes_open,
                    "person_id": None,
                })

            if callback:
                ratio = int(((i + 1) / len(image_paths)) * 100)
                # Face detection is the slowest per-image stream, so its loop
                # counter doubles as the "images analysed" meter for the UI.
                callback(
                    "analyzing", "Analyzing images (faces, persons, scenes, semantics)",
                    5 + int(ratio * 0.40),
                    {"imagesDone": done_offset + i + 1,
                     "imagesTotal": images_total or len(image_paths)},
                )

        return face_records, no_face_ids

    # ------------------------------------------------------- person detection (batched YOLO)
    def _detect_persons(
        self,
        image_paths: list[Path],
        img_cache: Dict[str, np.ndarray],
        callback: ProgressCallback | None = None,
    ) -> list[dict]:
        person_detections: list[dict] = []

        # Collect valid images and their paths
        valid_imgs: list[np.ndarray] = []
        valid_paths: list[Path] = []
        for path in image_paths:
            img_bgr = img_cache.get(str(path))
            if img_bgr is not None:
                valid_imgs.append(img_bgr)
                valid_paths.append(path)

        if not valid_imgs:
            return []

        batch_size = self.cfg.yolo_batch_size
        total = len(valid_imgs)

        for batch_start in range(0, total, batch_size):
            batch_imgs = valid_imgs[batch_start: batch_start + batch_size]
            batch_paths = valid_paths[batch_start: batch_start + batch_size]
            results = self.yolo(batch_imgs, classes=[0], imgsz=640, verbose=False)
            for path, r in zip(batch_paths, results):
                img_bgr = img_cache[str(path)]
                h, w = img_bgr.shape[:2]
                for box in r.boxes:
                    x1, y1, x2, y2 = box.xyxy[0].tolist()
                    conf = float(box.conf[0])
                    person_detections.append({
                        "photo_path": path,
                        "photo_id": None,
                        "image_hw": (h, w),
                        "bbox": [x1, y1, x2, y2],
                        "yolo_conf": conf,
                        "reid_embedding": None,
                        "face_record": None,
                        "person_id": None,
                    })

            if callback:
                ratio = int(min((batch_start + batch_size) / total, 1.0) * 100)
                callback("person_detection", "Detecting persons", 15 + int(ratio * 0.10))

        return person_detections

    # ------------------------------------------------------ reid embeddings (batched)
    def _extract_reid_embeddings(
        self,
        person_detections: list[dict],
        img_cache: Dict[str, np.ndarray],
        callback: ProgressCallback | None = None,
    ) -> list[dict]:
        # Phase 1: crop every person region into a tensor
        crop_tensors: list[torch.Tensor] = []
        valid_indices: list[int] = []

        for i, prec in enumerate(person_detections):
            if prec.get("reid_embedding") is not None:
                continue  # came from the embedding cache
            img_bgr = img_cache.get(str(prec["photo_path"]))
            if img_bgr is None:
                continue
            h, w = img_bgr.shape[:2]
            x1, y1, x2, y2 = [int(v) for v in prec["bbox"]]
            x1, y1 = max(0, x1), max(0, y1)
            x2, y2 = min(w, x2), min(h, y2)
            if x2 <= x1 + 10 or y2 <= y1 + 10:
                continue
            crop = img_bgr[y1:y2, x1:x2]
            pil_crop = Image.fromarray(cv2.cvtColor(crop, cv2.COLOR_BGR2RGB))
            crop_tensors.append(self.reid_transform(pil_crop))
            valid_indices.append(i)

        if crop_tensors:
            batch_size = self.cfg.reid_batch_size
            total_crops = len(crop_tensors)
            all_feats: list[np.ndarray] = []

            for batch_start in range(0, total_crops, batch_size):
                batch = torch.stack(crop_tensors[batch_start: batch_start + batch_size])
                if torch.cuda.is_available():
                    batch = batch.cuda()
                with torch.inference_mode():
                    feats = self.reid_model(batch).cpu().numpy()
                all_feats.append(feats)
                if callback:
                    ratio = int(min((batch_start + batch_size) / total_crops, 1.0) * 100)
                    callback("reid_embedding", "Extracting body embeddings", 45 + int(ratio * 0.10))

            all_feats_np = np.concatenate(all_feats, axis=0)
            for j, prec_idx in enumerate(valid_indices):
                feat = all_feats_np[j]
                norm = np.linalg.norm(feat)
                person_detections[prec_idx]["reid_embedding"] = feat / (norm + 1e-12)

        # Keep only detections that ended up with an embedding (cached or fresh)
        return [p for p in person_detections if p.get("reid_embedding") is not None]

    # -------------------------------------------------- link faces to persons
    def _link_faces_to_persons(
        self,
        person_detections: list[dict],
        face_records: list[dict],
        path_to_photo_id: dict[str, str],
    ) -> None:
        """Greedy IoU/containment matching, one face per person box.

        Replaces the old first-match containment test which mislinked faces in
        group photos with overlapping person boxes.
        """
        face_by_path: Dict[str, list[dict]] = {}
        for frec in face_records:
            face_by_path.setdefault(str(frec["photo_path"]), []).append(frec)

        persons_by_path: Dict[str, list[dict]] = {}
        for prec in person_detections:
            path_str = str(prec["photo_path"])
            prec["photo_id"] = path_to_photo_id.get(path_str)
            persons_by_path.setdefault(path_str, []).append(prec)

        for path_str, precs in persons_by_path.items():
            frecs = face_by_path.get(path_str, [])
            if not frecs:
                continue
            mapping = match_faces_to_persons(
                [f["bbox"] for f in frecs],
                [p["bbox"] for p in precs],
                min_containment=self.cfg.face_match_min_containment,
            )
            for face_idx, person_idx in mapping.items():
                precs[person_idx]["face_record"] = frecs[face_idx]

    # ------------------------------------------------ identity clustering
    def _cluster_identities(
        self,
        person_detections: list[dict],
        face_records: list[dict],
    ) -> None:
        """Cluster identities using confidence-weighted face+body fusion.

        Every face record becomes a cluster entity. Its embedding is
        e_fused = alpha * e_face (+) (1 - alpha) * e_body where alpha comes
        from detection confidence and face size, and e_body is the OSNet
        embedding of the person box the face was matched to (zero block when
        the face has no matched body). Faceless person detections are then
        attached to the nearest identity by ReID centroid distance.

        identity_mode config: "fused" (default), "face_only" (alpha = 1,
        Semester-1 behaviour), "body_only" (pure ReID clustering, ablation).
        """
        mode = self.cfg.identity_mode

        if mode == "body_only":
            self._cluster_identities_body_only(person_detections)
            return

        face_recs_with_emb = [f for f in face_records if f.get("embedding") is not None]

        if not face_recs_with_emb:
            self._cluster_identities_body_only(person_detections)
            return

        # Face record -> its matched person's body embedding (if any)
        face_to_body: Dict[int, np.ndarray] = {}
        for prec in person_detections:
            frec = prec.get("face_record")
            if frec is not None and prec.get("reid_embedding") is not None:
                face_to_body[id(frec)] = prec["reid_embedding"]

        fused_embs: list[np.ndarray] = []
        for frec in face_recs_with_emb:
            if mode == "face_only":
                alpha = 1.0
                body = None
            else:
                body = face_to_body.get(id(frec))
                alpha = face_confidence_alpha(frec["det_score"], frec["face_size_ratio"])
            fused = fuse_embeddings(frec["embedding"], body, alpha)
            fused_embs.append(fused)

        threshold = (
            self.cfg.face_cluster_distance if mode == "face_only"
            else self.cfg.fused_cluster_distance
        )

        if len(fused_embs) == 1:
            face_recs_with_emb[0]["person_id"] = "person_0"
        else:
            X = np.stack(fused_embs)
            agg = AgglomerativeClustering(
                n_clusters=None,
                distance_threshold=threshold,
                metric="cosine",
                linkage="average",
            )
            labels = agg.fit_predict(X)
            for frec, lbl in zip(face_recs_with_emb, labels):
                frec["person_id"] = f"person_{int(lbl)}"

        # ── Propagate face-based person_id → linked person detections ──
        for prec in person_detections:
            frec = prec.get("face_record")
            if frec is not None:
                prec["person_id"] = frec.get("person_id")

        # ── Assign faceless person detections via ReID distance ──
        pid_to_reid: Dict[str, list] = {}
        for prec in person_detections:
            if prec.get("person_id") and prec.get("reid_embedding") is not None:
                pid_to_reid.setdefault(prec["person_id"], []).append(prec["reid_embedding"])

        reid_centroids = {
            pid: np.mean(embs, axis=0) for pid, embs in pid_to_reid.items()
        }

        for prec in person_detections:
            if prec.get("person_id") is not None or prec.get("reid_embedding") is None:
                continue
            if not reid_centroids:
                continue
            reid_emb = prec["reid_embedding"]
            best_pid, best_dist = min(
                ((pid, float(np.linalg.norm(reid_emb - c))) for pid, c in reid_centroids.items()),
                key=lambda x: x[1],
            )
            if best_dist < self.cfg.reid_assign_threshold:
                prec["person_id"] = best_pid

    def _cluster_identities_body_only(self, person_detections: list[dict]) -> None:
        """Pure ReID clustering — used when no faces exist or for ablations."""
        if not person_detections:
            return
        with_emb = [p for p in person_detections if p.get("reid_embedding") is not None]
        if not with_emb:
            return
        reid_embeddings = np.stack([r["reid_embedding"] for r in with_emb])
        if len(with_emb) == 1:
            labels = np.array([0])
        else:
            hdb = hdbscan.HDBSCAN(
                min_cluster_size=self.cfg.hdbscan_min_cluster_size,
                min_samples=self.cfg.hdbscan_min_samples,
                metric="euclidean",
                cluster_selection_method="eom",
            )
            labels = hdb.fit_predict(reid_embeddings)

            unique_clusters = sorted({int(l) for l in labels if int(l) >= 0})
            if unique_clusters:
                centroids = {c: reid_embeddings[labels == c].mean(axis=0) for c in unique_clusters}
                for i, lbl in enumerate(labels):
                    if int(lbl) == -1:
                        dists = [(c, float(np.linalg.norm(reid_embeddings[i] - centroid))) for c, centroid in centroids.items()]
                        labels[i] = min(dists, key=lambda x: x[1])[0]

        for i, prec in enumerate(with_emb):
            pid = f"person_{int(labels[i])}" if int(labels[i]) >= 0 else None
            prec["person_id"] = pid
            if prec.get("face_record") is not None:
                prec["face_record"]["person_id"] = pid

    # -------------------------------------------------- DINO embeddings (cache-aware)
    def _extract_dino_embeddings(
        self,
        image_paths: list[Path],
        img_cache: Dict[str, np.ndarray],
        callback: ProgressCallback | None = None,
    ) -> np.ndarray:
        if not image_paths:
            return np.zeros((0, 384), dtype=np.float32)
        embeddings = []
        total_batches = max(1, (len(image_paths) + self.cfg.dino_batch_size - 1) // self.cfg.dino_batch_size)

        with torch.inference_mode():
            for batch_idx, i in enumerate(range(0, len(image_paths), self.cfg.dino_batch_size), start=1):
                batch_paths = image_paths[i: i + self.cfg.dino_batch_size]
                images = []
                for p in batch_paths:
                    img_bgr = img_cache.get(str(p))
                    if img_bgr is not None:
                        images.append(Image.fromarray(cv2.cvtColor(img_bgr, cv2.COLOR_BGR2RGB)))
                    else:
                        images.append(Image.open(p).convert("RGB"))  # fallback
                inputs = self.processor(images=images, return_tensors="pt")
                inputs = {k: v.to(self.device) for k, v in inputs.items()}
                outputs = self.dino_model(**inputs)
                if getattr(outputs, "pooler_output", None) is not None:
                    vec = outputs.pooler_output
                else:
                    vec = outputs.last_hidden_state[:, 0, :]
                vec = F.normalize(vec, p=2, dim=1)
                embeddings.append(vec.cpu().numpy())

                if callback:
                    ratio = int((batch_idx / total_batches) * 100)
                    callback("dino_embedding", "Extracting scene embeddings", 35 + int(ratio * 0.10))

        return np.concatenate(embeddings, axis=0)

    # ------------------------------------------------------ CLIP embeddings
    def _extract_clip_embeddings(
        self,
        image_paths: list[Path],
        img_cache: Dict[str, np.ndarray],
    ) -> np.ndarray:
        if self.clip is None or not image_paths:
            return np.zeros((0, 512), dtype=np.float32)
        pil_images = []
        for p in image_paths:
            img_bgr = img_cache.get(str(p))
            if img_bgr is not None:
                pil_images.append(Image.fromarray(cv2.cvtColor(img_bgr, cv2.COLOR_BGR2RGB)))
            else:
                pil_images.append(Image.open(p).convert("RGB"))
        return self.clip.embed_images(pil_images, batch_size=self.cfg.clip_batch_size)

    # --------------------------------------------------- event clustering (early-stop)
    def _cluster_events(
        self,
        dino_embeddings: np.ndarray,
        image_paths: list[Path],
        path_to_dino_idx: dict[str, int],
        person_detections: list[dict],
        exif_times: Optional[Dict[str, Optional[float]]] = None,
    ) -> dict[int, list[Path]]:
        """Agglomerative clustering on a time-blended visual distance matrix
        with a silhouette-tuned threshold.

        Visual (DINO cosine) distance is blended with EXIF capture-time
        proximity where timestamps exist — two look-alike cafe photos taken
        weeks apart are different events. Early-stop sweep when improvement
        stalls for `event_sweep_patience` steps."""
        event_paths = [p for p in image_paths if str(p) in path_to_dino_idx]
        if len(event_paths) <= 1:
            return {0: event_paths}

        event_idxs = [path_to_dino_idx[str(p)] for p in event_paths]
        X_event = dino_embeddings[event_idxs]

        # Embeddings are L2-normalised, so cosine distance = 1 - X X^T
        D = np.clip(1.0 - X_event @ X_event.T, 0.0, None)
        if exif_times and self.cfg.event_time_weight > 0:
            timestamps = [exif_times.get(str(p)) for p in event_paths]
            if any(t is not None for t in timestamps):
                D = blend_time_distance(
                    D, timestamps,
                    tau_seconds=self.cfg.event_time_tau_seconds,
                    weight=self.cfg.event_time_weight,
                )

        thresholds = np.arange(
            self.cfg.event_sweep_start,
            self.cfg.event_sweep_stop,
            self.cfg.event_sweep_step,
        )

        best_thresh = thresholds[0]
        best_sil = -1.0
        no_improve = 0

        def cluster_at(thresh: float) -> np.ndarray:
            agg = AgglomerativeClustering(
                n_clusters=None,
                distance_threshold=float(thresh),
                metric="precomputed",
                linkage="average",
            )
            return agg.fit_predict(D)

        for thresh in thresholds:
            lbls = cluster_at(thresh)
            n_cl = len(set(lbls))
            if 2 <= n_cl < len(D):
                sil = _sil(D, lbls, metric="precomputed")
                if sil > best_sil:
                    best_sil = sil
                    best_thresh = thresh
                    no_improve = 0
                else:
                    no_improve += 1
            else:
                no_improve += 1

            if no_improve >= self.cfg.event_sweep_patience:
                break

        final_labels = cluster_at(best_thresh)

        events: dict[int, list[Path]] = {}
        for path, lbl in zip(event_paths, final_labels):
            events.setdefault(int(lbl), []).append(path)

        return events

    # --------------------------------------------------------- NIMA scoring (batched)
    def _score_nima(
        self,
        image_paths: list[Path],
        img_cache: Dict[str, np.ndarray],
        callback: ProgressCallback | None = None,
    ) -> dict[str, float]:
        nima_scores: dict[str, float] = {}
        batch_size = self.cfg.nima_batch_size
        total = len(image_paths)
        if total == 0:
            return nima_scores
        to_tensor = T.ToTensor()

        for batch_start in range(0, total, batch_size):
            batch_paths = image_paths[batch_start: batch_start + batch_size]
            tensors: list[torch.Tensor] = []
            valid_paths: list[str] = []

            for path in batch_paths:
                img_bgr = img_cache.get(str(path))
                if img_bgr is None:
                    nima_scores[str(path)] = 0.0
                    continue
                img_rgb = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2RGB)
                pil_img = Image.fromarray(img_rgb).resize(_NIMA_SIZE, Image.BILINEAR)
                tensors.append(to_tensor(pil_img))
                valid_paths.append(str(path))

            if not tensors:
                continue

            batch_tensor = torch.stack(tensors).to(self.device)
            # pyiqa returns shape (n, 1); NumPy 2 refuses float() on a non-0-d array
            try:
                with torch.inference_mode():
                    scores = self.nima_metric(batch_tensor).cpu().numpy().reshape(-1)
                for path_str, score in zip(valid_paths, scores):
                    nima_scores[path_str] = float(score)
            except Exception as exc:
                print(f"[Lumina] Batched NIMA failed ({exc}); scoring one by one.")
                for path_str, t in zip(valid_paths, tensors):
                    try:
                        with torch.inference_mode():
                            score = self.nima_metric(t.unsqueeze(0).to(self.device)).cpu().numpy().reshape(-1)[0]
                        nima_scores[path_str] = float(score)
                    except Exception as exc_one:
                        print(f"[Lumina] NIMA failed for {Path(path_str).name}: {exc_one}")
                        nima_scores[path_str] = 0.0

            if callback:
                ratio = int(((batch_start + len(batch_paths)) / total) * 100)
                callback("aesthetic_scoring", "NIMA aesthetic scoring", 62 + int(ratio * 0.10))

        return nima_scores

    # ------------------------------------------------ embedding cache plumbing
    def _cache_key(self, image_hash: str) -> str:
        return f"{image_hash}:{self.cfg.cache_version}"

    def _rehydrate_cached(
        self,
        cached: dict,
        path: Path,
        photo_id: str,
    ) -> Tuple[list[dict], list[dict]]:
        """Turn a cached per-image feature dict back into live records."""
        face_records = []
        for f in cached.get("faces", []):
            face_records.append({
                **f,
                "photo_id": photo_id,
                "photo_path": path,
                "person_id": None,
            })
        person_detections = []
        for p in cached.get("persons", []):
            person_detections.append({
                **p,
                "photo_path": path,
                "photo_id": photo_id,
                "face_record": None,
                "person_id": None,
            })
        return face_records, person_detections

    @staticmethod
    def _strip_face_for_cache(frec: dict) -> dict:
        keep = ("face_idx", "embedding", "bbox", "det_score", "face_sharpness",
                "face_size_ratio", "pose_penalty", "ear", "eyes_open")
        return {k: frec[k] for k in keep if k in frec}

    @staticmethod
    def _strip_person_for_cache(prec: dict) -> dict:
        keep = ("image_hw", "bbox", "yolo_conf", "reid_embedding")
        return {k: prec[k] for k in keep if k in prec}

    # ------------------------------------------------ 7-signal event scoring
    def _best_face_signals(
        self,
        person_id: str | None,
        photo_path: Path,
        person_photo_to_faces: dict,
        photo_to_all_faces: dict,
    ) -> dict:
        recs = person_photo_to_faces.get(
            (person_id, str(photo_path)),
            photo_to_all_faces.get(str(photo_path), []),
        )
        if not recs:
            return {
                "det_score": 0, "pose_penalty": 0.5, "ear": 1.0,
                "face_sharpness": 0, "face_size_ratio": 0,
            }

        def _openness(r: dict) -> float:
            eo = r.get("eyes_open")
            if eo is None:  # pre-blendshape cache entries / fixtures
                eo = float(ear_to_openness(r.get("ear", 0.5)))
            return float(eo)

        # Aggregate over every face in scope, not just the most confident
        # one — in a group shot, one person's blink or blur should hurt the
        # photo. Eyes-open takes the MIN (any closed eyes count); sharpness/
        # pose/confidence average; size takes the most prominent face.
        # NOTE: the "ear" key carries the eyes-open score (0..1) from here on.
        return {
            "det_score": float(np.mean([r.get("det_score", 0) for r in recs])),
            "pose_penalty": float(np.mean([r.get("pose_penalty", 0.5) for r in recs])),
            "ear": float(min(_openness(r) for r in recs)),
            "face_sharpness": float(np.mean([r.get("face_sharpness", 0) for r in recs])),
            "face_size_ratio": float(max(r.get("face_size_ratio", 0) for r in recs)),
        }

    @staticmethod
    def _title_events(events: list[dict], samples: Dict[str, list]) -> None:
        """Give every event a human title, in place.

        A vision model (OpenRouter, one call per session) looks at each event's
        best shots and names it — "Sunset on the Beach", not "Event 2". Without
        a key, or if the call fails, the CLIP scene label stands, and events
        CLIP could not place are named by when they happened.
        """
        model = openrouter.event_model()
        if events and openrouter.is_configured() and model.lower() not in ("", "off", "none"):
            requests = []
            for evt in events:
                hints = []
                if evt.get("startTime") is not None:
                    import datetime as _dt
                    start = _dt.datetime.fromtimestamp(evt["startTime"])
                    hints.append(f"taken {start.strftime('%A %d %B %Y, around %I %p').replace(' 0', ' ')}")
                if evt.get("autoLabel"):
                    hints.append(f"a classifier guessed '{evt['autoLabel']['label']}'")
                if evt.get("caption"):
                    hints.append(f"one photo was captioned '{evt['caption']}'")
                hints.append(f"{len(evt['photoIds'])} photos")
                images = []
                for img_bgr in samples.get(evt["id"], []):
                    ok, buf = cv2.imencode(".jpg", img_bgr, [cv2.IMWRITE_JPEG_QUALITY, 85])
                    if ok:
                        images.append(buf.tobytes())
                requests.append({"images": images, "hint": "; ".join(hints)})

            titles = openrouter.name_events(requests, [label for label, _ in EVENT_PROMPT_BANK], model=model)
            for evt, named in zip(events, titles):
                if not named:
                    continue
                # The title comes from the vision model; autoLabel keeps a scene
                # word so Lumi's outfit and the search chips still work.
                clip_label = evt.get("autoLabel") or {}
                evt["label"] = named["title"]
                evt["autoLabel"] = {
                    "label": named["scene"] or clip_label.get("label"),
                    "confidence": clip_label.get("confidence", 1.0),
                    "source": "vision",
                    "model": model,
                }

        # Fallback: name untitled events by when they happened
        undated = 0
        for evt in (e for e in events if not e["label"]):
            evt["label"] = _when_label(evt.get("startTime"))
            if not evt["label"]:
                undated += 1
                evt["label"] = f"Moment {undated}"

        # Two events can land on the same name ("Beach" twice): tell them apart
        seen: Dict[str, int] = {}
        for evt in events:
            key = evt["label"].lower()
            seen[key] = seen.get(key, 0) + 1
            if seen[key] > 1:
                when = _when_label(evt.get("startTime"))
                evt["label"] = f"{evt['label']} · {when}" if when else f"{evt['label']} {seen[key]}"

    def _score_event_group(
        self,
        event_photo_paths: list[Path],
        dino_embeddings: np.ndarray,
        path_to_dino_idx: dict[str, int],
        nima_scores: dict[str, float],
        person_detections: list[dict],
        person_photo_to_faces: dict,
        photo_to_all_faces: dict,
        path_to_photo_id: dict[str, str],
        kept_pids: Optional[set] = None,
    ) -> Tuple[list[dict], list[dict], dict]:
        """Score one event group.

        Returns (members, best_by_person, mmr_picks):
        - members: photo-level scores sorted best-first, each carrying raw and
          normalised signals plus an explanation.
        - best_by_person: true per-event x per-identity selection — for each
          person in the event, their photos are re-scored using *that person's*
          face signals and the best one is picked.
        - mmr_picks: {mode: [photoId, ...]} diversity-aware highlight sets.
        """
        valid = [p for p in event_photo_paths if str(p) in path_to_dino_idx]
        if not valid:
            return [], [], {}

        weights = self.cfg.weights_dict()

        # Centrality — floored so near-identical bursts don't turn embedding
        # noise into a full-scale [0,1] signal.
        idxs = [path_to_dino_idx[str(p)] for p in valid]
        vecs = dino_embeddings[idxs]
        centroid = vecs.mean(axis=0, keepdims=True)
        dists = np.linalg.norm(vecs - centroid, axis=1)
        centrality = 1.0 - floored_minmax(dists, SIGNAL_SPAN_FLOORS["centrality"])

        # Build lookup: path -> person detections
        path_to_persons: Dict[str, list[dict]] = {}
        for prec in person_detections:
            path_to_persons.setdefault(str(prec["photo_path"]), []).append(prec)

        rows = []
        for i, path in enumerate(valid):
            photo_id = path_to_photo_id.get(str(path), "")
            persons_in_photo = [
                prec["person_id"]
                for prec in path_to_persons.get(str(path), [])
                if prec.get("person_id")
            ]
            # Faces can carry identities that YOLO missed — union both sources.
            for frec in photo_to_all_faces.get(str(path), []):
                if frec.get("person_id"):
                    persons_in_photo.append(frec["person_id"])

            # Background bystanders stay clustered internally but never
            # surface as event participants.
            if kept_pids is not None:
                persons_in_photo = [p for p in persons_in_photo if p in kept_pids]

            # Photo-level face signals: the most confident face in the photo
            fs = self._best_face_signals(None, path, person_photo_to_faces, photo_to_all_faces)
            ns = nima_scores.get(str(path), 0.0)

            rows.append({
                "photoId": photo_id,
                "path": path,
                "centrality_raw": float(centrality[i]),
                "faceSharpness_raw": fs["face_sharpness"],
                "faceSize_raw": fs["face_size_ratio"],
                "detScore_raw": fs["det_score"],
                "poseQuality_raw": fs["pose_penalty"],
                "ear_raw": fs["ear"],
                "nimaScore_raw": ns,
                "persons": sorted(set(persons_in_photo)),
            })

        if not rows:
            return [], [], {}

        # Normalize each signal within the group. Spans are floored so that a
        # trivially small raw spread (near-identical burst) stays a trivially
        # small normalised difference; EAR uses an absolute open/closed ramp
        # (blinks must score 0 even if everyone in the event blinked).
        signals = ["centrality", "faceSharpness", "faceSize", "detScore", "poseQuality", "ear", "nimaScore"]
        raw_arrays = {sig: np.array([r[f"{sig}_raw"] for r in rows], dtype=np.float32) for sig in signals}
        norm_arrays = {
            sig: (floored_minmax(raw_arrays[sig], SIGNAL_SPAN_FLOORS[sig])
                  if sig in SIGNAL_SPAN_FLOORS else minmax_norm(raw_arrays[sig]))
            for sig in signals
        }
        # centrality_raw is already normalised above — pass through unchanged;
        # ear_raw is already an absolute eyes-open score in [0, 1]
        norm_arrays["centrality"] = raw_arrays["centrality"]
        norm_arrays["ear"] = np.clip(raw_arrays["ear"], 0.0, 1.0)

        members = []
        for j, row in enumerate(rows):
            norm_signals = {sig: round(float(norm_arrays[sig][j]), 4) for sig in signals}
            final_score = float(sum(weights[sig] * norm_arrays[sig][j] for sig in signals))
            members.append({
                "photoId": row["photoId"],
                "finalScore": round(final_score, 4),
                "centrality": round(float(norm_arrays["centrality"][j]), 4),
                "faceSharpness": round(row["faceSharpness_raw"], 4),
                "faceSize": round(row["faceSize_raw"], 6),
                "detScore": round(row["detScore_raw"], 4),
                "poseQuality": round(row["poseQuality_raw"], 4),
                "ear": round(row["ear_raw"], 4),
                "nimaScore": round(row["nimaScore_raw"], 4),
                "normSignals": norm_signals,
                "persons": row["persons"],
            })

        # Hard constraint: a photo with closed eyes is never selected over a
        # non-blinking alternative, whatever the other signals say. Blinking
        # members sink below all non-blinking ones; ties break by score.
        def _is_blink(m: dict) -> bool:
            return m["detScore"] > 0 and m["ear"] < REJECT_EAR_CLOSED

        members.sort(key=lambda m: (_is_blink(m), -m["finalScore"]))

        # ── Near-duplicate (burst) stacks on DINO embeddings ─────────────────
        # The best-scoring member of each stack is the keeper; the rest are
        # flagged as its duplicates.
        member_rank = {m["photoId"]: rank for rank, m in enumerate(members)}
        duplicate_of: Dict[str, str] = {}
        for stack in find_duplicate_stacks(vecs, self.cfg.duplicate_sim_threshold):
            stack_ids = [rows[k]["photoId"] for k in stack]
            keeper = min(stack_ids, key=lambda pid: member_rank.get(pid, 1 << 30))
            for pid in stack_ids:
                if pid != keeper:
                    duplicate_of[pid] = keeper

        # Explanations + reject flags (both need the final ranking)
        group_size = len(members)
        for rank, m in enumerate(members):
            runner_up = members[1]["normSignals"] if rank == 0 and group_size > 1 else None
            raw = {"nimaScore": m["nimaScore"]}
            m["explanation"] = build_explanation(
                m["normSignals"], raw, rank, group_size,
                weights=weights, runner_up_norm=runner_up,
            )
            if m["photoId"] in duplicate_of:
                m["duplicateOf"] = duplicate_of[m["photoId"]]
            m["flags"] = reject_flags(
                raw_signals={"faceSharpness": m["faceSharpness"], "ear": m["ear"]},
                norm_signals=m["normSignals"],
                is_duplicate_loser=m["photoId"] in duplicate_of,
                has_face=m["detScore"] > 0,
                rank=rank,
                group_size=group_size,
            )

        # ── True per-event x per-identity selection ──────────────────────────
        # For each person, re-score their photos using that person's own face
        # signals (normalised across the person's photos within this event).
        photo_norm_shared = {
            m["photoId"]: {"centrality": m["normSignals"]["centrality"],
                           "nimaScore": m["normSignals"]["nimaScore"]}
            for m in members
        }
        person_ids = sorted({p for m in members for p in m.get("persons", [])})
        row_by_photo = {r["photoId"]: r for r in rows}

        best_by_person: list[dict] = []
        for pid in person_ids:
            candidates = []
            for m in members:
                if pid not in m.get("persons", []):
                    continue
                path = row_by_photo[m["photoId"]]["path"]
                fs = self._best_face_signals(pid, path, person_photo_to_faces, photo_to_all_faces)
                candidates.append((m["photoId"], fs))
            if not candidates:
                continue

            face_sigs = ["face_sharpness", "face_size_ratio", "det_score", "pose_penalty", "ear"]
            sig_key = {
                "face_sharpness": "faceSharpness", "face_size_ratio": "faceSize",
                "det_score": "detScore", "pose_penalty": "poseQuality", "ear": "ear",
            }
            raw_mat = {s: np.array([c[1][s] for c in candidates], dtype=np.float32) for s in face_sigs}
            norm_mat = {s: minmax_norm(raw_mat[s]) for s in face_sigs}
            norm_mat["ear"] = np.clip(raw_mat["ear"], 0.0, 1.0)

            scored = []
            for k, (photo_id, fs) in enumerate(candidates):
                shared = photo_norm_shared.get(photo_id, {"centrality": 0.0, "nimaScore": 0.0})
                norm_signals = {
                    "centrality": float(shared["centrality"]),
                    "nimaScore": float(shared["nimaScore"]),
                    **{sig_key[s]: float(norm_mat[s][k]) for s in face_sigs},
                }
                score = float(sum(weights[sig] * norm_signals[sig] for sig in SIGNAL_ORDER))
                blink = fs["det_score"] > 0 and fs["ear"] < REJECT_EAR_CLOSED
                scored.append({"photoId": photo_id, "score": round(score, 4),
                               "normSignals": norm_signals, "blink": blink})

            # Same hard constraint per person: never pick their blink shot
            # while an eyes-open shot of them exists.
            scored.sort(key=lambda s: (s["blink"], -s["score"]))
            top = scored[0]
            explanation = build_explanation(
                top["normSignals"], {}, 0, len(scored),
                weights=weights,
                runner_up_norm=scored[1]["normSignals"] if len(scored) > 1 else None,
            )
            best_by_person.append({
                "personId": pid,
                "photoId": top["photoId"],
                "score": top["score"],
                "numCandidates": len(scored),
                "explanation": explanation,
            })

        # ── MMR diversity picks ──────────────────────────────────────────────
        mmr_picks: dict = {}
        if len(members) >= 3:
            member_ids = [m["photoId"] for m in members]
            id_to_row_idx = {r["photoId"]: i for i, r in enumerate(rows)}
            emb_rows = np.stack([vecs[id_to_row_idx[mid]] for mid in member_ids])
            relevance = np.array([m["finalScore"] for m in members], dtype=np.float64)
            k = min(self.cfg.mmr_max_picks, len(members))
            for mode, lam in MMR_MODES.items():
                picked = mmr_select(relevance, emb_rows, k, lam)
                mmr_picks[mode] = [member_ids[i] for i in picked]

        return members, best_by_person, mmr_picks

    # ----------------------------------------------- face thumbnail (cache-aware)
    def _crop_face_thumbnail(
        self,
        path: Path,
        face_recs: list[dict],
        img_cache: Dict[str, np.ndarray],
        size: int = 128,
    ) -> str | None:
        if not face_recs:
            return None
        img_bgr = img_cache.get(str(path))
        if img_bgr is None:
            img_bgr = cv2.imread(str(path))
        if img_bgr is None:
            return None
        h, w = img_bgr.shape[:2]
        best_rec = max(face_recs, key=lambda r: (r["bbox"][2] - r["bbox"][0]) * (r["bbox"][3] - r["bbox"][1]))
        x1, y1, x2, y2 = (int(v) for v in best_rec["bbox"])
        pad = int(max(x2 - x1, y2 - y1) * 0.35)
        x1, y1 = max(0, x1 - pad), max(0, y1 - pad)
        x2, y2 = min(w, x2 + pad), min(h, y2 + pad)
        if x2 <= x1 or y2 <= y1:
            return None
        crop = img_bgr[y1:y2, x1:x2]
        if crop.size == 0:
            return None
        crop_rgb = cv2.cvtColor(crop, cv2.COLOR_BGR2RGB)
        pil_img = Image.fromarray(crop_rgb).resize((size, size), Image.LANCZOS)
        buf = io.BytesIO()
        pil_img.save(buf, format="JPEG", quality=85)
        b64 = base64.b64encode(buf.getvalue()).decode("utf-8")
        return f"data:image/jpeg;base64,{b64}"

    # ================================================================= run
    def run(
        self,
        image_paths: list[Path],
        photo_ids: list[str],
        callback: ProgressCallback | None = None,
    ) -> dict:
        if len(image_paths) == 0:
            raise ValueError("No images were provided.")
        if len(image_paths) != len(photo_ids):
            raise ValueError("photo_ids must have same length as image_paths.")

        t_start = time.time()
        timings: Dict[str, float] = {}

        path_to_photo_id = {str(p): pid for p, pid in zip(image_paths, photo_ids)}

        # ── Step 1: Load models (0–5%) ──────────────────────────────────────
        if callback:
            callback("loading_models", "Loading models (DINO, InsightFace, YOLO, OSNet, NIMA, CLIP)", 2)
        self._load_models()
        if callback:
            callback("loading_models", "Models loaded", 3)

        # ── Step 1a: Load images (parallel; one disk read per file gives
        #     pixels + content hash + EXIF capture time) ────────────────────
        t0 = time.time()
        img_cache, content_hashes, exif_times = self._build_image_cache(image_paths, callback=callback)
        timings["image_load"] = time.time() - t0

        # ── Step 1b: Embedding-cache lookup by content hash ─────────────────
        t0 = time.time()
        cached_features: Dict[str, dict] = {}
        if self.store is not None:
            for path in image_paths:
                digest = content_hashes.get(str(path))
                if digest is None:
                    continue
                hit = self.store.cache_get(self._cache_key(digest))
                if hit is not None:
                    cached_features[str(path)] = hit
        uncached_paths = [p for p in image_paths if str(p) not in cached_features]
        uncached_ids = [path_to_photo_id[str(p)] for p in uncached_paths]
        cache_hits = len(image_paths) - len(uncached_paths)
        timings["cache_lookup"] = time.time() - t0
        if callback:
            callback("loading_models", f"Images loaded ({cache_hits} cached)", 5)

        # ── Parallel block 1: faces + persons + DINO + CLIP on uncached (5–45%) ──
        if callback:
            callback("analyzing", "Analyzing images (faces, persons, scenes, semantics)", 5,
                     {"imagesDone": cache_hits, "imagesTotal": len(image_paths)})

        t0 = time.time()
        with ThreadPoolExecutor(max_workers=4) as pool:
            future_faces = pool.submit(
                self._detect_faces, uncached_paths, uncached_ids, img_cache,
                callback, cache_hits, len(image_paths),
            )
            future_persons = pool.submit(
                self._detect_persons, uncached_paths, img_cache,
            )
            future_dino = pool.submit(
                self._extract_dino_embeddings, uncached_paths, img_cache,
            )
            future_clip = pool.submit(
                self._extract_clip_embeddings, uncached_paths, img_cache,
            )

            face_records, no_face_ids = future_faces.result()
            person_detections = future_persons.result()
            dino_uncached = future_dino.result()
            clip_uncached = future_clip.result()
        timings["feature_extraction"] = time.time() - t0

        if callback:
            callback("analyzing", "Detection & embedding complete", 45)

        # ── Step 4: ReID embeddings — batched (45–55%) ───────────────────────
        t0 = time.time()
        if callback:
            callback("reid_embedding", "Extracting body embeddings", 45)
        person_detections = self._extract_reid_embeddings(person_detections, img_cache, callback=callback)
        timings["reid"] = time.time() - t0
        if callback:
            callback("reid_embedding", "Body embeddings extracted", 55)

        # ── Step 4b: NIMA on uncached (folded into parallel block 2 later
        #     for fresh runs; here we only prepare the per-path map) ─────────
        uncached_dino_by_path = {str(p): dino_uncached[i] for i, p in enumerate(uncached_paths)}
        uncached_clip_by_path = (
            {str(p): clip_uncached[i] for i, p in enumerate(uncached_paths)}
            if clip_uncached.shape[0] == len(uncached_paths) else {}
        )

        # ── Step 4c: merge cached features into live records ────────────────
        for path in image_paths:
            path_str = str(path)
            cached = cached_features.get(path_str)
            if cached is None:
                continue
            photo_id = path_to_photo_id[path_str]
            frecs, precs = self._rehydrate_cached(cached, path, photo_id)
            if not frecs:
                no_face_ids.append(photo_id)
            face_records.extend(frecs)
            person_detections.extend(precs)

        # Assemble DINO / CLIP matrices in canonical image order
        dino_rows, clip_rows, dino_ok_paths = [], [], []
        for path in image_paths:
            path_str = str(path)
            cached = cached_features.get(path_str)
            if cached is not None:
                dino_rows.append(cached["dino"])
                clip_rows.append(cached.get("clip"))
                dino_ok_paths.append(path_str)
            elif path_str in uncached_dino_by_path:
                dino_rows.append(uncached_dino_by_path[path_str])
                clip_rows.append(uncached_clip_by_path.get(path_str))
                dino_ok_paths.append(path_str)

        dino_embeddings = np.stack(dino_rows) if dino_rows else np.zeros((0, 384), dtype=np.float32)
        path_to_dino_idx = {p: i for i, p in enumerate(dino_ok_paths)}

        # ── Step 5: Link faces to persons + Identity clustering (55–60%) ────
        t0 = time.time()
        if callback:
            callback("identity_clustering", "Clustering identities (fused face + body)", 55)
        self._link_faces_to_persons(person_detections, face_records, path_to_photo_id)
        self._cluster_identities(person_detections, face_records)
        timings["identity_clustering"] = time.time() - t0
        if callback:
            callback("identity_clustering", "Identity clustering complete", 60)

        # ── Step 5b: prominence filter — hide background bystanders ─────────
        # Every stranger in a public place gets detected and clustered; only
        # identities that recur or have a reasonably large face surface as
        # "people". (Skipped in body_only ablation mode: no face sizes there.)
        kept_pids: Optional[set] = None
        background_count = 0
        if self.cfg.identity_mode != "body_only":
            pid_photos: Dict[str, set] = {}
            pid_max_ratio: Dict[str, float] = {}
            for frec in face_records:
                pid = frec.get("person_id")
                if not pid:
                    continue
                pid_photos.setdefault(pid, set()).add(frec["photo_id"])
                pid_max_ratio[pid] = max(pid_max_ratio.get(pid, 0.0), float(frec.get("face_size_ratio", 0.0)))
            for prec in person_detections:
                pid = prec.get("person_id")
                if pid and prec.get("photo_id"):
                    pid_photos.setdefault(pid, set()).add(prec["photo_id"])
                    pid_max_ratio.setdefault(pid, 0.0)
            kept_pids = {
                pid for pid, photos in pid_photos.items()
                if is_prominent_identity(
                    len(photos),
                    pid_max_ratio.get(pid, 0.0),
                    self.cfg.identity_min_appearances,
                    self.cfg.identity_min_face_ratio,
                )
            }
            background_count = len(pid_photos) - len(kept_pids)

        # ── Parallel block 2: Event clustering + NIMA on uncached (60–72%) ──
        if callback:
            callback("clustering_scoring", "Clustering events & scoring aesthetics", 60)

        t0 = time.time()
        with ThreadPoolExecutor(max_workers=2) as pool:
            future_events = pool.submit(
                self._cluster_events, dino_embeddings, image_paths,
                path_to_dino_idx, person_detections, exif_times,
            )
            future_nima = pool.submit(
                self._score_nima, uncached_paths, img_cache,
            )

            event_groups = future_events.result()
            nima_scores = future_nima.result()
        timings["events_and_nima"] = time.time() - t0

        # Merge cached NIMA scores
        for path_str, cached in cached_features.items():
            nima_scores[path_str] = float(cached.get("nima", 0.0))

        if callback:
            callback("clustering_scoring", "Events clustered & aesthetics scored", 70)

        # ── Step 6b: write fresh features into the embedding cache ──────────
        if self.store is not None and uncached_paths:
            faces_by_path: Dict[str, list] = {}
            for frec in face_records:
                if str(frec["photo_path"]) in cached_features:
                    continue
                faces_by_path.setdefault(str(frec["photo_path"]), []).append(frec)
            persons_by_path: Dict[str, list] = {}
            for prec in person_detections:
                if str(prec["photo_path"]) in cached_features:
                    continue
                persons_by_path.setdefault(str(prec["photo_path"]), []).append(prec)

            for path in uncached_paths:
                path_str = str(path)
                if path_str not in uncached_dino_by_path:
                    continue
                digest = content_hashes.get(path_str)
                if digest is None:
                    continue
                key = self._cache_key(digest)
                entry = {
                    "faces": [self._strip_face_for_cache(f) for f in faces_by_path.get(path_str, [])],
                    "persons": [self._strip_person_for_cache(p) for p in persons_by_path.get(path_str, [])],
                    "dino": uncached_dino_by_path[path_str],
                    "clip": uncached_clip_by_path.get(path_str),
                    "nima": float(nima_scores.get(path_str, 0.0)),
                }
                try:
                    self.store.cache_put(key, entry)
                except Exception:
                    pass  # cache failures must never fail the run

        # ── Step 7: CLIP event auto-naming ───────────────────────────────────
        clip_by_path = {}
        for i, p in enumerate(dino_ok_paths):
            if clip_rows[i] is not None:
                clip_by_path[p] = clip_rows[i]

        # ── Step 9: Quality scoring per event (72–92%) ──────────────────────
        if callback:
            callback("quality_scoring", "Scoring photos per event & per person", 72)

        t0 = time.time()
        # Build lookup structures
        person_photo_to_faces: Dict[tuple, list[dict]] = {}
        photo_to_all_faces: Dict[str, list[dict]] = {}
        for rec in face_records:
            photo_to_all_faces.setdefault(str(rec["photo_path"]), []).append(rec)
            if rec["person_id"] is not None:
                person_photo_to_faces.setdefault((rec["person_id"], str(rec["photo_path"])), []).append(rec)

        events_payload: list[dict] = []
        title_samples: Dict[str, list] = {}  # event id -> a few BGR shots for the titler
        total_events = max(1, len(event_groups))

        for evt_idx, (evt_label, evt_paths) in enumerate(sorted(event_groups.items())):
            members, best_by_person, mmr_picks = self._score_event_group(
                evt_paths, dino_embeddings, path_to_dino_idx,
                nima_scores, person_detections,
                person_photo_to_faces, photo_to_all_faces, path_to_photo_id,
                kept_pids=kept_pids,
            )
            if not members:
                continue

            event_persons = list({p for m in members for p in m.get("persons", []) if p})

            for m in members:
                m.pop("persons", None)

            top_photo_id = members[0]["photoId"]

            # Zero-shot event naming from CLIP centroids
            auto_label = None
            if self.clip is not None:
                evt_clip = [clip_by_path[str(p)] for p in evt_paths if str(p) in clip_by_path]
                if evt_clip:
                    try:
                        auto_label = self.clip.name_event(np.stack(evt_clip))
                    except Exception:
                        auto_label = None

            label = auto_label["label"] if auto_label is not None else None

            # EXIF time span of the event (None when no member has EXIF)
            evt_ts = [exif_times.get(str(p)) for p in evt_paths]
            evt_ts = [t for t in evt_ts if t is not None]
            start_time = min(evt_ts) if evt_ts else None
            end_time = max(evt_ts) if evt_ts else None
            date_label = None
            if start_time is not None:
                import datetime as _dt
                start_dt = _dt.datetime.fromtimestamp(start_time)
                date_label = start_dt.strftime("%a %d %b %Y")

            # One-line BLIP caption of the best shot
            caption = None
            if self.captioner is not None:
                top_path = next((p for p in evt_paths if path_to_photo_id.get(str(p)) == top_photo_id), None)
                img_bgr = img_cache.get(str(top_path)) if top_path is not None else None
                if img_bgr is not None:
                    caption = self.captioner.caption(
                        Image.fromarray(cv2.cvtColor(img_bgr, cv2.COLOR_BGR2RGB))
                    )

            # A varied handful of shots for the vision titler below
            sample_ids = (mmr_picks or {}).get("diverse") or [m["photoId"] for m in members]
            id_to_path = {path_to_photo_id.get(str(p)): str(p) for p in evt_paths}
            title_samples[f"event_{evt_idx}"] = [
                img_cache[id_to_path[pid]] for pid in sample_ids[:3]
                if pid in id_to_path and id_to_path[pid] in img_cache
            ]

            events_payload.append({
                "id": f"event_{evt_idx}",
                "label": label,
                "autoLabel": auto_label,
                "caption": caption,
                "startTime": start_time,
                "endTime": end_time,
                "dateLabel": date_label,
                "photoIds": [m["photoId"] for m in members],
                "topPhotoId": top_photo_id,
                "persons": event_persons,
                "members": members,
                "bestByPerson": best_by_person,
                "mmrPicks": mmr_picks,
            })

            if callback:
                ratio = int(((evt_idx + 1) / total_events) * 100)
                callback("quality_scoring", "Scoring photos per event & per person", 72 + int(ratio * 0.20))
        timings["scoring"] = time.time() - t0

        # ── Chronological order: dated events first (oldest → newest),
        #     undated ones keep their relative order at the end ──────────────
        events_payload.sort(key=lambda e: (e["startTime"] is None, e["startTime"] or 0))
        t0 = time.time()
        if callback:
            callback("quality_scoring", "Naming your events", 93)
        self._title_events(events_payload, title_samples)
        timings["event_titles"] = time.time() - t0

        # ── Build identities payload (prominent people only) ────────────────
        identity_map: Dict[str, Dict] = {}
        for prec in person_detections:
            pid = prec.get("person_id")
            if not pid or (kept_pids is not None and pid not in kept_pids):
                continue
            if pid not in identity_map:
                identity_map[pid] = {"photoIds": set(), "eventIds": set(), "face_recs": []}
            photo_id = prec.get("photo_id")
            if photo_id:
                identity_map[pid]["photoIds"].add(photo_id)
            if prec.get("face_record"):
                identity_map[pid]["face_recs"].append(prec["face_record"])

        # Faces without person boxes still carry identities
        for frec in face_records:
            pid = frec.get("person_id")
            if not pid or (kept_pids is not None and pid not in kept_pids):
                continue
            if pid not in identity_map:
                identity_map[pid] = {"photoIds": set(), "eventIds": set(), "face_recs": []}
            identity_map[pid]["photoIds"].add(frec["photo_id"])
            identity_map[pid]["face_recs"].append(frec)

        photo_to_event: Dict[str, str] = {}
        for evt in events_payload:
            for pid2 in evt["photoIds"]:
                photo_to_event[pid2] = evt["id"]

        for pid, info in identity_map.items():
            for photo_id in info["photoIds"]:
                eid = photo_to_event.get(photo_id)
                if eid:
                    info["eventIds"].add(eid)

        sorted_identities = sorted(identity_map.items(), key=lambda kv: len(kv[1]["photoIds"]), reverse=True)

        identities_payload: list[dict] = []
        for idx, (pid, info) in enumerate(sorted_identities):
            face_thumb = None
            face_recs = info["face_recs"]
            if face_recs:
                best_face_rec = max(face_recs, key=lambda r: r.get("det_score", 0))
                face_thumb = self._crop_face_thumbnail(
                    best_face_rec["photo_path"],
                    [best_face_rec],
                    img_cache,
                )

            # Normalised face box per photo (best face by det_score) so the
            # UI can draw "this is them" highlights. Coordinates are 0..1
            # fractions of the image, so they survive any client-side resize.
            face_boxes: Dict[str, list] = {}
            best_score: Dict[str, float] = {}
            for rec in face_recs:
                rec_photo_id = rec.get("photo_id")
                img = img_cache.get(str(rec.get("photo_path")))
                if not rec_photo_id or img is None:
                    continue
                score = float(rec.get("det_score", 0))
                if score <= best_score.get(rec_photo_id, -1.0):
                    continue
                h, w = img.shape[:2]
                x1, y1, x2, y2 = rec["bbox"]
                face_boxes[rec_photo_id] = [
                    round(float(np.clip(x1 / w, 0, 1)), 4),
                    round(float(np.clip(y1 / h, 0, 1)), 4),
                    round(float(np.clip(x2 / w, 0, 1)), 4),
                    round(float(np.clip(y2 / h, 0, 1)), 4),
                ]
                best_score[rec_photo_id] = score

            identities_payload.append({
                "id": pid,
                "label": f"Person {idx + 1}",
                "faceThumb": face_thumb,
                "photoIds": sorted(info["photoIds"]),
                "eventIds": sorted(info["eventIds"]),
                "faceBoxes": face_boxes,
            })

        # ── Step 10: Finalize (92–100%) ─────────────────────────────────────
        if callback:
            callback("finalizing", "Finalizing results", 96)

        timings["total"] = time.time() - t_start

        result = {
            "summary": {
                "numPhotos": len(image_paths),
                "numEvents": len(events_payload),
                "numIdentities": len(identities_payload),
                "backgroundIdentities": background_count,
                "noFacePhotos": len(set(no_face_ids)),
                "embeddingModel": self.dino_model_id_in_use,
                "faceModel": self.cfg.insightface_model,
                "reidModel": self.cfg.reid_model_name,
                "yoloModel": self.cfg.yolo_model,
                "clipModel": "openai/clip-vit-base-patch32" if self.clip is not None else None,
                "identityMode": self.cfg.identity_mode,
                "cacheHits": cache_hits,
                "cacheMisses": len(uncached_paths),
                "timings": {k: round(v, 2) for k, v in timings.items()},
            },
            "events": events_payload,
            "identities": identities_payload,
        }

        # CLIP embeddings ride along under a private key; the server strips
        # them from the client payload and persists them for /api/search.
        if self.clip is not None and clip_by_path:
            search_ids, search_matrix = [], []
            for path_str, emb in clip_by_path.items():
                pid = path_to_photo_id.get(path_str)
                if pid is not None and emb is not None:
                    search_ids.append(pid)
                    search_matrix.append(np.asarray(emb, dtype=np.float32))
            if search_ids:
                result["_clipIndex"] = {
                    "photoIds": search_ids,
                    "matrix": np.stack(search_matrix),
                }

        if callback:
            callback("completed", "Analysis complete", 100)
        return result

    def run_quick(
        self,
        image_paths: list[Path],
        photo_ids: list[str],
        callback: ProgressCallback | None = None,
    ) -> dict:
        """"Analysis off": describe each photo, and nothing else.

        No faces, people, scoring, best shots, duplicate checks or grouping
        into moments. Each photo gets one CLIP pass, which yields its scene
        label ("context") and makes it searchable by text. Photos come back as
        one collection in capture-time order, in the same result shape as
        run(), so the gallery, sessions and search all keep working.
        """
        if len(image_paths) == 0:
            raise ValueError("No images were provided.")
        if len(image_paths) != len(photo_ids):
            raise ValueError("photo_ids must have same length as image_paths.")

        t_start = time.time()
        timings: Dict[str, float] = {}
        total = len(image_paths)
        path_to_photo_id = {str(p): pid for p, pid in zip(image_paths, photo_ids)}

        if callback:
            callback("loading_models", "Loading your photos", 2)
        self._load_models()

        t0 = time.time()
        img_cache, content_hashes, exif_times = self._build_image_cache(image_paths, callback=callback)
        timings["image_load"] = time.time() - t0

        # A full analysis may already have embedded these photos. Quick runs
        # only read that cache: a CLIP-only entry would hide the face and
        # person features a later full analysis needs.
        clip_by_path: Dict[str, np.ndarray] = {}
        if self.store is not None:
            for path in image_paths:
                digest = content_hashes.get(str(path))
                hit = self.store.cache_get(self._cache_key(digest)) if digest else None
                if hit is not None and hit.get("clip") is not None:
                    clip_by_path[str(path)] = np.asarray(hit["clip"], dtype=np.float32)
        cache_hits = len(clip_by_path)

        t0 = time.time()
        todo = [p for p in image_paths if str(p) not in clip_by_path and str(p) in img_cache]
        done = cache_hits
        if callback:
            callback("describing", "Reading what is in each photo", 10,
                     {"imagesDone": done, "imagesTotal": total})
        if self.clip is not None:
            step = max(1, self.cfg.clip_batch_size)
            for start in range(0, len(todo), step):
                batch = todo[start:start + step]
                embs = self._extract_clip_embeddings(batch, img_cache)
                for path, emb in zip(batch, embs):
                    clip_by_path[str(path)] = emb
                done += len(batch)
                if callback:
                    callback("describing", "Reading what is in each photo", 10 + int(80 * done / total),
                             {"imagesDone": done, "imagesTotal": total})
        timings["clip"] = time.time() - t0

        # Per-photo context: the closest scene in the prompt bank, if any is
        # close enough to trust.
        context: Dict[str, Optional[dict]] = {}
        if self.clip is not None:
            for path_str, emb in clip_by_path.items():
                try:
                    context[path_str] = self.clip.name_event(np.asarray(emb, dtype=np.float32)[None, :])
                except Exception:
                    context[path_str] = None

        if callback:
            callback("finalizing", "Laying out your photos", 95)

        # Capture-time order; photos without EXIF keep their upload order, last.
        order = sorted(
            range(total),
            key=lambda i: (exif_times.get(str(image_paths[i])) is None,
                           exif_times.get(str(image_paths[i])) or 0, i),
        )
        ordered_paths = [image_paths[i] for i in order if str(image_paths[i]) in img_cache]
        if not ordered_paths:
            raise ValueError("None of the photos could be read.")

        members = []
        for path in ordered_paths:
            ctx = context.get(str(path))
            members.append({
                "photoId": path_to_photo_id[str(path)],
                # No scoring in this mode; zeros keep the result shape uniform.
                "finalScore": 0.0, "centrality": 0.0, "faceSharpness": 0.0, "faceSize": 0.0,
                "detScore": 0.0, "poseQuality": 0.0, "ear": 0.0, "nimaScore": 0.0,
                "context": ctx["label"] if ctx else None,
            })

        stamps = [exif_times.get(str(p)) for p in ordered_paths]
        stamps = [t for t in stamps if t is not None]
        start_time = min(stamps) if stamps else None
        end_time = max(stamps) if stamps else None
        date_label = None
        if start_time is not None:
            import datetime as _dt
            date_label = _dt.datetime.fromtimestamp(start_time).strftime("%a %d %b %Y")

        overall = None
        if self.clip is not None and clip_by_path:
            try:
                overall = self.clip.name_event(np.stack([np.asarray(e, dtype=np.float32) for e in clip_by_path.values()]))
            except Exception:
                overall = None

        event = {
            "id": "event_0",
            "label": "Your photos",
            "autoLabel": overall,
            "caption": None,
            "startTime": start_time,
            "endTime": end_time,
            "dateLabel": date_label,
            "photoIds": [m["photoId"] for m in members],
            # A cover for listings, not a pick: nothing is ranked in this mode.
            "topPhotoId": members[0]["photoId"],
            "persons": [],
            "members": members,
            "bestByPerson": [],
            "mmrPicks": {},
        }

        timings["total"] = time.time() - t_start
        result = {
            "summary": {
                "mode": "quick",
                "numPhotos": total,
                "numEvents": 1,
                "numIdentities": 0,
                "embeddingModel": "openai/clip-vit-base-patch32" if self.clip is not None else "none",
                "clipModel": "openai/clip-vit-base-patch32" if self.clip is not None else None,
                "cacheHits": cache_hits,
                "cacheMisses": len(todo),
                "timings": {k: round(v, 2) for k, v in timings.items()},
            },
            "events": [event],
            "identities": [],
        }

        search_ids = [path_to_photo_id[p] for p in clip_by_path]
        if search_ids:
            result["_clipIndex"] = {
                "photoIds": search_ids,
                "matrix": np.stack([np.asarray(e, dtype=np.float32) for e in clip_by_path.values()]),
            }

        if callback:
            callback("completed", "Done", 100)
        return result
