import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

let account: any;
const capability = {
  url: 'http://127.0.0.1:8096/Videos/item/stream',
  contentType: 'video/mp4',
  userId: 41,
  feature: 'movies',
  expires: Date.now() + 60_000,
};

mock.module(new URL('../src/lib/auth.js', import.meta.url).href, {
  namedExports: {
    findUserById: () => account,
    rowToUser: (row: any) => row,
  },
});
mock.module(new URL('../src/lib/db.js', import.meta.url).href, { namedExports: { audit: () => undefined } });
mock.module(new URL('../src/services/cast.js', import.meta.url).href, {
  namedExports: { resolveStreamToken: () => capability },
});
mock.module(new URL('../src/services/jellyfin.js', import.meta.url).href, { namedExports: {} });
mock.module(new URL('../src/services/audiobookshelf.js', import.meta.url).href, { namedExports: {} });

const { castStreamRouter } = await import('../src/routes/cast.js');
const handler = (castStreamRouter as any).stack.find((layer: any) => layer.route?.path === '/:token').route.stack[0].handle;

async function deniedStatus() {
  let status = 200;
  await handler(
    { params: { token: 'capability' }, headers: {} },
    {
      status(value: number) { status = value; return this; },
      end() { return undefined; },
    },
  );
  return status;
}

test('cast stream capabilities are unusable after owner deactivation', async () => {
  account = undefined;
  assert.equal(await deniedStatus(), 404);
});

test('cast stream capabilities are rechecked against the bound content feature', async () => {
  account = { id: 41, features: { movies: false } };
  assert.equal(await deniedStatus(), 404);
});

test.after(() => mock.reset());
