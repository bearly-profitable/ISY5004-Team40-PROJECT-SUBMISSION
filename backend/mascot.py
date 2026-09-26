"""Lumi — Lumina's mascot, as a library of posed sprites.

Lumi replaced 小黑, the procedural stagehand this module's predecessor drew in
code. Lumi is a rendered character rather than a silhouette, so the poses are
pre-made sprites in ``assets/lumi/`` (generated once, offline, by the scripts in
``tools/mascot/``). Nothing here calls a model: picking and drawing a pose is a
dictionary lookup and a resize.

Which pose appears where is the album's job. A chapter divider or a page of
photos gets the pose that matches its scene (``pose_for_scene``), so a beach
chapter shows Lumi with sunglasses and a swim ring, and a birthday page shows
Lumi holding a cake. Scenes come from the pipeline's zero-shot CLIP labels.
"""
from __future__ import annotations

import json
import math
from collections import Counter
from functools import lru_cache
from pathlib import Path
from typing import Iterable, Optional

import numpy as np
from PIL import Image

ASSETS = Path(__file__).resolve().parent / "assets" / "lumi"

#: Every pose, and what Lumi is doing in it.
POSES: dict[str, str] = {
    # States, for the app's own screens.
    "wave": "Waving hello.",
    "idle": "Standing, waiting.",
    "think": "Thinking it over.",
    "search": "Peering through a magnifying glass.",
    "sleepy": "Nodding off.",
    "sad": "Holding a crumpled photo.",
    # The album's jobs.
    "carry": "Carrying a stack of prints to the next chapter.",
    "hang": "Pegging a polaroid to the line.",
    "point": "Pointing out the thing worth looking at.",
    "present": "Holding up a blank sign.",
    "tag": "Handing out a name tag.",
    "celebrate": "Jumping for joy in confetti.",
    "camera": "Taking a photo.",
    "sort": "Sorting photos into piles.",
    "star": "Holding up a golden star.",
    "hug": "Hugging a heart.",
    # Scenes.
    "wedding": "In a bow tie, with a bouquet.",
    "birthday": "In a party hat, with a cake.",
    "graduation": "In a mortarboard, with a diploma.",
    "christmas": "In a santa hat, with a gift.",
    "beach": "In sunglasses, with a swim ring.",
    "hiking": "With a backpack and walking stick.",
    "cafe": "With a cup of coffee.",
    "dinner": "With a bowl of noodles.",
    "travel": "With a suitcase and map.",
    "garden": "Watering a flower.",
    "shopping": "Carrying shopping bags.",
    "night": "Waving a lightstick under the moon.",
    "home": "Hugging a cushion.",
    "meeting": "With a clipboard.",
}
DEFAULT_POSE = "idle"

#: CLIP's event labels (``clip_search.EVENT_PROMPT_BANK``) to the pose that fits.
SCENE_POSES: dict[str, str] = {
    "Wedding": "wedding",
    "Birthday": "birthday",
    "Party": "celebrate",
    "Graduation": "graduation",
    "Christmas": "christmas",
    "Cafe": "cafe",
    "Breakfast": "cafe",
    "Dinner": "dinner",
    "Hawker Meal": "dinner",
    "Picnic": "garden",
    "Beach": "beach",
    "Pool": "beach",
    "Hiking": "hiking",
    "Camping": "hiking",
    "Travel": "travel",
    "Street": "travel",
    "Museum": "travel",
    "Garden": "garden",
    "At Home": "home",
    "Family Gathering": "hug",
    "Shopping": "shopping",
    "Meeting": "meeting",
    "Night Out": "night",
    "Concert": "night",
    "Sports": "celebrate",
    "Selfie Session": "camera",
}

#: For pages whose scene has no pose of its own, cycled so neighbours differ.
WORK_POSES = ("carry", "hang", "point", "camera", "star", "sort")


def pose_for_scene(label: Optional[str]) -> Optional[str]:
    """The pose for an event label, matched loosely: renamed events often keep
    the scene word ("Beach day at Sentosa" still reads as Beach)."""
    if not label:
        return None
    if label in SCENE_POSES:
        return SCENE_POSES[label]
    lowered = label.lower()
    for scene, pose in SCENE_POSES.items():
        if scene.lower() in lowered:
            return pose
    return None


def pose_for_page(scenes: Iterable[str], index: int, *,
                  fallback: Optional[str] = None, avoid: Optional[str] = None) -> str:
    """The pose for a page, from its photos' scene labels.

    The most common scene that has a pose wins; `fallback` (the chapter's label)
    is used only when no photo has one. `avoid` is the previous page's pose, so
    a run of pages from one event does not show the same Lumi over and over —
    the next-best scene is used, or a work pose by position.
    """
    ranked = [pose for pose, _ in Counter(
        p for p in (pose_for_scene(s) for s in scenes) if p).most_common()]
    if not ranked and (chapter := pose_for_scene(fallback)):
        ranked = [chapter]
    for pose in ranked:
        if pose != avoid:
            return pose
    work = WORK_POSES[index % len(WORK_POSES)]
    return work if work != avoid else WORK_POSES[(index + 1) % len(WORK_POSES)]


# ---------------------------------------------------------------------------
# Outfits
# ---------------------------------------------------------------------------
# Colourways rather than costumes: a hue rotation of the whole sprite, so every
# pose exists in every outfit without a second set of drawings.

#: key -> (name, hue shift in degrees, saturation multiplier)
OUTFITS: dict[str, tuple[str, float, float]] = {
    "classic": ("Classic", 0.0, 1.0),
    "mint": ("Mint", -120.0, 1.0),
    "honey": ("Honey", 25.0, 1.0),
    "ocean": ("Ocean", 210.0, 1.0),
}
DEFAULT_OUTFIT = "classic"


def _filter_matrix(shift: float, sat: float) -> np.ndarray:
    """CSS ``hue-rotate(shift) saturate(sat)`` as one 3x3 matrix — the same maths
    the browser uses, so the web UI can dress Lumi with a CSS filter and match
    the PDF exactly."""
    a = math.radians(shift)
    cos, sin = math.cos(a), math.sin(a)
    hue = np.array([
        [0.213 + cos * 0.787 - sin * 0.213, 0.715 - cos * 0.715 - sin * 0.715,
         0.072 - cos * 0.072 + sin * 0.928],
        [0.213 - cos * 0.213 + sin * 0.143, 0.715 + cos * 0.285 + sin * 0.140,
         0.072 - cos * 0.072 - sin * 0.283],
        [0.213 - cos * 0.213 - sin * 0.787, 0.715 - cos * 0.715 + sin * 0.715,
         0.072 + cos * 0.928 + sin * 0.072],
    ])
    saturate = np.array([
        [0.213 + 0.787 * sat, 0.715 - 0.715 * sat, 0.072 - 0.072 * sat],
        [0.213 - 0.213 * sat, 0.715 + 0.285 * sat, 0.072 - 0.072 * sat],
        [0.213 - 0.213 * sat, 0.715 - 0.715 * sat, 0.072 + 0.928 * sat],
    ])
    return saturate @ hue          # CSS applies filters left to right


def _recolour(img: Image.Image, outfit: str) -> Image.Image:
    _, shift, sat = OUTFITS.get(outfit, OUTFITS[DEFAULT_OUTFIT])
    if shift == 0.0 and sat == 1.0:
        return img
    rgba = np.asarray(img).astype(np.float32)
    rgb = np.clip(rgba[..., :3] @ _filter_matrix(shift, sat).T, 0.0, 255.0)
    out = np.dstack([rgb, rgba[..., 3]])
    return Image.fromarray(out.round().astype(np.uint8))


# ---------------------------------------------------------------------------
# Rendering
# ---------------------------------------------------------------------------

@lru_cache(maxsize=64)
def sprite(pose: str) -> Image.Image:
    """The pose's sprite at full size. Unknown poses fall back to the default."""
    path = ASSETS / f"{pose if pose in POSES else DEFAULT_POSE}.webp"
    with Image.open(path) as img:
        return img.convert("RGBA")


@lru_cache(maxsize=256)
def render(pose: str, width: int, height: int, outfit: str = DEFAULT_OUTFIT,
           facing: int = 1) -> Image.Image:
    """Lumi in `pose`, fitted inside `width` x `height` and standing on its bottom
    edge, centred. `facing=-1` mirrors the sprite, so Lumi can face into a page."""
    art = sprite(pose)
    scale = min(width / art.width, height / art.height)
    size = (max(1, round(art.width * scale)), max(1, round(art.height * scale)))
    # Recolour after the resize: the per-pixel HSV pass scales with pixel count.
    art = _recolour(art.resize(size, Image.LANCZOS), outfit)
    if facing < 0:
        art = art.transpose(Image.FLIP_LEFT_RIGHT)
    canvas = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    canvas.paste(art, ((width - size[0]) // 2, height - size[1]), art)
    return canvas


# ---------------------------------------------------------------------------
# Frames: Lumi hugging, holding or peeking around a photo
# ---------------------------------------------------------------------------
# Each frame sprite was drawn around a placeholder card that became a window
# (tools/mascot/phase3_frames.py). frames.json records, per pose, the sprite's
# size, the window's bounding box and its outline, all in sprite pixels. The
# album puts the photo in the window and draws Lumi on top, so the paws really
# do overlap the photo's edges.

FRAMES = ASSETS / "frames"


@lru_cache(maxsize=1)
def frame_meta() -> dict[str, dict]:
    try:
        return json.loads((FRAMES / "frames.json").read_text())
    except (OSError, ValueError):
        return {}


def frame_poses() -> tuple[str, ...]:
    return tuple(frame_meta())


@lru_cache(maxsize=16)
def frame_sprite(pose: str) -> Image.Image:
    with Image.open(FRAMES / f"{pose}.webp") as img:
        return img.convert("RGBA")


def frame_fit(pose: str, box_w: float, box_h: float) -> tuple[float, float, float]:
    """(scale, drawn width, drawn height) of the frame fitted inside a box."""
    w, h = frame_meta()[pose]["size"]
    scale = min(box_w / w, box_h / h)
    return scale, w * scale, h * scale


def pick_frame(box_w: float, box_h: float, avoid: Optional[str] = None) -> Optional[str]:
    """The frame that suits a box of this shape.

    Frames differ in where Lumi stands (above, beside, on the corner), so each
    is scored by how big it shows the photo and how closely its window's shape
    matches the box (a portrait window in a wide slot crops hard). The previous
    page's frame is skipped whenever another scores at least 55% as well, so
    neighbouring pages vary without any photo shrinking to a postage stamp.
    """
    def score(pose: str) -> float:
        scale, _, _ = frame_fit(pose, box_w, box_h)
        x0, y0, x1, y1 = frame_meta()[pose]["window"]
        area = (x1 - x0) * (y1 - y0) * scale * scale / (box_w * box_h)
        window_ratio, box_ratio = (x1 - x0) / (y1 - y0), box_w / box_h
        match = min(window_ratio, box_ratio) / max(window_ratio, box_ratio)
        return area * math.sqrt(match)

    ranked = sorted(frame_poses(), key=score, reverse=True)
    if not ranked:
        return None
    best = score(ranked[0])
    for pose in ranked:
        if pose != avoid and score(pose) >= best * 0.55:
            return pose
    return ranked[0]
