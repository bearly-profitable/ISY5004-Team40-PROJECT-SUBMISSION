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

COPY requirements.txt .
RUN pip install -r requirements.txt

# MediaPipe face model (gitignored, so a git-based build doesn't have it).
RUN wget -q -O /app/face_landmarker.task \
    https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task

# Bake model weights into the image so boots don't download ~1 GB.
# Only the modules the pipeline imports, so code edits don't redo this layer.
COPY lumina_pipeline.py clip_search.py captioner.py blink.py curation.py openrouter.py yolov8n.pt prefetch_models.py ./
RUN python prefetch_models.py

COPY . .

RUN mkdir -p jobs

EXPOSE 8000

# exec so uvicorn gets SIGTERM directly and shuts down cleanly on redeploys.
CMD ["sh", "-c", "exec uvicorn server:app --host 0.0.0.0 --port ${PORT:-8000}"]
