# Single-service image: builds the React app, then runs the FastAPI backend,
# which serves the app and the API from one domain. (backend/ and frontend/
# keep their own Dockerfiles for a two-service deploy.)

# ---------- web app ----------
FROM node:22-alpine AS web

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

# ---------- python packages ----------
# Compilers live only in this stage (insightface and hdbscan build from
# source), so they don't count toward the final image size.
FROM python:3.11-slim AS deps

RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    cmake \
    wget \
    && rm -rf /var/lib/apt/lists/*

ENV PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PATH=/opt/venv/bin:$PATH
RUN python -m venv /opt/venv

# CPU-only PyTorch: the default Linux wheels bundle CUDA (several GB) that a
# CPU container never uses. Installed first so requirements.txt reuses it.
RUN pip install --upgrade pip && \
    pip install torch torchvision --index-url https://download.pytorch.org/whl/cpu

COPY backend/requirements.txt .
RUN pip install -r requirements.txt

# MediaPipe face model (gitignored, so a git-based build doesn't have it).
RUN wget -q -O /face_landmarker.task \
    https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task

# ---------- server ----------
FROM python:3.11-slim

WORKDIR /app

# Runtime libraries for OpenCV and MediaPipe.
RUN apt-get update && apt-get install -y --no-install-recommends \
    libgl1 \
    libglib2.0-0 \
    libsm6 \
    libxext6 \
    libxrender1 \
    libgomp1 \
    libstdc++6 \
    && rm -rf /var/lib/apt/lists/*

ENV PYTHONUNBUFFERED=1 \
    PATH=/opt/venv/bin:$PATH \
    YOLO_CONFIG_DIR=/tmp/Ultralytics

COPY --from=deps /opt/venv /opt/venv
COPY --from=deps /face_landmarker.task ./face_landmarker.task

# Model weights (~2.5 GB) are NOT baked in: with them the image passes
# Railway's image size limit. The server downloads them on boot (about a
# minute) before /api/health turns green.
COPY backend/ ./
COPY --from=web /web/dist ./static

RUN mkdir -p jobs

EXPOSE 8000

# exec so uvicorn gets SIGTERM directly and shuts down cleanly on redeploys.
CMD ["sh", "-c", "exec uvicorn server:app --host 0.0.0.0 --port ${PORT:-8000}"]
