"""Soundtrack for the Lumina demo video: one Lyria 3 Pro song ($0.08).

Goes through tools/mascot/orclient.py, so it is logged in ledger.json and
refused past the $5 cap.

    ../venv/Scripts/python.exe audio/gen_music.py [variant-name]
"""
from __future__ import annotations

import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parents[1] / "tools" / "mascot"))
from orclient import audio, spent  # noqa: E402

PROMPT = (
    "Instrumental music for a fast-cut, high-energy launch video of a playful, cute photo app. "
    "124 BPM, 4/4, major key, bright, euphoric and modern. Style: polished future-bass / "
    "electro-pop: crisp punchy kick and snappy claps, side-chained warm supersaw chords, "
    "sparkly synth plucks, glassy bell and music-box accents, soft pitched vocal-chop textures "
    "with no words, whoosh risers and reverse cymbals into each section. "
    "Structure: 0:00 airy intro, filtered chords and a ticking hi-hat, riser; "
    "0:08 first drop, full groove and energy; "
    "0:38 short breakdown with plucks and bells over a pulsing bass, riser; "
    "0:46 second drop, bigger, extra sparkle and a counter-melody; "
    "1:16 outro: one final big hit, then a gentle bell tail that ends cleanly by 1:26. "
    "No vocals, no lyrics, no spoken words."
)


def main() -> None:
    name = sys.argv[1] if len(sys.argv) > 1 else "track_a"
    out = HERE / f"{name}.mp3"
    print(f"spent so far ${spent():.3f}")
    audio(f"demo video music {name}", PROMPT, out,
          model="google/lyria-3-pro-preview", estimate=0.08, fmt="mp3")
    print("saved", out)


if __name__ == "__main__":
    main()
