#!/bin/bash
# Runs ON the docker host. Builds the Aerie image and (re)starts the
# container. Paths come from deploy/deploy.conf (see deploy.conf.example);
# generic defaults are used when unset.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONF="$SCRIPT_DIR/deploy.conf"
if [ -f "$CONF" ]; then
  # shellcheck source=deploy.conf.example
  . "$CONF"
fi

SRC="${SRC_DIR:-/root/aerie-src}"
APPDIR="${APPDIR:-/mnt/user/appdata/aerie}"
MEDIA_DIR="${MEDIA_DIR:-/mnt/user/Media}"

# ---- One-time migration from CloudBox (the app's former name) ----------
# Keep the old env file's contents (especially JWT_SECRET) so existing
# sessions survive the rename — nobody gets logged out.
if [ ! -f "$APPDIR/aerie.env" ] && [ -f "$APPDIR/cloudbox.env" ]; then
  echo ">> migrating legacy cloudbox.env -> aerie.env"
  mv "$APPDIR/cloudbox.env" "$APPDIR/aerie.env"
fi
# ------------------------------------------------------------------------

echo ">> generating env (secrets stay on server)"
# Use the repo's copy — a stale local copy of gen-env.sh once silently dropped
# newly added env vars (LIDARR_*) from the env file on redeploy.
bash "$SRC/deploy/gen-env.sh"

echo ">> building image (this can take a few minutes)"
cd "$SRC"
docker build -t aerie:latest .

echo ">> (re)starting container"
# One-time migration: remove the legacy CloudBox-era container (same port)
# so upgrades from CloudBox don't hit a port conflict.
docker rm -f cloudbox >/dev/null 2>&1 || true
docker rm -f aerie >/dev/null 2>&1 || true
docker run -d --name aerie --restart unless-stopped \
  -p 8200:8200 \
  --env-file "$APPDIR/aerie.env" \
  -v "$APPDIR/data":/data \
  -v "$APPDIR/files":/files \
  -v "$APPDIR/downloads":/downloads \
  -v "$MEDIA_DIR":/media \
  aerie:latest

sleep 4
echo ">> health check"
curl -s http://127.0.0.1:8200/api/health || echo "  (not up yet)"
echo
docker logs --tail 20 aerie 2>&1 || true
