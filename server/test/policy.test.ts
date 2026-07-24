import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

const statements: string[] = [];
mock.module(new URL('../src/lib/db.js', import.meta.url).href, {
  namedExports: {
    getSetting: (_key: string, fallback: string) => fallback,
    db: { prepare: (sql: string) => ({ run: () => { statements.push(sql); } }) },
  },
});

const policy = await import('../src/services/policy.js');

test('startup privacy reconciliation purges coordinates from the real photo index', () => {
  policy.reconcilePolicyState();
  assert.equal(statements.length, 1);
  assert.match(statements[0], /UPDATE photo_index SET lat=NULL,lon=NULL/);
  assert.doesNotMatch(statements[0], /UPDATE photos\b/);
});

test.after(() => mock.reset());
