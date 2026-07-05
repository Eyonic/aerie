// Movies / TV / Music / Videos — proxied through Aerie so playback stays in-app.
import { Router } from 'express';
import { type AuthedRequest } from '../lib/auth.js';
import * as jf from '../services/jellyfin.js';

const r = Router();

r.get('/status', (_req, res) => res.json({ configured: jf.configured() }));

// Movies
r.get('/movies', async (_req, res, next) => {
  try { res.json(await jf.listByType('Movie', { SortBy: 'DateCreated', SortOrder: 'Descending' })); }
  catch (e) { if (!jf.configured()) return res.json([]); next(e); }
});

// Series
r.get('/series', async (_req, res, next) => {
  try { res.json(await jf.listByType('Series', { SortBy: 'SortName' })); }
  catch (e) { if (!jf.configured()) return res.json([]); next(e); }
});

// Music: artists / albums / songs
r.get('/music/albums', async (_req, res, next) => {
  try { res.json(await jf.listByType('MusicAlbum', { SortBy: 'SortName' })); }
  catch (e) { if (!jf.configured()) return res.json([]); next(e); }
});
r.get('/music/artists', async (_req, res, next) => {
  try { res.json(await jf.listByType('MusicArtist', { SortBy: 'SortName' })); }
  catch (e) { if (!jf.configured()) return res.json([]); next(e); }
});
r.get('/music/songs', async (_req, res, next) => {
  try { res.json(await jf.listByType('Audio', { SortBy: 'SortName', Limit: 500 })); }
  catch (e) { if (!jf.configured()) return res.json([]); next(e); }
});

// Personal videos (Home videos / everything with MediaType Video not Movie/Episode)
r.get('/videos', async (_req, res, next) => {
  try { res.json(await jf.listByType('Video', { SortBy: 'DateCreated', SortOrder: 'Descending' })); }
  catch (e) { if (!jf.configured()) return res.json([]); next(e); }
});

// Continue watching / listening
r.get('/resume/video', async (_req, res, next) => {
  try { res.json(await jf.resumeItems('Video')); } catch (e) { if (!jf.configured()) return res.json([]); next(e); }
});
r.get('/resume/audio', async (_req, res, next) => {
  try { res.json(await jf.resumeItems('Audio')); } catch (e) { if (!jf.configured()) return res.json([]); next(e); }
});

// Item detail + children (seasons/episodes/tracks)
r.get('/item/:id', async (req, res, next) => {
  try { res.json(await jf.itemDetail(req.params.id)); } catch (e) { next(e); }
});
r.get('/item/:id/children', async (req, res, next) => {
  try { res.json(await jf.children(req.params.id)); } catch (e) { next(e); }
});

r.get('/search', async (req, res, next) => {
  try { res.json(await jf.search(String(req.query.q || ''))); } catch (e) { if (!jf.configured()) return res.json([]); next(e); }
});

// Image proxy
r.get('/image/:id/:type', async (req, res, next) => {
  try {
    const url = jf.directImageUrl(req.params.id, req.params.type);
    const upstream = await fetch(url);
    if (!upstream.ok || !upstream.body) return res.status(404).end();
    res.setHeader('Content-Type', upstream.headers.get('content-type') || 'image/jpeg');
    res.setHeader('Cache-Control', 'private, max-age=86400');
    const buf = Buffer.from(await upstream.arrayBuffer());
    res.end(buf);
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
    const id = req.params.id;
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
    const masterUrl = `${base}/Videos/${id}/master.m3u8?api_key=${key}&MediaSourceId=${id}`
      + `&VideoCodec=h264&AudioCodec=aac,mp3&TranscodingMaxAudioChannels=2&SegmentContainer=ts&MinSegments=1`
      + `&MaxStreamingBitrate=120000000&VideoBitrate=119808000&AudioBitrate=192000`
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
      return res.send(proxifyPlaylist(text, abs, req.params.id));
    }
    return pipeStream(req, res, abs);
  } catch (e) { next(e); }
});

// Audio + subtitle tracks for the player's pickers.
r.get('/streams/:id', async (req, res, next) => {
  try { res.json(await jf.mediaStreams(req.params.id)); } catch (e) { next(e); }
});

// Subtitle proxy (VTT).
r.get('/subtitle/:id/:src/:index', async (req, res, next) => {
  try {
    const url = jf.directSubtitleUrl(req.params.id, req.params.src, Number(req.params.index));
    const up = await fetch(url);
    if (!up.ok) return res.status(up.status).end();
    res.setHeader('Content-Type', 'text/vtt');
    res.end(Buffer.from(await up.arrayBuffer()));
  } catch (e) { next(e); }
});

r.post('/progress', async (req, res) => {
  const { id, positionTicks } = req.body || {};
  await jf.reportProgress(id, positionTicks || 0);
  res.json({ ok: true });
});

r.post('/played', async (req, res) => {
  const { id, played } = req.body || {};
  await jf.setPlayed(id, played !== false);
  res.json({ ok: true });
});

// Recommendations: Next Up, suggestions, recently added.
r.get('/recommendations', async (_req, res, next) => {
  try { res.json(await jf.recommendations()); }
  catch (e) { if (!jf.configured()) return res.json({ nextUp: [], suggestions: [], recentlyAdded: [] }); next(e); }
});

// "More like this".
r.get('/similar/:id', async (req, res, next) => {
  try { res.json(await jf.similar(req.params.id)); } catch (e) { next(e); }
});

export default r;
