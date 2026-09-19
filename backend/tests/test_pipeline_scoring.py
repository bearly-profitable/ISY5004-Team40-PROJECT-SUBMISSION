"""Scoring-level regression tests (no model inference needed).

_score_event_group is pure given its inputs, so we can drive the exact
user-reported failure: a technically-nice photo where everyone is blinking
must never be selected over an eyes-open alternative.
"""
from pathlib import Path

import numpy as np
import pytest

pytest.importorskip("torch")

from lumina_pipeline import LuminaPipeline  # noqa: E402


def _face(ear: float, sharp: float = 150.0, det: float = 0.9):
    return {
        "det_score": det,
        "pose_penalty": 0.8,
        "ear": ear,
        "face_sharpness": sharp,
        "face_size_ratio": 0.05,
        "person_id": "person_0",
    }


def _run_scoring(photo_faces, nima):
    """photo_faces: {photo_id: [face dicts]}, nima: {photo_id: score}."""
    pipeline = LuminaPipeline()  # no models loaded — scoring is pure math
    pipeline.clip = None
    paths = {pid: Path(f"{pid}.jpg") for pid in photo_faces}
    photo_ids = list(photo_faces)

    rng = np.random.default_rng(0)
    # Near-identical scene embeddings (a selfie burst)
    base = rng.normal(size=16)
    emb = np.stack([base + rng.normal(scale=0.001, size=16) for _ in photo_ids])
    emb = emb / np.linalg.norm(emb, axis=1, keepdims=True)

    members, best_by_person, _ = pipeline._score_event_group(
        event_photo_paths=[paths[p] for p in photo_ids],
        dino_embeddings=emb,
        path_to_dino_idx={str(paths[p]): i for i, p in enumerate(photo_ids)},
        nima_scores={str(paths[p]): nima[p] for p in photo_ids},
        person_detections=[],
        person_photo_to_faces={
            ("person_0", str(paths[p])): faces for p, faces in photo_faces.items() if faces
        },
        photo_to_all_faces={str(paths[p]): faces for p, faces in photo_faces.items()},
        path_to_photo_id={str(paths[p]): p for p in photo_ids},
    )
    return members, best_by_person


def test_blink_photo_never_wins_over_open_eyes():
    """The user-reported bug: both-eyes-closed shot won on NIMA/sharpness
    noise. With the hard constraint it must sink below eyes-open shots even
    with better raw signals."""
    members, best_by_person = _run_scoring(
        photo_faces={
            "blink": [_face(ear=0.06, sharp=260.0)],   # closed eyes, but sharper
            "open1": [_face(ear=0.30, sharp=150.0)],
            "open2": [_face(ear=0.28, sharp=140.0)],
        },
        nima={"blink": 6.0, "open1": 5.2, "open2": 5.0},  # and prettier NIMA
    )
    assert members[0]["photoId"] in ("open1", "open2")
    assert members[-1]["photoId"] == "blink"
    # Per-person pick obeys the same rule
    assert best_by_person[0]["photoId"] in ("open1", "open2")


def test_group_blink_detected_via_min_aggregation():
    """One person blinking in a two-person photo must count as a blink for
    the whole photo (previously only the most confident face was scored)."""
    members, _ = _run_scoring(
        photo_faces={
            "one_blink": [_face(ear=0.30, det=0.95), _face(ear=0.05, det=0.60)],
            "all_open": [_face(ear=0.29, det=0.90), _face(ear=0.27, det=0.85)],
        },
        nima={"one_blink": 6.5, "all_open": 5.0},
    )
    assert members[0]["photoId"] == "all_open"


def test_all_blink_event_still_selects_something():
    members, _ = _run_scoring(
        photo_faces={
            "b1": [_face(ear=0.05)],
            "b2": [_face(ear=0.08, sharp=200.0)],
        },
        nima={"b1": 5.0, "b2": 5.5},
    )
    assert members[0]["photoId"] == "b2"  # best of the blinks, by score
    assert members[0]["flags"] == []      # top pick never flagged


def test_noise_spread_does_not_dominate():
    """A meaningless 0.05 NIMA gap must not produce a decisive normalised
    difference (floored normalisation)."""
    members, _ = _run_scoring(
        photo_faces={
            "a": [_face(ear=0.30)],
            "b": [_face(ear=0.29)],
        },
        nima={"a": 5.00, "b": 5.05},
    )
    by_id = {m["photoId"]: m for m in members}
    gap = abs(by_id["a"]["normSignals"]["nimaScore"] - by_id["b"]["normSignals"]["nimaScore"])
    assert gap < 0.15  # previously this stretched to a full 1.0
