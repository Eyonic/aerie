import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { AERIE_MIGRATIONS, migrateDatabase, type DatabaseMigration } from '../src/lib/migrations.js';

function adapter(sqlite: DatabaseSync) {
  return {
    exec: (sql: string) => sqlite.exec(sql),
    prepare: (sql: string) => sqlite.prepare(sql),
    transaction: (operation: (...args: any[]) => any) => (...args: any[]) => {
      sqlite.exec('BEGIN IMMEDIATE');
      try { const result = operation(...args); sqlite.exec('COMMIT'); return result; }
      catch (error) { sqlite.exec('ROLLBACK'); throw error; }
    },
  };
}

const plan: DatabaseMigration[] = [{
  version: 1,
  name: 'fixture',
  fingerprint: 'fixture:v1',
  up(database) { database.exec('CREATE TABLE fixture (id INTEGER PRIMARY KEY)'); },
}];

test('migration ledger is transactional, idempotent and records user_version', () => {
  const sqlite = new DatabaseSync(':memory:');
  try {
    const database = adapter(sqlite);
    assert.equal(migrateDatabase(database, plan), 1);
    assert.equal(migrateDatabase(database, plan), 1);
    assert.equal((sqlite.prepare('SELECT COUNT(*) count FROM schema_migrations').get() as any).count, 1);
    assert.equal((sqlite.prepare('PRAGMA user_version').get() as any).user_version, 1);
  } finally { sqlite.close(); }
});

test('migration ledger rejects changed history and newer schemas', () => {
  const sqlite = new DatabaseSync(':memory:');
  try {
    const database = adapter(sqlite);
    migrateDatabase(database, plan);
    sqlite.prepare("UPDATE schema_migrations SET checksum='tampered' WHERE version=1").run();
    assert.throws(() => migrateDatabase(database, plan), /checksum_mismatch/);
    sqlite.prepare('DELETE FROM schema_migrations').run();
    sqlite.prepare("INSERT INTO schema_migrations(version,name,checksum) VALUES (2,'future','future')").run();
    assert.throws(() => migrateDatabase(database, plan), /newer_than_server/);
  } finally { sqlite.close(); }
});

test('household share migration enforces authenticated recipient grants and recoverable revocation', () => {
  const sqlite = new DatabaseSync(':memory:');
  try {
    sqlite.exec('PRAGMA foreign_keys=ON');
    const database = adapter(sqlite);
    const fixture: DatabaseMigration = {
      version: 1,
      name: 'fixture-users',
      fingerprint: 'fixture-users:v1',
      up(target) {
        target.exec('CREATE TABLE users (id INTEGER PRIMARY KEY)');
      },
    };
    migrateDatabase(database, [fixture, AERIE_MIGRATIONS[1]]);
    sqlite.exec('INSERT INTO users(id) VALUES (1),(2),(3)');
    const insert = sqlite.prepare(`INSERT INTO account_shares
      (id,owner_user_id,recipient_user_id,root_path,permission,created_by_user_id)
      VALUES (?,?,?,?,?,?)`);
    insert.run('as_viewer', 1, 2, '/Household', 'viewer', 1);
    insert.run('as_editor', 1, 3, '/Household', 'editor', 1);

    assert.throws(() => insert.run('as_self', 1, 1, '/Private', 'viewer', 1), /constraint/i);
    assert.throws(() => insert.run('as_invalid', 1, 2, '/Other', 'owner', 1), /constraint/i);
    assert.throws(() => insert.run('as_duplicate', 1, 2, '/Household', 'viewer', 1), /unique/i);

    sqlite.prepare("UPDATE account_shares SET revoked_at=datetime('now') WHERE id='as_viewer'").run();
    insert.run('as_regranted', 1, 2, '/Household', 'editor', 1);
    assert.equal((sqlite.prepare(`SELECT permission FROM account_shares
      WHERE owner_user_id=1 AND recipient_user_id=2 AND revoked_at IS NULL`).get() as any).permission, 'editor');
  } finally { sqlite.close(); }
});

test('photo albums keep ownership boundaries and remove album entries with deleted photos', () => {
  const sqlite = new DatabaseSync(':memory:');
  try {
    sqlite.exec(`PRAGMA foreign_keys=ON;
      CREATE TABLE users (id INTEGER PRIMARY KEY);
      CREATE TABLE photo_index (
        user_id INTEGER NOT NULL,
        rel_path TEXT NOT NULL,
        taken_at TEXT,
        PRIMARY KEY(user_id,rel_path)
      );
      INSERT INTO users(id) VALUES (1),(2);
      INSERT INTO photo_index(user_id,rel_path,taken_at) VALUES (1,'Photos/a.jpg','2026-01-01'),(2,'Photos/b.jpg','2026-01-02');
    `);
    const database = adapter(sqlite);
    database.transaction(() => AERIE_MIGRATIONS[3].up(database))();
    assert.equal((sqlite.prepare("SELECT name FROM pragma_table_info('photo_index') WHERE name='favorite'").get() as any).name, 'favorite');
    sqlite.prepare('INSERT INTO photo_albums(id,user_id,name) VALUES (?,?,?)').run('album-1', 1, 'Trip');
    sqlite.prepare('INSERT INTO photo_album_items(album_id,user_id,rel_path) VALUES (?,?,?)').run('album-1', 1, 'Photos/a.jpg');
    assert.throws(() => sqlite.prepare('INSERT INTO photo_album_items(album_id,user_id,rel_path) VALUES (?,?,?)')
      .run('album-1', 2, 'Photos/b.jpg'), /constraint/i);
    sqlite.prepare('DELETE FROM photo_index WHERE user_id=? AND rel_path=?').run(1, 'Photos/a.jpg');
    assert.equal((sqlite.prepare('SELECT COUNT(*) count FROM photo_album_items').get() as any).count, 0);
  } finally { sqlite.close(); }
});

test('private photo album shares enforce owner, recipient, and one active view-only grant', () => {
  const sqlite = new DatabaseSync(':memory:');
  try {
    sqlite.exec(`PRAGMA foreign_keys=ON;
      CREATE TABLE users (id INTEGER PRIMARY KEY);
      CREATE TABLE photo_albums (
        id TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL,
        UNIQUE(id,user_id),
        FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
      );
      INSERT INTO users(id) VALUES (1),(2),(3);
      INSERT INTO photo_albums(id,user_id) VALUES ('album-1',1);
    `);
    const database = adapter(sqlite);
    database.transaction(() => AERIE_MIGRATIONS[5].up(database))();
    const insert = sqlite.prepare(`INSERT INTO photo_album_shares
      (id,album_id,owner_user_id,recipient_user_id,created_by_user_id)
      VALUES (?,?,?,?,?)`);
    insert.run('share-1', 'album-1', 1, 2, 1);
    assert.throws(() => insert.run('share-self', 'album-1', 1, 1, 1), /constraint/i);
    assert.throws(() => insert.run('share-wrong-owner', 'album-1', 3, 2, 3), /constraint/i);
    assert.throws(() => insert.run('share-duplicate', 'album-1', 1, 2, 1), /unique/i);
    sqlite.prepare("UPDATE photo_album_shares SET revoked_at=datetime('now') WHERE id='share-1'").run();
    insert.run('share-regranted', 'album-1', 1, 2, 1);
    assert.equal((sqlite.prepare(`SELECT COUNT(*) count FROM photo_album_shares
      WHERE album_id='album-1' AND recipient_user_id=2 AND revoked_at IS NULL`).get() as any).count, 1);
    sqlite.prepare("DELETE FROM photo_albums WHERE id='album-1'").run();
    assert.equal((sqlite.prepare('SELECT COUNT(*) count FROM photo_album_shares').get() as any).count, 0);
  } finally { sqlite.close(); }
});

test('household invitation schema never requires storing a raw invitation token', () => {
  const sqlite = new DatabaseSync(':memory:');
  try {
    sqlite.exec('PRAGMA foreign_keys=ON; CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT); INSERT INTO users(id,username) VALUES (1,\'owner\');');
    const database = adapter(sqlite);
    database.transaction(() => AERIE_MIGRATIONS[4].up(database))();
    sqlite.prepare(`INSERT INTO user_invites
      (id,token_hash,created_by_user_id,role,ai_mode,expires_at)
      VALUES (?,?,?,?,?,?)`).run('invite-1', 'a'.repeat(64), 1, 'user', 'local_only', '2030-01-01T00:00:00.000Z');
    const columns = sqlite.prepare("SELECT name FROM pragma_table_info('user_invites') ORDER BY cid").all() as Array<{ name: string }>;
    assert.equal(columns.some(column => column.name === 'token'), false);
    assert.equal((sqlite.prepare('SELECT token_hash FROM user_invites WHERE id=?').get('invite-1') as any).token_hash.length, 64);
  } finally { sqlite.close(); }
});

test('migration 7 canonically adopts feature tables, preserves their rows, and bumps user_version', () => {
  const sqlite = new DatabaseSync(':memory:');
  try {
    sqlite.exec(`
      PRAGMA foreign_keys=ON;
      CREATE TABLE users (id INTEGER PRIMARY KEY);
      CREATE TABLE auth_sessions (id TEXT PRIMARY KEY);
      CREATE TABLE audit (action TEXT, target TEXT);
    `);
    const database = adapter(sqlite);
    const historical: DatabaseMigration[] = Array.from({ length: 6 }, (_, index) => ({
      version: index + 1,
      name: `fixture-${index + 1}`,
      fingerprint: `fixture-${index + 1}:v1`,
      up() {},
    }));
    migrateDatabase(database, historical);
    assert.equal((sqlite.prepare('PRAGMA user_version').get() as any).user_version, 6);

    // Representative tables are the exact import-time shapes used before v7.
    // The migration must adopt them in place rather than rebuild their data.
    sqlite.exec(`
      CREATE TABLE trusted_devices (
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
      CREATE TABLE device_presence (
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
      CREATE TABLE time_machine_snapshots (
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
      INSERT INTO users(id) VALUES (1);
      INSERT INTO trusted_devices
        (id,user_id,name,type,public_key,public_key_fingerprint,key_algorithm)
        VALUES ('device-1',1,'Laptop','desktop','public','fingerprint','Ed25519');
      INSERT INTO device_presence (device_id,user_id,name,type,expires_at)
        VALUES ('device-1',1,'Laptop','desktop','2030-01-01T00:00:00.000Z');
      INSERT INTO time_machine_snapshots
        (id,user_id,created_at,manifest_path,manifest_hash,entry_count,file_count,total_bytes)
        VALUES ('snapshot-1',1,'2026-01-01T00:00:00.000Z','/manifest-1','hash',2,1,42);
    `);
    const before = sqlite.prepare(`SELECT name,sql FROM sqlite_schema
      WHERE type='table' AND name IN ('trusted_devices','device_presence','time_machine_snapshots')
      ORDER BY name`).all();

    assert.equal(migrateDatabase(database, [...historical, AERIE_MIGRATIONS[6]]), 7);
    assert.equal((sqlite.prepare('PRAGMA user_version').get() as any).user_version, 7);
    assert.deepEqual(sqlite.prepare(`SELECT name,sql FROM sqlite_schema
      WHERE type='table' AND name IN ('trusted_devices','device_presence','time_machine_snapshots')
      ORDER BY name`).all(), before);
    assert.equal((sqlite.prepare("SELECT name FROM trusted_devices WHERE id='device-1'").get() as any).name, 'Laptop');
    assert.equal((sqlite.prepare("SELECT total_bytes FROM time_machine_snapshots WHERE id='snapshot-1'").get() as any).total_bytes, 42);

    const required = [
      'device_challenges', 'device_messages', 'device_pairings', 'device_presence',
      'device_session_links', 'mesh_tickets', 'time_machine_retention',
      'time_machine_snapshots', 'time_machine_tasks', 'trusted_devices',
    ];
    assert.deepEqual((sqlite.prepare(`SELECT name FROM sqlite_schema WHERE type='table'
      AND name IN (${required.map(() => '?').join(',')}) ORDER BY name`).all(...required) as Array<{ name: string }>)
      .map(row => row.name), [...required].sort());
    assert.equal((sqlite.prepare("SELECT 1 ok FROM sqlite_schema WHERE type='trigger' AND name='time_machine_snapshots_no_update'").get() as any).ok, 1);
    assert.equal((sqlite.prepare("SELECT 1 ok FROM sqlite_schema WHERE type='index' AND name='idx_audit_action_target'").get() as any).ok, 1);
  } finally { sqlite.close(); }
});
