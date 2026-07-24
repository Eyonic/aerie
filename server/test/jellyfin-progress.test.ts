import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

let failure: any = null;
const removedItems: string[] = [];
const removedSeries: string[] = [];

mock.module(new URL('../src/services/jellyfin.js', import.meta.url).href, {
  namedExports: {
    itemDetail: async (id: string) => {
      if (failure) throw failure;
      return { id, type: 'Movie', name: 'Available' };
    },
    isJellyfinNotFound: (error: any) => error?.kind === 'missing',
  },
});
mock.module(new URL('../src/services/progress.js', import.meta.url).href, {
  namedExports: {
    remove: (_userId: number, itemId: string) => { removedItems.push(itemId); return true; },
    removeSeries: (_userId: number, seriesId: string) => { removedSeries.push(seriesId); return 1; },
  },
});

const reconciliation = await import('../src/services/jellyfin-progress.js');

test.beforeEach(() => {
  failure = null;
  removedItems.length = 0;
  removedSeries.length = 0;
});

test('continue-watching reconciliation deletes only definitive stale items', async () => {
  failure = { kind: 'missing' };
  assert.equal(await reconciliation.progressItem(7, 'gone'), null);
  assert.deepEqual(removedItems, ['gone']);

  failure = { kind: 'unavailable' };
  assert.equal(await reconciliation.progressItem(7, 'temporary'), null);
  assert.deepEqual(removedItems, ['gone']);
});

test('a missing series clears its stale child progress, not transient outages', () => {
  assert.equal(reconciliation.reconcileMissingSeries({ kind: 'unavailable' }, 7, 'series-1'), false);
  assert.deepEqual(removedSeries, []);
  assert.equal(reconciliation.reconcileMissingSeries({ kind: 'missing' }, 7, 'series-1'), true);
  assert.deepEqual(removedSeries, ['series-1']);
});

test.after(() => mock.reset());
