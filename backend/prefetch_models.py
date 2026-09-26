"""Download every model weight into the image at build time.

The server preloads all models before it answers /api/health. Without this
step each fresh container would fetch ~1 GB (DINO, CLIP, BLIP, buffalo_l,
OSNet, NIMA) on boot, which is slow and can outlast the platform healthcheck.

Run from the backend directory:  python prefetch_models.py
"""
from lumina_pipeline import LuminaPipeline

pipeline = LuminaPipeline()
pipeline._load_models()
if pipeline.captioner is not None and not pipeline.captioner._ensure_loaded():
    raise SystemExit("Captioner weights failed to download.")
print("[Lumina] All model weights cached.")
