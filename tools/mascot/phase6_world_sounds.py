"""The island's sound pack.

OpenRouter has no sound-effect model, so each sound comes from what does
it best:

    music     Lyria 3 Clip: a 30 s cozy adventure loop           ($0.04)
    chimes    Lyria 3 Clip: short sparkly stingers, sliced apart  ($0.04)
    voice     gpt-audio-mini: Lumi's "hup!", "wheee!", "ooh!"     (<$0.01)
    foley     Veo 3.1 Lite's soundtrack: footsteps on grass        ($0.20)

Wind, whoosh and landing thuds are synthesised in the browser
(frontend/world/sound.ts), which needs no files.

    python phase6_world_sounds.py gen music|chimes|voice|foley
    python phase6_world_sounds.py cut          # slice + encode (free)

Raw downloads land in out/sounds/raw; web files in frontend/public/world/sfx.
"""
import subprocess
import sys
import wave
from pathlib import Path

import imageio_ffmpeg
import numpy as np

from orclient import OUT, audio, spent, text_video

RAW = OUT / "sounds" / "raw"
DEST = Path(__file__).resolve().parents[2] / "frontend" / "public" / "world" / "sfx"
FFMPEG = imageio_ffmpeg.get_ffmpeg_exe()
LYRIA = "google/lyria-3-clip-preview"
VOICE_MODEL = "openai/gpt-audio-mini"

MUSIC_PROMPT = (
    "Instrumental background music for a cozy, cute low-poly island exploration game. "
    "Gentle and cheerful: soft marimba, plucked ukulele, light glockenspiel sparkles, warm "
    "felt piano and a relaxed shaker groove, about 96 BPM, major key. Calm enough to sit under "
    "footsteps and sound effects, no vocals, no big drums, no build-ups or drops, steady "
    "energy from start to end so it loops seamlessly."
)
CHIMES_PROMPT = (
    "A sound-effect pack of six very short, separate magical UI chimes for a cute game, "
    "each one under one second long and followed by two full seconds of complete silence: "
    "1) a bright sparkly glockenspiel twinkle rising up, 2) a soft harp glissando upward, "
    "3) a warm two-note marimba 'ding-dong', 4) a playful kalimba bloop, 5) a shimmering "
    "celesta sparkle falling down, 6) a tiny music-box flourish. No melody between them, "
    "no rhythm section, no reverb tails, silence in between each sound."
)
#: file -> what Lumi says (pitched up afterwards for a small, cute voice)
VOICE_LINES = {
    "hup": "Hup!",
    "wheee": "Wheeee!",
    "ooh": "Oooh!",
    "yay": "Yay!",
}
VOICE_SYSTEM = (
    "You are the voice of Lumi, a tiny, bubbly, adorable mascot in a cozy game. Say exactly "
    "the words given, once, as a short playful exclamation, full of joy, with no other words, "
    "no breathing before or after."
)
FOLEY_PROMPT = (
    "Extreme close-up at ground level of a small cartoon character's soft feet running quickly "
    "across short green grass in a sunny meadow, steady rhythm of about three steps per second. "
    "Sound: only crisp, soft, satisfying footstep foley on grass, each step clearly separate. "
    "No music, no voices, no wind, no birds, no ambience."
)


def gen(what: str) -> None:
    RAW.mkdir(parents=True, exist_ok=True)
    if what == "music":
        audio("world music", MUSIC_PROMPT, RAW / "music.mp3", model=LYRIA, estimate=0.04)
    elif what == "chimes":
        audio("world chimes", CHIMES_PROMPT, RAW / "chimes.mp3", model=LYRIA, estimate=0.04)
    elif what == "voice":
        for name, line in VOICE_LINES.items():
            audio(f"voice {name}", line, RAW / f"voice_{name}.wav", model=VOICE_MODEL,
                  voice="shimmer", fmt="pcm16", system=VOICE_SYSTEM, estimate=0.01)
    elif what == "foley":
        text_video("world foley steps", FOLEY_PROMPT, RAW / "foley.mp4", duration=4, estimate=0.20)
    else:
        sys.exit(f"unknown: {what}")
    print(f"spent so far ${spent():.2f}")


SR = 44100


def load(path: Path, sr: int = SR, channels: int = 1) -> np.ndarray:
    raw = subprocess.run([FFMPEG, "-v", "quiet", "-i", str(path), "-vn", "-f", "f32le", "-ac", str(channels),
                          "-ar", str(sr), "-"], capture_output=True, check=True).stdout
    x = np.frombuffer(raw, np.float32).copy()
    return x.reshape(-1, channels) if channels > 1 else x


def save_mp3(x: np.ndarray, name: str, *, bitrate: str = "96k", peak: float = 0.89) -> None:
    """Peak-normalise, then encode with the bundled ffmpeg."""
    x = x / (np.abs(x).max() + 1e-9) * peak
    channels = 1 if x.ndim == 1 else x.shape[1]
    DEST.mkdir(parents=True, exist_ok=True)
    out = DEST / f"{name}.mp3"
    subprocess.run([FFMPEG, "-v", "quiet", "-y", "-f", "f32le", "-ac", str(channels), "-ar", str(SR), "-i", "-",
                    "-c:a", "libmp3lame", "-b:a", bitrate, str(out)], input=x.astype(np.float32).tobytes(), check=True)
    print(f"  {out.name}: {len(x) / SR:.2f} s, {out.stat().st_size / 1e3:.0f} KB")


def fades(x: np.ndarray, fade_in: float = 0.004, fade_out: float = 0.05) -> np.ndarray:
    x = x.copy()
    a, b = int(fade_in * SR), int(fade_out * SR)
    if a:
        x[:a] *= np.linspace(0, 1, a)[:, None] if x.ndim > 1 else np.linspace(0, 1, a)
    if b:
        x[-b:] *= (np.linspace(1, 0, b) ** 2)[:, None] if x.ndim > 1 else np.linspace(1, 0, b) ** 2
    return x


def envelope(x: np.ndarray, hop: int) -> np.ndarray:
    mono = x if x.ndim == 1 else x.mean(axis=1)
    frames = len(mono) // hop
    return np.sqrt((mono[: frames * hop].reshape(frames, hop) ** 2).mean(axis=1))


def cut_music() -> None:
    """Loop on a bar line: find the beat, keep whole bars, crossfade the tail into the head."""
    x = load(RAW / "music.mp3", channels=2)
    hop = 512
    env = envelope(x, hop)
    onset = np.maximum(0, np.diff(env))
    onset -= onset.mean()
    ac = np.correlate(onset, onset, "full")[len(onset) - 1:]
    fps = SR / hop
    lags = np.arange(len(ac)) / fps
    ok = (lags > 60 / 140) & (lags < 60 / 70)  # 70..140 BPM
    beat = lags[ok][np.argmax(ac[ok])]
    bar = beat * 4
    bars = int((len(x) / SR - 1.0) // bar)
    n = int(round(bars * bar * SR))
    xf = int(min(beat, 0.6) * SR)
    loop = x[:n].copy()
    ramp = np.linspace(0, 1, xf)[:, None]
    loop[:xf] = loop[:xf] * np.sqrt(ramp) + x[n:n + xf] * np.sqrt(1 - ramp)
    print(f"  music: {60 / beat:.1f} BPM, {bars} bars, loop {n / SR:.2f} s")
    save_mp3(loop, "music", bitrate="112k", peak=0.8)


def cut_steps(count: int = 6) -> None:
    """Single footsteps from Veo's soundtrack: the cleanest `count` hits, noise gated."""
    x = load(RAW / "foley.mp4")
    hop = int(0.005 * SR)
    env = envelope(x, hop)
    db = 20 * np.log10(env + 1e-9)
    floor = np.percentile(db, 30)
    hits = []
    i = 0
    while i < len(db):
        if db[i] > floor + 14:
            start = max(0, i - 2)
            peak = db[i:i + 20].max()
            hits.append((peak - floor, start))
            i += int(0.25 / 0.005)  # one step, then look for the next
        else:
            i += 1
    hits.sort(reverse=True)
    for k, (_, start) in enumerate(sorted(hits[:count], key=lambda h: h[1])):
        s = start * hop
        step = x[s:s + int(0.22 * SR)].copy()
        # Gate the room tone under the tail.
        e = np.repeat(envelope(step, hop), hop)[: len(step)]
        e = np.pad(e, (0, len(step) - len(e)), mode="edge")
        gate = np.clip((20 * np.log10(e + 1e-9) - (floor + 4)) / 8, 0, 1)
        save_mp3(fades(step * gate, 0.002, 0.08), f"step{k + 1}", peak=0.8)


def from_onset(x: np.ndarray, seconds: float, below_peak_db: float = 30) -> np.ndarray:
    """`seconds` of audio starting where it first gets within `below_peak_db` of its peak."""
    hop = 256
    db = 20 * np.log10(envelope(x, hop) + 1e-9)
    start = int(np.argmax(db > db.max() - below_peak_db)) * hop
    return x[max(0, start - 200): start + int(seconds * SR)]


def cut_chimes() -> None:
    """Lyria ran the first chimes together; keep the three that stand alone."""
    x = load(RAW / "chimes.mp3", channels=2)
    t = lambda s: int(s * SR)  # noqa: E731
    save_mp3(fades(x[t(0.0):t(1.0)], 0.002, 0.3), "ding")
    save_mp3(fades(from_onset(x[t(13.0):t(17.0)], 2.2), 0.003, 0.6), "sparkle")
    save_mp3(fades(from_onset(x[t(17.2):t(23.7)], 2.6, 24), 0.01, 0.9), "flourish")


def cut_voice(pitch: float = 1.32) -> None:
    """Lumi is small: speed each line up (pitch and pace together, cartoon style)."""
    for name in VOICE_LINES:
        raw = RAW / f"voice_{name}.wav"
        x = load(raw, sr=int(SR / pitch))  # resample down, then play at SR: faster and higher
        env = envelope(x, 256)
        db = 20 * np.log10(env + 1e-9)
        loud = db > db.max() - 32
        first = int(np.argmax(loud))
        # End at the first real pause after the loudest moment (drops a trailing breath).
        quiet_run = int(0.08 * SR / 256)
        end = len(db)
        for i in range(int(np.argmax(db)), len(db) - quiet_run):
            if not loud[i:i + quiet_run].any():
                end = i
                break
        x = x[max(0, first * 256 - 400): end * 256 + 1500]
        save_mp3(fades(x, 0.004, 0.06), f"voice_{name}")


def cut() -> None:
    cut_music()
    cut_steps()
    cut_chimes()
    cut_voice()


if __name__ == "__main__":
    if len(sys.argv) >= 3 and sys.argv[1] == "gen":
        gen(sys.argv[2])
    elif len(sys.argv) >= 2 and sys.argv[1] == "cut":
        cut()
    else:
        sys.exit(__doc__)
