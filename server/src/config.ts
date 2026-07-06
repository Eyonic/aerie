// Central config. Every backend integration is OPTIONAL: leave its URL unset
// and the matching feature reports "not configured" in the UI instead of
// breaking. Values resolve live on every read: in-app Integrations settings
// (DB-backed overrides) win over env vars (see the env example in the repo
// root). Boot-level values (port, paths, JWT) stay env-only — they can't
// change without a restart anyway.
import path from 'node:path';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { getOverride } from './lib/overrides.js';

const env = process.env;

// Override-aware lookup used for everything the Integrations page can manage.
export const cfgVal = (key: string, dflt = ''): string =>
  getOverride(key) ?? env[key] ?? dflt;

// JWT secret: use JWT_SECRET when provided; otherwise generate one once and
// persist it under the data dir so sessions survive restarts. Never fall back
// to a well-known string — that would make every unconfigured install forgeable.
function jwtSecret(dataDir: string): string {
  if (env.JWT_SECRET) return env.JWT_SECRET;
  const file = path.join(dataDir, '.jwt-secret');
  try {
    return fs.readFileSync(file, 'utf8').trim();
  } catch {
    const secret = crypto.randomBytes(32).toString('hex');
    try {
      fs.mkdirSync(dataDir, { recursive: true });
      fs.writeFileSync(file, secret, { mode: 0o600 });
      console.warn('JWT_SECRET not set — generated one and saved it to ' + file);
    } catch {
      console.warn('JWT_SECRET not set and ' + file + ' not writable — sessions reset on restart.');
    }
    return secret;
  }
}

// Per-user PhotoPrism instances: PP_INSTANCES="alice=http://host:2342,bob=http://host:2343"
// (legacy PP_<NAME>_URL variables are also honored for existing deployments).
function photoprismUsers(): Record<string, string> {
  const users: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    const m = /^PP_([A-Z0-9]+)_URL$/.exec(key);
    if (m && value) users[m[1].toLowerCase()] = value;
  }
  for (const part of cfgVal('PP_INSTANCES').split(',')) {
    const [name, url] = part.split('=').map(s => s?.trim());
    if (name && url) users[name.toLowerCase()] = url;
  }
  return users;
}

const dataDir = env.DATA_DIR || '/data';

export const config = {
  port: parseInt(env.PORT || '8200', 10),
  jwtSecret: jwtSecret(dataDir),
  // Public HTTPS address of this Aerie server (optional). Shown in UI hints
  // for features that need a secure context (casting, mic, PWA install).
  get publicUrl() { return cfgVal('PUBLIC_URL'); },
  // Secondary/LAN address (optional). Together with publicUrl these are the
  // failover origins the native apps learn from /api/health.
  get lanUrl() { return cfgVal('LAN_URL'); },
  dataDir,
  // 'cloudbox.db' is the legacy (pre-rename) filename — kept so existing
  // installs keep opening their data. Do NOT rename to aerie.db.
  get dbPath() { return path.join(this.dataDir, 'cloudbox.db'); },
  get versionsDir() { return path.join(this.dataDir, 'versions'); },
  get generatedDir() { return path.join(this.dataDir, 'generated'); },
  get subtitlesDir() { return path.join(this.dataDir, 'subtitles'); },
  get thumbsDir() { return path.join(this.dataDir, 'thumbs'); },
  get downloadsDir() { return env.DOWNLOADS_DIR || path.join(this.dataDir, 'downloads'); },

  // Per-user file storage root. Each user gets DATA_ROOT/<username>.
  filesRoot: env.FILES_ROOT || '/files',

  // Shared media library roots (read-mostly, imported into sections)
  mediaRoot: env.MEDIA_ROOT || '/media',

  // Backend services — unset URL = integration disabled.
  jellyfin: {
    get url() { return cfgVal('JELLYFIN_URL'); },
    get apiKey() { return cfgVal('JELLYFIN_API_KEY'); },
  },
  audiobookshelf: {
    get url() { return cfgVal('ABS_URL'); },
    get apiKey() { return cfgVal('ABS_API_KEY'); },
  },
  photoprism: {
    get users() { return photoprismUsers(); },
    get defaultUser() { return cfgVal('PP_DEFAULT') || Object.keys(photoprismUsers())[0] || ''; },
    get user() { return cfgVal('PP_USER', 'admin'); },
    get password() { return cfgVal('PP_PASSWORD'); },
  },
  jellyseerr: {
    get url() { return cfgVal('JELLYSEERR_URL'); },
    get apiKey() { return cfgVal('JELLYSEERR_API_KEY'); },
  },
  lidarr: {
    get url() { return cfgVal('LIDARR_URL'); },
    get apiKey() { return cfgVal('LIDARR_API_KEY'); },
  },
  ollama: {
    get url() { return cfgVal('OLLAMA_URL'); },
    get model() { return cfgVal('OLLAMA_MODEL', 'llama3.2:latest'); },
  },
  deepseek: {
    get url() { return cfgVal('DEEPSEEK_URL', 'https://api.deepseek.com'); },
    get apiKey() { return cfgVal('DEEPSEEK_API_KEY'); },
    get model() { return cfgVal('DEEPSEEK_MODEL', 'deepseek-chat'); },
  },
  sd: {
    // AI image backend (ComfyUI on this port by convention)
    get url() { return cfgVal('SD_URL'); },
  },
  acestep: {
    get url() { return cfgVal('ACESTEP_URL'); },
  },
  whisper: {
    get url() { return cfgVal('WHISPER_URL'); },
  },
  get translateLang() { return cfgVal('TRANSLATE_LANG', 'nl'); },
  // Optional "jellyfinPrefix=ourPrefix,..." map for finding Jellyfin's files on our mount.
  get mediaPathMap() { return cfgVal('MEDIA_PATH_MAP', ''); },
  server: {
    // Host address used for on-box stats via a lightweight agent (optional)
    get host() { return cfgVal('SERVER_HOST') || cfgVal('TOWER_HOST'); },
  },
} as const;

export type Config = typeof config;
