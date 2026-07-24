import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { mock } from 'node:test';
import { DatabaseSync } from 'node:sqlite';

const sandbox = await fsp.mkdtemp(path.join(os.tmpdir(), 'aerie-file-catalog-'));
const filesRoot = path.join(sandbox, 'files');
const outsideRoot = path.join(sandbox, 'outside');
process.env.DATA_DIR = path.join(sandbox, 'data');
process.env.FILES_ROOT = filesRoot;
process.env.JWT_SECRET = 'file-catalog-test-secret';

const sqlite = new DatabaseSync(path.join(sandbox, 'catalog-test.db'));
sqlite.exec(`
  PRAGMA foreign_keys=ON;
  CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT UNIQUE NOT NULL, storage_id TEXT UNIQUE);
  INSERT INTO users (id,username,storage_id) VALUES
    (101,'alice','alice-store'),
    (202,'bob','bob-store');

  CREATE TABLE file_catalog (
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
    UNIQUE (user_id,path),
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
  );
  CREATE INDEX idx_file_catalog_scan ON file_catalog(user_id,scan_id);
  CREATE INDEX idx_file_catalog_recent ON file_catalog(user_id,is_folder,mtime_ms DESC,path);
  CREATE INDEX idx_file_catalog_size ON file_catalog(user_id,is_folder,size DESC,path);
  CREATE INDEX idx_file_catalog_kind ON file_catalog(user_id,is_folder,kind,mtime_ms DESC,path);
  CREATE INDEX idx_file_catalog_extension ON file_catalog(user_id,is_folder,extension,mtime_ms DESC,path);
  CREATE INDEX idx_file_catalog_name ON file_catalog(user_id,name_folded,path);
  CREATE INDEX idx_file_catalog_name_length ON file_catalog(user_id,name_length,name_folded,path);
  CREATE TABLE file_catalog_state (
    user_id INTEGER PRIMARY KEY,
    last_started_ms REAL NOT NULL DEFAULT 0,
    last_completed_ms REAL NOT NULL DEFAULT 0,
    invalidated_at_ms REAL NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'idle',
    last_error TEXT,
    file_count INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
  );
  CREATE VIRTUAL TABLE file_catalog_fts USING fts5(
    name,path,content='file_catalog',content_rowid='id',tokenize='unicode61 remove_diacritics 2'
  );
  CREATE TRIGGER file_catalog_fts_insert AFTER INSERT ON file_catalog BEGIN
    INSERT INTO file_catalog_fts(rowid,name,path) VALUES (new.id,new.name,new.path);
  END;
  CREATE TRIGGER file_catalog_fts_delete AFTER DELETE ON file_catalog BEGIN
    INSERT INTO file_catalog_fts(file_catalog_fts,rowid,name,path)
      VALUES ('delete',old.id,old.name,old.path);
  END;
  CREATE TRIGGER file_catalog_fts_update AFTER UPDATE OF name,path ON file_catalog
  WHEN old.name<>new.name OR old.path<>new.path BEGIN
    INSERT INTO file_catalog_fts(file_catalog_fts,rowid,name,path)
      VALUES ('delete',old.id,old.name,old.path);
    INSERT INTO file_catalog_fts(rowid,name,path) VALUES (new.id,new.name,new.path);
  END;
`);

const testDb = {
  exec: (sql: string) => sqlite.exec(sql),
  prepare: (sql: string) => sqlite.prepare(sql),
  transaction: (operation: (...args: any[]) => any) => (...args: any[]) => {
    sqlite.exec('BEGIN IMMEDIATE');
    try {
      const result = operation(...args);
      sqlite.exec('COMMIT');
      return result;
    } catch (error) {
      sqlite.exec('ROLLBACK');
      throw error;
    }
  },
};
const { AERIE_MIGRATIONS } = await import('../src/lib/migrations.js');
const contentSearchMigration = AERIE_MIGRATIONS.find(migration => migration.version === 3);
assert.ok(contentSearchMigration, 'content search migration must exist');
contentSearchMigration.up(testDb);
mock.module(new URL('../src/lib/db.js', import.meta.url).href, { namedExports: { db: testDb } });

const catalog = await import('../src/services/file-catalog.js');
const contentSearch = await import('../src/services/content-search.js');
const alice = { id: 101, username: 'alice' };
const bob = { id: 202, username: 'bob' };
const aliceRoot = path.join(filesRoot, 'alice-store');
const bobRoot = path.join(filesRoot, 'bob-store');

async function write(root: string, relative: string, content: string, mtimeMs?: number): Promise<void> {
  const destination = path.join(root, relative);
  await fsp.mkdir(path.dirname(destination), { recursive: true });
  await fsp.writeFile(destination, content);
  if (mtimeMs != null) {
    const at = new Date(mtimeMs);
    await fsp.utimes(destination, at, at);
  }
}

test.beforeEach(async () => {
  sqlite.exec(`
    DROP TRIGGER IF EXISTS fail_catalog_insert;
    DROP TRIGGER IF EXISTS fail_content_insert;
    DELETE FROM content_search_entries;
    DELETE FROM content_search_state;
    DELETE FROM file_catalog;
    DELETE FROM file_catalog_state;
  `);
  await fsp.rm(filesRoot, { recursive: true, force: true });
  await fsp.rm(outsideRoot, { recursive: true, force: true });
  await fsp.mkdir(aliceRoot, { recursive: true });
  await fsp.mkdir(bobRoot, { recursive: true });
  await fsp.mkdir(outsideRoot, { recursive: true });
});

test('reconciliation is single-flight, per-user, and excludes symlink targets', async () => {
  await write(aliceRoot, 'Documents/Quarterly Report.md', 'alice report');
  await write(bobRoot, 'Private/Quarterly Secret.md', 'bob secret');
  await write(outsideRoot, 'host-secret.txt', 'must not be indexed');
  await fsp.symlink(outsideRoot, path.join(aliceRoot, 'escape'));
  await fsp.symlink(path.join(outsideRoot, 'host-secret.txt'), path.join(aliceRoot, 'secret-link.txt'));

  const first = catalog.refreshFileCatalog(alice);
  const joined = catalog.refreshFileCatalog(alice);
  assert.equal(first, joined, 'concurrent refreshes for one user must share a promise');
  const refreshed = await first;
  assert.equal(refreshed.scanned, 2, 'one folder and one file are cataloged; symlinks are not');
  await catalog.refreshFileCatalog(bob);

  const alicePaths = catalog.listFileCatalog(alice.id, { includeFolders: true, limit: 100 }).map(row => row.path);
  assert.deepEqual(alicePaths.sort(), ['/Documents', '/Documents/Quarterly Report.md'].sort());
  assert.equal(alicePaths.some(value => value.includes('escape') || value.includes('secret-link')), false);
  assert.deepEqual(catalog.searchFileCatalog(alice.id, 'quarterly').map(row => row.name), ['Quarterly Report.md']);
  assert.deepEqual(catalog.searchFileCatalog(bob.id, 'quarterly').map(row => row.name), ['Quarterly Secret.md']);
  assert.equal(catalog.searchFileCatalog(alice.id, 'secret').length, 0, 'another user and symlink targets stay isolated');
});

test('bounded indexed helpers support extension, type, recent, largest, fuzzy search, and FileEntry conversion', async () => {
  const base = Date.now() - 60_000;
  await write(aliceRoot, 'Docs/Quarterly Report.md', 'report', base + 1_000);
  await write(aliceRoot, 'Docs/Notes.MD', 'notes are longer', base + 2_000);
  await write(aliceRoot, 'Media/clip.mp4', 'x'.repeat(200), base + 3_000);
  for (let index = 0; index < 205; index++) {
    await write(aliceRoot, `Bulk/item-${String(index).padStart(3, '0')}.bin`, String(index), base - index);
  }
  await catalog.refreshFileCatalog(alice);

  const dotted = catalog.listFileCatalog(alice.id, { extensions: ['.md'], sort: 'recent', limit: 10 });
  const bare = catalog.listFileCatalog(alice.id, { extensions: ['MD'], sort: 'recent', limit: 10 });
  assert.deepEqual(dotted.map(row => row.path), bare.map(row => row.path));
  assert.deepEqual(dotted.map(row => row.name), ['Notes.MD', 'Quarterly Report.md']);
  assert.deepEqual(catalog.listFileCatalog(alice.id, { kinds: ['video'], limit: 10 }).map(row => row.name), ['clip.mp4']);
  assert.equal(catalog.listFileCatalog(alice.id, { sort: 'largest', limit: 1 })[0].name, 'clip.mp4');
  assert.equal(catalog.listFileCatalog(alice.id, { limit: 50_000 }).length, 200, 'public limits are hard-capped');
  const usage = catalog.fileCatalogUsage(alice.id);
  assert.equal(usage.fileCount, 208);
  assert.equal(usage.byKind.other.count, 205);
  assert.equal(usage.byKind.video.bytes, 200);

  assert.equal(catalog.searchFileCatalog(alice.id, 'reporr')[0].name, 'Quarterly Report.md',
    'bounded broad-prefix candidates allow a one-edit typo');
  assert.ok(catalog.searchFileCatalog(alice.id, 'x'.repeat(10_000), { limit: 50_000 }).length <= 200,
    'query text and result counts stay bounded');
  const result = catalog.toFileEntry(catalog.searchFileCatalog(alice.id, 'clip')[0], { starred: true });
  assert.equal(result.path, '/Media/clip.mp4');
  assert.equal(result.starred, true);
  assert.match(result.thumbUrl || '', /^\/api\/files\/thumb\?path=/);
  assert.match(result.modifiedAt, /^\d{4}-\d{2}-\d{2}T/);
});

test('an aborted scan preserves prior rows and completion watermark until a complete scan removes stale rows', async () => {
  await write(aliceRoot, 'keep.txt', 'keep');
  await write(aliceRoot, 'stale.txt', 'old');
  await catalog.refreshFileCatalog(alice);
  const before = sqlite.prepare('SELECT last_completed_ms FROM file_catalog_state WHERE user_id=?').get(alice.id) as any;

  await fsp.rm(path.join(aliceRoot, 'stale.txt'));
  await write(aliceRoot, 'explode.txt', 'fail this batch');
  sqlite.exec(`CREATE TRIGGER fail_catalog_insert BEFORE INSERT ON file_catalog
    WHEN new.name='explode.txt' BEGIN SELECT RAISE(ABORT,'injected catalog failure'); END;`);

  await assert.rejects(() => catalog.refreshFileCatalog(alice), /injected catalog failure/);
  const failed = sqlite.prepare(`SELECT last_completed_ms,status FROM file_catalog_state WHERE user_id=?`).get(alice.id) as any;
  assert.equal(failed.last_completed_ms, before.last_completed_ms);
  assert.equal(failed.status, 'error');
  assert.ok(catalog.listFileCatalog(alice.id, { limit: 20 }).some(row => row.path === '/stale.txt'),
    'a partial scan must not delete rows from the last complete catalog');

  sqlite.exec('DROP TRIGGER fail_catalog_insert;');
  const completed = await catalog.refreshFileCatalog(alice);
  assert.equal(completed.removed, 1);
  assert.equal(catalog.listFileCatalog(alice.id, { limit: 20 }).some(row => row.path === '/stale.txt'), false);
});

test('ensure awaits cold start then serves stale data while one refresh runs', async () => {
  await write(aliceRoot, 'one.txt', 'one');
  const cold = await catalog.ensureFileCatalog(alice, { maxAgeMs: 60_000 });
  assert.equal(cold.refreshed, true);
  const fresh = await catalog.ensureFileCatalog(alice, { maxAgeMs: 60_000 });
  assert.equal(fresh.refreshing, false);
  assert.equal(fresh.refreshed, false);

  await write(aliceRoot, 'two.txt', 'two');
  catalog.markFileCatalogStale(alice.id);
  const stale = await catalog.ensureFileCatalog(alice, { maxAgeMs: 60_000 });
  assert.equal(stale.refreshing, true, 'a populated stale catalog returns without awaiting its refresh');
  await catalog.refreshFileCatalog(alice);
  assert.deepEqual(catalog.listFileCatalog(alice.id, { sort: 'name', limit: 10 }).map(row => row.name), ['one.txt', 'two.txt']);
});

test('content search indexes native documents and sheets with snippets, filters, and strict user isolation', async () => {
  const now = Date.now();
  await write(aliceRoot, 'Documents/Launch Plan.cbxdoc',
    '<h1>Roadmap</h1><p>Project Aurora launches after the accessibility review.</p>', now - 1_000);
  await write(aliceRoot, 'Spreadsheets/Budget.cbxsheet', JSON.stringify({
    sheets: [{ name: 'Budget', grid: [['Vendor', 'Amount'], ['Nimbus Works', '4200']], formats: {} }], active: 0,
  }), now - 90_000);
  await write(bobRoot, 'Private/Secret.txt', 'Bob-only zephyr clearance phrase', now);

  await catalog.refreshFileCatalog(alice);
  await catalog.refreshFileCatalog(bob);
  await contentSearch.refreshContentSearchIndex(alice);
  await contentSearch.refreshContentSearchIndex(bob);

  const document = contentSearch.searchContentIndex(alice.id, 'aurora', { kinds: ['document'] });
  assert.equal(document.length, 1);
  assert.equal(document[0].path, '/Documents/Launch Plan.cbxdoc');
  assert.match(document[0].snippet.toLowerCase(), /project aurora launches/);
  assert.doesNotMatch(document[0].snippet, /<\/?(?:h1|p)>/i, 'snippets contain text, not native HTML markup');

  assert.equal(contentSearch.searchContentIndex(alice.id, 'zephyr').length, 0,
    'a query can never read another user\'s active generation');
  assert.equal(contentSearch.searchContentIndex(bob.id, 'zephyr').length, 1);
  assert.equal(contentSearch.searchContentIndex(alice.id, 'nimbus', { kinds: ['document'] }).length, 0);
  assert.equal(contentSearch.searchContentIndex(alice.id, 'nimbus', { kinds: ['spreadsheet'] }).length, 1);
  assert.equal(contentSearch.searchContentIndex(alice.id, 'nimbus', { modifiedAfterMs: now - 10_000 }).length, 0,
    'the modified-date filter is enforced by the user-scoped query');

  const state = contentSearch.contentIndexState(alice.id);
  assert.equal(state.ready, true);
  assert.equal(state.indexedCount, 2);
  assert.equal(state.stale, false);
});

test('a failed content generation keeps the previous complete generation searchable', async () => {
  await write(aliceRoot, 'note.txt', 'the stable amber phrase');
  await catalog.refreshFileCatalog(alice);
  await contentSearch.refreshContentSearchIndex(alice);
  const before = sqlite.prepare(`SELECT active_scan_id,last_completed_ms
    FROM content_search_state WHERE user_id=?`).get(alice.id) as any;
  assert.equal(contentSearch.searchContentIndex(alice.id, 'amber').length, 1);

  await write(aliceRoot, 'note.txt', 'the replacement cobalt phrase');
  catalog.markFileCatalogStale(alice.id);
  await catalog.refreshFileCatalog(alice);
  sqlite.exec(`CREATE TRIGGER fail_content_insert BEFORE INSERT ON content_search_entries
    WHEN new.name='note.txt' BEGIN SELECT RAISE(ABORT,'injected content failure'); END;`);

  await assert.rejects(() => contentSearch.refreshContentSearchIndex(alice), /injected content failure/);
  const failed = sqlite.prepare(`SELECT active_scan_id,last_completed_ms,status
    FROM content_search_state WHERE user_id=?`).get(alice.id) as any;
  assert.equal(failed.active_scan_id, before.active_scan_id);
  assert.equal(failed.last_completed_ms, before.last_completed_ms);
  assert.equal(failed.status, 'error');
  assert.equal(contentSearch.searchContentIndex(alice.id, 'amber').length, 1,
    'the prior generation remains available after a failed replacement');
  assert.equal(contentSearch.searchContentIndex(alice.id, 'cobalt').length, 0);

  sqlite.exec('DROP TRIGGER fail_content_insert;');
  await contentSearch.refreshContentSearchIndex(alice);
  assert.equal(contentSearch.searchContentIndex(alice.id, 'amber').length, 0);
  assert.equal(contentSearch.searchContentIndex(alice.id, 'cobalt').length, 1);
});

test.after(async () => {
  sqlite.close();
  mock.reset();
  await fsp.rm(sandbox, { recursive: true, force: true });
});
