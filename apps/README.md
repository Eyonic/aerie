# Aerie native apps

Native clients around the Aerie web app and shared server APIs:

- `desktop/` — hardened Electron app, trusted-device identity, signed self-updates, two-way Sync Fabric and encrypted LAN Mesh (Linux AppImage/deb, Windows installer)
- `android/` — WebView UI plus native two-way sync, Android Auto audio, Android DocumentsProvider and OS-keystore identity (update-signed release APK)

Both are generic out of the box: they ship with **no server address** and ask the
user for one on first run. If you self-host Aerie you can bake your own
server address in at build time so your users never see the prompt.

## Prerequisites

Docker. Nothing else — both build scripts run entirely inside containers.

## Desktop

```sh
cd apps

# Generic local/manual build (first run shows the connection screen):
./build-desktop.sh

# Build with your server pre-configured:
AERIE_DEFAULT_URL=https://cloud.example.com ./build-desktop.sh

# Official publishable build: unsigned output is rejected.
AERIE_DEFAULT_URL=https://cloud.example.com \
AERIE_RELEASE_MODE=publish \
AERIE_RELEASE_SIGNING_KEY=/secure/path/release-ed25519-private.pem \
./build-desktop.sh
```

The script writes `desktop/default-server.json` (`{"url": ""}` when the env var
is unset), runs the desktop test suite, and builds inside a new isolated output
directory. It validates the three exact versioned artifacts before atomically
replacing `desktop/release`, so an installer left by an older build cannot be
re-labelled as the current release.

Artifacts land in `apps/desktop/release/`:

- `Aerie-<version>.AppImage`
- `aerie_<version>_amd64.deb`
- `Aerie-Setup-<version>.exe` (NSIS installer)

Each artifact also gets an adjacent `.release.json` sidecar. The default
`local` mode permits unsigned checksum metadata for manual testing only; it is
not accepted by the desktop updater. `AERIE_RELEASE_MODE=publish` requires the
persistent Ed25519 identity whose public half is pinned in
`desktop/release-key.json`, and fails if the key is absent or mismatched. Keep
the private key outside the repository, restrict its permissions, and back it
up securely. Replacing it after distributing an app prevents that installed
app from trusting future releases.

Starting with desktop 1.8.0, Aerie checks its configured server for updates on
a bounded schedule and on demand from **Get Apps**, the app menu, or tray. It
downloads only an exact same-server artifact, resumes interrupted transfers,
and verifies the pinned Ed25519 signature, version/build, size, SHA-256 and
minimum server version before installing. Linux AppImage swaps are atomic and
retain one verified rollback; Windows launches the verified NSIS installer
directly in silent-update mode. Builds older than 1.8.0 need one final manual
install before they can use this path. The release signature authenticates an
Aerie update even on a private HTTP LAN, although HTTPS is still recommended.

Ed25519 update signing is independent of Windows Authenticode. Unless you also
sign the installer with a trusted Authenticode certificate, Windows may still
show a SmartScreen reputation warning on the first manual install.

Users can always change the server later via *Aerie → Change Server…* in the
app menu or the tray icon.

## Android

```sh
cd apps

# Generic build (first run prompts for the server address):
./build-android.sh

# Build with your server(s) baked in:
AERIE_DEFAULT_URL=https://cloud.example.com \
AERIE_LAN_URL=http://192.0.2.10:8200 \
./build-android.sh
```

- `AERIE_DEFAULT_URL` — your public (cloud) address, used as the default and
  pre-filled in the server prompt.
- `AERIE_LAN_URL` — optional LAN address. When set, the app probes the LAN
  address first and automatically hops between LAN and cloud as connectivity
  changes (useful when your router can't hairpin your public hostname).

Both are optional; either can be empty. They can also be passed as Gradle
properties (`-PaerieDefaultUrl=… -PaerieLanUrl=…`) if you build without
the script.

The script runs Android unit tests and release lint before it is allowed to
assemble and verify `apps/android/app/build/outputs/apk/release/app-release.apk`.
It preserves the existing certificate by migrating the prior `debug.keystore`
bytes to `aerie-update.keystore`; despite the legacy filename, the resulting APK
is a non-debuggable release build. Back up `apps/android/.signing/` securely:
losing that identity requires uninstalling the existing app before reinstalling.
Each build also emits a `.release.json` sidecar with its version, SHA-256 and
certificate digest for Aerie's deterministic Get Apps catalogue.

Starting with Android 1.7.0, the app checks its own Aerie server for newer
verified releases at startup and daily. It resumes the APK download in the
background, verifies the checksum, package id, version and existing signing
certificate, then asks the user to approve Android's normal installer flow.
Installation is never silent. Builds older than 1.7.0 need one final manual
install of the current APK from **Get Apps**. Starting with 1.8.0, reopening
Aerie also surfaces a ready update when Android notification permission is off.

Android's system Share menu also includes **Aerie** for single or multiple
files and text. Shared items use the same resumable, account-bound upload
protocol as native folder sync.

After signing in, connect the phone to Android Auto and select **Aerie** from
the audio launcher. Music is supplied by the configured Jellyfin integration;
audiobook files come from Audiobookshelf while resume state remains private to
each Aerie member. The service owns a native Media3 player, so it keeps playing
independently of the WebView. **Aerie Drive**
also appears in Android's system file picker and streams files on demand.

The APK produced here is sideloaded rather than Play-distributed. For a real
vehicle test, enable Android Auto developer mode and its **Unknown sources**
option, or distribute the build through a Play internal test track; otherwise
Android Auto intentionally hides untrusted-source media apps.

## Publishing the apps on your server

Aerie serves a *Get Apps* page from its `/downloads` volume. Publish exact
versioned names—never release globs—and stage each file under a non-matching
hidden name. Put the sidecar in place first and rename the complete artifact
last, so neither a partial upload nor stale output can become downloadable:

```sh
downloads=/path/to/aerie/downloads
desktop_version=1.8.3

publish_pair() {
  source_file=$1
  published_name=$2
  test -f "$source_file" && test -f "$source_file.release.json"
  install -m 0644 "$source_file.release.json" "$downloads/.$published_name.release.json.incoming"
  mv -f "$downloads/.$published_name.release.json.incoming" "$downloads/$published_name.release.json"
  install -m 0644 "$source_file" "$downloads/.$published_name.incoming"
  mv -f "$downloads/.$published_name.incoming" "$downloads/$published_name"
}

publish_pair "desktop/release/Aerie-$desktop_version.AppImage" "Aerie-$desktop_version.AppImage"
publish_pair "desktop/release/aerie_${desktop_version}_amd64.deb" "aerie_${desktop_version}_amd64.deb"
publish_pair "desktop/release/Aerie-Setup-$desktop_version.exe" "Aerie-Setup-$desktop_version.exe"

android_version=1.8.0
publish_pair "android/app/build/outputs/apk/release/app-release.apk" "Aerie-$android_version.apk"
```

Deploy the matching server version before publishing desktop artifacts: the
signed sidecar's `minServerVersion` is enforced by clients. The server hashes
every candidate, verifies desktop Ed25519 signatures against the same pinned
public identity, and selects the highest trusted build. Unsigned local builds
remain available only as clearly checksum-verified manual downloads.

(The exact host path of the `/downloads` volume depends on your server deploy —
check your compose file / deploy script.)

## Notes

- **APK signing**: self-hosted releases keep one private update identity so
  sideloaded installs upgrade in place. Set `AERIE_ANDROID_SIGNING_DIR`,
  `AERIE_ANDROID_STORE_PASSWORD`, `AERIE_ANDROID_KEY_ALIAS`, and
  `AERIE_ANDROID_KEY_PASSWORD` before the first distributed build to choose the
  persistent keystore location and stronger credentials. Keep those values and
  the keystore unchanged after distributing an APK; replacing that identity
  breaks in-place updates. Play distribution should use a separately planned
  Play App Signing lineage.
- **Desktop release signing**: use a dedicated Ed25519 private key and commit
  only its public SPKI and key id in `desktop/release-key.json`. Never copy the
  private key into an image, artifact, download directory or Git repository.
- **Package rename**: the Android applicationId changed from `org.cloudbox.app`
  to `org.aerie.app` with the rebrand, so Android treats the Aerie APK as a new
  app — installs alongside an old CloudBox APK rather than updating it.
- **Cleartext HTTP**: the Android app explicitly allows cleartext (plain `http://`)
  traffic so that LAN servers without TLS — e.g. `http://192.0.2.10:8200` — work.
  If you only ever use HTTPS you can tighten
  `android/app/src/main/res/xml/network_security_config.xml` and drop
  `android:usesCleartextTraffic` from the manifest. The desktop app likewise
  accepts plain `http://` URLs for LAN use.
- Keep your real server addresses out of the repo: pass them via the environment
  (or a local, uncommitted conf that exports the two variables) when you build.
