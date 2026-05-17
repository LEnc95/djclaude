# Deploying DJClaude (GitHub + Vercel + Fly)

Three-piece split deploy:

| Piece | Where | URL |
|---|---|---|
| Source code | GitHub | `https://github.com/LEnc95/djclaude` |
| Static SPA | Vercel | `https://dj.aiandsons.io` |
| API + WebSocket + SQLite | Fly.io | `https://api.dj.aiandsons.io` |

The frontend calls the backend via the `VITE_API_BASE` env var (baked at build time on Vercel). CORS is permissive but allow-listed via `ALLOWED_ORIGINS` on the Fly side.

---

## 0. Prerequisites

- GitHub: already done (`LEnc95/djclaude` is live and public).
- Fly CLI installed (`fly version` → 0.4+). Done on this machine. If you're on another box: https://fly.io/docs/flyctl/install/.
- A logged-in browser session for **Vercel** (any account that controls `dj.aiandsons.io`'s DNS, or that has access to add domains there).
- DNS access for `aiandsons.io`.

---

## 1. Fly.io — backend at `api.dj.aiandsons.io`

### 1a. Auth (interactive — opens your browser)

```sh
fly auth login
```

### 1b. Launch the app from this repo

From the repo root (where `fly.toml` lives):

```sh
fly launch --no-deploy --copy-config --name djclaude
```

Notes:
- When asked about adding databases/Redis: **no**.
- Use the same region that's in `fly.toml` (`iad` is fine for US East; swap for `lax`, `ord`, `sjc`, etc.).

### 1c. Create the persistent volume

```sh
fly volumes create data --size 1 --region iad
```

> Volumes are regional. Match your `primary_region` in `fly.toml`.

### 1d. Set CORS for the Vercel origin (and Vercel previews)

```sh
fly secrets set ALLOWED_ORIGINS="https://dj.aiandsons.io,https://djclaude.vercel.app"
```

> Add more comma-separated origins later (e.g. preview branches) without redeploying.

### 1e. First deploy

```sh
fly deploy
```

Watch the build. When the health check at `/api/health` goes green, you're up at `https://djclaude.fly.dev`.

Smoke test:

```sh
curl -sf https://djclaude.fly.dev/api/health
# → {"status":"ok"}
```

### 1f. Custom subdomain `api.dj.aiandsons.io`

```sh
fly certs add api.dj.aiandsons.io
fly certs show api.dj.aiandsons.io
```

`flyctl` prints DNS records to add. Typically a CNAME:

```
CNAME  api.dj.aiandsons.io  →  djclaude.fly.dev
```

Add it at your DNS provider for `aiandsons.io`. Then:

```sh
fly certs check api.dj.aiandsons.io
```

Cert issues in ~minutes. Sanity check:

```sh
curl -sf https://api.dj.aiandsons.io/api/health   # {"status":"ok"}
```

---

## 2. Vercel — SPA at `dj.aiandsons.io`

### 2a. Import the repo (browser, one-time)

Open https://vercel.com/new in a browser logged into your Vercel team
(`lenc95's projects`). Import `LEnc95/djclaude`.

Vercel will read `vercel.json` from the repo automatically:

- Build command: `cd frontend && npm install && npm run build`
- Output directory: `frontend/dist`
- SPA rewrite rule for `/r/:code`, `/host/:code`, etc.

### 2b. Set the API base before first deploy

In the import screen, expand **Environment Variables** and add:

| Name | Value | Env |
|---|---|---|
| `VITE_API_BASE` | `https://api.dj.aiandsons.io` | Production, Preview |

This is baked into the SPA bundle at build time — change it later means triggering a new deploy.

Click **Deploy**. Initial build takes ~60 s. When it goes green you'll have `djclaude.vercel.app`.

### 2c. Custom domain

In Vercel project settings → **Domains**:

- Add `dj.aiandsons.io`.
- Vercel shows the CNAME / A record to add at your DNS provider. Typically:

```
CNAME  dj.aiandsons.io  →  cname.vercel-dns.com
```

Add at your DNS, then wait for verification. Done — the SPA is live at `https://dj.aiandsons.io`.

### 2d. Push-to-deploy

Any push to `main` of `LEnc95/djclaude` now auto-deploys to Vercel.

---

## 3. End-to-end smoke test

After all DNS resolves:

```sh
# Backend health
curl -sf https://api.dj.aiandsons.io/api/health

# Create an event
EV=$(curl -s -X POST https://api.dj.aiandsons.io/api/events \
  -H 'content-type: application/json' \
  -d '{"name":"Smoke","venue_name":"Neon Lounge"}')
CODE=$(echo "$EV" | jq -r .code)
TOKEN=$(echo "$EV" | jq -r .host_token)

# Submit a request
curl -s -X POST "https://api.dj.aiandsons.io/api/events/$CODE/requests" \
  -H 'content-type: application/json' \
  -d '{"singer_name":"Alex","song_input":"https://www.youtube.com/watch?v=dQw4w9WgXcQ"}' | jq .

# Open the SPA, both URLs should work:
echo "https://dj.aiandsons.io/r/$CODE"
echo "https://dj.aiandsons.io/host/$CODE?token=$TOKEN"
```

In the host view, open browser devtools → Network → WS tab; the `/ws/...` connection should be open with `snapshot` arriving immediately.

---

## 4. Operations cheatsheet

### Fly

```sh
fly logs                 # tail Machine logs
fly ssh console          # shell into the running container
fly status               # see Machine state
fly machine restart ID   # restart with current env
fly secrets list         # see ALLOWED_ORIGINS, etc.
fly volumes snapshots create VOLUME_ID   # backup SQLite
```

### Vercel

- Dashboard → Deployments → pick a deployment → "Promote to Production" to roll back.
- Add `*.vercel.app` preview origins to Fly's `ALLOWED_ORIGINS` if guests will share preview links.

### Tuning

| Variable | Where | Effect |
|---|---|---|
| `ALLOWED_ORIGINS` | Fly secrets | Comma-list of origins allowed cross-origin. |
| `PER_SINGER_LIMIT` | Fly env in fly.toml | Active-request cap per singer. |
| `AUTO_ACCEPT` | Fly env in fly.toml | Skip pending → accepted automatically. |
| `BASE_URL` | Fly env in fly.toml | Used for any printable share URLs. |
| `VITE_API_BASE` | Vercel env | API base URL baked into the SPA. |

---

## 5. Troubleshooting

- **CORS error in browser console** — confirm `ALLOWED_ORIGINS` on Fly contains your exact origin (no trailing slash). Use `fly secrets list` to double-check and `fly deploy` after changes (or `fly machine restart`).
- **WebSocket fails to connect from Vercel** — gorilla/websocket's CheckOrigin in the hub is permissive, so this is almost always a path / proto issue. Open the host page in devtools → Network → WS; the URL should be `wss://api.dj.aiandsons.io/ws/<code>?host_token=...`.
- **Cert stuck on `awaiting-configuration`** — DNS hasn't propagated. `dig api.dj.aiandsons.io` to check. Fly will issue once it resolves; usually <5 min on Cloudflare.
- **Fly deploy fails on `package modernc.org/sqlite ... CGO`** — make sure the Dockerfile's Go stage has `ENV CGO_ENABLED=0` (the shipped one does).
- **SQLite wiped between deploys** — volume didn't attach. `fly volumes list` should show `data` in the same region as the Machine. If not: `fly volumes create data --size 1 --region iad`.

---

## 6. Tearing down

```sh
# Fly
fly apps destroy djclaude
fly volumes destroy <volume-id>

# Vercel — easier in the dashboard: Project Settings → Delete Project
```
