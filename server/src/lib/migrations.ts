import crypto from 'node:crypto';
import { durableScheduleSchema } from './durable-schedule.js';

export interface MigrationDatabase {
  exec(sql: string): unknown;
  prepare(sql: string): { all(...params: any[]): any[]; get(...params: any[]): any; run(...params: any[]): any };
  transaction<T extends (...args: any[]) => any>(operation: T): T;
}

export interface DatabaseMigration {
  version: number;
  name: string;
  fingerprint: string;
  up(database: MigrationDatabase): void;
}

function checksum(migration: DatabaseMigration): string {
  return crypto.createHash('sha256')
    .update(`${migration.version}\n${migration.name}\n${migration.fingerprint}`)
    .digest('hex');
}

function addColumn(database: MigrationDatabase, table: string, column: string, definition: string) {
  const columns = database.prepare(`PRAGMA table_info(${table})`).all();
  if (!columns.some((item: any) => item.name === column)) {
    database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

const commonReadIndexes = `
CREATE INDEX IF NOT EXISTS idx_users_active_role ON users(disabled_at,role,id);
CREATE INDEX IF NOT EXISTS idx_trash_user_deleted ON trash(user_id,deleted_at DESC);
CREATE INDEX IF NOT EXISTS idx_shares_user_created ON shares(user_id,created_at DESC);
CREATE INDEX IF NOT EXISTS idx_versions_user_path_created ON versions(user_id,path,created_at DESC);
CREATE INDEX IF NOT EXISTS idx_jobs_user_status_created ON jobs(user_id,status,created_at DESC);
CREATE INDEX IF NOT EXISTS idx_jobs_queue ON jobs(type,status,created_at);
CREATE INDEX IF NOT EXISTS idx_generated_images_user_created ON generated_images(user_id,created_at DESC);
CREATE INDEX IF NOT EXISTS idx_generated_images_workflow ON generated_images(user_id,workflow,created_at);
CREATE INDEX IF NOT EXISTS idx_generated_music_user_created ON generated_music(user_id,created_at DESC);
CREATE INDEX IF NOT EXISTS idx_generated_music_queue ON generated_music(status,created_at);
CREATE INDEX IF NOT EXISTS idx_audit_user_ts ON audit(user_id,ts DESC);
CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit(ts DESC);
CREATE INDEX IF NOT EXISTS idx_devices_user_seen ON devices(user_id,last_seen DESC);
CREATE INDEX IF NOT EXISTS idx_notifications_user_ts ON notifications(user_id,ts DESC);
CREATE INDEX IF NOT EXISTS idx_subtitles_creator_created ON subtitles(created_by,created_at DESC);
CREATE INDEX IF NOT EXISTS idx_play_history_user_last ON play_history(user_id,last_ts DESC);
`;

export const AERIE_MIGRATIONS: DatabaseMigration[] = [
  {
    version: 1,
    name: 'baseline-security-storage-and-durable-scheduler',
    fingerprint: [
      'users:totp_secret,totp_pending_secret,totp_enabled,totp_recovery_codes,features,storage_id,disabled_at,avatar_version',
      'jobs:payload',
      'upload_sessions:reservation_id',
      'storage_reservations:physical_bytes',
      'scheduled_tasks:v1',
      'common-read-indexes:v1',
    ].join('|'),
    up(database) {
      addColumn(database, 'users', 'totp_secret', 'TEXT');
      addColumn(database, 'users', 'totp_pending_secret', 'TEXT');
      addColumn(database, 'users', 'totp_enabled', 'INTEGER NOT NULL DEFAULT 0');
      addColumn(database, 'users', 'totp_recovery_codes', "TEXT NOT NULL DEFAULT '[]'");
      addColumn(database, 'users', 'features', "TEXT NOT NULL DEFAULT '{}'");
      addColumn(database, 'users', 'storage_id', 'TEXT');
      addColumn(database, 'users', 'disabled_at', 'TEXT');
      addColumn(database, 'users', 'avatar_version', 'INTEGER NOT NULL DEFAULT 0');
      addColumn(database, 'jobs', 'payload', 'TEXT');
      addColumn(database, 'upload_sessions', 'reservation_id', 'TEXT');
      addColumn(database, 'storage_reservations', 'physical_bytes', 'INTEGER');
      database.exec(durableScheduleSchema);
      database.exec(commonReadIndexes);
    },
  },
  {
    version: 2,
    name: 'household-shared-spaces',
    fingerprint: [
      'account_shares:v1',
      'permission:viewer|editor',
      'soft-revocation:v1',
      'active-owner-recipient-root-unique:v1',
      'recipient-owner-active-indexes:v1',
    ].join('|'),
    up(database) {
      // Account-to-account grants are intentionally separate from the public
      // `shares` capability table.  Public links remain anonymous, read-only
      // capabilities; household grants always have an authenticated recipient.
      database.exec(`
        CREATE TABLE IF NOT EXISTS account_shares (
          id TEXT PRIMARY KEY,
          owner_user_id INTEGER NOT NULL,
          recipient_user_id INTEGER NOT NULL,
          root_path TEXT NOT NULL,
          permission TEXT NOT NULL CHECK(permission IN ('viewer','editor')),
          created_by_user_id INTEGER NOT NULL,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now')),
          revoked_at TEXT,
          FOREIGN KEY(owner_user_id) REFERENCES users(id) ON DELETE CASCADE,
          FOREIGN KEY(recipient_user_id) REFERENCES users(id) ON DELETE CASCADE,
          FOREIGN KEY(created_by_user_id) REFERENCES users(id) ON DELETE CASCADE,
          CHECK(owner_user_id <> recipient_user_id)
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_account_shares_active_unique
          ON account_shares(owner_user_id,recipient_user_id,root_path)
          WHERE revoked_at IS NULL;
        CREATE INDEX IF NOT EXISTS idx_account_shares_recipient_active
          ON account_shares(recipient_user_id,revoked_at,created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_account_shares_owner_active
          ON account_shares(owner_user_id,revoked_at,created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_account_shares_owner_path
          ON account_shares(owner_user_id,root_path,revoked_at);
      `);
    },
  },
  {
    version: 3,
    name: 'bounded-content-search-index',
    fingerprint: [
      'content_search_entries:generation-v1',
      'content_search_state:active-generation-v1',
      'content_search_fts:name|path|body',
      'content-search-user-generation-indexes:v1',
    ].join('|'),
    up(database) {
      // Content reconciliation writes a new generation while queries continue
      // to use the last complete one. Switching the active generation and
      // pruning its predecessor happen in one transaction, so an interrupted
      // scan can never replace a usable index with a partial result.
      database.exec(`
        CREATE TABLE IF NOT EXISTS content_search_entries (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL,
          scan_id TEXT NOT NULL,
          path TEXT NOT NULL,
          parent TEXT NOT NULL,
          name TEXT NOT NULL,
          extension TEXT NOT NULL,
          kind TEXT NOT NULL,
          size INTEGER NOT NULL,
          mtime_ms REAL NOT NULL,
          body TEXT NOT NULL,
          body_truncated INTEGER NOT NULL DEFAULT 0,
          FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
          UNIQUE(user_id,scan_id,path)
        );
        CREATE INDEX IF NOT EXISTS idx_content_search_generation
          ON content_search_entries(user_id,scan_id,path);
        CREATE INDEX IF NOT EXISTS idx_content_search_filter
          ON content_search_entries(user_id,scan_id,kind,mtime_ms DESC,path);

        CREATE TABLE IF NOT EXISTS content_search_state (
          user_id INTEGER PRIMARY KEY,
          active_scan_id TEXT,
          last_started_ms REAL NOT NULL DEFAULT 0,
          last_completed_ms REAL NOT NULL DEFAULT 0,
          invalidated_at_ms REAL NOT NULL DEFAULT 0,
          status TEXT NOT NULL DEFAULT 'idle',
          last_error TEXT,
          indexed_count INTEGER NOT NULL DEFAULT 0,
          skipped_count INTEGER NOT NULL DEFAULT 0,
          truncated_count INTEGER NOT NULL DEFAULT 0,
          indexed_chars INTEGER NOT NULL DEFAULT 0,
          FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
        );

        CREATE VIRTUAL TABLE IF NOT EXISTS content_search_fts USING fts5(
          name,
          path,
          body,
          content='content_search_entries',
          content_rowid='id',
          tokenize='unicode61 remove_diacritics 2'
        );
        CREATE TRIGGER IF NOT EXISTS content_search_fts_insert
        AFTER INSERT ON content_search_entries BEGIN
          INSERT INTO content_search_fts(rowid,name,path,body)
            VALUES (new.id,new.name,new.path,new.body);
        END;
        CREATE TRIGGER IF NOT EXISTS content_search_fts_delete
        AFTER DELETE ON content_search_entries BEGIN
          INSERT INTO content_search_fts(content_search_fts,rowid,name,path,body)
            VALUES ('delete',old.id,old.name,old.path,old.body);
        END;
        CREATE TRIGGER IF NOT EXISTS content_search_fts_update
        AFTER UPDATE OF name,path,body ON content_search_entries BEGIN
          INSERT INTO content_search_fts(content_search_fts,rowid,name,path,body)
            VALUES ('delete',old.id,old.name,old.path,old.body);
          INSERT INTO content_search_fts(rowid,name,path,body)
            VALUES (new.id,new.name,new.path,new.body);
        END;
      `);
    },
  },
  {
    version: 4,
    name: 'photo-albums-and-favourites',
    fingerprint: [
      'photo_index:favorite-v1',
      'photo_albums:v1',
      'photo_album_items:v1',
      'album-owner-and-photo-integrity:v1',
    ].join('|'),
    up(database) {
      addColumn(database, 'photo_index', 'favorite', 'INTEGER NOT NULL DEFAULT 0');
      database.exec(`
        CREATE INDEX IF NOT EXISTS idx_photo_favorites
          ON photo_index(user_id,favorite,taken_at DESC,rel_path);

        CREATE TABLE IF NOT EXISTS photo_albums (
          id TEXT PRIMARY KEY,
          user_id INTEGER NOT NULL,
          name TEXT NOT NULL,
          description TEXT NOT NULL DEFAULT '',
          cover_path TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now')),
          FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
          UNIQUE(id,user_id)
        );
        CREATE INDEX IF NOT EXISTS idx_photo_albums_user_updated
          ON photo_albums(user_id,updated_at DESC,name);

        CREATE TABLE IF NOT EXISTS photo_album_items (
          album_id TEXT NOT NULL,
          user_id INTEGER NOT NULL,
          rel_path TEXT NOT NULL,
          added_at TEXT NOT NULL DEFAULT (datetime('now')),
          PRIMARY KEY(album_id,rel_path),
          FOREIGN KEY(album_id,user_id) REFERENCES photo_albums(id,user_id) ON DELETE CASCADE,
          FOREIGN KEY(user_id,rel_path) REFERENCES photo_index(user_id,rel_path) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_photo_album_items_photo
          ON photo_album_items(user_id,rel_path,album_id);
      `);
    },
  },
  {
    version: 5,
    name: 'one-time-household-invitations',
    fingerprint: [
      'user_invites:v1',
      'sha256-token-only:v1',
      'expiry-revocation-single-use:v1',
      'preset-role-quota-ai-features:v1',
    ].join('|'),
    up(database) {
      database.exec(`
        CREATE TABLE IF NOT EXISTS user_invites (
          id TEXT PRIMARY KEY,
          token_hash TEXT NOT NULL UNIQUE,
          created_by_user_id INTEGER NOT NULL,
          display_name TEXT NOT NULL DEFAULT '',
          email TEXT,
          role TEXT NOT NULL CHECK(role IN ('admin','user')),
          storage_quota_bytes INTEGER,
          ai_mode TEXT NOT NULL,
          features TEXT NOT NULL DEFAULT '{}',
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          expires_at TEXT NOT NULL,
          used_at TEXT,
          used_by_user_id INTEGER,
          revoked_at TEXT,
          FOREIGN KEY(created_by_user_id) REFERENCES users(id) ON DELETE CASCADE,
          FOREIGN KEY(used_by_user_id) REFERENCES users(id) ON DELETE SET NULL
        );
        CREATE INDEX IF NOT EXISTS idx_user_invites_active
          ON user_invites(revoked_at,used_at,expires_at,created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_user_invites_creator
          ON user_invites(created_by_user_id,created_at DESC);
      `);
    },
  },
  {
    version: 6,
    name: 'private-household-photo-album-sharing',
    fingerprint: [
      'photo_album_shares:v1',
      'authenticated-recipient-view-only:v1',
      'soft-revocation:v1',
      'owner-album-recipient-active-unique:v1',
    ].join('|'),
    up(database) {
      database.exec(`
        CREATE TABLE IF NOT EXISTS photo_album_shares (
          id TEXT PRIMARY KEY,
          album_id TEXT NOT NULL,
          owner_user_id INTEGER NOT NULL,
          recipient_user_id INTEGER NOT NULL,
          created_by_user_id INTEGER NOT NULL,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          revoked_at TEXT,
          FOREIGN KEY(album_id,owner_user_id) REFERENCES photo_albums(id,user_id) ON DELETE CASCADE,
          FOREIGN KEY(recipient_user_id) REFERENCES users(id) ON DELETE CASCADE,
          FOREIGN KEY(created_by_user_id) REFERENCES users(id) ON DELETE CASCADE,
          CHECK(owner_user_id <> recipient_user_id)
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_photo_album_shares_active_unique
          ON photo_album_shares(album_id,owner_user_id,recipient_user_id) WHERE revoked_at IS NULL;
        CREATE INDEX IF NOT EXISTS idx_photo_album_shares_recipient
          ON photo_album_shares(recipient_user_id,revoked_at,created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_photo_album_shares_owner
          ON photo_album_shares(owner_user_id,album_id,revoked_at,created_at DESC);
      `);
    },
  },
  {
    version: 7,
    name: 'trusted-device-fabric-and-time-machine',
    fingerprint: [
      'trusted-devices:v1',
      'device-pairings-challenges-sessions:v1',
      'device-presence-messages-mesh-tickets:v1',
      'time-machine-immutable-snapshots-retention-tasks:v1',
      'adopt-existing-import-time-tables-without-rewrite:v1',
      'audit-action-target-index:v1',
    ].join('|'),
    up(database) {
      // These definitions deliberately match the feature-owned bootstrap SQL
      // shipped before migration 7. CREATE IF NOT EXISTS adopts those tables
      // and their rows in place; it does not rebuild or rewrite user data.
      database.exec(`
        CREATE INDEX IF NOT EXISTS idx_audit_action_target ON audit(action,target);

        CREATE TABLE IF NOT EXISTS trusted_devices (
          id TEXT PRIMARY KEY,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          name TEXT NOT NULL,
          type TEXT NOT NULL,
          public_key TEXT NOT NULL,
          public_key_fingerprint TEXT NOT NULL,
          key_algorithm TEXT NOT NULL,
          capabilities TEXT NOT NULL DEFAULT '[]',
          paired_by_session_id TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          last_seen TEXT NOT NULL DEFAULT (datetime('now')),
          revoked_at TEXT
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_trusted_devices_active_key
          ON trusted_devices(user_id, public_key_fingerprint) WHERE revoked_at IS NULL;
        CREATE INDEX IF NOT EXISTS idx_trusted_devices_user
          ON trusted_devices(user_id, last_seen DESC);

        CREATE TABLE IF NOT EXISTS device_pairings (
          id TEXT PRIMARY KEY,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          code_digest TEXT NOT NULL UNIQUE,
          requested_name TEXT NOT NULL,
          requested_type TEXT NOT NULL,
          requested_capabilities TEXT NOT NULL DEFAULT '[]',
          device_id TEXT,
          device_name TEXT,
          device_type TEXT,
          public_key TEXT,
          public_key_fingerprint TEXT,
          key_algorithm TEXT,
          capabilities TEXT,
          paired_by_session_id TEXT,
          attempt_count INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          expires_at TEXT NOT NULL,
          claimed_at TEXT,
          completed_at TEXT,
          cancelled_at TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_device_pairings_user
          ON device_pairings(user_id, created_at DESC);

        CREATE TABLE IF NOT EXISTS device_challenges (
          id TEXT PRIMARY KEY,
          device_id TEXT NOT NULL,
          pairing_id TEXT,
          purpose TEXT NOT NULL CHECK (purpose IN ('pair','authenticate')),
          nonce TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          expires_at TEXT NOT NULL,
          consumed_at TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_device_challenges_device
          ON device_challenges(device_id, created_at DESC);

        CREATE TABLE IF NOT EXISTS device_session_links (
          session_id TEXT PRIMARY KEY REFERENCES auth_sessions(id) ON DELETE CASCADE,
          device_id TEXT NOT NULL REFERENCES trusted_devices(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_device_session_links_device
          ON device_session_links(device_id);

        CREATE TABLE IF NOT EXISTS device_presence (
          device_id TEXT PRIMARY KEY,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          session_id TEXT,
          name TEXT NOT NULL,
          type TEXT NOT NULL,
          capabilities TEXT NOT NULL DEFAULT '[]',
          activity TEXT,
          mesh_endpoints TEXT NOT NULL DEFAULT '[]',
          last_seen TEXT NOT NULL DEFAULT (datetime('now')),
          expires_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_device_presence_user ON device_presence(user_id,last_seen DESC);

        CREATE TABLE IF NOT EXISTS device_messages (
          id TEXT PRIMARY KEY,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          source_device_id TEXT NOT NULL,
          target_device_id TEXT NOT NULL,
          kind TEXT NOT NULL,
          payload TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          expires_at TEXT NOT NULL,
          delivered_at TEXT,
          acknowledged_at TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_device_messages_target
          ON device_messages(user_id,target_device_id,acknowledged_at,created_at);

        CREATE TABLE IF NOT EXISTS mesh_tickets (
          token_hash TEXT PRIMARY KEY,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          source_device_id TEXT NOT NULL,
          target_device_id TEXT NOT NULL,
          resource TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          expires_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS time_machine_snapshots (
          id TEXT PRIMARY KEY,
          user_id INTEGER NOT NULL,
          created_at TEXT NOT NULL,
          label TEXT,
          manifest_path TEXT NOT NULL UNIQUE,
          manifest_hash TEXT NOT NULL,
          entry_count INTEGER NOT NULL,
          file_count INTEGER NOT NULL,
          total_bytes INTEGER NOT NULL,
          warning_count INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS idx_time_machine_snapshots_user_created
          ON time_machine_snapshots(user_id, created_at DESC);
        CREATE TRIGGER IF NOT EXISTS time_machine_snapshots_no_update
        BEFORE UPDATE ON time_machine_snapshots
        BEGIN
          SELECT RAISE(ABORT, 'time_machine_snapshots_are_immutable');
        END;

        CREATE TABLE IF NOT EXISTS time_machine_retention (
          user_id INTEGER PRIMARY KEY,
          enabled INTEGER NOT NULL DEFAULT 1,
          interval_hours INTEGER NOT NULL DEFAULT 24,
          hourly_hours INTEGER NOT NULL DEFAULT 48,
          daily_days INTEGER NOT NULL DEFAULT 30,
          weekly_weeks INTEGER NOT NULL DEFAULT 12,
          monthly_months INTEGER NOT NULL DEFAULT 12,
          minimum_snapshots INTEGER NOT NULL DEFAULT 3,
          maximum_bytes INTEGER,
          last_snapshot_at TEXT
        );

        CREATE TABLE IF NOT EXISTS time_machine_tasks (
          id TEXT PRIMARY KEY,
          user_id INTEGER NOT NULL,
          status TEXT NOT NULL DEFAULT 'queued',
          label TEXT,
          current_path TEXT,
          processed_files INTEGER NOT NULL DEFAULT 0,
          processed_bytes INTEGER NOT NULL DEFAULT 0,
          snapshot_id TEXT,
          error TEXT,
          created_at TEXT NOT NULL,
          started_at TEXT,
          finished_at TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_time_machine_tasks_user_created
          ON time_machine_tasks(user_id, created_at DESC);
      `);
    },
  },
];

export function migrateDatabase(
  database: MigrationDatabase,
  migrations: DatabaseMigration[] = AERIE_MIGRATIONS,
): number {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      checksum TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  const ordered = [...migrations].sort((a, b) => a.version - b.version);
  if (ordered.some((item, index) => item.version !== index + 1)) {
    throw new Error('database_migration_sequence_invalid');
  }
  const latest = ordered.at(-1)?.version || 0;
  const initialVersion = Number((database.prepare('PRAGMA user_version').get() as any)?.user_version || 0);
  if (initialVersion > latest) throw new Error('database_schema_newer_than_server');
  const known = new Map(ordered.map(item => [item.version, item]));
  const applied = database.prepare('SELECT version,name,checksum FROM schema_migrations ORDER BY version').all() as any[];
  for (const row of applied) {
    const migration = known.get(Number(row.version));
    if (!migration) throw new Error('database_schema_newer_than_server');
    if (row.name !== migration.name || row.checksum !== checksum(migration)) {
      throw new Error(`database_migration_checksum_mismatch_${migration.version}`);
    }
  }

  const appliedVersions = new Set(applied.map(row => Number(row.version)));
  for (const migration of ordered) {
    if (appliedVersions.has(migration.version)) continue;
    database.transaction(() => {
      migration.up(database);
      database.prepare('INSERT INTO schema_migrations (version,name,checksum) VALUES (?,?,?)')
        .run(migration.version, migration.name, checksum(migration));
      database.exec(`PRAGMA user_version = ${migration.version}`);
    })();
  }

  const current = Number((database.prepare('PRAGMA user_version').get() as any)?.user_version || 0);
  if (current > latest) throw new Error('database_schema_newer_than_server');
  if (current !== latest) database.exec(`PRAGMA user_version = ${latest}`);
  return latest;
}
