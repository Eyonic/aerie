# Aerie native apps

Thin native shells around the Aerie web app:

- `desktop/` — Electron app (Linux AppImage + deb, Windows NSIS installer + portable exe)
- `android/` — full-screen WebView app with media-session integration (debug-signed APK)

Both are generic out of the box: they ship with **no server address** and ask the
user for one on first run. If you self-host Aerie you can bake your own
server address in at build time so your users never see the prompt.

## Prerequisites

Docker. Nothing else — both build scripts run entirely inside containers.

## Desktop

```sh
cd apps

# Generic build (first run shows the "Connect to Aerie" screen):
./build-desktop.sh

# Build with your server pre-configured:
AERIE_DEFAULT_URL=https://cloud.example.com ./build-desktop.sh
```

The script writes `desktop/default-server.json` (`{"url": ""}` when the env var
is unset) and then runs `electron-builder` inside `electronuserland/builder:wine`.

Artifacts land in `apps/desktop/release/`:

- `Aerie-<version>.AppImage`
- `aerie_<version>_amd64.deb`
- `Aerie-Setup-<version>.exe` (NSIS installer)
- `Aerie <version>.exe` (portable)

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

The artifact lands in `apps/android/app/build/outputs/apk/debug/app-debug.apk`.

## Publishing the apps on your server

Aerie serves a *Get Apps* page from its `/downloads` volume. Copy the built
artifacts there so users can install them straight from your server, e.g.:

```sh
cp desktop/release/Aerie-*.AppImage desktop/release/*.deb \
   desktop/release/Aerie-Setup*.exe \
   /path/to/aerie/downloads/
cp android/app/build/outputs/apk/debug/app-debug.apk \
   /path/to/aerie/downloads/Aerie.apk
```

The server's download catalog matches files by **extension** (`.apk`,
`.AppImage`, `.deb`, `.exe`), not by name — so downloads published under the
old branding (`CloudBox.apk`, `CloudBox-*.AppImage`, …) keep working and can
be replaced with the `Aerie.*` files at your leisure.

(The exact host path of the `/downloads` volume depends on your server deploy —
check your compose file / deploy script.)

## Notes

- **APK signing**: the Android build is **debug-signed**. That is perfectly fine
  for sideloading on your own devices (the Get Apps page use case), but for a
  Play Store / F-Droid release you must set up your own release keystore and
  signing config.
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
