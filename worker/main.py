"""FastAPI service: health + dev-only enqueue helpers.

Authoritative job CRUD lives on the Go API server. This service runs the
processing loop and exposes a tiny HTTP surface so the Go server (and you,
when debugging) can probe its state.
"""
from __future__ import annotations

# IMPORTANT: must be set BEFORE torch/ctranslate2/onnxruntime get imported.
# On Windows we hit "OMP Error #15: libiomp5md.dll already initialized" because
# torch's bundled MKL and faster-whisper's ctranslate2 both ship their own
# OpenMP runtime. This env var tells Intel's OMP to allow the duplicate
# instead of aborting the process.
import os
os.environ.setdefault("KMP_DUPLICATE_LIB_OK", "TRUE")

import asyncio
import logging
import sys
from contextlib import asynccontextmanager
from pathlib import Path

import torch
from fastapi import FastAPI, Header, HTTPException

from . import db, runner
from .settings import settings

# Two log handlers: stdout (for `start.bat`'s visible cmd window) AND a
# rolling file in cache_dir/worker.log so logs survive even when the
# parent terminal exits. The latter matters on Windows where any
# PowerShell Start-Process with redirected stdout will silently kill its
# child the moment the parent session moves on.
_log_dir = Path(os.environ.get("WORKER_LOG_DIR") or os.environ.get("MEDIA_DIR") or ".").resolve()
try:
    _log_path = _log_dir / "worker.log"
    _log_path.parent.mkdir(parents=True, exist_ok=True)
except Exception:
    _log_path = Path("worker.log")

logging.basicConfig(
    level=os.getenv("LOG_LEVEL", "INFO"),
    format="%(asctime)s %(levelname)s %(name)s — %(message)s",
    handlers=[
        logging.StreamHandler(sys.stdout),
        logging.FileHandler(_log_path, encoding="utf-8"),
    ],
)
log = logging.getLogger("worker")
log.info("worker log file: %s", _log_path)


# ---- background loop ----
_stop = asyncio.Event()


async def _loop():
    log.info("worker loop started; device=%s concurrency=%d",
             settings.worker_device, settings.worker_concurrency)

    sem = asyncio.Semaphore(settings.worker_concurrency)

    async def _one_iter():
        async with sem:
            # runner is sync (torch + ffmpeg). Run in default thread pool so
            # we don't block the event loop or other concurrent jobs.
            did_work = await asyncio.to_thread(runner.run_one_job)
            if not did_work:
                await asyncio.sleep(settings.poll_interval_sec)

    while not _stop.is_set():
        try:
            await _one_iter()
        except Exception:
            log.exception("loop iteration crashed")
            await asyncio.sleep(2.0)


@asynccontextmanager
async def lifespan(_app: FastAPI):
    settings.media_dir.mkdir(parents=True, exist_ok=True)
    settings.cache_dir.mkdir(parents=True, exist_ok=True)
    # Pin process cwd to the cache dir so any child process (ffmpeg via
    # yt-dlp's postprocessor, demucs subprocess) that uses cwd-relative
    # paths writes somewhere writable. The Permission-denied-on-`.`
    # issue on Windows comes from ffmpeg inheriting whatever cwd the
    # worker was spawned with — which on PowerShell Start-Process can be
    # surprising.
    import os
    os.chdir(settings.cache_dir)
    log.info("worker cwd pinned to %s", settings.cache_dir)
    task = asyncio.create_task(_loop())
    try:
        yield
    finally:
        _stop.set()
        task.cancel()


app = FastAPI(title="djclaude-worker", lifespan=lifespan)


# ---- routes ----
def _require_worker_token(x_worker_token: str | None) -> None:
    if x_worker_token != settings.worker_token:
        raise HTTPException(status_code=401, detail="bad worker token")


@app.get("/health")
def health():
    return {
        "ok": True,
        "device": _device_info(),
        "models": {
            "demucs": settings.demucs_model,
            "whisper": settings.whisper_model,
        },
        "concurrency": settings.worker_concurrency,
    }


@app.post("/internal/kick")
def kick(x_worker_token: str | None = Header(default=None)):
    """The Go server can call this when a new job is enqueued to skip the
    poll-interval wait. Non-essential — the loop picks it up anyway."""
    _require_worker_token(x_worker_token)
    return {"ok": True}


def _device_info() -> dict:
    if torch.cuda.is_available():
        return {
            "type": "cuda",
            "name": torch.cuda.get_device_name(0),
            "vram_gb": round(torch.cuda.get_device_properties(0).total_memory / 1e9, 1),
        }
    return {"type": "cpu"}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(
        "worker.main:app",
        host=settings.worker_addr,
        port=settings.worker_port,
        reload=False,
    )
