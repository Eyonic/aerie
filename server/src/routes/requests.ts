// Requests — search & request movies/TV via Jellyseerr.
import { Router } from 'express';
import { type AuthedRequest } from '../lib/auth.js';
import { audit, db } from '../lib/db.js';
import * as js from '../services/jellyseerr.js';
import * as lidarr from '../services/lidarr.js';
import { cachedWebp, imageWidth } from '../services/image-cache.js';

const r = Router();

r.get('/status', async (_req, res) => {
  // Probe both backends concurrently — sequential awaits stack their timeouts
  // (~27s worst case) and this call gates the whole Requests page.
  const [online, musicOnline] = await Promise.all([
    js.configured() ? js.status() : Promise.resolve(false),
    lidarr.configured() ? lidarr.status() : Promise.resolve(false),
  ]);
  res.json({
    configured: js.configured(), online,
    music: { configured: lidarr.configured(), online: musicOnline },
  });
});

// ---- Music requests via Lidarr (Jellyseerr can't do music) ----
r.get('/music/search', async (req, res, next) => {
  try { res.json(await lidarr.searchArtists(String(req.query.q || ''))); }
  catch (e) { if (!lidarr.configured()) return res.json([]); next(e); }
});

// Trending artists (Deezer chart) — best-effort, an outage must not break the page.
r.get('/music/trending', async (_req, res) => {
  try { res.json(await lidarr.trendingArtists()); } catch { res.json([]); }
});

// Music "My requests": audit log (who/when) merged with live Lidarr status.
r.get('/music/mine', async (_req, res, next) => {
  try {
    const rows = db.prepare(
      "SELECT ts, username, target, meta FROM audit WHERE action='music_requested' ORDER BY ts DESC LIMIT 100",
    ).all() as any[];
    const lib = await lidarr.artistStatuses();
    const seen = new Set<string>();
    const out: any[] = [];
    for (const row of rows) {
      const mbid = String(row.target || '');
      if (!mbid || seen.has(mbid)) continue;
      let name = '';
      try { name = JSON.parse(row.meta || '{}').name || ''; } catch { /* legacy rows have no meta */ }
      const live = lib.get(mbid);
      // Removed from Lidarr with nothing to display — leave it unseen so an older
      // row for the same artist that does carry a name can still render "Removed".
      if (!live && !name) continue;
      seen.add(mbid);
      out.push({
        foreignArtistId: mbid,
        name: live?.name || name,
        posterUrl: live?.posterUrl,
        status: live?.status || 'removed',
        percent: live?.percent ?? 0,
        requestedBy: row.username,
        // sqlite datetime('now') is UTC without a zone marker — make it ISO.
        createdAt: row.ts ? `${String(row.ts).replace(' ', 'T')}Z` : undefined,
      });
      if (out.length >= 40) break;
    }
    res.json(out);
  } catch (e) { next(e); }
});

r.post('/music', async (req: AuthedRequest, res, next) => {
  try {
    const { foreignArtistId, name } = req.body || {};
    if (!foreignArtistId && !name) return res.status(400).json({ error: 'missing_artist' });
    const result = foreignArtistId
      ? await lidarr.requestArtist(String(foreignArtistId))
      : await lidarr.requestArtistByName(String(name));
    // A redundant click on an already-added artist must not steal attribution
    // (my-requests dedupes by newest audit row per artist).
    if (!result.already) {
      audit(req.user!.id, req.user!.username, 'music_requested',
        result.foreignArtistId || String(foreignArtistId || name), undefined, { name: result.name });
    }
    res.json(result);
  } catch (e) { next(e); }
});

r.get('/search', async (req, res, next) => {
  try { res.json(await js.search(String(req.query.q || ''))); }
  catch (e) { if (!js.configured()) return res.json([]); next(e); }
});

r.get('/trending', async (_req, res, next) => {
  try { res.json(await js.trending()); } catch (e) { if (!js.configured()) return res.json([]); next(e); }
});

r.get('/', async (_req, res, next) => {
  try { res.json(await js.listRequests()); } catch (e) { if (!js.configured()) return res.json([]); next(e); }
});

r.post('/', async (req: AuthedRequest, res, next) => {
  try {
    const { mediaType, mediaId, seasons } = req.body || {};
    const result = await js.requestMedia(mediaType, Number(mediaId), seasons);
    audit(req.user!.id, req.user!.username, 'media_requested', `${mediaType}:${mediaId}`);
    res.json({ ok: true, request: result });
  } catch (e) { next(e); }
});

r.get('/image', async (req, res, next) => {
  try {
    const p = String(req.query.p || '');
    if (!p) return res.status(400).end();
    const width = imageWidth(req.query.w, 480, 1280);
    const cached = await cachedWebp({
      namespace: 'requests', key: p, width, quality: 80,
      maxAgeMs: 30 * 86400_000,
      source: async () => {
        const img = await js.imageProxy(p, width);
        if (!img) throw Object.assign(new Error('image_not_found'), { status: 404 });
        return img.buf;
      },
    });
    res.setHeader('Content-Type', 'image/webp');
    res.setHeader('Cache-Control', 'public, max-age=604800');
    res.setHeader('X-Aerie-Image-Cache', cached.hit ? 'HIT' : 'MISS');
    res.sendFile(cached.file);
  } catch (e) { next(e); }
});

export default r;
