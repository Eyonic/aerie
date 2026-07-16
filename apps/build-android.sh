#!/usr/bin/env bash
# Build the Aerie Android app (debug-signed APK).
#
# Usage:
#   ./build-android.sh                                        # generic build, user enters their server on first run
#   AERIE_DEFAULT_URL=https://cloud.example.com \
#   AERIE_LAN_URL=http://192.0.2.10:8200 ./build-android.sh   # bake in your server(s) as defaults
#
# Run from the apps/ directory. Requires Docker. The artifact lands in
# android/app/build/outputs/apk/debug/app-debug.apk.
set -euo pipefail

cd "$(dirname "$0")"

# Keep Gradle's debug keystore outside the disposable build container. Without
# this mount every build gets a new signing certificate and Android refuses to
# install the APK as an update. Override the directory for CI if desired.
SIGNING_DIR="${AERIE_ANDROID_SIGNING_DIR:-$PWD/android/.signing}"
mkdir -p "$SIGNING_DIR"
chmod 700 "$SIGNING_DIR"

docker run --rm \
  -e AERIE_DEFAULT_URL \
  -e AERIE_LAN_URL \
  -v "$PWD/android:/project" \
  -v "$SIGNING_DIR:/root/.android" \
  -w /project \
  gradle:8.7-jdk17 \
  bash -c '
    set -euo pipefail
    export ANDROID_HOME=/opt/android-sdk
    export ANDROID_SDK_ROOT="$ANDROID_HOME"

    # The gradle image ships without the Android SDK — install the command-line
    # tools, then the platform/build-tools the project needs (compileSdk 34).
    command -v unzip >/dev/null 2>&1 || { apt-get update && apt-get install -y --no-install-recommends unzip; }
    mkdir -p "$ANDROID_HOME/cmdline-tools"
    curl -fsSL -o /tmp/cmdline-tools.zip \
      https://dl.google.com/android/repository/commandlinetools-linux-11076708_latest.zip
    unzip -q /tmp/cmdline-tools.zip -d "$ANDROID_HOME/cmdline-tools"
    mv "$ANDROID_HOME/cmdline-tools/cmdline-tools" "$ANDROID_HOME/cmdline-tools/latest"
    SDKMANAGER="$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager"

    ( yes || true ) | "$SDKMANAGER" --licenses > /dev/null
    "$SDKMANAGER" "platform-tools" "platforms;android-34" "build-tools;34.0.0" > /dev/null

    gradle --no-daemon assembleDebug \
      -PaerieDefaultUrl="${AERIE_DEFAULT_URL:-}" \
      -PaerieLanUrl="${AERIE_LAN_URL:-}"
  '

echo "APK: $PWD/android/app/build/outputs/apk/debug/app-debug.apk"
