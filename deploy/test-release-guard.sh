#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=release-guard.sh
. "$SCRIPT_DIR/release-guard.sh"

ROOT="$(mktemp -d "${TMPDIR:-/tmp}/aerie-release-guard.XXXXXX")"
cleanup() {
  case "$ROOT" in
    "${TMPDIR:-/tmp}"/aerie-release-guard.*) rm -rf -- "$ROOT" ;;
  esac
}
trap cleanup EXIT

mkdir -p "$ROOT/server" "$ROOT/web" "$ROOT/apps/desktop"
echo '**/node_modules' > "$ROOT/.dockerignore"
echo 'FROM scratch' > "$ROOT/Dockerfile"
echo 'module.exports = {};' > "$ROOT/apps/desktop/release-signature.js"
echo '{"schemaVersion":1}' > "$ROOT/apps/desktop/release-key.json"
for component in server web apps/desktop
do
  echo '{"version":"1.8.0"}' > "$ROOT/$component/package.json"
  echo '{"version":"1.8.0"}' > "$ROOT/$component/package-lock.json"
done

aerie_require_release_versions "$ROOT" 1.8.0
aerie_require_candidate_version 1.8.0 1.8.0
if aerie_require_candidate_version 1.7.0 1.8.0 >"$ROOT/out" 2>"$ROOT/error"; then
  echo "stale candidate health version was accepted" >&2
  exit 1
fi
grep -q 'candidate reports version 1.7.0, expected 1.8.0' "$ROOT/error"
first="$(aerie_source_identity "$ROOT")"
[[ "$first" =~ ^[a-f0-9]{64}$ ]]

echo 'source change' > "$ROOT/server/change.ts"
second="$(aerie_source_identity "$ROOT")"
[ "$first" != "$second" ]

echo '{"version":"1.7.0"}' > "$ROOT/web/package.json"
if aerie_require_release_versions "$ROOT" 1.8.0 >"$ROOT/out" 2>"$ROOT/error"; then
  echo "mismatched versions were accepted" >&2
  exit 1
fi
grep -q 'web/package.json is 1.7.0, expected 1.8.0' "$ROOT/error"

echo "release guard tests passed"
