"""Lumi's pose library: 6 poses per generated sheet, keyed and cut into PNGs.

One sheet per call is ~6x cheaper than one pose per call, and poses drawn side by
side in one image stay more consistent with each other.

    python phase1_poses.py gen [sheet ...]   # generate sheets (costs money)
    python phase1_poses.py cut               # key + slice every sheet (free)
"""
import sys

import numpy as np
from PIL import Image

from orclient import OUT, image, spent

REFS = (OUT / "ref" / "lumi_3q.png", OUT / "concepts" / "b_shutterbun.png")
COLS, ROWS = 3, 2

# Row-major: the first three are the top row, left to right.
SHEETS: dict[str, list[tuple[str, str]]] = {
    "states": [
        ("wave", "waving hello with one arm raised high, big happy smile"),
        ("idle", "standing relaxed, hands at its sides, gentle smile"),
        ("think", "one hand on its chin, looking up, thinking"),
        ("search", "peering through a large magnifying glass held in both hands"),
        ("sleepy", "sitting down, eyes closed, sleepy, a small 'z' bubble"),
        ("sad", "sad droopy pose, looking down, holding a crumpled photo"),
    ],
    "album": [
        ("carry", "walking, carrying a tall stack of photo prints in both arms"),
        ("hang", "reaching up to peg a polaroid photo onto a short string line"),
        ("point", "pointing sideways with one arm fully extended, excited"),
        ("present", "holding a blank wooden sign up over its head with both hands"),
        ("tag", "holding out a blank name tag towards the viewer"),
        ("celebrate", "jumping in the air with both arms up, confetti around it"),
    ],
    "events1": [
        ("wedding", "wearing a tiny bow tie, holding a flower bouquet"),
        ("birthday", "wearing a party hat, holding a small birthday cake with a candle"),
        ("graduation", "wearing a graduation cap, holding a rolled diploma"),
        ("christmas", "wearing a santa hat, holding a wrapped gift box"),
        ("beach", "wearing sunglasses, holding a striped swim ring"),
        ("hiking", "wearing a small backpack, holding a walking stick, mid-stride"),
    ],
    "events2": [
        ("cafe", "holding a coffee cup with both hands, steam rising"),
        ("dinner", "holding a bowl of noodles and chopsticks, happy"),
        ("travel", "pulling a small suitcase, holding a folded map"),
        ("garden", "watering a potted flower with a small watering can"),
        ("shopping", "carrying two shopping bags, one in each hand"),
        ("night", "holding a glowing lightstick, a tiny crescent moon beside it"),
    ],
    "extras": [
        ("home", "sitting cosily hugging a round cushion"),
        ("meeting", "holding a clipboard and a pencil, focused"),
        ("camera", "holding up a small instant camera and taking a photo"),
        ("sort", "sorting photos into two neat piles on the ground"),
        ("star", "holding up a big glowing golden star with both arms, proud"),
        ("hug", "hugging a big heart, eyes closed, blissful"),
    ],
}

PROMPT = (
    "Sprite sheet of the SAME character, Lumi, shown in both attached reference images: "
    "a bao-bun bear-hood mascot with lavender hood and round ears, cream face, pink-to-peach "
    "body, a purple camera lens on its cream tummy, and a small peach bump on top of its head. "
    "Keep the exact design, proportions and colours in every pose. Soft matte vinyl toy 3D "
    "render, soft studio lighting. Layout: a clean grid of {cols} columns by {rows} rows, one "
    "full-body pose per cell, each pose small and centered in its cell with wide empty space "
    "between cells, nothing crossing into another cell. Poses in reading order:\n{poses}\n"
    "Background: one flat solid pure green (#00FF00) everywhere, no gradient, no floor, "
    "no shadows, no text, no labels, no borders."
)


def generate(sheet: str) -> None:
    poses = SHEETS[sheet]
    lines = "\n".join(f"{i + 1}. {desc}" for i, (_, desc) in enumerate(poses))
    image(f"poses {sheet}", PROMPT.format(cols=COLS, rows=ROWS, poses=lines),
          OUT / "sheets" / f"{sheet}.png", refs=REFS, aspect="3:2", size="2K")


def key_green(img: Image.Image) -> Image.Image:
    """Chroma-key the green background to alpha, and pull green spill off edges."""
    a = np.asarray(img.convert("RGB")).astype(np.float32)
    r, g, b = a[..., 0], a[..., 1], a[..., 2]
    greenness = g - np.maximum(r, b)
    alpha = np.clip(1.0 - (greenness - 25.0) / 60.0, 0.0, 1.0)
    g = np.where(greenness > 0, np.maximum(r, b), g)          # despill
    out = np.dstack([r, g, b, alpha * 255.0]).astype(np.uint8)
    return Image.fromarray(out)


#: The model does not always honour the 3x2 grid (events1 came back 4x2 with a
#: duplicate graduation and an extra plain pose), so figures are found by shape
#: and this picks which detected figure, in reading order, each pose name gets.
PICK: dict[str, list[int]] = {
    "events1": [0, 1, 2, 4, 5, 7],
}


def figures(keyed: Image.Image) -> list[tuple[int, int, int, int, np.ndarray]]:
    """Each figure's bounding box and mask, in reading order.

    The mask is dilated before labelling so a figure's props and confetti join
    its body; blobs too small to be a figure are dropped as stray haze."""
    from scipy import ndimage

    alpha = np.asarray(keyed)[..., 3] > 24
    labels, n = ndimage.label(ndimage.binary_dilation(alpha, iterations=30))
    blobs = []
    for i, sl in enumerate(ndimage.find_objects(labels), start=1):
        mask = (labels[sl] == i) & alpha[sl]
        if mask.sum() < alpha.size * 0.004:
            continue
        ys, xs = sl
        blobs.append((xs.start, ys.start, xs.stop, ys.stop, mask))
    # Rows: a new row starts when a figure's centre drops by a quarter sheet.
    blobs.sort(key=lambda b: (b[1] + b[3]) / 2)
    rows: list[list] = []
    for b in blobs:
        cy = (b[1] + b[3]) / 2
        if rows and cy - (rows[-1][0][1] + rows[-1][0][3]) / 2 < keyed.height * 0.25:
            rows[-1].append(b)
        else:
            rows.append([b])
    return [b for row in rows for b in sorted(row, key=lambda b: b[0])]


def cut() -> None:
    dst = OUT / "poses"
    dst.mkdir(parents=True, exist_ok=True)
    for sheet, poses in SHEETS.items():
        path = OUT / "sheets" / f"{sheet}.png"
        if not path.exists():
            continue
        keyed = key_green(Image.open(path))
        found = figures(keyed)
        pick = PICK.get(sheet, list(range(len(poses))))
        if len(found) <= max(pick):
            print(f"  {sheet}: found {len(found)} figures, expected {len(poses)}; skipped")
            continue
        for (name, _), idx in zip(poses, pick):
            x0, y0, x1, y1, mask = found[idx]
            sprite = keyed.crop((x0, y0, x1, y1))
            alpha = np.asarray(sprite)[..., 3] * mask
            sprite.putalpha(Image.fromarray(alpha.astype(np.uint8)))
            box = sprite.getbbox()
            pad = 8
            sprite = sprite.crop((max(0, box[0] - pad), max(0, box[1] - pad),
                                  min(sprite.width, box[2] + pad),
                                  min(sprite.height, box[3] + pad)))
            sprite.save(dst / f"{name}.png", optimize=True)
            print(f"  {name}: {sprite.size}")


if __name__ == "__main__":
    cmd, *names = sys.argv[1:] or ["cut"]
    if cmd == "gen":
        for name in names or list(SHEETS):
            generate(name)
        print(f"total spent ${spent():.4f}")
    cut()
