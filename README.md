# Lumina: AI-Powered Photo Curation & Management Platform

> **In this repo, we have:** 1 full report PDF, 1 full presentation video MP4, 1 research and tuning Python notebook, and 1 full codebase (frontend + backend) for our webapp.

A photo management system that clusters, scores, curates, explains, and *learns from* photo collections using computer vision and ML. Upload a batch of photos, get back the best shot of each person at each event — with a natural-language explanation of why, semantic text search over the collection, and a taste profile that adapts to your feedback.

## Project Explanation & Demo

Watch our platform in action: [Full Recorded Presentation Link](https://youtu.be/63fbOCV3cN4)

Visit our website to test it yourself: [Live Link](https://lumina-production-639d.up.railway.app/)

## System Architecture

![Lumina System Architecture](frontend/public/Lumina-architecture.png)

**Layer descriptions:**

| Layer | What happens |
|-------|--------------|
| **Client & Deployment** | User uploads photos (drag-and-drop or file picker) via the React SPA. The FastAPI backend enqueues a job on a single-worker queue (the ML models are shared, so jobs run strictly one at a time). Docker containers are served on Railway behind nginx. |
| **Feature Extraction** | Four streams run in parallel on every image: ArcFace produces 512-D face identity vectors + quality signals; YOLOv8 detects full-body bounding boxes; DINO encodes the scene context; CLIP encodes semantics for search and event naming. Body crops are fed through OSNet for 512-D re-ID embeddings. Per-image features are cached in SQLite keyed by content hash — re-analysing seen photos skips inference entirely. |
| **Identity Clustering** | Faces are matched to bodies by greedy IoU/containment (one face per body). Each face becomes a **confidence-weighted fused embedding** `e_fused = α·e_face ⊕ (1−α)·e_body` (α from detection confidence + face size), clustered with agglomerative clustering (cosine, average linkage). Faceless detections attach to the nearest identity by ReID centroid. HDBSCAN handles the no-faces fallback. |
| **Event Clustering** | Agglomerative clustering on DINO scene vectors with an automatically-swept distance threshold (silhouette score optimisation) groups photos into events. Events are then **auto-named zero-shot** by comparing their CLIP centroid to a prompt bank ("Wedding", "Beach", "Hiking", …). |
| **Multi-Signal Scoring** | Seven quality signals are combined into a weighted composite (min-max normalised per event). The best shot is selected **per event and per person** — each person's photos are re-scored with *their own* face signals. Every selection ships with a template-generated explanation. |
| **Diversity & Personalisation** | MMR (Maximal Marginal Relevance) produces diversity-aware highlight sets in three modes (Quality / Balanced / Diverse). User "promote to best" swaps are logged as pairwise preferences and learned via Bradley-Terry SGD into a personal 7-signal weight vector that can re-rank any session. |
| **Smart Gallery** | Interactive gallery: events, people, per-person best shots, score breakdowns, "why this photo?" explanations, CLIP text search, human-in-the-loop cluster corrections (rename/merge people, re-pin best shots — persisted server-side), album export as zip, and a persistent session history. |

---

## Core Components

### 1. Photo Ingestion

- **Local upload only** — drag-and-drop or file-picker. Nothing to connect, no OAuth,
  no third-party account. Photos are deleted with the job after `JOB_TTL_HOURS`.

Up to **200 photos** per analysis run (the embedding cache makes repeat runs near-instant).

### 2. AI Analysis Pipeline

#### Stage 1: Parallel Feature Extraction (cache-aware)

| Stream | Model | Output |
|--------|-------|--------|
| **Face Detection & Embedding** | InsightFace / ArcFace (buffalo_l) | 512-d identity vectors + quality signals (sharpness, pose, confidence, eye-aspect ratio) |
| **Person Detection** | YOLOv8 Nano | Full-body bounding boxes + crops |
| **Scene Embedding** | DINOv3 ViT-S/16 (DINOv2 fallback) | Scene-level context vectors for event grouping |
| **Semantic Embedding** | CLIP ViT-B/32 | 512-d embeddings for text search + zero-shot event naming |

Every per-image feature bundle is cached in SQLite keyed by the image's SHA-256, so previously analysed photos are never re-processed.

#### Stage 2: Body Re-Identification

Person crops → **OSNet** (torchreid) 512-d body embeddings, used both as fusion input and as the occluded-face fallback.

#### Stage 3: Identity Clustering (confidence-weighted fusion)

1. Faces are assigned to person boxes by **greedy IoU/containment matching** with a head-position prior — one face per body, robust to overlapping people in group shots.
2. Each face record gets a fused embedding: `α` ramps with ArcFace detection confidence and face size (floor 0.5 — a detected face is always the primary identity signal). The fusion lives in a concatenated space where cosine similarity equals the α-weighted blend of face and body similarities.
3. Agglomerative clustering (cosine distance, average linkage) over fused embeddings; faceless detections attach via ReID centroid distance; pure-ReID HDBSCAN as the no-faces fallback.
4. Ablation modes are built in: `identity_mode = fused | face_only | body_only` (see `eval/`).

#### Stage 4: Event Clustering + Zero-Shot Naming

DINO embeddings → agglomerative clustering with a silhouette-swept threshold (0.1–3.0, early-stopped). Each event's CLIP centroid is compared against a 20-entry prompt bank; confident matches replace "Event N" with names like "Beach" or "Graduation".

#### Stage 5: Multi-Signal Scoring, Per-Person Selection & Explanations

Seven signals, min-max normalised within each event:

| Signal | Default Weight | Description |
|--------|--------|-------------|
| **Centrality** | 0.25 | Cosine similarity to the event's DINO centroid |
| **NIMA Score** | 0.25 | Neural Image Assessment aesthetic quality (0–10) |
| **Face Sharpness** | 0.15 | Laplacian variance of the face region |
| **Face Size** | 0.10 | Face area relative to the image |
| **Detection Confidence** | 0.10 | InsightFace detection score |
| **Pose Quality** | 0.10 | Penalty for yaw / pitch / roll deviation |
| **Eye Aspect Ratio** | 0.05 | Open-eye detection (anti-blink) |

- **Per event**: top composite score wins, with an explanation ("sharpest face, eyes open, most representative of the scene; beat the runner-up mainly on pose").
- **Per event × person**: each person's candidate photos are re-scored using *that person's* face signals — the true "best shot of each person at each event".
- **MMR highlights**: `λ·relevance − (1−λ)·max-similarity-to-selected` at λ = 0.9 / 0.7 / 0.45 gives Quality / Balanced / Diverse showcase sets.

#### Stage 6: Facial Geometry Analysis (Bonus Feature)

Optional deep-dive with **MediaPipe FaceMesh** (468 landmarks): symmetry, proportions, skin quality, per-feature scores.

### 3. Learning From Feedback (Pairwise Preference Learning)

When a user promotes a different photo to "Best Shot", that is a pairwise observation *winner ≻ loser*. Lumina runs one Bradley-Terry SGD step over the normalised 7-signal difference vector, with an L2 pull toward the default weights and simplex projection. The learned per-user weights:

- are visible in the UI ("My Taste" panel, learned vs default per signal),
- can re-rank any session on demand (`POST /api/rescore/{jobId}`),
- converge on synthetic users in ~20–60 swaps (see `backend/eval/eval_preferences.py`).

### 4. Human-in-the-Loop Corrections

All persisted server-side and logged (the corrections log doubles as evaluation data):

- rename / **merge** identity clusters, move photos between people
- re-pin an event's best shot (also feeds preference learning)
- rename / delete events

### 5. One-Click AI Enhancement (identity-guarded)

Every best shot — both the event hero and each showcase pick — carries an
**Enhance** button beside its download button. The photo is sent to an OpenRouter
image-edit model under a deliberately constrained retouch prompt, then verified
before it is ever shown:

1. **Constrained prompt** — retouch vocabulary only (skin tone, blemishes, eyes,
   exposure, colour, noise), with explicit prohibitions on reshaping features,
   slimming, de-ageing, changing ethnicity, re-framing or altering the aspect ratio.
2. **ArcFace identity guard** — every face in the original is matched to its closest
   counterpart in the result using the same InsightFace model the pipeline already
   loads. The *weakest* per-face similarity becomes the identity score, so one drifted
   face in a group shot is still caught.
   - `< 0.45` → the edit is **discarded** and the user is told why
   - `0.45 – 0.65` → shown with a drift warning
   - `≥ 0.65` → accepted, with the match percentage surfaced in the UI
   - no face detected → shown, flagged as unverified

Enhancements are non-destructive: the original is never overwritten, the card toggles
between the two, one click reverts, and the album export can use either. Results
persist with the session.

### 6. Themed PDF Album Export (bento layout)

An **Album** button turns the current selection into a designed, printable PDF rather
than a contact sheet:

- **Bento grid** — each page places photos on a 12x12 unit grid with mixed spans, so one
  or two tiles dominate and the rest form a rhythm. Seventeen templates cover 1–9 photos
  per page, each tiling the grid exactly (the test suite asserts it cell by cell), and
  pages alternate between variants so a long album never settles into one beat.
- **Photos are never darkened.** Labels sit in the gutter *beneath* each tile — an
  earlier version drew a scrim inside the tile and muddied every image.
- **Six themes** — Midnight, Ivory, Blush, Mono, Forest and Paper. Palette, page
  gradient, film grain, rule weights and display typeface change together. **Paper** is
  flat by design: one white, hairline rules, square corners, no shadow — built for 小黑
  (see below), whose style rules forbid all three.
- **Chapters** — consecutive photos sharing an event become a section, announced by a
  divider page carrying the event name and its size. Dividers take their own folio
  number but do not consume a bento template, so layout alternation is unchanged (the
  test suite asserts a chaptered album lays out identically to a flat one).
- **Cast page** — circular portraits of every clustered identity, cropped around the
  face box the pipeline already produced, introducing the people before the photos.
- **Editorial cover** — masthead, display title, a stat rail counted over what actually
  made the album, an accent rule, corner marks and a three-tile bento preview strip.
- **AI captions** (optional) — `gpt-5.6-luna` sees the batch and writes a 2–4 word title
  per photo, grounded in what is visible ("Pair Sharing Smartphone", "Woman Holding
  Question Phone"). It is told never to invent places, dates or names, and falls back to
  event labels on any failure.
- **AI album titles** (optional) — named from real event labels and person names.
- **Cover-cropped** tiles with rounded corners and soft Pillow-rendered shadows: no
  letterboxing, no distorted aspect ratios.

Rendering splits Pillow (gradients, crops, masks, shadows) and ReportLab (vector type,
rules, page structure). Slot composites embed as JPEG rather than alpha PNG, which took
a three-page album from ~9 MB to under 1 MB.

Every image goes through one `_draw_image` helper that resets the fill alpha first:
ReportLab's fill alpha is graphics state and applies to images as well as text, so the
page chrome — drawn before the photographs, footer set at 0.75 — was silently fading
every photo on every content page toward the paper colour.

### 6b. 小黑, the album's stagehand

The divider, cast and closing pages are worked by a small character adapted from
[`ian-xiaohei-illustrations`](https://github.com/helloianneo/ian-xiaohei-illustrations)
by [Ian](https://github.com/helloianneo) (MIT). That project is a *prompt skill* — every
picture is generated fresh by an image model — which an album cannot afford: a twelve-page
export would mean a dozen model calls, a dozen seconds of latency, and twelve characters
that do not quite match. So `backend/xiaohei.py` draws him procedurally instead, from the
description in the project's own `xiaohei-ip.md`: a solid black creature, white dot eyes,
thin legs, blank expression, slightly uneven hand-drawn outline.

- **Poses are data, not files.** A pose is a body tilt plus foot, hand and prop
  coordinates in unit space; the renderer fits the whole figure to whatever frame it is
  given. Any size renders crisp at print DPI and nothing has to be redrawn by hand.
- **The outline is a sum of low-frequency harmonics**, not per-vertex noise — high
  frequency jitter reads as a bad render, a few slow undulations read as a pen.
- **He does the work.** The source IP's own test is that if removing 小黑 leaves the
  meaning intact, he was decoration. So he hauls prints between chapters, pegs photos to
  a line, and hands out name tags on the cast page — never stands and watches.
- **On dark themes he is drawn in the page's ink**, not black, because a solid black
  character disappears on Midnight. The silhouette identifies him, not the colour.
- **Design your own** — bean, cylinder, box, funnel or shadow, seeded per album.

The browser cannot run that code, so `GET /api/xiaohei/{pose}.png` serves the same
drawing to the viewer; it is deterministic in its query string and cached hard.

### 7. Smart Gallery & Results

- **Event view** with per-person best-shot strips and explanations
- **Showcase mode** with MMR diversity modes (Quality / Balanced / Diverse)
- **Semantic search** box — "group hug", "sunset", "someone laughing" (CLIP; brute-force cosine is exact and instant at this scale, no ANN index needed)
- **Sessions** page — every analysis persists in SQLite and reopens anytime (with corrections applied); photos are served from the backend
- **Export** — download the current curated selection as a zip

---

## Machine Learning Architecture

| Model / Algorithm | Role | Key Detail |
|-------------------|------|------------|
| **InsightFace** (ArcFace, buffalo_l) | Face detection + identity embedding | 512-d cosine-comparable vectors + quality signals |
| **YOLOv8 Nano** | Person detection | Body boxes for fusion + occluded-face fallback |
| **OSNet** (torchreid) | Body re-identification | 512-d embeddings on 256×128 crops |
| **DINOv3** (ViT-S/16, DINOv2 fallback) | Scene understanding | Self-supervised ViT for event grouping |
| **CLIP** (ViT-B/32) | Semantics | Text-image search + zero-shot event naming |
| **Agglomerative Clustering** | Identity (fused space) + events | Cosine, average linkage; silhouette-swept threshold for events |
| **HDBSCAN** | No-face fallback clustering | Density-adaptive on ReID embeddings |
| **NIMA** (pyiqa) | Aesthetic scoring | Composition, colour, exposure (0–10) |
| **MMR** | Diversity-aware selection | λ-tunable relevance/diversity trade-off |
| **Bradley-Terry SGD** | Preference learning | Personal signal weights from pairwise swaps |
| **MediaPipe FaceMesh** | Facial geometry | 468 landmarks (bonus feature) |

---

## Engineering

| Concern | Implementation |
|---------|----------------|
| **Persistence** | SQLite (`backend/lumina.db`): jobs, results, feedback, preferences, corrections log, embedding cache. Sessions survive restarts. |
| **Concurrency** | Single-worker job queue — the shared model objects are not thread-safe, so analyses run one at a time; interrupted jobs are marked failed on restart. |
| **Incremental speed** | Per-image feature cache keyed by content SHA-256 (`cache_version` salt invalidates on pipeline changes). Warm re-runs skip all inference. |
| **Job hygiene** | Hourly TTL cleanup deletes job rows + input files older than `JOB_TTL_HOURS` (default 24) and prunes the cache. |
| **Auth** | Optional shared-secret: set `LUMINA_API_KEY` (backend) + `VITE_API_KEY` (frontend); photo serving stays open (unguessable job UUIDs). |
| **Tests** | `backend/tests/` — 110 pytest tests: pure-math units (fusion, MMR, IoU matching, explanations, preference learning, corrections, store, bento tiling and PDF rendering, the enhancement identity guard, the OpenRouter client) + API integration with a mocked pipeline and a mocked OpenRouter. |
| **CI** | GitHub Actions: backend unit tests + frontend typecheck/build on every push. |
| **Evaluation** | `backend/eval/` — scripts for identity-clustering ablations (ARI/NMI), event clustering, search Recall@K, preference convergence, and cache speedup. See `backend/eval/README.md`. |

### API Surface

| Endpoint | Purpose |
|----------|---------|
| `POST /api/analyze`, `GET /api/analyze/{id}` | Start / poll an analysis job |
| `GET /api/sessions`, `GET /api/sessions/{id}` | Persistent session history |
| `GET /api/photos/{jobId}/{photoId}` | Serve stored photos for reopened sessions |
| `POST /api/search/{jobId}` | CLIP text→image search |
| `POST /api/feedback` | Pairwise swap → preference update + pin |
| `GET/POST /api/preferences[...]` | Taste profile read / reset |
| `POST /api/rescore/{jobId}` | Re-rank with personal weights |
| `POST /api/corrections/{jobId}` | Cluster corrections (rename/merge/move/pin/delete) |
| `POST /api/export/{jobId}` | Zip download of a curated selection |
| `POST /api/enhance`, `GET /api/enhance/{id}` | Start / poll an AI enhancement |
| `GET/DELETE /api/enhanced/{jobId}/{photoId}` | Serve or discard an enhanced photo |
| `GET /api/collage/themes` | Available album themes + AI availability |
| `POST /api/collage/{jobId}` | Themed PDF album download |
| `POST /api/face-analysis` | Facial geometry deep-dive |

---

## Technical Stack

### Frontend

| Technology | Purpose |
|------------|---------|
| **React 19** with TypeScript | UI framework |
| **Vite 6** | Build tool & dev server (`npm run build` typechecks with tsc) |
| **Three.js** + **GSAP** | WebGL landing page |
| **Lucide React** | Icons |
| **Vanilla CSS** | Glass-morphism design system |

### Backend

| Technology | Purpose |
|------------|---------|
| **Python 3.11**, **FastAPI** + **Uvicorn** | Async REST API |
| **PyTorch** + **Transformers** | DINO + CLIP inference |
| **InsightFace / ultralytics / torchreid / pyiqa / MediaPipe** | Task models |
| **scikit-learn / hdbscan** | Clustering + silhouette analysis |
| **SQLite** (stdlib) | Persistence + embedding cache |
| **ReportLab + Pillow** | Themed PDF album rendering |
| **OpenRouter** | Image editing (enhance) + text (album titles) |
| **pytest** | Test suite |

---

## Getting Started

### Prerequisites

- **Node.js 18+**, **Python 3.11+**
- An [OpenRouter](https://openrouter.ai) API key *(optional — only the AI enhance
  button and AI album titles need it; everything else runs locally)*

### Local Development

```bash
# ── Frontend ──
cd frontend
npm install

# ── Backend ──
cd ../backend
python -m venv ../venv
../venv/Scripts/activate      # Windows
pip install -r requirements.txt

# ── Run both (Windows) ──
cd .. && ./start.ps1
# or manually:
#   backend:  cd backend && uvicorn server:app --reload    → http://127.0.0.1:8000
#   frontend: cd frontend && npm run dev                   → http://localhost:5173
```

### Tests & Evaluation

```bash
cd backend
../venv/Scripts/python.exe -m pytest tests -q          # full suite (110 tests)
../venv/Scripts/python.exe eval/eval_preferences.py    # synthetic preference convergence
# labeled-data evals: see backend/eval/README.md
```

### Environment Variables

`frontend/.env.local`:

```env
VITE_BACKEND_URL=http://127.0.0.1:8000
# VITE_API_KEY=shared-secret            # only if the backend sets LUMINA_API_KEY
```

`backend/.env`:

```env
FRONTEND_URL=http://localhost:5173

# OpenRouter — powers AI enhancement, album titles and photo captions.
# Without a key those features are disabled and everything else works unchanged.
OPENROUTER_API_KEY=sk-or-v1-...
OPENROUTER_BASE_URL=https://openrouter.ai/api/v1
OPENROUTER_TEXT_MODEL=openai/gpt-5.6-luna
OPENROUTER_IMAGE_MODEL=openai/gpt-5.4-image-2

# LUMINA_API_KEY=shared-secret          # enable API auth (recommended for public deploys)
# JOB_TTL_HOURS=24                      # session/photo retention
# MAX_PHOTOS=300                        # server-side per-job cap
```

> **Choosing the image model — this one is a trap.** OpenRouter exposes two
> different image surfaces and only one of them can *edit* a photo:
>
> | Surface | Behaviour |
> |---|---|
> | `POST /chat/completions` with `modalities: ["image","text"]` | Accepts an input image and returns an edited one. **The only transport that can retouch.** |
> | `POST /images` (`{model, prompt}` → `data[].b64_json`) | Text-to-image only. Every input-image parameter is accepted and then *silently ignored*. |
>
> `openai/gpt-image-2.5-flare` is served **only** on `/images`, so asking it to
> "enhance this photo" returns a picture of somebody else entirely — verified
> against a real photo, it invented two unrelated people. `enhance.py` therefore
> refuses the text-to-image models listed in `openrouter.MODELS_WITHOUT_EDITING`
> with an actionable error rather than returning an invented image. Use
> `generate_image()` if you ever want that model for genuine text-to-image work.
>
> Among the models that *do* edit, measured on the same photo and prompt:
>
> | Model | ArcFace identity | Cost | Note |
> |---|---|---|---|
> | `openai/gpt-5.4-image-2` *(default)* | **0.96** | ~$0.23 | Re-renders at a fixed output size, so non-square photos get re-framed |
> | `google/gemini-3.1-flash-image` | 0.94 | ~$0.07 | Edits in place; holds the source aspect ratio |

### 5. One-Click AI Enhancement (identity-guarded)

Every best shot — both the event hero and each showcase pick — carries an
**Enhance** button beside its download button. The photo is sent to an OpenRouter
image-edit model under a deliberately constrained retouch prompt, then verified
before it is ever shown:

1. **Constrained prompt** — retouch vocabulary only (skin tone, blemishes, eyes,
   exposure, colour, noise), with explicit prohibitions on reshaping features,
   slimming, de-ageing, changing ethnicity, re-framing or altering the aspect ratio.
2. **ArcFace identity guard** — every face in the original is matched to its closest
   counterpart in the result using the same InsightFace model the pipeline already
   loads. The *weakest* per-face similarity becomes the identity score, so one drifted
   face in a group shot is still caught.
   - `< 0.45` → the edit is **discarded** and the user is told why
   - `0.45 – 0.65` → shown with a drift warning
   - `≥ 0.65` → accepted, with the match percentage surfaced in the UI
   - no face detected → shown, flagged as unverified

Enhancements are non-destructive: the original is never overwritten, the card toggles
between the two, one click reverts, and the album export can use either. Results
persist with the session.

### 6. Themed PDF Album Export

An **Album** button turns the current selection into a designed, printable PDF rather
than a contact sheet:

- **Four themes** — Midnight, Ivory, Blush, Mono. Palette, gradient background, film
  grain and typography travel together.
- **Varied mosaics** — layout templates for 1–6 photos per page, alternating between
  pages so a long album never falls into a uniform grid.
- **Cover page** with the album title, an accent rule and a hero image.
- **Cover-cropped** photos with rounded corners and soft Pillow-rendered shadows; no
  letterboxing, no distorted aspect ratios.
- **Captions** drawn from the real clustering — event label plus the people in each shot.
- **AI titles** (optional) — the text model names the album from actual event labels
  and person names, e.g. "Beach Afternoon" + "Dinner" → *"Beach to Dinner"*. It is
  instructed never to invent places, dates or occasions, and falls back to the first
  event label if the call fails.

Rendering splits Pillow (gradients, crops, masks, shadows) and ReportLab (vector type,
rules, page structure). Slot composites are embedded as JPEG rather than alpha PNG,
which took a three-page album from ~9 MB to ~880 KB.

### 7. Smart Gallery & Results

- **Event view** with per-person best-shot strips and explanations
- **Showcase mode** with MMR diversity modes (Quality / Balanced / Diverse)
- **Semantic search** box — "group hug", "sunset", "someone laughing" (CLIP; brute-force cosine is exact and instant at this scale, no ANN index needed)
- **Sessions** page — every analysis persists in SQLite and reopens anytime (with corrections applied); photos are served from the backend
- **Export** — download the current curated selection as a zip

---

## Machine Learning Architecture

| Model / Algorithm | Role | Key Detail |
|-------------------|------|------------|
| **InsightFace** (ArcFace, buffalo_l) | Face detection + identity embedding | 512-d cosine-comparable vectors + quality signals |
| **YOLOv8 Nano** | Person detection | Body boxes for fusion + occluded-face fallback |
| **OSNet** (torchreid) | Body re-identification | 512-d embeddings on 256×128 crops |
| **DINOv3** (ViT-S/16, DINOv2 fallback) | Scene understanding | Self-supervised ViT for event grouping |
| **CLIP** (ViT-B/32) | Semantics | Text-image search + zero-shot event naming |
| **Agglomerative Clustering** | Identity (fused space) + events | Cosine, average linkage; silhouette-swept threshold for events |
| **HDBSCAN** | No-face fallback clustering | Density-adaptive on ReID embeddings |
| **NIMA** (pyiqa) | Aesthetic scoring | Composition, colour, exposure (0–10) |
| **MMR** | Diversity-aware selection | λ-tunable relevance/diversity trade-off |
| **Bradley-Terry SGD** | Preference learning | Personal signal weights from pairwise swaps |
| **MediaPipe FaceMesh** | Facial geometry | 468 landmarks (bonus feature) |

---

## Engineering

| Concern | Implementation |
|---------|----------------|
| **Persistence** | SQLite (`backend/lumina.db`): jobs, results, feedback, preferences, corrections log, embedding cache. Sessions survive restarts. |
| **Concurrency** | Single-worker job queue — the shared model objects are not thread-safe, so analyses run one at a time; interrupted jobs are marked failed on restart. |
| **Incremental speed** | Per-image feature cache keyed by content SHA-256 (`cache_version` salt invalidates on pipeline changes). Warm re-runs skip all inference. |
| **Job hygiene** | Hourly TTL cleanup deletes job rows + input files older than `JOB_TTL_HOURS` (default 24) and prunes the cache. |
| **Auth** | Optional shared-secret: set `LUMINA_API_KEY` (backend) + `VITE_API_KEY` (frontend); photo serving stays open (unguessable job UUIDs). |
| **Tests** | `backend/tests/` — 110 pytest tests: pure-math units (fusion, MMR, IoU matching, explanations, preference learning, corrections, store, bento tiling and PDF rendering, the enhancement identity guard, the OpenRouter client) + API integration with a mocked pipeline and a mocked OpenRouter. |
| **CI** | GitHub Actions: backend unit tests + frontend typecheck/build on every push. |
| **Evaluation** | `backend/eval/` — scripts for identity-clustering ablations (ARI/NMI), event clustering, search Recall@K, preference convergence, and cache speedup. See `backend/eval/README.md`. |

### API Surface

| Endpoint | Purpose |
|----------|---------|
| `POST /api/analyze`, `GET /api/analyze/{id}` | Start / poll an analysis job |
| `GET /api/sessions`, `GET /api/sessions/{id}` | Persistent session history |
| `GET /api/photos/{jobId}/{photoId}` | Serve stored photos for reopened sessions |
| `POST /api/search/{jobId}` | CLIP text→image search |
| `POST /api/feedback` | Pairwise swap → preference update + pin |
| `GET/POST /api/preferences[...]` | Taste profile read / reset |
| `POST /api/rescore/{jobId}` | Re-rank with personal weights |
| `POST /api/corrections/{jobId}` | Cluster corrections (rename/merge/move/pin/delete) |
| `POST /api/export/{jobId}` | Zip download of a curated selection |
| `POST /api/enhance`, `GET /api/enhance/{id}` | Start / poll an AI enhancement |
| `GET/DELETE /api/enhanced/{jobId}/{photoId}` | Serve or discard an enhanced photo |
| `GET /api/collage/themes` | Available album themes + AI availability |
| `POST /api/collage/{jobId}` | Themed PDF album download |
| `POST /api/face-analysis` | Facial geometry deep-dive |

---

## Technical Stack

### Frontend

| Technology | Purpose |
|------------|---------|
| **React 19** with TypeScript | UI framework |
| **Vite 6** | Build tool & dev server (`npm run build` typechecks with tsc) |
| **Three.js** + **GSAP** | WebGL landing page |
| **Lucide React** | Icons |
| **Vanilla CSS** | Glass-morphism design system |

### Backend

| Technology | Purpose |
|------------|---------|
| **Python 3.11**, **FastAPI** + **Uvicorn** | Async REST API |
| **PyTorch** + **Transformers** | DINO + CLIP inference |
| **InsightFace / ultralytics / torchreid / pyiqa / MediaPipe** | Task models |
| **scikit-learn / hdbscan** | Clustering + silhouette analysis |
| **SQLite** (stdlib) | Persistence + embedding cache |
| **ReportLab + Pillow** | Themed PDF album rendering |
| **OpenRouter** | Image editing (enhance) + text (album titles) |
| **pytest** | Test suite |

---

## Getting Started

### Prerequisites

- **Node.js 18+**, **Python 3.11+**
- An [OpenRouter](https://openrouter.ai) API key *(optional — only the AI enhance
  button and AI album titles need it; everything else runs locally)*

### Local Development

```bash
# ── Frontend ──
cd frontend
npm install

# ── Backend ──
cd ../backend
python -m venv ../venv
../venv/Scripts/activate      # Windows
pip install -r requirements.txt

# ── Run both (Windows) ──
cd .. && ./start.ps1
# or manually:
#   backend:  cd backend && uvicorn server:app --reload    → http://127.0.0.1:8000
#   frontend: cd frontend && npm run dev                   → http://localhost:5173
```

### Tests & Evaluation

```bash
cd backend
../venv/Scripts/python.exe -m pytest tests -q          # full suite (110 tests)
../venv/Scripts/python.exe eval/eval_preferences.py    # synthetic preference convergence
# labeled-data evals: see backend/eval/README.md
```

### Environment Variables

`frontend/.env.local`:

```env
VITE_BACKEND_URL=http://127.0.0.1:8000
# VITE_API_KEY=shared-secret            # only if the backend sets LUMINA_API_KEY
```

`backend/.env`:

```env
FRONTEND_URL=http://localhost:5173

# OpenRouter — powers AI enhancement, album titles and photo captions.
# Without a key those features are disabled and everything else works unchanged.
OPENROUTER_API_KEY=sk-or-v1-...
OPENROUTER_BASE_URL=https://openrouter.ai/api/v1
OPENROUTER_TEXT_MODEL=openai/gpt-5.6-luna
OPENROUTER_IMAGE_MODEL=openai/gpt-5.4-image-2

# LUMINA_API_KEY=shared-secret          # enable API auth (recommended for public deploys)
# JOB_TTL_HOURS=24                      # session/photo retention
# MAX_PHOTOS=300                        # server-side per-job cap
```

> **Choosing the image model.** The edit model must *retouch* the photo, not
> regenerate it. Measured on the same input and prompt: `google/gemini-3.1-flash-image`
> preserved framing, aspect ratio and identity for ~$0.07/photo, while
> `openai/gpt-5.4-image-2` re-framed 16:9 → 1:1, re-posed the subjects and changed
> the background, for ~$0.23. Swap models via `OPENROUTER_IMAGE_MODEL`, but verify
> the output is an edit rather than a re-imagining.

---

## Deployment (Railway)

1. Connect the GitHub repository to [Railway](https://railway.app)
2. Create **two services** — one for `backend/`, one for `frontend/`
3. Set env vars (`FRONTEND_URL` and `OPENROUTER_API_KEY` on the backend; `VITE_BACKEND_URL` on the frontend; `LUMINA_API_KEY`/`VITE_API_KEY` pair recommended)
4. Push — Railway auto-detects each `Dockerfile`
5. Verify: `GET https://your-backend.railway.app/api/health` → `{"status": "ok"}`

> Note: SQLite persistence lives on the container filesystem — attach a Railway volume at `backend/` (or accept that sessions reset on redeploys).

---

## Research & Development Notebooks

> **Final pipeline notebook:** [`Lumina_fine_tuned_eventbased_aggloreid_weighted_final.ipynb`](backend/Lumina_fine_tuned_eventbased_aggloreid_weighted_final.ipynb)
>
> Covers the Semester-1 pipeline development: model choices, hyperparameter tuning, ablation experiments, and qualitative results. The Semester-2 (capstone) additions — embedding fusion, per-person selection, MMR, explanations, CLIP search/naming, preference learning, persistence, and the evaluation harness — live in `backend/` with tests in `backend/tests/` and evaluation scripts in `backend/eval/`.

---

## Credits

The 小黑 character is adapted from
[`ian-xiaohei-illustrations`](https://github.com/helloianneo/ian-xiaohei-illustrations)
by [Ian](https://github.com/helloianneo), used under the MIT licence. Lumina redraws the
character procedurally rather than generating it, but the character design, style rules
and the principle that 小黑 must perform the picture's core action rather than decorate
it are all his. Its `NOTICE.md` asks that adaptations carry attribution, and this is it.
