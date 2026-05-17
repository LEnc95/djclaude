# Deploying DJClaude to Fly.io at dj.aiandsons.io

This walks through getting the app live on Fly with the custom domain
`dj.aiandsons.io`. End state: a single Fly Machine running the Go binary
that serves REST + WebSocket + the Preact SPA, with SQLite on a persistent
volume.

Why Fly (and not Vercel) for this app: Vercel Functions are short-lived and
stateless. Our WebSocket hub needs a long-running process, and the SQLite
DB needs a real disk. Fly gives us both for free at this scale.

## Prereqs

- [Fly CLI](https://fly.io/docs/flyctl/install/) installed and `fly auth login` done.
- Docker Desktop (for the local image verification step; not strictly required for `fly deploy`).
- Access to the DNS for `aiandsons.io` so you can add a CNAME / A record.

## One-time setup

```sh
# From the repo root
fly launch --no-deploy --copy-config --name djclaude

# When prompted, accept the existing fly.toml. Choose your primary_region
# (e.g. iad/ord/lax/sjc) — match the value in fly.toml.
```

The `fly launch` step creates the app entry on Fly and registers the
Dockerfile. We're using `--no-deploy` because the volume must exist before
the first deploy (the app mounts `/data`).

### Create the persistent volume

```sh
# 1 GB is plenty for thousands of karaoke requests; bump later if needed.
fly volumes create data --size 1 --region iad
```

> Use the same region you set in `fly.toml`. A volume is regional and the
> Machine must run in the same region as its volume.

### First deploy

```sh
fly deploy
```

Watch the build: Docker stages (frontend → Go → alpine runtime), push, then
Fly starts a Machine and runs the health check at `/api/health`. When
`status=ok` is healthy, you're live at `https://djclaude.fly.dev`.

Quick smoke test:

```sh
curl -sf https://djclaude.fly.dev/api/health        # {"status":"ok"}
curl -s -X POST https://djclaude.fly.dev/api/events \
  -H 'content-type: application/json' \
  -d '{"name":"smoke","venue_name":"Fly"}' | jq .
```

## Custom domain: dj.aiandsons.io

```sh
fly certs add dj.aiandsons.io
```

`flyctl` prints the DNS records you need to create. Typically:

- A record `dj.aiandsons.io` → Fly's IPv4 (printed)
- AAAA record `dj.aiandsons.io` → Fly's IPv6 (printed)
- *or* a single CNAME `dj.aiandsons.io` → `djclaude.fly.dev`

Add those at your DNS provider for `aiandsons.io`. Then:

```sh
fly certs check dj.aiandsons.io
```

Fly will issue a Let's Encrypt cert automatically once DNS resolves (usually
within a few minutes). Visit https://dj.aiandsons.io — you should see the
Neon Lounge landing page.

> If you want the apex `aiandsons.io` to redirect to `dj.aiandsons.io`,
> handle that at the DNS / registrar level (most providers support a
> domain-level redirect rule). It's not part of this app.

## Tuning

### Make sure printable QR URLs use the custom domain

Once the custom domain is verified, the `BASE_URL` env var in `fly.toml`
already points to `https://dj.aiandsons.io`. Restart the Machine to pick
up any future env changes:

```sh
fly deploy   # or: fly machine restart <id>
```

### Per-singer cap / auto-accept

Set in `fly.toml` (`[env]`). Or override at runtime without redeploy:

```sh
fly secrets set PER_SINGER_LIMIT=3 AUTO_ACCEPT=false
```

> `fly secrets set` triggers a rolling restart automatically.

### Scale up / down

The default `fly.toml` ships:
- `shared-cpu-1x` / 256 MB — fine for one bar
- `auto_stop_machines = "stop"` — Fly parks the Machine when idle
- `min_machines_running = 0` — first request after idle adds ~2s cold start

If you need always-on (busy night, no cold starts):

```sh
fly scale count 1 --max-per-region 1
fly machine update <machine_id> --restart-policy always
```

Bigger VM for many simultaneous WebSocket clients:

```sh
fly scale vm shared-cpu-2x --memory 512
```

### Logs / shell

```sh
fly logs                # tail logs from the running Machine
fly ssh console         # shell into the container
ls /data                # see karaoke.db on the volume
```

### Backups

SQLite + Fly volumes: take periodic snapshots.

```sh
fly volumes snapshots list
fly volumes snapshots create <volume-id>
```

For something more automated, run `litestream` as a sidecar that replicates
to S3 — out of scope for v1.

## Updating

Push code, redeploy:

```sh
git pull   # if working on a teammate's machine
fly deploy
```

`fly deploy` rebuilds the Docker image, ships the new layers, starts a new
Machine, waits for the health check, then swaps traffic. Zero-downtime by
default.

## Tearing down

```sh
fly apps destroy djclaude
fly certs remove dj.aiandsons.io
fly volumes destroy <volume-id>
```

## Troubleshooting

- **`fly certs check` stuck at "awaiting-configuration"** — DNS hasn't
  propagated yet. `dig dj.aiandsons.io` to confirm. Some providers take an
  hour; Cloudflare usually under a minute.
- **WebSocket disconnects every 30s in prod** — Fly's edge holds open
  connections fine, but check that your client isn't behind a proxy that
  cuts long-lived sockets. The app already sends a ping every 54s.
- **Database wiped between deploys** — the volume mount didn't attach. Run
  `fly volumes list` and confirm a `data` volume exists in the same region
  as the Machine; `fly machine update <id> --mount source=data,destination=/data`.
- **Build fails with `package modernc.org/sqlite ... CGO`** — make sure
  `CGO_ENABLED=0` is set in the Dockerfile's Go stage (it is in the
  shipped one).
