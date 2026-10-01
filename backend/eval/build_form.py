"""Build questions 15-25 for the human-study form.

Q01-Q14 stay as they are. Q15-Q18 are four more "which photo would you keep"
occasions, used as extra training. Q19-Q25 are the harder event and people pairs.
"""

from __future__ import annotations

import csv
import json
import random
import shutil
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageOps

BACKEND_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND_DIR))

from eval.experiments import (  # noqa: E402
    IMAGE_EXTS,
    cluster_identities,
    event_label_from_name,
    load_features,
    score_truth_events,
)
from lumina_pipeline import LuminaPipeline, PipelineConfig  # noqa: E402
from store import LuminaStore  # noqa: E402

ROOT = BACKEND_DIR.parent
DATASET = ROOT / "report" / "Test Images"
STUDY = ROOT / "report" / "human_study"
FORM = STUDY / "form"
CONFIG = STUDY / "config.json"
CACHE = BACKEND_DIR / "eval" / "experiments_cache_dinov3.db"
N_EVENT_PAIRS = 4
N_PERSON_PAIRS = 3
EXTRA_TRAIN = ("6", "17", "18", "1")
# The one occasion Lumina split. Asked first, then the closest other boundaries.
SPLIT_PAIR = ("17-1.jpeg", "17-3.jpeg")


def load_rgb(path: Path) -> Image.Image:
    return ImageOps.exif_transpose(Image.open(path).convert("RGB"))


def face_crop(path: Path, bbox: list) -> Image.Image:
    im = load_rgb(path)
    w, h = im.size
    long_edge = max(w, h)
    scale = min(1280, long_edge) / long_edge
    x1, y1, x2, y2 = [v / scale for v in bbox]
    pad = 0.18 * max(x2 - x1, y2 - y1)
    box = (max(0, int(x1 - pad)), max(0, int(y1 - pad)), min(w, int(x2 + pad)), min(h, int(y2 + pad)))
    crop = im.crop(box)
    return crop if crop.size[0] > 10 and crop.size[1] > 10 else im


def collage(images: list, thumb: int = 320) -> Image.Image:
    fitted = [im.copy() for im in images]
    for im in fitted:
        im.thumbnail((thumb, thumb))
    cols = 2 if len(fitted) > 1 else 1
    if len(fitted) >= 5:
        cols = 3
    rows = (len(fitted) + cols - 1) // cols
    cell_w = max(im.width for im in fitted)
    cell_h = max(im.height for im in fitted)
    gap = 8
    canvas = Image.new("RGB", (cols * cell_w + (cols + 1) * gap, rows * cell_h + (rows + 1) * gap), (246, 244, 240))
    for i, im in enumerate(fitted):
        r, c = divmod(i, cols)
        x = gap + c * (cell_w + gap) + (cell_w - im.width) // 2
        y = gap + r * (cell_h + gap) + (cell_h - im.height) // 2
        canvas.paste(im, (x, y))
    return canvas


def main() -> None:
    paths = sorted((p for p in DATASET.iterdir() if p.suffix.lower() in IMAGE_EXTS), key=lambda p: p.name.lower())
    ids = [p.name for p in paths]
    truth = {pid: event_label_from_name(pid) for pid in ids}
    pipe = LuminaPipeline(config=PipelineConfig(enable_captions=False, enable_clip=False), store=LuminaStore(CACHE))
    features = load_features(pipe, paths, ids, truth)
    faces, persons, _ = cluster_identities(pipe, features, pipe.cfg)
    groups = pipe._cluster_events(features.dino, features.paths, features.path_to_idx, [], features.exif)

    scored = score_truth_events(pipe, features, pipe.cfg, {"faces": faces, "persons": persons})
    config = json.loads(CONFIG.read_text(encoding="utf-8"))
    already = {event["eventId"] for event in config["train"]}
    for event_id in EXTRA_TRAIN:
        if event_id in already:
            continue
        members = scored[event_id][:4]
        signed = float(members[0]["finalScore"]) - float(members[1]["finalScore"])
        config["train"].append({
            "eventId": event_id,
            "phase": "train",
            "margin": round(abs(signed), 4),
            "topTwoScoreGap": round(signed, 4),
            "defaultPhotoId": members[0]["photoId"],
            "shownPhotoIds": [m["photoId"] for m in members],
            "photos": [
                {
                    "photoId": m["photoId"],
                    "finalScore": m["finalScore"],
                    "normSignals": {k: round(float(v), 4) for k, v in m["normSignals"].items()},
                }
                for m in scored[event_id]
            ],
        })
    config["unusedEventIds"] = [eid for eid in config.get("unusedEventIds", []) if eid not in EXTRA_TRAIN]
    config["selection"] = (
        "Of the events with at least 2 photos, the 8 smallest gaps between Lumina's top two photos "
        "are the training set. The next 4 are held out. The 2 closest training events are shown a "
        "second time and are not used for learning. Events 6, 17, 18, and 1 are extra training."
    )
    CONFIG.write_text(json.dumps(config, indent=2), encoding="utf-8")

    key_rows = []
    number = 15
    rng = random.Random(42)
    for event_id in EXTRA_TRAIN:
        event = next(item for item in config["train"] if item["eventId"] == event_id)
        shown = list(event["shownPhotoIds"])
        rng.shuffle(shown)
        folder = FORM / f"Q{number:02d}"
        if folder.exists():
            shutil.rmtree(folder)
        folder.mkdir(parents=True)
        letters = "ABCDEFGH"
        for letter, photo_id in zip(letters, shown):
            src = DATASET / photo_id
            dst_name = f"{letter}{src.suffix.lower()}"
            shutil.copy2(src, folder / dst_name)
            key_rows.append({
                "question": number,
                "phase": "train",
                "event_id": event_id,
                "option": letter,
                "photo_id": photo_id,
                "is_default": int(photo_id == event["defaultPhotoId"]),
                "folder": f"Q{number:02d}",
                "file": dst_name,
            })
        print(f"Q{number:02d}  keep-photo  event {event_id}  default {event['defaultPhotoId']}  options {', '.join(shown)}")
        number += 1

    with (FORM / "key.csv").open(newline="", encoding="utf-8") as handle:
        existing = [row for row in csv.DictReader(handle) if int(row["question"]) < 15]
    with (FORM / "key.csv").open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=list(existing[0].keys()))
        writer.writeheader()
        writer.writerows(existing + key_rows)

    questions = []

    def add(kind: str, prompt: str, choices: str, images: list, detail: dict) -> None:
        nonlocal number
        folder = FORM / f"Q{number:02d}"
        if folder.exists():
            shutil.rmtree(folder)
        folder.mkdir(parents=True)
        collage(images).save(folder / "group.jpg", quality=90)
        questions.append({
            "question": number, "kind": kind, "prompt": prompt, "choices": choices,
            "folder": f"Q{number:02d}", "file": "group.jpg", **detail,
        })
        print(f"Q{number:02d}  {kind:16}  {detail.get('summary', '')}")
        number += 1

    labels = {}
    for label, members in groups.items():
        for path in members:
            labels[str(path)] = label
    by_name = {p.name: p for p in features.paths}
    index = {p.name: i for i, p in enumerate(features.paths)}
    split_a, split_b = by_name[SPLIT_PAIR[0]], by_name[SPLIT_PAIR[1]]
    split_dist = float(1.0 - np.dot(features.dino[index[split_a.name]], features.dino[index[split_b.name]]))
    event_pairs = [(split_dist, split_a, split_b)]
    used_photos = {split_a.name, split_b.name}
    used_clusters = {tuple(sorted((str(labels[str(split_a)]), str(labels[str(split_b)]))))}
    candidates = []
    for i in range(len(features.paths)):
        for j in range(i + 1, len(features.paths)):
            if labels[str(features.paths[i])] == labels[str(features.paths[j])]:
                continue
            dist = float(1.0 - np.dot(features.dino[i], features.dino[j]))
            candidates.append((dist, features.paths[i], features.paths[j]))
    candidates.sort(key=lambda item: item[0])
    for dist, a, b in candidates:
        if a.name in used_photos or b.name in used_photos:
            continue
        cluster_pair = tuple(sorted((str(labels[str(a)]), str(labels[str(b)]))))
        if cluster_pair in used_clusters:
            continue
        event_pairs.append((dist, a, b))
        used_photos.update((a.name, b.name))
        used_clusters.add(cluster_pair)
        if len(event_pairs) == N_EVENT_PAIRS:
            break
    if len(event_pairs) != N_EVENT_PAIRS:
        raise SystemExit(f"expected {N_EVENT_PAIRS} event pairs, found {len(event_pairs)}")
    for dist, a, b in event_pairs:
        add(
            "event-pair",
            "Are these two photos from the same occasion?",
            "Same occasion | Different occasions",
            [load_rgb(a), load_rgb(b)],
            {"summary": f"{a.name} + {b.name}  distance {dist:.3f}", "photos": f"{a.name} {b.name}"},
        )

    by_person: dict = {}
    for face in faces:
        if face.get("person_id") and face.get("embedding") is not None:
            by_person.setdefault(face["person_id"], []).append(face)
    centroids = []
    for pid, recs in by_person.items():
        mat = np.stack([np.asarray(rec["embedding"], dtype=np.float32) for rec in recs])
        mat = mat / np.maximum(np.linalg.norm(mat, axis=1, keepdims=True), 1e-12)
        center = mat.mean(axis=0)
        center = center / max(np.linalg.norm(center), 1e-12)
        centroids.append((pid, center, recs))
    near = []
    for i in range(len(centroids)):
        for j in range(i + 1, len(centroids)):
            sim = float(np.dot(centroids[i][1], centroids[j][1]))
            near.append((sim, centroids[i], centroids[j]))
    near.sort(key=lambda item: -item[0])
    person_pairs = []
    used_people = set()
    for sim, left, right in near:
        if left[0] in used_people or right[0] in used_people:
            continue
        person_pairs.append((sim, left, right))
        used_people.update((left[0], right[0]))
        if len(person_pairs) == N_PERSON_PAIRS:
            break
    if len(person_pairs) != N_PERSON_PAIRS:
        raise SystemExit(f"expected {N_PERSON_PAIRS} person pairs, found {len(person_pairs)}")
    for sim, left, right in person_pairs:
        a = max(left[2], key=lambda rec: (rec["bbox"][2] - rec["bbox"][0]) * (rec["bbox"][3] - rec["bbox"][1]))
        b = max(right[2], key=lambda rec: (rec["bbox"][2] - rec["bbox"][0]) * (rec["bbox"][3] - rec["bbox"][1]))
        add(
            "person-pair",
            "Is this one person or two people?",
            "One person | Two people",
            [face_crop(DATASET / a["photo_id"], a["bbox"]), face_crop(DATASET / b["photo_id"], b["bbox"])],
            {"summary": f"{left[0]} vs {right[0]}  similarity {sim:.3f}", "photos": f"{a['photo_id']} {b['photo_id']}"},
        )

    keep = {row["question"] for row in questions} | set(range(15, 15 + len(EXTRA_TRAIN)))
    for folder in FORM.glob("Q*"):
        qn = int(folder.name[1:])
        if qn >= 15 and qn not in keep:
            shutil.rmtree(folder)
    with (FORM / "events_people.csv").open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=["question", "kind", "prompt", "choices", "folder", "file", "summary", "photos"])
        writer.writeheader()
        writer.writerows(questions)
    if len(questions) != N_EVENT_PAIRS + N_PERSON_PAIRS:
        raise SystemExit(f"expected {N_EVENT_PAIRS + N_PERSON_PAIRS} pair questions, wrote {len(questions)}")
    print(f"Wrote {len(questions)} questions to {FORM / 'events_people.csv'}")


if __name__ == "__main__":
    main()
