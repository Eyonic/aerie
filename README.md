# Aerie

**Your entire digital life, self-hosted, in one app.** Aerie is a private-cloud hub that unifies your files, photos, movies, TV, music, audiobooks, documents and AI tools behind a single beautiful interface — powered by the self-hosted services you already run.

![Dashboard](docs/screenshots/dashboard.png?v=2)

## What you get is an app that combines all of your backends into one ultimate app.


- **Drive** — per-user file storage with uploads, sharing links, trash, versioning and indexed filename/path search
- **Docs & Sheets** — built-in document (WYSIWYG) and spreadsheet editors with a safe formula engine, charts, durable recovery drafts and explicit cross-device conflict resolution
- **Photos** — per-member timelines, favourites and albums, with private view-only album sharing to named household accounts and **zero extra containers**
- **Sync Fabric** — true two-way desktop and Android folders with stable file identities, rename/delete propagation, resumable transfers and conflict copies; camera backup stays safely add-only
- **Cloud Time Machine** — immutable, deduplicated snapshots with a browsable timeline, diffs, retention and staged file/folder restore
- **Aerie Drive** — mount private files in Windows, macOS and Linux over WebDAV, or open them as a native Android document source
- **Movies, TV & Videos** — capability-aware Direct Play, adaptive/manual quality, stereo or 5.1 audio, chapters, remembered language/caption preferences and reliable cross-season next-episode navigation, backed by [Jellyfin](https://jellyfin.org)
- **AI subtitles** — generate subtitles from the audio itself with automatic language detection (local Whisper), translate any track into your selected languages with your chosen local or external provider, fix timing with one click, and clean up broken files
- **Watch & listening history** — per-member history for movies, TV, music, audiobooks and podcasts, with real hours spent and weekly totals
- **2K GPU upscaling** — a WebGL2 port of AMD FidelityFX Super Resolution 1.0 upscales 1080p to 1440p *on the viewer's own GPU* (Windows/Linux desktops)
- **TV casting** — server-side Google Cast: send any movie to a Chromecast straight from the web app, with pause/seek controls
- **Music** — albums, artists, AI "made for you" mixes, editable Play Next/upcoming queues, shuffle-safe history, low-gap handoff and opt-in clipping-safe loudness normalization
- **Audiobooks & Podcasts** — multi-file books, resume across devices, backed by [Audiobookshelf](https://www.audiobookshelf.org)
- **Optimized artwork** — responsive WebP posters, covers and thumbnails with a persistent server-side cache under the Aerie data directory
- **Requests** — family members request movies/TV via [Jellyseerr](https://github.com/Fallenbagel/jellyseerr) and music via [Lidarr](https://lidarr.audio), right from the app
- **AI suite** — chat assistant with tool use (search your files, storage reports, playlists), image generation & inpainting (ComfyUI), music generation (ACE-Step), and voice input (Whisper) — using a cloud API (DeepSeek) or fully local (Ollama)
- **Apps everywhere** — installable PWA plus hardened Windows/Linux desktop apps and an Android APK with verified in-app updates, Share to Aerie, trusted-device keys, LAN/cloud failover, Android Auto and native Drive access
- **Continuity & Mesh** — hand off routes and listening queues between trusted devices; encrypted LAN peers move sync chunks directly and fall back to the cloud automatically
- **Self-care** — TOTP 2FA, verified recovery bundles, service monitoring, real built-in automations and an admin panel

| | | |
|---|---|---|
| ![Movies](docs/screenshots/movies.png?v=2) | ![Player with 2K upscaling](docs/screenshots/player-2k.png?v=2) | ![Music](docs/screenshots/music.png?v=2) |

Request new titles right from the app — movies & TV through Jellyseerr, and music (whole artist discographies) through your own Lidarr:

| | |
|---|---|
| ![Request movies & TV](docs/screenshots/requests.png?v=2) | ![Request music](docs/screenshots/requests-music.png?v=2) |

### Create — documents, spreadsheets & image editing

| | | |
|---|---|---|
| ![Documents](docs/screenshots/documents.png?v=2) | ![Spreadsheets with live formulas](docs/screenshots/spreadsheets.png?v=2) | ![Image editor with layers](docs/screenshots/image-editor.png?v=2) |

### AI, on your own hardware

| | | |
|---|---|---|
| ![AI Image Studio](docs/screenshots/ai-image-studio.png?v=2) | ![AI Music Studio](docs/screenshots/music-studio.png?v=2) | ![AI Assistant](docs/screenshots/assistant.png?v=2) |

### Your library & files

| | | |
|---|---|---|
| ![Files](docs/screenshots/files.png?v=2) | ![Audiobooks](docs/screenshots/audiobooks.png?v=2) | ![TV Shows](docs/screenshots/tv-shows.png?v=2) |

### Runs like an appliance

| | | |
|---|---|---|
| ![Automations](docs/screenshots/automations.png?v=2) | ![Live monitoring](docs/screenshots/monitoring.png?v=2) | ![Nightly backups](docs/screenshots/backups.png?v=2) |

## How it works

Aerie is a single Docker container (Node/Express API + React web app). It doesn't replace your media stack — it **federates** it. Every integration is optional: leave its URL unset in the env and that feature simply reports "not configured" while everything else keeps working.

| Integration | Powers | Env vars |
|---|---|---|
| Jellyfin | Movies, TV, Videos, Music | `JELLYFIN_URL`, `JELLYFIN_API_KEY` |
| Audiobookshelf | Audiobooks, Podcasts | `ABS_URL`, `ABS_API_KEY` |
| Jellyseerr | Movie/TV requests | `JELLYSEERR_URL`, `JELLYSEERR_API_KEY` |
| Lidarr | Music requests | `LIDARR_URL`, `LIDARR_API_KEY` |
| DeepSeek (cloud) or Ollama (local) | AI assistant, doc/sheet AI, subtitle translation | `DEEPSEEK_API_KEY` / `OLLAMA_URL` |
| ComfyUI | AI image generation | `SD_URL` |
| ACE-Step | AI music generation | `ACESTEP_URL` |
| Wyoming Whisper | Voice input, AI subtitle generation | `WHISPER_URL` |

Files, Photos, Docs, Sheets, Shares, History, Folder sync, Backups and Automations are fully built-in and need nothing external. If Jellyfin's paths differ from Aerie's `/media` mount (renamed bind mounts), set `MEDIA_PATH_MAP` (e.g. `/data/movies=/media/Films`) so subtitle generation can read the files directly — without it Aerie falls back to streaming them from Jellyfin.

Recovery bundles run at 03:00 server-local time by default. Set `TZ` to the
host's IANA timezone, `BACKUP_SCHEDULE_HOUR` to a different hour (0–23), and
`BACKUP_RETENTION` to the number of complete local bundles to keep. The Backups
page reports these effective values and whether the nightly automation is on.

**You don't need to touch a config file for any of this.** The admin **Integrations** page (sidebar → System → Integrations) lets you enter every service URL and API key from the browser, with one-click connection tests — values save to the database, apply instantly without a restart, and override the environment. Env vars remain fully supported as defaults/automation (see [`aerie.env.example`](aerie.env.example)); secrets saved in the app are write-only and never shown again.

![Integrations](docs/screenshots/integrations.png?v=2)

It's also where you set your server's **public and LAN addresses** — the native apps learn both from the server and switch between them automatically (home Wi-Fi ↔ mobile data) without rebuilding or reconfiguring anything on the devices.

## Want to help this project? Get involved by sharing your feedback or supporting me with a coffee.

<a href="https://www.buymeacoffee.com/Eyonic" target="_blank"><img src="https://www.buymeacoffee.com/assets/img/custom_images/orange_img.png" alt="Buy Me A Coffee" style="height: 41px !important;width: 174px !important;box-shadow: 0px 3px 2px 0px rgba(190, 190, 190, 0.5) !important;-webkit-box-shadow: 0px 3px 2px 0px rgba(190, 190, 190, 0.5) !important;" ></a>

## Quick start (any Docker host)

```bash
git clone https://github.com/Eyonic/aerie.git
cd aerie
cp aerie.env.example aerie.env   # edit: add your service URLs + API keys
docker compose up -d --build
```

Open `http://YOUR-HOST:8200`. On first run Aerie creates an **admin** account and prints its password once to the container log:

```bash
docker logs aerie | grep -A3 'First run'
```

Log in, change the password (Settings → Security), optionally enable 2FA, and add accounts for your family in Admin.

## Installing on Unraid

Aerie was built on and for an Unraid home server. The `deploy/` scripts automate everything, including **harvesting the API keys from your existing containers' appdata** so you don't have to copy them by hand.

1. **Get the source onto the server** (SSH in as root — any path works; set `SRC_DIR` in `deploy.conf` if you pick a different one):
   ```bash
   git clone https://github.com/Eyonic/aerie.git /root/aerie-src
   cd /root/aerie-src
   ```
2. **Describe your setup** — copy the template and edit it:
   ```bash
   cp deploy/deploy.conf.example deploy/deploy.conf
   nano deploy/deploy.conf
   ```
   Set at minimum `HOST_IP` (your server's LAN IP), `SRC_DIR` (this exact source tree), and `EXPECTED_VERSION` (the version you intend to deploy). Point the `*_APPDATA` paths at your existing service appdata folders — `gen-env.sh` reads the API keys straight out of those services' own config files/databases. The deploy refuses mixed/stale package versions and refuses to promote a healthy container that reports a different version.
3. **Deploy:**
   ```bash
   bash deploy/run.sh
   ```
   This generates `/mnt/user/appdata/aerie/aerie.env`, builds the Docker image, and starts the `aerie` container on port 8200 with `/mnt/user/appdata/aerie/{data,files,downloads}` volumes and your media share mounted read-only.
4. **First login:** `http://SERVER-IP:8200` — see the container log for the generated admin password (`docker logs aerie`).
5. **HTTPS (recommended):** several features are browser-gated to secure contexts — microphone/voice, browser casting, offline downloads and PWA install only work over HTTPS. Put any reverse proxy in front (Nginx Proxy Manager, Caddy, Traefik, Cloudflare Tunnel) targeting `SERVER-IP:8200` with websockets enabled, proxy buffering off, and generous timeouts/body size for uploads and long streams. If you use Nginx Proxy Manager, `deploy/npm-proxy.sh` is a working example. Set `PUBLIC_URL` in `deploy.conf` to your HTTPS address so the UI can point people at it.
6. **Update later:** `git pull`, set `EXPECTED_VERSION` in `deploy.conf` to the release you reviewed, then run `bash deploy/run.sh`. Your env and data are preserved; the source/version guard prevents an old staged tree from being promoted by mistake. For schema upgrades, deployment stops the old container, captures and verifies a WAL-consistent database snapshot, and health-checks the migrated candidate without publishing a host port. A private-candidate failure restores that snapshot atomically before the previous container is restarted.

The public port is the write-preservation boundary: once the already-tested candidate is started on port 8200, it may receive user writes, so the script will never silently restore the older snapshot and discard them. The small residual window is the second container start and final health readback. If that post-exposure check fails, Aerie remains on the migrated database, the verified pre-migration snapshot is retained, and the old container stays stopped for an operator to inspect rather than risking data loss.

## Native apps

The **Get Apps** page serves whatever installers you place in the `/downloads` volume. Build them yourself from `apps/` — optionally baking in your server's address so your family never types a URL:

```bash
export AERIE_DEFAULT_URL=https://cloud.example.com   # optional
export AERIE_LAN_URL=http://192.168.0.10:8200        # optional (Android failover)
AERIE_RELEASE_MODE=publish \
AERIE_RELEASE_SIGNING_KEY=/secure/release-ed25519-private.pem \
./apps/build-desktop.sh    # signed Windows .exe + Linux AppImage/.deb
./apps/build-android.sh    # Android APK (Docker)
```

Copy the artifacts into `<appdata>/aerie/downloads/`. Details, signing notes and caveats: [`apps/README.md`](apps/README.md). Pair native installs from **Devices & Continuity**; their OS-keystore identity renews short sessions without storing the account password. Normal desktop and Android folders use journaled two-way Sync Fabric, while Camera Backup remains add-only. Trusted desktop peers advertise an encrypted Aerie Mesh endpoint and transfer resumable chunks directly over the LAN before falling back to the server.

### Android Auto, Android Drive and desktop mounts

Sign into the Aerie Android app once, then connect the phone to Android Auto. **Aerie** appears as an audio app with shallow Music, Audiobooks and Continue Listening sections. Playback is owned by a native background player—not the WebView—so steering-wheel play/pause/seek, voice search, queues and audiobook resume keep working when the phone UI is closed. Music requires Jellyfin and audiobooks require Audiobookshelf, using the same libraries and per-member progress as the web app.

The Android APK also registers **Aerie Drive** in the system document picker. Apps can lazily browse, open, create, stream-write, rename and delete private Aerie files without downloading the whole Drive first.

On Windows, macOS or Linux, open **Devices & Continuity → Aerie Drive**, create a one-time app password, and mount the displayed `/dav` address with your Aerie username. Revoke that credential independently at any time; the normal account password is never given to the operating system.

## AI subtitles

Every video's CC menu has an **AI tools** section:

- **Generate subtitles (AI)** — the server extracts the audio, cuts it at natural silences and transcribes it chunk-by-chunk through your local Whisper with automatic language detection — subtitles from nothing, fully on your own hardware.
- **Translate current** — any subtitle track, translated cue-by-cue into any of the target languages selected under **Settings → AI & Privacy**, using either the saved local engine or cloud provider while preserving all timing.
- **Sync current to audio** — one click fixes out-of-sync subtitles by correlating speech activity in the audio with the cue timing (handles constant offsets *and* drift).
- **Clean up current** — instantly repairs broken encodings (mojibake, wrong charset), strips stray tags and formatting codes, and fixes overlapping cues.

Generation and translation run as background jobs with live progress in the menu — keep watching, you'll get a notification when the new track is ready. Generated tracks are stored server-side and remain private to the account that created them.

![AI subtitle tools](docs/screenshots/subtitles-ai.png)

## The 2K GPU upscaler

Movies stored in 1080p can be rendered at 2560×1440 by the *viewing* machine: the player pipes every decoded frame through a WebGL2 port of AMD FidelityFX Super Resolution 1.0 (EASU + RCAS). Toggle it with the **2K** button in the player — the badge shows the live pipeline (`1920×800 → 2560×1067 · GPU`). Desktop Windows/Linux only; the server never transcodes for it, so it costs the server nothing.

## Security notes

- Browser sessions use secure, HttpOnly cookies with CSRF protection; native clients use revocable sessions and an OS-keystore device key. The signing secret comes from `JWT_SECRET` or is generated once and persisted under `/data`.
- The first-run admin password is random unless you set `ADMIN_USER`/`ADMIN_PASSWORD`. A demo account is created only with `SEED_DEMO=1`, and its password comes from `DEMO_PASSWORD` or is generated randomly and logged once.
- Optional TOTP two-factor authentication includes encrypted secrets and one-use recovery codes (Settings → Security).
- Integration API keys are encrypted at rest, write-only in the admin UI, and sent only by bounded same-origin proxy routes. Upstream redirects and oversized responses are rejected.
- Public share links use high-entropy IDs, optional passwords, expiry and download limits. Passwords are exchanged for scoped HttpOnly share cookies rather than being placed in URLs.
- Deactivating a member revokes sessions and stops their jobs without deleting files, history, snapshots or shares; restoring the account brings that data back.
- Nightly recovery bundles include the database and required Aerie state, are checksummed before restore, and apply through a staged restart with automatic rollback on a failed database check.
- The production container is compiled, runs as a non-root user with a read-only root filesystem, drops Linux capabilities, and exposes a health check used by the rollback-safe deploy script.

## License

MIT — see [LICENSE](LICENSE). Includes a port of AMD FidelityFX Super Resolution 1.0 and OpenStreetMap-based maps; attributions in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
