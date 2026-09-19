"""Embedding-cache speedup benchmark (cold run vs warm run).

Usage:
    python eval/eval_speed.py <image_dir>

Runs the full pipeline twice over the same folder. The first (cold) run
computes and caches every per-image feature; the second (warm) run reuses the
SQLite embedding cache keyed by image content hash. Reports wall-clock per
stage and the end-to-end speedup — the concrete "incremental processing"
number for the report (proposal target: <90 s for 80 images cold).
"""
from __future__ import annotations

import argparse
import time
from pathlib import Path

from common import BACKEND_DIR, IMAGE_EXTS, print_table


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("image_dir", type=Path)
    parser.add_argument("--fresh-cache", action="store_true",
                        help="Delete the eval cache first so the first run is truly cold")
    args = parser.parse_args()

    cache_db = BACKEND_DIR / "eval" / "eval_cache.db"
    if args.fresh_cache:
        for suffix in ("", "-wal", "-shm"):
            path = Path(str(cache_db) + suffix)
            if path.exists():
                path.unlink()

    image_paths = sorted(p for p in args.image_dir.iterdir() if p.suffix.lower() in IMAGE_EXTS)
    if not image_paths:
        raise SystemExit(f"No images found in {args.image_dir}")
    photo_ids = [p.name for p in image_paths]

    from lumina_pipeline import LuminaPipeline
    from store import LuminaStore

    store = LuminaStore(cache_db)
    pipeline = LuminaPipeline(store=store)
    print("Loading models (excluded from timings)…")
    pipeline._load_models()

    rows = []
    for label in ("cold", "warm"):
        start = time.time()
        result = pipeline.run(image_paths=image_paths, photo_ids=photo_ids)
        elapsed = time.time() - start
        summary = result["summary"]
        rows.append({
            "run": label,
            "photos": summary["numPhotos"],
            "cache_hits": summary["cacheHits"],
            "total_s": elapsed,
            **{f"{k}_s": v for k, v in summary.get("timings", {}).items() if k != "total"},
        })

    print_table("Cold vs warm pipeline runs", rows)
    speedup = rows[0]["total_s"] / max(rows[1]["total_s"], 1e-9)
    print(f"End-to-end speedup from embedding cache: {speedup:.1f}x")
    print(f"Proposal target: < 90 s for 80 images (cold). Measured cold: {rows[0]['total_s']:.1f} s for {len(image_paths)}.")


if __name__ == "__main__":
    main()
