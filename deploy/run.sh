#!/usr/bin/env bash
# Runs ON the Docker host. Builds a uniquely tagged candidate, stops the
# current container only after the build succeeds, and promotes an unpublished
# candidate only after Docker reports it healthy. A failed private cutover
# atomically restores both the pre-migration database and previous container.
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONF="$SCRIPT_DIR/deploy.conf"
if [ -f "$CONF" ]; then
  # shellcheck source=deploy.conf.example
  . "$CONF"
fi

die() { echo "ERROR: $*" >&2; exit 1; }

SRC="${SRC_DIR:-/root/aerie-src}"
APPDIR="${APPDIR:-/mnt/user/appdata/aerie}"
MEDIA_DIR="${MEDIA_DIR:-/mnt/user/Media}"
AERIE_UID="${AERIE_UID:-99}"
AERIE_GID="${AERIE_GID:-100}"
DEPLOY_HEALTH_TIMEOUT="${DEPLOY_HEALTH_TIMEOUT:-120}"
EXPECTED_VERSION="${EXPECTED_VERSION:-}"

command -v docker >/dev/null 2>&1 || die "docker is not installed or not on PATH"
command -v realpath >/dev/null 2>&1 || die "realpath is required for safe path validation"
command -v sha256sum >/dev/null 2>&1 || die "sha256sum is required for source identity"
command -v stat >/dev/null 2>&1 || die "stat is required for rollback ownership preservation"
APPDIR="$(realpath -m -- "$APPDIR")"
[ -d "$SRC" ] || die "source directory does not exist: $SRC"
[ -d "$MEDIA_DIR" ] || die "media directory does not exist: $MEDIA_DIR"
SRC="$(realpath -e -- "$SRC")"
MEDIA_DIR="$(realpath -e -- "$MEDIA_DIR")"
case "$APPDIR" in
  ""|/|/bin|/boot|/data|/dev|/etc|/files|/home|/lib|/lib32|/lib64|/mnt|/mnt/user|/mnt/user/appdata|/opt|/proc|/root|/run|/sbin|/srv|/sys|/tmp|/usr|/var)
    die "refusing unsafe APPDIR: $APPDIR"
    ;;
esac
case "$APPDIR/" in
  "$MEDIA_DIR/"*|"$SRC/"*) die "APPDIR must not be inside MEDIA_DIR or SRC_DIR: $APPDIR" ;;
esac
case "$AERIE_UID:$AERIE_GID" in
  *[!0-9:]*|0:*|*:0|:*) die "AERIE_UID and AERIE_GID must be non-zero numeric IDs" ;;
esac
case "$DEPLOY_HEALTH_TIMEOUT" in
  *[!0-9]*|"") die "DEPLOY_HEALTH_TIMEOUT must be a number of seconds" ;;
esac
[ "$DEPLOY_HEALTH_TIMEOUT" -ge 30 ] || die "DEPLOY_HEALTH_TIMEOUT must be at least 30 seconds"

# Refuse a stale or mixed source tree before generating live configuration or
# asking Docker to build. The source hash labels the exact server/web inputs.
[ -f "$SRC/deploy/release-guard.sh" ] || die "release guard is missing from source: $SRC"
# shellcheck source=release-guard.sh
. "$SRC/deploy/release-guard.sh"
aerie_require_release_versions "$SRC" "$EXPECTED_VERSION" || die "release source version guard failed"
SOURCE_ID="$(aerie_source_identity "$SRC")"
[[ "$SOURCE_ID" =~ ^[a-f0-9]{64}$ ]] || die "release source identity is invalid"

# ---- One-time migration from CloudBox (the app's former name) --------------
# Keep the old env file's contents (especially JWT_SECRET) so existing sessions
# survive the rename.
if [ ! -f "$APPDIR/aerie.env" ] && [ -f "$APPDIR/cloudbox.env" ]; then
  echo ">> migrating legacy cloudbox.env -> aerie.env"
  mv "$APPDIR/cloudbox.env" "$APPDIR/aerie.env"
fi

echo ">> generating env (secrets stay on server)"
# Use the repo copy: a stale local gen-env.sh can silently omit new variables.
bash "$SRC/deploy/gen-env.sh"

BUILD_ID="$(date -u +%Y%m%d%H%M%S)-$$"
CANDIDATE_IMAGE="aerie:deploy-$BUILD_ID"
CANDIDATE_CONTAINER="aerie-candidate-$BUILD_ID"
ROLLBACK_CONTAINER="aerie-rollback-$BUILD_ID"
ORIGINAL_CONTAINER=""
ORIGINAL_WAS_RUNNING=0
ORIGINAL_RESTART_POLICY=""
ORIGINAL_RESTART_RETRIES=0
RESTART_POLICY_NEUTERED=0
CUTOVER_STARTED=0
ROLLBACK_READY=0
PUBLIC_CONTAINER_CREATED=0
DB_MUTATION_STARTED=0
DB_SNAPSHOT_READY=0
DB_SNAPSHOT_DIR=""
DB_SNAPSHOT_FILE=""
DB_SNAPSHOT_MANIFEST=""
DB_ORIGINAL_UID=""
DB_ORIGINAL_GID=""
DB_ORIGINAL_MODE=""
EXPOSURE_ATTEMPTED=0
COMMITTED=0
MIGRATION_PREFLIGHT_DIR=""

cleanup_migration_preflight() {
  [ -n "$MIGRATION_PREFLIGHT_DIR" ] || return 0
  case "$MIGRATION_PREFLIGHT_DIR" in
    "$APPDIR"/.aerie-migration-preflight.*)
      rm -rf -- "$MIGRATION_PREFLIGHT_DIR"
      MIGRATION_PREFLIGHT_DIR=""
      ;;
    *)
      echo ">> refusing unexpected migration preflight cleanup path: $MIGRATION_PREFLIGHT_DIR" >&2
      ;;
  esac
}

cleanup_database_snapshot() {
  [ -n "$DB_SNAPSHOT_DIR" ] || return 0
  case "$DB_SNAPSHOT_DIR" in
    "$APPDIR"/.aerie-db-rollback.*)
      rm -rf -- "$DB_SNAPSHOT_DIR"
      DB_SNAPSHOT_DIR=""
      DB_SNAPSHOT_FILE=""
      DB_SNAPSHOT_MANIFEST=""
      DB_SNAPSHOT_READY=0
      ;;
    *)
      echo ">> refusing unexpected database snapshot cleanup path: $DB_SNAPSHOT_DIR" >&2
      return 1
      ;;
  esac
}

container_exists() {
  docker container inspect "$1" >/dev/null 2>&1
}

restore_original_restart_policy() {
  local name="$1"
  local policy
  [ "$RESTART_POLICY_NEUTERED" -eq 1 ] || return 0
  policy="$ORIGINAL_RESTART_POLICY"
  if [ "$policy" = on-failure ] && [ "$ORIGINAL_RESTART_RETRIES" -gt 0 ]; then
    policy="on-failure:$ORIGINAL_RESTART_RETRIES"
  fi
  docker update --restart="$policy" "$name" >/dev/null
  RESTART_POLICY_NEUTERED=0
}

public_container_has_started() {
  local started_at
  started_at="$(docker inspect --format '{{.State.StartedAt}}' aerie 2>/dev/null || true)"
  case "$started_at" in
    ""|0001-01-01T00:00:00Z|0001-01-01T00:00:00.000000000Z) return 1 ;;
    *) return 0 ;;
  esac
}

run_cutover_snapshot() {
  docker run --rm \
    --user "$DB_ORIGINAL_UID:$DB_ORIGINAL_GID" \
    --network none \
    --read-only \
    --tmpfs /tmp:rw,nosuid,nodev,noexec,size=64m,mode=1777 \
    --cap-drop ALL \
    --security-opt no-new-privileges:true \
    -v "$APPDIR/data:/live:ro" \
    -v "$DB_SNAPSHOT_DIR:/snapshot:rw" \
    "$CANDIDATE_IMAGE" node dist/database-cutover.js snapshot \
      /live/cloudbox.db /snapshot/cloudbox.db /snapshot/manifest.json
  docker run --rm \
    --user "$DB_ORIGINAL_UID:$DB_ORIGINAL_GID" \
    --network none \
    --read-only \
    --tmpfs /tmp:rw,nosuid,nodev,noexec,size=64m,mode=1777 \
    --cap-drop ALL \
    --security-opt no-new-privileges:true \
    -v "$DB_SNAPSHOT_DIR:/snapshot:ro" \
    "$CANDIDATE_IMAGE" node dist/database-cutover.js verify \
      /snapshot/cloudbox.db /snapshot/manifest.json
}

restore_cutover_snapshot() {
  docker run --rm \
    --user "$AERIE_UID:$AERIE_GID" \
    --network none \
    --read-only \
    --tmpfs /tmp:rw,nosuid,nodev,noexec,size=64m,mode=1777 \
    --cap-drop ALL \
    --security-opt no-new-privileges:true \
    -v "$APPDIR/data:/live:rw" \
    -v "$DB_SNAPSHOT_DIR:/snapshot:ro" \
    "$CANDIDATE_IMAGE" node dist/database-cutover.js restore \
      /snapshot/cloudbox.db /snapshot/manifest.json /live/cloudbox.db
  chown "$DB_ORIGINAL_UID:$DB_ORIGINAL_GID" "$APPDIR/data/cloudbox.db"
  chmod "$DB_ORIGINAL_MODE" "$APPDIR/data/cloudbox.db"
}

create_application_container() {
  local name="$1"
  local publish="$2"
  local restart_policy="$3"
  local private_canary="$4"
  local -a publish_args=()
  local -a canary_args=()
  if [ "$publish" -eq 1 ]; then publish_args=(-p 8200:8200); fi
  if [ "$private_canary" -eq 1 ]; then canary_args=(-e AERIE_PRIVATE_CANARY=1); fi
  docker create --name "$name" --restart "$restart_policy" \
    --label "org.aerie.deploy-id=$BUILD_ID" \
    --label "org.opencontainers.image.version=$EXPECTED_VERSION" \
    --label "org.aerie.source-id=$SOURCE_ID" \
    --user "$AERIE_UID:$AERIE_GID" \
    --read-only \
    --tmpfs /tmp:rw,nosuid,nodev,noexec,size=256m,mode=1777 \
    --cap-drop ALL \
    --security-opt no-new-privileges:true \
    --pids-limit 512 \
    --stop-timeout 30 \
    --log-opt max-size=10m \
    --log-opt max-file=3 \
    --health-interval 5s \
    --health-timeout 5s \
    --health-start-period "${DEPLOY_HEALTH_TIMEOUT}s" \
    --health-retries 3 \
    "${publish_args[@]}" \
    "${canary_args[@]}" \
    --env-file "$APPDIR/aerie.env" \
    -v "$APPDIR/data:/data:rw" \
    -v "$APPDIR/files:/files:rw" \
    -v "$APPDIR/downloads:/downloads:rw" \
    -v "$MEDIA_DIR:/media:ro" \
    "$CANDIDATE_IMAGE"
}

wait_for_healthy() {
  local name="$1"
  local deadline health
  echo ">> waiting up to ${DEPLOY_HEALTH_TIMEOUT}s for $name to become healthy"
  deadline=$((SECONDS + DEPLOY_HEALTH_TIMEOUT))
  health=starting
  while [ "$SECONDS" -lt "$deadline" ]; do
    health="$(docker inspect --format '{{if not .State.Running}}{{.State.Status}}{{else if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$name" 2>/dev/null || echo missing)"
    case "$health" in
      healthy) break ;;
      unhealthy|exited|dead|missing) die "$name entered terminal state: $health" ;;
    esac
    sleep 2
  done
  [ "$health" = healthy ] || die "$name did not become healthy (last state: $health)"
}

verify_container_version() {
  local name="$1"
  local expected_canary="$2"
  local reported
  if ! reported="$(docker exec "$name" node -e '
    const expectedCanary = process.argv[1] === "1";
    fetch("http://127.0.0.1:" + (process.env.PORT || "8200") + "/api/health")
      .then(async response => {
        const body = await response.json();
        if (!response.ok || body.ok !== true || typeof body.version !== "string"
          || body.privateCanary !== expectedCanary) process.exit(1);
        process.stdout.write(body.version);
      })
      .catch(() => process.exit(1));
  ' "$expected_canary")"; then
    die "$name version/private-canary health check failed"
  fi
  aerie_require_candidate_version "$reported" "$EXPECTED_VERSION" \
    || die "$name health version guard failed"
}

rollback_on_exit() {
  local status=$?
  trap - EXIT INT TERM
  cleanup_migration_preflight
  if [ "$COMMITTED" -eq 0 ] && [ "$EXPOSURE_ATTEMPTED" -eq 1 ] \
    && container_exists aerie && public_container_has_started; then
    # docker start may have reached the daemon even if its client was
    # interrupted. Once StartedAt is non-zero, preserve possible user writes.
    COMMITTED=1
  fi
  if [ "$COMMITTED" -eq 1 ]; then
    if [ "$status" -ne 0 ]; then
      echo ">> public exposure was committed; automatic database rollback is disabled to avoid discarding user writes" >&2
      if [ "$DB_SNAPSHOT_READY" -eq 1 ]; then
        echo ">> verified pre-migration snapshot retained for operator recovery: $DB_SNAPSHOT_DIR" >&2
      fi
    fi
    exit "$status"
  fi
  if [ "$CUTOVER_STARTED" -eq 0 ]; then
    cleanup_database_snapshot
    docker image rm "$CANDIDATE_IMAGE" >/dev/null 2>&1 || true
    exit "$status"
  fi

  set +e
  echo ">> deployment failed; rolling back" >&2
  if container_exists "$CANDIDATE_CONTAINER"; then
    docker logs --tail 80 "$CANDIDATE_CONTAINER" >&2 2>/dev/null
    docker rm -f "$CANDIDATE_CONTAINER" >/dev/null 2>&1
  fi
  if [ "$PUBLIC_CONTAINER_CREATED" -eq 1 ] && container_exists aerie; then
    docker rm -f aerie >/dev/null 2>&1
  fi

  if [ "$DB_MUTATION_STARTED" -eq 1 ] && [ -n "$ORIGINAL_CONTAINER" ]; then
    if [ "$DB_SNAPSHOT_READY" -ne 1 ]; then
      echo ">> database may have been mutated but no verified rollback snapshot is available; old container remains stopped" >&2
      exit 1
    fi
    echo ">> restoring verified pre-migration database snapshot" >&2
    if ! restore_cutover_snapshot; then
      echo ">> database restore failed; old container remains stopped and snapshot is retained at $DB_SNAPSHOT_DIR" >&2
      exit 1
    fi
    echo ">> pre-migration database restored atomically" >&2
  fi

  if [ "$ROLLBACK_READY" -eq 1 ]; then
    local rollback_source="$ROLLBACK_CONTAINER"
    if ! container_exists "$rollback_source" && container_exists aerie-previous; then
      rollback_source=aerie-previous
    fi
    if ! container_exists "$rollback_source"; then
      echo ">> previous container could not be found for rollback" >&2
      exit "$status"
    fi
    if ! restore_original_restart_policy "$rollback_source"; then
      echo ">> previous restart policy could not be restored; old container remains stopped" >&2
      exit 1
    fi
    if ! docker rename "$rollback_source" "$ORIGINAL_CONTAINER" >/dev/null; then
      echo ">> previous container could not be renamed for rollback; snapshot is retained" >&2
      exit 1
    fi
    if [ "$ORIGINAL_WAS_RUNNING" -eq 1 ]; then
      if ! docker start "$ORIGINAL_CONTAINER" >/dev/null; then
        echo ">> previous container could not be restarted; restored database and snapshot are retained" >&2
        exit 1
      fi
      echo ">> restored previous container: $ORIGINAL_CONTAINER" >&2
    else
      echo ">> restored previous stopped container: $ORIGINAL_CONTAINER" >&2
    fi
  elif [ -n "$ORIGINAL_CONTAINER" ] && container_exists "$ORIGINAL_CONTAINER"; then
    # The cutover may have failed between stopping and renaming the old
    # container. In that narrow window it is still available under its
    # original name.
    if ! restore_original_restart_policy "$ORIGINAL_CONTAINER"; then
      echo ">> previous restart policy could not be restored; old container remains stopped" >&2
      exit 1
    fi
    if [ "$ORIGINAL_WAS_RUNNING" -eq 1 ]; then
      if ! docker start "$ORIGINAL_CONTAINER" >/dev/null; then
        echo ">> previous container could not be restarted; snapshot is retained" >&2
        exit 1
      fi
      echo ">> restarted previous container: $ORIGINAL_CONTAINER" >&2
    fi
  fi
  cleanup_database_snapshot
  docker image rm "$CANDIDATE_IMAGE" >/dev/null 2>&1 || true
  exit "$status"
}
trap rollback_on_exit EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

echo ">> building candidate image $CANDIDATE_IMAGE"
docker build --target runtime \
  --label "org.opencontainers.image.version=$EXPECTED_VERSION" \
  --label "org.aerie.source-id=$SOURCE_ID" \
  --tag "$CANDIDATE_IMAGE" "$SRC"
IMAGE_VERSION="$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.version"}}' "$CANDIDATE_IMAGE")"
IMAGE_SOURCE_ID="$(docker image inspect --format '{{index .Config.Labels "org.aerie.source-id"}}' "$CANDIDATE_IMAGE")"
[ "$IMAGE_VERSION" = "$EXPECTED_VERSION" ] || die "candidate image version label mismatch"
[ "$IMAGE_SOURCE_ID" = "$SOURCE_ID" ] || die "candidate image source label mismatch"

# Exercise the candidate's real schema/startup path against a SQLite online
# backup while the current service is still running. The isolated copy includes
# committed WAL pages and cannot mutate live metadata or user files.
if [ -f "$APPDIR/data/cloudbox.db" ]; then
  echo ">> rehearsing database migrations on an isolated copy"
  MIGRATION_PREFLIGHT_DIR="$(mktemp -d "$APPDIR/.aerie-migration-preflight.XXXXXX")"
  chown "$AERIE_UID:$AERIE_GID" "$MIGRATION_PREFLIGHT_DIR"
  docker run --rm \
    --user "$AERIE_UID:$AERIE_GID" \
    --network none \
    --read-only \
    --tmpfs /tmp:rw,nosuid,nodev,noexec,size=64m,mode=1777 \
    --cap-drop ALL \
    --security-opt no-new-privileges:true \
    -e AERIE_MIGRATION_SOURCE=/live/cloudbox.db \
    -e AERIE_MIGRATION_STAGE=/preflight \
    -v "$APPDIR/data:/live:ro" \
    -v "$MIGRATION_PREFLIGHT_DIR:/preflight:rw" \
    "$CANDIDATE_IMAGE" node dist/migration-rehearsal.js
  cleanup_migration_preflight
fi

# Prefer the current Aerie container. During the one-time rename migration, a
# legacy CloudBox container is also eligible for automatic rollback.
if container_exists aerie; then
  ORIGINAL_CONTAINER=aerie
elif container_exists cloudbox; then
  ORIGINAL_CONTAINER=cloudbox
fi

if [ -n "$ORIGINAL_CONTAINER" ]; then
  CUTOVER_STARTED=1
  ORIGINAL_RESTART_POLICY="$(docker inspect --format '{{.HostConfig.RestartPolicy.Name}}' "$ORIGINAL_CONTAINER")"
  ORIGINAL_RESTART_RETRIES="$(docker inspect --format '{{.HostConfig.RestartPolicy.MaximumRetryCount}}' "$ORIGINAL_CONTAINER")"
  case "$ORIGINAL_RESTART_POLICY" in
    no|always|unless-stopped|on-failure) ;;
    *) die "unsupported previous restart policy: $ORIGINAL_RESTART_POLICY" ;;
  esac
  case "$ORIGINAL_RESTART_RETRIES" in
    ""|*[!0-9]*) die "previous restart retry count is invalid" ;;
  esac
  if [ "$(docker inspect --format '{{.State.Running}}' "$ORIGINAL_CONTAINER")" = true ]; then
    ORIGINAL_WAS_RUNNING=1
    echo ">> stopping current container: $ORIGINAL_CONTAINER"
    docker stop --time 30 "$ORIGINAL_CONTAINER" >/dev/null
  fi
  # A daemon restart must never revive the previous release against a database
  # that the private candidate may already have migrated.
  RESTART_POLICY_NEUTERED=1
  docker update --restart=no "$ORIGINAL_CONTAINER" >/dev/null
  [ -f "$APPDIR/data/cloudbox.db" ] || die "current container has no rollbackable database at $APPDIR/data/cloudbox.db"
  [ ! -L "$APPDIR/data/cloudbox.db" ] || die "refusing symlink database at $APPDIR/data/cloudbox.db"
  DB_ORIGINAL_UID="$(stat -c '%u' "$APPDIR/data/cloudbox.db")"
  DB_ORIGINAL_GID="$(stat -c '%g' "$APPDIR/data/cloudbox.db")"
  DB_ORIGINAL_MODE="$(stat -c '%a' "$APPDIR/data/cloudbox.db")"
  case "$DB_ORIGINAL_UID:$DB_ORIGINAL_GID:$DB_ORIGINAL_MODE" in
    *[!0-9:]*) die "database ownership metadata is invalid" ;;
  esac
  DB_SNAPSHOT_DIR="$APPDIR/.aerie-db-rollback.$BUILD_ID"
  DB_SNAPSHOT_FILE="$DB_SNAPSHOT_DIR/cloudbox.db"
  DB_SNAPSHOT_MANIFEST="$DB_SNAPSHOT_DIR/manifest.json"
  (umask 077; mkdir "$DB_SNAPSHOT_DIR")
  chown "$DB_ORIGINAL_UID:$DB_ORIGINAL_GID" "$DB_SNAPSHOT_DIR"
  echo ">> capturing WAL-consistent pre-migration database snapshot"
  run_cutover_snapshot
  [ -s "$DB_SNAPSHOT_FILE" ] && [ -s "$DB_SNAPSHOT_MANIFEST" ] \
    || die "verified database snapshot was not created"
  DB_SNAPSHOT_READY=1
  # Candidate and restore helper both run as Aerie's unprivileged account.
  chown -R "$AERIE_UID:$AERIE_GID" "$DB_SNAPSHOT_DIR"
  docker rename "$ORIGINAL_CONTAINER" "$ROLLBACK_CONTAINER"
  ROLLBACK_READY=1
fi
CUTOVER_STARTED=1

# The image runs without root. Migrate Aerie-owned state only after the old
# process is stopped, preventing it from creating new root-owned files during
# the ownership pass. MEDIA_DIR is deliberately excluded and stays read-only.
mkdir -p "$APPDIR/data" "$APPDIR/files" "$APPDIR/downloads"
echo ">> ensuring app state belongs to uid:gid $AERIE_UID:$AERIE_GID"
chown -R "$AERIE_UID:$AERIE_GID" \
  "$APPDIR/data" "$APPDIR/files" "$APPDIR/downloads"

echo ">> starting private candidate with no published host port"
create_application_container "$CANDIDATE_CONTAINER" 0 no 1 >/dev/null
DB_MUTATION_STARTED=1
docker start "$CANDIDATE_CONTAINER" >/dev/null
wait_for_healthy "$CANDIDATE_CONTAINER"
verify_container_version "$CANDIDATE_CONTAINER" 1

# Create, but do not start, the public container while rollback is still safe.
# Docker does not publish its port until `docker start` below.
echo ">> preparing stopped public container"
create_application_container aerie 1 unless-stopped 0 >/dev/null
PUBLIC_CONTAINER_CREATED=1

# Stop the private instance cleanly so every WAL frame is closed before the
# exact same image/env/mount set is exposed. Any failure through this point
# restores the verified pre-deployment snapshot before restarting the previous
# container.
docker stop --time 30 "$CANDIDATE_CONTAINER" >/dev/null
docker rm "$CANDIDATE_CONTAINER" >/dev/null

docker tag "$CANDIDATE_IMAGE" aerie:latest
if [ "$ROLLBACK_READY" -eq 1 ]; then
  if container_exists aerie-previous; then
    docker rm -f aerie-previous >/dev/null
  fi
  docker rename "$ROLLBACK_CONTAINER" aerie-previous
fi

# This is the write-preservation boundary. Starting `aerie` activates the host
# port and can admit user writes. If the start command fails before Docker sets
# StartedAt, rollback is still automatic; after StartedAt, possible writes win
# and the verified snapshot is retained for an operator decision.
echo ">> exposing health-verified candidate on host port 8200"
EXPOSURE_ATTEMPTED=1
if ! docker start aerie >/dev/null; then
  if public_container_has_started; then COMMITTED=1; fi
  die "public container failed to start"
fi
COMMITTED=1
wait_for_healthy aerie
verify_container_version aerie 0

cleanup_database_snapshot
docker image rm "$CANDIDATE_IMAGE" >/dev/null 2>&1 || true

echo ">> deploy healthy; promoted $CANDIDATE_IMAGE to aerie:latest"
docker ps --filter name='^/aerie$' --format '  {{.Names}}  {{.Status}}  {{.Image}}'
docker logs --tail 20 aerie 2>&1 || true
