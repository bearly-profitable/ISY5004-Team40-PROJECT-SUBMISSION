"""Pure-math curation logic for the Lumina pipeline.

Everything in this module is numpy-only (no torch, no model weights) so it can
be unit-tested in milliseconds and reasoned about in isolation:

- IoU-based face <-> person-box association (replaces first-match containment)
- Confidence-weighted face/body embedding fusion
- MMR (Maximal Marginal Relevance) diversity-aware selection
- Template-based selection explanations
- Bradley-Terry pairwise preference learning over the 7 scoring signals
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Sequence, Tuple

import numpy as np

# The 7 scoring signals, in canonical order. Preference weight vectors and
# signal matrices everywhere in this module follow this order.
SIGNAL_ORDER = [
    "centrality",
    "nimaScore",
    "faceSharpness",
    "faceSize",
    "detScore",
    "poseQuality",
    "ear",
]

DEFAULT_WEIGHTS = {
    "centrality": 0.25,
    "nimaScore": 0.25,
    "faceSharpness": 0.15,
    "faceSize": 0.10,
    "detScore": 0.05,
    "poseQuality": 0.10,
    "ear": 0.10,
}

SIGNAL_LABELS = {
    "centrality": "scene representativeness",
    "nimaScore": "aesthetic quality",
    "faceSharpness": "face sharpness",
    "faceSize": "face prominence",
    "detScore": "face clarity",
    "poseQuality": "frontal pose",
    "ear": "open eyes",
}


# ---------------------------------------------------------------------------
# Face <-> person association (IoU-based, one face per person box)
# ---------------------------------------------------------------------------

def bbox_iou(box_a: Sequence[float], box_b: Sequence[float]) -> float:
    """Intersection-over-union of two [x1, y1, x2, y2] boxes."""
    ax1, ay1, ax2, ay2 = box_a
    bx1, by1, bx2, by2 = box_b
    ix1, iy1 = max(ax1, bx1), max(ay1, by1)
    ix2, iy2 = min(ax2, bx2), min(ay2, by2)
    iw, ih = max(0.0, ix2 - ix1), max(0.0, iy2 - iy1)
    inter = iw * ih
    if inter <= 0:
        return 0.0
    area_a = max(0.0, ax2 - ax1) * max(0.0, ay2 - ay1)
    area_b = max(0.0, bx2 - bx1) * max(0.0, by2 - by1)
    union = area_a + area_b - inter
    return float(inter / union) if union > 0 else 0.0


def face_containment(face_bbox: Sequence[float], person_bbox: Sequence[float]) -> float:
    """Fraction of the face box area that lies inside the person box."""
    fx1, fy1, fx2, fy2 = face_bbox
    px1, py1, px2, py2 = person_bbox
    ix1, iy1 = max(fx1, px1), max(fy1, py1)
    ix2, iy2 = min(fx2, px2), min(fy2, py2)
    inter = max(0.0, ix2 - ix1) * max(0.0, iy2 - iy1)
    face_area = max(0.0, fx2 - fx1) * max(0.0, fy2 - fy1)
    if face_area <= 0:
        return 0.0
    return float(inter / face_area)


def match_faces_to_persons(
    face_bboxes: List[Sequence[float]],
    person_bboxes: List[Sequence[float]],
    min_containment: float = 0.5,
) -> Dict[int, int]:
    """Greedy one-to-one assignment of faces to person boxes.

    Score = containment of the face inside the person box, tie-broken by how
    close the face centre is to the top-centre of the person box (heads sit at
    the top of bodies). Each person box receives at most one face and each
    face at most one person box, which prevents the overlapping-group-photo
    mislinking that first-match containment suffers from.

    Returns {face_index: person_index}.
    """
    candidates: List[Tuple[float, int, int]] = []
    for fi, fb in enumerate(face_bboxes):
        fcx = (fb[0] + fb[2]) / 2.0
        fcy = (fb[1] + fb[3]) / 2.0
        for pi, pb in enumerate(person_bboxes):
            cont = face_containment(fb, pb)
            if cont < min_containment:
                continue
            # Head prior: face centre should be near the horizontal centre and
            # the upper portion of the person box.
            pw = max(pb[2] - pb[0], 1e-6)
            ph = max(pb[3] - pb[1], 1e-6)
            dx = abs(fcx - (pb[0] + pb[2]) / 2.0) / pw          # 0 = centred
            dy = (fcy - pb[1]) / ph                              # 0 = top edge
            head_prior = max(0.0, 1.0 - dx) * max(0.0, 1.0 - min(dy / 0.6, 1.0))
            score = cont + 0.5 * head_prior
            candidates.append((score, fi, pi))

    candidates.sort(key=lambda t: t[0], reverse=True)
    assigned_faces: set = set()
    assigned_persons: set = set()
    mapping: Dict[int, int] = {}
    for score, fi, pi in candidates:
        if fi in assigned_faces or pi in assigned_persons:
            continue
        mapping[fi] = pi
        assigned_faces.add(fi)
        assigned_persons.add(pi)
    return mapping


def is_prominent_identity(
    n_photos: int,
    max_face_ratio: float,
    min_appearances: int = 2,
    min_face_ratio: float = 0.004,
) -> bool:
    """Should this identity cluster be surfaced as a 'person' in the gallery?

    Group photos in public places detect every bystander; each background
    stranger becomes a singleton cluster and floods the people list. An
    identity is prominent — a *subject* rather than scenery — if it either
    recurs across photos or has at least one reasonably large face
    (min_face_ratio of image area ~= a 70px face in a 1280px photo; food-court
    bystanders sit an order of magnitude below that).
    """
    return n_photos >= min_appearances or max_face_ratio >= min_face_ratio


# ---------------------------------------------------------------------------
# Confidence-weighted face/body embedding fusion
# ---------------------------------------------------------------------------

def face_confidence_alpha(
    det_score: float,
    face_size_ratio: float,
    det_floor: float = 0.35,
    det_ceil: float = 0.85,
    size_full: float = 0.02,
) -> float:
    """How much to trust the face embedding relative to the body embedding.

    Returns alpha in [0.7, 1.0]; 1 = trust the face fully. Detection
    confidence is ramped between det_floor and det_ceil, then discounted for
    tiny faces (below `size_full` of image area) which produce noisy ArcFace
    embeddings.

    The floor is deliberately high: in the fused space, the similarity
    between two entities scales with sqrt(alpha_i * alpha_j) on the face term,
    so a face *without* a matched body (alpha forced to 1) and the same
    person's face *with* a body at low alpha would see their face similarity
    shrunk by sqrt(alpha) — low floors split identical people into separate
    clusters. With a 0.7 floor the worst-case shrink is ~0.84, which the
    clustering threshold absorbs.
    """
    conf = (det_score - det_floor) / max(det_ceil - det_floor, 1e-6)
    conf = float(np.clip(conf, 0.0, 1.0))
    size_factor = float(np.clip(face_size_ratio / size_full, 0.0, 1.0))
    return 0.7 + 0.3 * (conf * (0.5 + 0.5 * size_factor))


def fuse_embeddings(
    face_emb: Optional[np.ndarray],
    body_emb: Optional[np.ndarray],
    alpha: float,
) -> Optional[np.ndarray]:
    """e_fused = alpha * e_face (+) (1 - alpha) * e_body, in a concatenated space.

    ArcFace and OSNet embeddings live in different spaces, so a plain weighted
    sum would mix incompatible coordinates. Instead each modality occupies its
    own block of a concatenated vector, scaled by its weight; cosine distance
    over the concatenation then equals the alpha-weighted blend of per-modality
    cosine similarities. Missing modalities get a zero block, which cleanly
    reduces similarity to the shared modality.
    """
    if face_emb is None and body_emb is None:
        return None
    dim_f = face_emb.shape[0] if face_emb is not None else 512
    dim_b = body_emb.shape[0] if body_emb is not None else 512

    f = np.zeros(dim_f, dtype=np.float32)
    b = np.zeros(dim_b, dtype=np.float32)
    if face_emb is not None:
        norm = np.linalg.norm(face_emb)
        f = (face_emb / norm) if norm > 0 else f
    else:
        alpha = 0.0
    if body_emb is not None:
        norm = np.linalg.norm(body_emb)
        b = (body_emb / norm) if norm > 0 else b
    else:
        alpha = 1.0

    fused = np.concatenate([math.sqrt(max(alpha, 0.0)) * f,
                            math.sqrt(max(1.0 - alpha, 0.0)) * b]).astype(np.float32)
    norm = np.linalg.norm(fused)
    return fused / norm if norm > 0 else fused


# ---------------------------------------------------------------------------
# Time-aware event distance blending
# ---------------------------------------------------------------------------

def blend_time_distance(
    visual_dist: np.ndarray,
    timestamps: Sequence[Optional[float]],
    tau_seconds: float = 6 * 3600.0,
    weight: float = 0.35,
) -> np.ndarray:
    """Blend capture-time proximity into a visual distance matrix.

    Real photo events are bounded in time: two visually similar cafe photos
    taken months apart are different events. For pairs where both photos have
    an EXIF timestamp, the distance becomes

        (1 - weight) * visual + weight * min(|dt| / tau, 1)

    Pairs with a missing timestamp keep their pure visual distance, so mixed
    collections degrade gracefully. `tau_seconds` is the gap at which the
    temporal term saturates (default 6h — beyond that, time says "different
    event" as loudly as it can).
    """
    D = np.asarray(visual_dist, dtype=np.float64).copy()
    n = D.shape[0]
    ts = list(timestamps)
    if n == 0 or len(ts) != n:
        return D
    for i in range(n):
        if ts[i] is None:
            continue
        for j in range(i + 1, n):
            if ts[j] is None:
                continue
            dt = min(abs(ts[i] - ts[j]) / max(tau_seconds, 1.0), 1.0)
            blended = (1.0 - weight) * D[i, j] + weight * dt
            D[i, j] = blended
            D[j, i] = blended
    np.fill_diagonal(D, 0.0)
    return D


# ---------------------------------------------------------------------------
# Near-duplicate / burst detection
# ---------------------------------------------------------------------------

def find_duplicate_stacks(
    embeddings: np.ndarray,
    threshold: float = 0.965,
) -> List[List[int]]:
    """Group near-identical shots (bursts, re-takes) by embedding similarity.

    Greedy union-find over pairs with cosine similarity >= threshold.
    Returns only stacks of size >= 2, each sorted ascending by index.
    """
    n = embeddings.shape[0]
    if n < 2:
        return []
    norms = np.linalg.norm(embeddings, axis=1, keepdims=True)
    unit = embeddings / np.maximum(norms, 1e-12)
    sim = unit @ unit.T

    parent = list(range(n))

    def find(x: int) -> int:
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    for i in range(n):
        for j in range(i + 1, n):
            if sim[i, j] >= threshold:
                ri, rj = find(i), find(j)
                if ri != rj:
                    parent[rj] = ri

    groups: Dict[int, List[int]] = {}
    for i in range(n):
        groups.setdefault(find(i), []).append(i)
    return [sorted(g) for g in groups.values() if len(g) >= 2]


# ---------------------------------------------------------------------------
# Reject flagging — the "safe to delete" bin
# ---------------------------------------------------------------------------

# Raw-signal floors below which a photo is called out. Sharpness is Laplacian
# variance (typical crisp faces are 100+). The "ear" channel carries an
# eyes-open score in [0, 1] (MediaPipe eyeBlink blendshapes, geometric-EAR
# ramp as fallback); below 0.45 the eyes are judged closed.
REJECT_BLUR_SHARPNESS = 25.0
REJECT_EAR_CLOSED = 0.45
REJECT_SCORE_PERCENTILE = 0.25  # bottom-of-event score with no redeeming rank

# Minimum raw spread (in each signal's native units) that counts as a real
# quality difference. Plain min-max normalisation stretches ANY spread to
# [0, 1] — in a near-identical selfie burst, a meaningless 0.05 NIMA gap
# becomes a full-weight 1.0-vs-0.0 swing that drowns out real signals like a
# blink. Flooring the divisor keeps noise proportionally small.
SIGNAL_SPAN_FLOORS = {
    "centrality": 0.06,     # cosine distance to the event centroid
    "nimaScore": 0.75,      # NIMA points (0-10 scale)
    "faceSharpness": 60.0,  # Laplacian variance
    "faceSize": 0.008,      # fraction of image area
    "detScore": 0.10,       # detector confidence
    "poseQuality": 0.25,    # pose penalty score (0-1)
}


def floored_minmax(arr: np.ndarray, span_floor: float) -> np.ndarray:
    """Min-max normalisation whose divisor never shrinks below span_floor.

    When the observed spread is smaller than the floor, values stay
    proportionally small instead of being stretched to the full [0, 1] range.
    """
    arr = np.asarray(arr, dtype=np.float32)
    if arr.size == 0:
        return arr
    mn = float(arr.min())
    span = max(float(arr.max()) - mn, span_floor, 1e-12)
    return (arr - mn) / span


def ear_to_openness(ear: "np.ndarray | float") -> "np.ndarray | float":
    """Map raw Eye Aspect Ratio to an absolute open-eyes score in [0, 1].

    Typical EAR: closed/blink < ~0.15, fully open > ~0.25. Min-max
    normalising raw EAR within an event makes the signal *relative* (a set of
    all-open photos gets punished arbitrarily); this absolute ramp gives a
    blink 0 and open eyes 1 regardless of the rest of the group.
    """
    return np.clip((np.asarray(ear, dtype=np.float32) - 0.15) / 0.10, 0.0, 1.0)


REJECT_LABELS = {
    "duplicate": "near-duplicate of a better shot",
    "blurry": "face is blurry",
    "eyes_closed": "eyes closed (blink)",
    "low_quality": "scored far below the rest of the event",
}


def reject_flags(
    raw_signals: Dict[str, float],
    norm_signals: Dict[str, float],
    is_duplicate_loser: bool,
    has_face: bool,
    rank: int,
    group_size: int,
) -> List[str]:
    """Reasons a photo is a deletion candidate (empty list = keeper).

    The event's best shot is never flagged; duplicate losers always are.
    Blur/blink flags need a detected face so no-face scenery isn't punished
    for lacking face signals.
    """
    if rank == 0:
        return []
    flags: List[str] = []
    if is_duplicate_loser:
        flags.append("duplicate")
    if has_face:
        if raw_signals.get("faceSharpness", 1e9) < REJECT_BLUR_SHARPNESS:
            flags.append("blurry")
        if raw_signals.get("ear", 1.0) < REJECT_EAR_CLOSED:
            flags.append("eyes_closed")
    if (
        not flags
        and group_size >= 4
        and rank >= group_size - 1
        and norm_signals.get("nimaScore", 1.0) < REJECT_SCORE_PERCENTILE
        and norm_signals.get("faceSharpness", 1.0) < REJECT_SCORE_PERCENTILE
    ):
        flags.append("low_quality")
    return flags


# ---------------------------------------------------------------------------
# MMR diversity-aware selection
# ---------------------------------------------------------------------------

MMR_MODES = {"safe": 0.9, "balanced": 0.7, "diverse": 0.45}


def mmr_select(
    relevance: np.ndarray,
    embeddings: np.ndarray,
    k: int,
    lam: float,
) -> List[int]:
    """Maximal Marginal Relevance selection.

    Picks k items maximising  lam * relevance - (1 - lam) * max_sim_to_selected.
    `relevance` is an (n,) quality score array; `embeddings` an (n, d) matrix
    (rows need not be normalised). Returns selected indices in pick order.
    """
    n = len(relevance)
    if n == 0 or k <= 0:
        return []
    k = min(k, n)

    norms = np.linalg.norm(embeddings, axis=1, keepdims=True)
    unit = embeddings / np.maximum(norms, 1e-12)
    sim = unit @ unit.T  # cosine similarity matrix

    rel = np.asarray(relevance, dtype=np.float64)
    selected: List[int] = [int(np.argmax(rel))]
    remaining = set(range(n)) - set(selected)

    while len(selected) < k and remaining:
        best_idx, best_val = -1, -np.inf
        for i in remaining:
            redundancy = max(sim[i, j] for j in selected)
            val = lam * rel[i] - (1.0 - lam) * redundancy
            if val > best_val:
                best_val, best_idx = val, i
        selected.append(best_idx)
        remaining.discard(best_idx)
    return selected


# ---------------------------------------------------------------------------
# Template-based selection explanations
# ---------------------------------------------------------------------------

def _percentile_phrase(value: float) -> Optional[str]:
    if value >= 0.999:
        return "best in the event"
    if value >= 0.85:
        return "top of the event"
    if value >= 0.65:
        return "above average"
    return None


def build_explanation(
    norm_signals: Dict[str, float],
    raw_signals: Dict[str, float],
    rank: int,
    group_size: int,
    weights: Optional[Dict[str, float]] = None,
    runner_up_norm: Optional[Dict[str, float]] = None,
) -> Dict:
    """Natural-language rationale for why a photo was (or wasn't) selected.

    Returns {"summary": str, "reasons": [{"signal", "label", "detail", "strength"}]}.
    Purely template-based over the already-computed signal values.
    """
    w = weights or DEFAULT_WEIGHTS
    contributions = sorted(
        ((sig, w.get(sig, 0.0) * norm_signals.get(sig, 0.0)) for sig in SIGNAL_ORDER),
        key=lambda t: t[1],
        reverse=True,
    )

    reasons: List[Dict] = []
    for sig, contrib in contributions:
        nval = norm_signals.get(sig, 0.0)
        phrase = _percentile_phrase(nval)
        if phrase is None or len(reasons) >= 3:
            continue
        detail = f"{SIGNAL_LABELS[sig]} is {phrase}"
        if sig == "nimaScore" and raw_signals.get("nimaScore", 0) > 0:
            detail += f" ({raw_signals['nimaScore']:.1f}/10)"
        elif sig == "ear" and nval >= 0.85:
            detail = "eyes clearly open"
        elif sig == "poseQuality" and nval >= 0.85:
            detail = "face is near-frontal"
        reasons.append({
            "signal": sig,
            "label": SIGNAL_LABELS[sig],
            "detail": detail,
            "strength": round(float(nval), 3),
        })

    if rank == 0:
        if reasons:
            lead = ", ".join(r["detail"] for r in reasons[:2])
            summary = f"Selected as best of {group_size}: {lead}."
        else:
            summary = f"Selected as best of {group_size} by overall composite score."
        # Margin over the runner-up, if we know it
        if runner_up_norm is not None:
            gaps = sorted(
                ((sig, norm_signals.get(sig, 0) - runner_up_norm.get(sig, 0)) for sig in SIGNAL_ORDER),
                key=lambda t: t[1],
                reverse=True,
            )
            top_sig, top_gap = gaps[0]
            if top_gap > 0.25:
                summary += f" Beat the runner-up mainly on {SIGNAL_LABELS[top_sig]}."
    else:
        # Why it lost: weakest heavily-weighted signal
        weak = sorted(
            ((sig, norm_signals.get(sig, 0.0)) for sig in SIGNAL_ORDER if w.get(sig, 0) >= 0.10),
            key=lambda t: t[1],
        )
        weak_sig, weak_val = weak[0]
        if weak_val < 0.4:
            summary = f"Ranked #{rank + 1} of {group_size}: lost mainly on {SIGNAL_LABELS[weak_sig]}."
        else:
            summary = f"Ranked #{rank + 1} of {group_size}: solid shot, edged out on overall score."

    return {"summary": summary, "reasons": reasons}


# ---------------------------------------------------------------------------
# Bradley-Terry pairwise preference learning
# ---------------------------------------------------------------------------

def _sigmoid(x: float) -> float:
    return 1.0 / (1.0 + math.exp(-max(min(x, 30.0), -30.0)))


@dataclass
class PreferenceModel:
    """Learns personalised signal weights from pairwise photo swaps.

    When a user promotes photo B over the system's pick A, that is one
    Bradley-Terry observation  P(B > A) = sigmoid(w . (s_B - s_A))  over the
    normalised 7-signal vectors. We run SGD on the negative log-likelihood
    with an L2 pull toward the default weights (so a handful of swaps nudges
    rather than destroys the prior), then re-project onto the simplex so the
    weights stay positive and sum to 1 like the defaults.
    """

    weights: Dict[str, float] = field(default_factory=lambda: dict(DEFAULT_WEIGHTS))
    lr: float = 0.35
    l2_to_prior: float = 0.05
    n_updates: int = 0

    def as_vector(self) -> np.ndarray:
        return np.array([self.weights[s] for s in SIGNAL_ORDER], dtype=np.float64)

    def _project(self, w: np.ndarray) -> np.ndarray:
        w = np.clip(w, 0.01, None)
        return w / w.sum()

    def update(self, winner_signals: Dict[str, float], loser_signals: Dict[str, float]) -> Dict[str, float]:
        """One SGD step from a single 'winner beats loser' observation."""
        s_w = np.array([winner_signals.get(s, 0.0) for s in SIGNAL_ORDER])
        s_l = np.array([loser_signals.get(s, 0.0) for s in SIGNAL_ORDER])
        diff = s_w - s_l

        w = self.as_vector()
        prior = np.array([DEFAULT_WEIGHTS[s] for s in SIGNAL_ORDER])

        p = _sigmoid(float(w @ diff))
        grad = (1.0 - p) * diff - self.l2_to_prior * (w - prior)
        w = self._project(w + self.lr * grad)

        self.weights = {s: float(w[i]) for i, s in enumerate(SIGNAL_ORDER)}
        self.n_updates += 1
        return self.weights

    def score(self, norm_signals: Dict[str, float]) -> float:
        return float(sum(self.weights[s] * norm_signals.get(s, 0.0) for s in SIGNAL_ORDER))

    def predict_preference(self, signals_a: Dict[str, float], signals_b: Dict[str, float]) -> float:
        """P(A preferred over B) under the current weights."""
        s_a = np.array([signals_a.get(s, 0.0) for s in SIGNAL_ORDER])
        s_b = np.array([signals_b.get(s, 0.0) for s in SIGNAL_ORDER])
        return _sigmoid(float(self.as_vector() @ (s_a - s_b)))

    def to_dict(self) -> Dict:
        return {"weights": self.weights, "n_updates": self.n_updates}

    @classmethod
    def from_dict(cls, data: Optional[Dict]) -> "PreferenceModel":
        model = cls()
        if data:
            stored = data.get("weights") or {}
            if set(stored.keys()) == set(SIGNAL_ORDER):
                model.weights = {s: float(stored[s]) for s in SIGNAL_ORDER}
            model.n_updates = int(data.get("n_updates", 0))
        return model


def rescore_members(members: List[Dict], weights: Dict[str, float]) -> List[Dict]:
    """Re-rank event members under a (possibly personalised) weight vector.

    Members must carry per-signal normalised values under `normSignals`.
    Returns a new list sorted by the recomputed score; does not mutate input.
    """
    rescored = []
    for m in members:
        norm = m.get("normSignals") or {}
        score = float(sum(weights.get(s, 0.0) * norm.get(s, 0.0) for s in SIGNAL_ORDER))
        rescored.append({**m, "finalScore": round(score, 4)})
    rescored.sort(key=lambda m: m["finalScore"], reverse=True)
    return rescored
