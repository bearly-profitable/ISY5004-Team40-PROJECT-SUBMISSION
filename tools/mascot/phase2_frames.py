"""Encode the upscaled landing film (phase2_upscale.py) into the WebP frame
sequences the landing page scrubs, at the clips' full 24 fps.

  d/  1920x1080, for wide screens
  m/  800x800, a centred square crop for phones (Lumi is framed in the middle
      third of the film, so the square keeps everything that matters)

Also writes frontend/lib/landingFilm.json, which the page imports for the
frame count, so the two can never disagree.
"""
import json
import shutil
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

from PIL import Image

from orclient import OUT

UP = OUT / "video" / "up"
FRONTEND = Path(__file__).resolve().parents[2] / "frontend"
DEST = FRONTEND / "public" / "landing"
FPS = 24


def encode(args: tuple[int, str]) -> int:
    index, src = args
    with Image.open(src) as img:
        img = img.convert("RGB")
        w, h = img.size
        img.resize((1920, 1080), Image.LANCZOS).save(
            DEST / "d" / f"{index:04d}.webp", "WEBP", quality=80, method=5)
        side = h
        left = (w - side) // 2
        img.crop((left, 0, left + side, side)).resize((800, 800), Image.LANCZOS).save(
            DEST / "m" / f"{index:04d}.webp", "WEBP", quality=78, method=5)
    return index


if __name__ == "__main__":
    frames = sorted(UP.glob("*.png"))
    for key in ("d", "m"):
        shutil.rmtree(DEST / key, ignore_errors=True)
        (DEST / key).mkdir(parents=True)
    with ProcessPoolExecutor() as pool:
        list(pool.map(encode, enumerate((str(f) for f in frames), start=1), chunksize=8))
    (FRONTEND / "lib" / "landingFilm.json").write_text(
        json.dumps({"frames": len(frames), "fps": FPS}) + "\n")
    for key in ("d", "m"):
        size = sum(f.stat().st_size for f in (DEST / key).iterdir())
        print(f"{key}: {len(frames)} frames, {size / 1e6:.1f} MB")
