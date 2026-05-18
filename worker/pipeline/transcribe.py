"""WhisperX word-level transcription + alignment."""
from __future__ import annotations

import gc
import json
import logging
from pathlib import Path
from typing import Callable

import torch

from ..settings import settings

log = logging.getLogger(__name__)

# Lazy globals: models load on first use, then live across jobs to avoid
# re-loading the 3 GB large-v3 weights every song.
_whisper = None
_align_models: dict[str, tuple[object, dict]] = {}


class TranscribeError(RuntimeError):
    pass


def _resolve_device() -> str:
    if settings.worker_device == "auto":
        return "cuda" if torch.cuda.is_available() else "cpu"
    return settings.worker_device


def _load_whisper(device: str):
    global _whisper
    if _whisper is None:
        import whisperx
        log.info("loading whisper %s on %s (%s)", settings.whisper_model, device,
                 settings.worker_compute_type)
        _whisper = whisperx.load_model(
            settings.whisper_model,
            device,
            compute_type=settings.worker_compute_type,
        )
    return _whisper


def _load_aligner(lang: str, device: str):
    if lang not in _align_models:
        import whisperx
        log.info("loading aligner for %s on %s", lang, device)
        model_a, metadata = whisperx.load_align_model(language_code=lang, device=device)
        _align_models[lang] = (model_a, metadata)
    return _align_models[lang]


def transcribe(
    audio_path: Path,
    job_id: str,
    progress: Callable[[float], None],
) -> dict:
    """Run WhisperX on `audio_path` (the ORIGINAL, vocals-in audio — Whisper
    needs the vocals to transcribe them) and return a lyrics JSON structure:

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

    This file is what the frontend's LyricsCanvas reads to highlight words
    against the playing instrumental.
    """
    import whisperx

    device = _resolve_device()
    progress(0.05)

    audio = whisperx.load_audio(str(audio_path))
    whisper = _load_whisper(device)

    progress(0.10)
    result = whisper.transcribe(
        audio,
        batch_size=16,
        language=settings.whisper_language,
    )
    detected_lang = result["language"]
    progress(0.55)

    try:
        model_a, metadata = _load_aligner(detected_lang, device)
        aligned = whisperx.align(
            result["segments"],
            model_a,
            metadata,
            audio,
            device,
            return_char_alignments=False,
        )
        segments = aligned["segments"]
    except Exception as e:
        # Alignment is best-effort. If no aligner exists for the detected
        # language we still ship Whisper's coarser segment timestamps.
        log.warning("alignment failed (%s); falling back to segment-level timestamps", e)
        segments = result["segments"]

    progress(0.95)
    duration = float(segments[-1].get("end", 0)) if segments else 0.0

    out = {
        "language": detected_lang,
        "duration": duration,
        "segments": [_clean_segment(s) for s in segments],
    }

    # WhisperX leaks VRAM if you load multiple aligners. Aggressive GC here
    # keeps headroom for Demucs on the next job.
    gc.collect()
    if device == "cuda":
        torch.cuda.empty_cache()

    progress(1.0)
    return out


def _clean_segment(s: dict) -> dict:
    words = []
    for w in s.get("words", []) or []:
        # alignment sometimes drops start/end on unaligned words — skip those
        if "start" not in w or "end" not in w:
            continue
        words.append({
            "word": w.get("word", "").strip(),
            "start": round(float(w["start"]), 3),
            "end": round(float(w["end"]), 3),
            "score": round(float(w.get("score", 0.0)), 3),
        })
    return {
        "start": round(float(s.get("start", 0.0)), 3),
        "end": round(float(s.get("end", 0.0)), 3),
        "text": s.get("text", "").strip(),
        "words": words,
    }


def write_lyrics_json(data: dict, out_path: Path) -> None:
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
