# Lumina Evaluation

Scripts that produce the numbers in the technical paper
(`report/lumina_technical_paper_with_humantest.tex`, Section V). Run them from
`backend/` with the project venv.

## Paper experiments

```bash
cd backend
../venv/Scripts/python.exe eval/experiments.py "../report/Test Images" --out ../report/experiments
../venv/Scripts/python.exe eval/human_study.py prepare   # writes report/human_study/config.json
../venv/Scripts/python.exe eval/human_study.py serve     # local keep-one form, appends to responses.csv
../venv/Scripts/python.exe eval/human_study.py score     # one learning step per disagreement, held-out scoring
```

| Script | Paper result |
|---|---|
| `experiments.py` | Identity: cannot-link merges (0 of 526) and subsample stability for fused, face-only and body-only modes, plus the threshold and α-floor sweeps (Table III) |
| `experiments.py` | Events: ARI against the folder grouping, stability, the coarse-vs-fine sweep, the time-weight sweep and the Semester 1 features (Table IV, Fig. 2) |
| `experiments.py` | Ranker: winners changed and avoidable blink picks when one part is removed or a weight moves ±20% (Table V) |
| `experiments.py` | Timing: cold pass 82 s, cached repeat 1.9 s |
| `human_study.py` | The 13-person keep-one study: position of the kept photo in Lumina's order, repeat consistency, held-out matches after learning (Table VI) |

The test set is 55 private photos in `report/Test Images/`. File names carry the
reference occasion (`9-3.JPG` is photo 3 of occasion 9). Nobody labelled
identities, so identity results use cannot-link and stability checks rather than
ARI against people.

Each run writes a timestamped folder under `report/experiments/`. The run behind
the paper is `report/experiments/20260928-130909/`. The hosted copy of the
keep-one form is in `report/human_study/`. `lumina_answers.csv` there is an export
from the hosted form.

## Earlier harness

These scripts score against a hand-labelled dataset and were written for the
Semester 1 proposal targets. The paper does not report them.

```bash
../venv/Scripts/python.exe eval/eval_preferences.py            # synthetic users, no data needed
../venv/Scripts/python.exe eval/eval_identity.py  <dataset>    # needs labels.csv
../venv/Scripts/python.exe eval/eval_events.py    <dataset>    # needs labels.csv
../venv/Scripts/python.exe eval/eval_search.py    <dataset>    # needs queries.csv
../venv/Scripts/python.exe eval/eval_speed.py     <image_dir>  # any image folder
```

| Script | Metric |
|---|---|
| `eval_identity.py` | Identity ARI/NMI, face-only vs body-only vs fused |
| `eval_events.py` | Event ARI/NMI and CLIP naming coverage |
| `eval_search.py` | Search Recall@1/5/10 |
| `eval_preferences.py` | Convergence on synthetic users (weight cosine, top-1 agreement) |
| `eval_speed.py` | Cold vs warm runtime, cache speed-up |

A dataset is a folder of images plus a `labels.csv`:

```csv
filename,person,event
img_001.jpg,alice,beach_day
img_002.jpg,bob,beach_day
img_003.jpg,alice;bob,dinner        # multi-person: excluded from identity eval
img_004.jpg,,dinner                 # no-person photo: event eval only
```

For search, add a `queries.csv`:

```csv
query,relevant
"people hugging on the beach","img_001.jpg;img_002.jpg"
"birthday cake with candles","img_010.jpg"
```

To build labels quickly, run the folder through the app, fix its mistakes in the
gallery (merge, rename, re-pin), and start `labels.csv` from the corrected
assignments. The corrections are logged in the `corrections` table. PIPA
(identity in albums) and PEC (event collections) are public sets worth trying.
