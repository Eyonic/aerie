#!/usr/bin/env bash
# Build the Aerie Android app as a non-debuggable, update-signed release APK.
#
# Usage:
#   ./build-android.sh                                        # generic build, user enters their server on first run
#   AERIE_DEFAULT_URL=https://cloud.example.com \
#   AERIE_LAN_URL=http://192.0.2.10:8200 ./build-android.sh   # bake in your server(s) as defaults
#
# Run from the apps/ directory. Requires Docker. The artifact lands in
# android/app/build/outputs/apk/release/app-release.apk.
set -euo pipefail

cd "$(dirname "$0")"

# Keep the update identity outside the disposable build container. Existing
# installs were signed with the persisted debug keystore, so migrate those exact
# bytes instead of rotating the certificate and breaking in-place upgrades.
SIGNING_DIR="${AERIE_ANDROID_SIGNING_DIR:-$PWD/android/.signing}"
mkdir -p "$SIGNING_DIR"
chmod 700 "$SIGNING_DIR"
if [ ! -f "$SIGNING_DIR/aerie-update.keystore" ] && [ -f "$SIGNING_DIR/debug.keystore" ]; then
  cp -p "$SIGNING_DIR/debug.keystore" "$SIGNING_DIR/aerie-update.keystore"
fi

docker run --rm \
  -e AERIE_DEFAULT_URL \
  -e AERIE_LAN_URL \
  -e AERIE_RELEASE_STORE_FILE=/signing/aerie-update.keystore \
  -e AERIE_RELEASE_STORE_PASSWORD="${AERIE_ANDROID_STORE_PASSWORD:-android}" \
  -e AERIE_RELEASE_KEY_ALIAS="${AERIE_ANDROID_KEY_ALIAS:-androiddebugkey}" \
  -e AERIE_RELEASE_KEY_PASSWORD="${AERIE_ANDROID_KEY_PASSWORD:-android}" \
  -v "$PWD/android:/project" \
  -v "$SIGNING_DIR:/signing" \
  -w /project \
  gradle:8.11.1-jdk17 \
  bash -c '
    set -euo pipefail
    export ANDROID_HOME=/opt/android-sdk
    export ANDROID_SDK_ROOT="$ANDROID_HOME"

    # The gradle image ships without the Android SDK — install the command-line
    # tools, then the platform/build-tools the project needs (compileSdk 36).
    command -v unzip >/dev/null 2>&1 || { apt-get update && apt-get install -y --no-install-recommends unzip; }
    mkdir -p "$ANDROID_HOME/cmdline-tools"
    curl -fsSL -o /tmp/cmdline-tools.zip \
      https://dl.google.com/android/repository/commandlinetools-linux-11076708_latest.zip
    unzip -q /tmp/cmdline-tools.zip -d "$ANDROID_HOME/cmdline-tools"
    mv "$ANDROID_HOME/cmdline-tools/cmdline-tools" "$ANDROID_HOME/cmdline-tools/latest"
    SDKMANAGER="$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager"

    ( yes || true ) | "$SDKMANAGER" --licenses > /dev/null
    "$SDKMANAGER" "platform-tools" "platforms;android-36" "build-tools;35.0.0" > /dev/null

    if [ ! -f "$AERIE_RELEASE_STORE_FILE" ]; then
      keytool -genkeypair -v \
        -keystore "$AERIE_RELEASE_STORE_FILE" \
        -storepass "$AERIE_RELEASE_STORE_PASSWORD" \
        -alias "$AERIE_RELEASE_KEY_ALIAS" \
        -keypass "$AERIE_RELEASE_KEY_PASSWORD" \
        -keyalg RSA -keysize 2048 -validity 10000 \
        -dname "CN=Aerie Local Update, OU=Self Hosted, O=Aerie, C=NL" > /dev/null
      chmod 600 "$AERIE_RELEASE_STORE_FILE"
    fi

    gradle --no-daemon testDebugUnitTest lintRelease \
      -PaerieDefaultUrl="${AERIE_DEFAULT_URL:-}" \
      -PaerieLanUrl="${AERIE_LAN_URL:-}"

    gradle --no-daemon assembleRelease \
      -PaerieDefaultUrl="${AERIE_DEFAULT_URL:-}" \
      -PaerieLanUrl="${AERIE_LAN_URL:-}"

    APK=/project/app/build/outputs/apk/release/app-release.apk
    APKSIGNER="$ANDROID_HOME/build-tools/35.0.0/apksigner"
    "$APKSIGNER" verify --verbose "$APK"
    "$APKSIGNER" verify --print-certs "$APK" \
      | awk -F": " "/certificate SHA-256 digest/{print \$2; exit}" \
      > /project/app/build/outputs/apk/release/certificate-sha256.txt
    test -s /project/app/build/outputs/apk/release/certificate-sha256.txt
  '

# Generate the checksum/version sidecar consumed by the Get Apps catalogue.
docker run --rm \
  --network none \
  --read-only \
  --tmpfs /tmp:rw,nosuid,nodev,noexec,size=32m,mode=1777 \
  -v "$PWD/..:/workspace:ro" \
  -v "$PWD/android/app/build/outputs/apk/release:/artifacts:rw" \
  -w /workspace/apps \
  node:22-alpine \
  sh -c 'node --test test/release-sidecars.test.mjs && exec node write-release-sidecars.mjs "$@"' \
  release-writer --target android --artifacts-dir /artifacts

echo "APK: $PWD/android/app/build/outputs/apk/release/app-release.apk"
echo "Metadata: $PWD/android/app/build/outputs/apk/release/app-release.apk.release.json"
