from __future__ import annotations

import base64
import io
import json
import os
import random
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

SEED = 42
random.seed(SEED)
np.random.seed(SEED)
torch.manual_seed(SEED)
BASE_DIR = Path(__file__).resolve().parent

ProgressCallback = Callable[[str, str, int], None]

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

    # Image cache — long edge capped before any model sees the image
    max_image_dim: int = 1280

    # Face detection — downscale to this long edge before InsightFace
    face_det_max_dim: int = 640

    # NIMA — batched aesthetic scoring
    nima_batch_size: int = 16

    # HDBSCAN identity clustering
    hdbscan_min_cluster_size: int = 2
    hdbscan_min_samples: int = 1  # lenient — fewer noise singletons

    # ArcFace clustering: cosine distance threshold for AgglomerativeClustering.
    # Same person across photos ≈ 0.1-0.5 cosine dist; different persons > 0.6.
    # Be permissive to avoid splitting the same person into two clusters.
    face_cluster_distance: float = 0.6

    # ReID fallback: max euclidean distance to attach a faceless person to a known identity
    reid_assign_threshold: float = 0.75

    # Agglomerative event clustering — silhouette sweep range
    event_sweep_start: float = 0.1
    event_sweep_stop: float = 3.0
    event_sweep_step: float = 0.25
    event_sweep_patience: int = 3  # stop if no improvement for N consecutive thresholds

    # 7-signal scoring weights (sum to 1.0)
    w_centrality: float = 0.25
    w_nima: float = 0.25
    w_face_sharpness: float = 0.15
    w_face_size: float = 0.10
    w_det_score: float = 0.10
    w_pose: float = 0.10
    w_ear: float = 0.05


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

def face_center_in_box(face_bbox: list, person_bbox: list) -> bool:
    """True if face centre falls inside the person bounding box."""
    fx1, fy1, fx2, fy2 = face_bbox
    cx, cy = (fx1 + fx2) / 2, (fy1 + fy2) / 2
    px1, py1, px2, py2 = person_bbox
    return px1 <= cx <= px2 and py1 <= cy <= py2


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


class LuminaPipeline:
    def __init__(self, config: PipelineConfig | None = None):
        self.cfg = config or PipelineConfig()
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

    # -------------------------------------------------------- image cache
    def _build_image_cache(
        self,
        image_paths: list[Path],
        callback: ProgressCallback | None = None,
    ) -> Dict[str, np.ndarray]:
        """Load every image once, downsampling the long edge to max_image_dim.
        All subsequent steps read from this cache — zero extra disk I/O."""
        cache: Dict[str, np.ndarray] = {}
        max_dim = self.cfg.max_image_dim
        total = len(image_paths)
        for i, path in enumerate(image_paths):
            img = cv2.imread(str(path))
            if img is None:
                continue
            h, w = img.shape[:2]
            long_edge = max(h, w)
            if long_edge > max_dim:
                scale = max_dim / long_edge
                img = cv2.resize(img, (int(w * scale), int(h * scale)), interpolation=cv2.INTER_AREA)
            cache[str(path)] = img
            if callback and (i + 1) % max(1, total // 20) == 0:
                ratio = int(((i + 1) / total) * 100)
                callback("loading_models", "Loading images", 2 + int(ratio * 0.03))
        return cache

    # --------------------------------------------------------- face detection
    def _detect_faces(
        self,
        image_paths: list[Path],
        photo_ids: list[str],
        img_cache: Dict[str, np.ndarray],
        callback: ProgressCallback | None = None,
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

                # EAR
                ear = 0.5
                if hasattr(face, 'landmark_2d_106') and face.landmark_2d_106 is not None:
                    ear = compute_ear(face.landmark_2d_106) if len(face.landmark_2d_106) >= 48 else 0.5
                elif hasattr(face, 'landmark') and face.landmark is not None and len(face.landmark) >= 48:
                    ear = compute_ear(face.landmark)

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
                    "person_id": None,
                })

            if callback:
                ratio = int(((i + 1) / len(image_paths)) * 100)
                callback("face_detection", "Detecting faces", 5 + int(ratio * 0.10))

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

        if not crop_tensors:
            return []

        # Phase 2: batched GPU/CPU inference
        batch_size = self.cfg.reid_batch_size
        total_crops = len(crop_tensors)
        all_feats: list[np.ndarray] = []

        for batch_start in range(0, total_crops, batch_size):
            batch = torch.stack(crop_tensors[batch_start: batch_start + batch_size])
            if torch.cuda.is_available():
                batch = batch.cuda()
            with torch.no_grad():
                feats = self.reid_model(batch).cpu().numpy()
            all_feats.append(feats)
            if callback:
                ratio = int(min((batch_start + batch_size) / total_crops, 1.0) * 100)
                callback("reid_embedding", "Extracting body embeddings", 45 + int(ratio * 0.10))

        all_feats_np = np.concatenate(all_feats, axis=0)

        # Phase 3: write embeddings back and collect valid detections
        valid: list[dict] = []
        for j, prec_idx in enumerate(valid_indices):
            feat = all_feats_np[j]
            norm = np.linalg.norm(feat)
            person_detections[prec_idx]["reid_embedding"] = feat / (norm + 1e-12)
            valid.append(person_detections[prec_idx])

        return valid

    # -------------------------------------------------- link faces to persons
    def _link_faces_to_persons(
        self,
        person_detections: list[dict],
        face_records: list[dict],
        path_to_photo_id: dict[str, str],
    ) -> None:
        face_by_path: Dict[str, list[dict]] = {}
        for frec in face_records:
            face_by_path.setdefault(str(frec["photo_path"]), []).append(frec)

        for prec in person_detections:
            path_str = str(prec["photo_path"])
            prec["photo_id"] = path_to_photo_id.get(path_str)
            for frec in face_by_path.get(path_str, []):
                if face_center_in_box(frec["bbox"], prec["bbox"]):
                    prec["face_record"] = frec
                    break

    # ------------------------------------------------ identity clustering
    def _cluster_identities(
        self,
        person_detections: list[dict],
        face_records: list[dict],
    ) -> None:
        """Cluster by ArcFace embeddings (face identity) first.
        ReID is only used as a fallback to attach faceless persons to a known identity.
        Persons that appear only once are kept as singletons rather than discarded as noise.
        """
        face_recs_with_emb = [f for f in face_records if f.get("embedding") is not None]

        if face_recs_with_emb:
            # ── 1. Cluster face embeddings (ArcFace — the right tool for identity) ──
            face_embs = np.stack([f["embedding"] for f in face_recs_with_emb])

            if len(face_embs) == 1:
                face_recs_with_emb[0]["person_id"] = "person_0"
            else:
                # AgglomerativeClustering: cosine distance, average linkage.
                # No noise points — every face gets assigned. Distance threshold
                # is directly interpretable (cosine dist between face embeddings).
                agg = AgglomerativeClustering(
                    n_clusters=None,
                    distance_threshold=self.cfg.face_cluster_distance,
                    metric="cosine",
                    linkage="average",
                )
                labels = agg.fit_predict(face_embs)
                for frec, lbl in zip(face_recs_with_emb, labels):
                    frec["person_id"] = f"person_{int(lbl)}"

            # ── 2. Propagate face-based person_id → linked person detections ──
            for prec in person_detections:
                frec = prec.get("face_record")
                if frec is not None:
                    prec["person_id"] = frec.get("person_id")

            # ── 3. Assign faceless person detections via ReID distance ──
            # Build one ReID centroid per known identity
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

        else:
            # ── No faces at all: pure ReID clustering as last resort ──
            if not person_detections:
                return
            reid_embeddings = np.stack([r["reid_embedding"] for r in person_detections])
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

            for i, prec in enumerate(person_detections):
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
        embeddings = []
        total_batches = max(1, (len(image_paths) + self.cfg.dino_batch_size - 1) // self.cfg.dino_batch_size)

        with torch.no_grad():
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

    # --------------------------------------------------- event clustering (early-stop)
    def _cluster_events(
        self,
        dino_embeddings: np.ndarray,
        image_paths: list[Path],
        path_to_dino_idx: dict[str, int],
        person_detections: list[dict],
    ) -> dict[int, list[Path]]:
        """Agglomerative clustering on DINOv3 embeddings with silhouette-tuned threshold.
        Early-stop sweep when improvement stalls for `event_sweep_patience` steps."""
        event_paths = [p for p in image_paths if str(p) in path_to_dino_idx]
        if len(event_paths) <= 1:
            return {0: event_paths}

        event_idxs = [path_to_dino_idx[str(p)] for p in event_paths]
        X_event = dino_embeddings[event_idxs]

        thresholds = np.arange(
            self.cfg.event_sweep_start,
            self.cfg.event_sweep_stop,
            self.cfg.event_sweep_step,
        )

        best_thresh = thresholds[0]
        best_sil = -1.0
        no_improve = 0

        for thresh in thresholds:
            agg = AgglomerativeClustering(
                n_clusters=None,
                distance_threshold=float(thresh),
                metric="cosine",
                linkage="average",
            )
            lbls = agg.fit_predict(X_event)
            n_cl = len(set(lbls))
            if 2 <= n_cl < len(X_event):
                sil = _sil(X_event, lbls, metric="cosine")
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

        agg_final = AgglomerativeClustering(
            n_clusters=None,
            distance_threshold=float(best_thresh),
            metric="cosine",
            linkage="average",
        )
        final_labels = agg_final.fit_predict(X_event)

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
            try:
                with torch.no_grad():
                    scores = self.nima_metric(batch_tensor).cpu().numpy()
                for path_str, score in zip(valid_paths, np.atleast_1d(scores)):
                    nima_scores[path_str] = float(score)
            except Exception:
                # fallback: score individually (e.g. pyiqa version doesn't batch)
                for path_str, t in zip(valid_paths, tensors):
                    try:
                        with torch.no_grad():
                            score = float(self.nima_metric(t.unsqueeze(0).to(self.device)).cpu().numpy())
                        nima_scores[path_str] = score
                    except Exception:
                        nima_scores[path_str] = 0.0

            if callback:
                ratio = int(((batch_start + len(batch_paths)) / total) * 100)
                callback("aesthetic_scoring", "NIMA aesthetic scoring", 62 + int(ratio * 0.10))

        return nima_scores

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
                "det_score": 0, "pose_penalty": 0.5, "ear": 0.5,
                "face_sharpness": 0, "face_size_ratio": 0,
            }
        best = max(recs, key=lambda r: r.get("det_score", 0))
        return {
            "det_score": best.get("det_score", 0),
            "pose_penalty": best.get("pose_penalty", 0.5),
            "ear": best.get("ear", 0.5),
            "face_sharpness": best.get("face_sharpness", 0),
            "face_size_ratio": best.get("face_size_ratio", 0),
        }

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
    ) -> list[dict]:
        valid = [p for p in event_photo_paths if str(p) in path_to_dino_idx]
        if not valid:
            return []

        # Centrality
        idxs = [path_to_dino_idx[str(p)] for p in valid]
        vecs = dino_embeddings[idxs]
        centroid = vecs.mean(axis=0, keepdims=True)
        dists = np.linalg.norm(vecs - centroid, axis=1)
        centrality = 1.0 - minmax_norm(dists)

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
            pid_for_signals = persons_in_photo[0] if persons_in_photo else None
            fs = self._best_face_signals(pid_for_signals, path, person_photo_to_faces, photo_to_all_faces)
            ns = nima_scores.get(str(path), 0.0)

            rows.append({
                "photoId": photo_id,
                "centrality_raw": float(centrality[i]),
                "faceSharpness_raw": fs["face_sharpness"],
                "faceSize_raw": fs["face_size_ratio"],
                "detScore_raw": fs["det_score"],
                "poseQuality_raw": fs["pose_penalty"],
                "ear_raw": fs["ear"],
                "nimaScore_raw": ns,
                "persons": list(set(persons_in_photo)),
            })

        if not rows:
            return []

        # Min-max normalize each signal within group
        signals = ["centrality", "faceSharpness", "faceSize", "detScore", "poseQuality", "ear", "nimaScore"]
        raw_arrays = {sig: np.array([r[f"{sig}_raw"] for r in rows], dtype=np.float32) for sig in signals}
        norm_arrays = {sig: minmax_norm(raw_arrays[sig]) for sig in signals}

        members = []
        for j, row in enumerate(rows):
            final_score = float(
                self.cfg.w_centrality * norm_arrays["centrality"][j]
                + self.cfg.w_face_sharpness * norm_arrays["faceSharpness"][j]
                + self.cfg.w_face_size * norm_arrays["faceSize"][j]
                + self.cfg.w_det_score * norm_arrays["detScore"][j]
                + self.cfg.w_pose * norm_arrays["poseQuality"][j]
                + self.cfg.w_ear * norm_arrays["ear"][j]
                + self.cfg.w_nima * norm_arrays["nimaScore"][j]
            )
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
                "persons": row["persons"],
            })

        members.sort(key=lambda m: m["finalScore"], reverse=True)
        return members

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

        path_to_photo_id = {str(p): pid for p, pid in zip(image_paths, photo_ids)}
        id_to_path = {pid: p for pid, p in zip(photo_ids, image_paths)}

        # ── Step 1: Load models (0–5%) ──────────────────────────────────────
        if callback:
            callback("loading_models", "Loading models (DINO, InsightFace, YOLO, OSNet, NIMA)", 2)
        self._load_models()
        if callback:
            callback("loading_models", "Models loaded", 4)

        # ── Step 1b: Build image cache — load + downsample every image once ─
        img_cache = self._build_image_cache(image_paths, callback=callback)
        if callback:
            callback("loading_models", "Images loaded", 5)

        # ── Parallel block 1: Face detection + Person detection + DINO (5–45%) ──
        # These three stages are independent — they all read from img_cache
        # and produce separate outputs. Run them concurrently to collapse
        # ~3 sequential stages into 1 wall-clock block.
        if callback:
            callback("analyzing", "Analyzing images (faces, persons, scenes)", 5)

        with ThreadPoolExecutor(max_workers=3) as pool:
            future_faces = pool.submit(
                self._detect_faces, image_paths, photo_ids, img_cache,
            )
            future_persons = pool.submit(
                self._detect_persons, image_paths, img_cache,
            )
            future_dino = pool.submit(
                self._extract_dino_embeddings, image_paths, img_cache,
            )

            face_records, no_face_ids = future_faces.result()
            person_detections = future_persons.result()
            dino_embeddings = future_dino.result()

        path_to_dino_idx = {str(p): i for i, p in enumerate(image_paths)}

        if callback:
            callback("analyzing", "Detection & embedding complete", 45)

        # ── Step 4: ReID embeddings — batched (45–55%) ───────────────────────
        # Depends on person_detections from YOLO, so must be sequential.
        if callback:
            callback("reid_embedding", "Extracting body embeddings", 45)
        person_detections = self._extract_reid_embeddings(person_detections, img_cache, callback=callback)
        if callback:
            callback("reid_embedding", "Body embeddings extracted", 55)

        # ── Step 5: Link faces to persons + Identity clustering (55–60%) ────
        if callback:
            callback("identity_clustering", "Clustering identities", 55)
        self._link_faces_to_persons(person_detections, face_records, path_to_photo_id)
        self._cluster_identities(person_detections, face_records)
        if callback:
            callback("identity_clustering", "Identity clustering complete", 60)

        # ── Parallel block 2: Event clustering + NIMA scoring (60–72%) ──────
        # NIMA only needs img_cache; event clustering only needs embeddings.
        if callback:
            callback("clustering_scoring", "Clustering events & scoring aesthetics", 60)

        with ThreadPoolExecutor(max_workers=2) as pool:
            future_events = pool.submit(
                self._cluster_events, dino_embeddings, image_paths,
                path_to_dino_idx, person_detections,
            )
            future_nima = pool.submit(
                self._score_nima, image_paths, img_cache,
            )

            event_groups = future_events.result()
            nima_scores = future_nima.result()

        if callback:
            callback("clustering_scoring", "Events clustered & aesthetics scored", 72)

        # ── Step 9: Quality scoring per event (72–92%) ──────────────────────
        if callback:
            callback("quality_scoring", "Scoring photos per event", 72)

        # Build lookup structures
        person_photo_to_faces: Dict[tuple, list[dict]] = {}
        photo_to_all_faces: Dict[str, list[dict]] = {}
        for rec in face_records:
            photo_to_all_faces.setdefault(str(rec["photo_path"]), []).append(rec)
            if rec["person_id"] is not None:
                person_photo_to_faces.setdefault((rec["person_id"], str(rec["photo_path"])), []).append(rec)

        events_payload: list[dict] = []
        total_events = max(1, len(event_groups))

        for evt_idx, (evt_label, evt_paths) in enumerate(sorted(event_groups.items())):
            members = self._score_event_group(
                evt_paths, dino_embeddings, path_to_dino_idx,
                nima_scores, person_detections,
                person_photo_to_faces, photo_to_all_faces, path_to_photo_id,
            )
            if not members:
                continue

            event_persons = list({p for m in members for p in m.get("persons", []) if p})

            for m in members:
                m.pop("persons", None)

            top_photo_id = members[0]["photoId"]

            events_payload.append({
                "id": f"event_{evt_idx}",
                "label": f"Event {evt_idx + 1}",
                "photoIds": [m["photoId"] for m in members],
                "topPhotoId": top_photo_id,
                "persons": event_persons,
                "members": members,
            })

            if callback:
                ratio = int(((evt_idx + 1) / total_events) * 100)
                callback("quality_scoring", "Scoring photos per event", 72 + int(ratio * 0.20))

        # ── Build identities payload ────────────────────────────────────────
        identity_map: Dict[str, Dict] = {}
        for prec in person_detections:
            pid = prec.get("person_id")
            if not pid:
                continue
            if pid not in identity_map:
                identity_map[pid] = {"photoIds": set(), "eventIds": set(), "face_recs": []}
            photo_id = prec.get("photo_id")
            if photo_id:
                identity_map[pid]["photoIds"].add(photo_id)
            if prec.get("face_record"):
                identity_map[pid]["face_recs"].append(prec["face_record"])

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

            identities_payload.append({
                "id": pid,
                "label": f"Person {idx + 1}",
                "faceThumb": face_thumb,
                "photoIds": sorted(info["photoIds"]),
                "eventIds": sorted(info["eventIds"]),
            })

        # ── Step 10: Finalize (92–100%) ─────────────────────────────────────
        if callback:
            callback("finalizing", "Finalizing results", 96)

        result = {
            "summary": {
                "numPhotos": len(image_paths),
                "numEvents": len(events_payload),
                "numIdentities": len(identities_payload),
                "noFacePhotos": len(no_face_ids),
                "embeddingModel": self.dino_model_id_in_use,
                "faceModel": self.cfg.insightface_model,
                "reidModel": self.cfg.reid_model_name,
                "yoloModel": self.cfg.yolo_model,
            },
            "events": events_payload,
            "identities": identities_payload,
        }

        if callback:
            callback("completed", "Analysis complete", 100)
        return result
