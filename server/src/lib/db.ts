// SQLite metadata store: users, sessions, stars, shares, versions, jobs,
// audit log, devices, automations, notifications, settings, watch-progress.
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { config } from '../config.js';

fs.mkdirSync(config.dataDir, { recursive: true });
fs.mkdirSync(config.versionsDir, { recursive: true });
fs.mkdirSync(config.generatedDir, { recursive: true });
fs.mkdirSync(config.subtitlesDir, { recursive: true });
fs.mkdirSync(config.thumbsDir, { recursive: true });

export const db = new Database(config.dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  display_name TEXT NOT NULL,
  email TEXT,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user',
  avatar_color TEXT NOT NULL DEFAULT '#6366f1',
  storage_quota_bytes INTEGER,
  ai_mode TEXT NOT NULL DEFAULT 'local_only',
  settings TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS stars (
  user_id INTEGER NOT NULL,
  path TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, path)
);

CREATE TABLE IF NOT EXISTS trash (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  original_path TEXT NOT NULL,
  trashed_path TEXT NOT NULL,
  name TEXT NOT NULL,
  is_folder INTEGER NOT NULL DEFAULT 0,
  size INTEGER NOT NULL DEFAULT 0,
  deleted_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS shares (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  path TEXT NOT NULL,
  name TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'link',
  permission TEXT NOT NULL DEFAULT 'view',
  allow_download INTEGER NOT NULL DEFAULT 1,
  password_hash TEXT,
  shared_with TEXT,
  expires_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS versions (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  path TEXT NOT NULL,
  stored_path TEXT NOT NULL,
  author TEXT NOT NULL,
  note TEXT,
  size_bytes INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  prompt TEXT,
  progress REAL DEFAULT 0,
  result_urls TEXT,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT
);

CREATE TABLE IF NOT EXISTS generated_images (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  prompt TEXT NOT NULL,
  filename TEXT NOT NULL,
  width INTEGER, height INTEGER,
  workflow TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS subtitles (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL,
  lang TEXT NOT NULL,
  label TEXT NOT NULL,
  origin TEXT NOT NULL,
  filename TEXT NOT NULL,
  created_by INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_subtitles_item ON subtitles(item_id);

CREATE TABLE IF NOT EXISTS generated_music (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  prompt TEXT NOT NULL,
  lyrics TEXT,
  filename TEXT,
  duration_sec INTEGER,
  status TEXT NOT NULL DEFAULT 'queued',
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL DEFAULT (datetime('now')),
  user_id INTEGER,
  username TEXT NOT NULL DEFAULT 'system',
  action TEXT NOT NULL,
  target TEXT,
  ip TEXT,
  meta TEXT
);

CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'web',
  last_seen TEXT NOT NULL DEFAULT (datetime('now')),
  backup_status TEXT,
  trusted INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS automations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  trigger TEXT NOT NULL,
  action TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  last_run TEXT,
  run_count INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  ts TEXT NOT NULL DEFAULT (datetime('now')),
  title TEXT NOT NULL,
  body TEXT,
  level TEXT NOT NULL DEFAULT 'info',
  read INTEGER NOT NULL DEFAULT 0,
  link TEXT
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS play_history (
  user_id INTEGER NOT NULL,
  kind TEXT NOT NULL,
  item_id TEXT NOT NULL,
  day TEXT NOT NULL,
  title TEXT NOT NULL,
  subtitle TEXT,
  image_url TEXT,
  seconds INTEGER NOT NULL DEFAULT 0,
  position_sec REAL NOT NULL DEFAULT 0,
  duration_sec REAL NOT NULL DEFAULT 0,
  first_ts TEXT NOT NULL DEFAULT (datetime('now')),
  last_ts TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, kind, item_id, day)
);

CREATE TABLE IF NOT EXISTS photo_index (
  user_id INTEGER NOT NULL,
  rel_path TEXT NOT NULL,
  taken_at TEXT,
  width INTEGER, height INTEGER,
  size INTEGER NOT NULL DEFAULT 0,
  camera TEXT,
  lat REAL, lon REAL,
  mtime INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, rel_path)
);
CREATE INDEX IF NOT EXISTS idx_photo_taken ON photo_index(user_id, taken_at DESC);
`);

// ---------- Migrations (add columns to existing DBs) ----------
function addColumn(table: string, col: string, def: string) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as any[];
  if (!cols.some(c => c.name === col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
}
addColumn('users', 'totp_secret', 'TEXT');
addColumn('users', 'totp_enabled', 'INTEGER NOT NULL DEFAULT 0');
addColumn('users', 'features', "TEXT NOT NULL DEFAULT '{}'");
// Uploaded profile picture: 0 = none (fall back to colour+initials); otherwise a
// version stamp used to cache-bust the avatar image URL after each upload.
addColumn('users', 'avatar_version', 'INTEGER NOT NULL DEFAULT 0');

// ---------- Seed default admin + demo automations/devices ----------
function seed() {
  const count = (db.prepare('SELECT COUNT(*) c FROM users').get() as any).c;
  if (count === 0) {
    const insert = db.prepare(`INSERT INTO users
      (username, display_name, email, password_hash, role, avatar_color, ai_mode)
      VALUES (?,?,?,?,?,?,?)`);
    // First-run admin. Set ADMIN_USER/ADMIN_PASSWORD in the env to choose your
    // own; without ADMIN_PASSWORD a random one is generated and printed ONCE
    // to the container log — change it in Settings after logging in.
    const adminUser = process.env.ADMIN_USER || 'admin';
    let adminPass = process.env.ADMIN_PASSWORD || '';
    if (!adminPass) {
      adminPass = crypto.randomBytes(9).toString('base64url');
      console.log([
        '', '='.repeat(46),
        '  First run — admin account created',
        `  username: ${adminUser}`,
        `  password: ${adminPass}`,
        '  (change it in Settings after logging in)',
        '='.repeat(46), '',
      ].join('\n'));
    }
    insert.run(adminUser, 'Admin', null,
      bcrypt.hashSync(adminPass, 10), 'admin', '#6366f1', 'local_only');
    // Optional try-it-out account, opt-in only.
    if (process.env.SEED_DEMO === '1') {
      insert.run('demo', 'Demo User', null,
        bcrypt.hashSync('demo', 10), 'user', '#ec4899', 'ask_before_send');
    }
  }
  const autos = (db.prepare('SELECT COUNT(*) c FROM automations').get() as any).c;
  if (autos === 0) {
    const ins = db.prepare(`INSERT INTO automations (id,name,trigger,action,enabled,run_count) VALUES (?,?,?,?,?,?)`);
    ins.run('a1', 'Nightly phone backup', 'Every night on Wi-Fi + charging', 'Upload new phone photos & videos', 1, 214);
    ins.run('a2', 'Generate thumbnails', 'On photo/video upload', 'Create thumbnails + extract metadata', 1, 5821);
    ins.run('a3', 'Extract PDF text (OCR)', 'On PDF upload', 'Run OCR and index text for search', 1, 342);
    ins.run('a4', 'Backup failure alert', 'When a backup fails', 'Notify admin', 1, 3);
    ins.run('a5', 'Weekly cleanup', 'Every Sunday 03:00', 'Empty old trash + dedupe report', 1, 27);
    ins.run('a6', 'Storage almost full', 'When storage > 90%', 'Alert admin', 0, 0);
  }
}
seed();

export function getSetting(key: string, def = ''): string {
  const row = db.prepare('SELECT value FROM settings WHERE key=?').get(key) as any;
  return row ? row.value : def;
}
export function setSetting(key: string, value: string) {
  db.prepare('INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value);
}

export function audit(userId: number | null, username: string, action: string, target?: string, ip?: string, meta?: any) {
  try {
    db.prepare('INSERT INTO audit (user_id, username, action, target, ip, meta) VALUES (?,?,?,?,?,?)')
      .run(userId, username, action, target ?? null, ip ?? null, meta ? JSON.stringify(meta) : null);
  } catch { /* non-fatal */ }
}

export function notify(userId: number, title: string, body: string, level = 'info', link?: string) {
  const id = 'n_' + Math.random().toString(36).slice(2, 11);
  const ts = new Date().toISOString();
  db.prepare('INSERT INTO notifications (id,user_id,title,body,level,link) VALUES (?,?,?,?,?,?)')
    .run(id, userId, title, body, level, link ?? null);
  // Push live to any connected clients (SSE) — best-effort, never throws.
  import('../services/events.js').then(ev => ev.emit(userId, { type: 'notification', id, ts, title, body, level, link: link ?? null, read: false }))
    .catch(() => { /* events module optional */ });
}
