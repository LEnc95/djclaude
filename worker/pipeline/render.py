"""Render instrumental audio + static background image → .webm playable in browser.

We deliberately do NOT burn lyrics into the video. The frontend's
LyricsCanvas overlays them against the lyrics JSON timestamps, so users can
restyle (font, color, highlight) without re-rendering, and word-by-word
highlighting works in real time.
"""
from __future__ import annotations

import logging
import subprocess
from pathlib import Path
from typing import Callable

import httpx
from PIL import Image, ImageDraw, ImageFilter

from ..settings import settings

log = logging.getLogger(__name__)


class RenderError(RuntimeError):
    pass


def _build_background(
    thumb_url: str | None,
    artist: str,
    title: str,
    out_path: Path,
) -> None:
    """Generate a 1920x1080 background:
    - If thumb_url loads: blurred upscaled thumbnail
    - Otherwise: dark indigo gradient
    Title/artist text is rendered top-left in both cases.
    """
    W, H = 1920, 1080
    img = None
    if thumb_url:
        try:
            r = httpx.get(thumb_url, timeout=10.0)
            if r.status_code == 200:
                from io import BytesIO
                src = Image.open(BytesIO(r.content)).convert("RGB")
                src = src.resize((W, H), Image.LANCZOS)
                src = src.filter(ImageFilter.GaussianBlur(radius=40))
                # darken so lyrics are readable
                overlay = Image.new("RGB", (W, H), (10, 10, 20))
                img = Image.blend(src, overlay, 0.55)
        except Exception as e:
            log.warning("thumb fetch failed (%s); using gradient", e)

    if img is None:
        img = Image.new("RGB", (W, H), (15, 15, 30))
        draw = ImageDraw.Draw(img)
        for y in range(H):
            shade = int(15 + (y / H) * 25)
            draw.line([(0, y), (W, y)], fill=(shade, shade, shade + 10))

    out_path.parent.mkdir(parents=True, exist_ok=True)
    img.save(out_path, "JPEG", quality=88)


def render_webm(
    instrumental_path: Path,
    thumb_url: str | None,
    artist: str,
    title: str,
    out_path: Path,
    job_id: str,
    progress: Callable[[float], None],
) -> None:
    """Mux instrumental audio over a still-image video → .webm (VP9 + Opus).

    Single-frame still video + audio is ~3 MB per song at this bitrate.

    IMPORTANT: we probe the audio duration first and pass `-t` to ffmpeg
    instead of using `-shortest`. With `-loop 1 -shortest`, ffmpeg's WebM
    muxer leaves duration=N/A in the container, and browsers refuse to
    .play() such files (they think the media has 0 length, so the play
    button toggles right back to pause). With explicit `-t`, the duration
    lands in the container header and playback works everywhere.
    """
    bg_path = settings.cache_dir / "bg" / f"{job_id}.jpg"
    _build_background(thumb_url, artist, title, bg_path)
    progress(0.20)

    duration = _probe_duration(instrumental_path)
    progress(0.30)

    out_path.parent.mkdir(parents=True, exist_ok=True)
    cmd = [
        "ffmpeg", "-y",
        "-loop", "1", "-framerate", "1", "-i", str(bg_path),
        "-i", str(instrumental_path),
        "-t", f"{duration:.3f}",   # explicit duration → muxer writes it
        "-c:v", "libvpx-vp9",
        "-b:v", "40k",
        "-minrate", "20k",
        "-maxrate", "80k",
        "-r", "1",
        "-g", "9999",
        "-pix_fmt", "yuv420p",
        "-deadline", "good",
        "-cpu-used", "4",
        "-c:a", "libopus",
        "-b:a", "96k",
        "-vbr", "on",
        "-application", "audio",
        str(out_path),
    ]
    log.info("ffmpeg: %s", " ".join(cmd))
    try:
        subprocess.run(cmd, check=True, capture_output=True, text=True)
    except subprocess.CalledProcessError as e:
        raise RenderError(f"ffmpeg failed: {e.stderr[-2000:]}") from e

    bg_path.unlink(missing_ok=True)
    progress(1.0)


def _probe_duration(audio_path: Path) -> float:
    """Return the audio file's duration in seconds. Falls back to a long
    sentinel (10 hours) if probe fails — better an over-long file than
    one with no duration."""
    try:
        out = subprocess.run(
            ["ffprobe", "-v", "error",
             "-show_entries", "format=duration",
             "-of", "default=noprint_wrappers=1:nokey=1",
             str(audio_path)],
            check=True, capture_output=True, text=True,
        )
        return float(out.stdout.strip())
    except Exception as e:
        log.warning("ffprobe duration failed (%s); falling back to 10h", e)
        return 36000.0


def save_thumbnail(thumb_url: str | None, out_path: Path) -> None:
    """Save a small thumbnail (320x180) alongside the media for UI listings."""
    if not thumb_url:
        return
    try:
        r = httpx.get(thumb_url, timeout=10.0)
        if r.status_code != 200:
            return
        from io import BytesIO
        src = Image.open(BytesIO(r.content)).convert("RGB")
        src.thumbnail((320, 320), Image.LANCZOS)
        out_path.parent.mkdir(parents=True, exist_ok=True)
        src.save(out_path, "JPEG", quality=85)
    except Exception as e:
        log.warning("thumb save failed: %s", e)
