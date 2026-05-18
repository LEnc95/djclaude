# CUDA 12.1 + cuDNN 8 runtime. Matches the torch==2.3.1+cu121 wheels pinned
# in pyproject.toml. ~3 GB image; the model weights add another ~4 GB at runtime.
FROM nvidia/cuda:12.1.1-cudnn8-runtime-ubuntu22.04

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    HF_HOME=/cache/huggingface

# Python 3.11 (whisperx + demucs both support it; 3.12 still has torch issues)
RUN apt-get update && apt-get install -y --no-install-recommends \
        python3.11 python3.11-venv python3-pip \
        ffmpeg git ca-certificates curl \
    && ln -sf /usr/bin/python3.11 /usr/local/bin/python \
    && ln -sf /usr/bin/python3.11 /usr/local/bin/python3 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install deps first for layer caching
COPY worker/pyproject.toml /app/worker/pyproject.toml
RUN python -m pip install --upgrade pip \
    && python -m pip install --extra-index-url https://download.pytorch.org/whl/cu121 \
       -e /app/worker

COPY worker/ /app/worker/

# /cache holds HF model downloads (~4 GB). Mount this as a volume so weights
# survive container rebuilds.
VOLUME ["/cache", "/app/media", "/app/karaoke.db"]

EXPOSE 8090
CMD ["python", "-m", "worker.main"]
