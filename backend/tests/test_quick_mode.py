"""Analysis off ("quick" mode): one CLIP pass per photo, no curation."""
import io

import numpy as np
from PIL import Image

from lumina_pipeline import LuminaPipeline


class FakeClip:
    """Photo i's embedding is the i-th basis vector; name_event labels it."""

    def __init__(self):
        self.calls = 0

    def embed_images(self, pil_images, batch_size=16):
        self.calls += 1
        out = np.zeros((len(pil_images), 512), dtype=np.float32)
        for row, img in enumerate(pil_images):
            out[row, img.getpixel((0, 0))[0] % 512] = 1.0  # red channel tags the photo
        return out

    def name_event(self, embs):
        idx = int(np.argmax(embs.mean(axis=0)))
        return None if idx == 30 else {"label": f"Scene {idx}", "confidence": 0.3}


def _photo(path, red, taken=None):
    exif = Image.Exif()
    if taken:
        exif[306] = taken  # DateTime
    Image.new("RGB", (64, 48), (red, 0, 0)).save(path, format="JPEG", quality=100, exif=exif)


def test_run_quick_describes_photos_in_capture_order(tmp_path):
    a, b, c = tmp_path / "a.jpg", tmp_path / "b.jpg", tmp_path / "c.jpg"
    _photo(a, 10, "2026:01:02 12:00:00")
    _photo(b, 20, "2026:01:02 09:00:00")
    _photo(c, 30)  # no EXIF: goes last; its scene is too uncertain to label

    pipeline = LuminaPipeline()
    pipeline._load_models = lambda: None
    pipeline.clip = FakeClip()
    steps = []
    result = pipeline.run_quick([a, b, c], ["pa", "pb", "pc"],
                                callback=lambda key, label, pct, meta=None: steps.append(key))

    assert result["summary"]["mode"] == "quick"
    assert result["identities"] == []
    [event] = result["events"]
    assert event["photoIds"] == ["pb", "pa", "pc"]
    assert event["bestByPerson"] == [] and event["mmrPicks"] == {}
    contexts = {m["photoId"]: m["context"] for m in event["members"]}
    assert contexts["pc"] is None
    assert contexts["pa"] == "Scene 10" and contexts["pb"] == "Scene 20"
    assert all(not m.get("flags") for m in event["members"])
    assert sorted(result["_clipIndex"]["photoIds"]) == ["pa", "pb", "pc"]
    # None of the curation stages ran.
    assert "describing" in steps and "identity_clustering" not in steps and "quality_scoring" not in steps
