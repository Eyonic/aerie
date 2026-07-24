import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { mock } from 'node:test';
import { DatabaseSync } from 'node:sqlite';

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'aerie-time-machine-test-'));
process.env.DATA_DIR = path.join(sandbox, 'data');
process.env.FILES_ROOT = path.join(sandbox, 'files');
process.env.ADMIN_PASSWORD = 'time-machine-test-password';

// The repository's better-sqlite3 binary targets the production Node 22 image,
// while tests may run under another local ABI. node:sqlite implements the small
// synchronous API surface this service uses, so lifecycle tests stay portable.
const sqlite = new DatabaseSync(path.join(sandbox, 'time-machine-test.db'));
const testDb = {
  exec: (sql: string) => sqlite.exec(sql),
  prepare: (sql: string) => sqlite.prepare(sql),
  transaction: (operation: (...args: any[]) => any) => (...args: any[]) => {
    sqlite.exec('BEGIN IMMEDIATE');
    try { const result = operation(...args); sqlite.exec('COMMIT'); return result; }
    catch (error) { sqlite.exec('ROLLBACK'); throw error; }
  },
};
mock.module(new URL('../src/lib/db.js', import.meta.url).href, {
  namedExports: { db: testDb, getSetting: (_key: string, fallback = '') => fallback },
});
mock.module(new URL('../src/services/file-catalog.js', import.meta.url).href, {
  namedExports: { markFileCatalogStale: (_userId: number) => {} },
});
testDb.exec(`
CREATE TABLE users (
  id INTEGER PRIMARY KEY, username TEXT NOT NULL UNIQUE, storage_id TEXT,
  storage_quota_bytes INTEGER, disabled_at TEXT
);
CREATE TABLE audit (action TEXT, target TEXT);
INSERT INTO users (id,username,storage_id,storage_quota_bytes,disabled_at) VALUES (101,'alice','alice',NULL,NULL);
CREATE TABLE versions (id TEXT PRIMARY KEY,user_id INTEGER,path TEXT,stored_path TEXT,author TEXT,size_bytes INTEGER);
CREATE TABLE trash (id TEXT PRIMARY KEY,user_id INTEGER,trashed_path TEXT);
CREATE TABLE generated_images (id TEXT PRIMARY KEY,user_id INTEGER,filename TEXT);
CREATE TABLE generated_music (id TEXT PRIMARY KEY,user_id INTEGER,filename TEXT);
CREATE TABLE subtitles (id TEXT PRIMARY KEY,created_by INTEGER,filename TEXT);
CREATE TABLE storage_reservations (
  id TEXT PRIMARY KEY,user_id INTEGER NOT NULL,bytes INTEGER NOT NULL,physical_bytes INTEGER,
  expires_at TEXT NOT NULL,created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE sync_entries (
  stable_id TEXT PRIMARY KEY, user_id INTEGER NOT NULL, base TEXT NOT NULL, rel_path TEXT NOT NULL,
  content_hash TEXT NOT NULL, size INTEGER NOT NULL, mtime_ms REAL NOT NULL, deleted INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX idx_sync_entries_active_path ON sync_entries(user_id,base,rel_path) WHERE deleted=0;
CREATE TABLE sync_changes (
  cursor INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, base TEXT NOT NULL, stable_id TEXT NOT NULL,
  kind TEXT NOT NULL, rel_path TEXT NOT NULL, previous_rel_path TEXT, content_hash TEXT NOT NULL, size INTEGER NOT NULL,
  mtime_ms REAL NOT NULL, origin_device TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE sync_device_cursors (
  user_id INTEGER NOT NULL, base TEXT NOT NULL, device_id TEXT NOT NULL,
  ack_cursor INTEGER NOT NULL DEFAULT 0, last_seen TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id,base,device_id)
);
CREATE TABLE sync_journal_state (
  user_id INTEGER NOT NULL, base TEXT NOT NULL, compacted_through INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')), PRIMARY KEY (user_id,base)
);
`);
const { AERIE_MIGRATIONS } = await import('../src/lib/migrations.js');
AERIE_MIGRATIONS[6].up(testDb);
const { bootstrapPersistenceDirectories } = await import('../src/lib/persistence-bootstrap.js');
bootstrapPersistenceDirectories();

const timeMachine = await import('../src/services/time-machine.js');
const syncFabric = await import('../src/services/sync-fabric.js');
const storageWrites = await import('../src/services/storage-write.js');

const username = 'alice';
const userId = 101;
const files = path.join(process.env.FILES_ROOT, username);

async function write(relative: string, content: string) {
  const destination = path.join(files, relative);
  await fsp.mkdir(path.dirname(destination), { recursive: true });
  await fsp.writeFile(destination, content);
}

test('snapshot, browse, diff and staged restore form a complete isolated lifecycle', async () => {
  await write('docs/note.txt', 'before');
  await write('docs/deleted.txt', 'recover me');
  const snapshot = await timeMachine.createSnapshot(userId, username, 'Before changes');

  assert.equal(snapshot.fileCount, 2);
  assert.equal(snapshot.warningCount, 0);
  const manifest = path.join(timeMachine.timeMachinePaths.manifestRoot, String(userId), `${snapshot.id}.json`);
  assert.equal((await fsp.stat(manifest)).mode & 0o777, 0o444);

  const tree = await timeMachine.browseSnapshot(userId, snapshot.id, '/docs');
  assert.deepEqual(tree.entries.map(entry => entry.path), ['/docs/deleted.txt', '/docs/note.txt']);
  await assert.rejects(() => timeMachine.browseSnapshot(userId + 1, snapshot.id, '/'), /snapshot_not_found/);

  await write('docs/note.txt', 'after');
  await fsp.rm(path.join(files, 'docs/deleted.txt'));
  await write('docs/added.txt', 'new');
  const diff = await timeMachine.diffSnapshot(userId, username, snapshot.id, 'current', '/docs');
  assert.equal(diff.summary.added, 1);
  assert.equal(diff.summary.removed, 1);
  assert.equal(diff.summary.modified, 1);

  const skipped = await timeMachine.restoreSnapshot(userId, username, snapshot.id, '/docs', '/docs', 'skip');
  assert.ok(skipped.skipped >= 1);
  assert.equal(await fsp.readFile(path.join(files, 'docs/note.txt'), 'utf8'), 'after');
  assert.equal(await fsp.readFile(path.join(files, 'docs/deleted.txt'), 'utf8'), 'recover me');

  const renamed = await timeMachine.restoreSnapshot(userId, username, snapshot.id, '/docs/note.txt', undefined, 'rename');
  assert.notEqual(renamed.destinationPath, '/docs/note.txt');
  assert.equal(await fsp.readFile(path.join(files, renamed.destinationPath), 'utf8'), 'before');
  assert.equal(await fsp.readFile(path.join(files, 'docs/note.txt'), 'utf8'), 'after');

  await write('recovered-docs/current-only.txt', 'must be replaced');
  const recovered = await timeMachine.restoreSnapshot(userId, username, snapshot.id, '/docs', '/recovered-docs', 'overwrite');
  assert.equal(recovered.destinationPath, '/recovered-docs');
  assert.equal(recovered.replaced, true);
  assert.equal(await fsp.readFile(path.join(files, 'recovered-docs/note.txt'), 'utf8'), 'before');
  assert.equal(await fsp.readFile(path.join(files, 'recovered-docs/deleted.txt'), 'utf8'), 'recover me');
  assert.equal(fs.existsSync(path.join(files, 'recovered-docs/added.txt')), false);
  assert.equal(fs.existsSync(path.join(files, 'recovered-docs/current-only.txt')), false);

  const outside = path.join(sandbox, 'outside');
  await fsp.mkdir(outside);
  await fsp.symlink(outside, path.join(files, 'escape'));
  await assert.rejects(() => timeMachine.restoreSnapshot(userId, username, snapshot.id,
    '/docs/note.txt', '/escape/note.txt', 'overwrite'), /unsafe_destination_symlink/);
  assert.equal(fs.existsSync(path.join(outside, 'note.txt')), false);
});

test('snapshot objects and restore deltas are quota charged without double-counting unchanged content', async () => {
  await write('quota/protected.bin', 'q'.repeat(4096));
  const before = await storageWrites.timeMachineUsageBytes(userId);
  const first = await timeMachine.createSnapshot(userId, username, 'Quota baseline');
  const afterFirst = await storageWrites.timeMachineUsageBytes(userId);
  assert.ok(afterFirst > before + 4096, 'the new object and its manifest are charged');

  const second = await timeMachine.createSnapshot(userId, username, 'Unchanged quota baseline');
  const afterSecond = await storageWrites.timeMachineUsageBytes(userId);
  const secondManifest = path.join(timeMachine.timeMachinePaths.manifestRoot, String(userId), `${second.id}.json`);
  assert.equal(afterSecond - afterFirst, (await fsp.stat(secondManifest)).size,
    'unchanged content is charged once while each immutable manifest is charged');

  await write('quota/not-protected.bin', 'n'.repeat(4096));
  const account = { id: userId, username };
  const usedBeforeRejectedSnapshot = await storageWrites.chargedUsageBytes(account);
  sqlite.prepare('UPDATE users SET storage_quota_bytes=? WHERE id=?').run(usedBeforeRejectedSnapshot + 2048, userId);
  const snapshotCount = timeMachine.listSnapshots(userId).length;
  await assert.rejects(() => timeMachine.createSnapshot(userId, username, 'Must exceed quota'), /storage_quota_exceeded/);
  assert.equal(timeMachine.listSnapshots(userId).length, snapshotCount);

  const usedBeforeRejectedRestore = await storageWrites.chargedUsageBytes(account);
  sqlite.prepare('UPDATE users SET storage_quota_bytes=? WHERE id=?').run(usedBeforeRejectedRestore + 4095, userId);
  await assert.rejects(() => timeMachine.restoreSnapshot(userId, username, first.id,
    '/quota/protected.bin', '/quota/restored.bin', 'rename'), /storage_quota_exceeded/);
  assert.equal(fs.existsSync(path.join(files, 'quota/restored.bin')), false);

  sqlite.prepare('UPDATE users SET storage_quota_bytes=NULL WHERE id=?').run(userId);
  await write('quota/replaced.bin', 'x'.repeat(4096));
  const exactUsage = await storageWrites.chargedUsageBytes(account);
  sqlite.prepare('UPDATE users SET storage_quota_bytes=? WHERE id=?').run(exactUsage, userId);
  const restored = await timeMachine.restoreSnapshot(userId, username, first.id,
    '/quota/protected.bin', '/quota/replaced.bin', 'overwrite');
  assert.equal(restored.replaced, true, 'an equal-sized overwrite has a zero final quota delta');
  assert.equal(await fsp.readFile(path.join(files, 'quota/replaced.bin'), 'utf8'), 'q'.repeat(4096));
  assert.equal((sqlite.prepare('SELECT COUNT(*) count FROM storage_reservations').get() as any).count, 0,
    'all successful and rejected operation reservations are released');
  sqlite.prepare('UPDATE users SET storage_quota_bytes=NULL WHERE id=?').run(userId);
});

test('manual snapshot tasks persist progress and complete outside the request lifecycle', async () => {
  const queued = timeMachine.queueSnapshot(userId, username, 'Background checkpoint');
  assert.ok(queued.status === 'queued' || queued.status === 'running');
  let task = queued;
  for (let attempt = 0; attempt < 200 && (task.status === 'queued' || task.status === 'running'); attempt++) {
    await new Promise(resolve => setTimeout(resolve, 10));
    task = timeMachine.getSnapshotTask(userId, queued.id);
  }
  assert.equal(task.status, 'completed', task.error || 'background task did not finish');
  assert.ok(task.snapshotId);
  assert.ok(task.processedFiles > 0);
});

test('account deactivation aborts snapshot commit and blocks restore filesystem work', async () => {
  await write('cancel/in-flight.bin', 'cancel me');
  const before = timeMachine.listSnapshots(userId).length;
  let deactivated = false;
  await assert.rejects(() => timeMachine.createSnapshot(userId, username, 'Must not commit', () => {
    if (deactivated) return;
    deactivated = true;
    sqlite.prepare("UPDATE users SET disabled_at=datetime('now') WHERE id=?").run(userId);
  }), /account_deactivated/);
  assert.equal(timeMachine.listSnapshots(userId).length, before);

  const existing = timeMachine.listSnapshots(userId)[0];
  assert.ok(existing);
  await assert.rejects(() => timeMachine.restoreSnapshot(userId, username, existing.id,
    '/docs/note.txt', '/must-not-restore.txt', 'overwrite'), /account_deactivated/);
  assert.equal(fs.existsSync(path.join(files, 'must-not-restore.txt')), false);
  sqlite.prepare('UPDATE users SET disabled_at=NULL WHERE id=?').run(userId);
});

test('retention preserves the requested floor and prunes unreferenced manifests', async () => {
  await write('sequence.txt', 'one');
  await timeMachine.createSnapshot(userId, username, 'One');
  await write('sequence.txt', 'two');
  await timeMachine.createSnapshot(userId, username, 'Two');
  timeMachine.updateRetentionPolicy(userId, {
    hourlyHours: 0,
    dailyDays: 0,
    weeklyWeeks: 0,
    monthlyMonths: 0,
    minimumSnapshots: 1,
    maximumBytes: null,
  });
  const result = await timeMachine.pruneSnapshots(userId);
  assert.equal(timeMachine.listSnapshots(userId).length, 1);
  assert.ok(result.removedSnapshots >= 2);
});

test('restores under sync and camera bases immediately append device-visible journal changes', async () => {
  await write('Sync/Laptop/shared.txt', 'snapshot version');
  await write('Photos/Camera/Phone/photo.jpg', 'snapshot photo');
  const snapshot = await timeMachine.createSnapshot(userId, username, 'Sync checkpoint');
  await syncFabric.reconcileRestoredPath(userId, files, '/');

  await write('Sync/Laptop/shared.txt', 'new current version');
  await write('Sync/Laptop/current-only.txt', 'remove on restore');
  await fsp.rm(path.join(files, 'Photos/Camera/Phone/photo.jpg'));
  await syncFabric.reconcileRestoredPath(userId, files, '/');
  const syncCursor = syncFabric.latestCursor(userId, 'Sync/Laptop');
  const cameraCursor = syncFabric.latestCursor(userId, 'Photos/Camera/Phone');

  const syncRestore = await timeMachine.restoreSnapshot(userId, username, snapshot.id,
    '/Sync/Laptop', '/Sync/Laptop', 'overwrite');
  assert.equal(syncRestore.sync.reconciled, true);
  const syncChanges = syncFabric.changesAfter(userId, 'Sync/Laptop', syncCursor, 100).items;
  assert.ok(syncChanges.some(change => change.kind === 'upsert' && change.rel === 'shared.txt'));
  assert.ok(syncChanges.some(change => change.kind === 'delete' && change.rel === 'current-only.txt'));

  const cameraRestore = await timeMachine.restoreSnapshot(userId, username, snapshot.id,
    '/Photos/Camera/Phone', '/Photos/Camera/Phone', 'overwrite');
  assert.equal(cameraRestore.sync.reconciled, true);
  const cameraChanges = syncFabric.changesAfter(userId, 'Photos/Camera/Phone', cameraCursor, 100).items;
  assert.ok(cameraChanges.some(change => change.kind === 'upsert' && change.rel === 'photo.jpg'));
});

test('manifest tampering is detected before browse or restore', async () => {
  const snapshot = timeMachine.listSnapshots(userId)[0];
  const manifest = path.join(timeMachine.timeMachinePaths.manifestRoot, String(userId), `${snapshot.id}.json`);
  await fsp.chmod(manifest, 0o600);
  await fsp.appendFile(manifest, '\n');
  await assert.rejects(() => timeMachine.browseSnapshot(userId, snapshot.id, '/'), /snapshot_integrity_failed/);
});

test.after(async () => {
  sqlite.close();
  mock.reset();
  await fsp.rm(sandbox, { recursive: true, force: true });
});
