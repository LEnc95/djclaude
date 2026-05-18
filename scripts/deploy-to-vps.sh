#!/usr/bin/env bash
# deploy-to-vps.sh — push the processed media + DB to a VPS that runs the
# api-only Docker Compose stack. Idempotent and safe to re-run.
#
# Reads VPS_HOST / VPS_USER / VPS_PATH / VPS_SSH_KEY / VPS_RSYNC_OPTS from
# the local .env. Optional: pass --dry-run to preview what rsync would do.
#
# Usage:
#   ./scripts/deploy-to-vps.sh           # full sync + remote compose restart
#   ./scripts/deploy-to-vps.sh --dry-run # preview only
#   ./scripts/deploy-to-vps.sh --media-only  # skip the DB
#   ./scripts/deploy-to-vps.sh --no-restart  # don't bounce compose

set -euo pipefail

DRY_RUN=0
SKIP_DB=0
NO_RESTART=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --media-only) SKIP_DB=1 ;;
    --no-restart) NO_RESTART=1 ;;
    -h|--help)
      sed -n '1,20p' "$0"; exit 0 ;;
    *) echo "unknown arg: $arg" >&2; exit 2 ;;
  esac
done

# Load .env if present (POSIX-friendly). Values with spaces should be quoted.
if [[ -f .env ]]; then
  set -a; . ./.env; set +a
fi

: "${VPS_HOST:?Set VPS_HOST (in .env or admin settings)}"
: "${VPS_USER:=root}"
: "${VPS_PATH:=/srv/karaoke}"
: "${VPS_SSH_KEY:=$HOME/.ssh/id_ed25519}"
: "${VPS_RSYNC_OPTS:=-az --partial --human-readable}"
: "${MEDIA_DIR:=./media}"
: "${DATABASE_PATH:=./karaoke.db}"

SSH_OPTS=(-o StrictHostKeyChecking=accept-new -i "$VPS_SSH_KEY")
RSYNC_BASE=(rsync $VPS_RSYNC_OPTS -e "ssh ${SSH_OPTS[*]}")
[[ $DRY_RUN -eq 1 ]] && RSYNC_BASE+=(--dry-run --itemize-changes)

# Ensure target dirs exist.
ssh "${SSH_OPTS[@]}" "$VPS_USER@$VPS_HOST" "mkdir -p '$VPS_PATH/media'"

echo ">> Sync media → $VPS_USER@$VPS_HOST:$VPS_PATH/media/"
"${RSYNC_BASE[@]}" "$MEDIA_DIR/" "$VPS_USER@$VPS_HOST:$VPS_PATH/media/"

if [[ $SKIP_DB -eq 0 ]]; then
  echo ">> Sync DB → $VPS_USER@$VPS_HOST:$VPS_PATH/"
  # SQLite WAL note: copying the .db while writes are in flight risks a
  # partial file. We use sqlite's .backup command to get a consistent copy
  # locally first, then rsync that.
  TMPDB="$(mktemp).db"
  sqlite3 "$DATABASE_PATH" ".backup '$TMPDB'"
  "${RSYNC_BASE[@]}" "$TMPDB" "$VPS_USER@$VPS_HOST:$VPS_PATH/karaoke.db"
  rm -f "$TMPDB"
fi

if [[ $NO_RESTART -eq 0 && $DRY_RUN -eq 0 ]]; then
  echo ">> Restart remote Docker Compose stack"
  ssh "${SSH_OPTS[@]}" "$VPS_USER@$VPS_HOST" \
    "cd '$VPS_PATH' && docker compose -f docker-compose.vps.yml up -d --remove-orphans"
fi

echo "done."
