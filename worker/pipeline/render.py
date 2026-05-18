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
    """
    bg_path = settings.cache_dir / "bg" / f"{job_id}.jpg"
    _build_background(thumb_url, artist, title, bg_path)
    progress(0.30)

    out_path.parent.mkdir(parents=True, exist_ok=True)
    # Video is a single static frame; lyrics render client-side as a canvas
    # overlay. So we starve the video track of bitrate and use one keyframe
    # + a very long GOP so every subsequent frame is a near-empty p-frame.
    # On a 3-minute song this brings video from ~7 MB → ~300 KB. Audio
    # dominates total file size (~3 MB at 128 kbps Opus, ~2 MB at 96 kbps).
    cmd = [
        "ffmpeg", "-y",
        "-loop", "1", "-framerate", "1", "-i", str(bg_path),
        "-i", str(instrumental_path),
        "-c:v", "libvpx-vp9",
        "-b:v", "40k",             # static image — barely needs anything
        "-minrate", "20k",
        "-maxrate", "80k",
        "-r", "1",                 # 1 fps; browsers handle this fine
        "-g", "9999",              # single keyframe, rest are tiny p-frames
        "-pix_fmt", "yuv420p",
        "-deadline", "good",
        "-cpu-used", "4",
        "-c:a", "libopus",
        "-b:a", "96k",             # good music quality, smaller than 128k
        "-vbr", "on",
        "-application", "audio",
        "-shortest",
        "-movflags", "+faststart",
        str(out_path),
    ]
    log.info("ffmpeg: %s", " ".join(cmd))
    try:
        subprocess.run(cmd, check=True, capture_output=True, text=True)
    except subprocess.CalledProcessError as e:
        raise RenderError(f"ffmpeg failed: {e.stderr[-2000:]}") from e

    # Drop the bg jpeg; we won't need it again.
    bg_path.unlink(missing_ok=True)
    progress(1.0)


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
