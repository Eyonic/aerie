const test = require('node:test');
const assert = require('node:assert/strict');
const {
  changesPath,
  manifestPath,
  missingManifestStableIds,
  persistThenAck,
  validatedChangePage,
} = require('../sync-journal');

test('v2 journal requests carry the stable device id and per-base cursor', () => {
  const changes = new URL(changesPath('Sync/Work files', 42, 'desktop-stable_1'), 'https://aerie.example');
  assert.equal(changes.pathname, '/api/sync/changes');
  assert.equal(changes.searchParams.get('base'), 'Sync/Work files');
  assert.equal(changes.searchParams.get('cursor'), '42');
  assert.equal(changes.searchParams.get('deviceId'), 'desktop-stable_1');
  assert.equal(changes.searchParams.get('limit'), '250');

  const manifest = new URL(manifestPath('Sync/Work files', 'desktop-stable_1'), 'https://aerie.example');
  assert.equal(manifest.pathname, '/api/sync/manifest');
  assert.equal(manifest.searchParams.get('deviceId'), 'desktop-stable_1');
});

test('change pages cannot advance a durable cursor past missing or unordered items', () => {
  assert.deepEqual(validatedChangePage({
    items: [{ cursor: 11 }, { cursor: 14 }], nextCursor: 14, hasMore: false,
  }, 10), { items: [{ cursor: 11 }, { cursor: 14 }], nextCursor: 14, hasMore: false });
  assert.throws(() => validatedChangePage({ items: [{ cursor: 11 }], nextCursor: 99 }, 10), /invalid_sync_change_page/);
  assert.throws(() => validatedChangePage({ items: [{ cursor: 10 }], nextCursor: 10 }, 10), /invalid_sync_change_page/);
  assert.throws(() => validatedChangePage({ items: [], nextCursor: 10, hasMore: true }, 10), /invalid_sync_change_page/);
});

test('authoritative manifest fallback identifies local snapshot tombstones', () => {
  const snapshot = {
    keep: { stableId: 'keep', rel: 'keep.txt' },
    removeB: { stableId: 'removeB', rel: 'b.txt' },
    removeA: { stableId: 'removeA', rel: 'a.txt' },
  };
  assert.deepEqual(
    missingManifestStableIds(snapshot, [{ stableId: 'keep', rel: 'keep.txt' }]),
    ['removeA', 'removeB'],
  );
});

test('cursor ACK happens only after the applied cursor is durably persisted', async () => {
  const events = [];
  await persistThenAck(
    73,
    cursor => events.push(`set:${cursor}`),
    () => events.push('persist'),
    async cursor => { events.push(`ack:${cursor}`); },
  );
  assert.deepEqual(events, ['set:73', 'persist', 'ack:73']);

  const failed = [];
  await assert.rejects(() => persistThenAck(
    74,
    cursor => failed.push(`set:${cursor}`),
    () => { failed.push('persist'); throw new Error('disk_full'); },
    async cursor => { failed.push(`ack:${cursor}`); },
  ), /disk_full/);
  assert.deepEqual(failed, ['set:74', 'persist']);
});
