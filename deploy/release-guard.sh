#!/usr/bin/env bash
# Shared, side-effect-free release validation used by deploy/run.sh and its
# shell tests. This file may be sourced; its CLI prints only non-secret release
# identity data.

aerie_package_version() {
  local package_file="$1"
  local line value=""
  [ -f "$package_file" ] && [ ! -L "$package_file" ] || {
    echo "release package is missing or unsafe: $package_file" >&2
    return 1
  }
  while IFS= read -r line; do
    if [[ "$line" =~ \"version\"[[:space:]]*:[[:space:]]*\"([^\"]+)\" ]]; then
      value="${BASH_REMATCH[1]}"
      break
    fi
  done < "$package_file"
  [ -n "$value" ] || { echo "release version missing: $package_file" >&2; return 1; }
  echo "$value"
}

aerie_require_release_versions() {
  local source_dir="$1"
  local expected="$2"
  local component actual
  [[ "$expected" =~ ^[0-9]+(\.[0-9]+){1,3}([-+][0-9A-Za-z.-]+)?$ ]] || {
    echo "EXPECTED_VERSION must be an explicit release version" >&2
    return 1
  }
  for component in \
    server/package.json server/package-lock.json \
    web/package.json web/package-lock.json \
    apps/desktop/package.json apps/desktop/package-lock.json
  do
    actual="$(aerie_package_version "$source_dir/$component")" || return 1
    [ "$actual" = "$expected" ] || {
      echo "release version mismatch: $component is $actual, expected $expected" >&2
      return 1
    }
  done
}

aerie_require_candidate_version() {
  local actual="$1"
  local expected="$2"
  [ "$actual" = "$expected" ] || {
    echo "candidate reports version ${actual:-missing}, expected $expected" >&2
    return 1
  }
}

aerie_source_identity() {
  local source_dir="$1"
  command -v sha256sum >/dev/null 2>&1 || { echo "sha256sum is required" >&2; return 1; }
  [ -f "$source_dir/Dockerfile" ] || { echo "Dockerfile is missing from release source" >&2; return 1; }
  (
    cd "$source_dir"
    find .dockerignore Dockerfile server web apps/desktop/release-signature.js apps/desktop/release-key.json -type f \
      ! -path '*/node_modules/*' \
      ! -path '*/dist/*' \
      ! -name '*.log' \
      -print0 \
      | LC_ALL=C sort -z \
      | while IFS= read -r -d '' file; do sha256sum "$file"; done \
      | sha256sum \
      | cut -d' ' -f1
  )
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  set -euo pipefail
  [ "$#" -eq 3 ] && [ "$1" = verify ] || {
    echo "usage: release-guard.sh verify SOURCE_DIR EXPECTED_VERSION" >&2
    exit 2
  }
  aerie_require_release_versions "$2" "$3"
  identity="$(aerie_source_identity "$2")"
  [[ "$identity" =~ ^[a-f0-9]{64}$ ]] || { echo "invalid source identity" >&2; exit 1; }
  echo "$3|$identity"
fi
