# Aerie

**Your entire digital life, self-hosted, in one app.** Aerie is a private-cloud hub that unifies your files, photos, movies, TV, music, audiobooks, documents and AI tools behind a single beautiful interface — powered by the self-hosted services you already run.

![Dashboard](docs/screenshots/dashboard.png?v=2)

## What you get is an app that combines all of your backends into one ultimate app.


- **Drive** — per-user file storage with uploads, sharing links, trash, versioning and full-text search
- **Docs & Sheets** — built-in document (WYSIWYG) and spreadsheet editors with a safe formula engine and charts
- **Photos** — a built-in photo library for every member (timeline, EXIF dates & camera info, drag-drop upload, lightbox) with **zero extra containers**
- **Auto-sync folders** — pick folders on your PC to back up or two-way mirror; your phone uploads chosen folders **every night while it charges on Wi-Fi**, and those files flow down to your PC the next time it's on
- **Movies, TV & Videos** — Netflix-style browsing, resume, subtitles and audio tracks, backed by [Jellyfin](https://jellyfin.org)
- **AI subtitles** — generate English subtitles from the audio itself (local Whisper), translate any track with an LLM, fix out-of-sync timing with one click, and clean up broken/garbled subtitle files instantly
- **Watch & listening history** — per-member history for movies, TV, music, audiobooks and podcasts, with real hours spent and weekly totals
- **2K GPU upscaling** — a WebGL2 port of AMD FidelityFX Super Resolution 1.0 upscales 1080p to 1440p *on the viewer's own GPU* (Windows/Linux desktops)
- **TV casting** — server-side Google Cast: send any movie to a Chromecast straight from the web app, with pause/seek controls
- **Music** — albums, artists, AI "made for you" mixes, and a phone-friendly player with media-session controls
- **Audiobooks & Podcasts** — multi-file books, resume across devices, backed by [Audiobookshelf](https://www.audiobookshelf.org)
- **Requests** — family members request movies/TV via [Jellyseerr](https://github.com/Fallenbagel/jellyseerr) and music via [Lidarr](https://lidarr.audio), right from the app
- **AI suite** — chat assistant with tool use (search your files, storage reports, playlists), image generation & inpainting (ComfyUI), music generation (ACE-Step), and voice input (Whisper) — using a cloud API (DeepSeek) or fully local (Ollama)
- **Apps everywhere** — installable PWA plus native Windows/Linux desktop apps and an Android APK with media notifications and LAN/cloud auto-failover
- **Self-care** — TOTP 2FA, nightly SQLite backups, service monitoring, automations, admin panel

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
   Set at minimum `HOST_IP` (your server's LAN IP). Point the `*_APPDATA` paths at your existing service appdata folders — `gen-env.sh` reads the API keys straight out of those services' own config files/databases.
3. **Deploy:**
   ```bash
   bash deploy/run.sh
   ```
   This generates `/mnt/user/appdata/aerie/aerie.env`, builds the Docker image, and starts the `aerie` container on port 8200 with `/mnt/user/appdata/aerie/{data,files,downloads}` volumes and your media share mounted read-only.
4. **First login:** `http://SERVER-IP:8200` — see the container log for the generated admin password (`docker logs aerie`).
5. **HTTPS (recommended):** several features are browser-gated to secure contexts — microphone/voice, browser casting, offline downloads and PWA install only work over HTTPS. Put any reverse proxy in front (Nginx Proxy Manager, Caddy, Traefik, Cloudflare Tunnel) targeting `SERVER-IP:8200` with websockets enabled, proxy buffering off, and generous timeouts/body size for uploads and long streams. If you use Nginx Proxy Manager, `deploy/npm-proxy.sh` is a working example. Set `PUBLIC_URL` in `deploy.conf` to your HTTPS address so the UI can point people at it.
6. **Update later:** `git pull && bash deploy/run.sh` — your `deploy.conf`, env and data are preserved.

## Native apps

The **Get Apps** page serves whatever installers you place in the `/downloads` volume. Build them yourself from `apps/` — optionally baking in your server's address so your family never types a URL:

```bash
export AERIE_DEFAULT_URL=https://cloud.example.com   # optional
export AERIE_LAN_URL=http://192.168.0.10:8200        # optional (Android failover)
./apps/build-desktop.sh    # Windows .exe + Linux AppImage/.deb (Docker)
./apps/build-android.sh    # Android APK (Docker)
```

Copy the artifacts into `<appdata>/aerie/downloads/`. Details, signing notes and caveats: [`apps/README.md`](apps/README.md). The Android app adds OS media controls, automatic LAN↔cloud switching with session handoff, and **nightly folder sync** — pick folders (camera roll, downloads, …) in Settings and they upload while the phone charges on Wi-Fi. The desktop app is a slim wrapper around your server's web UI that adds **folder sync** (backup or two-way mirror, managed from the same Settings page), so it updates itself whenever you redeploy the server.

## AI subtitles

Every video's CC menu has an **AI tools** section:

- **Generate English (AI)** — the server extracts the audio, cuts it at natural silences and transcribes it chunk-by-chunk through your local Whisper — subtitles from nothing, fully on your own hardware.
- **Translate current** — any subtitle track, translated cue-by-cue by the LLM into your configured language (`TRANSLATE_LANG`), preserving all timing.
- **Sync current to audio** — one click fixes out-of-sync subtitles by correlating speech activity in the audio with the cue timing (handles constant offsets *and* drift).
- **Clean up current** — instantly repairs broken encodings (mojibake, wrong charset), strips stray tags and formatting codes, and fixes overlapping cues.

Generation and translation run as background jobs with live progress in the menu — keep watching, you'll get a notification when the new track is ready. Generated tracks are stored server-side and appear for the whole family.

![AI subtitle tools](docs/screenshots/subtitles-ai.png)

## The 2K GPU upscaler

Movies stored in 1080p can be rendered at 2560×1440 by the *viewing* machine: the player pipes every decoded frame through a WebGL2 port of AMD FidelityFX Super Resolution 1.0 (EASU + RCAS). Toggle it with the **2K** button in the player — the badge shows the live pipeline (`1920×800 → 2560×1067 · GPU`). Desktop Windows/Linux only; the server never transcodes for it, so it costs the server nothing.

## Security notes

- Sessions are JWT-based; the secret comes from `JWT_SECRET` or is generated once and persisted under `/data`.
- The first-run admin password is random unless you set `ADMIN_USER`/`ADMIN_PASSWORD`; a `demo/demo` account is only created if you opt in with `SEED_DEMO=1`.
- Optional TOTP two-factor auth per account (Settings → Security).
- Media/photo API keys live server-side only; the browser only ever sees Aerie session tokens.
- Nightly `VACUUM INTO` database backups with one-click restore (Backups page).

## License

MIT — see [LICENSE](LICENSE). Includes a port of AMD FidelityFX Super Resolution 1.0 and OpenStreetMap-based maps; attributions in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).


