"""Thin OpenRouter client for Lumina's generative features.

OpenRouter exposes an OpenAI-compatible `/chat/completions` endpoint. Image
*editing* rides the same endpoint: the source photo goes in as an `image_url`
content part, `modalities` asks for an image back, and the result arrives as a
base64 data URL in `choices[0].message.images[0]`.

Model choice matters more than it looks. The OpenAI image models regenerate the
scene — they re-frame, re-pose, and silently change the aspect ratio — which is
wrong for a retoucher that must return *the same photograph*. The Gemini image
models edit in place and hold identity and composition, so that family is the
default here. Both are swappable via `OPENROUTER_IMAGE_MODEL`.
"""
from __future__ import annotations

import base64
import io
import os
from typing import Optional

import httpx

DEFAULT_BASE_URL = "https://openrouter.ai/api/v1"
# Nano Banana 2. Preserves framing, aspect ratio and identity on edits, and is
# ~3.4x cheaper per image than the OpenAI image models (~$0.07 vs ~$0.23).
DEFAULT_IMAGE_MODEL = "google/gemini-3.1-flash-image"
DEFAULT_TEXT_MODEL = "openai/gpt-5.6-luna"

# Long edge the source photo is downscaled to before upload. The models cap
# output resolution well below typical camera originals anyway, and this keeps
# request bodies (and prompt-token cost) sane.
MAX_UPLOAD_EDGE = 1536

_TIMEOUT = httpx.Timeout(connect=15.0, read=300.0, write=60.0, pool=15.0)


class OpenRouterError(RuntimeError):
    """Any failure talking to OpenRouter, safe to surface to the client."""


def _api_key() -> str:
    return (os.getenv("OPENROUTER_API_KEY") or "").strip()


def _base_url() -> str:
    return (os.getenv("OPENROUTER_BASE_URL") or DEFAULT_BASE_URL).rstrip("/")


def image_model() -> str:
    return (os.getenv("OPENROUTER_IMAGE_MODEL") or DEFAULT_IMAGE_MODEL).strip()


def text_model() -> str:
    return (os.getenv("OPENROUTER_TEXT_MODEL") or DEFAULT_TEXT_MODEL).strip()


def is_configured() -> bool:
    """False when no API key is set — callers degrade instead of erroring."""
    return bool(_api_key())


def _headers() -> dict[str, str]:
    headers = {
        "Authorization": f"Bearer {_api_key()}",
        "Content-Type": "application/json",
    }
    # Optional OpenRouter attribution headers; harmless when unset.
    referer = (os.getenv("OPENROUTER_SITE_URL") or "").strip()
    if referer:
        headers["HTTP-Referer"] = referer
    headers["X-Title"] = (os.getenv("OPENROUTER_SITE_NAME") or "Lumina").strip()
    return headers


def prepare_image(raw: bytes, max_edge: int = MAX_UPLOAD_EDGE) -> tuple[str, tuple[int, int]]:
    """EXIF-rotate, downscale and JPEG-encode `raw` into a base64 data URL."""
    from PIL import Image, ImageOps

    with Image.open(io.BytesIO(raw)) as img:
        img = ImageOps.exif_transpose(img).convert("RGB")
        if max(img.size) > max_edge:
            scale = max_edge / max(img.size)
            img = img.resize(
                (max(1, round(img.width * scale)), max(1, round(img.height * scale))),
                Image.LANCZOS,
            )
        size = img.size
        buf = io.BytesIO()
        img.save(buf, format="JPEG", quality=92)

    b64 = base64.b64encode(buf.getvalue()).decode()
    return f"data:image/jpeg;base64,{b64}", size


def _post(payload: dict) -> dict:
    if not is_configured():
        raise OpenRouterError(
            "OPENROUTER_API_KEY is not set. Add it to backend/.env to enable AI features."
        )
    try:
        with httpx.Client(timeout=_TIMEOUT) as client:
            response = client.post(
                f"{_base_url()}/chat/completions", headers=_headers(), json=payload
            )
    except httpx.HTTPError as exc:
        raise OpenRouterError(f"Could not reach OpenRouter: {exc}") from exc

    if response.status_code != 200:
        detail = response.text[:400]
        raise OpenRouterError(f"OpenRouter returned {response.status_code}: {detail}")

    try:
        return response.json()
    except ValueError as exc:
        raise OpenRouterError("OpenRouter returned a non-JSON response.") from exc


def edit_image(
    image_bytes: bytes,
    prompt: str,
    *,
    model: Optional[str] = None,
) -> tuple[bytes, float]:
    """Send one photo + an instruction, get the edited photo back.

    Returns `(png_or_jpeg_bytes, usd_cost)`. `usd_cost` is 0.0 when OpenRouter
    does not report one.
    """
    data_url, _ = prepare_image(image_bytes)
    payload = {
        "model": model or image_model(),
        "modalities": ["image", "text"],
        "messages": [
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": prompt},
                    {"type": "image_url", "image_url": {"url": data_url}},
                ],
            }
        ],
    }

    data = _post(payload)
    choices = data.get("choices") or []
    if not choices:
        raise OpenRouterError("OpenRouter returned no choices.")

    message = choices[0].get("message") or {}
    if message.get("refusal"):
        raise OpenRouterError(f"The image model declined this edit: {message['refusal']}")

    images = message.get("images") or []
    if not images:
        text = (message.get("content") or "").strip()
        hint = f" Model said: {text[:200]}" if text else ""
        raise OpenRouterError(f"The model returned no image.{hint}")

    url = (images[0].get("image_url") or {}).get("url") or ""
    if "," not in url:
        raise OpenRouterError("The model returned a malformed image payload.")

    try:
        out = base64.b64decode(url.split(",", 1)[1])
    except (ValueError, TypeError) as exc:
        raise OpenRouterError("Could not decode the returned image.") from exc

    cost = float((data.get("usage") or {}).get("cost") or 0.0)
    return out, cost


def complete_text(
    prompt: str,
    *,
    system: Optional[str] = None,
    model: Optional[str] = None,
    max_tokens: int = 1024,
) -> str:
    """Plain text completion — used for collage titles and blurbs."""
    messages = []
    if system:
        messages.append({"role": "system", "content": system})
    messages.append({"role": "user", "content": prompt})

    data = _post(
        {
            "model": model or text_model(),
            "messages": messages,
            "max_tokens": max_tokens,
        }
    )
    choices = data.get("choices") or []
    if not choices:
        raise OpenRouterError("OpenRouter returned no choices.")
    return ((choices[0].get("message") or {}).get("content") or "").strip()
