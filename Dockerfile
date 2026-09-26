# Single-service image: builds the React app, then runs the FastAPI backend,
# which serves the app and the API from one domain. (backend/ and frontend/
# keep their own Dockerfiles for a two-service deploy.)

# ---------- web app ----------
FROM node:20-alpine AS web

WORKDIR /web

COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci

COPY frontend/ ./

# Everything here is compiled into public JavaScript: only values that are
# safe for any visitor to read belong in this list (never a server secret).
# VITE_BACKEND_URL stays unset: the app calls the API on its own origin.
ARG VITE_API_KEY
ARG VITE_SUPABASE_URL
ARG VITE_SUPABASE_ANON_KEY
ENV VITE_API_KEY=$VITE_API_KEY \
    VITE_SUPABASE_URL=$VITE_SUPABASE_URL \
    VITE_SUPABASE_ANON_KEY=$VITE_SUPABASE_ANON_KEY

RUN npm run build

# ---------- server ----------
FROM python:3.11-slim

WORKDIR /app

ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

# System libraries required by OpenCV, InsightFace (needs cmake/gcc), MediaPipe, and OpenGL
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    cmake \
    libgl1 \
    libglib2.0-0 \
    libsm6 \
    libxext6 \
    libxrender1 \
    libgomp1 \
    git \
    wget \
    && rm -rf /var/lib/apt/lists/*

# CPU-only PyTorch: the default Linux wheels bundle CUDA (several GB) that a
# CPU container never uses. Installed first so requirements.txt reuses it.
RUN pip install --upgrade pip && \
    pip install torch torchvision --index-url https://download.pytorch.org/whl/cpu

COPY backend/requirements.txt .
RUN pip install -r requirements.txt

# MediaPipe face model (gitignored, so a git-based build doesn't have it).
RUN wget -q -O /app/face_landmarker.task \
    https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task

# Bake model weights into the image so boots don't download ~1 GB.
# Only the modules the pipeline imports, so code edits don't redo this layer.
COPY backend/lumina_pipeline.py backend/clip_search.py backend/captioner.py backend/blink.py \
     backend/curation.py backend/openrouter.py backend/yolov8n.pt backend/prefetch_models.py ./
RUN python prefetch_models.py

COPY backend/ ./
COPY --from=web /web/dist ./static

RUN mkdir -p jobs

EXPOSE 8000

# exec so uvicorn gets SIGTERM directly and shuts down cleanly on redeploys.
CMD ["sh", "-c", "exec uvicorn server:app --host 0.0.0.0 --port ${PORT:-8000}"]
