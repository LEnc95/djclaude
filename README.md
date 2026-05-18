# Karaoke Forever Pro (DJClaude)

A self-hostable karaoke system that takes guest YouTube requests, automatically
downloads them, strips the vocals, transcribes lyrics with word-level
timestamps, and plays the result on the host's laptop, every guest's phone
(muted, with synced lyrics), and optionally a TV/projector — all in sync.

Built on the existing DJClaude request app, with the
[karaoke-forever](https://github.com/gazugafan/karaoke-forever) pipeline ideas
ported in.

## What this does

- **Guest** scans a QR, picks a song. If the song is already in the local
  library it plays the clean instrumental immediately. If not, the host can
  fall back to a YouTube embed and (optionally) auto-queue it for processing.
- **Host** runs `/host/:code` on a laptop hooked up to bar speakers. Big
  player up top, queue management below. Their browser is the master clock.
- **Guests' phones** display the same player on `/r/:code` but muted, with
  word-by-word synced lyrics. Lets shy singers read along privately.
- **Screen mode** at `/screen/:code` is the same player with no UI — point
  this at a TV or projector via HDMI / cast.
- **Admin** at `/admin` (default `admin`/`admin`, forced change on first
  login): queue control, bulk import from artist / Billboard year / Spotify,
  lyrics styling, VPS deploy settings.

## Architecture

```
                          ┌───────────────────┐
                          │  SQLite (WAL)     │
                          │  karaoke.db       │
                          └──────┬────────────┘
                  reads/writes   │   reads/writes
              ┌──────────────────┴──────────────────┐
              ▼                                     ▼
   ┌───────────────────┐                  ┌──────────────────────┐
   │ Go API server     │  HTTP /kick      │ Python worker        │
   │ (stdlib net/http) │ ─────────────►   │ FastAPI + asyncio    │
   │ :8080             │                  │ :8090                │
   │  + REST           │  POST callback   │  yt-dlp              │
   │  + WebSocket      │ ◄──────────────  │  Demucs (CUDA)       │
   │  + /media/*       │                  │  WhisperX (CUDA)     │
   └───────┬───────────┘                  │  ffmpeg              │
           │                              └────┬─────────────────┘
           │ static files                      │ writes
           │                                   ▼
           │                          ┌──────────────────┐
           │                          │ media/           │
           │                          │   instr/*.webm   │
           ▼                          │   lyrics/*.json  │
   ┌────────────────┐                 │   thumbs/*.jpg   │
   │ Preact SPA     │                 └──────────────────┘
   │  /admin        │  ←─ byte-range fetches /media/* over HTTP
   │  /host/:code   │
   │  /r/:code      │  ←─ each guest phone loads the SAME .webm muted
   │  /screen/:code │     and reconciles to the host clock (~2 Hz)
   └────────────────┘
```

See [ARCHITECTURE.md](ARCHITECTURE.md) for the full data model + decision log.

## Quick start (local dev, with GPU)

You need:

- Go 1.22+ ([install](https://go.dev/dl/))
- Node 18+ ([install](https://nodejs.org/))
- Python 3.10 or 3.11 (3.12 still has torch+demucs issues)
- ffmpeg on PATH
- NVIDIA GPU + CUDA 12.x for the worker (CPU works but ~10× slower)

Three terminals:

```sh
# 1. Go API
cd backend
go run ./cmd/server
# → listens on :8080, creates karaoke.db, serves /media/* + frontend

# 2. Preact frontend (HMR)
cd frontend
npm install
npm run dev
# → http://localhost:5173, proxies /api + /ws + /media to :8080

# 3. Python worker
cd worker
python -m venv .venv && source .venv/bin/activate   # or .venv\Scripts\activate on Windows
pip install -e . --extra-index-url https://download.pytorch.org/whl/cu121
python -m worker.main
# → listens on :8090; polls karaoke.db for jobs
```

First boot creates a default admin (`admin` / `admin`). Open
`http://localhost:5173/admin` and you'll be forced to change the password.

The first job takes ~5 min while WhisperX and Demucs download their model
weights (~4 GB total). Subsequent jobs reuse the cached weights.

## Quick start (Docker, local with GPU)

```sh
cp .env.example .env
# edit WORKER_TOKEN at minimum; everything else has sane defaults

docker compose up --build
# → API on :8080, worker on :8090, GPU passthrough via nvidia-container-toolkit
```

If you don't have the nvidia-container-toolkit installed, set
`WORKER_DEVICE=cpu` in `.env` and remove the `deploy.resources` block from
`docker-compose.yml`. Processing will work but slowly.

## Deploying to a VPS

Two parts:

1. **VPS** runs only the API + frontend (no worker, no Python). 1 vCPU / 1 GB
   RAM / 25 GB disk is plenty. Use `docker-compose.vps.yml`.
2. **Your local box** does all processing. The `deploy-to-vps.sh` script
   rsyncs the media folder and DB to the VPS and restarts the remote stack.

```sh
# one-time VPS setup
ssh root@your-vps
mkdir -p /srv/karaoke
cd /srv/karaoke
git clone https://github.com/yourname/djclaude.git .
docker compose -f docker-compose.vps.yml up -d
exit

# on your local box, fill out .env (VPS_HOST, VPS_USER, etc.) then:
./scripts/deploy-to-vps.sh
# or via the admin panel: /admin → Deploy tab
```

The script does a SQLite `.backup` (so live writes can't corrupt the copy)
before the rsync, then triggers `docker compose up -d` on the VPS.

## Configuration

All knobs are env vars; see `.env.example` for the canonical list. Anything
you change at runtime — VPS host, SSH key, Slack webhook, lyrics style,
auto-enqueue-on-fallback, worker concurrency — lives in the `app_settings`
table and is editable from `/admin`.

## Bulk importing

`/admin → Queue → Bulk import` supports three modes:

| Mode | Source | Example query | Notes |
|---|---|---|---|
| Artist | MusicBrainz (free) | `Fleetwood Mac` | Returns the artist's full deduped discography. |
| Year | Wikipedia Billboard Year-End | `1985` | Scrapes the year's Hot 100 page. |
| Search | Spotify (optional) | `year:2023` | Requires `SPOTIFY_CLIENT_ID` + `SPOTIFY_CLIENT_SECRET`. |

Each candidate becomes a Job with `youtube_url = "ytsearch1:Artist Title karaoke"`,
which yt-dlp resolves to the top YouTube hit at download time — no YouTube
Data API key needed.

## Project structure

```
djclaude-main/
├── backend/                Go API server
│   ├── cmd/server/         main.go
│   └── internal/
│       ├── api/            HTTP/WS handlers (events, requests, jobs, library, admin, settings)
│       ├── config/         env config
│       ├── importers/      musicbrainz, wikipedia, spotify
│       ├── models/         Event, Request, Song, Media, Job, AdminUser
│       ├── queue/          fairness rules (unchanged from v1)
│       ├── store/          SQLite store + migrations
│       ├── ws/             hub (now with inbound handler)
│       └── youtube/        URL parsing
├── worker/                 Python processing pipeline
│   ├── main.py             FastAPI + asyncio loop
│   ├── runner.py           one-job-at-a-time orchestration
│   ├── db.py               SQLite access (shares karaoke.db with Go)
│   ├── pipeline/
│   │   ├── download.py     yt-dlp wrapper
│   │   ├── separate.py     Demucs htdemucs_ft
│   │   ├── transcribe.py   WhisperX large-v3 with word alignment
│   │   ├── render.py       ffmpeg → low-bitrate .webm
│   │   └── hash.py         canonical title/artist hashing (mirrored in Go)
│   └── Dockerfile          CUDA 12.1 + cuDNN base
├── frontend/               Preact + Vite SPA
│   └── src/
│       ├── views/          Landing, Host, Guest, Admin, Screen
│       ├── components/     KaraokePlayer, YouTubeFallbackPlayer, LyricsCanvas,
│       │                   JobBadge, BulkImportModal, LyricsStyleEditor, AdminLogin
│       ├── hooks/          usePlaybackSync, useAdminAuth, useJobs
│       └── lyrics/         presets + shadow/contrast helpers
├── scripts/
│   └── deploy-to-vps.sh    rsync media + DB + remote compose restart
├── docker-compose.yml      local: api + worker (GPU)
├── docker-compose.vps.yml  VPS: api only
├── Dockerfile              API + frontend (multi-stage, no CGO)
├── worker/Dockerfile       Worker (CUDA runtime)
└── .env.example            all knobs documented
```

## Cost & disk footprint

- A processed song = ~2.3 MB (40 kbps VP9 still video + 96 kbps Opus + lyrics JSON).
- 500 processed songs ≈ 1.2 GB. A 25 GB VPS disk holds ~10k songs.
- Processing time on a 4070-class GPU: ~45-60 s per 4-min song
  (download + Demucs + WhisperX + render).
- Processing on CPU: ~10 min per song. Plan for overnight batch runs.

## Legal & operational note

This project is open-source tooling that, like yt-dlp, Demucs, and WhisperX,
sits in the same gray area: removing vocals from a track doesn't make a
new work — it creates a derivative work of copyrighted material.

For personal / home use, practical risk is low. For commercial venues the
clean path is a licensed karaoke catalog (KaraFun commercial, PCDJ Karaoki,
Stingray) — use this tool to **fill gaps** in your licensed library, not to
replace it.

Don't host the `/media/*` URLs publicly without auth, and don't surface
download links in the UI (we don't). The instructions in
[ARCHITECTURE.md](ARCHITECTURE.md) include defaults that keep the media
behind your app's same-origin auth.

## License

MIT. The bundled karaoke-forever ideas + pipeline are also MIT
([gazugafan/karaoke-forever](https://github.com/gazugafan/karaoke-forever)).
