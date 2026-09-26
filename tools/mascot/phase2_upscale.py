"""Sharper landing film: extract every frame of the 720p clips and upscale 2x.

Veo 3.1 Lite renders at 720p, which a laptop screen stretches about 2.5x, so the
film looked soft. Real-ESRGAN's anime-video model (realesr-animevideov3), run
locally through realesrgan-ncnn-vulkan on any Vulkan GPU, restores clean edges
on Lumi's toy-like render for free. phase1_frames.py then encodes the result.

    python phase2_upscale.py <path to realesrgan-ncnn-vulkan.exe>
"""
import shutil
import subprocess
import sys

import imageio_ffmpeg

from orclient import OUT

FF = imageio_ffmpeg.get_ffmpeg_exe()
CLIPS = [OUT / "video" / "clips" / f"c{i}.mp4" for i in range(1, 5)]
RAW = OUT / "video" / "raw"          # every frame at 720p, in film order
UP = OUT / "video" / "up"            # the same frames at 1440p

esrgan = sys.argv[1]

shutil.rmtree(RAW, ignore_errors=True)
RAW.mkdir(parents=True)
n = 0
for i, clip in enumerate(CLIPS):
    tmp = RAW / "tmp"
    tmp.mkdir()
    subprocess.run([FF, "-v", "error", "-i", str(clip), str(tmp / "%04d.png")], check=True)
    # Each clip starts on the frame the previous one ended on; keep one copy.
    for f in sorted(tmp.glob("*.png"))[1 if i else 0:]:
        n += 1
        f.replace(RAW / f"{n:04d}.png")
    shutil.rmtree(tmp)
print(f"extracted {n} frames", flush=True)

UP.mkdir(parents=True, exist_ok=True)
subprocess.run([esrgan, "-i", str(RAW), "-o", str(UP), "-n", "realesr-animevideov3",
                "-s", "2", "-j", "1:2:2"], check=True)
print(f"upscaled {len(list(UP.glob('*.png')))} frames")
