"""Worker configuration.

Auto-discovers the project root (directory containing `.env`) and resolves
relative paths against it, so the worker hits the SAME karaoke.db and
media/ directory as the Go server no matter which directory either process
is launched from.

All env vars documented in /.env.example.
"""
from __future__ import annotations

from pathlib import Path
from typing import Literal

from pydantic_settings import BaseSettings, SettingsConfigDict


def find_project_root() -> Path:
    """Walk upward from cwd until we find .env or pyproject.toml-with-worker-sibling.

    Falls back to cwd if neither marker is found.
    """
    cwd = Path.cwd().resolve()
    for d in [cwd] + list(cwd.parents):
        if (d / ".env").exists():
            return d
        # pyproject.toml at this level + a sibling-or-self worker/ dir is a
        # strong signal we're inside the djclaude repo.
        if (d / "go.mod").exists() and (d.parent / "worker").exists():
            return d.parent
        if (d / "go.mod").exists() and (d / "worker").exists():
            return d
    return cwd


PROJECT_ROOT = find_project_root()


def _under_root(rel: str) -> Path:
    p = Path(rel)
    return p if p.is_absolute() else (PROJECT_ROOT / p).resolve()


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=str(PROJECT_ROOT / ".env"),
        env_file_encoding="utf-8",
        extra="ignore",
        env_prefix="",
    )

    # --- service ---
    worker_addr: str = "0.0.0.0"
    worker_port: int = 8090
    worker_token: str = "change-me-shared-secret"
    api_base_url: str = "http://localhost:8080"

    # --- storage. Defaults are root-relative; absolute overrides win.
    # We use str + a validator-style normaliser in __init__ rather than
    # Path defaults so we can rewrite relative paths against PROJECT_ROOT.
    database_path: Path = PROJECT_ROOT / "karaoke.db"
    media_dir: Path = PROJECT_ROOT / "media"
    cache_dir: Path = PROJECT_ROOT / "worker-cache"

    # --- GPU/compute ---
    worker_device: Literal["auto", "cuda", "cpu"] = "auto"
    worker_concurrency: int = 1
    worker_compute_type: Literal["float16", "int8_float16", "int8"] = "float16"

    # --- model selection ---
    demucs_model: str = "htdemucs_ft"
    whisper_model: str = "large-v3"
    whisper_language: str | None = None

    # --- yt-dlp ---
    yt_dlp_format: str = "bestaudio/best"
    yt_dlp_rate_limit: str | None = None
    yt_dlp_cookies_file: Path | None = None

    # --- pacing ---
    poll_interval_sec: float = 2.0
    max_attempts: int = 3
    backoff_base_sec: float = 30.0

    def model_post_init(self, __context) -> None:
        # Re-anchor any path the user supplied via env in case they passed a
        # relative one ("./karaoke.db"). Absolute paths are untouched.
        if not self.database_path.is_absolute():
            self.database_path = _under_root(str(self.database_path))
        if not self.media_dir.is_absolute():
            self.media_dir = _under_root(str(self.media_dir))
        if not self.cache_dir.is_absolute():
            self.cache_dir = _under_root(str(self.cache_dir))
        # CRITICAL: pydantic-settings parses an env var of "" (empty string)
        # as the literal "" / Path("") instead of None. Downstream libs reject
        # empties (faster_whisper rejects '' as a language code; yt-dlp tries
        # to open '.' as a cookies file). Normalize any blank Optional fields.
        if self.yt_dlp_cookies_file and str(self.yt_dlp_cookies_file).strip() in ("", "."):
            self.yt_dlp_cookies_file = None
        if self.whisper_language is not None and not str(self.whisper_language).strip():
            self.whisper_language = None
        if self.yt_dlp_rate_limit is not None and not str(self.yt_dlp_rate_limit).strip():
            self.yt_dlp_rate_limit = None


settings = Settings()
