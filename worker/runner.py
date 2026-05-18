"""Job runner: claims one job, drives it through the pipeline, writes results.

This is the single point that:
    - Calls each pipeline stage
    - Computes the canonical hash and dedups via media.source_video_id
    - Decides what's a fatal vs retriable error
    - Writes the final song + media rows
    - Notifies the Go server (best-effort HTTP POST to /api/jobs/:id/callback)
"""
from __future__ import annotations

import logging
import shutil
import traceback
from pathlib import Path

import httpx

from . import db
from .pipeline import download, hash as hashing, render, separate, transcribe
from .settings import settings

log = logging.getLogger(__name__)

# Some yt-dlp errors are forever-fatal (video gone, region-blocked); others
# are flaky (rate limit, network). Crude substring check beats parsing.
_FATAL_YT_PATTERNS = (
    "video unavailable",
    "removed by the user",
    "private video",
    "blocked it in your country",
    "copyright",
)


def run_one_job() -> bool:
    """Pull and process one job. Returns True if work was done."""
    row = db.claim_next_job()
    if not row:
        return False

    job_id = row["id"]
    url = row["youtube_url"]
    log.info("starting job %s url=%s", job_id, url)

    def _p(stage: str, fraction: float) -> None:
        if db.is_canceled(job_id):
            raise _Canceled()
        db.update_progress(job_id, stage, fraction)

    try:
        # ----- 1. download (and short-circuit dedup) -----
        _p("download", 0.0)
        dl = download.download(url, job_id, progress=lambda f: _p("download", f))

        existing = db.find_media_by_video_id(dl.video_id)
        if existing:
            # Same YouTube ID already processed — link job to that song, done.
            log.info("dedup hit: video_id=%s already in library", dl.video_id)
            db.link_job_to_song(job_id, existing["song_id"])
            db.finish_success(job_id, existing["song_id"], existing["id"])
            _cleanup_cache(job_id)
            _notify_api(job_id, "done")
            return True

        canon = hashing.canonical_hash(dl.artist, dl.title)
        song_id = db.upsert_song(
            artist=dl.artist,
            title=dl.title,
            year=dl.year,
            duration_sec=dl.duration_sec,
            canonical_hash=canon,
        )
        db.link_job_to_song(job_id, song_id)

        # ----- 2. separate -----
        _p("separate", 0.0)
        instrumental = separate.separate(dl.audio_path, job_id,
                                         progress=lambda f: _p("separate", f))

        # ----- 3. transcribe (on the ORIGINAL audio — needs vocals) -----
        _p("transcribe", 0.0)
        lyrics = transcribe.transcribe(dl.audio_path, job_id,
                                       progress=lambda f: _p("transcribe", f))

        # ----- 4. render -----
        _p("render", 0.0)
        media_id_hex = _short_id()
        webm_rel = Path("instr") / f"{media_id_hex}.webm"
        lyrics_rel = Path("lyrics") / f"{media_id_hex}.json"
        thumb_rel = Path("thumbs") / f"{media_id_hex}.jpg"
        webm_abs = settings.media_dir / webm_rel
        lyrics_abs = settings.media_dir / lyrics_rel
        thumb_abs = settings.media_dir / thumb_rel

        render.render_webm(
            instrumental, dl.thumb_url, dl.artist, dl.title,
            webm_abs, job_id,
            progress=lambda f: _p("render", f),
        )
        transcribe.write_lyrics_json(lyrics, lyrics_abs)
        render.save_thumbnail(dl.thumb_url, thumb_abs)

        media_id = db.insert_media(
            song_id=song_id,
            source_url=url,
            source_video_id=dl.video_id,
            instrumental_path=str(webm_rel).replace("\\", "/"),
            lyrics_path=str(lyrics_rel).replace("\\", "/"),
            thumb_path=str(thumb_rel).replace("\\", "/") if thumb_abs.exists() else None,
            bytes_total=webm_abs.stat().st_size,
        )
        db.finish_success(job_id, song_id, media_id)
        log.info("job %s done: %s — %s", job_id, dl.artist, dl.title)

    except _Canceled:
        log.info("job %s canceled", job_id)
    except download.DownloadError as e:
        msg = str(e)
        fatal = any(p in msg.lower() for p in _FATAL_YT_PATTERNS)
        db.finish_failure(job_id, f"download: {msg}", fatal=fatal)
        log.warning("job %s download failed (fatal=%s): %s", job_id, fatal, msg)
    except (separate.SeparationError, transcribe.TranscribeError, render.RenderError) as e:
        db.finish_failure(job_id, f"{type(e).__name__}: {e}", fatal=False)
        log.exception("job %s pipeline error", job_id)
    except Exception as e:  # last-resort safety net
        db.finish_failure(job_id, f"unexpected: {e}\n{traceback.format_exc()[-1500:]}", fatal=False)
        log.exception("job %s unexpected error", job_id)
    finally:
        _cleanup_cache(job_id)
        _notify_api(job_id, None)

    return True


class _Canceled(Exception):
    """Raised inside progress callbacks when the job was canceled in the DB."""


def _short_id() -> str:
    import secrets
    return secrets.token_hex(8)


def _cleanup_cache(job_id: str) -> None:
    for sub in ("downloads", "demucs"):
        p = settings.cache_dir / sub / job_id
        if p.exists():
            shutil.rmtree(p, ignore_errors=True)


def _notify_api(job_id: str, status_hint: str | None) -> None:
    """Best-effort ping. The Go server can also poll, so failure here is fine."""
    try:
        httpx.post(
            f"{settings.api_base_url}/api/jobs/{job_id}/callback",
            headers={"X-Worker-Token": settings.worker_token},
            json={"hint": status_hint},
            timeout=3.0,
        )
    except Exception as e:
        log.debug("api callback failed (non-fatal): %s", e)
