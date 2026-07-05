#!/bin/bash
# Runs ON the docker host. Adds/updates a proxy host for Aerie in Nginx
# Proxy Manager (DB row + nginx conf) pointing at the Aerie container on
# :8200. Idempotent. HTTP by default; pass "ssl <npm-cert-dir>" to enable TLS.
#
# Required settings (from deploy/deploy.conf, or as environment variables):
#   DOMAIN         public domain to serve (e.g. cloud.example.com)
#   HOST_IP        LAN IP of the docker host running Aerie
#   NPM_DATA_DIR   NPM appdata dir (contains data/database.sqlite)
#   NPM_CONTAINER  name of the running NPM container
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONF="$SCRIPT_DIR/deploy.conf"
if [ -f "$CONF" ]; then
  # shellcheck source=deploy.conf.example
  . "$CONF"
fi

usage() {
  cat >&2 <<'USAGE'
Usage: npm-proxy.sh [http|ssl <npm-cert-dir>]

Requires DOMAIN, HOST_IP, NPM_DATA_DIR and NPM_CONTAINER to be set — either
in deploy/deploy.conf (copy deploy.conf.example) or as environment variables:

  DOMAIN=cloud.example.com HOST_IP=192.168.0.10 \
  NPM_DATA_DIR=/path/to/appdata/nginx-proxy-manager \
  NPM_CONTAINER=nginx-proxy-manager \
  ./npm-proxy.sh ssl npm-cloud
USAGE
  exit 1
}

MISSING=""
for var in DOMAIN HOST_IP NPM_DATA_DIR NPM_CONTAINER; do
  [ -n "${!var:-}" ] || MISSING="$MISSING $var"
done
if [ -n "$MISSING" ]; then
  echo "ERROR: missing required settings:$MISSING" >&2
  usage
fi

DB="$NPM_DATA_DIR/data/database.sqlite"
CONFDIR="$NPM_DATA_DIR/data/nginx/proxy_host"
FWD_HOST="$HOST_IP"
FWD_PORT=8200
CERTDIR="${2:-}"     # NPM cert dir under /etc/letsencrypt/live/  when mode=ssl

# Find existing id for this domain, else next id.
EXISTING=$(sqlite3 "$DB" "SELECT id FROM proxy_host WHERE domain_names LIKE '%$DOMAIN%' AND is_deleted=0 LIMIT 1;" 2>/dev/null || true)
if [ -n "$EXISTING" ]; then ID="$EXISTING"; else ID=$(( $(sqlite3 "$DB" "SELECT COALESCE(MAX(id),1000) FROM proxy_host;") + 1 )); fi

CERT_ID=0
SSL_BLOCK=""
if [ "${1:-http}" = "ssl" ] && [ -n "$CERTDIR" ]; then
  # look up NPM certificate row id matching this domain, if present
  CID=$(sqlite3 "$DB" "SELECT id FROM certificate WHERE domain_names LIKE '%$DOMAIN%' AND is_deleted=0 LIMIT 1;" 2>/dev/null || true)
  CERT_ID="${CID:-0}"
  SSL_BLOCK=$(cat <<SSL
  listen 443 ssl;
  listen [::]:443 ssl;
  include conf.d/include/ssl-ciphers.conf;
  ssl_certificate /etc/letsencrypt/live/$CERTDIR/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/$CERTDIR/privkey.pem;
SSL
)
fi

# Upsert DB row (so the host appears in the NPM UI and is managed).
if [ -n "$EXISTING" ]; then
  sqlite3 "$DB" "UPDATE proxy_host SET forward_host='$FWD_HOST', forward_port=$FWD_PORT, forward_scheme='http', certificate_id=$CERT_ID, allow_websocket_upgrade=1, block_exploits=1, http2_support=1, enabled=1, modified_on=datetime('now') WHERE id=$ID;"
else
  sqlite3 "$DB" "INSERT INTO proxy_host (id,created_on,modified_on,owner_user_id,is_deleted,domain_names,forward_host,forward_port,access_list_id,certificate_id,ssl_forced,caching_enabled,block_exploits,advanced_config,meta,allow_websocket_upgrade,http2_support,forward_scheme,enabled,locations,hsts_enabled,hsts_subdomains,trust_forwarded_proto) VALUES ($ID,datetime('now'),datetime('now'),1,0,'[\"$DOMAIN\"]','$FWD_HOST',$FWD_PORT,0,$CERT_ID,0,0,1,'','{\"nginx_online\":true,\"nginx_err\":null}',1,1,'http',1,'[]',0,0,0);"
fi

# Write the nginx conf (streaming-friendly: no buffering, long timeouts, big uploads).
cat > "$CONFDIR/$ID.conf" <<CONF
# ------------------------------------------------------------
# $DOMAIN  — Aerie
# ------------------------------------------------------------
server {
  set \$forward_scheme http;
  set \$server         "$FWD_HOST";
  set \$port           $FWD_PORT;

  listen 80;
  listen [::]:80;
$SSL_BLOCK
  server_name $DOMAIN;

  access_log /data/logs/proxy-host-${ID}_access.log proxy;
  error_log /data/logs/proxy-host-${ID}_error.log warn;

  client_max_body_size 0;

  location / {
    proxy_set_header Host \$host;
    proxy_set_header X-Forwarded-Scheme \$scheme;
    proxy_set_header X-Forwarded-Proto  \$scheme;
    proxy_set_header X-Forwarded-For \$remote_addr;
    proxy_set_header X-Real-IP \$remote_addr;
    proxy_pass http://$FWD_HOST:$FWD_PORT;

    proxy_http_version 1.1;
    proxy_set_header Upgrade \$http_upgrade;
    proxy_set_header Connection \$http_connection;
    proxy_buffering off;
    proxy_request_buffering off;
    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;
  }

  include conf.d/include/letsencrypt-acme-challenge.conf;
}
CONF

echo ">> reloading NPM nginx"
docker exec "$NPM_CONTAINER" nginx -t && docker exec "$NPM_CONTAINER" nginx -s reload
echo ">> proxy host $ID for $DOMAIN -> $FWD_HOST:$FWD_PORT (cert_id=$CERT_ID)"
