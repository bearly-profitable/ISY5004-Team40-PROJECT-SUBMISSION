"""Event-clustering evaluation against ground-truth event labels.

Usage:
    python eval/eval_events.py <dataset_dir>

Reads <dataset_dir>/labels.csv (columns: filename,event[,person]) and reports
ARI / NMI of the DINO + agglomerative (silhouette-swept) event clustering.
Ground truth can come from timestamps (photos within one outing = one event)
or a benchmark like the Photo Event Collection (PEC).
"""
from __future__ import annotations

import argparse
from pathlib import Path

from common import (
    clustering_scores,
    collect_images,
    load_labels,
    predicted_event_labels,
    print_table,
    run_pipeline,
)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("dataset_dir", type=Path)
    args = parser.parse_args()

    rows = load_labels(args.dataset_dir)
    labeled = [r for r in rows if r.get("event")]
    if not labeled:
        raise SystemExit("labels.csv has no `event` labels.")
    image_paths, photo_ids = collect_images(args.dataset_dir, labeled)
    true_by_id = {r["filename"]: r["event"] for r in labeled}

    result = run_pipeline(image_paths, photo_ids)
    predicted = predicted_event_labels(result)

    evaluable = [pid for pid in photo_ids if pid in predicted]
    scores = clustering_scores(
        [true_by_id[p] for p in evaluable],
        [predicted[p] for p in evaluable],
    )
    print_table("Event clustering", [scores])

    # Bonus: how often did CLIP auto-naming fire, and with what confidence?
    named = [e for e in result["events"] if e.get("autoLabel")]
    print(f"CLIP auto-named {len(named)}/{len(result['events'])} events:")
    for evt in named:
        print(f"  {evt['id']}: {evt['autoLabel']['label']} (conf {evt['autoLabel']['confidence']:.2f})")


if __name__ == "__main__":
    main()
