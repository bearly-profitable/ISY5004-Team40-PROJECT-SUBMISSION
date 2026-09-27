"""Synthesised sound effects for the demo video (no API calls, $0).

    ../venv/Scripts/python.exe audio/make_sfx.py   ->  public/sfx/*.wav
"""
from __future__ import annotations

from pathlib import Path

import numpy as np
import soundfile as sf
from scipy import signal

SR = 48000
OUT = Path(__file__).resolve().parents[1] / "public" / "sfx"
rng = np.random.default_rng(7)


def env(n: int, attack: float, release: float, curve: float = 2.0) -> np.ndarray:
    t = np.linspace(0, 1, n)
    a = np.clip(t / max(attack, 1e-4), 0, 1)
    r = np.clip((1 - t) / max(release, 1e-4), 0, 1) ** curve
    return a * r


def sweep_filter(x: np.ndarray, f0: float, f1: float, q: float = 1.2) -> np.ndarray:
    """Band-pass whose centre glides from f0 to f1 (block-wise)."""
    out = np.zeros_like(x)
    block = 256
    zi = None
    for i in range(0, len(x), block):
        k = i / len(x)
        fc = f0 * (f1 / f0) ** k
        b, a = signal.iirpeak(min(fc, SR / 2 - 100), q, fs=SR)
        seg = x[i:i + block]
        if zi is None:
            zi = signal.lfilter_zi(b, a) * 0
        y, zi = signal.lfilter(b, a, seg, zi=zi)
        out[i:i + block] = y
    return out


def stereo(x: np.ndarray, pan_from: float = -0.6, pan_to: float = 0.6) -> np.ndarray:
    p = np.linspace(pan_from, pan_to, len(x))
    left = x * np.sqrt((1 - p) / 2)
    right = x * np.sqrt((1 + p) / 2)
    return np.stack([left, right], 1)


def norm(x: np.ndarray, peak: float = 0.9) -> np.ndarray:
    return x / (np.abs(x).max() + 1e-9) * peak


def whoosh(dur=0.55, f0=300, f1=4200) -> np.ndarray:
    n = int(SR * dur)
    x = rng.standard_normal(n)
    x = sweep_filter(x, f0, f1, 0.9) * env(n, 0.55, 0.45, 1.6)
    air = signal.lfilter(*signal.butter(2, 6000, 'hp', fs=SR), rng.standard_normal(n)) * env(n, 0.6, 0.4) * 0.15
    return stereo(norm(x + air, 0.8))


def impact(dur=1.4) -> np.ndarray:
    n = int(SR * dur)
    t = np.arange(n) / SR
    f = 34 + 70 * np.exp(-t * 18)
    boom = np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t * 3.2)
    crack = signal.lfilter(*signal.butter(2, [800, 7000], 'bp', fs=SR), rng.standard_normal(n)) * np.exp(-t * 28) * 0.5
    shimmer = sum(np.sin(2 * np.pi * fr * t) for fr in (1318.5, 1975.5, 2637.0)) * np.exp(-t * 2.5) * 0.05
    x = norm(boom + crack + shimmer, 0.85)
    return np.stack([x, x], 1)


def click() -> np.ndarray:
    n = int(SR * 0.09)
    t = np.arange(n) / SR
    x = np.sin(2 * np.pi * 2300 * t) * np.exp(-t * 90) + np.sin(2 * np.pi * 1150 * t) * np.exp(-t * 60) * 0.6
    x += signal.lfilter(*signal.butter(2, 3000, 'hp', fs=SR), rng.standard_normal(n)) * np.exp(-t * 300) * 0.4
    x = norm(x, 0.6)
    return np.stack([x, x], 1)


def tick() -> np.ndarray:
    n = int(SR * 0.05)
    t = np.arange(n) / SR
    x = signal.lfilter(*signal.butter(2, [1800, 6000], 'bp', fs=SR), rng.standard_normal(n)) * np.exp(-t * 180)
    x = norm(x, 0.35)
    return np.stack([x, x], 1)


def sparkle(dur=1.2) -> np.ndarray:
    n = int(SR * dur)
    t = np.arange(n) / SR
    notes = [1567.98, 2093.0, 2637.0, 3135.96, 4186.0]
    x = np.zeros(n)
    for i, fr in enumerate(notes):
        start = int(i * 0.055 * SR)
        tt = t[: n - start]
        x[start:] += np.sin(2 * np.pi * fr * tt) * np.exp(-tt * 5) * (0.9 ** i)
    return stereo(norm(x, 0.45), -0.3, 0.3)


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    for name, data in {
        "whoosh": whoosh(),
        "whoosh_long": whoosh(0.9, 200, 5200),
        "impact": impact(),
        "click": click(),
        "tick": tick(),
        "sparkle": sparkle(),
    }.items():
        sf.write(OUT / f"{name}.wav", data.astype(np.float32), SR)
        print(name, f"{len(data) / SR:.2f}s")


if __name__ == "__main__":
    main()
