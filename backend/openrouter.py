"""Thin OpenRouter client for Lumina's generative features.

OpenRouter exposes two different image surfaces, and the difference matters:

- **`/chat/completions`** with `modalities: ["image", "text"]` accepts an input
  image as a content part and returns an edited one. This is the only transport
  that can *retouch* an existing photograph.
- **`/images`** takes `{model, prompt}` and returns `data[].b64_json`. It is
  text-to-image only: every input-image parameter is accepted and then silently
  ignored, so asking it to "enhance this photo" returns a picture of somebody
  else entirely.

`openai/gpt-image-2.5-flare` is only served on `/images`, so it cannot be used
for enhancement — see `MODELS_WITHOUT_EDITING`. It is still reachable through
`generate_image()` for text-to-image work.

Model choice for editing also matters. The OpenAI image models accept the input
but re-render the scene at one of their fixed output sizes, so framing and
aspect ratio shift. The Gemini image models edit in place and hold composition.
Both are swappable via `OPENROUTER_IMAGE_MODEL`; the ArcFace guard in
`enhance.py` is what stops a bad edit reaching the user either way.
"""
from __future__ import annotations

import base64
import io
import os
from typing import Optional

import httpx

DEFAULT_BASE_URL = "https://openrouter.ai/api/v1"
DEFAULT_IMAGE_MODEL = "openai/gpt-5.4-image-2"
DEFAULT_TEXT_MODEL = "openai/gpt-5.6-luna"

# Models served only on the text-to-image `/images` endpoint. Using one of these
# to "enhance" a photo would discard the photo, so enhancement refuses them
# with an explanation rather than silently returning an invented image.
MODELS_WITHOUT_EDITING = {
    "openai/gpt-image-2.5-flare",
    "openai/gpt-image-1",
    "openai/dall-e-3",
    "openai/dall-e-2",
}

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


def can_edit_images(model: Optional[str] = None) -> bool:
    return (model or image_model()) not in MODELS_WITHOUT_EDITING


def is_configured() -> bool:
    """False when no API key is set — callers degrade instead of erroring."""
    return bool(_api_key())


def _headers() -> dict[str, str]:
    headers = {
        "Authorization": f"Bearer {_api_key()}",
        "Content-Type": "application/json",
    }
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


def _post(path: str, payload: dict) -> dict:
    if not is_configured():
        raise OpenRouterError(
            "OPENROUTER_API_KEY is not set. Add it to backend/.env to enable AI features."
        )
    try:
        with httpx.Client(timeout=_TIMEOUT) as client:
            response = client.post(f"{_base_url()}{path}", headers=_headers(), json=payload)
    except httpx.HTTPError as exc:
        raise OpenRouterError(f"Could not reach OpenRouter: {exc}") from exc

    if response.status_code != 200:
        raise OpenRouterError(f"OpenRouter returned {response.status_code}: {response.text[:400]}")

    try:
        return response.json()
    except ValueError as exc:
        raise OpenRouterError("OpenRouter returned a non-JSON response.") from exc


def _decode_data_url(url: str) -> bytes:
    if "," not in url:
        raise OpenRouterError("The model returned a malformed image payload.")
    try:
        return base64.b64decode(url.split(",", 1)[1])
    except (ValueError, TypeError) as exc:
        raise OpenRouterError("Could not decode the returned image.") from exc


def edit_image(
    image_bytes: bytes,
    prompt: str,
    *,
    model: Optional[str] = None,
) -> tuple[bytes, float]:
    """Send one photo + an instruction, get the edited photo back.

    Returns `(image_bytes, usd_cost)`. Raises if the configured model cannot
    edit, rather than returning an unrelated generated image.
    """
    chosen = model or image_model()
    if not can_edit_images(chosen):
        raise OpenRouterError(
            f"'{chosen}' is a text-to-image model on OpenRouter: it ignores the photo "
            f"you send and invents a new one, so it cannot be used to enhance a "
            f"photograph. Set OPENROUTER_IMAGE_MODEL to an image-editing model such as "
            f"'{DEFAULT_IMAGE_MODEL}' or 'google/gemini-3.1-flash-image'."
        )

    data_url, _ = prepare_image(image_bytes)
    data = _post("/chat/completions", {
        "model": chosen,
        "modalities": ["image", "text"],
        "messages": [{
            "role": "user",
            "content": [
                {"type": "text", "text": prompt},
                {"type": "image_url", "image_url": {"url": data_url}},
            ],
        }],
    })

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

    out = _decode_data_url((images[0].get("image_url") or {}).get("url") or "")
    cost = float((data.get("usage") or {}).get("cost") or 0.0)
    return out, cost


def generate_image(prompt: str, *, model: Optional[str] = None) -> bytes:
    """Text-to-image via `/images`. No input photo — this creates a new image."""
    data = _post("/images", {"model": model or image_model(), "prompt": prompt})
    entries = data.get("data") or []
    if not entries:
        raise OpenRouterError("OpenRouter returned no image data.")

    entry = entries[0]
    if entry.get("b64_json"):
        try:
            return base64.b64decode(entry["b64_json"])
        except (ValueError, TypeError) as exc:
            raise OpenRouterError("Could not decode the generated image.") from exc
    if entry.get("url"):
        return _decode_data_url(entry["url"])
    raise OpenRouterError("OpenRouter returned an image entry with no payload.")


def complete_text(
    prompt: str,
    *,
    system: Optional[str] = None,
    model: Optional[str] = None,
    max_tokens: int = 1024,
) -> str:
    """Plain text completion — used for album titles and photo captions."""
    messages = []
    if system:
        messages.append({"role": "system", "content": system})
    messages.append({"role": "user", "content": prompt})

    data = _post("/chat/completions", {
        "model": model or text_model(),
        "messages": messages,
        "max_tokens": max_tokens,
    })
    choices = data.get("choices") or []
    if not choices:
        raise OpenRouterError("OpenRouter returned no choices.")
    return ((choices[0].get("message") or {}).get("content") or "").strip()


def describe_images(
    images: list[bytes],
    context: str = "",
    *,
    model: Optional[str] = None,
) -> list[str]:
    """Short captions for a batch of photos, one per input, in order.

    Used for album labels. Returns `[]` on any failure — captions are a nicety
    and must never break an export.
    """
    if not images:
        return []

    content: list[dict] = [{
        "type": "text",
        "text": (
            f"These are {len(images)} photos from one album."
            + (f" Context: {context}." if context else "")
            + f"\n\nWrite a caption for each photo, in order. Each caption is a title:"
            f" 2 to 4 words, title case, concrete and specific to what you can actually"
            f" see. No quotes, no numbering, no trailing punctuation. Never invent a"
            f" place, date, event or name you were not given."
            f"\n\nReply with exactly {len(images)} lines, one caption per line."
        ),
    }]
    for raw in images:
        data_url, _ = prepare_image(raw, max_edge=512)
        content.append({"type": "image_url", "image_url": {"url": data_url}})

    data = _post("/chat/completions", {
        "model": model or text_model(),
        "messages": [{"role": "user", "content": content}],
        "max_tokens": 40 * len(images) + 200,
    })
    choices = data.get("choices") or []
    if not choices:
        return []

    text = ((choices[0].get("message") or {}).get("content") or "").strip()
    lines = [
        line.strip().lstrip("0123456789.-) ").strip().strip('"').rstrip(".")
        for line in text.splitlines()
        if line.strip()
    ]
    return lines[: len(images)]
