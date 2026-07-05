#!/usr/bin/env bash
# Build the Aerie desktop app (Linux AppImage/deb + Windows installers).
#
# Usage:
#   ./build-desktop.sh                                        # generic build, no baked-in server
#   AERIE_DEFAULT_URL=https://cloud.example.com ./build-desktop.sh   # bake in your server as the default
#
# Run from the apps/ directory. Requires Docker. Artifacts land in desktop/release/.
set -euo pipefail

cd "$(dirname "$0")"

# The packaged app reads default-server.json for its pre-filled server URL.
# Always (re)write it so electron-builder never sees a stale or missing file.
printf '{"url": "%s"}\n' "${AERIE_DEFAULT_URL:-}" > desktop/default-server.json
echo "default-server.json -> $(cat desktop/default-server.json)"

docker run --rm \
  -v "$PWD/desktop:/project" \
  -w /project \
  electronuserland/builder:wine \
  bash -c 'npm install && npm run dist'
