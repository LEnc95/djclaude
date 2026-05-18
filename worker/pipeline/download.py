"""yt-dlp wrapper with retry, rate-limit, multi-candidate fallback, and
metadata extraction."""
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


# Some yt-dlp errors are forever-fatal for a specific video. The runner's
# higher-level error classifier uses _FATAL_YT_PATTERNS too; this list is
# just for the per-candidate skip decision inside download().
_PER_CANDIDATE_SKIP = (
    "video unavailable",
    "removed by the user",
    "private video",
    "blocked it in your country",
    "members-only",
    "sign in to confirm",
    "age",
)


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

    If `url` is a `ytsearchN:` search expression, we fetch the top N
    candidates and try them in order until one downloads cleanly — handy
    when the first hit is region-blocked, age-gated, or removed. Direct
    `https://www.youtube.com/watch?v=...` URLs skip the fallback loop and
    download the single target.

    Raises DownloadError if every candidate fails.
    """
    out_dir = settings.cache_dir / "downloads" / job_id
    out_dir.mkdir(parents=True, exist_ok=True)

    candidates = _resolve_candidates(url)
    if not candidates:
        raise DownloadError(f"no candidates resolved from URL: {url}")

    last_err: Exception | None = None
    for i, cand_url in enumerate(candidates, start=1):
        try:
            log.info("download attempt %d/%d for job %s: %s",
                     i, len(candidates), job_id, cand_url)
            return _download_one(cand_url, out_dir, progress)
        except yt_dlp.utils.DownloadError as e:
            msg = str(e)
            last_err = e
            skip = any(p in msg.lower() for p in _PER_CANDIDATE_SKIP)
            log.warning("candidate %d/%d failed%s: %s",
                        i, len(candidates),
                        " (skip-and-try-next)" if skip else "",
                        msg.split('\n')[0][:200])
            log.exception("candidate %d/%d full traceback:", i, len(candidates))
            continue
        except Exception as e:
            last_err = e
            log.exception("candidate %d/%d unexpected error full traceback:", i, len(candidates))
            continue

    raise DownloadError(
        f"all {len(candidates)} candidate(s) failed for {url}; last error: {last_err}"
    )


def _resolve_candidates(url: str, fanout: int = 5) -> list[str]:
    """Turn a single submitted URL into one or more watchable URLs.

    - `ytsearch1:foo` -> expand to up to N watch URLs (top N results)
    - `ytsearchN:foo` -> use N as the fanout
    - direct watch URL -> single-element list (no fallback)
    """
    if url.startswith("ytsearch") and ":" in url:
        prefix, query = url.split(":", 1)
        # prefix is like "ytsearch", "ytsearch1", "ytsearch5"; expand to fanout
        search_url = f"ytsearch{fanout}:{query}"
        with yt_dlp.YoutubeDL({
            "quiet": True,
            "no_warnings": True,
            "extract_flat": True,    # don't fetch full info per result — fast
            "noplaylist": False,
        }) as ydl:
            try:
                info = ydl.extract_info(search_url, download=False)
            except Exception as e:
                log.warning("search resolution failed for %s: %s", search_url, e)
                return []
        entries = info.get("entries") or []
        urls = []
        for e in entries:
            if not e:
                continue
            u = e.get("url") or e.get("webpage_url") or e.get("original_url")
            if not u:
                vid = e.get("id")
                if vid:
                    u = f"https://www.youtube.com/watch?v={vid}"
            if u:
                urls.append(u)
        return urls
    # Direct URL
    return [url]


def _download_one(
    url: str,
    out_dir: Path,
    progress: Callable[[float], None],
) -> DownloadResult:
    """Single yt-dlp invocation. Raises yt_dlp.utils.DownloadError on
    failure; caller decides whether to skip to the next candidate.

    Defensive: chdir into out_dir for the duration of the call. ffmpeg's
    postprocessor (FFmpegExtractAudio) shells out and uses cwd for its
    own temp files; if the worker's process cwd is somewhere unwritable
    we get a confusing '[Errno 13] Permission denied: .' that no amount
    of yt-dlp `paths` config can fix. Pinning cwd to a per-job writable
    dir makes both yt-dlp AND ffmpeg behave.
    """
    import os
    prev_cwd = os.getcwd()
    try:
        os.chdir(out_dir)
        return _download_one_inner(url, out_dir, progress)
    finally:
        try:
            os.chdir(prev_cwd)
        except OSError:
            pass


def _download_one_inner(
    url: str,
    out_dir: Path,
    progress: Callable[[float], None],
) -> DownloadResult:
    def _hook(d: dict) -> None:
        if d.get("status") == "downloading":
            total = d.get("total_bytes") or d.get("total_bytes_estimate")
            done = d.get("downloaded_bytes") or 0
            if total:
                progress(min(0.99, done / total))

    ydl_opts: dict = {
        "format": settings.yt_dlp_format,
        # outtmpl is just the filename; the actual directory comes from `paths`.
        "outtmpl": "%(id)s.%(ext)s",
        # paths.home + paths.temp override ALL output directories (final,
        # temp, thumbnail, info-json). Without this, writethumbnail and the
        # postprocessor fall through to cwd → "[Errno 13] Permission
        # denied: '.'" when the worker's cwd isn't writable.
        "paths": {"home": str(out_dir), "temp": str(out_dir)},
        "quiet": True,
        "no_warnings": True,
        "noprogress": True,
        "retries": 3,
        "fragment_retries": 3,
        "progress_hooks": [_hook],
        "writethumbnail": True,
        "postprocessors": [{
            "key": "FFmpegExtractAudio",
            "preferredcodec": "wav",
        }],
    }
    if settings.yt_dlp_rate_limit:
        ydl_opts["ratelimit"] = _parse_rate(settings.yt_dlp_rate_limit)
    # Belt + suspenders against the "empty env → Path(.) → cookiefile=." bug:
    # only set cookiefile if the path is real and points at an existing file.
    cookies = settings.yt_dlp_cookies_file
    if cookies and str(cookies).strip() not in ("", ".") and Path(str(cookies)).is_file():
        ydl_opts["cookiefile"] = str(cookies)

    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        info = ydl.extract_info(url, download=True)

    video_id = info["id"]
    audio_path = out_dir / f"{video_id}.wav"
    if not audio_path.exists():
        wavs = list(out_dir.glob(f"{video_id}*.wav")) or list(out_dir.glob("*.wav"))
        if not wavs:
            raise yt_dlp.utils.DownloadError(f"audio not found after download in {out_dir}")
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
