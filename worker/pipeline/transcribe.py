"""Word-level transcription via faster-whisper.

We deliberately do NOT use whisperx — its transitive deps (PyAV, etc.) are
a Windows install nightmare and it pins faster-whisper to an old version.
faster-whisper's `word_timestamps=True` gives us perfectly usable word
alignment for karaoke. Less precise than WhisperX's separate alignment
model pass, but the diff is sub-100ms and inaudible for sing-along use.
"""
from __future__ import annotations

import gc
import json
import logging
from pathlib import Path
from typing import Callable

import torch
from faster_whisper import WhisperModel

from ..settings import settings

log = logging.getLogger(__name__)

# Lazy global: the 3 GB large-v3 weights load once, then live across jobs.
_model: WhisperModel | None = None


class TranscribeError(RuntimeError):
    pass


def _resolve_device() -> tuple[str, str]:
    """Return (device, compute_type) honoring WORKER_DEVICE + auto-detect."""
    if settings.worker_device == "cpu":
        return "cpu", "int8"
    if settings.worker_device == "cuda":
        return "cuda", settings.worker_compute_type
    # auto
    if torch.cuda.is_available():
        return "cuda", settings.worker_compute_type
    return "cpu", "int8"


def _load_model() -> WhisperModel:
    global _model
    if _model is None:
        device, compute_type = _resolve_device()
        log.info("loading whisper %s on %s (%s)",
                 settings.whisper_model, device, compute_type)
        _model = WhisperModel(
            settings.whisper_model,
            device=device,
            compute_type=compute_type,
        )
    return _model


def transcribe(
    audio_path: Path,
    job_id: str,
    progress: Callable[[float], None],
) -> dict:
    """Run faster-whisper on `audio_path` (vocals included — we need them
    to transcribe) and return the same lyrics JSON shape the frontend
    LyricsCanvas expects:

        {
          "language": "en",
          "duration": 213.4,
          "segments": [
            {
              "start": 0.0,
              "end": 4.21,
              "text": "Coming out of my cage and I've been doing just fine",
              "words": [
                {"word": "Coming", "start": 0.10, "end": 0.43, "score": 0.94},
                ...
              ]
            },
            ...
          ]
        }
    """
    model = _load_model()
    progress(0.10)

    # Belt + suspenders for the empty-env-var → "" issue: faster_whisper's
    # Tokenizer rejects '' but accepts None (= auto-detect).
    lang = settings.whisper_language
    if lang is not None and not str(lang).strip():
        lang = None

    segments_iter, info = model.transcribe(
        str(audio_path),
        word_timestamps=True,
        language=lang,                       # None → auto-detect
        vad_filter=True,                     # skip non-vocal sections
        beam_size=5,
    )

    out_segments = []
    total_duration = float(info.duration or 0)
    # faster-whisper yields segments lazily; iterate and emit progress
    for seg in segments_iter:
        words = []
        for w in (seg.words or []):
            words.append({
                "word": (w.word or "").strip(),
                "start": round(float(w.start), 3),
                "end": round(float(w.end), 3),
                "score": round(float(w.probability or 0.0), 3),
            })
        out_segments.append({
            "start": round(float(seg.start), 3),
            "end": round(float(seg.end), 3),
            "text": (seg.text or "").strip(),
            "words": words,
        })
        if total_duration > 0:
            progress(min(0.95, 0.10 + 0.85 * (seg.end / total_duration)))

    final = {
        "language": info.language,
        "duration": total_duration,
        "segments": out_segments,
    }

    # Aggressive GC keeps VRAM headroom for the next Demucs run.
    gc.collect()
    if torch.cuda.is_available():
        torch.cuda.empty_cache()

    progress(1.0)
    return final


def write_lyrics_json(data: dict, out_path: Path) -> None:
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
