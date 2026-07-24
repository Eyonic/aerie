import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import {
  MAX_REQUEST_OWNERSHIP_AUDIT_ROWS,
  MAX_REQUEST_OWNERSHIP_AUDIT_TARGETS,
} from '../src/services/request-ownership.js';

type AuditRow = { id: number; ts: string; user_id: number; target: string; meta?: string | null };

let mediaRows: any[] = [];
let musicRows: Array<AuditRow & { name: string }> = [];
let submittedResult: any = { id: 900 };
const submitted: any[] = [];
const writtenAudits: any[] = [];

const fakeDb = {
  prepare(sql: string) {
    if (sql.includes("action='music_requested'")) {
      assert.match(sql, /user_id=\?/);
      assert.doesNotMatch(sql, /username/);
      return {
        all(userId: number) {
          return musicRows
            .filter(row => row.user_id === userId)
            .map(row => ({ ts: row.ts, target: row.target, meta: row.meta }));
        },
      };
    }
    if (sql.includes("action IN ('media_requested','auto_requested')")) {
      assert.match(sql, /target IN \(\?(?:,\?)*\)/);
      assert.match(sql, /LIMIT \?/);
      return {
        all(...parameters: unknown[]) {
          const limit = parameters.pop();
          assert.equal(limit, MAX_REQUEST_OWNERSHIP_AUDIT_ROWS + 1);
          assert.ok(parameters.length <= MAX_REQUEST_OWNERSHIP_AUDIT_TARGETS);
          const targets = new Set(parameters);
          return mediaRows
            .filter(row => targets.has(row.target))
            .slice(0, Number(limit))
            .map(row => ({ ...row }));
        },
      };
    }
    throw new Error(`unexpected requests SQL: ${sql}`);
  },
};

mock.module(new URL('../src/lib/db.js', import.meta.url).href, {
  namedExports: {
    db: fakeDb,
    audit: (...args: any[]) => { writtenAudits.push(args); },
  },
});

const listedRequests = [
  { id: 101, status: 2, mediaType: 'movie', tmdbId: 10, title: 'Seven', requestedBy: 'Jelly user 7', createdAt: '2026-07-24T10:00:00Z' },
  { id: 202, status: 2, mediaType: 'tv', tmdbId: 20, title: 'Eight', requestedBy: 'Jelly user 8', createdAt: '2026-07-24T10:01:00Z' },
  { id: 303, status: 1, mediaType: 'movie', tmdbId: 30, title: 'Legacy seven', requestedBy: 'Jelly admin', createdAt: '2026-07-24T10:02:00Z' },
  { id: 404, status: 1, mediaType: 'movie', tmdbId: 40, title: 'Later reuse', requestedBy: 'Jelly admin', createdAt: '2026-07-24T10:03:00Z' },
];

mock.module(new URL('../src/services/jellyseerr.js', import.meta.url).href, {
  namedExports: {
    configured: () => true,
    status: async () => true,
    search: async () => [],
    trending: async () => [],
    listRequests: async () => listedRequests.map(row => ({ ...row })),
    requestMedia: async (...args: any[]) => { submitted.push(args); return submittedResult; },
    imageProxy: async () => null,
  },
});

mock.module(new URL('../src/services/lidarr.js', import.meta.url).href, {
  namedExports: {
    configured: () => true,
    status: async () => true,
    searchArtists: async () => [],
    trendingArtists: async () => [],
    artistStatuses: async () => new Map([
      ['mbid-seven', { name: 'Seven Artist', status: 'available', percent: 100 }],
      ['mbid-eight', { name: 'Eight Artist', status: 'downloading', percent: 30 }],
    ]),
    requestArtist: async () => ({ ok: true }),
    requestArtistByName: async () => ({ ok: true }),
  },
});

mock.module(new URL('../src/services/image-cache.js', import.meta.url).href, {
  namedExports: {
    cachedWebp: async () => ({ hit: false, file: '/tmp/not-used' }),
    imageWidth: () => 480,
  },
});

const requestsRouter = (await import('../src/routes/requests.js')).default;

function routeHandler(method: string, routePath: string) {
  const layer = (requestsRouter as any).stack.find((item: any) => item.route?.path === routePath
    && item.route.methods?.[method]);
  assert.ok(layer, `${method.toUpperCase()} ${routePath} route missing`);
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

function response() {
  const state = { status: 200, body: undefined as any };
  const res = {
    status(code: number) { state.status = code; return this; },
    json(value: any) { state.body = value; return this; },
    end() { return this; },
    setHeader() { return this; },
    sendFile() { return this; },
  };
  return { state, res };
}

async function invoke(method: string, routePath: string, request: any) {
  const { state, res } = response();
  let nextError: unknown;
  await routeHandler(method, routePath)(request, res, (error?: unknown) => { nextError = error; });
  if (nextError) throw nextError;
  return state;
}

test.beforeEach(() => {
  submitted.length = 0;
  writtenAudits.length = 0;
  submittedResult = { id: 900 };
  mediaRows = [
    { id: 1, user_id: 7, action: 'media_requested', ts: '2026-07-24 10:00:01', target: 'jellyseerr-request:101', meta: JSON.stringify({ jellyseerrRequestId: 101, mediaType: 'movie', mediaId: 10 }) },
    { id: 2, user_id: 8, action: 'media_requested', ts: '2026-07-24 10:01:01', target: 'jellyseerr-request:202', meta: JSON.stringify({ jellyseerrRequestId: 202, mediaType: 'tv', mediaId: 20 }) },
    { id: 3, user_id: 7, action: 'media_requested', ts: '2026-07-24 10:02:10', target: 'movie:30', meta: null },
    { id: 4, user_id: 8, action: 'media_requested', ts: '2026-06-01 10:03:00', target: 'movie:40', meta: null },
    // This row would be a disclosure if the route still loaded the whole audit table.
    { id: 5, user_id: 8, action: 'media_requested', ts: '2026-07-24 10:04:00', target: 'movie:999999', meta: null },
  ];
  musicRows = [
    { id: 11, user_id: 7, ts: '2026-07-24 11:00:00', target: 'mbid-seven', meta: JSON.stringify({ name: 'Seven Artist' }), name: 'Seven Artist' },
    { id: 12, user_id: 8, ts: '2026-07-24 11:01:00', target: 'mbid-eight', meta: JSON.stringify({ name: 'Eight Artist' }), name: 'Eight Artist' },
  ];
});

test('movie and TV GET returns only the authenticated account ownership rows', async () => {
  const seven = await invoke('get', '/', { user: { id: 7, username: 'seven' } });
  const eight = await invoke('get', '/', { user: { id: 8, username: 'eight' } });
  assert.deepEqual(seven.body.map((row: any) => row.id), [101, 303]);
  assert.deepEqual(eight.body.map((row: any) => row.id), [202]);
  assert.ok(seven.body.every((row: any) => !Object.hasOwn(row, 'requestedBy')));
  assert.ok(eight.body.every((row: any) => !Object.hasOwn(row, 'requestedBy')));
});

test('movie and TV GET fails closed when relevant ownership history exceeds its row budget', async () => {
  mediaRows = Array.from({ length: MAX_REQUEST_OWNERSHIP_AUDIT_ROWS + 1 }, (_, index) => ({
    id: index + 1,
    user_id: 7,
    action: 'media_requested',
    ts: '2026-07-24 10:00:01',
    target: 'jellyseerr-request:101',
    meta: JSON.stringify({ jellyseerrRequestId: 101, mediaType: 'movie', mediaId: 10 }),
  }));
  const response = await invoke('get', '/', { user: { id: 7, username: 'seven' } });
  assert.deepEqual(response.body, []);
});

test('music mine filters at the database boundary and never emits usernames', async () => {
  const seven = await invoke('get', '/music/mine', { user: { id: 7, username: 'seven' } });
  const eight = await invoke('get', '/music/mine', { user: { id: 8, username: 'eight' } });
  assert.deepEqual(seven.body.map((row: any) => row.foreignArtistId), ['mbid-seven']);
  assert.deepEqual(eight.body.map((row: any) => row.foreignArtistId), ['mbid-eight']);
  assert.ok(seven.body.every((row: any) => !Object.hasOwn(row, 'requestedBy')));
  assert.ok(eight.body.every((row: any) => !Object.hasOwn(row, 'requestedBy')));
});

test('POST validates media before the upstream call and records its exact request id', async () => {
  const invalid = await invoke('post', '/', {
    user: { id: 7, username: 'seven' }, body: { mediaType: 'movie', mediaId: '10' }, ip: '127.0.0.1',
  });
  assert.equal(invalid.status, 400);
  assert.deepEqual(invalid.body, { error: 'invalid_media_id' });
  assert.equal(submitted.length, 0);

  const valid = await invoke('post', '/', {
    user: { id: 7, username: 'seven' }, body: { mediaType: 'tv', mediaId: 20, seasons: '1,2' }, ip: '127.0.0.1',
  });
  assert.equal(valid.status, 200);
  assert.deepEqual(submitted, [['tv', 20, [1, 2]]]);
  assert.deepEqual(writtenAudits, [[
    7,
    'seven',
    'media_requested',
    'jellyseerr-request:900',
    '127.0.0.1',
    { jellyseerrRequestId: 900, mediaType: 'tv', mediaId: 20 },
  ]]);
});

test.after(() => mock.reset());
