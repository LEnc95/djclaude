"""Karaoke processing pipeline.

Stages:
    1. download   — yt-dlp grabs best audio (and metadata)
    2. separate   — Demucs strips vocals, leaving instrumental
    3. transcribe — WhisperX produces word-level timestamps
    4. render     — ffmpeg combines instrumental + still-image background → .webm

Each stage takes a `Job` and a `progress(stage, fraction)` callback.
"""
