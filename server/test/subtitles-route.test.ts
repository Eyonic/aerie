import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

const queries: Array<{ sql: string; args: any[] }> = [];
let listed: any[] = [];
let authorized = true;
mock.module(new URL('../src/lib/db.js', import.meta.url).href, {
  namedExports: {
    audit: () => undefined,
    db: { prepare: (sql: string) => ({
      get: (...args: any[]) => { queries.push({ sql, args }); return undefined; },
      run: (...args: any[]) => { queries.push({ sql, args }); return { changes: 0 }; },
    }) },
    getSetting: (_key: string, fallback = '') => fallback,
  },
});
mock.module(new URL('../src/services/subtitles.js', import.meta.url).href, {
  namedExports: {
    authorizeSubtitleItem: async () => {
      if (!authorized) throw Object.assign(new Error('feature_disabled'), { status: 403, feature: 'movies' });
      return 'movies';
    },
    list: (itemId: string, userId: number) => { listed = [itemId, userId]; return []; },
  },
});

const router = (await import('../src/routes/subtitles.js')).default as any;

function route(path: string, method: string) {
  return router.stack.find((layer: any) => layer.route?.path === path && layer.route.methods[method]).route.stack[0].handle;
}

test('subtitle listing and file reads are scoped to the authenticated creator', async () => {
  let response: any;
  await route('/item/:itemId', 'get')(
    { params: { itemId: 'movie-1' }, user: { id: 41, features: { movies: true } } },
    { json: (body: any) => { response = body; } },
    (error: any) => { throw error; },
  );
  assert.deepEqual(listed, ['movie-1', 41]);
  assert.deepEqual(response, { subtitles: [] });

  let status = 200;
  await route('/file/:id', 'get')(
    { params: { id: 'sub-private' }, user: { id: 41 } },
    { status: (value: number) => { status = value; return { end: () => undefined }; } },
    (error: any) => { throw error; },
  );
  assert.equal(status, 404);
  const lookup = queries.find(query => /FROM subtitles WHERE id=\? AND created_by=\?/.test(query.sql));
  assert.deepEqual(lookup?.args, ['sub-private', 41]);
});

test('subtitle routes fail closed when the item content feature is disabled', async () => {
  authorized = false;
  listed = [];
  let caught: any;
  await route('/item/:itemId', 'get')(
    { params: { itemId: 'movie-disabled' }, user: { id: 41, features: { movies: false } } },
    { json: () => assert.fail('disabled subtitle metadata must not be returned') },
    (error: any) => { caught = error; },
  );
  assert.equal(caught?.message, 'feature_disabled');
  assert.equal(caught?.feature, 'movies');
  assert.deepEqual(listed, []);
  authorized = true;
});

test.after(() => mock.reset());
