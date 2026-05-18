"""Demucs vocal separation → instrumental audio."""
from __future__ import annotations

import logging
import shutil
import subprocess
from pathlib import Path
from typing import Callable

from ..settings import settings

log = logging.getLogger(__name__)


class SeparationError(RuntimeError):
    pass


def separate(
    audio_path: Path,
    job_id: str,
    progress: Callable[[float], None],
) -> Path:
    """Run Demucs (`settings.demucs_model`) on `audio_path` and return the
    no_vocals.wav path.

    Demucs writes into:
        out_dir / {model_name} / {input_basename} / no_vocals.wav
    plus vocals.wav, drums.wav, bass.wav, other.wav (4-stem). We keep only
    no_vocals.wav and delete the rest to save disk.
    """
    out_dir = settings.cache_dir / "demucs" / job_id
    out_dir.mkdir(parents=True, exist_ok=True)

    cmd = [
        "python", "-m", "demucs.separate",
        "-n", settings.demucs_model,
        "--two-stems", "vocals",   # only need vocals vs no_vocals; saves time + RAM
        "-o", str(out_dir),
        "--filename", "{track}/{stem}.{ext}",
        str(audio_path),
    ]
    if settings.worker_device == "cpu":
        cmd.extend(["-d", "cpu"])
    elif settings.worker_device == "cuda":
        cmd.extend(["-d", "cuda"])
    # 'auto' lets Demucs pick.

    progress(0.05)
    log.info("demucs: %s", " ".join(cmd))
    try:
        # Demucs prints progress to stderr; we don't parse it, just stream.
        proc = subprocess.run(cmd, check=True, capture_output=True, text=True)
        log.debug(proc.stdout)
    except subprocess.CalledProcessError as e:
        raise SeparationError(f"demucs failed: {e.stderr}") from e

    track_name = audio_path.stem
    candidates = list((out_dir / settings.demucs_model / track_name).glob("no_vocals.*"))
    if not candidates:
        raise SeparationError(f"demucs produced no no_vocals output in {out_dir}")
    instrumental = candidates[0]

    # Trim the cache: we keep instrumental only.
    for f in instrumental.parent.iterdir():
        if f != instrumental:
            f.unlink(missing_ok=True)

    progress(1.0)
    return instrumental


def have_demucs() -> bool:
    return shutil.which("python") is not None  # demucs is a python module; presence checked at runtime
