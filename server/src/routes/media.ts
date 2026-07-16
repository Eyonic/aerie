// Movies / TV / Music / Videos — proxied through Aerie so playback stays in-app.
import { Router } from 'express';
import crypto from 'node:crypto';
import { type AuthedRequest } from '../lib/auth.js';
import * as jf from '../services/jellyfin.js';
import * as progress from '../services/progress.js';
import { cachedWebp, fetchImage, imageWidth } from '../services/image-cache.js';
import type { MediaItem } from '../lib/model.js';

const r = Router();

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

async function resumeItems(userId: number, media: 'video' | 'audio', limit = 20): Promise<MediaItem[]> {
  const rows = progress.resume(userId, media, limit);
  const items = await Promise.all(rows.map(async row => {
    try {
      const item = await jf.itemDetail(row.itemId);
      return overlayItem(item, { positionTicks: row.positionTicks, durationTicks: row.durationTicks, played: false });
    } catch { return null; }
  }));
  return items.filter(Boolean) as MediaItem[];
}

// Movies
r.get('/movies', async (req: AuthedRequest, res, next) => {
  try { res.json(overlayItems(req.user!.id, await jf.listByType('Movie', { SortBy: 'DateCreated', SortOrder: 'Descending' }))); }
  catch (e) { if (!jf.configured()) return res.json([]); next(e); }
});

// Series
r.get('/series', async (req: AuthedRequest, res, next) => {
  try { res.json(overlayItems(req.user!.id, await jf.listByType('Series', { SortBy: 'SortName' }))); }
  catch (e) { if (!jf.configured()) return res.json([]); next(e); }
});

// Music: artists / albums / songs
r.get('/music/albums', async (req: AuthedRequest, res, next) => {
  try { res.json(overlayItems(req.user!.id, await jf.listByType('MusicAlbum', { SortBy: 'SortName' }))); }
  catch (e) { if (!jf.configured()) return res.json([]); next(e); }
});
r.get('/music/artists', async (req: AuthedRequest, res, next) => {
  try { res.json(overlayItems(req.user!.id, await jf.listByType('MusicArtist', { SortBy: 'SortName' }))); }
  catch (e) { if (!jf.configured()) return res.json([]); next(e); }
});
r.get('/music/songs', async (req: AuthedRequest, res, next) => {
  try { res.json(overlayItems(req.user!.id, await jf.listByType('Audio', { SortBy: 'SortName', Limit: 500 }))); }
  catch (e) { if (!jf.configured()) return res.json([]); next(e); }
});

// Personal videos (Home videos / everything with MediaType Video not Movie/Episode)
r.get('/videos', async (req: AuthedRequest, res, next) => {
  try { res.json(overlayItems(req.user!.id, await jf.listByType('Video', { SortBy: 'DateCreated', SortOrder: 'Descending' }))); }
  catch (e) { if (!jf.configured()) return res.json([]); next(e); }
});

// Continue watching / listening
r.get('/resume/video', async (req: AuthedRequest, res, next) => {
  try { if (!jf.configured()) return res.json([]); res.json(await resumeItems(req.user!.id, 'video', 20)); } catch (e) { next(e); }
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

r.get('/search', async (req, res, next) => {
  try { res.json(await jf.search(String(req.query.q || ''))); } catch (e) { if (!jf.configured()) return res.json([]); next(e); }
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

// Rewrite every URL in an HLS playlist so sub-playlists + segments route back
// through our proxy (browser never talks to Jellyfin directly).
function proxifyPlaylist(text: string, baseAbsUrl: string, id: string): string {
  const enc = (abs: string) => `/api/media/hls/${id}?p=${encodeURIComponent(Buffer.from(abs).toString('base64url'))}`;
  return text.split('\n').map(line => {
    const t = line.trim();
    if (!t) return line;
    if (t.startsWith('#')) {
      if (t.includes('URI="')) return line.replace(/URI="([^"]+)"/g, (_m, u) => `URI="${enc(new URL(u, baseAbsUrl).toString())}"`);
      return line;
    }
    try { return enc(new URL(t, baseAbsUrl).toString()); } catch { return line; }
  }).join('\n');
}

async function pipeStream(req: AuthedRequest, res: any, target: string) {
  const range = req.headers.range;
  const upstream = await fetch(target, { headers: range ? { Range: range } : {} });
  res.status(upstream.status);
  upstream.headers.forEach((v: string, k: string) => {
    if (['content-type', 'content-length', 'content-range', 'accept-ranges', 'cache-control'].includes(k)) res.setHeader(k, v);
  });
  if (!upstream.body) return res.end();
  const reader = upstream.body.getReader();
  const pump = async () => {
    while (true) { const { done, value } = await reader.read(); if (done) break; res.write(Buffer.from(value)); }
    res.end();
  };
  pump().catch(() => res.end());
}

// Stream entrypoint: video -> rewritten HLS master; audio -> progressive stream.
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
    // Without an explicit bitrate ceiling Jellyfin falls back to a ~256kbps
    // transcode (everything looked soft/blocky). Mirror jellyfin-web's "Auto":
    // a huge ceiling makes compatible h264 files DIRECT-STREAM (video copy,
    // original quality, no CPU) and gives real transcodes a sane budget.
    // Strict digits-only parse: Number('') is 0, so a bare/empty audioStream=
    // would otherwise leak AudioStreamIndex=0 (the video stream) to Jellyfin.
    const rawAudio = Array.isArray(req.query.audioStream) ? '' : String(req.query.audioStream ?? '');
    const audioStream = /^\d+$/.test(rawAudio) ? Number(rawAudio) : null;
    // BreakOnNonKeyFrames suits hls.js only; Safari's native HLS player wants
    // keyframe-aligned segments (the client says which engine it uses).
    const nativeHls = String(req.query.native) === '1';
    // Fresh PlaySessionId per master request (like jellyfin-web): without it
    // Jellyfin matches the request to an existing transcode session and keeps
    // serving its OLD audio — an AudioStreamIndex change was silently ignored
    // (verified: byte-identical segments for different tracks).
    const playSessionId = crypto.randomBytes(8).toString('hex');
    const masterUrl = `${base}/Videos/${id}/master.m3u8?api_key=${key}&MediaSourceId=${id}`
      + `&VideoCodec=h264&AudioCodec=aac,mp3&TranscodingMaxAudioChannels=2&SegmentContainer=ts&MinSegments=1`
      + `&MaxStreamingBitrate=120000000&VideoBitrate=119808000&AudioBitrate=192000`
      + `&PlaySessionId=${playSessionId}`
      + (nativeHls ? '' : `&BreakOnNonKeyFrames=True`)
      + (audioStream != null ? `&AudioStreamIndex=${audioStream}` : '');
    const upstream = await fetch(masterUrl);
    if (!upstream.ok) return res.status(upstream.status).json({ error: 'stream_unavailable' });
    const text = await upstream.text();
    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    res.setHeader('Cache-Control', 'no-cache');
    res.send(proxifyPlaylist(text, masterUrl, id));
  } catch (e) { next(e); }
});

// Proxy for sub-playlists (rewritten again) and .ts segments (streamed).
r.get('/hls/:id', async (req: AuthedRequest, res, next) => {
  try {
    const abs = Buffer.from(String(req.query.p || ''), 'base64url').toString('utf8');
    if (!abs.startsWith(jf.jellyfinBase())) return res.status(400).end();
    const isPlaylist = abs.includes('.m3u8');
    if (isPlaylist) {
      const upstream = await fetch(abs);
      if (!upstream.ok) return res.status(upstream.status).end();
      const text = await upstream.text();
      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      res.setHeader('Cache-Control', 'no-cache');
      return res.send(proxifyPlaylist(text, abs, String(req.params.id)));
    }
    return pipeStream(req, res, abs);
  } catch (e) { next(e); }
});

// Audio + subtitle tracks for the player's pickers.
r.get('/streams/:id', async (req, res, next) => {
  try { res.json(await jf.mediaStreams(String(req.params.id))); } catch (e) { next(e); }
});

// Subtitle proxy (VTT).
r.get('/subtitle/:id/:src/:index', async (req, res, next) => {
  try {
    const url = jf.directSubtitleUrl(String(req.params.id), String(req.params.src), Number(req.params.index));
    const up = await fetch(url);
    if (!up.ok) return res.status(up.status).end();
    res.setHeader('Content-Type', 'text/vtt');
    res.end(Buffer.from(await up.arrayBuffer()));
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
      } catch { /* skip this series */ }
    }
    const catalog = await jf.recommendationCatalog();
    res.json({ nextUp, suggestions: catalog.suggestions, recentlyAdded: catalog.recentlyAdded });
  }
  catch (e) { if (!jf.configured()) return res.json({ nextUp: [], suggestions: [], recentlyAdded: [] }); next(e); }
});

// "More like this".
r.get('/similar/:id', async (req, res, next) => {
  try { res.json(await jf.similar(req.params.id)); } catch (e) { next(e); }
});

export default r;
