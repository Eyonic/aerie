import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

class TestOutboundError extends Error {
  constructor(readonly code: string, readonly upstreamStatus?: number) { super(code); }
}

const response = (body: any, status = 200) => ({
  url: 'http://jellyfin.invalid/', status, statusText: '', headers: new Headers(), body,
});

const outboundJson = async (value: string | URL) => {
  const url = String(value);
  if (/\/Users\/?(?:\?|$)/.test(url)) return response([{ Id: 'user-1' }]);
  if (url.includes('/Items/missing')) throw new TestOutboundError('upstream_status', 404);
  if (url.includes('/Items/broken')) throw new TestOutboundError('upstream_status', 500);
  if (url.includes('/Items/offline')) throw new TestOutboundError('timeout');
  return response({ Id: 'ok', Type: 'Movie', Name: 'Available' });
};

mock.module(new URL('../src/config.js', import.meta.url).href, {
  namedExports: { config: { jellyfin: { url: 'http://jellyfin.invalid', apiKey: 'secret' } } },
});
mock.module(new URL('../src/services/outbound-http.js', import.meta.url).href, {
  namedExports: {
    OutboundHttpError: TestOutboundError,
    outboundJson,
    outboundVoid: async () => response(undefined, 204),
  },
});

const jellyfin = await import('../src/services/jellyfin.js');

test('a stale Jellyfin item becomes a safe, classifiable local 404', async () => {
  await assert.rejects(jellyfin.itemDetail('missing'), (error: any) => {
    assert.ok(error instanceof jellyfin.JellyfinRequestError);
    assert.equal(error.status, 404);
    assert.equal(error.message, 'media_not_found');
    assert.equal(error.upstreamStatus, 404);
    assert.equal(jellyfin.isJellyfinNotFound(error), true);
    assert.equal(error.message.includes('/Users/'), false);
    return true;
  });
  await assert.rejects(jellyfin.castSource('missing'), (error: any) => {
    assert.equal(jellyfin.isJellyfinNotFound(error), true);
    return true;
  });
});

test('upstream and network failures become a safe unavailable response', async () => {
  for (const id of ['broken', 'offline']) {
    await assert.rejects(jellyfin.itemDetail(id), (error: any) => {
      assert.ok(error instanceof jellyfin.JellyfinRequestError);
      assert.equal(error.status, 503);
      assert.equal(error.message, 'jellyfin_unavailable');
      assert.equal(jellyfin.isJellyfinNotFound(error), false);
      return true;
    });
  }
});

test.after(() => mock.reset());
