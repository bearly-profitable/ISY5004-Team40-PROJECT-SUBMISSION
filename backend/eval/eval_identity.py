"""Identity-clustering ablation: face-only vs body-only vs fused.

Usage:
    python eval/eval_identity.py <dataset_dir> [--modes fused face_only body_only]

Reads <dataset_dir>/labels.csv (columns: filename,person[,event]) and reports
ARI / NMI per identity mode — the headline ablation table for the report
(proposal target: ARI > 0.85).

Photos with multiple people (`;`-separated labels) are excluded here; they
need per-face matching, which this simple protocol doesn't attempt.
"""
from __future__ import annotations

import argparse
import csv
from pathlib import Path

from common import (
    clustering_scores,
    collect_images,
    load_labels,
    predicted_identity_labels,
    print_table,
    run_pipeline,
)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("dataset_dir", type=Path)
    parser.add_argument("--modes", nargs="+", default=["fused", "face_only", "body_only"])
    parser.add_argument("--csv-out", type=Path, default=None, help="Also write results as CSV")
    args = parser.parse_args()

    rows = load_labels(args.dataset_dir)
    labeled = [r for r in rows if r.get("person") and ";" not in r["person"]]
    skipped = len(rows) - len(labeled)
    if skipped:
        print(f"Skipping {skipped} photo(s) without a single-person label.")
    image_paths, photo_ids = collect_images(args.dataset_dir, labeled)
    true_by_id = {r["filename"]: r["person"] for r in labeled}

    results = []
    for mode in args.modes:
        print(f"\n### identity_mode = {mode} ({len(image_paths)} photos)")
        result = run_pipeline(image_paths, photo_ids, identity_mode=mode)
        predicted = predicted_identity_labels(result, photo_ids)

        evaluable = [pid for pid in photo_ids if pid in predicted]
        unassigned = len(photo_ids) - len(evaluable)
        scores = clustering_scores(
            [true_by_id[p] for p in evaluable],
            [predicted[p] for p in evaluable],
        )
        results.append({"mode": mode, **scores, "unassigned": unassigned})

    print_table(
        "Identity clustering ablation",
        results,
        columns=["mode", "ARI", "NMI", "n", "true_clusters", "pred_clusters", "unassigned"],
    )
    print("Proposal target: ARI > 0.85 (report the measured number either way).")

    if args.csv_out:
        with open(args.csv_out, "w", newline="", encoding="utf-8") as f:
            writer = csv.DictWriter(f, fieldnames=list(results[0].keys()))
            writer.writeheader()
            writer.writerows(results)
        print(f"Wrote {args.csv_out}")


if __name__ == "__main__":
    main()
