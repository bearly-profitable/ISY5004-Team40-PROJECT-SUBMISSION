"""Synthetic validation of pairwise preference learning (no models needed).

Usage:
    python eval/eval_preferences.py [--trials 20] [--swaps 100]

Protocol: sample a hidden ground-truth weight vector w* on the simplex, then
simulate a user who, shown random photo pairs, promotes whichever photo w*
scores higher. Feed those swaps to PreferenceModel and measure how well the
learned weights recover w* (cosine similarity) and how often the learned
model's top-1 pick agrees with the hidden user (top-1 agreement) as the
number of swaps grows.

This is the honest capstone-scale substitute for a live multi-user RL study:
it demonstrates the mechanism converges, while real-user validation is
documented as future work.
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

import numpy as np

BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from curation import SIGNAL_ORDER, PreferenceModel  # noqa: E402
from common import print_table  # noqa: E402

CHECKPOINTS = [0, 5, 10, 20, 40, 60, 100]


def sample_simplex(rng: np.random.Generator, concentration: float = 0.7) -> np.ndarray:
    return rng.dirichlet([concentration] * len(SIGNAL_ORDER))


def random_signals(rng: np.random.Generator) -> dict:
    return {s: float(rng.uniform()) for s in SIGNAL_ORDER}


def top1_agreement(model: PreferenceModel, w_star: np.ndarray, rng: np.random.Generator, n_events: int = 200) -> float:
    """Fraction of simulated 6-photo events where the model's top pick matches
    the hidden user's top pick."""
    agree = 0
    for _ in range(n_events):
        photos = [random_signals(rng) for _ in range(6)]
        star_scores = [float(w_star @ np.array([p[s] for s in SIGNAL_ORDER])) for p in photos]
        model_scores = [model.score(p) for p in photos]
        if int(np.argmax(star_scores)) == int(np.argmax(model_scores)):
            agree += 1
    return agree / n_events


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--trials", type=int, default=20)
    parser.add_argument("--swaps", type=int, default=100)
    parser.add_argument("--seed", type=int, default=42)
    args = parser.parse_args()

    rng = np.random.default_rng(args.seed)
    checkpoints = [c for c in CHECKPOINTS if c <= args.swaps]

    cos_by_ckpt = {c: [] for c in checkpoints}
    agree_by_ckpt = {c: [] for c in checkpoints}

    for _trial in range(args.trials):
        w_star = sample_simplex(rng)
        model = PreferenceModel()

        for n_swap in range(args.swaps + 1):
            if n_swap in cos_by_ckpt:
                w = model.as_vector()
                cos = float(w @ w_star / (np.linalg.norm(w) * np.linalg.norm(w_star)))
                cos_by_ckpt[n_swap].append(cos)
                agree_by_ckpt[n_swap].append(top1_agreement(model, w_star, rng))
            if n_swap == args.swaps:
                break

            a, b = random_signals(rng), random_signals(rng)
            score_a = float(w_star @ np.array([a[s] for s in SIGNAL_ORDER]))
            score_b = float(w_star @ np.array([b[s] for s in SIGNAL_ORDER]))
            winner, loser = (a, b) if score_a >= score_b else (b, a)
            model.update(winner, loser)

    rows = [
        {
            "swaps": c,
            "weight_cosine_mean": float(np.mean(cos_by_ckpt[c])),
            "weight_cosine_std": float(np.std(cos_by_ckpt[c])),
            "top1_agreement_mean": float(np.mean(agree_by_ckpt[c])),
        }
        for c in checkpoints
    ]
    print_table(
        f"Preference-learning convergence ({args.trials} trials, hidden Dirichlet users)",
        rows,
    )
    print("Row 0 = untrained prior (default weights). Improvement over row 0 is the learning effect.")


if __name__ == "__main__":
    main()
