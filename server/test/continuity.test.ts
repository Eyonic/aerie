import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ContinuityInputError,
  normalizeContinuityMediaUrl,
  normalizeContinuityRoute,
  normalizeHandoffPayload,
} from '../src/services/continuity.js';

test('continuity routes remain same-origin and do not carry credentials', () => {
  assert.equal(normalizeContinuityRoute('/music/../audiobooks?q=yes&token=secret#chapter'), '/audiobooks?q=yes#chapter');
  assert.equal(normalizeContinuityRoute('/search?q=%2Fmusic'), '/search?q=%2Fmusic');
  assert.equal(normalizeContinuityRoute('/pair?code=ABCD-EFGH&next=%2Fdevices'), '/pair?next=%2Fdevices');
  assert.equal(normalizeContinuityRoute('/music#cbho=secret'), '/music');
  for (const unsafe of ['//outside.example/x', '/\\outside.example/x', '/%2f%2foutside.example',
    '/%5coutside.example', '/bad%', '/line\nbreak']) {
    assert.equal(normalizeContinuityRoute(unsafe), null, unsafe);
  }
});

test('media URLs become token-free local API paths across public and LAN origins', () => {
  assert.equal(
    normalizeContinuityMediaUrl('https://public.example/api/media/stream/song?audio=1&token=secret#ignored'),
    '/api/media/stream/song?audio=1',
  );
  assert.equal(
    normalizeContinuityMediaUrl('/api/files/raw?path=%2FMusic%2Fone.mp3&access_token=secret'),
    '/api/files/raw?path=%2FMusic%2Fone.mp3',
  );
  for (const unsafe of ['https://outside.example/not-api/file.mp3', '//outside.example/api/media/stream/x',
    'javascript:alert(1)', 'data:audio/mp3;base64,AAAA', 'blob:https://aerie.invalid/id', '/files/song.mp3',
    '/api/auth/logout', '/api/admin/users']) {
    assert.equal(normalizeContinuityMediaUrl(unsafe), null, unsafe);
  }
});

test('handoff normalization rebuilds a bounded Track queue and remaps its index', () => {
  const normalized = normalizeHandoffPayload({
    path: '/music?token=page-secret&album=one',
    title: '  Playing\u0000 now  ',
    kind: 'media',
    sentAt: '2026-07-18T10:11:12+02:00',
    audio: {
      index: 1,
      position: '42.5',
      playing: true,
      queue: [
        { id: 'bad', title: 'Outside', streamUrl: 'https://outside.example/file.mp3', kind: 'music' },
        {
          id: 'book:10', title: 'Chapter 1', subtitle: 'Author', kind: 'audiobook',
          streamUrl: '/api/books/file/book/10?token=stream-secret',
          artUrl: 'https://old-lan.example/api/books/cover/book?token=art-secret&w=240',
          durationSec: '3600', startAt: 12,
          cast: { source: 'audiobookshelf', itemId: 'book', fileId: '10', ignored: true },
          injected: { arbitrary: true },
        },
        {
          id: 'file', title: 'Local file', kind: 'music',
          streamUrl: '/api/files/raw?path=%2FMusic%2Fone.mp3&token=stream-secret',
        },
      ],
      ignored: 'field',
    },
    arbitrary: { nested: 'object' },
  }) as any;

  assert.equal(normalized.path, '/music?album=one');
  assert.equal(normalized.title, 'Playing now');
  assert.equal(normalized.sentAt, '2026-07-18T08:11:12.000Z');
  assert.deepEqual(Object.keys(normalized).sort(), ['audio', 'kind', 'path', 'sentAt', 'title']);
  assert.equal(normalized.audio.index, 0, 'selected source item remains selected after invalid entries are dropped');
  assert.equal(normalized.audio.position, 42.5);
  assert.equal(normalized.audio.playing, true);
  assert.equal(normalized.audio.queue.length, 2);
  assert.deepEqual(normalized.audio.queue[0], {
    id: 'book:10', title: 'Chapter 1', streamUrl: '/api/books/file/book/10', kind: 'audiobook',
    subtitle: 'Author', artUrl: '/api/books/cover/book?w=240', durationSec: 3600, startAt: 12,
    cast: { source: 'audiobookshelf', itemId: 'book', fileId: '10' },
  });
  assert.equal(normalized.audio.queue[1].streamUrl, '/api/files/raw?path=%2FMusic%2Fone.mp3');
  assert.equal((normalizeHandoffPayload({ path: '/', title: 'Safe\u202eexe.txt' }) as any).title, 'Safeexe.txt');
});

test('malformed handoff structures are rejected while unsupported tracks are safely omitted', () => {
  assert.throws(() => normalizeHandoffPayload(null), ContinuityInputError);
  assert.throws(() => normalizeHandoffPayload({ path: '//outside.example' }), ContinuityInputError);
  assert.throws(() => normalizeHandoffPayload({ path: '/music', audio: { queue: 'not-an-array' } }), ContinuityInputError);

  assert.deepEqual(normalizeHandoffPayload({
    path: '/music',
    audio: { queue: [{ id: 'x', title: 'x', streamUrl: 'data:audio/mp3,x', kind: 'music' }], playing: true },
  }), { path: '/music', kind: 'page' });
});

test('video state is reduced to safe scalar fields', () => {
  assert.deepEqual(normalizeHandoffPayload({
    path: '/movies', kind: 'unexpected',
    video: { itemId: 'movie-1', position: '123.25', paused: true, streamUrl: 'https://outside.example' },
  }), {
    path: '/movies', kind: 'media',
    video: { itemId: 'movie-1', position: 123.25, paused: true },
  });
});
