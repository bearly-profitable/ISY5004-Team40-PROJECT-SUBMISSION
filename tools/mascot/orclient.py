"""OpenRouter calls for building Lumi's assets, behind a hard spending cap.

These scripts run once, offline, to produce the files the app ships with. The
app itself never generates Lumi at runtime. Every call's cost is appended to
`ledger.json`, and a call is refused once the recorded total reaches BUDGET_USD.
"""
from __future__ import annotations

import base64
import json
import mimetypes
import os
import time
from pathlib import Path

import httpx
from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parent
OUT = ROOT / "out"
LEDGER = ROOT / "ledger.json"
BUDGET_USD = 5.00

load_dotenv(ROOT.parents[1] / "backend" / ".env")
BASE = (os.getenv("OPENROUTER_BASE_URL") or "https://openrouter.ai/api/v1").rstrip("/")
IMAGE_MODEL = "google/gemini-3.1-flash-image"

_TIMEOUT = httpx.Timeout(connect=15.0, read=600.0, write=60.0, pool=15.0)


def _headers() -> dict[str, str]:
    key = (os.getenv("OPENROUTER_API_KEY") or "").strip()
    if not key:
        raise SystemExit("OPENROUTER_API_KEY missing from backend/.env")
    return {"Authorization": f"Bearer {key}", "Content-Type": "application/json",
            "X-Title": "Lumina mascot assets"}


def spent() -> float:
    if not LEDGER.exists():
        return 0.0
    return round(sum(e["usd"] for e in json.loads(LEDGER.read_text())), 4)


def record(label: str, usd: float) -> None:
    entries = json.loads(LEDGER.read_text()) if LEDGER.exists() else []
    entries.append({"label": label, "usd": usd, "at": time.strftime("%Y-%m-%d %H:%M:%S")})
    LEDGER.write_text(json.dumps(entries, indent=2))
    print(f"  ${usd:.4f}  {label}   (total ${spent():.4f} / ${BUDGET_USD:.2f})")


def guard(estimate: float) -> None:
    if spent() + estimate > BUDGET_USD:
        raise SystemExit(f"Refusing: ${spent():.2f} spent, +${estimate:.2f} would pass the "
                         f"${BUDGET_USD:.2f} cap.")


def data_url(path: Path) -> str:
    mime = mimetypes.guess_type(path.name)[0] or "image/png"
    return f"data:{mime};base64,{base64.b64encode(path.read_bytes()).decode()}"


def video(label: str, prompt: str, out: Path, *, first: Path, last: Path,
          model: str = "google/veo-3.1-lite", duration: int = 6,
          estimate: float = 0.20) -> Path:
    """One clip that starts on `first` and ends on `last`, saved as MP4."""
    guard(estimate)
    frames = [{"type": "image_url", "image_url": {"url": data_url(p)}, "frame_type": kind}
              for p, kind in ((first, "first_frame"), (last, "last_frame"))]
    with httpx.Client(timeout=_TIMEOUT) as client:
        r = client.post(f"{BASE}/videos", headers=_headers(), json={
            "model": model, "prompt": prompt, "duration": duration,
            "resolution": "720p", "aspect_ratio": "16:9",
            "generate_audio": False, "frame_images": frames,
        })
        if r.status_code not in (200, 201, 202):
            raise SystemExit(f"{label}: HTTP {r.status_code} {r.text[:400]}")
        job = r.json()
        print(f"  {label}: job {job['id']} submitted", flush=True)
        while True:
            time.sleep(20)
            status = client.get(f"{BASE}/videos/{job['id']}", headers=_headers()).json()
            if status.get("status") in ("completed", "failed", "cancelled", "error"):
                break
        if status.get("status") != "completed":
            record(f"{label} (failed)", float((status.get("usage") or {}).get("cost") or 0.0))
            raise SystemExit(f"{label}: {status.get('status')} {str(status)[:400]}")
        record(label, float((status.get("usage") or {}).get("cost") or estimate))
        content = client.get(status["unsigned_urls"][0], headers=_headers(),
                             follow_redirects=True)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_bytes(content.content)
    return out


def image(label: str, prompt: str, out: Path, *, refs: tuple[Path, ...] = (),
          aspect: str = "1:1", size: str = "1K", model: str = IMAGE_MODEL,
          estimate: float = 0.10) -> Path:
    """One image from `prompt`, conditioned on reference images, saved to `out`."""
    guard(estimate)
    image_config = {"aspect_ratio": aspect, "image_size": size}
    content: list[dict] = [{"type": "text", "text": prompt}]
    content += [{"type": "image_url", "image_url": {"url": data_url(p)}} for p in refs]
    with httpx.Client(timeout=_TIMEOUT) as client:
        r = client.post(f"{BASE}/chat/completions", headers=_headers(), json={
            "model": model,
            "modalities": ["image", "text"],
            "image_config": image_config,
            "usage": {"include": True},
            "messages": [{"role": "user", "content": content}],
        })
    if r.status_code != 200:
        raise SystemExit(f"{label}: HTTP {r.status_code} {r.text[:400]}")
    data = r.json()
    record(label, float((data.get("usage") or {}).get("cost") or 0.0))
    msg = (data.get("choices") or [{}])[0].get("message") or {}
    images = msg.get("images") or []
    if not images:
        raise SystemExit(f"{label}: no image returned. {str(msg.get('content'))[:300]}")
    url = images[0]["image_url"]["url"]
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_bytes(base64.b64decode(url.split(",", 1)[1]))
    return out
