import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';

import {
  createDatabaseCutoverSnapshot,
  restoreDatabaseCutoverSnapshot,
  verifyDatabaseCutoverSnapshot,
} from '../src/services/database-cutover.js';

test('cutover snapshot captures committed WAL pages and atomically restores the pre-migration database', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'aerie-cutover-'));
  const live = path.join(root, 'cloudbox.db');
  const snapshot = path.join(root, 'rollback', 'cloudbox.db');
  const manifest = path.join(root, 'rollback', 'manifest.json');
  let database: Database.Database | undefined;
  try {
    database = new Database(live);
    database.pragma('journal_mode = WAL');
    database.pragma('wal_autocheckpoint = 0');
    database.exec(`
      CREATE TABLE records (id INTEGER PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO records(value) VALUES ('before-migration');
      PRAGMA user_version = 6;
    `);
    assert.equal(await fsp.stat(live + '-wal').then(stat => stat.size > 0), true);

    const captured = await createDatabaseCutoverSnapshot(live, snapshot, manifest);
    assert.equal(captured.userVersion, 6);
    assert.equal((await verifyDatabaseCutoverSnapshot(snapshot, manifest)).sha256, captured.sha256);
    const snapshotDatabase = new Database(snapshot, { readonly: true });
    try {
      assert.equal((snapshotDatabase.prepare('SELECT value FROM records').get() as any).value, 'before-migration');
    } finally { snapshotDatabase.close(); }

    database.exec("ALTER TABLE records ADD COLUMN migrated INTEGER NOT NULL DEFAULT 1; INSERT INTO records(value) VALUES ('candidate-write'); PRAGMA user_version = 7;");
    database.close();
    database = undefined;

    const restored = await restoreDatabaseCutoverSnapshot(snapshot, manifest, live);
    assert.equal(restored.userVersion, 6);
    const oldDatabase = new Database(live, { readonly: true });
    try {
      assert.equal(oldDatabase.pragma('user_version', { simple: true }), 6);
      assert.deepEqual(oldDatabase.prepare('SELECT id,value FROM records ORDER BY id').all(), [
        { id: 1, value: 'before-migration' },
      ]);
      assert.equal(oldDatabase.prepare("SELECT 1 FROM pragma_table_info('records') WHERE name='migrated'").get(), undefined);
    } finally { oldDatabase.close(); }
  } finally {
    database?.close();
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('a damaged rollback snapshot fails closed without replacing the live database', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'aerie-cutover-damaged-'));
  const live = path.join(root, 'cloudbox.db');
  const snapshot = path.join(root, 'rollback', 'cloudbox.db');
  const manifest = path.join(root, 'rollback', 'manifest.json');
  try {
    const database = new Database(live);
    database.exec("CREATE TABLE records(value TEXT); INSERT INTO records VALUES ('original'); PRAGMA user_version=6;");
    database.close();
    await createDatabaseCutoverSnapshot(live, snapshot, manifest);

    const candidate = new Database(live);
    candidate.exec("DELETE FROM records; INSERT INTO records VALUES ('candidate'); PRAGMA user_version=7;");
    candidate.close();
    await fsp.appendFile(snapshot, 'tamper');

    await assert.rejects(
      () => restoreDatabaseCutoverSnapshot(snapshot, manifest, live),
      /cutover_snapshot_(size|hash)_mismatch/,
    );
    const unchanged = new Database(live, { readonly: true });
    try {
      assert.equal(unchanged.pragma('user_version', { simple: true }), 7);
      assert.equal((unchanged.prepare('SELECT value FROM records').get() as any).value, 'candidate');
    } finally { unchanged.close(); }
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});
