import assert from 'node:assert/strict';
import test from 'node:test';
import {
  extractJellyseerrRequestId,
  MAX_REQUEST_OWNERSHIP_AUDIT_ROWS,
  MAX_REQUEST_OWNERSHIP_AUDIT_TARGETS,
  mediaRequestAuditRecord,
  requestOwnershipAuditTargets,
  requestsOwnedByUser,
  validateMediaRequestInput,
} from '../src/services/request-ownership.js';

test('media request input accepts only bounded movie and TV identities/seasons', () => {
  assert.deepEqual(validateMediaRequestInput({ mediaType: 'movie', mediaId: 10 }), {
    ok: true, value: { mediaType: 'movie', mediaId: 10 },
  });
  assert.deepEqual(validateMediaRequestInput({ mediaType: 'tv', mediaId: 20, seasons: '2,1,2' }), {
    ok: true, value: { mediaType: 'tv', mediaId: 20, seasons: [2, 1] },
  });
  assert.equal(validateMediaRequestInput({ mediaType: 'music', mediaId: 10 }).ok, false);
  assert.equal(validateMediaRequestInput({ mediaType: 'movie', mediaId: '10' }).ok, false);
  assert.equal(validateMediaRequestInput({ mediaType: 'movie', mediaId: 10, seasons: 'all' }).ok, false);
  assert.equal(validateMediaRequestInput({ mediaType: 'tv', mediaId: 10, seasons: { all: true } }).ok, false);
  assert.equal(validateMediaRequestInput({ mediaType: 'tv', mediaId: 10, seasons: [0] }).ok, false);
  assert.equal(validateMediaRequestInput({ mediaType: 'tv', mediaId: 10, seasons: `${'1,'.repeat(100_000)}1` }).ok, false);
});

test('successful request audits prefer the exact upstream request id', () => {
  assert.equal(extractJellyseerrRequestId({ request: { id: 82 } }), 82);
  assert.equal(extractJellyseerrRequestId({ id: '82' }), null);
  assert.deepEqual(mediaRequestAuditRecord({ mediaType: 'tv', mediaId: 500, seasons: 'all' }, { id: 82 }), {
    target: 'jellyseerr-request:82',
    meta: { jellyseerrRequestId: 82, mediaType: 'tv', mediaId: 500 },
  });
  assert.deepEqual(mediaRequestAuditRecord({ mediaType: 'movie', mediaId: 501 }, {}), {
    target: 'movie:501',
    meta: { mediaType: 'movie', mediaId: 501 },
  });
});

test('request ownership isolates accounts, strips usernames, and admits only plausible legacy rows', () => {
  const requests = [
    { id: 11, mediaType: 'movie', tmdbId: 101, title: 'Seven', requestedBy: 'upstream seven', createdAt: '2026-07-24T12:00:00Z' },
    { id: 12, mediaType: 'tv', tmdbId: 202, title: 'Eight', requestedBy: 'upstream eight', createdAt: '2026-07-24T12:01:00Z' },
    { id: 13, mediaType: 'movie', tmdbId: 303, title: 'Legacy seven', requestedBy: 'upstream', createdAt: '2026-07-24T12:02:00Z' },
    { id: 14, mediaType: 'movie', tmdbId: 404, title: 'Later reuse', requestedBy: 'upstream', createdAt: '2026-07-24T12:03:00Z' },
    { id: 15, mediaType: 'tv', tmdbId: 505, title: 'Auto seven', requestedBy: 'upstream', createdAt: '2026-07-24T12:04:00Z' },
  ];
  const audits = [
    { id: 1, user_id: 7, ts: '2026-07-24 12:00:01', target: 'jellyseerr-request:11', meta: JSON.stringify({ jellyseerrRequestId: 11, mediaType: 'movie', mediaId: 101 }) },
    { id: 2, user_id: 8, ts: '2026-07-24 12:01:01', target: 'jellyseerr-request:12', meta: JSON.stringify({ jellyseerrRequestId: 12, mediaType: 'tv', mediaId: 202 }) },
    { id: 3, user_id: 7, ts: '2026-07-24 12:02:10', target: 'movie:303', meta: null },
    // Same TMDB id, but far outside the two-minute creation window: this stale
    // ownership record cannot claim a later Jellyseerr request.
    { id: 4, user_id: 7, ts: '2026-07-23 12:03:00', target: 'movie:404', meta: null },
    // Auto-request keeps its human-readable target but records the exact id in metadata.
    { id: 5, user_id: 7, ts: '2026-07-24 12:04:01', target: 'Auto title', meta: JSON.stringify({ jellyseerrRequestId: 15, mediaType: 'tv', mediaId: 505 }) },
  ];

  const seven = requestsOwnedByUser(requests, audits, 7);
  const eight = requestsOwnedByUser(requests, audits, 8);
  assert.deepEqual(seven.map(row => row.id), [11, 13, 15]);
  assert.deepEqual(eight.map(row => row.id), [12]);
  assert.ok(seven.every(row => !Object.hasOwn(row, 'requestedBy')));
  assert.ok(eight.every(row => !Object.hasOwn(row, 'requestedBy')));
});

test('ownership lookup targets are exact, deduplicated, and have a fixed placeholder ceiling', () => {
  const requests = Array.from({ length: 100 }, (_, index) => ({
    id: index + 1,
    mediaType: index % 2 ? 'tv' : 'movie',
    tmdbId: 1_000 + index,
  }));
  const targets = requestOwnershipAuditTargets(requests);
  assert.equal(targets.length, MAX_REQUEST_OWNERSHIP_AUDIT_TARGETS);
  assert.deepEqual(targets.slice(0, 4), [
    'jellyseerr-request:1', 'movie:1000', 'jellyseerr-request:2', 'tv:1001',
  ]);
  assert.equal(targets.includes('jellyseerr-request:41'), false);
  assert.deepEqual(requestOwnershipAuditTargets([
    { id: 5, mediaType: 'movie', tmdbId: 8 },
    { id: 5, mediaType: 'movie', tmdbId: 8 },
    null,
  ]), ['jellyseerr-request:5', 'movie:8']);
});

test('ownership reconciliation fails closed above its audit-row budget', () => {
  const request = [{ id: 5, mediaType: 'movie', tmdbId: 8 }];
  const audits = Array.from({ length: MAX_REQUEST_OWNERSHIP_AUDIT_ROWS + 1 }, (_, index) => ({
    id: index + 1,
    user_id: 7,
    action: 'media_requested',
    target: 'jellyseerr-request:5',
    meta: JSON.stringify({ jellyseerrRequestId: 5, mediaType: 'movie', mediaId: 8 }),
  }));
  assert.deepEqual(requestsOwnedByUser(request, audits, 7), []);
});

test('auto-request title shapes cannot impersonate legacy media identities', () => {
  const request = [{ id: 30, mediaType: 'movie', tmdbId: 600, createdAt: '2026-07-24T12:00:00Z' }];
  const titleCollision = [{
    id: 1,
    user_id: 7,
    action: 'auto_requested',
    ts: '2026-07-24 12:00:01',
    target: 'movie:600',
    meta: JSON.stringify({ kind: 'artist', title: 'movie:600' }),
  }];
  assert.deepEqual(requestsOwnedByUser(request, titleCollision, 7), []);

  const typedFallback = [{
    ...titleCollision[0],
    meta: JSON.stringify({ kind: 'movie', title: 'Real title', mediaType: 'movie', mediaId: 600 }),
  }];
  assert.deepEqual(requestsOwnedByUser(request, typedFallback, 7).map(row => row.id), [30]);
});

test('ambiguous exact or equally close legacy ownership is hidden from every account', () => {
  const requests = [
    { id: 20, mediaType: 'movie', tmdbId: 600, createdAt: '2026-07-24T12:00:00Z' },
    { id: 21, mediaType: 'tv', tmdbId: 700, createdAt: '2026-07-24T12:10:00Z' },
  ];
  const audits = [
    { id: 1, user_id: 7, target: 'jellyseerr-request:20', meta: JSON.stringify({ mediaType: 'movie', mediaId: 600 }) },
    { id: 2, user_id: 8, target: 'jellyseerr-request:20', meta: JSON.stringify({ mediaType: 'movie', mediaId: 600 }) },
    { id: 3, user_id: 7, ts: '2026-07-24 12:09:59', target: 'tv:700' },
    { id: 4, user_id: 8, ts: '2026-07-24 12:10:01', target: 'tv:700' },
  ];
  assert.deepEqual(requestsOwnedByUser(requests, audits, 7), []);
  assert.deepEqual(requestsOwnedByUser(requests, audits, 8), []);
});
