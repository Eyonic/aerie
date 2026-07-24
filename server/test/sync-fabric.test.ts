import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const sandbox = await fsp.mkdtemp(path.join(os.tmpdir(), 'aerie-sync-fabric-'));
process.env.DATA_DIR = path.join(sandbox, 'data');
process.env.FILES_ROOT = path.join(sandbox, 'files');
process.env.JWT_SECRET = 'sync-fabric-test-secret';

const protocol = await import('../src/services/sync-protocol.js');
const sqlite = new DatabaseSync(path.join(sandbox, 'sync-fabric-test.db'));
sqlite.exec(`
  CREATE TABLE sync_entries (
    stable_id TEXT PRIMARY KEY, user_id INTEGER NOT NULL, base TEXT NOT NULL, rel_path TEXT NOT NULL,
    content_hash TEXT NOT NULL, size INTEGER NOT NULL, mtime_ms REAL NOT NULL,
    deleted INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE UNIQUE INDEX idx_sync_entries_active_path ON sync_entries(user_id,base,rel_path) WHERE deleted=0;
  CREATE TABLE sync_changes (
    cursor INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, base TEXT NOT NULL,
    stable_id TEXT NOT NULL, kind TEXT NOT NULL, rel_path TEXT NOT NULL, previous_rel_path TEXT,
    content_hash TEXT NOT NULL, size INTEGER NOT NULL, mtime_ms REAL NOT NULL,
    origin_device TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now'))
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
const testDb = {
  exec: (sql: string) => sqlite.exec(sql),
  prepare: (sql: string) => sqlite.prepare(sql),
  transaction: (operation: (...args: any[]) => any) => (...args: any[]) => {
    sqlite.exec('BEGIN IMMEDIATE');
    try { const result = operation(...args); sqlite.exec('COMMIT'); return result; }
    catch (error) { sqlite.exec('ROLLBACK'); throw error; }
  },
};
mock.module(new URL('../src/lib/db.js', import.meta.url).href, { namedExports: { db: testDb } });
const fabric = await import('../src/services/sync-fabric.js');

test.after(async () => {
  sqlite.close();
  mock.reset();
  await fsp.rm(sandbox, { recursive: true, force: true });
});

test('range parsing accepts one bounded byte range', () => {
  assert.deepEqual(protocol.parseByteRange('bytes=10-', 100), { start: 10, end: 99 });
  assert.deepEqual(protocol.parseByteRange('bytes=10-20', 100), { start: 10, end: 20 });
  assert.equal(protocol.parseByteRange('bytes=100-', 100), null);
  assert.equal(protocol.parseByteRange('bytes=1-2,4-5', 100), null);
});

test('conflict paths are deterministic and retain the extension', () => {
  const hash = 'a'.repeat(64);
  assert.equal(
    protocol.deterministicConflictRel('docs/report.pdf', 'laptop! 1', hash),
    'docs/report (Aerie conflict laptop1-aaaaaaaa).pdf',
  );
  const long = protocol.deterministicConflictRel(`docs/${'界'.repeat(100)}.documentextension`, 'laptop', hash);
  assert.ok(Buffer.byteLength(path.posix.basename(long), 'utf8') <= 255);
});

test('reconciliation retains stable identity across rename and journals a tombstone', async () => {
  const root = path.join(sandbox, 'files', 'alice', 'Sync', 'Work');
  await fsp.mkdir(root, { recursive: true });
  await fsp.writeFile(path.join(root, 'draft.txt'), 'same bytes');

  await fabric.withSyncLock(41, 'Sync/Work', () => fabric.reconcileBase(41, 'Sync/Work', root));
  const first = fabric.manifest(41, 'Sync/Work');
  assert.equal(first.entries.length, 1);
  assert.equal(first.entries[0].rel, 'draft.txt');
  assert.equal(first.entries[0].contentHash, '58100dc8fc06562ce3e578231dc948e083520ee49c4b4ee5a5a28bb4b4003feb');
  const stableId = first.entries[0].stableId;
  const initialCursor = first.cursor;

  await fabric.withSyncLock(41, 'Sync/Work', () => fabric.reconcileBase(41, 'Sync/Work', root));
  assert.equal(fabric.manifest(41, 'Sync/Work').cursor, initialCursor, 'unchanged scans must not append duplicate events');

  await fsp.rename(path.join(root, 'draft.txt'), path.join(root, 'final.txt'));
  await fabric.withSyncLock(41, 'Sync/Work', () => fabric.reconcileBase(41, 'Sync/Work', root));
  const renamed = fabric.manifest(41, 'Sync/Work');
  assert.equal(renamed.entries[0].stableId, stableId);
  assert.equal(renamed.entries[0].rel, 'final.txt');

  await fsp.unlink(path.join(root, 'final.txt'));
  await fabric.withSyncLock(41, 'Sync/Work', () => fabric.reconcileBase(41, 'Sync/Work', root));
  assert.deepEqual(fabric.manifest(41, 'Sync/Work').entries, []);

  const journal = fabric.changesAfter(41, 'Sync/Work', 0, 20);
  assert.deepEqual(journal.items.map(item => item.kind), ['upsert', 'rename', 'delete']);
  assert.ok(journal.items.every(item => item.stableId === stableId));
  assert.equal(journal.items[1].previousRel, 'draft.txt');
  assert.equal(journal.items[2].rel, 'final.txt');

  const firstPage = fabric.changesAfter(41, 'Sync/Work', 0, 2);
  assert.equal(firstPage.hasMore, true);
  assert.deepEqual(firstPage.items.map(item => item.kind), ['upsert', 'rename']);
  const tail = fabric.changesAfter(41, 'Sync/Work', firstPage.nextCursor, 2);
  assert.equal(tail.hasMore, false);
  assert.deepEqual(tail.items.map(item => item.kind), ['delete']);
});

test('per-device ACKs compact only applied history and preserve a durable fallback watermark', () => {
  const userId = 52;
  const base = 'Sync/Acks';
  const cursors: number[] = [];
  for (let index = 0; index < 4; index++) {
    cursors.push(fabric.registerUpsert({
      userId,
      base,
      rel: `file-${index}.txt`,
      contentHash: String(index).padStart(64, 'a'),
      size: index + 1,
      mtimeMs: 1_000 + index,
      originDevice: 'desktop-a',
    }).cursor);
  }

  fabric.noteSyncDeviceSeen(userId, base, 'desktop-a');
  fabric.noteSyncDeviceSeen(userId, base, 'android-b');
  fabric.acknowledgeCursor(userId, base, 'desktop-a', cursors[3]);
  assert.equal(fabric.journalWatermark(userId, base), 0, 'an unacked active device must hold the safe watermark');

  const partial = fabric.acknowledgeCursor(userId, base, 'android-b', cursors[1]);
  assert.equal(partial.ok, true);
  assert.equal(partial.compactedThrough, cursors[1]);
  assert.equal(fabric.changesAfter(userId, base, 0, 20).fullManifestRequired, true);
  const remaining = fabric.changesAfter(userId, base, cursors[1], 20);
  assert.equal(remaining.fullManifestRequired, false);
  assert.deepEqual(remaining.items.map(item => item.cursor), cursors.slice(2));

  const completed = fabric.acknowledgeCursor(userId, base, 'android-b', cursors[3]);
  assert.equal(completed.compactedThrough, cursors[3]);
  assert.equal(completed.retained, 0);
  assert.equal(fabric.latestCursor(userId, base), cursors[3], 'latest cursor must survive an empty retained journal');
  assert.equal(fabric.manifest(userId, base).cursor, cursors[3]);
  const staleAck = fabric.acknowledgeCursor(userId, base, 'android-b', cursors[1]);
  assert.equal(staleAck.ok, false);
  assert.equal(staleAck.reason, 'cursor_compacted');
});

test('hard compaction cap remains bounded and forces lagging clients through a manifest', () => {
  const userId = 53;
  const base = 'Sync/Bounded';
  const cursors: number[] = [];
  for (let index = 0; index < 6; index++) {
    cursors.push(fabric.registerUpsert({
      userId,
      base,
      rel: `item-${index}.bin`,
      contentHash: String(index + 10).padStart(64, 'b'),
      size: index,
      mtimeMs: 2_000 + index,
    }).cursor);
  }

  const compacted = fabric.compactJournal(userId, base, 2);
  assert.equal(compacted.deleted, 4);
  assert.equal(compacted.retained, 2);
  assert.equal(compacted.compactedThrough, cursors[3]);

  const stale = fabric.changesAfter(userId, base, 0, 20);
  assert.equal(stale.fullManifestRequired, true);
  assert.equal(stale.reason, 'cursor_compacted');
  assert.equal(stale.nextCursor, cursors[5]);
  const tail = fabric.changesAfter(userId, base, compacted.compactedThrough, 20);
  assert.equal(tail.fullManifestRequired, false);
  assert.deepEqual(tail.items.map(item => item.cursor), cursors.slice(4));
});
