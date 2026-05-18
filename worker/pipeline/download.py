"""yt-dlp wrapper with retry, rate-limit, and metadata extraction."""
from __future__ import annotations

import logging
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

import yt_dlp

from ..settings import settings

log = logging.getLogger(__name__)


@dataclass
class DownloadResult:
    audio_path: Path
    video_id: str
    title: str
    artist: str
    year: int | None
    duration_sec: int
    thumb_url: str | None


class DownloadError(RuntimeError):
    pass


def _guess_artist_title(info: dict) -> tuple[str, str]:
    """yt-dlp gives us several artist/title-ish fields. Try them in order.

    For official-channel uploads, `artist` and `track` are reliable.
    For UGC, fall back to splitting the video title on " - ".
    """
    artist = (info.get("artist") or info.get("creator") or info.get("uploader") or "").strip()
    title = (info.get("track") or "").strip()

    if not title:
        raw = (info.get("title") or "").strip()
        if " - " in raw:
            left, right = raw.split(" - ", 1)
            if not artist:
                artist = left.strip()
            title = right.strip()
        else:
            title = raw

    if not artist:
        artist = "Unknown Artist"
    if not title:
        title = "Unknown Title"
    return artist, title


def download(
    url: str,
    job_id: str,
    progress: Callable[[float], None],
) -> DownloadResult:
    """Download the best audio for `url` into the worker cache.

    Returns the local audio path plus parsed metadata. Raises DownloadError
    on terminal failure (yt-dlp's own retry exhausted).
    """
    out_dir = settings.cache_dir / "downloads" / job_id
    out_dir.mkdir(parents=True, exist_ok=True)

    def _hook(d: dict) -> None:
        if d.get("status") == "downloading":
            total = d.get("total_bytes") or d.get("total_bytes_estimate")
            done = d.get("downloaded_bytes") or 0
            if total:
                progress(min(0.99, done / total))

    ydl_opts: dict = {
        "format": settings.yt_dlp_format,
        "outtmpl": str(out_dir / "%(id)s.%(ext)s"),
        "quiet": True,
        "no_warnings": True,
        "noprogress": True,
        "retries": 5,
        "fragment_retries": 5,
        "progress_hooks": [_hook],
        "writethumbnail": True,
        "postprocessors": [{
            "key": "FFmpegExtractAudio",
            "preferredcodec": "wav",  # uncompressed → cleanest input to Demucs
        }],
    }
    if settings.yt_dlp_rate_limit:
        ydl_opts["ratelimit"] = _parse_rate(settings.yt_dlp_rate_limit)
    if settings.yt_dlp_cookies_file:
        ydl_opts["cookiefile"] = str(settings.yt_dlp_cookies_file)

    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(url, download=True)
    except yt_dlp.utils.DownloadError as e:
        raise DownloadError(str(e)) from e

    video_id = info["id"]
    audio_path = out_dir / f"{video_id}.wav"
    if not audio_path.exists():
        # FFmpegExtractAudio renames; find whichever .wav landed in out_dir
        wavs = list(out_dir.glob("*.wav"))
        if not wavs:
            raise DownloadError(f"audio not found after download: {out_dir}")
        audio_path = wavs[0]

    artist, title = _guess_artist_title(info)
    progress(1.0)
    return DownloadResult(
        audio_path=audio_path,
        video_id=video_id,
        title=title,
        artist=artist,
        year=info.get("release_year") or _year_from_date(info.get("upload_date")),
        duration_sec=int(info.get("duration") or 0),
        thumb_url=info.get("thumbnail"),
    )


def _year_from_date(s: str | None) -> int | None:
    if s and len(s) >= 4 and s[:4].isdigit():
        return int(s[:4])
    return None


def _parse_rate(s: str) -> int:
    """'2M' → 2_000_000 bytes/sec. yt-dlp expects an integer."""
    s = s.strip().upper()
    mult = 1
    if s.endswith("K"):
        mult, s = 1_000, s[:-1]
    elif s.endswith("M"):
        mult, s = 1_000_000, s[:-1]
    elif s.endswith("G"):
        mult, s = 1_000_000_000, s[:-1]
    return int(float(s) * mult)
