"""Lumina experiment suite for the capstone report.

Usage (from backend/):
    ../venv/Scripts/python.exe eval/experiments.py "../report/test images" \
        --out ../report/experiments

The folder's file names carry the reference event: `9-3.JPG` is photo 3 of
event 9, `12.jpeg` is a one-photo event 12. Event grouping is subjective, so
every clustering result is reported twice: against those labels, and with
label-free measures (stability under subsampling, cross-date merges, internal
indices, cannot-link violations for identities).

Stage A runs the real pipeline twice (cold, then warm) and fills an embedding
cache. Stage B re-runs the pipeline's own clustering and scoring methods from
that cache under each experimental configuration, so every number comes from
production code paths, not re-implementations. The few places that need an
internal quantity the pipeline does not return (sweep curves, fused vectors)
recompute it and assert that the recomputation reproduces the pipeline.
"""
from __future__ import annotations

import argparse
import csv
import dataclasses
import datetime as dt
import json
import os
import platform
import sys
import time
from pathlib import Path
from typing import Callable, Dict, List, Optional, Sequence, Tuple

from dotenv import load_dotenv

for _env in (Path(__file__).resolve().parents[1] / ".env", Path(__file__).resolve().parents[2] / ".env"):
    load_dotenv(_env)  # HF_TOKEN for the gated DINOv3 weights
os.environ["OPENROUTER_EVENT_MODEL"] = "off"  # never send photos to a third party
os.environ.pop("OPENROUTER_API_KEY", None)

import numpy as np

BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from scipy.stats import kendalltau, wilcoxon  # noqa: E402
from sklearn.cluster import AgglomerativeClustering  # noqa: E402
from sklearn.metrics import (  # noqa: E402
    adjusted_rand_score,
    calinski_harabasz_score,
    davies_bouldin_score,
    homogeneity_completeness_v_measure,
    normalized_mutual_info_score,
    silhouette_score,
)

import lumina_pipeline as lp  # noqa: E402
from curation import (  # noqa: E402
    DEFAULT_WEIGHTS,
    SIGNAL_ORDER,
    PreferenceModel,
    blend_time_distance,
    fuse_embeddings,
    is_prominent_identity,
)
from lumina_pipeline import LuminaPipeline, PipelineConfig  # noqa: E402
from store import LuminaStore  # noqa: E402

IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".webp", ".bmp"}
RNG_SEED = 42
BLINK_THRESHOLD = 0.45
SEM1_WEIGHTS = {**DEFAULT_WEIGHTS, "detScore": 0.10, "ear": 0.05}


# ---------------------------------------------------------------- utilities

def event_label_from_name(name: str) -> str:
    return Path(name).stem.split("-")[0]


def write_csv(path: Path, rows: List[Dict]) -> None:
    if not rows:
        return
    keys: List[str] = []
    for row in rows:
        for k in row:
            if k not in keys:
                keys.append(k)
    with open(path, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=keys)
        writer.writeheader()
        for row in rows:
            writer.writerow({k: _round(row.get(k)) for k in keys})


def _round(v):
    if isinstance(v, (float, np.floating)):
        return round(float(v), 4)
    return v


class Log:
    def __init__(self, path: Path):
        self.path = path
        self.lines: List[str] = []

    def __call__(self, msg: str = "") -> None:
        print(msg, flush=True)
        self.lines.append(msg)

    def flush(self) -> None:
        self.path.write_text("\n".join(self.lines) + "\n", encoding="utf-8")


# ----------------------------------------------------------------- stage A

@dataclasses.dataclass
class Features:
    paths: List[Path]
    ids: List[str]
    truth: Dict[str, str]
    exif: Dict[str, Optional[float]]
    entries: Dict[str, dict]
    dino: np.ndarray
    nima: Dict[str, float]

    @property
    def path_to_idx(self) -> Dict[str, int]:
        return {str(p): i for i, p in enumerate(self.paths)}

    @property
    def path_to_id(self) -> Dict[str, str]:
        return {str(p): pid for p, pid in zip(self.paths, self.ids)}


def run_full_pipeline(paths: List[Path], ids: List[str], store: LuminaStore, log: Log) -> Tuple[LuminaPipeline, dict, List[Dict]]:
    cfg = PipelineConfig(enable_captions=False, enable_clip=False)
    pipe = LuminaPipeline(config=cfg, store=store)
    timing_rows = []
    result = None
    for label in ("cold", "warm"):
        t0 = time.time()
        result = pipe.run(image_paths=paths, photo_ids=ids)
        wall = time.time() - t0
        s = result["summary"]
        timing_rows.append({
            "run": label,
            "wall_seconds": wall,
            "seconds_per_image": wall / len(paths),
            "cache_hits": s["cacheHits"],
            "cache_misses": s["cacheMisses"],
            **{f"t_{k}": v for k, v in s["timings"].items()},
        })
        log(f"  {label} run: {wall:.1f}s, cache hits {s['cacheHits']}/{len(paths)}")
    return pipe, result, timing_rows


def load_features(pipe: LuminaPipeline, paths: List[Path], ids: List[str], truth: Dict[str, str]) -> Features:
    _, hashes, exif = pipe._build_image_cache(paths)
    entries = {}
    for p in paths:
        entry = pipe.store.cache_get(pipe._cache_key(hashes[str(p)]))
        if entry is None:
            raise SystemExit(f"No cached features for {p.name}; stage A did not complete.")
        entries[str(p)] = entry
    dino = np.stack([np.asarray(entries[str(p)]["dino"], dtype=np.float32) for p in paths])
    nima = {str(p): float(entries[str(p)].get("nima", 0.0)) for p in paths}
    return Features(paths, ids, truth, exif, entries, dino, nima)


def fresh_records(pipe: LuminaPipeline, F: Features, subset: Optional[Sequence[int]] = None):
    idxs = range(len(F.paths)) if subset is None else subset
    faces, persons = [], []
    for i in idxs:
        p = F.paths[i]
        fr, pr = pipe._rehydrate_cached(F.entries[str(p)], p, F.ids[i])
        faces.extend(fr)
        persons.extend(pr)
    return faces, persons


# ------------------------------------------------------ identity experiments

def alpha_with_floor(floor: float) -> Callable[[float, float], float]:
    base = lp.face_confidence_alpha

    def alpha(det_score: float, face_size_ratio: float) -> float:
        trust = (base(det_score, face_size_ratio) - 0.7) / 0.3  # in [0, 1]
        return floor + (1.0 - floor) * trust
    return alpha


def cluster_identities(pipe, F, cfg, subset=None, alpha_floor=None):
    pipe.cfg = cfg
    original_alpha = lp.face_confidence_alpha
    if alpha_floor is not None:
        lp.face_confidence_alpha = alpha_with_floor(alpha_floor)
    try:
        faces, persons = fresh_records(pipe, F, subset)
        pipe._link_faces_to_persons(persons, faces, F.path_to_id)
        pipe._cluster_identities(persons, faces)
        vectors = identity_vectors(faces, persons, cfg.identity_mode)
    finally:
        lp.face_confidence_alpha = original_alpha
    return faces, persons, vectors


def identity_vectors(faces, persons, mode):
    """The embedding each clustered entity lived in, keyed like entity_keys()."""
    out = {}
    if mode == "body_only":
        for p in persons:
            out[person_key(p)] = p["reid_embedding"]
        return out
    body_of = {id(p["face_record"]): p["reid_embedding"] for p in persons
               if p.get("face_record") is not None and p.get("reid_embedding") is not None}
    for f in faces:
        if f.get("embedding") is None:
            continue
        if mode == "face_only":
            vec = fuse_embeddings(f["embedding"], None, 1.0)
        else:
            alpha = lp.face_confidence_alpha(f["det_score"], f["face_size_ratio"])
            vec = fuse_embeddings(f["embedding"], body_of.get(id(f)), alpha)
        out[face_key(f)] = vec
    return out


def face_key(f) -> Tuple:
    return ("face", f["photo_id"], int(f.get("face_idx", 0)))


def person_key(p) -> Tuple:
    return ("body", p["photo_id"], tuple(round(float(v), 1) for v in p["bbox"]))


def entity_labels(faces, persons, mode) -> Dict[Tuple, str]:
    if mode == "body_only":
        return {person_key(p): p["person_id"] for p in persons if p.get("person_id")}
    return {face_key(f): f["person_id"] for f in faces if f.get("person_id")}


def identity_metrics(faces, persons, vectors, mode, cfg) -> Dict:
    labels = entity_labels(faces, persons, mode)
    ents = list(labels)
    lab = [labels[k] for k in ents]
    by_photo: Dict[str, List[str]] = {}
    for k in ents:
        by_photo.setdefault(k[1], []).append(labels[k])
    pairs = viol = 0
    for pids in by_photo.values():
        for a in range(len(pids)):
            for b in range(a + 1, len(pids)):
                pairs += 1
                viol += int(pids[a] == pids[b])

    sizes: Dict[str, int] = {}
    for l in lab:
        sizes[l] = sizes.get(l, 0) + 1
    n_clusters = len(sizes)

    sil = float("nan")
    keep = [i for i, l in enumerate(lab) if sizes[l] >= 2]
    if len({lab[i] for i in keep}) >= 2 and len(keep) > len({lab[i] for i in keep}):
        X = np.stack([vectors[ents[i]] for i in keep])
        sil = float(silhouette_score(X, [lab[i] for i in keep], metric="cosine"))

    photos_of: Dict[str, set] = {}
    max_ratio: Dict[str, float] = {}
    for f in faces:
        if f.get("person_id"):
            photos_of.setdefault(f["person_id"], set()).add(f["photo_id"])
            max_ratio[f["person_id"]] = max(max_ratio.get(f["person_id"], 0.0), float(f.get("face_size_ratio", 0)))
    for p in persons:
        if p.get("person_id"):
            photos_of.setdefault(p["person_id"], set()).add(p["photo_id"])
            max_ratio.setdefault(p["person_id"], 0.0)
    prominent = sum(
        is_prominent_identity(len(ph), max_ratio.get(pid, 0.0), cfg.identity_min_appearances, cfg.identity_min_face_ratio)
        for pid, ph in photos_of.items()
    )

    faceless = [p for p in persons if p.get("face_record") is None]
    attached = sum(1 for p in faceless if p.get("person_id"))
    return {
        "entities": len(ents),
        "clusters": n_clusters,
        "singleton_fraction": sum(1 for s in sizes.values() if s == 1) / max(n_clusters, 1),
        "prominent_identities": prominent,
        "same_photo_pairs": pairs,
        "cannot_link_violations": viol,
        "cannot_link_violation_rate": viol / pairs if pairs else 0.0,
        "silhouette_cosine": sil,
        "faceless_bodies": len(faceless),
        "faceless_attached_fraction": attached / len(faceless) if faceless else float("nan"),
    }


def identity_stability(pipe, F, cfg, full_labels, reps, frac, rng, alpha_floor=None) -> Tuple[float, float]:
    scores = []
    n = len(F.paths)
    for _ in range(reps):
        subset = sorted(rng.choice(n, size=max(2, int(round(frac * n))), replace=False).tolist())
        faces, persons, _ = cluster_identities(pipe, F, cfg, subset, alpha_floor)
        sub = entity_labels(faces, persons, cfg.identity_mode)
        common = [k for k in sub if k in full_labels]
        if len(common) >= 2:
            scores.append(adjusted_rand_score([full_labels[k] for k in common], [sub[k] for k in common]))
    return (float(np.mean(scores)), float(np.std(scores))) if scores else (float("nan"), float("nan"))


def run_identity_experiments(pipe, F, base_cfg, log, reps, rng) -> Tuple[List[Dict], Dict]:
    rows = []
    configs = [("mode", m, dataclasses.replace(base_cfg, identity_mode=m), None) for m in ("fused", "face_only", "body_only")]
    for thr in (0.45, 0.50, 0.55, 0.58, 0.62, 0.66, 0.70):
        configs.append(("fused_threshold", thr, dataclasses.replace(base_cfg, fused_cluster_distance=thr), None))
    for floor in (0.5, 0.6, 0.7, 0.8, 0.9):
        configs.append(("alpha_floor", floor, base_cfg, floor))
    for thr in (0.50, 0.55, 0.60, 0.65, 0.70):
        configs.append(("face_only_threshold", thr, dataclasses.replace(base_cfg, identity_mode="face_only", face_cluster_distance=thr), None))

    default_faces = default_persons = None
    for exp, value, cfg, floor in configs:
        faces, persons, vectors = cluster_identities(pipe, F, cfg, alpha_floor=floor)
        m = identity_metrics(faces, persons, vectors, cfg.identity_mode, cfg)
        full = entity_labels(faces, persons, cfg.identity_mode)
        stab_mean, stab_std = identity_stability(pipe, F, cfg, full, reps, 0.8, rng, floor)
        row = {"experiment": exp, "value": value, "mode": cfg.identity_mode, **m,
               "stability_ari_mean": stab_mean, "stability_ari_std": stab_std}
        rows.append(row)
        log(f"  {exp}={value}: clusters={m['clusters']} prominent={m['prominent_identities']} "
            f"CL-viol={m['cannot_link_violations']}/{m['same_photo_pairs']} sil={m['silhouette_cosine']:.3f} "
            f"stab={stab_mean:.3f}")
        if exp == "mode" and value == "fused":
            default_faces, default_persons = faces, persons
    pipe.cfg = base_cfg
    return rows, {"faces": default_faces, "persons": default_persons}


# --------------------------------------------------------- event experiments

def event_distance(F: Features, weight: float, tau: float) -> np.ndarray:
    X = F.dino
    D = np.clip(1.0 - X @ X.T, 0.0, None)
    if weight > 0:
        ts = [F.exif.get(str(p)) for p in F.paths]
        if any(t is not None for t in ts):
            D = blend_time_distance(D, ts, tau_seconds=tau, weight=weight)
    return D


def agglomerate(D: np.ndarray, thresh: float, linkage: str = "average") -> np.ndarray:
    return AgglomerativeClustering(n_clusters=None, distance_threshold=float(thresh),
                                   metric="precomputed", linkage=linkage).fit_predict(D)


def silhouette_or_nan(D, labels) -> float:
    k = len(set(labels))
    if 2 <= k < len(D):
        return float(silhouette_score(D, labels, metric="precomputed"))
    return float("nan")


def select_threshold(D, thresholds, linkage="average", patience: Optional[int] = 3) -> Tuple[float, float]:
    """The pipeline's rule: best silhouette over the sweep, early-stopping
    after `patience` non-improving steps (None = full sweep)."""
    best_t, best_s, no_imp = thresholds[0], -1.0, 0
    for t in thresholds:
        s = silhouette_or_nan(D, agglomerate(D, t, linkage))
        if not np.isnan(s) and s > best_s:
            best_s, best_t, no_imp = s, t, 0
        else:
            no_imp += 1
        if patience is not None and no_imp >= patience:
            break
    return float(best_t), float(best_s)


def event_metrics(F: Features, labels: np.ndarray, D: np.ndarray) -> Dict:
    truth = [F.truth[i] for i in F.ids]
    pred = [str(l) for l in labels]
    h, c, v = homogeneity_completeness_v_measure(truth, pred)
    k = len(set(pred))
    dbi = chi = float("nan")
    if 2 <= k < len(pred):
        dbi = float(davies_bouldin_score(F.dino, pred))
        chi = float(calinski_harabasz_score(F.dino, pred))
    # Label-free sanity: a predicted event that mixes EXIF photos from
    # different calendar dates is a certain merge error.
    dates_by_event: Dict[str, set] = {}
    spans: Dict[str, List[float]] = {}
    for p, l in zip(F.paths, pred):
        ts = F.exif.get(str(p))
        if ts is None:
            continue
        dates_by_event.setdefault(l, set()).add(dt.datetime.fromtimestamp(ts).date())
        spans.setdefault(l, []).append(ts)
    cross_date = sum(1 for d in dates_by_event.values() if len(d) > 1)
    max_span_h = max(((max(s) - min(s)) / 3600 for s in spans.values()), default=0.0)
    return {
        "pred_events": k,
        "true_events": len(set(truth)),
        "ARI": adjusted_rand_score(truth, pred),
        "NMI": normalized_mutual_info_score(truth, pred),
        "homogeneity": h,
        "completeness": c,
        "v_measure": v,
        "silhouette_D": silhouette_or_nan(D, labels),
        "davies_bouldin_dino": dbi,
        "calinski_harabasz_dino": chi,
        "cross_date_events": cross_date,
        "max_exif_span_hours": max_span_h,
    }


def event_stability(D, thresholds, linkage, reps, frac, rng, patience=3) -> Tuple[float, float]:
    """Re-select the threshold and re-cluster on random subsets; compare to
    the full-data partition restricted to the subset (label-free)."""
    full_t, _ = select_threshold(D, thresholds, linkage, patience)
    full = agglomerate(D, full_t, linkage)
    n = len(D)
    scores = []
    for _ in range(reps):
        sub = np.sort(rng.choice(n, size=int(round(frac * n)), replace=False))
        Ds = D[np.ix_(sub, sub)]
        t, _ = select_threshold(Ds, thresholds, linkage, patience)
        scores.append(adjusted_rand_score(full[sub], agglomerate(Ds, t, linkage)))
    return float(np.mean(scores)), float(np.std(scores))


def sem1_event_distance(F: Features, persons, faces, kept, person_weight=5.0) -> np.ndarray:
    """Semester 1 feature: DINO concatenated with a person multi-hot block
    scaled by w_person, L2-normalised, cosine distance, no time."""
    pids = sorted(kept)
    col = {p: j for j, p in enumerate(pids)}
    M = np.zeros((len(F.paths), len(pids)), dtype=np.float32)
    idx = F.path_to_idx
    for rec in list(persons) + list(faces):
        pid = rec.get("person_id")
        if pid in col:
            M[idx[str(rec["photo_path"])], col[pid]] = 1.0
    X = np.concatenate([F.dino, person_weight * M], axis=1)
    X = X / np.maximum(np.linalg.norm(X, axis=1, keepdims=True), 1e-12)
    return np.clip(1.0 - X @ X.T, 0.0, None)


def run_event_experiments(pipe, F, base_cfg, identity_state, log, reps, rng):
    thresholds = np.arange(base_cfg.event_sweep_start, base_cfg.event_sweep_stop, base_cfg.event_sweep_step)
    fine = np.round(np.arange(0.05, 1.0, 0.025), 4)
    rows, curves = [], []

    # Sanity: the harness's selection rule reproduces the pipeline's partition.
    pipe.cfg = base_cfg
    groups = pipe._cluster_events(F.dino, F.paths, F.path_to_idx, [], F.exif)
    pipe_labels = np.empty(len(F.paths), dtype=int)
    for lbl, members in groups.items():
        for p in members:
            pipe_labels[F.path_to_idx[str(p)]] = lbl
    D0 = event_distance(F, base_cfg.event_time_weight, base_cfg.event_time_tau_seconds)
    t0, _ = select_threshold(D0, thresholds)
    reproduced = adjusted_rand_score(pipe_labels, agglomerate(D0, t0)) == 1.0
    log(f"  harness reproduces pipeline event partition: {reproduced} (threshold {t0:.2f})")

    def add(exp, value, D, linkage="average", patience=3, grid=thresholds, fixed=None):
        if fixed is None:
            t, s = select_threshold(D, grid, linkage, patience)
        else:
            t, s = fixed, silhouette_or_nan(D, agglomerate(D, fixed, linkage))
        labels = agglomerate(D, t, linkage)
        m = event_metrics(F, labels, D)
        sm, ss = event_stability(D, grid, linkage, reps, 0.8, rng, patience) if fixed is None else (float("nan"), float("nan"))
        row = {"experiment": exp, "value": value, "linkage": linkage, "threshold": t,
               "selection_silhouette": s, **m, "stability_ari_mean": sm, "stability_ari_std": ss}
        rows.append(row)
        log(f"  {exp}={value}: t={t:.3f} k={m['pred_events']} ARI={m['ARI']:.3f} NMI={m['NMI']:.3f} "
            f"hom={m['homogeneity']:.3f} comp={m['completeness']:.3f} xdate={m['cross_date_events']} stab={sm:.3f}")
        return labels

    for w in (0.0, 0.2, 0.35, 0.5, 0.7):
        add("time_weight", w, event_distance(F, w, base_cfg.event_time_tau_seconds))
    for tau_h in (1, 3, 6, 12, 24):
        add("time_tau_hours", tau_h, event_distance(F, base_cfg.event_time_weight, tau_h * 3600.0))
    for link in ("average", "complete", "single"):
        add("linkage", link, D0, linkage=link)
    add("sweep", "coarse0.25_patience3 (previous default)", D0, patience=3, grid=np.arange(0.1, 3.0, 0.25))
    add("sweep", "fine0.025_patience3", D0, patience=3, grid=fine)
    add("sweep", "fine0.025_full", D0, patience=None, grid=fine)
    add("sweep", f"step{base_cfg.event_sweep_step}_patience{base_cfg.event_sweep_patience} (production)", D0,
        patience=base_cfg.event_sweep_patience)

    faces, persons = identity_state["faces"], identity_state["persons"]
    kept = {f["person_id"] for f in faces if f.get("person_id")}
    D_s1 = sem1_event_distance(F, persons, faces, kept, person_weight=5.0)
    add("semester1_baseline", "DINO+multihot(w=5), no time", D_s1)

    # Threshold curves (what the silhouette rule sees vs. what the labels say)
    truth = [F.truth[i] for i in F.ids]
    for name, D in (("time_w0", event_distance(F, 0.0, 1.0)), ("time_w0.35", D0), ("semester1", D_s1)):
        for t in fine:
            labels = agglomerate(D, t)
            curves.append({"series": name, "threshold": float(t), "clusters": len(set(labels)),
                           "silhouette": silhouette_or_nan(D, labels),
                           "ARI": adjusted_rand_score(truth, labels)})
    for name in ("time_w0", "time_w0.35", "semester1"):
        pts = [c for c in curves if c["series"] == name]
        best = max(pts, key=lambda c: c["ARI"])
        rows.append({"experiment": "oracle_threshold (upper bound, uses labels)", "value": name,
                     "linkage": "average", "threshold": best["threshold"], "ARI": best["ARI"],
                     "pred_events": best["clusters"], "true_events": len(set(truth))})
        log(f"  oracle threshold for {name}: t={best['threshold']:.3f} ARI={best['ARI']:.3f} k={best['clusters']}")
    pipe.cfg = base_cfg
    return rows, curves, reproduced


# ------------------------------------------------------- ranking experiments

def score_truth_events(pipe, F, cfg, identity_state) -> Dict[str, List[dict]]:
    """Score each reference event with the pipeline's own event scorer."""
    pipe.cfg = cfg
    faces, persons = identity_state["faces"], identity_state["persons"]
    person_photo_to_faces: Dict[tuple, list] = {}
    photo_to_all_faces: Dict[str, list] = {}
    for rec in faces:
        photo_to_all_faces.setdefault(str(rec["photo_path"]), []).append(rec)
        if rec.get("person_id") is not None:
            person_photo_to_faces.setdefault((rec["person_id"], str(rec["photo_path"])), []).append(rec)
    kept = {f["person_id"] for f in faces if f.get("person_id")}
    by_event: Dict[str, List[Path]] = {}
    for p, pid in zip(F.paths, F.ids):
        by_event.setdefault(F.truth[pid], []).append(p)
    out = {}
    for evt, paths in sorted(by_event.items(), key=lambda kv: int(kv[0]) if kv[0].isdigit() else kv[0]):
        members, _, _ = pipe._score_event_group(
            paths, F.dino, F.path_to_idx, F.nima, persons,
            person_photo_to_faces, photo_to_all_faces, F.path_to_id, kept_pids=kept,
        )
        out[evt] = members
    return out


def cfg_with_weights(base_cfg, w: Dict[str, float]):
    return dataclasses.replace(
        base_cfg,
        w_centrality=w["centrality"], w_nima=w["nimaScore"], w_face_sharpness=w["faceSharpness"],
        w_face_size=w["faceSize"], w_det_score=w["detScore"], w_pose=w["poseQuality"], w_ear=w["ear"],
    )


class patched:
    """Temporarily override module-level constants the scorer reads."""

    def __init__(self, **overrides):
        self.overrides = overrides
        self.saved = {}

    def __enter__(self):
        for k, v in self.overrides.items():
            self.saved[k] = getattr(lp, k)
            setattr(lp, k, v)

    def __exit__(self, *exc):
        for k, v in self.saved.items():
            setattr(lp, k, v)


def is_blink(m: dict) -> bool:
    return m["detScore"] > 0 and m["ear"] < BLINK_THRESHOLD


def ranking_summary(name: str, scored: Dict[str, List[dict]], reference: Dict[str, List[dict]]) -> Dict:
    events = [e for e, ms in scored.items() if len(ms) >= 2]
    flips = taus = avoidable_blinks = blink_available = 0
    tau_vals, sharp_pct, nima_pct = [], [], []
    for e in events:
        ms, ref = scored[e], reference[e]
        top = ms[0]
        flips += int(top["photoId"] != ref[0]["photoId"])
        ref_order = [m["photoId"] for m in ref]
        order = [m["photoId"] for m in ms]
        tau_vals.append(kendalltau([ref_order.index(p) for p in order], list(range(len(order))))[0])
        has_open = any(not is_blink(m) and m["detScore"] > 0 for m in ms)
        if has_open:
            blink_available += 1
            avoidable_blinks += int(is_blink(top))
        for key, bucket in (("faceSharpness", sharp_pct), ("nimaScore", nima_pct)):
            vals = [m[key] for m in ms]
            bucket.append(sum(v <= top[key] for v in vals) / len(vals))
    return {
        "config": name,
        "events_scored": len(events),
        "top1_changes_vs_default": flips,
        "mean_kendall_tau_vs_default": float(np.nanmean(tau_vals)) if tau_vals else float("nan"),
        "avoidable_blink_picks": avoidable_blinks,
        "events_with_eyes_open_option": blink_available,
        "pick_sharpness_percentile": float(np.mean(sharp_pct)) if sharp_pct else float("nan"),
        "pick_nima_percentile": float(np.mean(nima_pct)) if nima_pct else float("nan"),
    }


def run_ranking_experiments(pipe, F, base_cfg, identity_state, log):
    no_floors = {k: 1e-12 for k in lp.SIGNAL_SPAN_FLOORS}
    default = score_truth_events(pipe, F, base_cfg, identity_state)
    rows = [ranking_summary("capstone default", default, default)]

    variants: List[Tuple[str, Dict[str, float], dict]] = [
        ("no span floors", DEFAULT_WEIGHTS, {"SIGNAL_SPAN_FLOORS": no_floors}),
        ("no blink constraint", DEFAULT_WEIGHTS, {"REJECT_EAR_CLOSED": -1.0}),
        ("semester-1 weights", SEM1_WEIGHTS, {}),
        ("semester-1 rule (weights, no floors, no constraint)", SEM1_WEIGHTS,
         {"SIGNAL_SPAN_FLOORS": no_floors, "REJECT_EAR_CLOSED": -1.0}),
        ("NIMA only", {s: (1.0 if s == "nimaScore" else 0.0) for s in SIGNAL_ORDER}, {"REJECT_EAR_CLOSED": -1.0}),
    ]
    for sig in SIGNAL_ORDER:
        w = {s: (0.0 if s == sig else DEFAULT_WEIGHTS[s]) for s in SIGNAL_ORDER}
        tot = sum(w.values())
        variants.append((f"ablate {sig}", {s: v / tot for s, v in w.items()}, {}))
    for sig in SIGNAL_ORDER:
        for f in (0.8, 1.2):
            w = dict(DEFAULT_WEIGHTS)
            w[sig] *= f
            variants.append((f"perturb {sig} x{f}", w, {}))

    for name, weights, patch in variants:
        with patched(**patch):
            scored = score_truth_events(pipe, F, cfg_with_weights(base_cfg, weights), identity_state)
        row = ranking_summary(name, scored, default)
        rows.append(row)
        log(f"  {name}: top1 changes={row['top1_changes_vs_default']}/{row['events_scored']} "
            f"tau={row['mean_kendall_tau_vs_default']:.3f} avoidable blinks={row['avoidable_blink_picks']}")
    pipe.cfg = base_cfg
    return rows, default


# -------------------------------------------------- preference experiments

PERSONAS = {
    "aesthete": {"centrality": 0.10, "nimaScore": 0.60, "faceSharpness": 0.05, "faceSize": 0.05,
                 "detScore": 0.05, "poseQuality": 0.05, "ear": 0.10},
    "portraitist": {"centrality": 0.05, "nimaScore": 0.05, "faceSharpness": 0.35, "faceSize": 0.25,
                    "detScore": 0.05, "poseQuality": 0.15, "ear": 0.10},
    "storyteller": {"centrality": 0.55, "nimaScore": 0.20, "faceSharpness": 0.05, "faceSize": 0.05,
                    "detScore": 0.05, "poseQuality": 0.05, "ear": 0.05},
}


def signal_matrix(members: List[dict]) -> np.ndarray:
    return np.array([[m["normSignals"].get(s, 0.0) for s in SIGNAL_ORDER] for m in members], dtype=np.float64)


def simulate_user(events: List[np.ndarray], w_star: np.ndarray, rng, splits: int, max_passes: int,
                  test_frac: float, noise_temp: float = 0.0,
                  model_kwargs: Optional[Dict[str, float]] = None) -> Dict[str, np.ndarray]:
    """Train/test protocol on real per-event signal matrices.

    Each train visit shows the system's current pick; if the simulated user
    prefers another photo, that is one swap (winner = user's pick, loser =
    system's pick) and one PreferenceModel.update. Held-out events measure
    whether the learned weights now pick what the user would.
    """
    n_ev = len(events)
    n_test = max(1, int(round(test_frac * n_ev)))
    agree = np.zeros((splits, max_passes + 1))
    regret = np.zeros((splits, max_passes + 1))
    swaps = np.zeros((splits, max_passes + 1))
    random_agree = np.zeros(splits)

    def user_pick(S):
        u = S @ w_star
        if noise_temp > 0:
            p = np.exp((u - u.max()) / noise_temp)
            return int(rng.choice(len(u), p=p / p.sum()))
        return int(np.argmax(u))

    def evaluate(model, test):
        w = model.as_vector()
        hits, reg = [], []
        for S in test:
            u = S @ w_star
            pick = int(np.argmax(S @ w))
            hits.append(float(pick == int(np.argmax(u))))
            span = u.max() - u.min()
            reg.append((u.max() - u[pick]) / span if span > 0 else 0.0)
        return float(np.mean(hits)), float(np.mean(reg))

    for s in range(splits):
        order = rng.permutation(n_ev)
        test = [events[i] for i in order[:n_test]]
        train = [events[i] for i in order[n_test:]]
        random_agree[s] = float(np.mean([1.0 / len(S) for S in test]))
        model = PreferenceModel(**(model_kwargs or {}))
        n_swaps = 0
        agree[s, 0], regret[s, 0] = evaluate(model, test)
        for p in range(1, max_passes + 1):
            for i in rng.permutation(len(train)):
                S = train[i]
                sys_pick = int(np.argmax(S @ model.as_vector()))
                usr = user_pick(S)
                if usr != sys_pick:
                    sig = {k: float(S[usr, j]) for j, k in enumerate(SIGNAL_ORDER)}
                    los = {k: float(S[sys_pick, j]) for j, k in enumerate(SIGNAL_ORDER)}
                    model.update(sig, los)
                    n_swaps += 1
            agree[s, p], regret[s, p] = evaluate(model, test)
            swaps[s, p] = n_swaps
    return {"agree": agree, "regret": regret, "swaps": swaps, "random": random_agree}


LR_GRID = (0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.35)
L2_GRID = (0.05, 0.2, 0.5, 1.0, 2.0)


def responsive(lr: float, l2: float, n_swaps: int = 60) -> Tuple[bool, float]:
    """Same check as test_preference_converges_on_synthetic_ground_truth: a
    user who only ever prefers the more aesthetic photo must make nimaScore
    the dominant weight (and +0.1 over its default) within n_swaps."""
    rng = np.random.default_rng(7)
    m = PreferenceModel(lr=lr, l2_to_prior=l2)
    for _ in range(n_swaps):
        a = {s: float(rng.uniform()) for s in SIGNAL_ORDER}
        b = {s: float(rng.uniform()) for s in SIGNAL_ORDER}
        m.update(*((a, b) if a["nimaScore"] >= b["nimaScore"] else (b, a)))
    w = m.weights["nimaScore"]
    return bool(w > DEFAULT_WEIGHTS["nimaScore"] + 0.1 and w == max(m.weights.values())), w


def run_preference_tuning(scored: Dict[str, List[dict]], log, seed: int, passes=5,
                          persona_splits=40, n_users=20, user_splits=15):
    """Grid over (lr, l2_to_prior) on a tuning population drawn with its own
    seed, so the selected setting is evaluated later on fresh simulated users.

    Objective: mean held-out gain in top-1 agreement over 8 cells (3 personas
    plus the random-user group, each with and without 5% noisy clicks).
    Ties go to the setting with the better worst cell."""
    events = [signal_matrix(ms) for ms in scored.values() if len(ms) >= 2]
    rng = np.random.default_rng(seed)
    users = [(name, np.array([w[s] for s in SIGNAL_ORDER])) for name, w in PERSONAS.items()]
    users += [(f"dirichlet_{i:02d}", rng.dirichlet([0.7] * len(SIGNAL_ORDER))) for i in range(n_users)]
    rows = []
    for lr in LR_GRID:
        for l2 in L2_GRID:
            cells: Dict[str, List[float]] = {}
            for noise in (0.0, 0.05):
                for name, w_star in users:
                    is_rand = name.startswith("dirichlet")
                    res = simulate_user(events, w_star, np.random.default_rng(seed + 7), user_splits if is_rand else persona_splits,
                                        passes, 0.3, noise, {"lr": lr, "l2_to_prior": l2})
                    group = "random" if is_rand else name
                    cells.setdefault(f"{group}|{noise}", []).append(float((res["agree"][:, -1] - res["agree"][:, 0]).mean()))
            gains = {k: float(np.mean(v)) for k, v in cells.items()}
            ok, w_nima = responsive(lr, l2)
            row = {"lr": lr, "l2_to_prior": l2, "mean_gain": float(np.mean(list(gains.values()))),
                   "worst_cell_gain": min(gains.values()), "responsive_60_swaps": ok, "nima_after_60": w_nima,
                   **{f"gain[{k}]": v for k, v in gains.items()}}
            rows.append(row)
            log(f"  lr={lr:<5} l2={l2:<5} mean gain={row['mean_gain']:+.3f} worst cell={row['worst_cell_gain']:+.3f} "
                f"responsive={ok} (nima {w_nima:.2f})")
    best = max((r for r in rows if r["responsive_60_swaps"]),
               key=lambda r: (round(r["mean_gain"], 4), r["worst_cell_gain"]))
    log(f"  selected lr={best['lr']} l2_to_prior={best['l2_to_prior']} "
        f"(mean gain {best['mean_gain']:+.3f}, worst cell {best['worst_cell_gain']:+.3f})")
    return rows, {"lr": best["lr"], "l2_to_prior": best["l2_to_prior"]}


def run_preference_experiments(scored: Dict[str, List[dict]], log, rng, splits=200, passes=5, n_random_users=60,
                               model_kwargs: Optional[Dict[str, float]] = None, setting: str = "default"):
    events = [signal_matrix(ms) for ms in scored.values() if len(ms) >= 2]
    kw = model_kwargs or {}
    params = {"lr": kw.get("lr", PreferenceModel.lr), "l2_to_prior": kw.get("l2_to_prior", PreferenceModel.l2_to_prior)}
    log(f"  [{setting}: lr={params['lr']}, l2_to_prior={params['l2_to_prior']}] "
        f"{len(events)} reference events with >= 2 photos; test fraction 0.3; {splits} splits; {passes} passes")
    users = [(name, np.array([w[s] for s in SIGNAL_ORDER])) for name, w in PERSONAS.items()]
    for i in range(n_random_users):
        users.append((f"dirichlet_{i:02d}", rng.dirichlet([0.7] * len(SIGNAL_ORDER))))

    curve_rows, test_rows = [], []
    groups: Dict[str, Dict[str, List[np.ndarray]]] = {}
    for noise in (0.0, 0.05):
        for name, w_star in users:
            res = simulate_user(events, w_star, rng, splits if not name.startswith("dirichlet") else 40,
                                passes, 0.3, noise, kw)
            group = name if not name.startswith("dirichlet") else "random users (Dirichlet 0.7)"
            key = f"{group} | noise={noise}"
            g = groups.setdefault(key, {"agree": [], "regret": [], "swaps": [], "random": []})
            for k in g:
                g[k].append(res[k].mean(axis=0) if res[k].ndim == 2 else np.array([res[k].mean()]))
            if not name.startswith("dirichlet"):
                a = res["agree"]
                diff = a[:, -1] - a[:, 0]
                nz = diff[diff != 0]
                p = float(wilcoxon(a[:, -1], a[:, 0], alternative="greater").pvalue) if len(nz) else float("nan")
                test_rows.append({"setting": setting, **params, "user": name, "noise_temp": noise, "splits": a.shape[0],
                                  "agree_default": a[:, 0].mean(), "agree_learned": a[:, -1].mean(),
                                  "mean_gain": diff.mean(), "splits_improved": int((diff > 0).sum()),
                                  "splits_worse": int((diff < 0).sum()),
                                  "wilcoxon_p_one_sided": p, "random_pick_agree": res["random"].mean()})
    for key, g in groups.items():
        agree = np.mean(g["agree"], axis=0)
        regret = np.mean(g["regret"], axis=0)
        swaps = np.mean(g["swaps"], axis=0)
        rnd = float(np.mean(g["random"]))
        for p in range(len(agree)):
            curve_rows.append({"setting": setting, "user_group": key, "passes": p, "mean_swaps": swaps[p],
                               "test_top1_agreement": agree[p], "test_regret": regret[p],
                               "random_pick_agreement": rnd})
        log(f"  [{setting}] {key}: agreement {agree[0]:.3f} -> {agree[-1]:.3f} after {swaps[-1]:.1f} swaps "
            f"(random {rnd:.3f}); regret {regret[0]:.3f} -> {regret[-1]:.3f}")

    # Dirichlet group significance, one point per user
    for noise in (0.0, 0.05):
        g = groups[f"random users (Dirichlet 0.7) | noise={noise}"]
        a = np.array(g["agree"])
        diff = a[:, -1] - a[:, 0]
        p = float(wilcoxon(a[:, -1], a[:, 0], alternative="greater").pvalue) if np.any(diff != 0) else float("nan")
        test_rows.append({"setting": setting, **params, "user": f"{n_random_users} random users", "noise_temp": noise,
                          "splits": "40 per user",
                          "agree_default": a[:, 0].mean(), "agree_learned": a[:, -1].mean(),
                          "mean_gain": diff.mean(), "splits_improved": int((diff > 0).sum()),
                          "splits_worse": int((diff < 0).sum()), "wilcoxon_p_one_sided": p,
                          "random_pick_agree": float(np.mean(g["random"]))})
    return curve_rows, test_rows


# ------------------------------------------------------------------- figures

def make_figures(out: Path, curves, pref_curves, id_rows):
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    fig_dir = out / "figures"
    fig_dir.mkdir(exist_ok=True)

    fig, ax = plt.subplots(1, 2, figsize=(7.2, 2.7))
    for name, style in (("time_w0", "--"), ("time_w0.35", "-"), ("semester1", ":")):
        pts = [c for c in curves if c["series"] == name]
        t = [c["threshold"] for c in pts]
        ax[0].plot(t, [c["ARI"] for c in pts], style, label=name)
        ax[1].plot(t, [c["silhouette"] for c in pts], style, label=name)
    ax[0].set(xlabel="distance threshold", ylabel="ARI vs reference", title="Agreement with labels")
    ax[1].set(xlabel="distance threshold", ylabel="silhouette", title="Label-free selection signal")
    ax[0].legend(fontsize=7)
    fig.tight_layout()
    fig.savefig(fig_dir / "event_threshold_curves.png", dpi=200)
    plt.close(fig)

    fig, axes = plt.subplots(1, 2, figsize=(7.2, 2.8), sharey=True)
    groups = sorted({r["user_group"].split(" |")[0] for r in pref_curves})
    colours = dict(zip(groups, plt.rcParams["axes.prop_cycle"].by_key()["color"]))
    for ax, noise in zip(axes, ("0.0", "0.05")):
        for setting, style in (("previous", "--"), ("tuned", "-")):
            for g in groups:
                pts = [r for r in pref_curves if r["user_group"] == f"{g} | noise={noise}"
                       and r["setting"].startswith(setting)]
                if pts:
                    ax.plot([r["mean_swaps"] for r in pts], [r["test_top1_agreement"] for r in pts], style,
                            marker="o", markersize=2.5, color=colours[g],
                            label=g if setting == "tuned" else None)
        ax.set(xlabel="swaps so far (mean)", title="consistent user" if noise == "0.0" else "noisy user (softmax T=0.05)")
    axes[0].set_ylabel("held-out top-1 agreement")
    axes[0].legend(fontsize=6, title="solid = tuned, dashed = previous", title_fontsize=6)
    fig.tight_layout()
    fig.savefig(fig_dir / "preference_learning_curve.png", dpi=200)
    plt.close(fig)

    thr = [r for r in id_rows if r["experiment"] == "fused_threshold"]
    if thr:
        fig, ax = plt.subplots(figsize=(3.5, 2.6))
        x = [r["value"] for r in thr]
        ax.plot(x, [r["cannot_link_violation_rate"] for r in thr], "o-", label="cannot-link violation rate")
        ax.plot(x, [r["stability_ari_mean"] for r in thr], "s-", label="subsample stability (ARI)")
        ax.plot(x, [r["singleton_fraction"] for r in thr], "^-", label="singleton fraction")
        ax.set(xlabel="fused cosine-distance threshold", ylim=(-0.02, 1.02))
        ax.legend(fontsize=6)
        fig.tight_layout()
        fig.savefig(fig_dir / "identity_threshold_sweep.png", dpi=200)
        plt.close(fig)


# ---------------------------------------------------------------------- main

def environment_info(pipe: LuminaPipeline) -> Dict:
    import importlib
    versions = {}
    for mod in ("numpy", "torch", "transformers", "sklearn", "insightface", "onnx", "ultralytics", "torchreid", "pyiqa", "mediapipe"):
        try:
            versions[mod] = getattr(importlib.import_module(mod), "__version__", "?")
        except Exception as exc:  # pragma: no cover - diagnostic only
            versions[mod] = f"unavailable ({exc})"
    return {
        "python": platform.python_version(),
        "platform": platform.platform(),
        "device": str(pipe.device),
        "scene_model": pipe.dino_model_id_in_use,
        "blink_model": "mediapipe face_landmarker (blendshapes)" if lp.BlinkDetector()._ensure_loaded() else "geometric EAR fallback",
        "versions": versions,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("dataset_dir", type=Path)
    parser.add_argument("--out", type=Path, default=BACKEND_DIR.parent / "report" / "experiments")
    parser.add_argument("--reps", type=int, default=30, help="subsampling repetitions for stability")
    parser.add_argument("--splits", type=int, default=200, help="train/test splits per persona")
    parser.add_argument("--cache", type=Path, default=BACKEND_DIR / "eval" / "experiments_cache.db",
                        help="embedding cache; keys do not include the scene model, so use one file per backbone")
    parser.add_argument("--limit", type=int, default=None, help="first N images only (debugging)")
    parser.add_argument("--require-scene-model", default=None,
                        help="abort unless this scene model actually loaded (e.g. the DINOv3 id)")
    args = parser.parse_args()

    paths = sorted((p for p in args.dataset_dir.iterdir() if p.suffix.lower() in IMAGE_EXTS), key=lambda p: p.name)
    if args.limit:
        paths = paths[: args.limit]
    ids = [p.name for p in paths]
    truth = {pid: event_label_from_name(pid) for pid in ids}

    run_id = dt.datetime.now().strftime("%Y%m%d-%H%M%S")
    out = args.out / run_id
    out.mkdir(parents=True, exist_ok=True)
    log = Log(out / "run_log.txt")
    rng = np.random.default_rng(RNG_SEED)
    log(f"Lumina experiment run {run_id}: {len(paths)} images, {len(set(truth.values()))} reference events")

    store = LuminaStore(args.cache)
    if args.require_scene_model:
        probe = LuminaPipeline(config=PipelineConfig(enable_captions=False, enable_clip=False))
        probe._load_models()
        if probe.dino_model_id_in_use != args.require_scene_model:
            raise SystemExit(f"Scene model is {probe.dino_model_id_in_use}, not {args.require_scene_model}. "
                             "Log in to Hugging Face (hf auth login) or set HF_TOKEN.")
        del probe
    log("\n[A] full pipeline, cold then warm")
    pipe, result, timing_rows = run_full_pipeline(paths, ids, store, log)
    base_cfg = pipe.cfg
    F = load_features(pipe, paths, ids, truth)
    env = environment_info(pipe)
    log(f"  scene model: {env['scene_model']}; blink: {env['blink_model']}; device: {env['device']}")
    n_exif = sum(1 for p in paths if F.exif.get(str(p)) is not None)
    log(f"  photos with EXIF time: {n_exif}/{len(paths)}")
    nima_vals = np.array(list(F.nima.values()))
    log(f"  NIMA: min {nima_vals.min():.2f}, mean {nima_vals.mean():.2f}, max {nima_vals.max():.2f}")
    if np.ptp(nima_vals) == 0:
        raise SystemExit("Every NIMA score is identical; aesthetic scoring failed, so ranking results would be void.")

    log("\n[B1] identity clustering (label-free)")
    id_rows, identity_state = run_identity_experiments(pipe, F, base_cfg, log, args.reps, rng)

    log("\n[B2] event clustering")
    ev_rows, curves, reproduced = run_event_experiments(pipe, F, base_cfg, identity_state, log, args.reps, rng)

    log("\n[B3] best-shot ranking on reference events")
    rank_rows, default_scored = run_ranking_experiments(pipe, F, base_cfg, identity_state, log)
    members = [m for ms in default_scored.values() for m in ms]
    spread = {s: float(np.ptp([m["normSignals"][s] for m in members])) for s in SIGNAL_ORDER}
    log("  normalised signal range across scored photos: " + ", ".join(f"{s}={v:.2f}" for s, v in spread.items()))
    dead = [s for s, v in spread.items() if v == 0]
    if dead:
        raise SystemExit(f"Signals with no variation: {dead}; an extractor failed, so ranking results would be void.")

    log("\n[B4a] preference learning: tune (lr, l2_to_prior) on a separate simulated population")
    tuning_rows, tuned = run_preference_tuning(default_scored, log, seed=RNG_SEED + 1000)

    log("\n[B4b] preference learning: held-out evaluation on fresh simulated users")
    pref_curves, pref_tests = [], []
    for setting, kw in (("previous (lr=0.35, l2=0.05)", {"lr": 0.35, "l2_to_prior": 0.05}),
                        ("tuned", tuned)):
        c, t = run_preference_experiments(default_scored, log, np.random.default_rng(RNG_SEED + 2000),
                                          splits=args.splits, model_kwargs=kw, setting=setting)
        pref_curves += c
        pref_tests += t

    write_csv(out / "timing.csv", timing_rows)
    write_csv(out / "identity.csv", id_rows)
    write_csv(out / "events.csv", ev_rows)
    write_csv(out / "event_threshold_curves.csv", curves)
    write_csv(out / "ranking.csv", rank_rows)
    write_csv(out / "preference_curves.csv", pref_curves)
    write_csv(out / "preference_tests.csv", pref_tests)
    write_csv(out / "preference_tuning.csv", tuning_rows)
    pipeline_summary = {k: v for k, v in result["summary"].items() if k != "timings"}
    (out / "config.json").write_text(json.dumps({
        "run_id": run_id,
        "dataset": str(args.dataset_dir),
        "images": len(paths),
        "reference_events": len(set(truth.values())),
        "photos_with_exif": n_exif,
        "rng_seed": RNG_SEED,
        "stability_reps": args.reps,
        "preference_splits": args.splits,
        "preference_tuned": tuned,
        "preference_model_defaults": {"lr": PreferenceModel.lr, "l2_to_prior": PreferenceModel.l2_to_prior},
        "harness_reproduces_pipeline_events": bool(reproduced),
        "pipeline_config": dataclasses.asdict(base_cfg),
        "pipeline_summary": pipeline_summary,
        "environment": env,
    }, indent=2, default=str), encoding="utf-8")
    make_figures(out, curves, pref_curves, id_rows)
    log(f"\nWrote results to {out}")
    log.flush()


if __name__ == "__main__":
    main()
