# Lumina Evaluation Harness

Scripts that turn the report's Section 6 targets into measured numbers.
Run everything from `backend/` with the project venv:

```bash
cd backend
../venv/Scripts/python.exe eval/eval_preferences.py            # no data needed
../venv/Scripts/python.exe eval/eval_identity.py  <dataset>    # needs labels.csv
../venv/Scripts/python.exe eval/eval_events.py    <dataset>    # needs labels.csv
../venv/Scripts/python.exe eval/eval_search.py    <dataset>    # needs queries.csv
../venv/Scripts/python.exe eval/eval_speed.py     <image_dir>  # any image folder
```

| Script | Report metric | Proposal target |
|---|---|---|
| `eval_identity.py` | Identity clustering ARI/NMI, ablated face-only vs body-only vs fused | ARI > 0.85 |
| `eval_events.py` | Event clustering ARI/NMI + CLIP auto-naming coverage | — |
| `eval_search.py` | Cross-modal search Recall@1/5/10 | Recall@5 > 0.75 |
| `eval_preferences.py` | Preference-learning convergence on synthetic users (weight cosine, top-1 agreement) | — |
| `eval_speed.py` | Cold vs warm runtime, embedding-cache speedup | < 90 s / 80 images |

## Dataset format

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

## Building the labeled set without hand-labeling from scratch

1. Run the folder through the Lumina web app.
2. Fix the mistakes in the gallery (merge split people, rename, re-pin best
   shots) — corrections are logged server-side in the `corrections` table.
3. Export the corrected identity/event assignments as your `labels.csv`
   starting point, then spot-check.

Correcting model output is 5–10x faster than labeling blind, and the
corrections log itself is reportable data (what kinds of mistakes the
clustering made).

Public backbones worth considering: PIPA (People in Photo Albums) for
identity-in-albums, PEC (Photo Event Collection) for event clustering.
