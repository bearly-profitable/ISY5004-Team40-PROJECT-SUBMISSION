"""Lumi "frame" poses for the PDF album: Lumi hugging, holding or peeking around
a photo.

Each pose is drawn around a flat pure-blue card on a pure-green background. The
green becomes transparency and the blue becomes a *window*: the album composites
the real photo underneath, so Lumi's paws genuinely overlap its edges.

    python phase3_frames.py gen [pose ...]   # generate (costs ~$0.10 each)
    python phase3_frames.py cut              # key, find windows, write assets (free)
"""
import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

from orclient import OUT, image, spent

REFS = (OUT / "ref" / "lumi_3q.png", OUT / "concepts" / "b_shutterbun.png")
SRC = OUT / "frames"
DEST = Path(__file__).resolve().parents[2] / "backend" / "assets" / "lumi" / "frames"

#: pose -> (aspect of the generated image, what Lumi is doing with the card)
POSES: dict[str, tuple[str, str]] = {
    "bighug": ("3:4", "Lumi stands BEHIND a large square card and gives it a big loving hug: "
               "Lumi's head and ears rise above the card's top edge, eyes happily closed, "
               "and both arms wrap around the card so both paws are visible ON THE FRONT of "
               "the card, one near the left edge and one near the right edge."),
    "peek": ("4:3", "A wide landscape card (3:2) stands upright. Lumi hides BEHIND it and "
             "peeks over the top edge: only Lumi's head, ears and two paws show, the paws "
             "gripping the card's top edge and overlapping the front of the card."),
    "sidehug": ("16:9", "A wide landscape card (3:2) stands upright on the right. Lumi stands "
                "to its LEFT, hugging the card's left edge with both arms, cheek pressed "
                "lovingly against it, both paws overlapping the front of the card."),
    "tallhug": ("4:3", "A tall portrait card (3:4) stands upright on the left. Lumi stands to "
                "its RIGHT, hugging the card's right edge with both arms, cheek pressed "
                "against it, both paws overlapping the front of the card."),
    "sidepeek": ("1:1", "A tall portrait card (3:4) stands upright on the right. Lumi peeks out "
                 "from behind the card's LEFT edge: half of Lumi's head and one paw show, the "
                 "paw curled around the edge and overlapping the front of the card."),
    "sit": ("4:3", "A wide landscape card (3:2) stands upright. Lumi sits happily on the "
            "card's TOP-RIGHT corner, legs dangling down in front of the card's face, "
            "waving with one paw."),
}

PROMPT = (
    "The SAME character, Lumi, shown in both attached reference images: a bao-bun "
    "bear-hood mascot with lavender hood and round ears, cream face, pink-to-peach body, a "
    "purple camera lens on its cream tummy, and a small peach bump on its head. Keep the "
    "exact design, proportions and colours. Soft matte vinyl toy 3D render, soft studio "
    "light. Lumi's hands are soft rounded mitten paws with no separate fingers.\n\n"
    "Scene: {action}\n\n"
    "THE CARD IS A PLACEHOLDER: a perfectly flat, perfectly uniform pure blue (#0000FF) "
    "rectangle facing the viewer straight on, sharp square corners, no border, no shading, "
    "no gradient, no texture, no reflection, no shadow on it. It must be large: the card "
    "is the main subject and fills most of the image. Everything is centred with a small "
    "margin. Background: one flat solid pure green (#00FF00) everywhere, no floor, no "
    "shadows, no text."
)


def generate(pose: str) -> None:
    aspect, action = POSES[pose]
    image(f"frame {pose}", PROMPT.format(action=action), SRC / f"{pose}.png",
          refs=REFS, aspect=aspect, size="2K")


def cut() -> None:
    """Key green to transparency, blue to a window, and record the window's shape."""
    from scipy.spatial import ConvexHull

    DEST.mkdir(parents=True, exist_ok=True)
    meta: dict[str, dict] = {}
    for pose in POSES:
        path = SRC / f"{pose}.png"
        if not path.exists():
            continue
        a = np.asarray(Image.open(path).convert("RGB")).astype(np.float32)
        r, g, b = a[..., 0], a[..., 1], a[..., 2]
        greenness = g - np.maximum(r, b)
        blueness = b - np.maximum(r, g)
        card = blueness > 90
        # Lumi's hood and lens are bluish too, so the blue key only applies in
        # a thin band around the card, never to Lumi.
        from scipy.ndimage import binary_dilation
        near_card = binary_dilation(card, iterations=8)
        blue_key = np.where(near_card, np.clip(1 - (blueness - 40) / 70, 0, 1), 1.0)
        # Soft keys: fully keyed well inside a colour, blended across its edge.
        alpha = np.clip(1 - (greenness - 25) / 60, 0, 1) * blue_key
        # Where the blue card meets the green background the two blend into a
        # dark teal that neither key catches. Lumi's colours all carry plenty of
        # red, so a red-less pixel beside the card is fringe: drop it.
        fringe = near_card & (r < 70) & (np.maximum(g, b) > 90)
        alpha = np.where(fringe, 0.0, alpha)
        # Despill both key colours from the edges that remain.
        g = np.where(greenness > 0, np.maximum(r, b), g)
        b = np.where(near_card & (blueness > 0), np.maximum(r, g), b)

        ys, xs = np.nonzero(card)
        if len(xs) < 1000:
            print(f"  {pose}: no card found, skipped")
            continue
        hull = ConvexHull(np.column_stack([xs, ys]))
        poly = [(float(xs[i]), float(ys[i])) for i in hull.vertices]
        # How rectangular is the card? A clean placeholder fills its hull.
        mask = Image.new("L", (a.shape[1], a.shape[0]), 0)
        ImageDraw.Draw(mask).polygon(poly, fill=255)
        hull_area = np.count_nonzero(np.asarray(mask))
        x0, y0, x1, y1 = int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1
        fill = hull_area / ((x1 - x0) * (y1 - y0))

        # The model outlines the card with a dark line that neither key catches.
        # Along the card's edge, anything not clearly Lumi (whose colours all
        # carry plenty of red) goes; the album grows the photo into that band.
        from scipy.ndimage import binary_erosion
        hull_mask = np.asarray(mask) > 0
        edge = binary_dilation(hull_mask, iterations=6) & ~binary_erosion(hull_mask, iterations=4)
        alpha = np.where(edge & (a[..., 0] < 115), 0.0, alpha)

        sprite = Image.fromarray(np.dstack([r, g, b, alpha * 255]).round().astype(np.uint8))
        box = sprite.getchannel("A").point(lambda v: 255 if v > 8 else 0).getbbox()
        # The window counts as content too, so the crop never clips the card.
        box = (min(box[0], x0), min(box[1], y0), max(box[2], x1), max(box[3], y1))
        sprite = sprite.crop(box)
        ox, oy = box[0], box[1]
        sprite.save(DEST / f"{pose}.webp", "WEBP", quality=92, method=5)
        meta[pose] = {
            "size": list(sprite.size),
            "window": [x0 - ox, y0 - oy, x1 - ox, y1 - oy],
            "polygon": [[round(x - ox, 1), round(y - oy, 1)] for x, y in poly],
        }
        print(f"  {pose}: sprite {sprite.size}, window {x1 - x0}x{y1 - y0}, "
              f"rectangular {fill:.2f}")
    (DEST / "frames.json").write_text(json.dumps(meta, indent=1))


if __name__ == "__main__":
    cmd, *names = sys.argv[1:] or ["cut"]
    if cmd == "gen":
        for name in names or list(POSES):
            generate(name)
        print(f"total spent ${spent():.4f}")
    cut()
