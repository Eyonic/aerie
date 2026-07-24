#!/usr/bin/env bash
set -euo pipefail

STATE="${FAKE_DOCKER_STATE:?}"
mkdir -p "$STATE"

safe_name() {
  [[ "$1" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]*$ ]] || exit 90
}

event() { printf '%s\n' "$1" >> "$STATE/events"; }
container_file() { safe_name "$1"; printf '%s/container-%s' "$STATE" "$1"; }
running_file() { safe_name "$1"; printf '%s/running-%s' "$STATE" "$1"; }
started_file() { safe_name "$1"; printf '%s/started-%s' "$STATE" "$1"; }
restart_file() { safe_name "$1"; printf '%s/restart-%s' "$STATE" "$1"; }

command_name="${1:-}"
[ "$#" -gt 0 ] && shift
case "$command_name" in
  build)
    while [ "$#" -gt 0 ]; do
      if [ "$1" = --label ]; then
        case "$2" in
          org.opencontainers.image.version=*) printf '%s' "${2#*=}" > "$STATE/image-version" ;;
          org.aerie.source-id=*) printf '%s' "${2#*=}" > "$STATE/image-source" ;;
        esac
        shift 2
      else
        shift
      fi
    done
    event build
    ;;
  image)
    subcommand="${1:-}"; shift || true
    case "$subcommand" in
      inspect)
        format=''
        while [ "$#" -gt 0 ]; do
          if [ "$1" = --format ]; then format="$2"; shift 2; else shift; fi
        done
        case "$format" in
          *org.opencontainers.image.version*) cat "$STATE/image-version" ;;
          *org.aerie.source-id*) cat "$STATE/image-source" ;;
          *) exit 1 ;;
        esac
        ;;
      rm) event image-rm ;;
      *) exit 2 ;;
    esac
    ;;
  tag) event tag ;;
  container)
    [ "${1:-}" = inspect ] || exit 2
    name="${2:-}"; [ -f "$(container_file "$name")" ]
    ;;
  inspect)
    format=''
    if [ "${1:-}" = --format ]; then format="$2"; shift 2; fi
    name="${1:-}"
    [ -f "$(container_file "$name")" ] || exit 1
    if [[ "$format" == *'.HostConfig.RestartPolicy.Name'* ]]; then
      cat "$(restart_file "$name")"
    elif [[ "$format" == *'.HostConfig.RestartPolicy.MaximumRetryCount'* ]]; then
      printf '0\n'
    elif [[ "$format" == *'.State.StartedAt'* ]]; then
      if [ -f "$(started_file "$name")" ]; then cat "$(started_file "$name")"; else printf '0001-01-01T00:00:00Z\n'; fi
    elif [[ "$format" == *'.State.Running'* && "$format" != *'.State.Health'* ]]; then
      [ -f "$(running_file "$name")" ] && printf 'true\n' || printf 'false\n'
    elif [[ "$name" == aerie-candidate-* && "${FAKE_DOCKER_FAIL_PRIVATE:-0}" = 1 ]]; then
      printf 'unhealthy\n'
    else
      printf 'healthy\n'
    fi
    ;;
  create)
    name=''
    published=private
    canary=normal
    restart=no
    while [ "$#" -gt 0 ]; do
      case "$1" in
        --name) name="$2"; shift 2 ;;
        --restart) restart="$2"; shift 2 ;;
        -p|--publish) published=published; shift 2 ;;
        -e|--env)
          [ "$2" = AERIE_PRIVATE_CANARY=1 ] && canary=canary
          shift 2
          ;;
        *) shift ;;
      esac
    done
    safe_name "$name"
    printf 'created\n' > "$(container_file "$name")"
    printf '%s\n' "$restart" > "$(restart_file "$name")"
    event "create:$name:$published:$canary"
    ;;
  start)
    name="${1:-}"; [ -f "$(container_file "$name")" ]
    if [ "$name" = aerie ] && [ "$(cat "$(container_file "$name")")" = created ] \
      && [ "${FAKE_DOCKER_FAIL_PUBLIC_START:-}" = before ]; then
      event public-start-failed-before-started
      exit 1
    fi
    : > "$(running_file "$name")"
    printf '2026-07-24T00:00:00.000000000Z\n' > "$(started_file "$name")"
    event "start:$name"
    if [[ "$name" == aerie-candidate-* ]]; then
      printf 'candidate-v7\n' > "${FAKE_LIVE_DB:?}"
    elif [ "$name" = aerie ] && [ "$(cat "$(container_file "$name")")" = old ] \
      && [ "$(cat "${FAKE_LIVE_DB:?}")" != 'pre-migration-v6' ]; then
      event old-started-before-restore
      exit 88
    fi
    ;;
  stop)
    if [ "${1:-}" = --time ]; then shift 2; fi
    name="${1:-}"
    rm -f -- "$(running_file "$name")"
    event "stop:$name"
    ;;
  rename)
    old="${1:-}"; new="${2:-}"
    mv "$(container_file "$old")" "$(container_file "$new")"
    if [ -f "$(running_file "$old")" ]; then mv "$(running_file "$old")" "$(running_file "$new")"; fi
    if [ -f "$(started_file "$old")" ]; then mv "$(started_file "$old")" "$(started_file "$new")"; fi
    if [ -f "$(restart_file "$old")" ]; then mv "$(restart_file "$old")" "$(restart_file "$new")"; fi
    event "rename:$old:$new"
    ;;
  update)
    policy=''
    if [[ "${1:-}" == --restart=* ]]; then policy="${1#*=}"; shift; fi
    name="${1:-}"
    case "$policy" in on-failure:*) policy=on-failure ;; esac
    printf '%s\n' "$policy" > "$(restart_file "$name")"
    event "update:$name:$policy"
    ;;
  rm)
    [ "${1:-}" = -f ] && shift
    name="${1:-}"
    rm -f -- "$(container_file "$name")" "$(running_file "$name")" "$(started_file "$name")" "$(restart_file "$name")"
    event "rm:$name"
    ;;
  logs) exit 0 ;;
  exec) printf '%s' "${FAKE_EXPECTED_VERSION:-1.8.0}" ;;
  ps) exit 0 ;;
  run)
    live=''
    snapshot=''
    arguments=("$@")
    for ((index=0; index<${#arguments[@]}; index++)); do
      if [ "${arguments[$index]}" = -v ]; then
        mount="${arguments[$((index + 1))]}"
        case "$mount" in
          *:/live:*) live="${mount%%:/live:*}" ;;
          *:/snapshot:*) snapshot="${mount%%:/snapshot:*}" ;;
        esac
      fi
    done
    joined=" ${arguments[*]} "
    case "$joined" in
      *' dist/database-cutover.js snapshot '*)
        cp -- "$live/cloudbox.db" "$snapshot/cloudbox.db"
        printf '{"fake":true}\n' > "$snapshot/manifest.json"
        event snapshot
        ;;
      *' dist/database-cutover.js verify '*) event snapshot-verify ;;
      *' dist/database-cutover.js restore '*)
        cp -- "$snapshot/cloudbox.db" "$live/cloudbox.db"
        event restore
        ;;
      *' dist/migration-rehearsal.js '*) event rehearsal ;;
      *) event helper-run ;;
    esac
    ;;
  *)
    echo "unsupported fake docker command: $command_name $*" >&2
    exit 2
    ;;
esac
