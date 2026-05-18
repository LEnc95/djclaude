"""Worker configuration. All env vars documented in /.env.example."""
from __future__ import annotations

from pathlib import Path
from typing import Literal

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
        env_prefix="",
    )

    # --- service ---
    worker_addr: str = "0.0.0.0"
    worker_port: int = 8090
    worker_token: str = "change-me-shared-secret"
    api_base_url: str = "http://localhost:8080"

    # --- storage (must match the Go server's MEDIA_DIR + DATABASE_PATH) ---
    database_path: Path = Path("./karaoke.db")
    media_dir: Path = Path("./media")
    cache_dir: Path = Path("./worker-cache")  # yt-dlp downloads, demucs temp

    # --- GPU/compute ---
    worker_device: Literal["auto", "cuda", "cpu"] = "auto"
    worker_concurrency: int = 1  # raise only if you have multiple GPUs
    worker_compute_type: Literal["float16", "int8_float16", "int8"] = "float16"

    # --- model selection ---
    demucs_model: str = "htdemucs_ft"
    whisper_model: str = "large-v3"
    whisper_language: str | None = None  # None = auto-detect

    # --- yt-dlp behaviour ---
    yt_dlp_format: str = "bestaudio/best"
    yt_dlp_rate_limit: str | None = None  # e.g. "2M"; None = unlimited
    yt_dlp_cookies_file: Path | None = None

    # --- pacing ---
    poll_interval_sec: float = 2.0
    max_attempts: int = 3
    backoff_base_sec: float = 30.0  # exponential: 30, 60, 120


settings = Settings()
