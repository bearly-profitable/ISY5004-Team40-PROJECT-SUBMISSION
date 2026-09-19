import numpy as np
import pytest

from curation import (
    DEFAULT_WEIGHTS,
    SIGNAL_ORDER,
    PreferenceModel,
    bbox_iou,
    blend_time_distance,
    build_explanation,
    ear_to_openness,
    face_confidence_alpha,
    face_containment,
    find_duplicate_stacks,
    fuse_embeddings,
    is_prominent_identity,
    match_faces_to_persons,
    mmr_select,
    reject_flags,
    rescore_members,
)


# ---------------------------------------------------------------- geometry

def test_bbox_iou_identical_and_disjoint():
    box = [0, 0, 10, 10]
    assert bbox_iou(box, box) == pytest.approx(1.0)
    assert bbox_iou(box, [20, 20, 30, 30]) == 0.0


def test_face_containment_full_and_partial():
    person = [0, 0, 100, 200]
    face_inside = [40, 10, 60, 30]
    assert face_containment(face_inside, person) == pytest.approx(1.0)
    face_half_out = [90, 10, 110, 30]  # right half outside
    assert face_containment(face_half_out, person) == pytest.approx(0.5)


def test_match_faces_one_to_one_in_overlapping_group():
    """Two overlapping people: each face must map to its own body, not the
    first box that happens to contain it (the Semester-1 failure mode)."""
    person_a = [0, 0, 120, 300]
    person_b = [80, 0, 200, 300]  # overlaps person_a horizontally
    face_a = [40, 20, 80, 60]     # centred over person_a's head
    face_b = [120, 20, 160, 60]   # centred over person_b's head

    mapping = match_faces_to_persons([face_a, face_b], [person_a, person_b])
    assert mapping[0] == 0
    assert mapping[1] == 1


def test_match_faces_at_most_one_face_per_person():
    person = [0, 0, 100, 300]
    face_1 = [30, 10, 70, 50]
    face_2 = [35, 15, 75, 55]  # nearly identical duplicate detection
    mapping = match_faces_to_persons([face_1, face_2], [person])
    assert len(mapping) == 1  # only one face wins the box


def test_match_faces_respects_min_containment():
    person = [0, 0, 100, 100]
    outside_face = [200, 200, 240, 240]
    mapping = match_faces_to_persons([outside_face], [person])
    assert mapping == {}


# ------------------------------------------------------------------ fusion

def test_alpha_bounds():
    # A confident large face is fully trusted; a garbage face never drops
    # below the 0.7 floor (lower floors shrink cross-modality similarity
    # enough to split the same person into two clusters).
    assert face_confidence_alpha(0.99, 0.10) == pytest.approx(1.0)
    assert face_confidence_alpha(0.10, 0.0001) >= 0.7


def test_prominence_filter_hides_background_singletons():
    # A food-court bystander: tiny face, one photo -> hidden
    assert not is_prominent_identity(n_photos=1, max_face_ratio=0.0008)
    # A subject photographed once but close-up -> kept
    assert is_prominent_identity(n_photos=1, max_face_ratio=0.02)
    # A recurring person, even with small faces -> kept
    assert is_prominent_identity(n_photos=2, max_face_ratio=0.001)
    # ReID-only identity (no face at all) needs recurrence
    assert not is_prominent_identity(n_photos=1, max_face_ratio=0.0)
    assert is_prominent_identity(n_photos=3, max_face_ratio=0.0)


def test_fused_embedding_is_unit_norm():
    rng = np.random.default_rng(0)
    face = rng.normal(size=512).astype(np.float32)
    body = rng.normal(size=512).astype(np.float32)
    fused = fuse_embeddings(face, body, alpha=0.7)
    assert fused.shape == (1024,)
    assert np.linalg.norm(fused) == pytest.approx(1.0, abs=1e-5)


def test_fusion_cosine_is_alpha_weighted_blend():
    """cos(fused_i, fused_j) must equal alpha*cos_face + (1-alpha)*cos_body
    when both entities share the same alpha — the property that makes the
    concatenation construction equivalent to score-level fusion."""
    rng = np.random.default_rng(1)
    f1, f2 = rng.normal(size=512), rng.normal(size=512)
    b1, b2 = rng.normal(size=512), rng.normal(size=512)
    alpha = 0.65

    def unit(v):
        return v / np.linalg.norm(v)

    expected = alpha * float(unit(f1) @ unit(f2)) + (1 - alpha) * float(unit(b1) @ unit(b2))
    fused1 = fuse_embeddings(f1.astype(np.float32), b1.astype(np.float32), alpha)
    fused2 = fuse_embeddings(f2.astype(np.float32), b2.astype(np.float32), alpha)
    assert float(fused1 @ fused2) == pytest.approx(expected, abs=1e-5)


def test_fusion_handles_missing_modalities():
    face = np.ones(512, dtype=np.float32)
    assert fuse_embeddings(face, None, alpha=0.6) is not None
    body = np.ones(512, dtype=np.float32)
    assert fuse_embeddings(None, body, alpha=0.6) is not None
    assert fuse_embeddings(None, None, alpha=0.6) is None


# --------------------------------------------------------------------- MMR

def _clustered_embeddings():
    """6 items: indices 0-2 are near-duplicates, 3-5 are three distinct shots."""
    rng = np.random.default_rng(42)
    base = rng.normal(size=64)
    dup = np.stack([base + rng.normal(scale=0.01, size=64) for _ in range(3)])
    distinct = rng.normal(size=(3, 64))
    return np.concatenate([dup, distinct])


def test_mmr_starts_with_best_and_diversifies():
    emb = _clustered_embeddings()
    relevance = np.array([1.0, 0.99, 0.98, 0.5, 0.4, 0.3])

    picks_diverse = mmr_select(relevance, emb, k=3, lam=0.3)
    assert picks_diverse[0] == 0  # highest relevance always first
    # With diversity pressure, the near-duplicates of item 0 should NOT fill
    # the remaining slots even though they have the next-highest relevance.
    assert not set(picks_diverse[1:]).issubset({1, 2})

    picks_safe = mmr_select(relevance, emb, k=3, lam=1.0)
    assert picks_safe == [0, 1, 2]  # pure relevance ordering


def test_mmr_handles_small_and_empty_inputs():
    assert mmr_select(np.array([]), np.zeros((0, 4)), k=3, lam=0.7) == []
    single = mmr_select(np.array([1.0]), np.ones((1, 4)), k=5, lam=0.7)
    assert single == [0]


# --------------------------------------------------- time-blended distance

def test_blend_time_distance_separates_far_apart_lookalikes():
    # Two visually identical photos (distance 0) taken a week apart must
    # move away from each other; same-minute pairs must stay put.
    D = np.zeros((3, 3))
    ts = [0.0, 60.0, 7 * 24 * 3600.0]  # t0, one minute later, one week later
    out = blend_time_distance(D, ts, tau_seconds=6 * 3600, weight=0.4)
    assert out[0, 1] < 0.01           # same minute: essentially unchanged
    assert out[0, 2] == pytest.approx(0.4)  # saturated temporal term * weight
    assert out[2, 0] == out[0, 2]     # symmetric
    assert out[1, 1] == 0.0           # diagonal untouched


def test_blend_time_distance_skips_missing_timestamps():
    D = np.full((2, 2), 0.3)
    np.fill_diagonal(D, 0.0)
    out = blend_time_distance(D, [None, 1e9], weight=0.5)
    assert out[0, 1] == pytest.approx(0.3)  # pure visual when a ts is missing


# ------------------------------------------------------- duplicate stacks

def test_find_duplicate_stacks_groups_bursts_only():
    rng = np.random.default_rng(3)
    base = rng.normal(size=32)
    burst = np.stack([base + rng.normal(scale=0.005, size=32) for _ in range(3)])
    distinct = rng.normal(size=(2, 32))
    emb = np.concatenate([burst, distinct])

    stacks = find_duplicate_stacks(emb, threshold=0.965)
    assert stacks == [[0, 1, 2]]
    assert find_duplicate_stacks(emb[3:], threshold=0.965) == []
    assert find_duplicate_stacks(emb[:1], threshold=0.965) == []


# ------------------------------------------------------------ eye openness

def test_ear_to_openness_is_absolute():
    # Blink scores 0, open eyes score 1 — regardless of the rest of the group
    assert float(ear_to_openness(0.08)) == 0.0
    assert float(ear_to_openness(0.30)) == 1.0
    mid = float(ear_to_openness(0.20))
    assert 0.0 < mid < 1.0
    # Vectorised: an all-blink group must NOT get relative credit
    out = ear_to_openness(np.array([0.10, 0.11, 0.12]))
    assert out.max() == 0.0


# ------------------------------------------------------------ reject flags

def test_reject_flags_best_shot_never_flagged():
    flags = reject_flags({"faceSharpness": 1.0, "ear": 0.05}, {}, True, True, rank=0, group_size=5)
    assert flags == []


def test_reject_flags_duplicate_blur_and_blink():
    flags = reject_flags(
        {"faceSharpness": 5.0, "ear": 0.1},
        {s: 0.5 for s in SIGNAL_ORDER},
        is_duplicate_loser=True, has_face=True, rank=2, group_size=5,
    )
    assert set(flags) == {"duplicate", "blurry", "eyes_closed"}


def test_reject_flags_no_face_photos_not_punished_for_face_signals():
    flags = reject_flags(
        {"faceSharpness": 0.0, "ear": 0.0},
        {s: 0.5 for s in SIGNAL_ORDER},
        is_duplicate_loser=False, has_face=False, rank=3, group_size=5,
    )
    assert flags == []


# ------------------------------------------------------------ explanations

def _norm(over=None):
    base = {s: 0.5 for s in SIGNAL_ORDER}
    base.update(over or {})
    return base


def test_explanation_for_winner_mentions_strong_signals():
    out = build_explanation(
        _norm({"faceSharpness": 1.0, "nimaScore": 0.9}),
        {"nimaScore": 7.2},
        rank=0,
        group_size=8,
    )
    assert out["summary"].startswith("Selected as best of 8")
    signals = {r["signal"] for r in out["reasons"]}
    assert "faceSharpness" in signals
    assert "nimaScore" in signals


def test_explanation_for_loser_names_weak_signal():
    out = build_explanation(
        _norm({"ear": 0.9, "nimaScore": 0.1}),
        {},
        rank=3,
        group_size=8,
    )
    assert "Ranked #4 of 8" in out["summary"]
    assert "aesthetic quality" in out["summary"]


def test_explanation_margin_over_runner_up():
    winner = _norm({"poseQuality": 1.0})
    runner = _norm({"poseQuality": 0.2})
    out = build_explanation(winner, {}, rank=0, group_size=5, runner_up_norm=runner)
    assert "frontal pose" in out["summary"]


# ----------------------------------------------------- preference learning

def test_preference_update_moves_weight_toward_discriminating_signal():
    model = PreferenceModel()
    winner = _norm({"faceSharpness": 1.0})
    loser = _norm({"faceSharpness": 0.0})
    before = model.weights["faceSharpness"]
    for _ in range(5):
        model.update(winner, loser)
    assert model.weights["faceSharpness"] > before
    assert sum(model.weights.values()) == pytest.approx(1.0)
    assert all(w > 0 for w in model.weights.values())


def test_preference_converges_on_synthetic_ground_truth():
    """Simulate a user who only cares about aesthetics: after enough swaps the
    learned nimaScore weight should clearly dominate the default."""
    rng = np.random.default_rng(7)
    model = PreferenceModel()
    for _ in range(60):
        a = {s: float(rng.uniform()) for s in SIGNAL_ORDER}
        b = {s: float(rng.uniform()) for s in SIGNAL_ORDER}
        winner, loser = (a, b) if a["nimaScore"] >= b["nimaScore"] else (b, a)
        model.update(winner, loser)

    assert model.weights["nimaScore"] > DEFAULT_WEIGHTS["nimaScore"] + 0.1
    assert model.weights["nimaScore"] == max(model.weights.values())

    # And its pairwise predictions should now favour the true preference more
    # strongly than the untrained prior does. (Weights live on a simplex, so
    # the probability is bounded — compare against the prior, not an absolute.)
    hi = _norm({"nimaScore": 0.95})
    lo = _norm({"nimaScore": 0.05})
    p_learned = model.predict_preference(hi, lo)
    p_prior = PreferenceModel().predict_preference(hi, lo)
    assert p_learned > p_prior
    assert p_learned > 0.6


def test_preference_roundtrip_serialization():
    model = PreferenceModel()
    model.update(_norm({"ear": 1.0}), _norm({"ear": 0.0}))
    restored = PreferenceModel.from_dict(model.to_dict())
    assert restored.weights == model.weights
    assert restored.n_updates == 1


def test_from_dict_tolerates_garbage():
    model = PreferenceModel.from_dict({"weights": {"bogus": 1.0}})
    assert model.weights == DEFAULT_WEIGHTS


# ------------------------------------------------------------------ rescore

def test_rescore_members_changes_ranking_under_new_weights():
    members = [
        {"photoId": "a", "finalScore": 0.9,
         "normSignals": _norm({"centrality": 1.0, "nimaScore": 0.0})},
        {"photoId": "b", "finalScore": 0.5,
         "normSignals": _norm({"centrality": 0.0, "nimaScore": 1.0})},
    ]
    nima_lover = {s: 0.02 for s in SIGNAL_ORDER}
    nima_lover["nimaScore"] = 0.88
    ranked = rescore_members(members, nima_lover)
    assert ranked[0]["photoId"] == "b"
    # Original list untouched
    assert members[0]["photoId"] == "a"
