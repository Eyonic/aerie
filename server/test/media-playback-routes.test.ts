import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

const videoSource = {
  id: 'source-1', name: 'Main', containers: ['mkv'], bitrate: 8_192_000,
  supportsDirectPlay: false, supportsDirectStream: true, supportsTranscoding: true,
  defaultAudioStreamIndex: 1,
  video: {
    index: 0, codec: 'h264', width: 1920, height: 1080, bitrate: 8_000_000,
    bitDepth: 8, profile: 'High', level: 41, range: 'SDR', interlaced: false, anamorphic: false,
  },
  audio: [{ index: 1, codec: 'aac', channels: 6, bitrate: 640_000, language: 'eng', title: 'English 5.1', default: true }],
};

mock.module(new URL('../src/config.js', import.meta.url).href, {
  namedExports: { config: { jwtSecret: 'route-test-signing-secret' } },
});
mock.module(new URL('../src/lib/auth.js', import.meta.url).href, {
  namedExports: { requireAdmin: (_req: any, _res: any, next: () => void) => next() },
});
mock.module(new URL('../src/lib/db.js', import.meta.url).href, {
  namedExports: {
    db: {
      prepare: () => ({ all: () => [], get: () => undefined, run: () => ({}) }),
      transaction: (fn: () => unknown) => fn,
    },
    audit: () => {},
  },
});
mock.module(new URL('../src/services/jellyfin.js', import.meta.url).href, {
  namedExports: {
    configured: () => true,
    itemDetail: async () => ({ id: 'movie-1', type: 'Movie', name: 'Movie' }),
    listByType: async () => [], listAllByType: async () => [], pageByType: async () => ({ items: [], total: 0 }),
    episodes: async () => [], children: async () => [], genres: async () => [], search: async () => [],
    directImageUrl: () => 'http://jellyfin.invalid/image', directSubtitleUrl: () => 'http://jellyfin.invalid/subtitle',
    directVideoStreamUrl: () => 'http://jellyfin.invalid/video', jellyUserId: async () => 'user-1',
    jellyfinBase: () => 'http://jellyfin.invalid', jellyfinKey: () => 'upstream-secret',
    mediaStreams: async () => ({ audio: [], subtitles: [] }),
    chapters: async () => [{ name: 'Opening', startSec: 0, endSec: 12.5 }],
    libraryScanStatus: async () => ({}), startLibraryScan: async () => {}, metadata: async () => ({}),
    updateMetadata: async () => {}, refreshItem: async () => {}, recommendationCatalog: async () => ({ suggestions: [], recentlyAdded: [] }),
    similar: async () => [], videoPlaybackSources: async () => [videoSource],
  },
});
mock.module(new URL('../src/services/progress.js', import.meta.url).href, {
  namedExports: {
    get: () => null, mapFor: () => new Map(), resume: () => [], remove: () => {}, report: () => {}, setPlayed: () => {},
    popularGenres: () => [], touchRecommendation: () => {}, recommendationTouches: () => new Set(),
  },
});
mock.module(new URL('../src/services/jellyfin-progress.js', import.meta.url).href, {
  namedExports: { progressItem: async () => null, reconcileMissingItem: () => {}, reconcileMissingSeries: () => {} },
});
mock.module(new URL('../src/services/image-cache.js', import.meta.url).href, {
  namedExports: { cachedWebp: async () => ({}), fetchImage: async () => Buffer.alloc(0), imageWidth: () => 480 },
});
mock.module(new URL('../src/services/video-thumbnail.js', import.meta.url).href, {
  namedExports: { jellyfinSource: async () => ({}), videoFrame: async () => Buffer.alloc(0) },
});
mock.module(new URL('../src/services/media-proxy.js', import.meta.url).href, {
  namedExports: {
    copyMediaHeaders: () => {}, mediaBytes: async () => ({ status: 200, body: Buffer.alloc(0) }),
    mediaText: async () => ({ status: 200, body: '#EXTM3U' }), openMediaStream: async () => ({}), pipeMediaBody: async () => {},
    mediaTarget: (value: string | URL) => new URL(String(value)),
  },
});

const router = (await import('../src/routes/media.js')).default;

function handler(method: string, path: string) {
  const layer = (router as any).stack.find((entry: any) => entry.route?.path === path && entry.route.methods?.[method]);
  assert.ok(layer, `${method.toUpperCase()} ${path} route missing`);
  return layer.route.stack.at(-1).handle;
}

function responseCapture() {
  const headers = new Map<string, string>();
  let status = 200;
  let body: any;
  return {
    response: {
      setHeader(name: string, value: unknown) { headers.set(name.toLowerCase(), String(value)); },
      status(value: number) { status = value; return this; },
      json(value: unknown) { body = value; return this; },
      send(value: unknown) { body = value; return this; },
    },
    value: () => ({ headers, status, body }),
  };
}

test('chapter route returns the dedicated bounded chapter contract', async () => {
  const capture = responseCapture();
  await handler('get', '/item/:id/chapters')(
    { params: { id: 'movie-1' }, query: {}, user: { id: 7, features: {} } }, capture.response, assert.fail,
  );
  const result = capture.value();
  assert.equal(result.status, 200);
  assert.equal(result.headers.get('cache-control'), 'private, max-age=300');
  assert.deepEqual(result.body, { chapters: [{ name: 'Opening', startSec: 0, endSec: 12.5 }] });
});

test('playback preflight exposes truthful normalized status without an upstream credential', async () => {
  const capture = responseCapture();
  await handler('get', '/playback/:id')(
    { params: { id: 'movie-1' }, query: { quality: '720p', audioChannels: '6' }, user: { id: 7, features: {} } },
    capture.response,
    assert.fail,
  );
  const result = capture.value();
  assert.equal(result.headers.get('cache-control'), 'no-store');
  assert.equal(result.body.delivery, 'transcode');
  assert.equal(result.body.output.height, 720);
  assert.equal(result.body.output.audioChannels, 6);
  assert.equal(result.body.audio.surroundAvailable, true);
  assert.equal(JSON.stringify(result.body).includes('upstream-secret'), false);
  assert.ok(String(result.body.streamUrl).startsWith('/api/media/stream/movie-1?'));
});

test('legacy stream entrypoint now returns a multi-rendition credential-free adaptive master', async () => {
  const capture = responseCapture();
  await handler('get', '/stream/:id')(
    { params: { id: 'movie-1' }, query: { audioChannels: '6' }, headers: {}, user: { id: 7, features: {} } },
    capture.response,
    assert.fail,
  );
  const result = capture.value();
  assert.equal(result.headers.get('content-type'), 'application/vnd.apple.mpegurl');
  assert.equal(result.headers.get('x-aerie-play-method'), 'Adaptive');
  assert.ok(String(result.body).includes('#EXT-X-STREAM-INF'));
  assert.ok(String(result.body).includes('/api/media/stream/movie-1?'));
  assert.equal(String(result.body).includes('api_key'), false);
  assert.equal(String(result.body).includes('upstream-secret'), false);
});

test.after(() => mock.reset());
