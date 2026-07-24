#!/usr/bin/env bash
# Build the Aerie desktop app (Linux AppImage/deb + Windows installers).
#
# Usage:
#   ./build-desktop.sh                                        # generic build, no baked-in server
#   AERIE_DEFAULT_URL=https://cloud.example.com ./build-desktop.sh   # bake in your server as the default
#   AERIE_RELEASE_MODE=publish AERIE_RELEASE_SIGNING_KEY=/secure/key.pem ./build-desktop.sh
#
# Run from the apps/ directory. Requires Docker. Artifacts land in desktop/release/.
set -euo pipefail

cd "$(dirname "$0")"

release_mode="${AERIE_RELEASE_MODE:-local}"
case "$release_mode" in
  local|publish) ;;
  *) echo "AERIE_RELEASE_MODE must be local or publish" >&2; exit 1 ;;
esac
if [ "$release_mode" = publish ] && [ -z "${AERIE_RELEASE_SIGNING_KEY:-}" ]; then
  echo "published desktop builds require AERIE_RELEASE_SIGNING_KEY" >&2
  exit 1
fi

# Build into a unique, empty directory. electron-builder does not clean its
# output directory, so reusing desktop/release can silently retain old apps.
build_dir="$(mktemp -d "$PWD/desktop/.release-build.XXXXXX")"
build_name="$(basename "$build_dir")"
old_release=""
cleanup() {
  status=$?
  case "$build_dir" in
    "$PWD"/desktop/.release-build.*) [ ! -e "$build_dir" ] || rm -rf -- "$build_dir" ;;
  esac
  case "$old_release" in
    "$PWD"/desktop/.release-previous.*)
      if [ -e "$old_release" ] && [ ! -e desktop/release ]; then
        mv -- "$old_release" desktop/release || true
      elif [ -e "$old_release" ]; then
        rm -rf -- "$old_release"
      fi
      ;;
  esac
  return "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

docker run --rm \
  -e "AERIE_DEFAULT_URL=${AERIE_DEFAULT_URL:-}" \
  -e "AERIE_DESKTOP_OUTPUT=$build_name" \
  -v "$PWD/desktop:/project" \
  -w /project \
  electronuserland/builder:wine \
  bash -c '
    set -euo pipefail
    node write-default-server.js
    npm ci --no-audit --no-fund
    npm test
    npm run dist -- --config.directories.output="$AERIE_DESKTOP_OUTPUT"
  '

# Sidecars carry the exact checksum and version consumed by Aerie's Get Apps
# catalogue. Keep this in Docker too: Docker remains the only prerequisite.
signing_mount=()
signing_environment=()
if [ -n "${AERIE_RELEASE_SIGNING_KEY:-}" ]; then
  signing_key="$(realpath -e -- "$AERIE_RELEASE_SIGNING_KEY")"
  [ -f "$signing_key" ] || { echo "release signing key is not a regular file" >&2; exit 1; }
  signing_mount=(-v "$signing_key:/run/secrets/aerie-release-signing-key.pem:ro")
  signing_environment=(-e AERIE_RELEASE_SIGNING_KEY=/run/secrets/aerie-release-signing-key.pem)
fi
writer_args=(--target desktop --artifacts-dir /artifacts)
if [ "$release_mode" = publish ]; then writer_args+=(--require-signature); fi
docker run --rm \
  --network none \
  --read-only \
  --tmpfs /tmp:rw,nosuid,nodev,noexec,size=32m,mode=1777 \
  "${signing_mount[@]}" \
  "${signing_environment[@]}" \
  -v "$PWD/..:/workspace:ro" \
  -v "$build_dir:/artifacts:rw" \
  -w /workspace/apps \
  node:22-alpine \
  sh -c 'node --test test/release-sidecars.test.mjs && exec node write-release-sidecars.mjs "$@"' \
  release-writer "${writer_args[@]}"

# Publish only the newly completed output tree locally. Preserve the previous
# directory until the replacement rename succeeds, then remove that known
# build-output backup.
if [ -L desktop/release ] || { [ -e desktop/release ] && [ ! -d desktop/release ]; }; then
  echo "desktop/release is not a safe build-output directory" >&2
  exit 1
fi
if [ -d desktop/release ]; then
  old_release="$PWD/desktop/.release-previous.$$"
  [ ! -e "$old_release" ] || { echo "temporary release backup already exists" >&2; exit 1; }
  mv -- desktop/release "$old_release"
fi
mv -- "$build_dir" desktop/release
build_dir=""
if [ -n "$old_release" ]; then rm -rf -- "$old_release"; old_release=""; fi
echo "Desktop artifacts: $PWD/desktop/release ($release_mode metadata)"
