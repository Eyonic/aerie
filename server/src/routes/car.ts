// Driver-safe audio catalogue for Android Auto / Android Automotive hosts.
//
// The car never embeds Aerie's web UI.  It browses this deliberately shallow
// tree, resolves a selection to a native playback queue, and streams through the
// existing authenticated Jellyfin/Audiobookshelf proxies.  Keeping the catalogue
// server-side means feature permissions and each member's progress remain the
// same in the browser, phone and car.
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import { Router } from 'express';
import { findUserById, rowToUser, type AuthedRequest } from '../lib/auth.js';
import { config } from '../config.js';
import * as jf from '../services/jellyfin.js';
import * as abs from '../services/audiobookshelf.js';
import * as progress from '../services/progress.js';
import { cachedWebp, fetchImage } from '../services/image-cache.js';
import type { Book, MediaItem } from '../lib/model.js';

const r = Router();
export const carArtworkRouter = Router();
const MAX_BROWSE_ITEMS = 100;
const ARTWORK_CAPABILITY_TTL_SECONDS = 10 * 60;
const MAX_ARTWORK_CAPABILITY_LENGTH = 2048;
const MAX_ARTWORK_BYTES = 5 * 1024 * 1024;
const ARTWORK_SIGNATURE_CONTEXT = 'aerie-car-artwork-v1\0';

type NodeKind = 'section' | 'album' | 'song' | 'book' | 'booktrack';
type NodeRef = { kind: NodeKind; id: string; extra?: string };
type ArtworkSource = 'music' | 'audiobook';
type ArtworkScope = { source: ArtworkSource; id: string };
type ArtworkCapability = { version: 1; userId: number; source: ArtworkSource; id: string; expiresAt: number };

interface CarItem {
  id: string;
  title: string;
  subtitle?: string;
  artworkUrl?: string;
  browsable: boolean;
  playable: boolean;
  durationMs?: number;
  progressMs?: number;
  mediaType?: 'music' | 'audiobook';
  streamUrl?: string;
  progressId?: string;
  progressOffsetMs?: number;
}

function validArtworkId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,256}$/.test(value);
}

function artworkSignature(payload: string): Buffer {
  return crypto.createHmac('sha256', config.jwtSecret)
    .update(ARTWORK_SIGNATURE_CONTEXT)
    .update(payload)
    .digest();
}

function issueArtworkCapability(userId: number, scope: ArtworkScope, nowMs = Date.now()): string {
  if (!Number.isSafeInteger(userId) || userId <= 0 || !validArtworkId(scope.id)
    || !['music', 'audiobook'].includes(scope.source)) throw new Error('invalid_artwork_scope');
  const claim: ArtworkCapability = {
    version: 1,
    userId,
    source: scope.source,
    id: scope.id,
    expiresAt: Math.floor(nowMs / 1000) + ARTWORK_CAPABILITY_TTL_SECONDS,
  };
  const payload = Buffer.from(JSON.stringify(claim), 'utf8').toString('base64url');
  return `${payload}.${artworkSignature(payload).toString('base64url')}`;
}

function verifyArtworkCapability(value: unknown, nowMs = Date.now()): ArtworkCapability {
  const raw = String(value || '');
  if (!raw || raw.length > MAX_ARTWORK_CAPABILITY_LENGTH) throw new Error('invalid_artwork_capability');
  const parts = raw.split('.');
  if (parts.length !== 2 || !parts.every(part => /^[A-Za-z0-9_-]+$/.test(part))) {
    throw new Error('invalid_artwork_capability');
  }
  const expected = artworkSignature(parts[0]);
  let supplied: Buffer;
  try { supplied = Buffer.from(parts[1], 'base64url'); }
  catch { throw new Error('invalid_artwork_capability'); }
  // Buffer's base64url decoder accepts non-canonical aliases whose unused tail
  // bits decode to the same bytes. Capabilities have one exact representation:
  // reject textual mutations even when a permissive decoder would collapse them.
  if (supplied.toString('base64url') !== parts[1]
    || supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) {
    throw new Error('invalid_artwork_capability');
  }
  let claim: ArtworkCapability;
  try { claim = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')); }
  catch { throw new Error('invalid_artwork_capability'); }
  const now = Math.floor(nowMs / 1000);
  if (claim?.version !== 1 || !Number.isSafeInteger(claim.userId) || claim.userId <= 0
    || !['music', 'audiobook'].includes(claim.source) || !validArtworkId(claim.id)
    || !Number.isSafeInteger(claim.expiresAt) || claim.expiresAt <= now
    || claim.expiresAt > now + ARTWORK_CAPABILITY_TTL_SECONDS + 5) {
    throw new Error('invalid_or_expired_artwork_capability');
  }
  return claim;
}

function artworkScope(value: string | undefined): ArtworkScope | null {
  if (!value || value.length > 4096) return null;
  let url: URL;
  try { url = new URL(value, 'http://aerie.invalid'); } catch { return null; }
  if (url.origin !== 'http://aerie.invalid' || url.hash) return null;
  let match = /^\/api\/media\/image\/([^/]+)\/Primary$/.exec(url.pathname);
  if (match) {
    try {
      const id = decodeURIComponent(match[1]);
      return validArtworkId(id) ? { source: 'music', id } : null;
    } catch { return null; }
  }
  match = /^\/api\/books\/cover\/([^/]+)$/.exec(url.pathname);
  if (match) {
    try {
      const id = decodeURIComponent(match[1]);
      return validArtworkId(id) ? { source: 'audiobook', id } : null;
    } catch { return null; }
  }
  return null;
}

function capabilityItems(req: AuthedRequest, items: CarItem[], nowMs = Date.now()): CarItem[] {
  return items.map(item => {
    const scope = artworkScope(item.artworkUrl);
    if (!scope) return item.artworkUrl ? { ...item, artworkUrl: undefined } : item;
    const capability = issueArtworkCapability(req.user!.id, scope, nowMs);
    return { ...item, artworkUrl: `/api/car-artwork/${encodeURIComponent(capability)}` };
  });
}

function authorizeArtworkCapability(token: unknown, nowMs = Date.now()): ArtworkCapability | null {
  let claim: ArtworkCapability;
  try { claim = verifyArtworkCapability(token, nowMs); } catch { return null; }
  const row = findUserById(claim.userId);
  if (!row) return null;
  const user = rowToUser(row);
  if (claim.source === 'music') {
    if (user.features?.music === false || !jf.configured()) return null;
  } else if (user.features?.audiobooks === false || !abs.configured()) return null;
  return claim;
}

carArtworkRouter.get('/:capability', async (req, res, next) => {
  try {
    const claim = authorizeArtworkCapability(req.params.capability);
    if (!claim) return res.status(404).end();
    const cached = claim.source === 'music'
      ? await cachedWebp({
        namespace: 'jellyfin', key: `${claim.id}:Primary:car`, width: 480, quality: 80,
        maxAgeMs: 7 * 86400_000,
        source: () => fetchImage(jf.directImageUrl(claim.id, 'Primary', 480)),
      })
      : await cachedWebp({
        namespace: 'audiobookshelf', key: `${claim.id}:car`, width: 480, quality: 80,
        maxAgeMs: 7 * 86400_000,
        source: () => fetchImage(abs.directCoverUrl(claim.id)),
      });
    const stat = await fsp.stat(cached.file);
    if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_ARTWORK_BYTES) {
      return res.status(502).json({ error: 'artwork_invalid' });
    }
    const maxAge = Math.max(0, claim.expiresAt - Math.floor(Date.now() / 1000));
    res.setHeader('Content-Type', 'image/webp');
    res.setHeader('Content-Length', String(stat.size));
    res.setHeader('Cache-Control', `private, max-age=${maxAge}`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.sendFile(cached.file);
  } catch (error) { next(error); }
});

function encode(ref: NodeRef): string {
  return 'ae_' + Buffer.from(JSON.stringify(ref)).toString('base64url');
}

function decode(value: unknown): NodeRef {
  const raw = String(value || '');
  if (!raw.startsWith('ae_')) throw Object.assign(new Error('invalid_media_id'), { status: 400 });
  try {
    const parsed = JSON.parse(Buffer.from(raw.slice(3), 'base64url').toString('utf8')) as NodeRef;
    if (!['section', 'album', 'song', 'book', 'booktrack'].includes(parsed.kind) || !parsed.id) throw new Error();
    return parsed;
  } catch {
    throw Object.assign(new Error('invalid_media_id'), { status: 400 });
  }
}

function musicAllowed(req: AuthedRequest) {
  return req.user!.features?.music !== false && jf.configured();
}

function booksAllowed(req: AuthedRequest) {
  return req.user!.features?.audiobooks !== false && abs.configured();
}

function musicArt(id: string) { return `/api/media/image/${encodeURIComponent(id)}/Primary?w=480`; }
function bookArt(id: string) { return `/api/books/cover/${encodeURIComponent(id)}?w=480`; }

function songNode(item: MediaItem): CarItem {
  return {
    id: encode({ kind: 'song', id: item.id }),
    title: item.name,
    subtitle: [item.albumArtist, item.album].filter(Boolean).join(' · ') || 'Music',
    artworkUrl: item.posterUrl || (item.albumId ? musicArt(item.albumId) : undefined),
    browsable: false,
    playable: true,
    durationMs: item.runtimeTicks ? Math.round(item.runtimeTicks / 1e4) : undefined,
    progressMs: item.positionTicks ? Math.round(item.positionTicks / 1e4) : undefined,
    mediaType: 'music',
  };
}

function songNodesForUser(req: AuthedRequest, items: MediaItem[]): CarItem[] {
  const rows = progress.mapFor(req.user!.id, items.map(item => item.id));
  return items.map(item => {
    const row = rows.get(item.id);
    return songNode({
      ...item,
      positionTicks: row && !row.played ? row.positionTicks : 0,
      runtimeTicks: item.runtimeTicks || row?.durationTicks || undefined,
    });
  });
}

function albumNode(item: MediaItem): CarItem {
  return {
    id: encode({ kind: 'album', id: item.id }),
    title: item.name,
    subtitle: item.albumArtist || 'Album',
    artworkUrl: item.posterUrl || musicArt(item.id),
    browsable: true,
    playable: true,
    mediaType: 'music',
  };
}

function bookNode(item: Book): CarItem {
  return {
    id: encode({ kind: 'book', id: item.id }),
    title: item.title,
    subtitle: [item.author, item.series].filter(Boolean).join(' · ') || 'Audiobook',
    artworkUrl: bookArt(item.id),
    browsable: false,
    playable: true,
    durationMs: item.durationSec ? Math.round(item.durationSec * 1000) : undefined,
    progressMs: item.currentTimeSec ? Math.round(item.currentTimeSec * 1000) : undefined,
    mediaType: 'audiobook',
  };
}

function bookNodesForUser(req: AuthedRequest, books: Book[]): CarItem[] {
  const rows = progress.mapFor(req.user!.id, books.map(book => book.id));
  return books.map(book => {
    const row = rows.get(book.id);
    return bookNode({
      ...book,
      // Audiobookshelf is configured with a shared backend account. Never put
      // its progress in a member's car catalogue; Aerie's per-user row wins.
      currentTimeSec: row && !row.played ? row.positionTicks / 1e7 : 0,
    });
  });
}

function rootItems(req: AuthedRequest): CarItem[] {
  const items: CarItem[] = [];
  if (musicAllowed(req) || booksAllowed(req)) items.push({
    id: encode({ kind: 'section', id: 'continue' }), title: 'Continue listening',
    subtitle: 'Pick up where you stopped', browsable: true, playable: false,
  });
  if (musicAllowed(req)) items.push({
    id: encode({ kind: 'section', id: 'music' }), title: 'Music',
    subtitle: 'Albums and songs', browsable: true, playable: false, mediaType: 'music',
  });
  if (booksAllowed(req)) items.push({
    id: encode({ kind: 'section', id: 'books' }), title: 'Audiobooks',
    subtitle: 'Your audiobook library', browsable: true, playable: false, mediaType: 'audiobook',
  });
  return items;
}

async function continued(req: AuthedRequest): Promise<CarItem[]> {
  const rows = progress.resume(req.user!.id, 'audio', 20);
  const resolved = await Promise.all(rows.map(async row => {
    if (musicAllowed(req)) {
      try {
        const item = await jf.itemDetail(row.itemId);
        if (item.type === 'Audio') {
          return songNode({ ...item, positionTicks: row.positionTicks });
        }
      } catch { /* it may be an Audiobookshelf id */ }
    }
    if (booksAllowed(req)) {
      try {
        const item = await abs.itemDetail(row.itemId);
        return bookNode({ ...item, currentTimeSec: row.positionTicks / 1e7 });
      } catch { /* stale progress row */ }
    }
    return null;
  }));
  return resolved.filter((item): item is CarItem => !!item);
}

async function defaultItems(req: AuthedRequest): Promise<CarItem[]> {
  const items = await continued(req);
  if (items.length) return items;
  const seen = new Set(items.map(item => item.id));

  // An empty voice query means a general "play music" request. A fresh member
  // has no resume rows yet, so provide deterministic playable fallbacks rather
  // than leaving the steering-wheel Play button at an error screen.
  const sources: Promise<CarItem[]>[] = [];
  if (musicAllowed(req)) sources.push(
    jf.pageByType('Audio', 0, 20, { SortBy: 'DateCreated', SortOrder: 'Descending' })
      .then(page => songNodesForUser(req, page.items)));
  if (booksAllowed(req)) sources.push(
    abs.allBooksPage('book', 0, 20).then(page => bookNodesForUser(req, page.items)));
  const settled = await Promise.allSettled(sources);
  if (settled.length && settled.every(result => result.status === 'rejected')) {
    throw Object.assign(new Error('catalog_unavailable'), { status: 503 });
  }
  for (const result of settled) if (result.status === 'fulfilled') {
    for (const item of result.value) if (!seen.has(item.id)) {
      items.push(item); seen.add(item.id);
    }
  }
  return items.slice(0, 40);
}

async function browse(req: AuthedRequest, parent?: NodeRef): Promise<CarItem[]> {
  if (!parent) return rootItems(req);
  if (parent.kind === 'section' && parent.id === 'continue') return continued(req);
  if (parent.kind === 'section' && parent.id === 'music') {
    if (!musicAllowed(req)) return [];
    return [
      { id: encode({ kind: 'section', id: 'albums' }), title: 'Albums', browsable: true, playable: false, mediaType: 'music' },
      { id: encode({ kind: 'section', id: 'songs' }), title: 'Songs', browsable: true, playable: false, mediaType: 'music' },
    ];
  }
  if (parent.kind === 'section' && parent.id === 'albums') {
    if (!musicAllowed(req)) return [];
    return (await jf.pageByType('MusicAlbum', 0, MAX_BROWSE_ITEMS, { SortBy: 'SortName' })).items.map(albumNode);
  }
  if (parent.kind === 'section' && parent.id === 'songs') {
    if (!musicAllowed(req)) return [];
    const page = await jf.pageByType('Audio', 0, MAX_BROWSE_ITEMS, { SortBy: 'SortName' });
    return songNodesForUser(req, page.items);
  }
  if (parent.kind === 'section' && parent.id === 'books') {
    if (!booksAllowed(req)) return [];
    const page = await abs.allBooksPage('book', 0, MAX_BROWSE_ITEMS);
    return bookNodesForUser(req, page.items);
  }
  if (parent.kind === 'album') {
    if (!musicAllowed(req)) return [];
    return songNodesForUser(req,
      (await jf.children(parent.id)).filter(i => i.type === 'Audio').slice(0, MAX_BROWSE_ITEMS));
  }
  return [];
}

async function resolveQueue(req: AuthedRequest, ref: NodeRef) {
  if ((ref.kind === 'song' || ref.kind === 'album') && !musicAllowed(req)) {
    throw Object.assign(new Error('feature_disabled'), { status: 403 });
  }
  if ((ref.kind === 'book' || ref.kind === 'booktrack') && !booksAllowed(req)) {
    throw Object.assign(new Error('feature_disabled'), { status: 403 });
  }

  if (ref.kind === 'song') {
    const song = await jf.itemDetail(ref.id);
    const saved = progress.get(req.user!.id, song.id);
    const node: CarItem = {
      ...songNode({
        ...song,
        positionTicks: saved && !saved.played ? saved.positionTicks : 0,
        runtimeTicks: song.runtimeTicks || saved?.durationTicks || undefined,
      }), streamUrl: `/api/media/stream/${encodeURIComponent(song.id)}?audio=1`,
      progressId: song.id, progressOffsetMs: 0,
    };
    return { items: [node], startIndex: 0, startPositionMs: node.progressMs || 0 };
  }

  if (ref.kind === 'album') {
    const songs = (await jf.children(ref.id)).filter(i => i.type === 'Audio');
    return {
      items: songs.map(song => ({
        ...songNode(song), streamUrl: `/api/media/stream/${encodeURIComponent(song.id)}?audio=1`,
        progressId: song.id, progressOffsetMs: 0,
      })),
      startIndex: 0,
      startPositionMs: 0,
    };
  }

  if (ref.kind === 'book' || ref.kind === 'booktrack') {
    const bookId = ref.kind === 'booktrack' ? ref.id : ref.id;
    const [book, tracks] = await Promise.all([abs.itemDetail(bookId), abs.getAudioTracks(bookId)]);
    const savedRow = progress.get(req.user!.id, bookId);
    const saved = savedRow && !savedRow.played ? savedRow.positionTicks : 0;
    const savedMs = Math.round(saved / 1e4);
    let offsetMs = 0;
    let startIndex = 0;
    let startPositionMs = savedMs;
    let locatedSavedPosition = false;
    const items: CarItem[] = tracks.map((track, index) => {
      const durationMs = Math.max(0, Math.round((track.durationSec || 0) * 1000));
      if (!locatedSavedPosition && durationMs > 0
        && savedMs >= offsetMs && savedMs < offsetMs + durationMs) {
        startIndex = index;
        startPositionMs = Math.max(0, savedMs - offsetMs);
        locatedSavedPosition = true;
      }
      const item: CarItem = {
        id: encode({ kind: 'booktrack', id: bookId, extra: track.ino }),
        title: tracks.length > 1 ? track.title : book.title,
        subtitle: [book.title, book.author].filter(Boolean).join(' · '),
        artworkUrl: bookArt(bookId),
        browsable: false,
        playable: true,
        durationMs,
        mediaType: 'audiobook',
        streamUrl: `/api/books/file/${encodeURIComponent(bookId)}/${encodeURIComponent(track.ino)}`,
        progressId: bookId,
        progressOffsetMs: offsetMs,
      };
      offsetMs += durationMs;
      return item;
    });
    if (ref.kind === 'booktrack' && ref.extra) {
      const selected = tracks.findIndex(track => track.ino === ref.extra);
      if (selected >= 0) { startIndex = selected; startPositionMs = 0; }
    } else if (!locatedSavedPosition && savedMs > 0 && tracks.length > 1) {
      // Missing/partial duration metadata cannot be mapped safely onto a
      // multi-file queue. Starting at the beginning avoids seeking hours into
      // the wrong chapter; the next valid progress report repairs the timeline.
      startIndex = 0;
      startPositionMs = 0;
    }
    return { items, startIndex, startPositionMs };
  }

  throw Object.assign(new Error('not_playable'), { status: 400 });
}

r.get('/browse', async (req: AuthedRequest, res, next) => {
  try {
    const parent = req.query.parent ? decode(req.query.parent) : undefined;
    res.json({ items: capabilityItems(req, await browse(req, parent)) });
  } catch (e) { next(e); }
});

r.get('/search', async (req: AuthedRequest, res, next) => {
  try {
    const q = String(req.query.q || '').trim().slice(0, 160);
    if (!q) return res.json({ items: capabilityItems(req, await defaultItems(req)) });
    const items: CarItem[] = [];
    let attempted = 0;
    let failed = 0;
    if (musicAllowed(req)) {
      attempted++;
      try {
        const found = await jf.searchAudio(q);
        const songs = found.filter(i => i.type === 'Audio').slice(0, 30);
        const seenSongs = new Set(songs.map(song => song.id));
        // Jellyfin represents an artist as its own search item. Resolve a few
        // matching artists into actual playable songs so “Play Miles Davis” is
        // useful instead of yielding no leaf item.
        const byArtist = await Promise.all(found.filter(i => i.type === 'MusicArtist').slice(0, 3)
          .map(artist => jf.listByType('Audio', {
            ArtistIds: artist.id,
            SortBy: 'Album,ParentIndexNumber,IndexNumber,SortName',
            Limit: 30,
          }).catch(() => [])));
        for (const matches of byArtist) {
          for (const song of matches) if (!seenSongs.has(song.id) && songs.length < 30) {
            songs.push(song); seenSongs.add(song.id);
          }
        }
        // A genre voice extra arrives as the genre text. SearchTerm is not
        // consistently applied to Jellyfin's Genres field, so use its dedicated
        // filter as a fallback when the normal/artist search found no songs.
        if (!songs.length) songs.push(...await jf.listByType('Audio', {
          Genres: q, SortBy: 'Random', Limit: 30,
        }));
        items.push(...songNodesForUser(req, songs));
        items.push(...found.filter(i => i.type === 'MusicAlbum').slice(0, 15).map(albumNode));
      } catch { failed++; }
    }
    if (booksAllowed(req)) {
      attempted++;
      try {
        const needle = q.toLocaleLowerCase();
        const books = (await abs.allBooks('book')).filter(b =>
          b.title.toLocaleLowerCase().includes(needle)
          || (b.author || '').toLocaleLowerCase().includes(needle)
          || (b.narrator || '').toLocaleLowerCase().includes(needle)
          || (b.series || '').toLocaleLowerCase().includes(needle));
        items.push(...bookNodesForUser(req, books.slice(0, 30)));
      } catch { failed++; }
    }
    if (attempted && failed === attempted) {
      throw Object.assign(new Error('catalog_unavailable'), { status: 503 });
    }
    res.json({ items: capabilityItems(req, items.slice(0, 60)) });
  } catch (e) { next(e); }
});

r.get('/resolve', async (req: AuthedRequest, res, next) => {
  try {
    const resolved = await resolveQueue(req, decode(req.query.id));
    res.json({ ...resolved, items: capabilityItems(req, resolved.items) });
  }
  catch (e) { next(e); }
});

r.post('/progress', (req: AuthedRequest, res) => {
  const id = String(req.body?.id || '').trim();
  if (!id || id.length > 512) return res.status(400).json({ error: 'invalid_media_id' });
  const maxMs = 10 * 365 * 24 * 60 * 60 * 1000;
  const rawPosition = Number(req.body?.positionMs);
  const rawDuration = Number(req.body?.durationMs);
  if (!Number.isFinite(rawPosition) || !Number.isFinite(rawDuration)) {
    return res.status(400).json({ error: 'invalid_progress' });
  }
  const durationMs = Math.min(maxMs, Math.max(0, rawDuration));
  const positionMs = Math.min(durationMs || maxMs, Math.max(0, rawPosition));
  progress.report(req.user!.id, id, 'audio', Math.round(positionMs * 1e4), Math.round(durationMs * 1e4));
  res.json({ ok: true });
});

// Kept as a single narrow export so queue/resume behavior can be regression
// tested without standing up Jellyfin, Audiobookshelf, or an Android host.
export const carCatalogTestApi = {
  encode, decode, browse, resolveQueue, defaultItems,
  artworkScope, issueArtworkCapability, verifyArtworkCapability,
  authorizeArtworkCapability, capabilityItems,
  artworkTtlSeconds: ARTWORK_CAPABILITY_TTL_SECONDS,
};

export default r;
