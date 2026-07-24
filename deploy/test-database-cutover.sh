#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SOURCE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
RELEASE_VERSION="$(node -p "require('$SOURCE_DIR/server/package.json').version")"
ROOT="$(mktemp -d "${TMPDIR:-/tmp}/aerie-deploy-cutover.XXXXXX")"
cleanup() {
  case "$ROOT" in
    "${TMPDIR:-/tmp}"/aerie-deploy-cutover.*) rm -rf -- "$ROOT" ;;
  esac
}
trap cleanup EXIT

mkdir -p "$ROOT/bin" "$ROOT/state" "$ROOT/app/data" "$ROOT/app/files" "$ROOT/app/downloads" "$ROOT/media"
ln -s "$SCRIPT_DIR/test/fake-docker.sh" "$ROOT/bin/docker"
printf 'pre-migration-v6\n' > "$ROOT/app/data/cloudbox.db"
printf 'old\n' > "$ROOT/state/container-aerie"
: > "$ROOT/state/running-aerie"
printf '2026-07-23T00:00:00.000000000Z\n' > "$ROOT/state/started-aerie"
printf 'unless-stopped\n' > "$ROOT/state/restart-aerie"

export PATH="$ROOT/bin:$PATH"
export FAKE_DOCKER_STATE="$ROOT/state"
export FAKE_DOCKER_FAIL_PRIVATE=1
export FAKE_EXPECTED_VERSION="$RELEASE_VERSION"
export FAKE_LIVE_DB="$ROOT/app/data/cloudbox.db"
export SRC_DIR="$SOURCE_DIR"
export APPDIR="$ROOT/app"
export MEDIA_DIR="$ROOT/media"
export AERIE_UID="$(id -u)"
export AERIE_GID="$(id -g)"
export HOST_IP=127.0.0.1
export EXPECTED_VERSION="$RELEASE_VERSION"
export DEPLOY_HEALTH_TIMEOUT=30

if bash "$SCRIPT_DIR/run.sh" >"$ROOT/stdout" 2>"$ROOT/stderr"; then
  echo "deployment unexpectedly succeeded with an unhealthy private candidate" >&2
  exit 1
fi

[ "$(cat "$ROOT/app/data/cloudbox.db")" = pre-migration-v6 ] || {
  echo "pre-migration database was not restored" >&2
  exit 1
}
[ -f "$ROOT/state/container-aerie" ] && [ -f "$ROOT/state/running-aerie" ] || {
  echo "old container was not restored and restarted" >&2
  exit 1
}
grep -q '^create:aerie-candidate-.*:private:canary$' "$ROOT/state/events"
if grep -q '^create:aerie-candidate-.*:published:' "$ROOT/state/events"; then
  echo "rollbackable candidate published a host port" >&2
  exit 1
fi
disable_restart_line="$(grep -n '^update:aerie:no$' "$ROOT/state/events" | cut -d: -f1)"

snapshot_line="$(grep -n '^snapshot$' "$ROOT/state/events" | cut -d: -f1)"
candidate_line="$(grep -n '^start:aerie-candidate-' "$ROOT/state/events" | cut -d: -f1)"
restore_line="$(grep -n '^restore$' "$ROOT/state/events" | cut -d: -f1)"
old_start_line="$(grep -n '^start:aerie$' "$ROOT/state/events" | cut -d: -f1)"
[ "$snapshot_line" -lt "$candidate_line" ]
[ "$disable_restart_line" -lt "$candidate_line" ]
[ "$candidate_line" -lt "$restore_line" ]
[ "$restore_line" -lt "$old_start_line" ]
grep -q 'pre-migration database restored atomically' "$ROOT/stderr"
if grep -q '^old-started-before-restore$' "$ROOT/state/events"; then
  echo "old container observed the v7 database" >&2
  exit 1
fi
grep -q '^update:aerie-rollback-.*:unless-stopped$' "$ROOT/state/events"

SECOND="$ROOT/public-start"
mkdir -p "$SECOND/bin" "$SECOND/state" "$SECOND/app/data" "$SECOND/app/files" "$SECOND/app/downloads" "$SECOND/media"
ln -s "$SCRIPT_DIR/test/fake-docker.sh" "$SECOND/bin/docker"
printf 'pre-migration-v6\n' > "$SECOND/app/data/cloudbox.db"
printf 'old\n' > "$SECOND/state/container-aerie"
: > "$SECOND/state/running-aerie"
printf '2026-07-23T00:00:00.000000000Z\n' > "$SECOND/state/started-aerie"
printf 'unless-stopped\n' > "$SECOND/state/restart-aerie"

export PATH="$SECOND/bin:${PATH#*:}"
export FAKE_DOCKER_STATE="$SECOND/state"
export FAKE_DOCKER_FAIL_PRIVATE=0
export FAKE_DOCKER_FAIL_PUBLIC_START=before
export FAKE_LIVE_DB="$SECOND/app/data/cloudbox.db"
export APPDIR="$SECOND/app"
export MEDIA_DIR="$SECOND/media"

if bash "$SCRIPT_DIR/run.sh" >"$SECOND/stdout" 2>"$SECOND/stderr"; then
  echo "deployment unexpectedly succeeded when the stopped public container could not start" >&2
  exit 1
fi
[ "$(cat "$SECOND/app/data/cloudbox.db")" = pre-migration-v6 ]
[ -f "$SECOND/state/container-aerie" ] && [ -f "$SECOND/state/running-aerie" ]
grep -q '^create:aerie-candidate-.*:private:canary$' "$SECOND/state/events"
grep -q '^create:aerie:published:normal$' "$SECOND/state/events"
grep -q '^public-start-failed-before-started$' "$SECOND/state/events"
grep -q '^restore$' "$SECOND/state/events"
grep -q '^update:aerie-previous:unless-stopped$' "$SECOND/state/events"
if grep -q 'public exposure was committed' "$SECOND/stderr"; then
  echo "a never-started public container incorrectly disabled automatic rollback" >&2
  exit 1
fi

echo "database cutover rollback shell tests passed"
