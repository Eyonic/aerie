#!/bin/bash
# Runs ON the docker host. Reads integration secrets from the existing service
# DBs/containers and writes them into an env file for the Aerie container.
# All site-specific values come from deploy/deploy.conf (see deploy.conf.example).
# Secrets are never printed to stdout.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONF="$SCRIPT_DIR/deploy.conf"
if [ -f "$CONF" ]; then
  # shellcheck source=deploy.conf.example
  . "$CONF"
fi

die() { echo "ERROR: $*" >&2; exit 1; }

[ -n "${HOST_IP:-}" ] || die "HOST_IP is not set. Copy $SCRIPT_DIR/deploy.conf.example to $SCRIPT_DIR/deploy.conf and fill in your values."

APPDIR="${APPDIR:-/mnt/user/appdata/aerie}"
ENVFILE="$APPDIR/aerie.env"
mkdir -p "$APPDIR/data" "$APPDIR/files"

# ---- Harvest API keys from existing service installs (all optional) ----
JELLY_KEY=""
if [ -n "${JELLYFIN_APPDATA:-}" ]; then
  JELLY_KEY="$(sqlite3 -readonly "$JELLYFIN_APPDATA/data/jellyfin.db" 'SELECT AccessToken FROM ApiKeys LIMIT 1;' 2>/dev/null || true)"
fi
ABS_TOKEN=""
if [ -n "${ABS_APPDATA:-}" ]; then
  ABS_TOKEN="$(sqlite3 -readonly "$ABS_APPDATA/absdatabase.sqlite" "SELECT token FROM users ORDER BY (type='root') DESC, id ASC LIMIT 1;" 2>/dev/null || true)"
fi
JS_KEY=""
if [ -n "${JELLYSEERR_APPDATA:-}" ]; then
  JS_KEY="$(grep -oE '"apiKey" *: *"[^"]+"' "$JELLYSEERR_APPDATA/settings.json" 2>/dev/null | head -1 | sed -E 's/.*: *"//; s/"$//' || true)"
fi
LIDARR_KEY=""
if [ -n "${LIDARR_APPDATA:-}" ]; then
  LIDARR_KEY="$(grep -oE '<ApiKey>[^<]+' "$LIDARR_APPDATA/config.xml" 2>/dev/null | head -1 | sed 's/<ApiKey>//' || true)"
fi
# DeepSeek key lives ONLY on the server (never in the repo).
DEEPSEEK_KEY_FILE="${DEEPSEEK_KEY_FILE:-$APPDIR/deepseek.key}"
DS_KEY="$(cat "$DEEPSEEK_KEY_FILE" 2>/dev/null | tr -d '\n' || true)"

# Preserve an existing JWT secret across redeploys so sessions survive.
# Falls back to the legacy CloudBox-era env file (the app's former name) so
# upgrades from CloudBox keep everyone logged in.
JWT_SRC=""
if [ -f "$ENVFILE" ] && grep -q '^JWT_SECRET=' "$ENVFILE"; then
  JWT_SRC="$ENVFILE"
elif [ -f "$APPDIR/cloudbox.env" ] && grep -q '^JWT_SECRET=' "$APPDIR/cloudbox.env"; then
  JWT_SRC="$APPDIR/cloudbox.env"
fi
if [ -n "$JWT_SRC" ]; then
  JWT="$(sed -n 's/^JWT_SECRET=//p' "$JWT_SRC" | head -1)"
else
  JWT="$(openssl rand -hex 32)"
fi

umask 077
cat > "$ENVFILE" <<EOF
PORT=8200
JWT_SECRET=$JWT
PUBLIC_URL=${PUBLIC_URL:-}
LAN_URL=${LAN_URL:-http://$HOST_IP:8200}
TRANSLATE_LANG=${TRANSLATE_LANG:-}
MEDIA_PATH_MAP=${MEDIA_PATH_MAP:-}
DATA_DIR=/data
FILES_ROOT=/files
MEDIA_ROOT=/media
DOWNLOADS_DIR=/downloads
TOWER_HOST=$HOST_IP
JELLYFIN_URL=http://$HOST_IP:8096
JELLYFIN_API_KEY=$JELLY_KEY
ABS_URL=http://$HOST_IP:13378
ABS_API_KEY=$ABS_TOKEN
OLLAMA_URL=http://$HOST_IP:11434
OLLAMA_MODEL=${OLLAMA_MODEL:-llama3.2:latest}
SD_URL=http://$HOST_IP:9000
WHISPER_URL=http://$HOST_IP:10300
JELLYSEERR_URL=http://$HOST_IP:5055
JELLYSEERR_API_KEY=$JS_KEY
LIDARR_URL=http://$HOST_IP:8686
LIDARR_API_KEY=$LIDARR_KEY
ACESTEP_URL=http://$HOST_IP:8019
DEEPSEEK_URL=https://api.deepseek.com
DEEPSEEK_API_KEY=$DS_KEY
DEEPSEEK_MODEL=${DEEPSEEK_MODEL:-deepseek-chat}
EOF

# Report only presence, never values.
echo "wrote $ENVFILE"
echo "jellyfin_key:   $([ -n "$JELLY_KEY" ] && echo present || echo MISSING)"
echo "abs_token:      $([ -n "$ABS_TOKEN" ] && echo present || echo MISSING)"
echo "jellyseerr_key: $([ -n "$JS_KEY" ] && echo present || echo MISSING)"
echo "lidarr_key:     $([ -n "$LIDARR_KEY" ] && echo present || echo MISSING)"
echo "deepseek_key:   $([ -n "$DS_KEY" ] && echo present || echo MISSING)"
