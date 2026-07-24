// SQLite metadata store: users, sessions, stars, shares, versions, jobs,
// audit log, devices, automations, notifications, settings, watch-progress.
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { config } from '../config.js';
import { privateCanary } from '../runtime-mode.js';
import { validatePassword, validateUsername } from './validation.js';
import { reconcileAutomationCatalog } from './automation-catalog.js';
import { migrateDatabase } from './migrations.js';
import { bootstrapPersistenceDirectories } from './persistence-bootstrap.js';

bootstrapPersistenceDirectories();

export const db = new Database(config.dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  storage_id TEXT UNIQUE,
  display_name TEXT NOT NULL,
  email TEXT,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user',
  avatar_color TEXT NOT NULL DEFAULT '#6366f1',
  storage_quota_bytes INTEGER,
  ai_mode TEXT NOT NULL DEFAULT 'local_only',
  settings TEXT NOT NULL DEFAULT '{}',
  disabled_at TEXT,
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
  payload TEXT,
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

CREATE TABLE IF NOT EXISTS drive_credentials (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  secret_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_used_at TEXT,
  revoked_at TEXT,
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_drive_credentials_user ON drive_credentials(user_id, created_at DESC);

-- Sync Fabric keeps stable file identities separate from the append-only
-- change journal.  Putting the schema in the central bootstrap means every
-- process (scheduler, WebDAV and API workers included) sees the same model
-- before importing the sync service.
CREATE TABLE IF NOT EXISTS sync_entries (
  stable_id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  base TEXT NOT NULL,
  rel_path TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  size INTEGER NOT NULL,
  mtime_ms REAL NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_sync_entries_active_path
  ON sync_entries(user_id, base, rel_path) WHERE deleted=0;
CREATE INDEX IF NOT EXISTS idx_sync_entries_user_base
  ON sync_entries(user_id, base, deleted, rel_path);

CREATE TABLE IF NOT EXISTS sync_changes (
  cursor INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  base TEXT NOT NULL,
  stable_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('upsert','rename','delete')),
  rel_path TEXT NOT NULL,
  previous_rel_path TEXT,
  content_hash TEXT NOT NULL,
  size INTEGER NOT NULL,
  mtime_ms REAL NOT NULL,
  origin_device TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_sync_changes_cursor
  ON sync_changes(user_id, base, cursor);
CREATE INDEX IF NOT EXISTS idx_sync_changes_stable
  ON sync_changes(user_id, stable_id, cursor);

-- A cursor is durable only after a named client confirms that it has applied
-- the corresponding page.  Per-base records let compaction discard history
-- that every active client has consumed without conflating unrelated roots.
CREATE TABLE IF NOT EXISTS sync_device_cursors (
  user_id INTEGER NOT NULL,
  base TEXT NOT NULL,
  device_id TEXT NOT NULL,
  ack_cursor INTEGER NOT NULL DEFAULT 0,
  last_seen TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, base, device_id),
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_sync_device_cursors_seen
  ON sync_device_cursors(user_id, base, last_seen);

-- When old change rows are compacted, their high-water mark must survive.
-- Otherwise an empty retained journal would look like cursor zero and a stale
-- client could silently miss tombstones instead of requesting a full manifest.
CREATE TABLE IF NOT EXISTS sync_journal_state (
  user_id INTEGER NOT NULL,
  base TEXT NOT NULL,
  compacted_through INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, base),
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
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

CREATE TABLE IF NOT EXISTS playback_progress (
  user_id INTEGER NOT NULL,
  item_id TEXT NOT NULL,
  media TEXT NOT NULL,
  position_ticks INTEGER NOT NULL DEFAULT 0,
  duration_ticks INTEGER NOT NULL DEFAULT 0,
  played INTEGER NOT NULL DEFAULT 0,
  series_id TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, item_id)
);
CREATE INDEX IF NOT EXISTS idx_pp_user ON playback_progress(user_id, updated_at DESC);

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

-- Persistent per-user filesystem catalog. Reconciliation writes a fresh scan
-- marker as it walks, then removes older markers only after the whole walk has
-- completed. This keeps the last usable catalog intact after partial scans.
CREATE TABLE IF NOT EXISTS file_catalog (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  path TEXT NOT NULL,
  parent TEXT NOT NULL,
  name TEXT NOT NULL,
  name_folded TEXT NOT NULL,
  name_length INTEGER NOT NULL,
  extension TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL DEFAULT 0,
  mtime_ms REAL NOT NULL,
  birthtime_ms REAL NOT NULL,
  is_folder INTEGER NOT NULL DEFAULT 0,
  scan_id TEXT NOT NULL,
  UNIQUE (user_id, path),
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_file_catalog_scan
  ON file_catalog(user_id, scan_id);
CREATE INDEX IF NOT EXISTS idx_file_catalog_recent
  ON file_catalog(user_id, is_folder, mtime_ms DESC, path);
CREATE INDEX IF NOT EXISTS idx_file_catalog_size
  ON file_catalog(user_id, is_folder, size DESC, path);
CREATE INDEX IF NOT EXISTS idx_file_catalog_kind
  ON file_catalog(user_id, is_folder, kind, mtime_ms DESC, path);
CREATE INDEX IF NOT EXISTS idx_file_catalog_extension
  ON file_catalog(user_id, is_folder, extension, mtime_ms DESC, path);
CREATE INDEX IF NOT EXISTS idx_file_catalog_name
  ON file_catalog(user_id, name_folded, path);
CREATE INDEX IF NOT EXISTS idx_file_catalog_name_length
  ON file_catalog(user_id, name_length, name_folded, path);

CREATE TABLE IF NOT EXISTS file_catalog_state (
  user_id INTEGER PRIMARY KEY,
  last_started_ms REAL NOT NULL DEFAULT 0,
  last_completed_ms REAL NOT NULL DEFAULT 0,
  invalidated_at_ms REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'idle',
  last_error TEXT,
  file_count INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- FTS supplies indexed token/prefix candidates for universal search. The
-- relational catalog remains authoritative and enforces user isolation.
CREATE VIRTUAL TABLE IF NOT EXISTS file_catalog_fts USING fts5(
  name,
  path,
  content='file_catalog',
  content_rowid='id',
  tokenize='unicode61 remove_diacritics 2'
);
CREATE TRIGGER IF NOT EXISTS file_catalog_fts_insert AFTER INSERT ON file_catalog BEGIN
  INSERT INTO file_catalog_fts(rowid, name, path) VALUES (new.id, new.name, new.path);
END;
CREATE TRIGGER IF NOT EXISTS file_catalog_fts_delete AFTER DELETE ON file_catalog BEGIN
  INSERT INTO file_catalog_fts(file_catalog_fts, rowid, name, path)
    VALUES ('delete', old.id, old.name, old.path);
END;
CREATE TRIGGER IF NOT EXISTS file_catalog_fts_update AFTER UPDATE OF name, path ON file_catalog
WHEN old.name<>new.name OR old.path<>new.path BEGIN
  INSERT INTO file_catalog_fts(file_catalog_fts, rowid, name, path)
    VALUES ('delete', old.id, old.name, old.path);
  INSERT INTO file_catalog_fts(rowid, name, path) VALUES (new.id, new.name, new.path);
END;

CREATE TABLE IF NOT EXISTS file_hashes (
  user_id INTEGER NOT NULL,
  rel_path TEXT NOT NULL,
  size INTEGER NOT NULL,
  mtime INTEGER NOT NULL,
  hash TEXT NOT NULL,
  PRIMARY KEY (user_id, rel_path)
);

CREATE TABLE IF NOT EXISTS dedup_removed (
  user_id INTEGER NOT NULL,
  rel_path TEXT NOT NULL,
  size INTEGER NOT NULL,
  hash TEXT NOT NULL,
  removed_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, rel_path)
);

CREATE TABLE IF NOT EXISTS auth_sessions (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  device_name TEXT NOT NULL DEFAULT 'Web browser',
  device_type TEXT NOT NULL DEFAULT 'web',
  ip TEXT,
  user_agent TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL,
  revoked_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_auth_sessions_user ON auth_sessions(user_id, last_seen DESC);

CREATE TABLE IF NOT EXISTS skip_segments (
  item_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  start_sec REAL NOT NULL,
  end_sec REAL NOT NULL,
  source TEXT NOT NULL DEFAULT 'manual',
  updated_by INTEGER,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (item_id, kind)
);

CREATE TABLE IF NOT EXISTS smart_collections (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  rule TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_smart_collections_user ON smart_collections(user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS sync_conflicts (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  base TEXT NOT NULL,
  rel_path TEXT NOT NULL,
  device_size INTEGER,
  device_mtime INTEGER,
  server_size INTEGER,
  server_mtime INTEGER,
  status TEXT NOT NULL DEFAULT 'open',
  resolution TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_sync_conflicts_user ON sync_conflicts(user_id, status, updated_at DESC);

CREATE TABLE IF NOT EXISTS upload_sessions (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  dest_path TEXT NOT NULL,
  display_path TEXT NOT NULL,
  total_size INTEGER NOT NULL,
  received_size INTEGER NOT NULL DEFAULT 0,
  last_modified INTEGER,
  status TEXT NOT NULL DEFAULT 'uploading',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_upload_sessions_user ON upload_sessions(user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS storage_reservations (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  bytes INTEGER NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_storage_reservations_user ON storage_reservations(user_id,expires_at);

CREATE TABLE IF NOT EXISTS storage_operations (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  kind TEXT NOT NULL,
  path TEXT NOT NULL,
  stage_path TEXT,
  status TEXT NOT NULL DEFAULT 'staged',
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_storage_operations_status ON storage_operations(status,updated_at);

CREATE TABLE IF NOT EXISTS alert_events (
  id TEXT PRIMARY KEY,
  service TEXT NOT NULL,
  level TEXT NOT NULL DEFAULT 'warning',
  title TEXT NOT NULL,
  body TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_alert_events_created ON alert_events(created_at DESC);
`);

// Every change after the base CREATE TABLE declarations is ordered, checksummed
// and transactional. A newer database fails closed instead of being opened by
// an older binary after an unsafe rollback.
migrateDatabase(db);

// ---------- Seed default admin ----------
function seed() {
  const count = (db.prepare('SELECT COUNT(*) c FROM users').get() as any).c;
  if (count === 0) {
    const insert = db.prepare(`INSERT INTO users
      (username, storage_id, display_name, email, password_hash, role, avatar_color, ai_mode)
      VALUES (?,?,?,?,?,?,?,?)`);
    // First-run admin. Set ADMIN_USER/ADMIN_PASSWORD in the env to choose your
    // own; without ADMIN_PASSWORD a random one is generated and printed ONCE
    // to the container log — change it in Settings after logging in.
    const adminUser = validateUsername(process.env.ADMIN_USER || 'admin');
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
    validatePassword(adminPass);
    insert.run(adminUser, crypto.randomUUID(), 'Admin', null,
      bcrypt.hashSync(adminPass, 12), 'admin', '#6366f1', 'local_only');
    // Optional try-it-out account, opt-in only.
    if (process.env.SEED_DEMO === '1') {
      let demoPass = process.env.DEMO_PASSWORD || '';
      if (!demoPass) {
        demoPass = crypto.randomBytes(12).toString('base64url');
        console.log(`  demo password: ${demoPass} (change it after login)`);
      }
      validatePassword(demoPass);
      insert.run('demo', crypto.randomUUID(), 'Demo User', null,
        bcrypt.hashSync(demoPass, 12), 'user', '#ec4899', 'ask_before_send');
    }
  }
}
seed();
reconcileAutomationCatalog(db);

// Existing releases stored files under /files/<username>. Move each safe root
// once to an immutable UUID directory. A same-filesystem rename is atomic; on
// any ambiguity/failure we leave the old directory untouched and retain the
// old key so an upgrade can never make user data disappear.
function migrateStorageIds() {
  const root = path.resolve(config.filesRoot);
  fs.mkdirSync(root, { recursive: true });
  const users = db.prepare('SELECT id,username,storage_id FROM users').all() as any[];
  const set = db.prepare('UPDATE users SET storage_id=? WHERE id=? AND storage_id IS NULL');
  for (const user of users) {
    if (user.storage_id) continue;
    const legacy = path.resolve(root, user.username);
    const safeLegacy = legacy.startsWith(root + path.sep);
    const storageId = crypto.randomUUID();
    const destination = path.join(root, storageId);
    try {
      if (safeLegacy && fs.existsSync(legacy)) {
        const st = fs.lstatSync(legacy);
        if (st.isSymbolicLink() || !st.isDirectory()) throw new Error('unsafe legacy root');
        if (fs.existsSync(destination)) throw new Error('storage destination already exists');
        fs.renameSync(legacy, destination);
      }
      set.run(storageId, user.id);
    } catch (error: any) {
      if (safeLegacy) {
        set.run(user.username, user.id);
        console.warn(`[storage migration] retained legacy root for user ${user.id}: ${String(error?.message || error)}`);
      } else {
        set.run(storageId, user.id);
        console.warn(`[storage migration] unsafe legacy username for user ${user.id}; old path was not accessed`);
      }
    }
  }
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_storage_id ON users(storage_id)');
}
// A private deployment canary must exercise the real schema path without
// renaming user directories. If it fails, deploy/run.sh restores the v6 DB;
// leaving a renamed /files root behind would make that rollback inconsistent.
if (!privateCanary) migrateStorageIds();

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
  const id = 'n_' + crypto.randomUUID();
  const ts = new Date().toISOString();
  db.prepare('INSERT INTO notifications (id,user_id,title,body,level,link) VALUES (?,?,?,?,?,?)')
    .run(id, userId, title, body, level, link ?? null);
  db.prepare(`DELETE FROM notifications WHERE user_id=? AND rowid NOT IN
    (SELECT rowid FROM notifications WHERE user_id=? ORDER BY ts DESC,rowid DESC LIMIT 1000)`)
    .run(userId, userId);
  // Push live to any connected clients (SSE) — best-effort, never throws.
  import('../services/events.js').then(ev => ev.emit(userId, { type: 'notification', id, ts, title, body, level, link: link ?? null, read: false }))
    .catch(() => { /* events module optional */ });
}
