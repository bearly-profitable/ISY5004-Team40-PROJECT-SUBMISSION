"""CLIP-based cross-modal search and zero-shot event naming.

Uses openai/clip-vit-base-patch32 via transformers. At Lumina's scale
(hundreds of photos per session) brute-force cosine over a numpy matrix is
exact and effectively instant, so no ANN index (FAISS et al.) is needed —
that only pays off around ~100K+ vectors.
"""
from __future__ import annotations

from typing import Dict, List, Optional, Sequence, Tuple

import numpy as np

CLIP_MODEL_ID = "openai/clip-vit-base-patch32"

# Prompt bank for zero-shot event naming. Each entry: (label, prompt).
# Prompts follow the CLIP "a photo of ..." convention which the model was
# trained to score well.
EVENT_PROMPT_BANK: List[Tuple[str, str]] = [
    # Celebrations
    ("Wedding", "a photo taken at a wedding ceremony"),
    ("Birthday", "a photo of a birthday celebration with a cake"),
    ("Party", "a photo of a party with people celebrating"),
    ("Graduation", "a photo of a graduation ceremony"),
    ("Christmas", "a photo of a christmas celebration with a christmas tree and decorations"),
    # Food & drink
    ("Cafe", "a photo of people having coffee and food at a cafe"),
    ("Breakfast", "a photo of people eating breakfast together"),
    ("Dinner", "a photo of people having dinner at a restaurant"),
    ("Hawker Meal", "a photo of people eating at a food court or hawker centre"),
    ("Picnic", "a photo of a picnic in a park"),
    # Outdoors & travel
    ("Beach", "a photo taken at the beach"),
    ("Hiking", "a photo of people hiking outdoors in nature"),
    ("Travel", "a photo of tourists sightseeing at a landmark"),
    ("Garden", "a photo of people in a garden with plants and flowers"),
    ("Camping", "a photo of a camping trip with tents"),
    ("Pool", "a photo of people at a swimming pool"),
    ("Street", "a photo of people walking on a city street"),
    # Indoors & everyday
    ("At Home", "a photo of people relaxing at home in a living room"),
    ("Family Gathering", "a photo of a family gathering at home"),
    ("Shopping", "a photo of people shopping at a mall or market"),
    ("Museum", "a photo taken inside a museum or gallery"),
    ("Meeting", "a photo of a business meeting or conference"),
    ("Night Out", "a photo of friends out at night in the city"),
    ("Concert", "a photo taken at a concert or live music event"),
    ("Sports", "a photo of people playing sports"),
    ("Selfie Session", "a close-up selfie photo of people posing"),
]

# Below this cosine similarity we keep the generic "Event N" label rather
# than guess wrong. Unrelated ViT-B/32 text-image pairs routinely reach
# ~0.20-0.23, so the floor sits above that noise band; a richer prompt bank
# (above) does the rest by giving everyday scenes a correct nearest prompt.
EVENT_NAME_MIN_SIM = 0.25


class ClipEngine:
    """Lazy-loading wrapper around CLIP for image/text embedding."""

    def __init__(self, device=None):
        self._model = None
        self._processor = None
        self._device = device
        self._prompt_matrix: Optional[np.ndarray] = None

    def _ensure_loaded(self) -> None:
        if self._model is not None:
            return
        import torch
        from transformers import CLIPModel, CLIPProcessor

        if self._device is None:
            self._device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
        self._processor = CLIPProcessor.from_pretrained(CLIP_MODEL_ID)
        self._model = CLIPModel.from_pretrained(CLIP_MODEL_ID).to(self._device).eval()

    @staticmethod
    def _as_projected_tensor(features):
        """Normalise across transformers versions: v4 returns the projected
        tensor directly; v5 returns a BaseModelOutputWithPooling whose
        pooler_output holds the projected (joint-space) embedding."""
        import torch

        if torch.is_tensor(features):
            return features
        return features.pooler_output

    # ------------------------------------------------------------ embeddings
    def embed_images(self, pil_images: Sequence, batch_size: int = 16) -> np.ndarray:
        """(n, 512) L2-normalised image embeddings."""
        self._ensure_loaded()
        import torch

        chunks: List[np.ndarray] = []
        for start in range(0, len(pil_images), batch_size):
            batch = list(pil_images[start:start + batch_size])
            inputs = self._processor(images=batch, return_tensors="pt").to(self._device)
            with torch.inference_mode():
                feats = self._as_projected_tensor(self._model.get_image_features(**inputs))
            feats = feats / feats.norm(dim=-1, keepdim=True)
            chunks.append(feats.cpu().numpy().astype(np.float32))
        return np.concatenate(chunks, axis=0) if chunks else np.zeros((0, 512), dtype=np.float32)

    def embed_texts(self, texts: Sequence[str]) -> np.ndarray:
        """(n, 512) L2-normalised text embeddings."""
        self._ensure_loaded()
        import torch

        inputs = self._processor(text=list(texts), return_tensors="pt", padding=True, truncation=True).to(self._device)
        with torch.inference_mode():
            feats = self._as_projected_tensor(self._model.get_text_features(**inputs))
        feats = feats / feats.norm(dim=-1, keepdim=True)
        return feats.cpu().numpy().astype(np.float32)

    # ---------------------------------------------------------------- search
    # Bare nouns ("baby") land in a weak region of CLIP's text space and rank
    # poorly; the standard fix is prompt-template ensembling — embed several
    # phrasings and average the normalised vectors (as in the CLIP paper's
    # zero-shot protocol).
    QUERY_TEMPLATES = (
        "a photo of {}",
        "a photo of a {}",
        "a photograph featuring {}",
        "{}",
    )

    def embed_query(self, query: str) -> np.ndarray:
        prompts = [t.format(query) for t in self.QUERY_TEMPLATES]
        embs = self.embed_texts(prompts)
        mean = embs.mean(axis=0)
        norm = np.linalg.norm(mean)
        return mean / norm if norm > 0 else mean

    def search(
        self,
        query: str,
        image_embeddings: np.ndarray,
        photo_ids: List[str],
        top_k: int = 12,
    ) -> List[Dict]:
        """Rank photos by cosine similarity to a natural-language query."""
        if image_embeddings.shape[0] == 0:
            return []
        text_emb = self.embed_query(query)
        sims = image_embeddings @ text_emb
        order = np.argsort(-sims)[:top_k]
        return [
            {"photoId": photo_ids[i], "score": round(float(sims[i]), 4)}
            for i in order
        ]

    # ---------------------------------------------------------- event naming
    def _prompts(self) -> np.ndarray:
        if self._prompt_matrix is None:
            self._prompt_matrix = self.embed_texts([p for _, p in EVENT_PROMPT_BANK])
        return self._prompt_matrix

    def name_event(self, event_image_embeddings: np.ndarray) -> Optional[Dict]:
        """Zero-shot label for an event from its member photos' CLIP embeddings.

        Returns {"label", "confidence"} or None when no prompt clears the floor.
        """
        if event_image_embeddings.shape[0] == 0:
            return None
        centroid = event_image_embeddings.mean(axis=0)
        norm = np.linalg.norm(centroid)
        if norm == 0:
            return None
        centroid = centroid / norm
        sims = self._prompts() @ centroid
        best = int(np.argmax(sims))
        if float(sims[best]) < EVENT_NAME_MIN_SIM:
            return None
        return {
            "label": EVENT_PROMPT_BANK[best][0],
            "confidence": round(float(sims[best]), 4),
        }
