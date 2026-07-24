// Movies / TV / Music / Videos — proxied through Aerie so playback stays in-app.
import { Router } from 'express';
import crypto from 'node:crypto';
import { requireAdmin, type AuthedRequest } from '../lib/auth.js';
import { db, audit } from '../lib/db.js';
import * as jf from '../services/jellyfin.js';
import * as progress from '../services/progress.js';
import {
  progressItem, reconcileMissingItem, reconcileMissingSeries,
} from '../services/jellyfin-progress.js';
import { cachedWebp, fetchImage, imageWidth } from '../services/image-cache.js';
import { jellyfinSource, videoFrame } from '../services/video-thumbnail.js';
import type { MediaItem } from '../lib/model.js';
import {
  copyMediaHeaders, mediaBytes, mediaText, openMediaStream, pipeMediaBody,
} from '../services/media-proxy.js';
import { config } from '../config.js';
import {
  credentialFreeHlsTarget, HlsCapabilityStore, rewriteHlsPlaylist, withJellyfinHlsAuth,
} from '../services/hls-capability.js';
import {
  adaptiveMasterPlaylist, buildPlaybackPlan, chooseVideoSource, parsePlaybackRequest,
  playbackAudioBitrate, playbackAudioChannels, playbackVariants, variantFromRequest,
  type PlaybackRequest, type PlaybackVariant, type VideoMediaSource,
} from '../services/video-playback.js';

const r = Router();
const hlsCapabilities = new HlsCapabilityStore(config.jwtSecret);
const itemTypeCache = new Map<string, { type: string; expires: number }>();
function featureForType(type: string): 'videos' | 'movies' | 'tv' | 'music' {
  if (type === 'Movie') return 'movies';
  if (['Series', 'Season', 'Episode'].includes(type)) return 'tv';
  if (['Audio', 'MusicAlbum', 'MusicArtist'].includes(type)) return 'music';
  return 'videos';
}
async function itemAllowed(req: AuthedRequest, id: string) {
  let cached = itemTypeCache.get(id);
  if (!cached || cached.expires < Date.now()) {
    const item = await jf.itemDetail(id); cached = { type: item.type, expires: Date.now() + 5 * 60_000 }; itemTypeCache.set(id, cached);
  }
  return req.user!.features?.[featureForType(cached.type)] !== false;
}

r.use(async (req: AuthedRequest, res, next) => {
  const p = req.path;
  let key: 'videos' | 'movies' | 'tv' | 'music' | null = null;
  if (p === '/videos' || p.startsWith('/video-thumbnail/')) key = 'videos';
  else if (p === '/movies') key = 'movies';
  else if (p === '/series') key = 'tv';
  else if (p.startsWith('/music/') || p === '/resume/audio') key = 'music';
  if (key && req.user!.features?.[key] === false) return res.status(403).json({ error: 'feature_disabled', feature: key });
  if (p === '/resume/video' && ['videos', 'movies', 'tv'].every(k => req.user!.features?.[k as 'videos'] === false)) {
    return res.status(403).json({ error: 'feature_disabled' });
  }
  try {
    const parts = p.split('/').filter(Boolean);
    const dynamic = ['item', 'playback', 'direct', 'stream', 'offline', 'streams', 'hls', 'image', 'preview', 'similar', 'subtitle'].includes(parts[0]);
    const id = dynamic ? parts[1] : (p === '/progress' || p === '/played') ? String(req.body?.id || '') : '';
    if (id && !await itemAllowed(req, id)) return res.status(403).json({ error: 'feature_disabled' });
    next();
  } catch (e) { next(e); }
});

r.get('/status', (_req, res) => res.json({ configured: jf.configured() }));

function overlayItem(item: MediaItem, row?: { positionTicks: number; durationTicks: number; played: boolean } | null): MediaItem {
  if (!row) return item;
  const runtimeTicks = item.runtimeTicks || row.durationTicks || undefined;
  const progressPct = row.played ? 100
    : row.durationTicks > 0 ? Math.round((row.positionTicks / row.durationTicks) * 100)
      : item.progressPct;
  return {
    ...item,
    runtimeTicks,
    runtimeMinutes: runtimeTicks ? Math.round(runtimeTicks / 600000000) : item.runtimeMinutes,
    positionTicks: row.positionTicks,
    progressPct,
    playedPct: row.played ? 100 : progressPct,
    played: row.played,
  };
}

function overlayItems(userId: number, items: MediaItem[]): MediaItem[] {
  const rows = progress.mapFor(userId, items.map(i => i.id));
  return items.map(i => overlayItem(i, rows.get(i.id)));
}

async function libraryItems(req: AuthedRequest, type: string, params: Record<string, any> = {}): Promise<MediaItem[]> {
  const raw = Array.isArray(req.query.limit) ? req.query.limit[0] : req.query.limit;
  const requested = Number(raw);
  if (Number.isFinite(requested) && requested > 0) {
    return jf.listByType(type, { ...params, Limit: Math.min(500, Math.floor(requested)) });
  }
  return jf.listAllByType(type, params);
}

function pageParams(req: AuthedRequest, defaults: Record<string, any>) {
  const sort = String(req.query.sort || '');
  const sortMap: Record<string, [string, string]> = {
    recent: ['DateCreated', 'Descending'], title: ['SortName', 'Ascending'],
    rating: ['CommunityRating', 'Descending'], year: ['ProductionYear', 'Descending'],
  };
  const pair = sortMap[sort];
  return {
    ...defaults,
    ...(pair ? { SortBy: pair[0], SortOrder: pair[1] } : {}),
    ...(req.query.q ? { SearchTerm: String(req.query.q).slice(0, 120) } : {}),
    ...(req.query.genre && req.query.genre !== 'all' ? { Genres: String(req.query.genre).slice(0, 120) } : {}),
  };
}

async function pagedLibrary(req: AuthedRequest, type: string, defaults: Record<string, any>) {
  const offset = Math.max(0, Math.floor(Number(req.query.offset) || 0));
  const limit = Math.min(100, Math.max(1, Math.floor(Number(req.query.limit) || 50)));
  const page = await jf.pageByType(type, offset, limit, pageParams(req, defaults));
  return { items: overlayItems(req.user!.id, page.items), total: page.total, offset, limit, hasMore: offset + page.items.length < page.total };
}

async function resumeItems(userId: number, media: 'video' | 'audio', limit = 20): Promise<MediaItem[]> {
  const rows = progress.resume(userId, media, limit);
  const items = await Promise.all(rows.map(async row => {
    const item = await progressItem(userId, row.itemId);
    return item
      ? overlayItem(item, { positionTicks: row.positionTicks, durationTicks: row.durationTicks, played: false })
      : null;
  }));
  return items.filter(Boolean) as MediaItem[];
}

// Movies
r.get('/movies', async (req: AuthedRequest, res, next) => {
  try { res.json(req.query.paged ? await pagedLibrary(req, 'Movie', { SortBy: 'DateCreated', SortOrder: 'Descending' }) : overlayItems(req.user!.id, await libraryItems(req, 'Movie', { SortBy: 'DateCreated', SortOrder: 'Descending' }))); }
  catch (e) { if (!jf.configured()) return res.json([]); next(e); }
});

// Series
r.get('/series', async (req: AuthedRequest, res, next) => {
  try { res.json(req.query.paged ? await pagedLibrary(req, 'Series', { SortBy: 'SortName' }) : overlayItems(req.user!.id, await libraryItems(req, 'Series', { SortBy: 'SortName' }))); }
  catch (e) { if (!jf.configured()) return res.json([]); next(e); }
});
r.get('/series/:id/episodes', async (req: AuthedRequest, res, next) => {
  try {
    if (req.user!.features?.tv === false) return res.status(403).json({ error: 'feature_disabled' });
    res.json(overlayItems(req.user!.id, await jf.episodes(String(req.params.id))));
  } catch (e) { next(e); }
});

// Music: artists / albums / songs
r.get('/music/albums', async (req: AuthedRequest, res, next) => {
  try { res.json(req.query.paged ? await pagedLibrary(req, 'MusicAlbum', { SortBy: 'SortName' }) : overlayItems(req.user!.id, await libraryItems(req, 'MusicAlbum', { SortBy: 'SortName' }))); }
  catch (e) { if (!jf.configured()) return res.json([]); next(e); }
});
r.get('/music/artists', async (req: AuthedRequest, res, next) => {
  try { res.json(req.query.paged ? await pagedLibrary(req, 'MusicArtist', { SortBy: 'SortName' }) : overlayItems(req.user!.id, await libraryItems(req, 'MusicArtist', { SortBy: 'SortName' }))); }
  catch (e) { if (!jf.configured()) return res.json([]); next(e); }
});
r.get('/music/songs', async (req: AuthedRequest, res, next) => {
  try { res.json(req.query.paged ? await pagedLibrary(req, 'Audio', { SortBy: 'SortName' }) : overlayItems(req.user!.id, await libraryItems(req, 'Audio', { SortBy: 'SortName' }))); }
  catch (e) { if (!jf.configured()) return res.json([]); next(e); }
});

r.get('/genres/:type', async (req, res, next) => {
  try {
    const types: Record<string, string> = { movies: 'Movie', series: 'Series' };
    const type = types[String(req.params.type)];
    if (!type) return res.status(400).json({ error: 'invalid_media_type' });
    const feature = type === 'Movie' ? 'movies' : 'tv';
    if ((req as AuthedRequest).user!.features?.[feature] === false) return res.status(403).json({ error: 'feature_disabled' });
    res.json({ genres: await jf.genres(type) });
  } catch (e) { next(e); }
});

// Personal videos (Home videos / everything with MediaType Video not Movie/Episode)
r.get('/videos', async (req: AuthedRequest, res, next) => {
  try { res.json(overlayItems(req.user!.id, await libraryItems(req, 'Video', { SortBy: 'DateCreated', SortOrder: 'Descending' }))); }
  catch (e) { if (!jf.configured()) return res.json([]); next(e); }
});

// Continue watching / listening
r.get('/resume/video', async (req: AuthedRequest, res, next) => {
  try { if (!jf.configured()) return res.json([]); res.json((await resumeItems(req.user!.id, 'video', 30)).filter(i => req.user!.features?.[featureForType(i.type)] !== false).slice(0, 20)); } catch (e) { next(e); }
});
r.get('/resume/audio', async (req: AuthedRequest, res, next) => {
  try { if (!jf.configured()) return res.json([]); res.json(await resumeItems(req.user!.id, 'audio', 20)); } catch (e) { next(e); }
});

// Item detail + children (seasons/episodes/tracks)
r.get('/item/:id', async (req: AuthedRequest, res, next) => {
  try {
    const id = String(req.params.id);
    res.json(overlayItem(await jf.itemDetail(id), progress.get(req.user!.id, id)));
  } catch (e) { next(e); }
});
r.get('/item/:id/children', async (req: AuthedRequest, res, next) => {
  try { res.json(overlayItems(req.user!.id, await jf.children(String(req.params.id)))); } catch (e) { next(e); }
});

r.get('/search', async (req: AuthedRequest, res, next) => {
  try { res.json((await jf.search(String(req.query.q || ''))).filter(i => req.user!.features?.[featureForType(i.type)] !== false)); } catch (e) { if (!jf.configured()) return res.json([]); next(e); }
});

// Image proxy
r.get('/image/:id/:type', async (req, res, next) => {
  try {
    const id = String(req.params.id);
    const type = String(req.params.type);
    if (!/^(Primary|Backdrop|Thumb|Logo|Banner|Art)$/i.test(type)) return res.status(400).end();
    const fallback = type.toLowerCase() === 'backdrop' ? 1280 : type.toLowerCase() === 'thumb' ? 640 : 480;
    const width = imageWidth(req.query.w, fallback, type.toLowerCase() === 'backdrop' ? 1920 : 960);
    const tag = String(req.query.tag || '').slice(0, 160);
    const cached = await cachedWebp({
      namespace: 'jellyfin',
      key: `${id}:${type}:${tag || 'untagged'}`,
      width,
      quality: type.toLowerCase() === 'backdrop' ? 76 : 80,
      maxAgeMs: tag ? undefined : 7 * 86400_000,
      source: () => fetchImage(jf.directImageUrl(id, type, width)),
    });
    res.setHeader('Content-Type', 'image/webp');
    res.setHeader('Cache-Control', tag ? 'private, max-age=604800, immutable' : 'private, max-age=86400');
    res.setHeader('X-Aerie-Image-Cache', cached.hit ? 'HIT' : 'MISS');
    res.sendFile(cached.file);
  } catch (e) { next(e); }
});

// Artwork fallback for home/personal videos that Jellyfin has not generated a
// Primary/Thumb image for. The extracted frame is persisted as a responsive
// WebP by the same cache used for normal artwork.
r.get('/video-thumbnail/:id', async (req, res) => {
  try {
    const id = String(req.params.id);
    const width = imageWidth(req.query.w, 480, 960);
    const src = await jellyfinSource(id);
    const cached = await cachedWebp({
      namespace: 'jellyfin-videos', key: id, source: () => videoFrame(src.source),
      sourceMtimeMs: src.mtimeMs, maxAgeMs: src.mtimeMs ? undefined : 7 * 86400_000,
      width, height: Math.round(width * 9 / 16), fit: 'cover', quality: 76,
    });
    res.setHeader('Content-Type', 'image/webp');
    res.setHeader('Cache-Control', 'private, max-age=86400');
    res.setHeader('X-Aerie-Image-Cache', cached.hit ? 'HIT' : 'MISS');
    res.sendFile(cached.file);
  } catch { res.status(204).end(); }
});

// Responsive timeline frames, quantized to 10-second buckets so repeated hover
// requests from every user share a small persistent WebP cache.
r.get('/preview/:id', async (req, res) => {
  try {
    const id = String(req.params.id);
    const at = Math.max(0, Math.min(12 * 3600, Math.round((Number(req.query.t) || 0) / 10) * 10));
    const width = imageWidth(req.query.w, 240, 480);
    const src = await jellyfinSource(id);
    const cached = await cachedWebp({
      namespace: 'jellyfin-previews', key: `${id}:${at}`, source: () => videoFrame(src.source, at),
      sourceMtimeMs: src.mtimeMs, maxAgeMs: src.mtimeMs ? undefined : 7 * 86400_000,
      width, height: Math.round(width * 9 / 16), fit: 'cover', quality: 72,
    });
    res.setHeader('Content-Type', 'image/webp'); res.setHeader('Cache-Control', 'private, max-age=604800, immutable');
    res.setHeader('X-Aerie-Image-Cache', cached.hit ? 'HIT' : 'MISS'); res.sendFile(cached.file);
  } catch { res.status(204).end(); }
});

r.get('/item/:id/chapters', async (req: AuthedRequest, res, next) => {
  try {
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.json({ chapters: await jf.chapters(String(req.params.id)) });
  } catch (e) { next(e); }
});

r.get('/item/:id/segments', async (req: AuthedRequest, res, next) => {
  try {
    const id = String(req.params.id);
    const saved = db.prepare('SELECT kind,start_sec startSec,end_sec endSec,source FROM skip_segments WHERE item_id=? ORDER BY start_sec').all(id) as any[];
    if (saved.length) return res.json({ segments: saved });
    const item = await jf.itemDetail(id);
    const ch = await jf.chapters(id);
    const duration = (item.runtimeTicks || 0) / 1e7;
    const auto: any[] = [];
    ch.forEach((c, i) => {
      const n = c.name.toLowerCase();
      const kind = /intro|opening|op\b/.test(n) ? 'intro' : /credit|ending|outro|end\b/.test(n) ? 'credits' : '';
      if (kind) auto.push({ kind, startSec: c.startSec, endSec: ch[i + 1]?.startSec || duration, source: 'chapter' });
    });
    res.json({ segments: auto.filter(s => s.endSec > s.startSec) });
  } catch (e) { next(e); }
});

r.put('/item/:id/segments', requireAdmin, (req: AuthedRequest, res) => {
  const id = String(req.params.id);
  const segments = Array.isArray(req.body?.segments) ? req.body.segments : [];
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM skip_segments WHERE item_id=?').run(id);
    const add = db.prepare(`INSERT INTO skip_segments (item_id,kind,start_sec,end_sec,source,updated_by)
      VALUES (?,?,?,?,?,?)`);
    for (const s of segments.slice(0, 4)) {
      const kind = String(s.kind); const start = Number(s.startSec); const end = Number(s.endSec);
      if (!['intro', 'credits'].includes(kind) || !Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) continue;
      add.run(id, kind, start, end, 'manual', req.user!.id);
    }
  });
  tx(); audit(req.user!.id, req.user!.username, 'skip_segments_updated', id); res.json({ ok: true });
});

r.get('/library-scan', requireAdmin, async (_req, res, next) => { try { res.json(await jf.libraryScanStatus()); } catch (e) { next(e); } });
r.post('/library-scan', requireAdmin, async (req: AuthedRequest, res, next) => {
  try { await jf.startLibraryScan(); audit(req.user!.id, req.user!.username, 'media_library_scan_started'); res.json({ ok: true }); } catch (e) { next(e); }
});
r.get('/item/:id/metadata', requireAdmin, async (req, res, next) => { try { res.json(await jf.metadata(String(req.params.id))); } catch (e) { next(e); } });
r.patch('/item/:id/metadata', requireAdmin, async (req: AuthedRequest, res, next) => {
  try {
    const b = req.body || {}; const changes: Record<string, any> = {};
    if (b.name !== undefined) changes.Name = String(b.name).slice(0, 300);
    if (b.sortName !== undefined) changes.SortName = String(b.sortName).slice(0, 300);
    if (b.overview !== undefined) changes.Overview = String(b.overview).slice(0, 20_000);
    if (b.year !== undefined) changes.ProductionYear = b.year ? Math.max(1800, Math.min(2200, Number(b.year))) : null;
    if (b.genres !== undefined) changes.Genres = (Array.isArray(b.genres) ? b.genres : String(b.genres).split(',')).map((x: any) => String(x).trim()).filter(Boolean).slice(0, 30);
    if (b.communityRating !== undefined) changes.CommunityRating = b.communityRating === '' ? null : Math.max(0, Math.min(10, Number(b.communityRating)));
    if (b.officialRating !== undefined) changes.OfficialRating = String(b.officialRating).slice(0, 30);
    await jf.updateMetadata(String(req.params.id), changes); audit(req.user!.id, req.user!.username, 'media_metadata_updated', String(req.params.id)); res.json({ ok: true });
  } catch (e) { next(e); }
});
r.post('/item/:id/refresh', requireAdmin, async (req: AuthedRequest, res, next) => {
  try { await jf.refreshItem(String(req.params.id)); audit(req.user!.id, req.user!.username, 'media_metadata_refreshed', String(req.params.id)); res.json({ ok: true }); } catch (e) { next(e); }
});

const BUILTIN_COLLECTIONS: Record<string, { name: string; rule: any }> = {
  'recently-added': { name: 'Recently added', rule: { types: 'Movie,Series', sort: 'DateCreated', order: 'Descending' } },
  'top-rated': { name: 'Top rated', rule: { types: 'Movie,Series', sort: 'CommunityRating', order: 'Descending', minRating: 7 } },
  'unwatched-movies': { name: 'Unwatched movies', rule: { types: 'Movie', sort: 'DateCreated', order: 'Descending', unwatched: true } },
  'recent-music': { name: 'Recently added music', rule: { types: 'MusicAlbum', sort: 'DateCreated', order: 'Descending' } },
};
r.get('/collections', (req: AuthedRequest, res) => {
  const saved = (db.prepare('SELECT id,name,rule,created_at createdAt,updated_at updatedAt FROM smart_collections WHERE user_id=? ORDER BY updated_at DESC').all(req.user!.id) as any[])
    .map(x => ({ ...x, rule: JSON.parse(x.rule || '{}'), builtin: false }));
  res.json({ items: [...Object.entries(BUILTIN_COLLECTIONS).map(([id, c]) => ({ id, ...c, builtin: true })), ...saved] });
});
r.post('/collections', (req: AuthedRequest, res) => {
  const id = crypto.randomUUID(); const name = String(req.body?.name || 'New collection').trim().slice(0, 120);
  const rule = req.body?.rule && typeof req.body.rule === 'object' ? req.body.rule : {};
  db.prepare('INSERT INTO smart_collections (id,user_id,name,rule) VALUES (?,?,?,?)').run(id, req.user!.id, name, JSON.stringify(rule));
  res.json({ id, name, rule, builtin: false });
});
r.patch('/collections/:id', (req: AuthedRequest, res) => {
  const old = db.prepare('SELECT * FROM smart_collections WHERE id=? AND user_id=?').get(String(req.params.id), req.user!.id) as any;
  if (!old) return res.status(404).json({ error: 'not_found' });
  const name = req.body?.name !== undefined ? String(req.body.name).trim().slice(0, 120) : old.name;
  const rule = req.body?.rule && typeof req.body.rule === 'object' ? req.body.rule : JSON.parse(old.rule || '{}');
  db.prepare("UPDATE smart_collections SET name=?,rule=?,updated_at=datetime('now') WHERE id=?").run(name, JSON.stringify(rule), old.id);
  res.json({ id: old.id, name, rule, builtin: false });
});
r.delete('/collections/:id', (req: AuthedRequest, res) => {
  db.prepare('DELETE FROM smart_collections WHERE id=? AND user_id=?').run(String(req.params.id), req.user!.id); res.json({ ok: true });
});
r.get('/collections/:id/items', async (req: AuthedRequest, res, next) => {
  try {
    const id = String(req.params.id); let rule = BUILTIN_COLLECTIONS[id]?.rule;
    if (!rule) { const row = db.prepare('SELECT rule FROM smart_collections WHERE id=? AND user_id=?').get(id, req.user!.id) as any; if (!row) return res.status(404).json({ error: 'not_found' }); rule = JSON.parse(row.rule || '{}'); }
    const types = ['Movie', 'Series', 'MusicAlbum', 'Audio'].includes(rule.types) || /^((Movie|Series|MusicAlbum|Audio),?)+$/.test(rule.types || '') ? rule.types : 'Movie,Series';
    const params: Record<string, any> = { SortBy: rule.sort || 'SortName', SortOrder: rule.order || 'Ascending' };
    if (rule.genre) params.Genres = String(rule.genre).slice(0, 100); if (rule.minRating) params.MinCommunityRating = Number(rule.minRating);
    if (rule.year) params.Years = Number(rule.year);
    const page = await jf.pageByType(types, 0, 50, params);
    let items = overlayItems(req.user!.id, page.items);
    if (rule.unwatched) items = items.filter(i => !i.played && (i.progressPct || 0) < 95);
    items = items.filter(i => req.user!.features?.[featureForType(i.type)] !== false);
    res.json({ items, total: items.length });
  } catch (e) { next(e); }
});

async function pipeStream(req: AuthedRequest, res: any, target: string) {
  const range = req.headers.range;
  const opened = await openMediaStream(target, jf.jellyfinBase(), range ? { Range: range } : {});
  if (opened.response.status < 200 || opened.response.status >= 300) {
    opened.controller.abort();
    if (opened.response.status === 404) progress.remove(req.user!.id, String(req.params.id || ''));
    return res.status(opened.response.status === 404 ? 404 : 503).json({ error: 'stream_unavailable' });
  }
  copyMediaHeaders(opened.response, res);
  await pipeMediaBody(req, res, opened);
}

function playbackRequest(req: AuthedRequest): PlaybackRequest {
  return parsePlaybackRequest(req.query as Record<string, unknown>);
}

async function playbackSource(id: string, request: PlaybackRequest, evaluateProfile = false): Promise<VideoMediaSource> {
  const sources = await jf.videoPlaybackSources(id, evaluateProfile ? request : undefined);
  return chooseVideoSource(sources, request);
}

function jellyfinHlsMaster(id: string, source: VideoMediaSource, request: PlaybackRequest,
  variant: PlaybackVariant): URL {
  const target = new URL(`${jf.jellyfinBase()}/Videos/${encodeURIComponent(id)}/master.m3u8`);
  target.searchParams.set('api_key', jf.jellyfinKey());
  target.searchParams.set('MediaSourceId', source.id);
  target.searchParams.set('VideoCodec', 'h264');
  target.searchParams.set('AudioCodec', 'aac');
  target.searchParams.set('TranscodingMaxAudioChannels', String(request.capabilities.maxAudioChannels));
  target.searchParams.set('MaxAudioChannels', String(request.capabilities.maxAudioChannels));
  target.searchParams.set('SegmentContainer', 'ts');
  target.searchParams.set('MinSegments', '1');
  target.searchParams.set('MaxStreamingBitrate', String(variant.bitrate));
  target.searchParams.set('VideoBitrate', String(variant.videoBitrate));
  target.searchParams.set('AudioBitrate', String(playbackAudioBitrate(source, request)));
  target.searchParams.set('MaxHeight', String(variant.height || source.video.height || 1080));
  if (variant.width) target.searchParams.set('MaxWidth', String(variant.width));
  target.searchParams.set('EnableAutoStreamCopy', 'True');
  target.searchParams.set('AllowVideoStreamCopy', 'True');
  target.searchParams.set('AllowAudioStreamCopy', 'True');
  // A distinct session is required for audio-track and quality changes; Jellyfin
  // otherwise may attach to an older transcode with different parameters.
  target.searchParams.set('PlaySessionId', crypto.randomBytes(8).toString('hex'));
  if (!request.nativeHls) target.searchParams.set('BreakOnNonKeyFrames', 'True');
  if (request.audioStreamIndex !== null) target.searchParams.set('AudioStreamIndex', String(request.audioStreamIndex));
  return target;
}

function firstPlaylistTarget(text: string, masterUrl: URL): URL | null {
  for (const line of text.split(/\r?\n/)) {
    const value = line.trim();
    if (value && !value.startsWith('#')) return new URL(value, masterUrl);
  }
  return null;
}

async function sendJellyfinHls(req: AuthedRequest, res: any, id: string, source: VideoMediaSource,
  request: PlaybackRequest, variant: PlaybackVariant, mediaPlaylist: boolean) {
  const base = jf.jellyfinBase();
  const masterUrl = jellyfinHlsMaster(id, source, request, variant);
  const upstream = await mediaText(masterUrl, base, { timeoutMs: 15_000, maxBytes: 2 * 1024 * 1024, requireOk: false });
  if (upstream.status < 200 || upstream.status >= 300) {
    if (upstream.status === 404) progress.remove(req.user!.id, id);
    return res.status(upstream.status === 404 ? 404 : 503).json({ error: 'stream_unavailable' });
  }

  let text = upstream.body;
  let playlistBase: string | URL = masterUrl;
  if (mediaPlaylist && !/^#EXTINF:/m.test(text)) {
    const child = firstPlaylistTarget(text, masterUrl);
    if (!child) return res.status(503).json({ error: 'stream_unavailable' });
    // The generated URI must remain within this item/source before credentials
    // are added back for the one upstream fetch.
    const clean = credentialFreeHlsTarget(child, base, id, source.id);
    const authenticated = withJellyfinHlsAuth(clean, jf.jellyfinKey());
    const media = await mediaText(authenticated, base, { timeoutMs: 15_000, maxBytes: 2 * 1024 * 1024, requireOk: false });
    if (media.status < 200 || media.status >= 300) {
      if (media.status === 404) progress.remove(req.user!.id, id);
      return res.status(media.status === 404 ? 404 : 503).json({ error: 'stream_unavailable' });
    }
    text = media.body;
    playlistBase = clean;
  }

  res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('X-Aerie-Play-Method', variant.delivery === 'remux' ? 'Remux' : 'Transcode');
  res.setHeader('X-Aerie-Resolution', variant.height ? `${variant.height}p` : 'source');
  res.setHeader('X-Aerie-Bitrate', String(variant.bitrate));
  const outputChannels = playbackAudioChannels(source, request);
  if (outputChannels) res.setHeader('X-Aerie-Audio-Channels', String(outputChannels));
  return res.send(rewriteHlsPlaylist(text, String(playlistBase), base, id, req.user!.id, hlsCapabilities, source.id));
}

// Capability-aware preflight. The response contains only Aerie URLs and safe
// normalized source metadata; Jellyfin paths, origins and API keys stay private.
r.get('/playback/:id', async (req: AuthedRequest, res, next) => {
  try {
    const id = String(req.params.id);
    const request = playbackRequest(req);
    const sources = await jf.videoPlaybackSources(id, request);
    res.setHeader('Cache-Control', 'no-store');
    res.json(buildPlaybackPlan(id, sources, request));
  } catch (e) { next(e); }
});

// Progressive source used only after the preflight has selected Direct Play.
// The source id is revalidated against this exact Jellyfin item before proxying.
r.get('/direct/:id', async (req: AuthedRequest, res, next) => {
  try {
    const id = String(req.params.id);
    const request = parsePlaybackRequest({ source: req.query.source, quality: 'original' });
    const source = await playbackSource(id, request);
    if (!source.supportsDirectPlay) return res.status(409).json({ error: 'direct_play_unavailable' });
    res.setHeader('X-Aerie-Play-Method', 'Direct Play');
    if (source.video.height) res.setHeader('X-Aerie-Resolution', `${source.video.height}p`);
    if (source.bitrate) res.setHeader('X-Aerie-Bitrate', String(source.bitrate));
    const directAudio = source.audio.find(stream => stream.index === source.defaultAudioStreamIndex)
      || source.audio.find(stream => stream.default) || source.audio[0];
    if (directAudio?.channels) res.setHeader('X-Aerie-Audio-Channels', String(directAudio.channels));
    return pipeStream(req, res, jf.directVideoStreamUrl(id, source.id));
  } catch (e) { next(e); }
});

// Stream entrypoint: video -> adaptive/limited rewritten HLS; audio -> progressive stream.
r.get('/stream/:id', async (req: AuthedRequest, res, next) => {
  try {
    const id = String(req.params.id);
    const base = jf.jellyfinBase(), key = jf.jellyfinKey();
    if (req.query.audio === '1') {
      const uid = await jf.jellyUserId();
      const target = `${base}/Audio/${id}/universal?api_key=${key}&UserId=${uid}&DeviceId=cloudbox-web`
        + `&Container=mp3,aac,m4a,flac,ogg,opus,wav&TranscodingContainer=aac&TranscodingProtocol=http`
        + `&AudioCodec=aac&MaxStreamingBitrate=320000`;
      return pipeStream(req, res, target);
    }
    const request = playbackRequest(req);
    const source = await playbackSource(id, request);
    const variants = playbackVariants(source, request);
    const rawVariant = Array.isArray(req.query.variant) ? req.query.variant : req.query.variant;
    if (request.quality === 'auto' && rawVariant === undefined && variants.length > 1) {
      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('X-Aerie-Play-Method', 'Adaptive');
      return res.send(adaptiveMasterPlaylist(id, source, request, variants));
    }
    const variant = rawVariant === undefined ? variants[variants.length - 1]
      : variantFromRequest(source, request, rawVariant);
    return sendJellyfinHls(req, res, id, source, request, variant, rawVariant !== undefined);
  } catch (e) { next(e); }
});

// Progressive original stream for explicit offline saving. Unlike HLS this is
// one cacheable file and keeps Range support for the offline video element.
r.get('/offline/:id', async (req: AuthedRequest, res, next) => {
  try { return pipeStream(req, res, jf.directVideoStreamUrl(String(req.params.id))); } catch (e) { next(e); }
});

// Proxy for sub-playlists (rewritten again) and .ts segments (streamed).
r.get('/hls/:id', async (req: AuthedRequest, res, next) => {
  try {
    const id = String(req.params.id);
    const token = String(req.query.p || '');
    if (token.length > 256) return res.status(403).end();
    let target: URL;
    try { target = hlsCapabilities.resolve(token, req.user!.id, id); }
    catch { return res.status(403).end(); }
    const base = jf.jellyfinBase();
    const abs = withJellyfinHlsAuth(target, jf.jellyfinKey());
    const mediaSourceId = target.searchParams.get('MediaSourceId') || id;
    const isPlaylist = target.pathname.endsWith('.m3u8');
    if (isPlaylist) {
      const upstream = await mediaText(abs, base, { timeoutMs: 15_000, maxBytes: 2 * 1024 * 1024, requireOk: false });
      if (upstream.status < 200 || upstream.status >= 300) {
        if (upstream.status === 404) progress.remove(req.user!.id, id);
        return res.status(upstream.status === 404 ? 404 : 503).end();
      }
      const text = upstream.body;
      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      res.setHeader('Cache-Control', 'no-cache');
      return res.send(rewriteHlsPlaylist(text, target.toString(), base, id, req.user!.id, hlsCapabilities, mediaSourceId));
    }
    return pipeStream(req, res, abs.toString());
  } catch (e) { next(e); }
});

// Audio + subtitle tracks for the player's pickers.
r.get('/streams/:id', async (req, res, next) => {
  try {
    const sourceId = parsePlaybackRequest({ source: req.query.source }).sourceId || undefined;
    res.json(await jf.mediaStreams(String(req.params.id), sourceId));
  } catch (e) { next(e); }
});

// Subtitle proxy (VTT).
r.get('/subtitle/:id/:src/:index', async (req: AuthedRequest, res, next) => {
  try {
    const url = jf.directSubtitleUrl(String(req.params.id), String(req.params.src), Number(req.params.index));
    const up = await mediaBytes(url, jf.jellyfinBase(), { timeoutMs: 20_000, maxBytes: 16 * 1024 * 1024, requireOk: false });
    if (up.status < 200 || up.status >= 300) {
      if (up.status === 404) progress.remove(req.user!.id, String(req.params.id));
      return res.status(up.status === 404 ? 404 : 503).end();
    }
    res.setHeader('Content-Type', 'text/vtt');
    res.end(up.body);
  } catch (e) { next(e); }
});

r.post('/progress', async (req, res) => {
  const { id, positionTicks, durationTicks, seriesId } = req.body || {};
  progress.report((req as AuthedRequest).user!.id, id, 'video', positionTicks || 0, durationTicks || 0, seriesId);
  res.json({ ok: true });
});

r.post('/played', async (req, res) => {
  const { id, played, durationTicks } = req.body || {};
  progress.setPlayed((req as AuthedRequest).user!.id, id, 'video', played !== false, durationTicks || 0);
  res.json({ ok: true });
});

// Recommendations: Next Up, suggestions, recently added.
r.get('/recommendations', async (req: AuthedRequest, res, next) => {
  try {
    const userId = req.user!.id;
    const nextUp: MediaItem[] = [];
    const seen = new Set<string>();
    for (const s of progress.seriesProgress(userId).slice(0, 15)) {
      if (nextUp.length >= 20) break;
      try {
        const episodes = overlayItems(userId, await jf.episodes(s.seriesId));
        const touched = episodes.map((ep, idx) => ({ ep, idx })).filter(x => progress.get(userId, x.ep.id));
        const start = touched.length ? Math.max(...touched.map(x => x.idx)) : 0;
        const pick = episodes.slice(start).find(ep => {
          const pos = ep.positionTicks || 0;
          const dur = ep.runtimeTicks || 0;
          const inProgress = pos > 5 * 1e7 && (!dur || pos < dur * 0.95);
          return ep.playedPct !== 100 && !inProgress;
        });
        if (pick && !seen.has(pick.id)) { seen.add(pick.id); nextUp.push(pick); }
      } catch (error) {
        reconcileMissingSeries(error, userId, s.seriesId);
      }
    }
    const catalog = await jf.recommendationCatalog();
    // Build a private taste profile from this Aerie user's own recent playback.
    // Jellyfin is shared by the household, so its Suggestions endpoint alone is
    // not personal enough.
    const recent = db.prepare(`SELECT item_id FROM playback_progress WHERE user_id=? AND media='video'
      ORDER BY updated_at DESC LIMIT 30`).all(userId) as { item_id: string }[];
    const touched = new Set(recent.map(x => x.item_id));
    const genreCounts = new Map<string, number>();
    for (const row of recent.slice(0, 12)) {
      const item = await progressItem(userId, row.item_id);
      for (const genre of item?.genres || []) genreCounts.set(genre, (genreCounts.get(genre) || 0) + 1);
    }
    const topGenres = [...genreCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(x => x[0]);
    let personal: MediaItem[] = [];
    for (const genre of topGenres) {
      try {
        const page = await jf.pageByType('Movie,Series', 0, 24, { Genres: genre, SortBy: 'CommunityRating', SortOrder: 'Descending' });
        for (const item of page.items) if (!touched.has(item.id) && !personal.some(x => x.id === item.id)) personal.push(item);
      } catch { /* one genre should not fail all recommendations */ }
    }
    personal = personal.slice(0, 24);
    const combined = [...personal, ...catalog.suggestions].filter((x, i, all) => all.findIndex(y => y.id === x.id) === i).slice(0, 24);
    const allowed = (i: MediaItem) => req.user!.features?.[featureForType(i.type)] !== false;
    res.json({ nextUp: nextUp.filter(allowed), personalized: personal.filter(allowed), becauseGenres: topGenres,
      suggestions: combined.filter(allowed), recentlyAdded: catalog.recentlyAdded.filter(allowed) });
  }
  catch (e) { if (!jf.configured()) return res.json({ nextUp: [], suggestions: [], recentlyAdded: [] }); next(e); }
});

// "More like this".
r.get('/similar/:id', async (req, res, next) => {
  try { res.json(await jf.similar(req.params.id)); } catch (e) { next(e); }
});

// A cached type lookup can outlive an item by a few minutes. Reconcile the
// exact row here as a final guard before the safe 404 reaches the app handler.
r.use((error: unknown, req: AuthedRequest, _res: any, next: (error: unknown) => void) => {
  const parts = req.path.split('/').filter(Boolean);
  const dynamic = ['item', 'playback', 'direct', 'stream', 'offline', 'streams', 'hls', 'image', 'preview', 'similar', 'subtitle']
    .includes(parts[0]);
  const id = dynamic ? parts[1]
    : (req.path === '/progress' || req.path === '/played') ? String(req.body?.id || '') : '';
  if (id) reconcileMissingItem(error, req.user!.id, id);
  next(error);
});

export default r;
