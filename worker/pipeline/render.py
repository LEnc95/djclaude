"""Render instrumental audio + background image + BURNED-IN karaoke lyrics
into a standalone .webm playable in any browser or media player.

Lyrics are still kept as a separate JSON file so the live web player can
do its own canvas-based word-highlighting overlay (and users can restyle
without re-rendering). But the video file itself also has lyrics baked in
via ASS subtitle karaoke timing tags — so when you download the .webm
and play it locally, you see a real karaoke video.
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
    lyrics: dict | None = None,
) -> None:
    """Mux instrumental audio + still-image background + burned-in karaoke
    lyrics → .mp4 (H.264 high + AAC).

    Codec choice: H.264/AAC in an MP4 container. We previously used
    VP9/Opus in WebM but Chrome's hardware decoder rejected it with
    MEDIA_ERR_DECODE — libvpx-vp9 with our still-image inputs produces
    streams Chrome's vp9 decoder won't touch even though ffmpeg and
    standalone players are fine with them. H.264 + yuv420p is the most
    universally decodable combination.

    Other knobs:
      - 24 fps, GOP every 48 frames (~2 s keyframes) — normal.
      - Explicit -t duration (NOT -shortest) so the container records
        duration metadata; browsers won't .play() if duration=N/A.
      - +faststart so the moov atom is at the head of the file (seekable
        before fully downloaded).
      - ASS karaoke subtitles burned in, so a downloaded .mp4 is a real
        standalone karaoke video — lyrics highlight word-by-word.
    """
    bg_path = settings.cache_dir / "bg" / f"{job_id}.jpg"
    _build_background(thumb_url, artist, title, bg_path)
    progress(0.10)

    duration = _probe_duration(instrumental_path)
    progress(0.15)

    # Build ASS subtitles from the lyrics JSON, if we have them.
    ass_path: Path | None = None
    if lyrics:
        from .subtitles import write_ass
        ass_path = write_ass(lyrics, settings.cache_dir / "subs" / f"{job_id}.ass")
        log.info("wrote ASS subtitles: %s", ass_path)
        progress(0.20)

    out_path.parent.mkdir(parents=True, exist_ok=True)

    # ffmpeg filter graph: scale background to 1080p, then burn subtitles
    # on top. The subtitles filter expects forward slashes + Windows drive
    # escape (e.g. C\:/path/file.ass), even on Windows — that's an ffmpeg
    # quirk, not a typo.
    vf_parts = ["scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080"]
    if ass_path:
        ass_for_ffmpeg = str(ass_path).replace("\\", "/").replace(":", "\\:", 1)
        vf_parts.append(f"subtitles='{ass_for_ffmpeg}'")

    cmd = [
        "ffmpeg", "-y",
        "-loop", "1", "-framerate", "24", "-i", str(bg_path),
        "-i", str(instrumental_path),
        "-map", "0:v:0", "-map", "1:a:0",
        "-t", f"{duration:.3f}",
        "-vf", ",".join(vf_parts),
        # H.264 + yuv420p decodes EVERYWHERE, unlike libvpx-vp9 which
        # Chrome's hardware decoder rejected on our still-image streams.
        "-c:v", "libx264",
        "-profile:v", "high",
        "-pix_fmt", "yuv420p",
        "-preset", "fast",
        "-crf", "23",
        "-r", "24",
        "-g", "48",
        "-c:a", "aac",
        "-b:a", "128k",
        "-movflags", "+faststart",
        str(out_path),
    ]
    log.info("ffmpeg: %s", " ".join(cmd))
    try:
        subprocess.run(cmd, check=True, capture_output=True, text=True)
    except subprocess.CalledProcessError as e:
        raise RenderError(f"ffmpeg failed: {e.stderr[-2000:]}") from e

    bg_path.unlink(missing_ok=True)
    if ass_path and ass_path.exists():
        ass_path.unlink(missing_ok=True)
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
