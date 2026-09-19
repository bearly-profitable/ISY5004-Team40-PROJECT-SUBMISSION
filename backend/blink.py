"""Blink detection via MediaPipe FaceLandmarker blendshapes.

Geometric EAR from InsightFace's regularised 68 3D landmarks cannot separate
relaxed closed eyes from open ones (measured ~0.199 closed vs ~0.209 open on
real photos). MediaPipe's face_landmarker.task ships a *trained* blendshape
head whose eyeBlinkLeft/eyeBlinkRight scores are a direct blink classifier —
that is what the scoring pipeline uses, with geometric EAR as the fallback
when MediaPipe finds no matching face.
"""
from __future__ import annotations

from pathlib import Path
from typing import Any, Dict, List, Optional

import numpy as np

_MODEL_PATH = Path(__file__).resolve().parent / "face_landmarker.task"


class BlinkDetector:
    """One FaceLandmarker call per image -> per-face eyes-open scores."""

    def __init__(self):
        self._landmarker: Any | None = None
        self._failed = False

    def _ensure_loaded(self) -> bool:
        if self._landmarker is not None:
            return True
        if self._failed or not _MODEL_PATH.is_file():
            self._failed = True
            return False
        try:
            import mediapipe as mp

            options = mp.tasks.vision.FaceLandmarkerOptions(
                base_options=mp.tasks.BaseOptions(model_asset_path=str(_MODEL_PATH)),
                num_faces=10,
                output_face_blendshapes=True,
                min_face_detection_confidence=0.4,
            )
            self._landmarker = mp.tasks.vision.FaceLandmarker.create_from_options(options)
            self._mp = mp
            return True
        except Exception as exc:
            print(f"[Lumina] BlinkDetector unavailable ({exc}); falling back to geometric EAR.")
            self._failed = True
            return False

    def detect(self, img_rgb: np.ndarray) -> List[Dict]:
        """Returns [{"bbox": [x1,y1,x2,y2] px, "eyes_open": 0..1}] per face.

        eyes_open = 1 - max(eyeBlinkLeft, eyeBlinkRight); a hard blink scores
        near 0, wide-open eyes near 1.
        """
        if not self._ensure_loaded():
            return []
        try:
            mp_image = self._mp.Image(image_format=self._mp.ImageFormat.SRGB,
                                      data=np.ascontiguousarray(img_rgb))
            result = self._landmarker.detect(mp_image)
        except Exception:
            return []

        h, w = img_rgb.shape[:2]
        faces: List[Dict] = []
        landmarks_list = result.face_landmarks or []
        blendshapes_list = result.face_blendshapes or []
        for i, landmarks in enumerate(landmarks_list):
            xs = [lm.x for lm in landmarks]
            ys = [lm.y for lm in landmarks]
            bbox = [min(xs) * w, min(ys) * h, max(xs) * w, max(ys) * h]

            eyes_open: Optional[float] = None
            if i < len(blendshapes_list):
                blink = 0.0
                for category in blendshapes_list[i]:
                    if category.category_name in ("eyeBlinkLeft", "eyeBlinkRight"):
                        blink = max(blink, float(category.score))
                eyes_open = float(np.clip(1.0 - blink, 0.0, 1.0))
            if eyes_open is not None:
                faces.append({"bbox": bbox, "eyes_open": eyes_open})
        return faces


def match_eyes_open(face_bbox: List[float], mp_faces: List[Dict]) -> Optional[float]:
    """eyes_open of the MediaPipe face whose centre falls inside face_bbox
    (closest centre wins when several qualify)."""
    fx1, fy1, fx2, fy2 = face_bbox
    fcx, fcy = (fx1 + fx2) / 2, (fy1 + fy2) / 2
    best, best_dist = None, float("inf")
    for mp_face in mp_faces:
        mx1, my1, mx2, my2 = mp_face["bbox"]
        mcx, mcy = (mx1 + mx2) / 2, (my1 + my2) / 2
        # Centres must be mutually contained-ish for a match
        if not (fx1 <= mcx <= fx2 and fy1 <= mcy <= fy2):
            continue
        dist = (mcx - fcx) ** 2 + (mcy - fcy) ** 2
        if dist < best_dist:
            best_dist = dist
            best = mp_face["eyes_open"]
    return best
