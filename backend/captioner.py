"""Event captioning with BLIP (one caption per event's best shot).

BLIP-base (~990MB) is chosen over Florence-2 for reliability: it has a
stable first-class transformers integration (no trust_remote_code), runs
acceptably on CPU (~2-4s per image), and one caption per *event* keeps the
total cost to a handful of images per run. Failures degrade to no caption —
captioning must never fail an analysis.
"""
from __future__ import annotations

from typing import Optional

CAPTION_MODEL_ID = "Salesforce/blip-image-captioning-base"


class EventCaptioner:
    def __init__(self, device=None):
        self._model = None
        self._processor = None
        self._device = device
        self._failed = False  # remember a load failure; don't retry every event

    def _ensure_loaded(self) -> bool:
        if self._model is not None:
            return True
        if self._failed:
            return False
        try:
            import torch
            from transformers import BlipForConditionalGeneration, BlipProcessor

            if self._device is None:
                self._device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
            self._processor = BlipProcessor.from_pretrained(CAPTION_MODEL_ID)
            self._model = (
                BlipForConditionalGeneration.from_pretrained(CAPTION_MODEL_ID)
                .to(self._device)
                .eval()
            )
            return True
        except Exception as exc:
            print(f"[Lumina] Captioner unavailable ({exc}); events will not be captioned.")
            self._failed = True
            return False

    def caption(self, pil_image) -> Optional[str]:
        """One-sentence description of an image, or None on any failure."""
        if not self._ensure_loaded():
            return None
        try:
            import torch

            inputs = self._processor(images=pil_image, return_tensors="pt").to(self._device)
            with torch.inference_mode():
                out = self._model.generate(**inputs, max_new_tokens=32, num_beams=3)
            text = self._processor.decode(out[0], skip_special_tokens=True).strip()
            if not text:
                return None
            return text[0].upper() + text[1:]
        except Exception:
            return None
