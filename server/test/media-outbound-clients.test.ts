import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

type Call = { kind: 'json' | 'text' | 'bytes' | 'void'; url: string; options: any };
const calls: Call[] = [];

class TestOutboundError extends Error {
  constructor(readonly code: string, readonly upstreamStatus?: number) {
    super(code);
  }
}

function metadata<T>(body: T, status = 200) {
  return { url: 'http://redacted.invalid/', status, statusText: '', headers: new Headers(), body };
}

const outboundJson = async (value: string | URL, options: any = {}) => {
  const url = String(value);
  calls.push({ kind: 'json', url, options });
  if (/\/Users\/?(?:\?|$)/.test(url)) return metadata([{ Id: 'jf-user' }]);
  if (url.includes('/Users/jf-user/Items')) return metadata({ Items: [], TotalRecordCount: 0 });
  if (url.includes('/api/libraries')) return metadata({ libraries: [] });
  if (url.includes('/api/v1/status')) return metadata({ version: '2.0' });
  return metadata({});
};

const outboundText = async (value: string | URL, options: any = {}) => {
  const url = String(value);
  calls.push({ kind: 'text', url, options });
  if (url.includes('/System/Info')) return metadata(JSON.stringify({ Version: '10.9', ServerName: 'Home' }));
  if (url.endsWith('/api/v1/system/status')) return metadata(JSON.stringify({ version: '1.0' }));
  if (url.includes('/artist/lookup')) return metadata(JSON.stringify([{
    foreignArtistId: 'mbid-1', artistName: 'Example Artist', images: [],
  }]));
  if (url.endsWith('/api/v1/rootfolder')) return metadata(JSON.stringify([{
    path: '/music', defaultQualityProfileId: 1, defaultMetadataProfileId: 1,
  }]));
  if (url.endsWith('/api/v1/artist') && options.method === 'POST') {
    return metadata('artist has already been added', 400);
  }
  if (url.endsWith('/api/v1/artist')) return metadata('[]');
  return metadata('{}');
};

const outboundVoid = async (value: string | URL, options: any = {}) => {
  calls.push({ kind: 'void', url: String(value), options });
  return metadata(undefined, 204);
};

const outboundBytes = async (value: string | URL, options: any = {}) => {
  calls.push({ kind: 'bytes', url: String(value), options });
  return { ...metadata(Buffer.from('image')), headers: new Headers({ 'content-type': 'image/jpeg' }) };
};

function validateOutboundUrl(value: string | URL): URL {
  const url = new URL(String(value));
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new TestOutboundError('invalid_url');
  return url;
}

mock.module(new URL('../src/services/outbound-http.js', import.meta.url).href, {
  namedExports: {
    OutboundHttpError: TestOutboundError,
    outboundJson,
    outboundText,
    outboundVoid,
    outboundBytes,
    validateOutboundUrl,
  },
});

const config = {
  port: 8200,
  dataDir: '/tmp',
  mediaRoot: '/tmp',
  filesRoot: '/tmp',
  jellyfin: { url: 'http://jellyfin.lan:8096', apiKey: 'jf-secret' },
  audiobookshelf: { url: 'http://books.lan:13378', apiKey: 'abs-secret' },
  jellyseerr: { url: 'http://requests.lan:5055', apiKey: 'js-secret' },
  lidarr: { url: 'http://lidarr.lan:8686', apiKey: 'lidarr-secret' },
  ollama: { url: 'http://ollama.lan:11434' },
  deepseek: { url: 'https://api.deepseek.test', apiKey: 'deepseek-secret' },
  sd: { url: 'http://comfy.lan:8188' },
  acestep: { url: 'http://music.lan:8001' },
  whisper: { url: 'http://whisper.lan:10300' },
};
mock.module(new URL('../src/config.js', import.meta.url).href, {
  namedExports: { config, cfgVal: () => '' },
});
mock.module(new URL('../src/lib/auth.js', import.meta.url).href, {
  namedExports: { requireAdmin: (_req: any, _res: any, next: () => void) => next() },
});
mock.module(new URL('../src/lib/db.js', import.meta.url).href, {
  namedExports: { getSetting: () => '', setSetting: () => {}, audit: () => {} },
});
mock.module(new URL('../src/lib/overrides.js', import.meta.url).href, {
  namedExports: { setOverride: () => {}, hasOverride: () => false },
});
mock.module(new URL('../src/services/secrets.js', import.meta.url).href, {
  namedExports: { isSealed: () => true, seal: (value: string) => value, unseal: (value: string) => value },
});

const originalFetch = globalThis.fetch;
globalThis.fetch = (async () => { throw new Error('raw_fetch_bypassed_outbound_helper'); }) as typeof fetch;

const jellyfin = await import('../src/services/jellyfin.js');
const audiobookshelf = await import('../src/services/audiobookshelf.js');
const jellyseerr = await import('../src/services/jellyseerr.js');
const lidarr = await import('../src/services/lidarr.js');
const monitoring = await import('../src/services/monitoring.js');
const integrations = (await import('../src/routes/integrations.js')).default;

function routeHandler(method: string, routePath: string) {
  const layer = (integrations as any).stack.find((item: any) => item.route?.path === routePath
    && item.route.methods?.[method]);
  assert.ok(layer, `${method.toUpperCase()} ${routePath} route missing`);
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

test('media clients and connection probes use bounded credential-safe outbound calls', async () => {
  await jellyfin.listByType('Movie', { Limit: 1 });
  await jellyfin.startLibraryScan();
  assert.deepEqual(await audiobookshelf.libraries(), []);
  await audiobookshelf.updateProgress('book-1', 5, 10);
  assert.equal(await jellyseerr.status(), true);
  assert.equal((await jellyseerr.imageProxy('/poster.jpg', 320))?.buf.toString(), 'image');
  assert.equal(await lidarr.status(), true);
  assert.deepEqual(await lidarr.requestArtist('mbid-1'), {
    ok: true, already: true, name: 'Example Artist', foreignArtistId: 'mbid-1',
  });
  const statuses = await monitoring.serviceStatuses();
  assert.equal(statuses.find(status => status.key === 'jellyfin')?.online, true);
  assert.equal(statuses.find(status => status.key === 'abs')?.online, true);

  let probePayload: any;
  await routeHandler('post', '/test/:service')(
    { params: { service: 'jellyfin' } },
    { json: (value: any) => { probePayload = value; } },
  );
  assert.deepEqual(probePayload, { ok: true, detail: 'Jellyfin 10.9 — "Home"' });

  const jellyfinJson = calls.find(call => call.kind === 'json' && call.url.includes('/Users'))!;
  assert.equal(jellyfinJson.options.headers['X-Emby-Token'], 'jf-secret');
  assert.equal(jellyfinJson.options.timeoutMs, 15_000);
  assert.equal(jellyfinJson.options.maxBytes, 8 * 1024 * 1024);
  const absJson = calls.find(call => call.kind === 'json' && call.url.includes('/api/libraries'))!;
  assert.equal(absJson.options.headers.Authorization, 'Bearer abs-secret');
  const image = calls.find(call => call.kind === 'bytes')!;
  assert.equal(image.options.maxBytes, 16 * 1024 * 1024);
  assert.ok(calls.every(call => Number.isSafeInteger(call.options.timeoutMs)), 'every call must have a timeout');

  let statusCode = 200;
  let invalidPayload: any;
  const response = {
    status(code: number) { statusCode = code; return this; },
    json(value: any) { invalidPayload = value; return this; },
  };
  await routeHandler('put', '/')({
    body: { JELLYFIN_URL: 'http://operator:password@jellyfin.lan' },
  }, response);
  assert.equal(statusCode, 400);
  assert.deepEqual(invalidPayload, { error: 'invalid_value:JELLYFIN_URL' });
});

test.after(() => {
  globalThis.fetch = originalFetch;
  mock.reset();
});
