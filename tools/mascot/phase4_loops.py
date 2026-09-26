"""Animated Lumi for the processing screen: one seamless loop per pipeline stage.

Each stage's still pose is centred on a flat green screen and handed to Veo 3.1
Lite as both the first and the last frame, so the clip starts and ends on the
same picture and loops without a jump. The green is then keyed out locally
(the same key as the pose sheets) into a transparent animated WebP.

    python phase4_loops.py key [stage ...]   # green-screen keyframes (free)
    python phase4_loops.py gen [stage ...]   # 4 s clips (~$0.12 each)
    python phase4_loops.py cut [stage ...]   # key + encode WebP loops (free)
"""
import subprocess
import sys
from pathlib import Path

import imageio_ffmpeg
import numpy as np
from PIL import Image

from orclient import OUT, spent, video
from phase1_poses import key_green

POSES = OUT / "poses"
KEYS = OUT / "loops" / "keys"
CLIPS = OUT / "loops" / "clips"
RAW = OUT / "loops" / "raw"
DEST = Path(__file__).resolve().parents[2] / "frontend" / "public" / "lumi" / "anim"

W, H = 1280, 720            # Veo 3.1 Lite's 720p 16:9 canvas
LUMI_H = 500                # leaves headroom for raised arms and props
GREEN = (0, 255, 0)
SECONDS = 4
FPS = 16                    # of Veo's 24; smooth enough, a third lighter
OUT_H = 320                 # shown at ~150 CSS px, so this is 2x for retina

STYLE = (
    " Keep the exact same character design, colours and proportions as the image."
    " Locked-off static camera, no zoom, no cuts. Flat solid pure green chroma-key"
    " background everywhere, with no floor, no shadow and no other objects."
    " Gentle, bouncy, cartoon-like motion that ends in exactly the starting pose."
)

#: stage -> (pose sprite, what Lumi does in the loop)
STAGES: dict[str, tuple[str, str]] = {
    "quality_scoring": ("star", "The cute mascot happily waves the glowing golden star from side to side above its head, the star twinkles, the mascot bounces a little on its feet and blinks, then settles back."),
}


def key(stage: str) -> Path:
    pose, _ = STAGES[stage]
    sprite = Image.open(POSES / f"{pose}.png").convert("RGBA")
    sprite = sprite.resize((round(sprite.width * LUMI_H / sprite.height), LUMI_H), Image.LANCZOS)
    canvas = Image.new("RGBA", (W, H), GREEN + (255,))
    canvas.alpha_composite(sprite, ((W - sprite.width) // 2, (H - LUMI_H) // 2 + 30))
    out = KEYS / f"{stage}.png"
    out.parent.mkdir(parents=True, exist_ok=True)
    canvas.convert("RGB").save(out)
    return out


def gen(stage: str) -> None:
    _, action = STAGES[stage]
    frame = KEYS / f"{stage}.png"
    if not frame.exists():
        key(stage)
    video(f"loop {stage}", action + STYLE, CLIPS / f"{stage}.mp4",
          first=frame, last=frame, duration=SECONDS, estimate=0.03 * SECONDS)


def cut(stage: str) -> Path:
    raw = RAW / stage
    raw.mkdir(parents=True, exist_ok=True)
    for old in raw.glob("*.png"):
        old.unlink()
    subprocess.run([imageio_ffmpeg.get_ffmpeg_exe(), "-loglevel", "error", "-i", str(CLIPS / f"{stage}.mp4"),
                    "-vf", f"fps={FPS}", str(raw / "%04d.png")], check=True)
    frames = [key_green(Image.open(p)) for p in sorted(raw.glob("*.png"))]

    # One crop for every frame (the union of Lumi's extent), so Lumi never jitters
    boxes = [f.getchannel("A").point(lambda a: 255 if a > 40 else 0).getbbox() for f in frames]
    boxes = [b for b in boxes if b]
    x0, y0 = min(b[0] for b in boxes), min(b[1] for b in boxes)
    x1, y1 = max(b[2] for b in boxes), max(b[3] for b in boxes)
    pad = 8
    box = (max(0, x0 - pad), max(0, y0 - pad), min(W, x1 + pad), min(H, y1 + pad))
    scale = OUT_H / (box[3] - box[1])
    size = (round((box[2] - box[0]) * scale), OUT_H)
    frames = [f.crop(box).resize(size, Image.LANCZOS) for f in frames]

    DEST.mkdir(parents=True, exist_ok=True)
    pose, _ = STAGES[stage]
    out = DEST / f"{pose}.webp"
    frames[0].save(out, save_all=True, append_images=frames[1:], duration=round(1000 / FPS),
                   loop=0, quality=80, method=6, lossless=False, background=(0, 0, 0, 0))
    print(f"  {out.name}: {len(frames)} frames, {size[0]}x{size[1]}, {out.stat().st_size // 1024} KB")
    return out


if __name__ == "__main__":
    cmd, names = sys.argv[1], sys.argv[2:] or list(STAGES)
    for name in names:
        {"key": key, "gen": gen, "cut": cut}[cmd](name)
    print(f"spent so far: ${spent():.4f}")
