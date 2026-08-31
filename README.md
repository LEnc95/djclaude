# DJClaude — Bar Karaoke Requests

A minimal, self-hostable karaoke request app for a bar DJ. Guests scan a QR
code, submit a song title or YouTube link + singer name; the DJ runs a
real-time dashboard to manage the queue and plays the songs manually. No audio
is downloaded, no playback is automated — we only store request metadata.

## Architecture

- **Backend**: Go (stdlib `net/http` + `gorilla/websocket`). SQLite via the
  pure-Go [`modernc.org/sqlite`](https://gitlab.com/cznic/sqlite) driver — no
  CGO, builds anywhere. Single binary serves the REST API, WebSocket, and the
  built frontend.
- **Frontend**: Preact + TypeScript + Vite. ~13 KB gzipped. Uses
  `wouter-preact` for routing.
- **Realtime**: one WebSocket channel per event code. The server pushes
  `snapshot` on connect, then `request:{created,updated,deleted}` and
  `event:updated` as state changes.

```
backend/        Go server
  cmd/server/   main.go
  internal/
    api/        HTTP handlers + IDs
    config/     env-driven config
    models/     Event, Request, statuses
    queue/      fairness rules
    store/      Store interface + SQLite impl
    ws/         hub
    youtube/    URL/video-id parsing
frontend/       Preact + Vite SPA
  src/
    views/      Landing, Guest, Host
    components/ shared UI
```

## Quick start (dev)

You need Go 1.22+ and Node 18+.

```sh
# 1. Backend
cd backend
go run ./cmd/server
# listens on :8080 by default, creates karaoke.db in CWD

# 2. Frontend (separate terminal, with Vite hot reload)
cd frontend
npm install
npm run dev
# Vite serves at http://localhost:5173 and proxies /api + /ws to :8080
```

Open `http://localhost:5173`. The landing page lets you create an event;
you'll get a guest link (`/r/CODE`), a printable QR code, and a host link
(`/host/CODE?token=…`). The host token is also stored in `localStorage`, so you
only need the link once.

## Deploying to Fly.io (production)

Single-VM deploy with a persistent SQLite volume. See **[DEPLOY.md](DEPLOY.md)**
for full steps. TL;DR:

```sh
fly launch --no-deploy --copy-config --name djclaude
fly volumes create data --size 1 --region iad
fly deploy
fly certs add dj.aiandsons.io   # then add the DNS records flyctl prints
```

## Quick start (production / single binary)

```sh
# Build the frontend (outputs to frontend/dist)
cd frontend && npm install && npm run build && cd ..

# Build the server
cd backend && go build -o ../djclaude ./cmd/server && cd ..

# Run
./djclaude
# Visit http://localhost:8080
```

The Go server serves the built frontend from `frontend/dist` by default.
Override with `STATIC_DIR`.

## Configuration (env vars)

| Var | Default | Purpose |
|---|---|---|
| `ADDR` | `:8080` | listen address |
| `DATABASE_PATH` | `karaoke.db` | SQLite file |
| `STATIC_DIR` | `../frontend/dist` | built SPA |
| `BASE_URL` | `http://localhost:8080` | for printable links |
| `PER_SINGER_LIMIT` | `2` | default active-request cap per singer |
| `AUTO_ACCEPT` | `true` | new requests go straight into the queue |
| `YOUTUBE_API_KEY` | _(unused in v1)_ | reserved for future search |

Frontend-only build variables:

| Var | Default | Purpose |
|---|---|---|
| `VITE_API_BASE` | _(same origin)_ | API/WebSocket origin for split frontend/API deploys |
| `VITE_DJ_TIP_URL` | _(hidden)_ | Shows a "Tip the DJ" support link for guests |
| `VITE_DEVELOPER_DONATE_URL` | _(hidden)_ | Shows a "Donate to developer" support link |

## Creating an event

For v1 the simplest path is the built-in landing page (`/`), but you can
also `curl`:

```sh
curl -X POST http://localhost:8080/api/events \
  -H 'content-type: application/json' \
  -d '{"name":"Friday Karaoke","venue_name":"The Tipsy Mic","per_singer_limit":2,"auto_accept":true}'
```

Response includes `code` (the short event code) and `host_token` (keep
secret — anyone with it can manage the queue). Guest URL is
`/r/<code>`; host URL is `/host/<code>?token=<host_token>`.

## API reference

All bodies are JSON. Host-only routes require `X-Host-Token` header.

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `POST` | `/api/events` | — | Create an event. Returns host token. |
| `GET` | `/api/events/:code` | optional host | Event info. Host token reveals the token. |
| `PATCH` | `/api/events/:code` | host | Update status / accepting / auto-accept / limits / names. |
| `GET` | `/api/events/:code/requests?status=accepted,singing` | optional host | List requests. Guests see live queue by default. |
| `POST` | `/api/events/:code/requests` | — | Submit a request (singer_name + song_input title or YouTube URL + notes). |
| `PATCH` | `/api/events/:code/requests/:id` | host | Update status / song / notes / manual_order. |
| `DELETE` | `/api/events/:code/requests/:id` | host | Delete. |
| `GET` | `/ws/:code[?host_token=…]` | optional host | WebSocket: `snapshot` + change events. |

### WebSocket event shapes

```ts
{ type: "snapshot",         payload: { event, requests } }
{ type: "event:updated",    payload: KaraokeEvent }
{ type: "request:created",  payload: KaraokeRequest }
{ type: "request:updated",  payload: KaraokeRequest }
{ type: "request:deleted",  payload: { id: string } }
```

## Queue / fairness

Each accepted request gets a `rotation_index` = "this singer's nth song
this event" (counted across active + already-sung). Queue order is
`(manual_order, rotation_index, created_at)`. A DJ can override ordering
on a per-request basis with `manual_order > 0` (the host dashboard's up/down
buttons swap manual orders between neighbours).

Per-singer cap: `PER_SINGER_LIMIT` (or the event's `per_singer_limit`).
A singer with that many active (`pending` | `accepted` | `singing`)
requests can't submit more until one finishes.

Duplicate detection: when a video ID matches an existing non-rejected
request in the same event, the new request gets `is_duplicate: true` and
the DJ sees a "duplicate" badge.

## Host keyboard shortcuts

- `D` — mark "now singing" as **done**
- `S` — **skip** current
- `N` — promote first queued request to **now singing**

## Roadmap (not in v1)

- Real YouTube search (Data API) with title autofill.
- Drag-and-drop reorder.
- Tip-priority lanes / multi-venue.
- Pending-reason audit log.

## License

MIT.
