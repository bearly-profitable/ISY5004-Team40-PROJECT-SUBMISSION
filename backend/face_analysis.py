"""
Comprehensive face analysis engine.

Uses MediaPipe FaceMesh (468 landmarks) for detailed facial geometry and
OpenCV for skin quality assessment.  Each detected face is scored across
seven categories (0-10 scale) and given an overall composite rating.
"""

from __future__ import annotations

import base64
import io
import math
from pathlib import Path
from typing import Any

import cv2
import numpy as np

# MediaPipe is the primary landmark engine (468 3-D landmarks per face).
import mediapipe as mp

# ---------------------------------------------------------------------------
# Landmark index groups (MediaPipe FaceMesh canonical indices)
# ---------------------------------------------------------------------------

# Face oval (silhouette)
FACE_OVAL = [
    10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288,
    397, 365, 379, 378, 400, 377, 152, 148, 176, 149, 150, 136,
    172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109,
]

# Left eye contour
LEFT_EYE = [33, 7, 163, 144, 145, 153, 154, 155, 133, 173, 157, 158, 159, 160, 161, 246]
# Right eye contour
RIGHT_EYE = [362, 382, 381, 380, 374, 373, 390, 249, 263, 466, 388, 387, 386, 385, 384, 398]

# Eyebrows
LEFT_EYEBROW = [70, 63, 105, 66, 107, 55, 65, 52, 53, 46]
RIGHT_EYEBROW = [300, 293, 334, 296, 336, 285, 295, 282, 283, 276]

# Nose bridge + tip
NOSE_BRIDGE = [168, 6, 197, 195, 5]
NOSE_TIP = [1]
NOSE_BOTTOM = [2, 98, 327]
NOSE_WINGS = [129, 358]  # left/right alar

# Lips – outer ring
LIPS_OUTER_TOP = [61, 185, 40, 39, 37, 0, 267, 269, 270, 409, 291]
LIPS_OUTER_BOTTOM = [61, 146, 91, 181, 84, 17, 314, 405, 321, 375, 291]
# Lips – inner ring
LIPS_INNER_TOP = [78, 191, 80, 81, 82, 13, 312, 311, 310, 415, 308]
LIPS_INNER_BOTTOM = [78, 95, 88, 178, 87, 14, 317, 402, 318, 324, 308]

# Jaw contour (lower face oval)
JAW = [
    234, 93, 132, 58, 172, 136, 150, 149, 176, 148, 152,
    377, 400, 378, 379, 365, 397, 288, 361, 323, 454,
]

# Symmetry pairs: (left_idx, right_idx)  – major feature pairs
SYMMETRY_PAIRS = [
    (33, 263),    # inner eye corners
    (133, 362),   # outer eye corners
    (159, 386),   # upper eyelid
    (145, 374),   # lower eyelid
    (70, 300),    # inner eyebrow
    (107, 336),   # outer eyebrow
    (61, 291),    # mouth corners
    (129, 358),   # nose wings
    (234, 454),   # jaw angles
    (58, 288),    # mid-jaw
    (172, 397),   # lower jaw
]

# Forehead reference (top of face)
FOREHEAD_TOP = 10
CHIN_BOTTOM = 152


def _dist(a: np.ndarray, b: np.ndarray) -> float:
    return float(np.linalg.norm(a - b))


def _polygon_area(pts: np.ndarray) -> float:
    """Shoelace formula for polygon area from Nx2 array."""
    x, y = pts[:, 0], pts[:, 1]
    return 0.5 * float(np.abs(np.dot(x, np.roll(y, 1)) - np.dot(y, np.roll(x, 1))))


def _clamp_score(v: float, lo: float = 0.0, hi: float = 10.0) -> float:
    return max(lo, min(hi, v))


_MODEL_DIR = Path(__file__).resolve().parent
_MODEL_PATH = _MODEL_DIR / "face_landmarker.task"


class FaceAnalyzer:
    """Stateless face analyzer.  Call ``analyze(image_path)`` to get results."""

    def __init__(self) -> None:
        self._landmarker: Any | None = None

    # ------------------------------------------------------------------
    # Lazy model loading
    # ------------------------------------------------------------------
    def _ensure_models(self) -> None:
        if self._landmarker is not None:
            return
        base_options = mp.tasks.BaseOptions(model_asset_path=str(_MODEL_PATH))
        options = mp.tasks.vision.FaceLandmarkerOptions(
            base_options=base_options,
            num_faces=10,
            min_face_detection_confidence=0.5,
            min_face_presence_confidence=0.5,
        )
        self._landmarker = mp.tasks.vision.FaceLandmarker.create_from_options(options)

    # ------------------------------------------------------------------
    # Public entry
    # ------------------------------------------------------------------
    def analyze(self, image_path: Path) -> dict:
        """Analyse *image_path* and return per-face results."""
        self._ensure_models()

        img_bgr = cv2.imread(str(image_path))
        if img_bgr is None:
            raise ValueError(f"Cannot read image: {image_path}")

        h, w = img_bgr.shape[:2]
        img_rgb = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2RGB)

        # Use the new tasks API
        mp_image = mp.Image(image_format=mp.ImageFormat.SRGB, data=img_rgb)
        results = self._landmarker.detect(mp_image)

        if not results.face_landmarks:
            return {"imageWidth": w, "imageHeight": h, "faces": []}

        faces: list[dict] = []
        for idx, face_lm_list in enumerate(results.face_landmarks):
            # Convert normalised landmarks → pixel coords (Nx2)
            lm = np.array(
                [[pt.x * w, pt.y * h] for pt in face_lm_list],
                dtype=np.float64,
            )

            # Bounding box from face oval
            oval_pts = lm[FACE_OVAL]
            x1, y1 = oval_pts.min(axis=0)
            x2, y2 = oval_pts.max(axis=0)

            # Expand bbox by 25 % for crop
            bw, bh = x2 - x1, y2 - y1
            pad_x, pad_y = bw * 0.25, bh * 0.25
            cx1 = max(0, int(x1 - pad_x))
            cy1 = max(0, int(y1 - pad_y))
            cx2 = min(w, int(x2 + pad_x))
            cy2 = min(h, int(y2 + pad_y))
            crop = img_bgr[cy1:cy2, cx1:cx2]

            # Encode face crop as base64 JPEG
            _, buf = cv2.imencode(".jpg", crop, [cv2.IMWRITE_JPEG_QUALITY, 90])
            face_b64 = "data:image/jpeg;base64," + base64.b64encode(buf).decode()

            # --- Compute metrics ---
            metrics: dict[str, float] = {}
            metrics["symmetry"] = self._score_symmetry(lm, w)
            metrics["proportions"] = self._score_proportions(lm)
            metrics["skinQuality"] = self._score_skin(crop)
            metrics["eyeScore"] = self._score_eyes(lm)
            metrics["noseScore"] = self._score_nose(lm)
            metrics["lipScore"] = self._score_lips(lm)
            metrics["jawlineScore"] = self._score_jawline(lm)

            # Weighted overall
            weights = {
                "symmetry": 0.18,
                "proportions": 0.18,
                "skinQuality": 0.14,
                "eyeScore": 0.15,
                "noseScore": 0.10,
                "lipScore": 0.10,
                "jawlineScore": 0.15,
            }
            raw = sum(metrics[k] * weights[k] for k in weights)
            metrics["overall"] = round(raw, 1)

            # Round sub-scores
            for k in metrics:
                metrics[k] = round(metrics[k], 1)

            faces.append({
                "faceIndex": idx,
                "bbox": [int(x1), int(y1), int(x2), int(y2)],
                "faceCrop": face_b64,
                "metrics": metrics,
            })

        return {"imageWidth": w, "imageHeight": h, "faces": faces}

    # ------------------------------------------------------------------
    # Scoring helpers (each returns 0-10)
    # ------------------------------------------------------------------

    def _score_symmetry(self, lm: np.ndarray, img_w: float) -> float:
        """Bilateral symmetry – compares distances of paired landmarks from
        the vertical midline (nose bridge axis)."""
        # Midline defined by nose bridge landmarks
        top = lm[FOREHEAD_TOP]
        bottom = lm[CHIN_BOTTOM]
        midline_x = (top[0] + bottom[0]) / 2.0

        deviations: list[float] = []
        for li, ri in SYMMETRY_PAIRS:
            dl = abs(lm[li][0] - midline_x)
            dr = abs(lm[ri][0] - midline_x)
            if max(dl, dr) < 1e-6:
                continue
            ratio = min(dl, dr) / max(dl, dr)
            deviations.append(ratio)

            # Also compare vertical positions
            dy = abs(lm[li][1] - lm[ri][1])
            face_h = _dist(top, bottom)
            if face_h > 0:
                vert_ratio = 1.0 - (dy / face_h)
                deviations.append(max(0, vert_ratio))

        if not deviations:
            return 5.0

        avg = float(np.mean(deviations))
        # Map [0.7 .. 1.0] → [0 .. 10]  (anything < 0.7 is extreme asymmetry)
        score = ((avg - 0.70) / 0.30) * 10.0
        return _clamp_score(score)

    def _score_proportions(self, lm: np.ndarray) -> float:
        """Golden-ratio based facial proportions."""
        PHI = 1.618

        top = lm[FOREHEAD_TOP]
        chin = lm[CHIN_BOTTOM]
        face_h = _dist(top, chin)
        if face_h < 1:
            return 5.0

        # Face width at cheekbones (jaw angles)
        face_w = _dist(lm[234], lm[454])

        scores: list[float] = []

        # 1. Face height / width  – ideal close to PHI (~1.618)
        hw_ratio = face_h / max(face_w, 1)
        scores.append(10.0 - min(abs(hw_ratio - PHI) * 8, 10))

        # 2. "Rule of thirds" – face divided into 3 equal vertical zones
        #    hairline→brow, brow→nose base, nose base→chin
        brow_mid = (lm[LEFT_EYEBROW[0]][1] + lm[RIGHT_EYEBROW[0]][1]) / 2
        nose_base_y = lm[NOSE_BOTTOM[0]][1]
        third1 = brow_mid - top[1]
        third2 = nose_base_y - brow_mid
        third3 = chin[1] - nose_base_y
        total = third1 + third2 + third3
        if total > 0:
            ideal = total / 3
            devs = [abs(t - ideal) / ideal for t in [third1, third2, third3]]
            avg_dev = float(np.mean(devs))
            scores.append(10.0 - min(avg_dev * 20, 10))

        # 3. Eye spacing / face width  – ideal ~0.30-0.33
        eye_l = (lm[33] + lm[133]) / 2  # left eye centre
        eye_r = (lm[263] + lm[362]) / 2  # right eye centre
        eye_dist = _dist(eye_l, eye_r)
        eye_ratio = eye_dist / max(face_w, 1)
        scores.append(10.0 - min(abs(eye_ratio - 0.32) * 40, 10))

        # 4. Nose width / face width – ideal ~0.20-0.25
        nose_w = _dist(lm[NOSE_WINGS[0]], lm[NOSE_WINGS[1]])
        nose_ratio = nose_w / max(face_w, 1)
        scores.append(10.0 - min(abs(nose_ratio - 0.22) * 40, 10))

        # 5. Lip width / face width – ideal ~0.38-0.50
        lip_w = _dist(lm[61], lm[291])
        lip_ratio = lip_w / max(face_w, 1)
        scores.append(10.0 - min(abs(lip_ratio - 0.42) * 25, 10))

        return _clamp_score(float(np.mean(scores)))

    def _score_skin(self, crop: np.ndarray) -> float:
        """Skin quality from the face crop: smoothness + evenness."""
        if crop.size == 0:
            return 5.0

        h, w = crop.shape[:2]
        # Centre region (inner 60 %) to avoid hair/background
        y1, y2 = int(h * 0.2), int(h * 0.8)
        x1, x2 = int(w * 0.2), int(w * 0.8)
        roi = crop[y1:y2, x1:x2]
        if roi.size == 0:
            return 5.0

        gray = cv2.cvtColor(roi, cv2.COLOR_BGR2GRAY)

        # 1. Smoothness: lower Laplacian variance → smoother skin → higher score
        lap_var = cv2.Laplacian(gray, cv2.CV_64F).var()
        # Typical range: very smooth ~20, textured ~300+
        smoothness = 10.0 - min(lap_var / 40.0, 10.0)

        # 2. Evenness: convert to LAB, measure std-dev of L and A channels
        lab = cv2.cvtColor(roi, cv2.COLOR_BGR2LAB).astype(np.float32)
        l_std = float(np.std(lab[:, :, 0]))
        a_std = float(np.std(lab[:, :, 1]))
        # Lower std → more even → higher score
        evenness = 10.0 - min((l_std + a_std) / 20.0, 10.0)

        # 3. Clarity (local contrast via CLAHE entropy proxy)
        clahe = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(4, 4))
        enhanced = clahe.apply(gray)
        clarity_diff = float(np.mean(np.abs(enhanced.astype(float) - gray.astype(float))))
        clarity = min(clarity_diff / 5.0, 10.0)

        score = 0.40 * smoothness + 0.35 * evenness + 0.25 * clarity
        return _clamp_score(score)

    def _score_eyes(self, lm: np.ndarray) -> float:
        """Eye attractiveness: size, openness, tilt, symmetry."""
        scores: list[float] = []

        # Eye opening (height / width ratio)
        for eye_idx in [LEFT_EYE, RIGHT_EYE]:
            pts = lm[eye_idx]
            ew = _dist(pts[0], pts[8]) if len(pts) > 8 else _dist(pts[0], pts[-1])
            # Approximate height from upper to lower lid midpoints
            upper = pts[len(pts) // 4]
            lower = pts[3 * len(pts) // 4]
            eh = _dist(upper, lower)
            if ew > 0:
                ratio = eh / ew
                # Ideal eye opening ratio ~0.28-0.35
                scores.append(10.0 - min(abs(ratio - 0.32) * 50, 10))

        # Eye size relative to face
        face_w = _dist(lm[234], lm[454])
        left_ew = _dist(lm[33], lm[133])
        right_ew = _dist(lm[263], lm[362])
        avg_ew = (left_ew + right_ew) / 2
        eye_size_ratio = avg_ew / max(face_w, 1)
        # Ideal ~0.22-0.28
        scores.append(10.0 - min(abs(eye_size_ratio - 0.25) * 50, 10))

        # Canthal tilt (positive = attractive upward tilt)
        for inner, outer in [(33, 133), (362, 263)]:
            dx = lm[outer][0] - lm[inner][0]
            dy = lm[inner][1] - lm[outer][1]  # positive if outer is higher
            if abs(dx) > 1:
                tilt_deg = math.degrees(math.atan2(dy, abs(dx)))
                # Ideal: slight positive tilt 3-8°
                scores.append(10.0 - min(abs(tilt_deg - 5) * 1.2, 10))

        # Eye symmetry
        left_area = _polygon_area(lm[LEFT_EYE])
        right_area = _polygon_area(lm[RIGHT_EYE])
        if max(left_area, right_area) > 0:
            sym = min(left_area, right_area) / max(left_area, right_area)
            scores.append(sym * 10.0)

        return _clamp_score(float(np.mean(scores)) if scores else 5.0)

    def _score_nose(self, lm: np.ndarray) -> float:
        """Nose proportions and straightness."""
        top = lm[FOREHEAD_TOP]
        chin = lm[CHIN_BOTTOM]
        face_h = _dist(top, chin)
        face_w = _dist(lm[234], lm[454])
        if face_h < 1 or face_w < 1:
            return 5.0

        scores: list[float] = []

        # Nose length / face height – ideal ~0.30-0.36
        nose_top = lm[168]  # bridge top
        nose_tip = lm[1]
        nose_len = _dist(nose_top, nose_tip)
        len_ratio = nose_len / face_h
        scores.append(10.0 - min(abs(len_ratio - 0.33) * 50, 10))

        # Nose width / face width – ideal ~0.20-0.25
        nose_w = _dist(lm[NOSE_WINGS[0]], lm[NOSE_WINGS[1]])
        w_ratio = nose_w / face_w
        scores.append(10.0 - min(abs(w_ratio - 0.22) * 40, 10))

        # Nose straightness (deviation of bridge from midline)
        midline_x = (top[0] + chin[0]) / 2
        bridge_pts = lm[NOSE_BRIDGE]
        deviations = [abs(pt[0] - midline_x) for pt in bridge_pts]
        avg_dev = float(np.mean(deviations))
        straightness = 10.0 - min((avg_dev / face_w) * 80, 10)
        scores.append(straightness)

        # Nose width / nose length ratio – ideal ~0.60-0.75
        nl_ratio = nose_w / max(nose_len, 1)
        scores.append(10.0 - min(abs(nl_ratio - 0.67) * 25, 10))

        return _clamp_score(float(np.mean(scores)))

    def _score_lips(self, lm: np.ndarray) -> float:
        """Lip fullness, ratio, and proportions."""
        face_w = _dist(lm[234], lm[454])
        if face_w < 1:
            return 5.0

        scores: list[float] = []

        # Lip width / face width – ideal ~0.38-0.50
        lip_w = _dist(lm[61], lm[291])
        ratio = lip_w / face_w
        scores.append(10.0 - min(abs(ratio - 0.45) * 30, 10))

        # Upper lip height (center)
        upper_top = lm[0]   # centre upper outer
        upper_bot = lm[13]  # centre upper inner
        upper_h = _dist(upper_top, upper_bot)

        # Lower lip height (center)
        lower_top = lm[14]  # centre lower inner
        lower_bot = lm[17]  # centre lower outer
        lower_h = _dist(lower_top, lower_bot)

        total_h = upper_h + lower_h
        if total_h > 0:
            # Upper:lower ratio – ideal ~0.40:0.60 (1:1.5)
            upper_ratio = upper_h / total_h
            scores.append(10.0 - min(abs(upper_ratio - 0.40) * 40, 10))

        # Lip fullness relative to face width
        fullness = total_h / max(face_w, 1)
        # Ideal ~0.08-0.14
        scores.append(10.0 - min(abs(fullness - 0.11) * 80, 10))

        # Cupid's bow definition (vertical dip at centre top of upper lip)
        left_peak = lm[37]
        right_peak = lm[267]
        center_dip = lm[0]
        avg_peak_y = (left_peak[1] + right_peak[1]) / 2
        dip_depth = center_dip[1] - avg_peak_y  # positive = dip exists
        if lip_w > 0:
            dip_ratio = dip_depth / lip_w
            # Ideal: slight dip ~0.01-0.05
            scores.append(10.0 - min(abs(dip_ratio - 0.03) * 150, 10))

        return _clamp_score(float(np.mean(scores)) if scores else 5.0)

    def _score_jawline(self, lm: np.ndarray) -> float:
        """Jawline definition, face taper, and chin proportion."""
        face_w = _dist(lm[234], lm[454])
        top = lm[FOREHEAD_TOP]
        chin = lm[CHIN_BOTTOM]
        face_h = _dist(top, chin)
        if face_h < 1 or face_w < 1:
            return 5.0

        scores: list[float] = []

        # Jaw angle width / cheekbone width – ideal ~0.75-0.85 (slight taper)
        jaw_w = _dist(lm[172], lm[397])
        taper = jaw_w / face_w
        scores.append(10.0 - min(abs(taper - 0.80) * 25, 10))

        # Chin width / face width – ideal ~0.35-0.45
        chin_w = _dist(lm[150], lm[379])
        chin_ratio = chin_w / face_w
        scores.append(10.0 - min(abs(chin_ratio - 0.40) * 30, 10))

        # Jawline smoothness – measure angular deviation along jaw contour
        jaw_pts = lm[JAW]
        if len(jaw_pts) >= 3:
            angles: list[float] = []
            for i in range(1, len(jaw_pts) - 1):
                v1 = jaw_pts[i] - jaw_pts[i - 1]
                v2 = jaw_pts[i + 1] - jaw_pts[i]
                dot = float(np.dot(v1, v2))
                norms = np.linalg.norm(v1) * np.linalg.norm(v2)
                if norms > 0:
                    cos_a = np.clip(dot / norms, -1, 1)
                    angles.append(abs(math.degrees(math.acos(cos_a)) - 180))
            if angles:
                avg_angle = float(np.mean(angles))
                # Lower deviation → smoother → higher score
                smoothness = 10.0 - min(avg_angle / 3.0, 10)
                scores.append(smoothness)

        # Jaw symmetry
        midline_x = (top[0] + chin[0]) / 2
        left_jaw = lm[JAW[:len(JAW) // 2]]
        right_jaw = lm[JAW[len(JAW) // 2:]]
        l_dists = [abs(p[0] - midline_x) for p in left_jaw]
        r_dists = [abs(p[0] - midline_x) for p in right_jaw]
        if l_dists and r_dists:
            avg_l = float(np.mean(l_dists))
            avg_r = float(np.mean(r_dists))
            if max(avg_l, avg_r) > 0:
                sym = min(avg_l, avg_r) / max(avg_l, avg_r)
                scores.append(sym * 10.0)

        return _clamp_score(float(np.mean(scores)) if scores else 5.0)
