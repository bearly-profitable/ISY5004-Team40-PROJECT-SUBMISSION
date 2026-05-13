# Lumina: AI-Powered Photo Curation & Management Platform

> **In this repo, we have:** 1 full report PDF, 1 full presentation video MP4, 1 research and tuning Python notebook, and 1 full codebase (frontend + backend) for our webapp.

A photo management system that clusters, scores, and curates photo collections using computer vision and ML. Upload a batch of photos, get back the best shot of each person at each event.

## Project Explanation & Demo

Watch our platform in action: [Full Recorded Presentation Link](https://youtu.be/63fbOCV3cN4)

Visit our website to test it yourself: [Live Link](https://lumina-production-639d.up.railway.app/)

## System Architecture

![Lumina System Architecture](frontend/public/Lumina-architecture.png)

**Layer descriptions:**

| Layer | What happens |
|-------|--------------|
| **Client & Deployment** | User uploads photos (Google Drive OAuth or local drag-and-drop) via the React SPA. The FastAPI backend receives them and spawns a background thread job. Docker containers are served on Railway behind nginx. |
| **Feature Extraction** | Three streams run in parallel on every image: ArcFace produces 512-D face identity vectors + quality signals; YOLOv8 detects full-body bounding boxes for occluded-face cases; DINOv2 encodes the scene context. Body crops are then fed through OSNet for 512-D re-ID embeddings used as a face fallback. |
| **Identity Clustering** | HDBSCAN groups people across photos using face embeddings (primary) with body embeddings as fallback. No manual epsilon — density-adaptive with noise reassignment. |
| **Event Clustering** | Agglomerative clustering on DINOv2 scene vectors with an automatically-swept distance threshold (silhouette score optimisation) groups photos into meaningful moments/scenes. |
| **Multi-Signal Scoring** | Seven quality signals are combined into a weighted composite score (min-max normalised per event group). The highest-scoring photo per Event × Identity pair is selected as the "best" shot. |
| **Smart Gallery** | Results are rendered in an interactive gallery — browsable by event and by person, with full score breakdowns and an optional facial geometry deep-dive (MediaPipe FaceMesh). |

---

## Core Components

### 1. Photo Ingestion

The application supports two photo import methods:

- **Google Drive integration** — authenticate via OAuth and select a Drive folder; photos are streamed directly without ever being stored on our servers
- **Local upload** — drag-and-drop or file-picker upload of images from your device

A maximum of **80 photos** per analysis run keeps processing focused and fast.

---

### 2. AI Analysis Pipeline (6-Stage Processing)

#### Stage 1: Parallel Feature Extraction

Three independent streams run simultaneously on every image:

| Stream | Model | Output |
|--------|-------|--------|
| **Face Detection & Embedding** | InsightFace / ArcFace (buffalo_l) | 512-d identity vectors + quality signals (sharpness, pose angles, detection confidence) |
| **Person Detection** | YOLOv8 Nano | Full-body bounding boxes + crops |
| **Scene Embedding** | DINOv2 (ViT-S/14) | Scene-level context vectors for event grouping |

All images are resized to a maximum of 1280 px before processing.

#### Stage 2: Body Re-Identification

Detected person crops are passed through **OSNet** (torchreid) to produce 512-d body embeddings. These serve as a robust fallback for identity matching when faces are occluded or partially visible.

#### Stage 3: Identity Clustering

Face embeddings (primary) and body embeddings (fallback) are clustered with **HDBSCAN**:

- No manual epsilon parameter required — handles variable-density clusters automatically
- Noise points are reassigned to the nearest cluster centroid
- Cosine distance threshold: **0.6** (face) · **0.75** (body fallback)

Each cluster corresponds to one unique individual across the entire photo collection.

#### Stage 4: Event Clustering

DINOv2 scene embeddings are grouped via **Agglomerative Clustering** (average linkage, cosine distance). The optimal cluster threshold is selected automatically by sweeping over a silhouette score across the range 0.1–3.0.

#### Stage 5: Multi-Signal Scoring

Every photo receives a composite quality score from seven weighted signals, **min-max normalised within each event group** for fair comparison:

| Signal | Weight | Description |
|--------|--------|-------------|
| **Centrality** | 0.25 | Cosine similarity to the event's DINOv2 centroid — how representative the shot is |
| **NIMA Score** | 0.25 | Neural Image Assessment aesthetic quality (0–10, via pyiqa) |
| **Face Sharpness** | 0.15 | Laplacian variance of isolated face region |
| **Face Size** | 0.10 | Face bounding box area relative to full image |
| **Detection Confidence** | 0.10 | InsightFace raw detection score |
| **Pose Quality** | 0.10 | Penalty for yaw / pitch / roll deviation from frontal |
| **Eye Aspect Ratio** | 0.05 | Open-eye detection to prevent blink selections |

The **top-ranked photo per event × identity combination** is surfaced as the "best" shot.

#### Stage 6: Facial Geometry Analysis (Bonus Feature)

An optional deep-dive face analysis uses **MediaPipe FaceMesh** (468 landmarks) to score:
- Symmetry & golden-ratio proportions
- Skin quality
- Eye, nose, lip, and jawline metrics

---

### 3. Smart Gallery & Results

After processing, the results are presented in a full-featured gallery interface:

- **Event view** — photos grouped into auto-detected events with the top-ranked shot highlighted
- **Identity view** — face-thumbnail clusters linking an individual across all events
- **Score breakdown** — per-image signal contributions visible on hover
- **Real-time progress** — live step-by-step status during analysis (Loading models → Feature extraction → Clustering → Scoring → Complete)

---

## Machine Learning Architecture

### Models & Algorithms

| Model / Algorithm | Role | Key Detail |
|-------------------|------|------------|
| **InsightFace** (ArcFace, buffalo_l) | Face detection + identity embedding | 512-d cosine-comparable vectors; extracts sharpness, pose, and confidence |
| **YOLOv8 Nano** | Person detection | Body bounding boxes for occluded-face fallback |
| **OSNet** (torchreid) | Body re-identification | 512-d body embeddings on 256×128 crops |
| **DINOv2** (ViT-S/14) | Scene understanding | Self-supervised ViT; captures background, lighting, and spatial layout |
| **HDBSCAN** | Identity clustering | Density-adaptive, noise-robust, no manual epsilon |
| **Agglomerative Clustering** | Event clustering | Average linkage + silhouette sweep (0.1–3.0) for automatic threshold |
| **NIMA** (pyiqa) | Aesthetic scoring | Neural Image Assessment; composition, colour harmony, exposure (0–10) |
| **MediaPipe FaceMesh** | Facial geometry | 468 landmarks; symmetry, proportions, skin quality |

### Composite Score Formula

```
Score(i) = Σ wₖ × normalised_signal_k(i)

All signals are min-max normalised within each event group before weighting.
```

---

## Technical Stack

### Frontend

| Technology | Purpose |
|------------|---------|
| **React 19** with TypeScript | UI framework |
| **Vite 6** | Build tool & dev server |
| **Three.js** + **GSAP** | WebGL landing page with glass-refraction shader transitions |
| **Lucide React** | Icon library |
| **Vanilla CSS** | Custom glass-morphism design system |

### Backend

| Technology | Purpose |
|------------|---------|
| **Python 3.11** | Runtime |
| **FastAPI** + **Uvicorn** | Async REST API |
| **PyTorch** + **Transformers** | Deep learning inference |
| **InsightFace** | ArcFace face embedding |
| **ultralytics** (YOLOv8) | Person detection |
| **torchreid** (OSNet) | Body re-identification |
| **pyiqa** (NIMA) | Aesthetic quality scoring |
| **MediaPipe** | FaceMesh landmark detection |
| **scikit-learn** | HDBSCAN, AgglomerativeClustering, silhouette analysis |
| **OpenCV** + **NumPy** | Image processing |

### Infrastructure

| Component | Detail |
|-----------|--------|
| **Frontend container** | Node 20 build → nginx:alpine (port 8080) |
| **Backend container** | python:3.11-slim (port 8000) |
| **Deployment** | Railway (automatic Docker detection) |
| **Job system** | Per-request UUID jobs — threaded background processing with live progress callbacks |

---

## Data Pipeline Architecture

```
Input Photos (≤ 80 images, resized to max 1280 px)
    │
    ├──[PARALLEL]──────────────────────────────────────────┐
    │                                                      │
    ▼                     ▼                                ▼
Face Detection       Person Detection            Scene Embedding
(InsightFace/ArcFace) (YOLOv8 Nano)            (DINOv2 ViT-S/14)
512-d face embeds     bounding boxes            scene-level vectors
+ quality signals     + crops                   (normalized)
    │                     │
    ▼                     ▼
    └──── Body Re-ID (OSNet) ──┘
          512-d body embeddings
                │
                ▼
        Identity Clustering (HDBSCAN)
        face embeds (primary) + body embeds (fallback)
                │
    ┌───────────┴───────────┐
    ▼                       ▼
Event Clustering        Aesthetic Scoring
(Agglomerative +        (NIMA)
 Silhouette sweep)      0–10 quality score
    │                       │
    └───────────┬───────────┘
                ▼
    Multi-Signal Scoring (7 signals, weighted sum)
                ▼
    Best Image Selection (top-1 per event × identity)
                ▼
    Smart Gallery — Events · Identities · Score Breakdown
```

---

## Research & Development Notebooks

The `backend/` directory contains Jupyter notebooks documenting the full ML research and development process — from baseline experiments through to the final tuned pipeline.

> **Final pipeline notebook:** [`Lumina_fine_tuned_eventbased_aggloreid_weighted_final.ipynb`](backend/Lumina_fine_tuned_eventbased_aggloreid_weighted_final.ipynb)
>
> This notebook covers the complete end-to-end pipeline with fine-tuned event-based clustering, agglomerative re-ID, and weighted multi-signal scoring. Refer to it for a detailed walkthrough of model choices, hyperparameter tuning, ablation experiments, and qualitative results.

---

## Getting Started

### Prerequisites

- **Node.js 18+**
- **Python 3.11+**
- Google OAuth credentials (Client ID + API Key) for Drive integration *(optional — local upload works without it)*

### Local Development

```bash
# Clone the repository
git clone <repository>
cd lumina

# ── Frontend setup ──
cd frontend
npm install

# ── Backend setup ──
cd ../backend
python -m venv ../venv
../venv/Scripts/activate      # Windows
pip install -r requirements.txt

# ── Run both servers ──
# Option A: one-command launcher (Windows)
cd ..
./start.ps1

# Option B: manual
# Terminal 1 — Backend
cd backend && uvicorn server:app --reload   # http://127.0.0.1:8000

# Terminal 2 — Frontend
cd frontend && npm run dev                 # http://localhost:5173
```

### Environment Variables

Create `frontend/.env.local`:

```env
VITE_BACKEND_URL=http://127.0.0.1:8000
VITE_GOOGLE_CLIENT_ID=your_google_client_id
VITE_GOOGLE_API_KEY=your_google_api_key
```

Create `backend/.env`:

```env
FRONTEND_URL=http://localhost:5173
```

---

## Deployment (Railway)

1. Connect your GitHub repository to [Railway](https://railway.app)
2. Create **two services** — one pointing to `backend/`, one to `frontend/`
3. Set environment variables in the Railway dashboard:

**Backend service:**
```
FRONTEND_URL=https://your-frontend.railway.app
```

**Frontend service:**
```
VITE_BACKEND_URL=https://your-backend.railway.app
VITE_GOOGLE_CLIENT_ID=your_google_client_id
VITE_GOOGLE_API_KEY=your_google_api_key
```

4. Push code to GitHub — Railway automatically detects each `Dockerfile` and deploys
5. Verify deployment: `GET https://your-backend.railway.app/api/health` → `{"status": "ok"}`

**Configuration files:**
- `backend/Dockerfile` — Python 3.11-slim with OpenCV, InsightFace, MediaPipe, and PyTorch dependencies
- `frontend/Dockerfile` — Multi-stage Node 20 build → nginx:alpine static hosting
- `*/railway.toml` — Railway-specific service configuration


