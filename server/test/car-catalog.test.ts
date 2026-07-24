import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

const song = {
  id: 'song-1', type: 'Audio' as const, name: 'Road Song',
  albumArtist: 'Aerie', album: 'Open Roads', albumId: 'album-1',
  runtimeTicks: 180 * 1e7,
};
const album = { id: 'album-1', type: 'MusicAlbum' as const, name: 'Open Roads', albumArtist: 'Aerie' };
const book = {
  id: 'book-1', libraryItemId: 'book-1', title: 'Long Drive', author: 'A. Reader',
  durationSec: 300, currentTimeSec: 222, mediaType: 'book' as const,
};
const tracks = [
  { ino: '11', index: 1, title: 'Part 1', durationSec: 100, mimeType: 'audio/mpeg' },
  { ino: '22', index: 2, title: 'Part 2', durationSec: 200, mimeType: 'audio/mpeg' },
];

let savedRows = new Map<string, { positionTicks: number; durationTicks: number; played: boolean }>();
let resumeRows: any[] = [];
let activeUserRow: any = { id: 7, features: { music: true, audiobooks: true } };

mock.module(new URL('../src/lib/auth.js', import.meta.url).href, {
  namedExports: {
    findUserById: (id: number) => activeUserRow?.id === id ? activeUserRow : undefined,
    rowToUser: (row: any) => row,
  },
});

mock.module(new URL('../src/services/jellyfin.js', import.meta.url).href, {
  namedExports: {
    configured: () => true,
    itemDetail: async (id: string) => {
      if (id === song.id) return song;
      throw new Error('not_found');
    },
    children: async (id: string) => id === album.id ? [song] : [],
    pageByType: async (type: string) => ({ items: type === 'MusicAlbum' ? [album] : [song], total: 1 }),
    searchAudio: async () => [song, album],
    listByType: async () => [song],
  },
});
mock.module(new URL('../src/services/audiobookshelf.js', import.meta.url).href, {
  namedExports: {
    configured: () => true,
    itemDetail: async (id: string) => {
      if (id === book.id) return book;
      throw new Error('not_found');
    },
    getAudioTracks: async () => tracks,
    allBooks: async () => [book],
    allBooksPage: async () => ({ items: [book], total: 1 }),
  },
});
mock.module(new URL('../src/services/progress.js', import.meta.url).href, {
  namedExports: {
    get: (_userId: number, id: string) => savedRows.get(id) || null,
    mapFor: (_userId: number, ids: string[]) => new Map(ids.flatMap(id => {
      const row = savedRows.get(id);
      return row ? [[id, row] as const] : [];
    })),
    resume: () => resumeRows,
    report: () => undefined,
  },
});

const { carCatalogTestApi } = await import('../src/routes/car.js');
const req = { user: { id: 7, features: { music: true, audiobooks: true } } } as any;

test.after(() => mock.reset());
test.beforeEach(() => {
  savedRows = new Map();
  resumeRows = [];
  activeUserRow = { id: 7, features: { music: true, audiobooks: true } };
});

test('a selected song resumes unfinished progress and restarts after completion', async () => {
  const id = carCatalogTestApi.encode({ kind: 'song', id: song.id });
  savedRows.set(song.id, { positionTicks: 42 * 1e7, durationTicks: 180 * 1e7, played: false });
  assert.equal((await carCatalogTestApi.resolveQueue(req, carCatalogTestApi.decode(id))).startPositionMs, 42_000);

  savedRows.set(song.id, { positionTicks: 180 * 1e7, durationTicks: 180 * 1e7, played: true });
  assert.equal((await carCatalogTestApi.resolveQueue(req, carCatalogTestApi.decode(id))).startPositionMs, 0);
});

test('audiobook resume maps global progress to a file, while an explicit file selection wins', async () => {
  savedRows.set(book.id, { positionTicks: 130 * 1e7, durationTicks: 300 * 1e7, played: false });
  const bookId = carCatalogTestApi.encode({ kind: 'book', id: book.id });
  const resumed = await carCatalogTestApi.resolveQueue(req, carCatalogTestApi.decode(bookId));
  assert.equal(resumed.startIndex, 1);
  assert.equal(resumed.startPositionMs, 30_000);
  assert.deepEqual(resumed.items.map((item: any) => item.progressOffsetMs), [0, 100_000]);

  const trackId = carCatalogTestApi.encode({ kind: 'booktrack', id: book.id, extra: '11' });
  const selected = await carCatalogTestApi.resolveQueue(req, carCatalogTestApi.decode(trackId));
  assert.equal(selected.startIndex, 0);
  assert.equal(selected.startPositionMs, 0);
});

test('general Play has useful defaults for a member with no listening history', async () => {
  const result = await carCatalogTestApi.defaultItems(req);
  assert.ok(result.some((item: any) => item.playable && item.mediaType === 'music'));
  assert.ok(result.some((item: any) => item.playable && item.mediaType === 'audiobook'));
  const audiobook = result.find((item: any) => item.mediaType === 'audiobook');
  assert.equal(audiobook.progressMs, undefined, 'shared Audiobookshelf progress must not leak into Aerie users');
});

test('catalogue artwork uses a short-lived exact-resource capability, never an account token URL', () => {
  const now = Date.parse('2026-07-22T12:00:00Z');
  const items = carCatalogTestApi.capabilityItems(req, [{
    id: 'song', title: 'Song', browsable: false, playable: true,
    artworkUrl: '/api/media/image/album-1/Primary?w=480&tag=backend-cache-tag',
  }], now);
  const artworkUrl = items[0].artworkUrl;
  assert.match(artworkUrl, /^\/api\/car-artwork\/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  assert.equal(new URL(artworkUrl, 'https://aerie.example').search, '');
  assert.doesNotMatch(artworkUrl, /token=|authorization|bearer/i);

  const capability = artworkUrl.slice('/api/car-artwork/'.length);
  const claim = carCatalogTestApi.verifyArtworkCapability(capability, now + 1_000);
  assert.deepEqual(
    { userId: claim.userId, source: claim.source, id: claim.id },
    { userId: 7, source: 'music', id: 'album-1' },
  );
  assert.ok(claim.expiresAt - Math.floor(now / 1000) <= carCatalogTestApi.artworkTtlSeconds);
  const tamperedSuffix = capability.endsWith('x') ? 'y' : 'x';
  const tamperedCapability = `${capability.slice(0, -1)}${tamperedSuffix}`;
  assert.throws(() => carCatalogTestApi.verifyArtworkCapability(tamperedCapability, now + 1_000));
  assert.throws(() => carCatalogTestApi.verifyArtworkCapability(capability,
    now + (carCatalogTestApi.artworkTtlSeconds + 1) * 1000));
});

test('artwork capabilities cannot become general proxies and recheck active feature access', () => {
  const now = Date.parse('2026-07-22T12:00:00Z');
  const unsafe = carCatalogTestApi.capabilityItems(req, [{
    id: 'unsafe', title: 'Unsafe', browsable: false, playable: true,
    artworkUrl: 'https://unrelated.example/private-file',
  }, {
    id: 'file', title: 'File', browsable: false, playable: true,
    artworkUrl: '/api/files/raw?path=/secret',
  }], now);
  assert.equal(unsafe[0].artworkUrl, undefined);
  assert.equal(unsafe[1].artworkUrl, undefined);

  const capability = carCatalogTestApi.issueArtworkCapability(7, { source: 'music', id: 'album-1' }, now);
  assert.equal(carCatalogTestApi.authorizeArtworkCapability(capability, now + 1_000)?.id, 'album-1');
  activeUserRow = { id: 7, features: { music: false, audiobooks: true } };
  assert.equal(carCatalogTestApi.authorizeArtworkCapability(capability, now + 1_000), null);
  activeUserRow = null;
  assert.equal(carCatalogTestApi.authorizeArtworkCapability(capability, now + 1_000), null);
  assert.throws(() => carCatalogTestApi.issueArtworkCapability(7,
    { source: 'music', id: '../not-an-art-id' }, now));
});
