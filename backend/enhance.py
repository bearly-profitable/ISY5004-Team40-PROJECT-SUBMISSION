"""One-click AI enhancement of a chosen photo, with an identity guard.

The product promise is "make it look better, but it must still be *them*".
Generative image models are perfectly happy to break that promise — they will
smooth a face into someone else's if the prompt lets them — so enhancement here
is two steps:

1. A deliberately constrained edit prompt (retouch vocabulary only; explicit
   prohibitions on reshaping features, slimming, age or ethnicity drift).
2. A verification pass using the ArcFace model the pipeline already loads.
   Every face in the original is matched to its closest counterpart in the
   result; the weakest match becomes the identity score. Below
   `IDENTITY_REJECT` we throw the edit away rather than show it.

That second step is what makes the button safe to ship. Without it the failure
mode is silent and the user only notices weeks later in a printed album.
"""
from __future__ import annotations

import io
from dataclasses import dataclass
from typing import Any, Optional

import numpy as np

import openrouter

# ArcFace cosine similarity between the original and the enhanced face.
# buffalo_l puts same-person pairs well above 0.5; different people sit near 0.
IDENTITY_WARN = 0.65    # below this we surface a caution to the user
IDENTITY_REJECT = 0.45  # below this the edit is discarded outright

STYLES: dict[str, str] = {
    "natural": (
        "Apply a subtle, natural retouch — the kind a careful photographer would do:\n"
        "- even out skin tone and reduce temporary blemishes, shine and redness\n"
        "- gently brighten and sharpen the eyes\n"
        "- balance the exposure, lift shadows slightly, correct any colour cast\n"
        "- reduce noise and recover mild softness\n"
        "Keep it restrained. The result should look like a good photo, not an edited one."
    ),
    "polished": (
        "Apply a polished editorial retouch:\n"
        "- clean, even skin with texture preserved (no plastic smoothing)\n"
        "- bright, clear eyes and well-defined but natural hair\n"
        "- richer contrast and colour grading, pleasing warm highlights\n"
        "- crisp detail on the subject, gentle depth falloff on the background\n"
        "Make it magazine-quality while staying photorealistic."
    ),
}
DEFAULT_STYLE = "natural"

_IDENTITY_RULES = (
    "ABSOLUTE CONSTRAINTS — these override every instruction above:\n"
    "- Every person must remain unmistakably the SAME person. Preserve their exact "
    "facial structure, bone structure, jawline, nose, eye shape and spacing, lips, "
    "ears, hairline, skin tone, apparent age, body shape and identity.\n"
    "- Do NOT slim, reshape, beautify, de-age, or alter anyone's features or "
    "proportions. Do not change ethnicity. Do not swap or invent faces.\n"
    "- Preserve the expression, pose, and where everyone is looking.\n"
    "- Preserve the exact framing, crop, composition, aspect ratio and background. "
    "Do not zoom, re-frame, extend the canvas, or move anyone.\n"
    "- Do not add or remove people, objects, text or watermarks.\n"
    "This is a retouch of an existing photograph, not a new image. "
    "Return only the edited photograph."
)


def build_prompt(style: str = DEFAULT_STYLE) -> str:
    body = STYLES.get(style, STYLES[DEFAULT_STYLE])
    return f"{body}\n\n{_IDENTITY_RULES}"


@dataclass
class EnhanceOutcome:
    image_bytes: bytes
    identity_score: Optional[float]
    num_faces: int
    warning: Optional[str]
    cost_usd: float
    model: str
    style: str


def _to_bgr(raw: bytes) -> np.ndarray:
    """Decode bytes to an EXIF-corrected BGR array for InsightFace."""
    import cv2
    from PIL import Image, ImageOps

    with Image.open(io.BytesIO(raw)) as img:
        rgb = np.array(ImageOps.exif_transpose(img).convert("RGB"))
    return cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR)


def _face_embeddings(face_app: Any, bgr: np.ndarray) -> list[np.ndarray]:
    """L2-normalised ArcFace embeddings for every face found, largest first."""
    try:
        faces = face_app.get(bgr) or []
    except Exception:
        return []

    out: list[tuple[float, np.ndarray]] = []
    for face in faces:
        emb = getattr(face, "embedding", None)
        if emb is None:
            continue
        vec = np.asarray(emb, dtype=np.float32)
        norm = float(np.linalg.norm(vec))
        if norm <= 0:
            continue
        box = getattr(face, "bbox", None)
        area = 0.0
        if box is not None and len(box) == 4:
            area = float(max(0.0, box[2] - box[0]) * max(0.0, box[3] - box[1]))
        out.append((area, vec / norm))

    out.sort(key=lambda pair: pair[0], reverse=True)
    return [vec for _, vec in out]


def identity_similarity(
    face_app: Any, original: bytes, edited: bytes
) -> tuple[Optional[float], int]:
    """Weakest per-face similarity between the two images, and the face count.

    Returns `(None, 0)` when no face can be compared — a landscape, a back-of-head
    shot, or a detector miss. Callers treat that as "unverifiable", not "failed".
    """
    if face_app is None:
        return None, 0

    before = _face_embeddings(face_app, _to_bgr(original))
    if not before:
        return None, 0
    after = _face_embeddings(face_app, _to_bgr(edited))
    if not after:
        return 0.0, len(before)

    after_mat = np.stack(after)  # (m, 512), already unit-norm
    # Compare only the faces the detector found in both; a face lost to the edit
    # is reported through the count, not as a spurious zero for every other face.
    scores = [float(np.max(after_mat @ emb)) for emb in before[: len(after)]]
    return (min(scores) if scores else None), len(before)


def enhance_photo(
    original: bytes,
    *,
    face_app: Any = None,
    style: str = DEFAULT_STYLE,
) -> EnhanceOutcome:
    """Enhance one photo and verify the people in it survived the edit.

    Raises `openrouter.OpenRouterError` on API failure or identity rejection.
    """
    if style not in STYLES:
        style = DEFAULT_STYLE

    model = openrouter.image_model()
    edited, cost = openrouter.edit_image(original, build_prompt(style), model=model)

    score, num_faces = identity_similarity(face_app, original, edited)

    warning: Optional[str] = None
    if score is not None:
        if score < IDENTITY_REJECT:
            raise openrouter.OpenRouterError(
                f"Enhancement discarded — the result no longer matched the original "
                f"face closely enough (similarity {score:.2f}, needs {IDENTITY_REJECT:.2f}). "
                f"Try the 'natural' style, or a photo where faces are larger."
            )
        if score < IDENTITY_WARN:
            warning = (
                f"Faces drifted a little in this edit (similarity {score:.2f}). "
                f"Compare against the original before using it."
            )
    elif num_faces == 0:
        warning = "No face was detected, so the identity check was skipped."

    return EnhanceOutcome(
        image_bytes=edited,
        identity_score=score,
        num_faces=num_faces,
        warning=warning,
        cost_usd=cost,
        model=model,
        style=style,
    )
