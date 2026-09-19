"""Shared helpers for the evaluation harness.

Dataset conventions
-------------------
A labeled dataset is a directory of images plus a `labels.csv` with columns:

    filename,person,event

- `person`: ground-truth identity of the main subject (blank if none).
  For multi-person photos, list identities separated by `;`.
- `event`:  ground-truth event/scene group id (blank if unknown).

Only the columns a given eval needs must be filled in. Build this once with
the semi-automatic workflow: run Lumina on the folder, then correct its
output in the gallery UI — the corrections log gives you the diff.
"""
from __future__ import annotations

import csv
import sys
from pathlib import Path
from typing import Dict, List, Optional, Tuple

BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".webp", ".bmp"}


def load_labels(dataset_dir: Path) -> List[Dict[str, str]]:
    labels_path = dataset_dir / "labels.csv"
    if not labels_path.is_file():
        raise SystemExit(f"Missing {labels_path}. See eval/common.py for the expected format.")
    with open(labels_path, newline="", encoding="utf-8-sig") as f:
        rows = list(csv.DictReader(f))
    if not rows:
        raise SystemExit("labels.csv is empty.")
    missing = [r["filename"] for r in rows if not (dataset_dir / r["filename"]).is_file()]
    if missing:
        raise SystemExit(f"{len(missing)} labeled file(s) not found, e.g. {missing[:3]}")
    return rows


def collect_images(dataset_dir: Path, rows: List[Dict[str, str]]) -> Tuple[List[Path], List[str]]:
    """Returns (image_paths, photo_ids) where photo_id == filename."""
    paths, ids = [], []
    for row in rows:
        path = dataset_dir / row["filename"]
        if path.suffix.lower() in IMAGE_EXTS:
            paths.append(path)
            ids.append(row["filename"])
    return paths, ids


def run_pipeline(
    image_paths: List[Path],
    photo_ids: List[str],
    identity_mode: str = "fused",
    use_cache: bool = True,
    enable_clip: bool = True,
):
    """Run the full Lumina pipeline over a labeled set and return the result dict."""
    from lumina_pipeline import LuminaPipeline, PipelineConfig
    from store import LuminaStore

    store = LuminaStore(BACKEND_DIR / "eval" / "eval_cache.db") if use_cache else None
    cfg = PipelineConfig(identity_mode=identity_mode, enable_clip=enable_clip)
    pipeline = LuminaPipeline(config=cfg, store=store)

    def progress(_key: str, label: str, pct: int) -> None:
        print(f"\r  [{pct:3d}%] {label:<60}", end="", flush=True)

    result = pipeline.run(image_paths=image_paths, photo_ids=photo_ids, callback=progress)
    print()
    return result


def predicted_identity_labels(result: dict, photo_ids: List[str]) -> Dict[str, str]:
    """photo_id -> predicted person id of the *first* identity containing it.

    For single-subject eval photos this is exact; multi-person photos should
    be evaluated per-face with a dedicated protocol (documented limitation).
    """
    assignment: Dict[str, str] = {}
    for ident in result.get("identities", []):
        for photo_id in ident["photoIds"]:
            assignment.setdefault(photo_id, ident["id"])
    return assignment


def predicted_event_labels(result: dict) -> Dict[str, str]:
    assignment: Dict[str, str] = {}
    for evt in result.get("events", []):
        for photo_id in evt["photoIds"]:
            assignment[photo_id] = evt["id"]
    return assignment


def clustering_scores(true_labels: List[str], pred_labels: List[str]) -> Dict[str, float]:
    from sklearn.metrics import adjusted_rand_score, normalized_mutual_info_score

    return {
        "ARI": float(adjusted_rand_score(true_labels, pred_labels)),
        "NMI": float(normalized_mutual_info_score(true_labels, pred_labels)),
        "n": len(true_labels),
        "true_clusters": len(set(true_labels)),
        "pred_clusters": len(set(pred_labels)),
    }


def print_table(title: str, rows: List[Dict], columns: Optional[List[str]] = None) -> None:
    if not rows:
        print(f"{title}: no rows")
        return
    cols = columns or list(rows[0].keys())
    widths = {c: max(len(c), *(len(_fmt(r.get(c))) for r in rows)) for c in cols}
    print(f"\n== {title} ==")
    print(" | ".join(c.ljust(widths[c]) for c in cols))
    print("-+-".join("-" * widths[c] for c in cols))
    for row in rows:
        print(" | ".join(_fmt(row.get(c)).ljust(widths[c]) for c in cols))
    print()


def _fmt(value) -> str:
    if isinstance(value, float):
        return f"{value:.4f}"
    return str(value)
