# Karaoke Forever Pro — Architecture

A reference document for contributors. The README covers usage; this covers
**why** the code looks the way it does.

## Goals

1. **Run anywhere.** Single-binary Go server + SQLite (no DB to manage) +
   stateless Python worker that polls. No message broker, no Redis.
2. **Local-first processing.** Heavy AI runs on your local box (GPU); only
   the small processed files sync to a cheap VPS.
3. **Three playback surfaces, one renderer.** Host, guest phones, and TV/cast
   mode all mount the same `<KaraokePlayer>`; the only difference is whether
   audio is muted and whether the UI shows controls.
4. **Backward-compatible additive build** on the existing DJClaude code —
   events, requests, host-token auth, the queue/fairness rules all keep
   working; the new library/jobs/admin layer is bolted on alongside.

## Data flow — request to playback

```
Guest submits song
      │
      ▼
 createRequest()
      │  parse URL → youtube_video_id
      │  call resolver:
      │    1. video_id → media row?  yes → set song_id
      │    2. canonical_hash(artist, title)?
      │    3. fuzzy LIKE search
      │  if none → song_id stays NULL (fallback)
      │
      │  optionally enqueue Job (admin setting: auto_enqueue_on_fallback)
      ▼
 INSERT into requests; broadcast request:created over WS
      │
      ▼
 Host promotes request → status = "singing"
      │
      ▼
 Host browser:
      • song_id set?  → fetch /api/library/songs/:id, load .webm into <video>
      • else          → render <YouTubeFallbackPlayer videoID=... mode=host>
      • plays unmuted (audio to bar speakers via laptop output)
      • emits playback:state every 500 ms over the WS
      │
      ▼
 Server stamps server_ts (ms since epoch), fans out
      │
      ▼
 Every other client on /ws/:code receives playback:state
      • Guest phone (/r/:code): nudges its muted <video> to match host clock;
        renders synced lyrics on top
      • Screen mode (/screen/:code): same, but unmuted (HDMI to speakers
        if used as the bar's primary output instead of the laptop)
      • Admin pages: ignore playback:state
```

## Sync algorithm details

The follower clock reconciliation lives in
[`usePlaybackSync`](frontend/src/hooks/usePlaybackSync.ts):

```
For each playback:state received:
    wallDrift   = max(0, (Date.now() - server_ts) / 1000)
    target      = current_time + (paused ? 0 : wallDrift)
    drift       = local.currentTime - target

    if |drift| > 1.2 s:   hard seek (currentTime = target)
    elif |drift| > 0.4 s: nudge playback rate ±5% for 600 ms
    if remote.paused and !local.paused: pause
    if !remote.paused and local.paused: play()
```

Rate-nudging avoids audible seek pops for small drifts. Hard seeks happen
on network hiccups, page-load, or song changes. The tolerances are tuned for
the "phones are muted; they're for lyrics" use case — humans don't notice
±400 ms when they can't hear the audio.

## Schema (additive on the v1 events/requests tables)

| Table | Purpose | Lifecycle |
|---|---|---|
| `events`, `requests` | unchanged from DJClaude v1 (requests gained nullable `song_id` FK) | per karaoke night |
| `songs` | canonical library entry: title + artist + hash; one row per song-as-cultural-object | permanent |
| `media` | one row per processed artifact (instrumental .webm + lyrics .json + thumb) | permanent; many per song |
| `jobs` | processing queue rows; worker polls `status='queued'` ordered by priority | ephemeral; deleted/cleaned manually |
| `import_batches` | groups jobs from a single bulk import (artist/year/csv) for progress tracking | ephemeral |
| `app_settings` | k/v store for VPS deploy creds, lyrics style JSON, admin session token | mutable |
| `admin_users` | bcrypt password hash, must_change_password flag | 1 row typically |

Foreign keys: `media.song_id → songs.id ON DELETE CASCADE`,
`songs.primary_media_id → media.id` (nullable; set after first successful
processing), `requests.song_id → songs.id ON DELETE SET NULL`.

The `songs.canonical_hash` (sha1 of `slug(artist)|slug(title)`) is the dedup
floor across submissions, importers, and the YouTube ID fast-path
(`media.source_video_id UNIQUE`). The slug function is mirrored verbatim
between Go (`api/resolver.go: Slug`) and Python (`worker/pipeline/hash.py:
slug`) — any divergence breaks dedup.

## Worker lifecycle

`worker/runner.py` is the single point of pipeline orchestration:

```
claim_next_job()  → UPDATE jobs SET status='running' RETURNING ... atomically
    │
    ▼
 download.download(url)
    │  yt-dlp grabs best audio, parses title/artist/year
    │  dedup short-circuit: if media.source_video_id exists, jump to link+done
    │
    ▼
 upsert_song(artist, title, year, ..., canonical_hash)
    │  insert songs row OR find existing by hash; returns song.id
    │  link job → song
    │
    ▼
 separate.separate(audio)
    │  Demucs htdemucs_ft, --two-stems vocals; keeps only no_vocals.wav
    │
    ▼
 transcribe.transcribe(audio_with_vocals)
    │  WhisperX large-v3 → segments + alignment → words with timestamps
    │
    ▼
 render.render_webm(instrumental, thumb, artist, title)
    │  ffmpeg loops a JPEG background + Opus audio; static-image single
    │  keyframe + GOP 9999 → ~300 KB of video data per song
    │
    ▼
 insert_media(...); finish_success(); POST /api/jobs/:id/callback
```

Errors get classified:
- yt-dlp fatal (`video unavailable`, `copyright`, `private`) → `status=failed` immediately
- everything else → retry with backoff up to `max_attempts` (default 3)
- cancellation: between every stage and inside progress callbacks the runner
  checks `is_canceled(job_id)`; if so, raises `_Canceled` which the outer
  except drops cleanly without marking failure

## Why these specific choices

| Decision | Choice | Why |
|---|---|---|
| Worker comms | Direct SQLite + HTTP kick | One DB = one source of truth; no broker to install/operate |
| GPU | Demucs htdemucs_ft + WhisperX large-v3 | Best free quality; both fit on 12 GB VRAM serially |
| Output format | .webm (VP9 still + Opus) | Single file ships everywhere; no two-stream sync; tiny |
| Sync model | Local files + clock broadcast | No streaming infra. Phones own their bytes after first range request. |
| Bulk importers | MusicBrainz + Wikipedia + optional Spotify | Two of three free, no API keys. Spotify opt-in. |
| YouTube fallback | iframe embed when `song_id IS NULL` | Plays SOMETHING immediately; optional auto-enqueue for next time |
| Admin auth | bcrypt + single shared session token in `app_settings` | Self-hosted single-operator; no need for a sessions table |
| Lyrics styling | JSON blob in `app_settings.player.lyrics_style` | Frontend owns the shape; backend never validates the contents |
| VPS deploy | rsync media + sqlite `.backup`-then-copy | No replication infra. Run as often as you process new songs. |

## Things explicitly NOT in scope

- Real-time collaborative editing of lyrics (you can re-process a song
  manually via admin if the alignment is bad).
- Multi-tenant SaaS support (one admin user; per-event scoping for guests).
- Playlist-style automation (the human host still decides who sings next).
- A native desktop app (browser fullscreen is the cast surface).

## Where to extend

- **Add an importer:** implement `importers.Source` in
  `backend/internal/importers/`. Three methods, no other plumbing.
- **Add a player theme:** drop a new preset into
  `frontend/src/lyrics/presets.ts`. The editor picks it up automatically.
- **Swap separation model:** change `DEMUCS_MODEL` env, or replace
  `worker/pipeline/separate.py` with a different tool — anything that
  outputs a stem file works.
- **Add a notification target:** the `import_batches` and `jobs` tables
  expose `finished_at` and counters; add a `notify.go` that watches for
  newly-finished batches and posts to email/Slack/whatever.
