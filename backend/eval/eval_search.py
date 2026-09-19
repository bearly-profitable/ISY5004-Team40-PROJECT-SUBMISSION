"""CLIP cross-modal search: Recall@K against a hand-written query set.

Usage:
    python eval/eval_search.py <dataset_dir>

Expects <dataset_dir>/queries.csv with columns:

    query,relevant
    "people hugging on a beach","img_012.jpg;img_047.jpg"

`relevant` lists all filenames that a human judges relevant to the query,
separated by `;`. Reports Recall@1/5/10 (proposal target: Recall@5 > 0.75).
"""
from __future__ import annotations

import argparse
import csv
from pathlib import Path

import numpy as np

from common import IMAGE_EXTS, print_table, run_pipeline


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("dataset_dir", type=Path)
    parser.add_argument("--ks", nargs="+", type=int, default=[1, 5, 10])
    args = parser.parse_args()

    queries_path = args.dataset_dir / "queries.csv"
    if not queries_path.is_file():
        raise SystemExit(f"Missing {queries_path} (columns: query,relevant).")
    with open(queries_path, newline="", encoding="utf-8-sig") as f:
        queries = [
            (row["query"], {x.strip() for x in row["relevant"].split(";") if x.strip()})
            for row in csv.DictReader(f)
        ]
    if not queries:
        raise SystemExit("queries.csv is empty.")

    image_paths = sorted(
        p for p in args.dataset_dir.iterdir() if p.suffix.lower() in IMAGE_EXTS
    )
    photo_ids = [p.name for p in image_paths]

    result = run_pipeline(image_paths, photo_ids, enable_clip=True)
    clip_index = result.get("_clipIndex")
    if clip_index is None:
        raise SystemExit("Pipeline produced no CLIP index — is enable_clip on?")

    from clip_search import ClipEngine

    engine = ClipEngine()
    matrix = np.asarray(clip_index["matrix"], dtype=np.float32)
    ids = clip_index["photoIds"]

    max_k = max(args.ks)
    per_query = []
    recalls = {k: [] for k in args.ks}
    for query, relevant in queries:
        hits = engine.search(query, matrix, ids, top_k=max_k)
        ranked = [h["photoId"] for h in hits]
        row = {"query": query, "relevant": len(relevant)}
        for k in args.ks:
            top_k = set(ranked[:k])
            recall = len(top_k & relevant) / len(relevant) if relevant else 0.0
            recalls[k].append(recall)
            row[f"R@{k}"] = recall
        per_query.append(row)

    print_table("Per-query recall", per_query)
    summary = [{"metric": f"Recall@{k}", "mean": float(np.mean(recalls[k]))} for k in args.ks]
    print_table("Summary", summary)
    print("Proposal target: Recall@5 > 0.75 (report the measured number either way).")


if __name__ == "__main__":
    main()
