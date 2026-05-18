"""SQLite access for the worker.

The worker reads the SAME `karaoke.db` the Go server writes to. SQLite WAL
mode + 5-second busy timeout means concurrent reads/writes are safe; we
keep our touches minimal:
    - Claim a job (UPDATE ... WHERE status='queued' AND id=? returning).
    - Write progress / stage updates.
    - On success: insert songs / media rows, update job, update primary_media_id.
    - On failure: increment attempts, set status=failed or requeue.
"""
from __future__ import annotations

import sqlite3
import time
import uuid
from contextlib import contextmanager
from pathlib import Path
from typing import Iterator, Optional

from .settings import settings


def _conn() -> sqlite3.Connection:
    c = sqlite3.connect(
        str(settings.database_path),
        timeout=10.0,
        isolation_level=None,  # autocommit; we open transactions explicitly
    )
    c.row_factory = sqlite3.Row
    c.execute("PRAGMA journal_mode=WAL")
    c.execute("PRAGMA foreign_keys=ON")
    c.execute("PRAGMA busy_timeout=5000")
    return c


@contextmanager
def tx() -> Iterator[sqlite3.Connection]:
    """Atomic write transaction. Rolls back on exception."""
    c = _conn()
    try:
        c.execute("BEGIN IMMEDIATE")
        yield c
        c.execute("COMMIT")
    except Exception:
        c.execute("ROLLBACK")
        raise
    finally:
        c.close()


def claim_next_job() -> Optional[sqlite3.Row]:
    """Atomically grab the highest-priority queued job and mark it running.

    Returns the claimed job row, or None if the queue is empty.
    """
    with tx() as c:
        row = c.execute("""
            SELECT id, song_id, youtube_url, title_hint, artist_hint, year_hint,
                   priority, attempts, batch_id
            FROM jobs
            WHERE status = 'queued'
            ORDER BY priority DESC, created_at ASC
            LIMIT 1
        """).fetchone()
        if not row:
            return None
        now = _now()
        c.execute("""
            UPDATE jobs
            SET status = 'running', stage = 'download', progress = 0,
                started_at = ?, attempts = attempts + 1, error = NULL
            WHERE id = ? AND status = 'queued'
        """, (now, row["id"]))
        return row


def update_progress(job_id: str, stage: str, progress: float) -> None:
    c = _conn()
    try:
        c.execute(
            "UPDATE jobs SET stage=?, progress=? WHERE id=?",
            (stage, max(0.0, min(1.0, progress)), job_id),
        )
    finally:
        c.close()


def is_canceled(job_id: str) -> bool:
    c = _conn()
    try:
        row = c.execute("SELECT status FROM jobs WHERE id=?", (job_id,)).fetchone()
        return bool(row and row["status"] in ("canceled", "paused"))
    finally:
        c.close()


def finish_success(
    job_id: str,
    song_id: str,
    media_id: str,
) -> None:
    """Mark job done and point the song at this new media row as primary."""
    with tx() as c:
        now = _now()
        c.execute("""
            UPDATE jobs
            SET status='done', stage='done', progress=1.0,
                finished_at=?, error=NULL
            WHERE id=?
        """, (now, job_id))
        c.execute("""
            UPDATE songs
            SET primary_media_id=?, status='ready', updated_at=?
            WHERE id=?
        """, (media_id, now, song_id))
        # batch counters
        row = c.execute("SELECT batch_id FROM jobs WHERE id=?", (job_id,)).fetchone()
        if row and row["batch_id"]:
            _bump_batch(c, row["batch_id"], completed=1)


def finish_failure(job_id: str, error: str, fatal: bool) -> None:
    """If !fatal AND attempts < max → requeue with exponential backoff."""
    with tx() as c:
        now = _now()
        row = c.execute(
            "SELECT attempts, batch_id FROM jobs WHERE id=?",
            (job_id,),
        ).fetchone()
        if not row:
            return
        attempts = int(row["attempts"])
        if not fatal and attempts < settings.max_attempts:
            # naive backoff: just bump created_at so it comes back later
            c.execute("""
                UPDATE jobs
                SET status='queued', stage=NULL, progress=0,
                    error=?, started_at=NULL
                WHERE id=?
            """, (error[:1000], job_id))
        else:
            c.execute("""
                UPDATE jobs
                SET status='failed', finished_at=?, error=?
                WHERE id=?
            """, (now, error[:2000], job_id))
            if row["batch_id"]:
                _bump_batch(c, row["batch_id"], failed=1)


def upsert_song(
    artist: str,
    title: str,
    year: int | None,
    duration_sec: int,
    canonical_hash: str,
) -> str:
    """Insert song if missing; return song.id. Idempotent on canonical_hash."""
    with tx() as c:
        row = c.execute(
            "SELECT id FROM songs WHERE canonical_hash=?", (canonical_hash,)
        ).fetchone()
        if row:
            c.execute("""
                UPDATE songs
                SET duration_sec=COALESCE(NULLIF(duration_sec,0), ?),
                    year=COALESCE(year, ?), updated_at=?
                WHERE id=?
            """, (duration_sec, year, _now(), row["id"]))
            return row["id"]
        sid = uuid.uuid4().hex
        now = _now()
        c.execute("""
            INSERT INTO songs (id, title, artist, year, duration_sec,
                               canonical_hash, status, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)
        """, (sid, title, artist, year, duration_sec, canonical_hash, now, now))
        return sid


def insert_media(
    song_id: str,
    source_url: str,
    source_video_id: str,
    instrumental_path: str,
    lyrics_path: str,
    thumb_path: str | None,
    bytes_total: int,
) -> str:
    with tx() as c:
        mid = uuid.uuid4().hex
        c.execute("""
            INSERT INTO media (id, song_id, source_url, source_video_id,
                               instrumental_path, lyrics_path, thumb_path,
                               bytes, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (mid, song_id, source_url, source_video_id,
              instrumental_path, lyrics_path, thumb_path,
              bytes_total, _now()))
        return mid


def find_media_by_video_id(video_id: str) -> Optional[sqlite3.Row]:
    """Dedup short-circuit: if we already processed this YouTube ID, reuse it."""
    c = _conn()
    try:
        return c.execute(
            "SELECT id, song_id FROM media WHERE source_video_id=?",
            (video_id,),
        ).fetchone()
    finally:
        c.close()


def link_job_to_song(job_id: str, song_id: str) -> None:
    c = _conn()
    try:
        c.execute("UPDATE jobs SET song_id=? WHERE id=?", (song_id, job_id))
    finally:
        c.close()


def _bump_batch(c: sqlite3.Connection, batch_id: str, *,
                completed: int = 0, failed: int = 0) -> None:
    c.execute("""
        UPDATE import_batches
        SET completed = completed + ?, failed = failed + ?
        WHERE id = ?
    """, (completed, failed, batch_id))
    row = c.execute(
        "SELECT total, completed, failed FROM import_batches WHERE id=?",
        (batch_id,),
    ).fetchone()
    if row and (row["completed"] + row["failed"]) >= row["total"]:
        c.execute(
            "UPDATE import_batches SET finished_at=? WHERE id=? AND finished_at IS NULL",
            (_now(), batch_id),
        )


def _now() -> str:
    # SQLite TIMESTAMP — match the Go server's UTC ISO format
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
