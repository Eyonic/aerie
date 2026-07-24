// Cast to TV — server-side Google Cast (works from any client, incl. the app).
import { Router } from 'express';
import { pipeline, Readable, Transform } from 'node:stream';
import { findUserById, rowToUser, type AuthedRequest } from '../lib/auth.js';
import { config } from '../config.js';
import { audit } from '../lib/db.js';
import * as cast from '../services/cast.js';
import * as jellyfin from '../services/jellyfin.js';
import * as audiobookshelf from '../services/audiobookshelf.js';
import { assertContentFeature, assertJellyfinItemFeature } from '../services/content-access.js';

const r = Router();

// Only RFC1918 addresses with valid octets — the cast machinery (and stream
// tokens) must never be aimed at arbitrary caller-named hosts.
function isPrivateLanIp(ip: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!m) return false;
  const o = m.slice(1).map(Number);
  if (o.some(x => x > 255)) return false;
  return o[0] === 10 || (o[0] === 172 && o[1] >= 16 && o[1] <= 31) || (o[0] === 192 && o[1] === 168);
}

const CONTROLLER_GENERATION = /^[a-f0-9]{32}$/;
function optionalControllerGeneration(value: unknown): string | undefined {
  if (value == null || value === '') return undefined;
  const generation = String(value);
  if (!CONTROLLER_GENERATION.test(generation)) throw Object.assign(new Error('bad_controller_generation'), { status: 400 });
  return generation;
}

// Base URL the TV uses to reach Aerie (same LAN as Jellyfin, our own port).
function lanBase(): string {
  const host = new URL(config.jellyfin.url || 'http://127.0.0.1:8096').hostname;
  return `http://${host}:${process.env.PORT || 8200}`;
}

r.get('/devices', async (req, res, next) => {
  try { res.json(await cast.discover(req.query.refresh === '1')); }
  catch (e) { next(e); }
});

r.post('/play', async (req: AuthedRequest, res, next) => {
  try {
    const { ip, itemId, positionSec } = req.body || {};
    const requestedGeneration = optionalControllerGeneration(req.body?.controllerGeneration);
    if (!isPrivateLanIp(String(ip || '')) || !itemId) return res.status(400).json({ error: 'missing_device_or_item' });
    if (!(await cast.isKnownDevice(String(ip)))) return res.status(400).json({ error: 'unknown_device' });
    const startSec = Number(positionSec) > 0 && Number.isFinite(Number(positionSec)) ? Number(positionSec) : 0;
    const item = await jellyfin.itemDetail(String(itemId));
    const feature = assertJellyfinItemFeature(req.user!, item);
    const title = item.name || 'Aerie';
    const subtitle = (item as any).seriesName
      ? `${(item as any).seriesName} · S${(item as any).seasonNumber}E${(item as any).episodeNumber}`
      : (item.year ? String(item.year) : '');
    const source = await jellyfin.castSource(String(itemId), startSec);
    const streamToken = cast.mintStreamToken(source.url, source.contentType, req.user!.id, feature);
    const artToken = cast.mintStreamToken(jellyfin.directImageUrl(String(itemId)), 'image/jpeg', req.user!.id, feature);
    const controllerGeneration = await cast.play(String(ip), {
      url: `${lanBase()}/api/cast-stream/${streamToken}.mp4`,
      contentType: source.contentType,
      title,
      subtitle,
      imageUrl: `${lanBase()}/api/cast-stream/${artToken}`,
      // Transcoded streams resume via StartTimeTicks server-side; the TV's own
      // timeline then starts at 0 and the client compensates with `offset`.
      startTime: source.canSeek ? startSec : 0,
    }, req.user!.id, req.user!.role === 'admin', requestedGeneration);
    audit(req.user!.id, req.user!.username, 'cast_play', `${itemId} -> ${ip}`);
    res.json({ ok: true, canSeek: source.canSeek, offset: source.canSeek ? 0 : startSec, controllerGeneration });
  } catch (e) { next(e); }
});

// Music and audiobook tracks use the same Default Media Receiver as video, but
// their upstreams differ: Jellyfin music may need an MP3 transcode, while an
// Audiobookshelf book must address the currently playing audio file by inode.
r.post('/play-audio', async (req: AuthedRequest, res, next) => {
  try {
    const { ip, source, itemId, fileId, positionSec } = req.body || {};
    const requestedGeneration = optionalControllerGeneration(req.body?.controllerGeneration);
    const targetIp = String(ip || '');
    const id = String(itemId || '');
    const safeId = /^[A-Za-z0-9_-]{1,160}$/;
    if (!isPrivateLanIp(targetIp) || !safeId.test(id) || !['jellyfin', 'audiobookshelf'].includes(source)) {
      return res.status(400).json({ error: 'missing_device_or_item' });
    }
    if (!(await cast.isKnownDevice(targetIp))) return res.status(400).json({ error: 'unknown_device' });
    const startSec = Number(positionSec) > 0 && Number.isFinite(Number(positionSec)) ? Number(positionSec) : 0;

    let media: { url: string; contentType: string; canSeek: boolean };
    let title = 'Aerie';
    let subtitle = '';
    let imageUrl = '';
    let feature: cast.CastStreamToken['feature'];
    if (source === 'jellyfin') {
      assertContentFeature(req.user!, 'music');
      const item = await jellyfin.itemDetail(id);
      if (item.type !== 'Audio') return res.status(400).json({ error: 'item_is_not_audio' });
      feature = assertJellyfinItemFeature(req.user!, item);
      media = await jellyfin.castAudioSource(id, startSec);
      title = item.name || title;
      subtitle = item.albumArtist || item.album || '';
      const artToken = cast.mintStreamToken(jellyfin.directImageUrl(id), 'image/jpeg', req.user!.id, feature);
      imageUrl = `${lanBase()}/api/cast-stream/${artToken}`;
    } else {
      feature = 'audiobooks';
      assertContentFeature(req.user!, feature);
      const requestedFile = fileId == null ? '' : String(fileId);
      if (requestedFile && !/^\d{1,32}$/.test(requestedFile)) return res.status(400).json({ error: 'bad_audio_file' });
      const [item, tracks] = await Promise.all([
        audiobookshelf.itemDetail(id),
        audiobookshelf.getAudioTracks(id),
      ]);
      const track = requestedFile ? tracks.find(t => t.ino === requestedFile) : tracks[0];
      if (!track) return res.status(404).json({ error: 'audio_file_not_found' });
      media = { url: audiobookshelf.directFileUrl(id, track.ino), contentType: track.mimeType, canSeek: true };
      title = tracks.length > 1 ? `${item.title} — ${track.title}` : item.title;
      subtitle = item.author || (item.mediaType === 'podcast' ? 'Podcast' : 'Audiobook');
      const artToken = cast.mintStreamToken(audiobookshelf.directCoverUrl(id), 'image/jpeg', req.user!.id, feature);
      imageUrl = `${lanBase()}/api/cast-stream/${artToken}`;
    }

    const streamToken = cast.mintStreamToken(media.url, media.contentType, req.user!.id, feature);
    const controllerGeneration = await cast.play(targetIp, {
      url: `${lanBase()}/api/cast-stream/${streamToken}`,
      contentType: media.contentType,
      title,
      subtitle,
      imageUrl,
      startTime: media.canSeek ? startSec : 0,
    }, req.user!.id, req.user!.role === 'admin', requestedGeneration);
    audit(req.user!.id, req.user!.username, 'cast_audio', `${source}:${id} -> ${targetIp}`);
    res.json({ ok: true, canSeek: media.canSeek, offset: media.canSeek ? 0 : startSec, controllerGeneration });
  } catch (e) { next(e); }
});

r.post('/control', async (req: AuthedRequest, res, next) => {
  try {
    const { ip, action, value } = req.body || {};
    const controllerGeneration = optionalControllerGeneration(req.body?.controllerGeneration);
    if (!isPrivateLanIp(String(ip || ''))) return res.status(400).json({ error: 'missing_device' });
    if (!['play', 'pause', 'stop', 'seek', 'quit'].includes(action)) return res.status(400).json({ error: 'bad_action' });
    const seekTo = action === 'seek' ? Number(value) : undefined;
    if (action === 'seek' && (!Number.isFinite(seekTo!) || seekTo! < 0)) return res.status(400).json({ error: 'bad_value' });
    const ok = await cast.control(String(ip), action, seekTo, req.user!.id, req.user!.role === 'admin', controllerGeneration);
    res.json({ ok });
  } catch (e) { next(e); }
});

r.get('/status', async (req: AuthedRequest, res, next) => {
  const ip = String(req.query.ip || '');
  let controllerGeneration: string | undefined;
  try { controllerGeneration = optionalControllerGeneration(req.query.controllerGeneration); }
  catch (error) { return next(error); }
  if (!isPrivateLanIp(ip)) return res.status(400).json({ error: 'missing_device' });
  // An unreachable TV reads as "no active session" — the client's strike counter
  // clears the overlay instead of a 500 leaving it stuck forever.
  try { res.json(await cast.status(ip, req.user!.id, req.user!.role === 'admin', controllerGeneration)); }
  catch (error: any) {
    if (Number(error?.status) >= 400) return next(error);
    res.json({ active: false });
  }
});

export default r;

// Public (token-authed) media proxy the TV fetches from — mounted OUTSIDE the
// auth middleware. The random token stands in for credentials; the Jellyfin
// api_key never leaves the server.
export const castStreamRouter = Router();
castStreamRouter.get('/:token', async (req, res) => {
  const token = String(req.params.token || '').replace(/\.mp4$/, '');
  const t = cast.resolveStreamToken(token);
  if (!t) return res.status(404).end();
  try {
    const authorized = () => {
      if (!cast.resolveStreamToken(token)) return false;
      const account = findUserById(t.userId);
      if (!account) return false;
      try { assertContentFeature(rowToUser(account), t.feature); return true; }
      catch { return false; }
    };
    if (!authorized()) return res.status(404).end();
    const upstream = new URL(t.url);
    const allowedOrigins = [config.jellyfin.url, config.audiobookshelf.url].flatMap(value => {
      try { return value ? [new URL(value).origin] : []; } catch { return []; }
    });
    if (!['http:', 'https:'].includes(upstream.protocol) || !allowedOrigins.includes(upstream.origin)) {
      return res.status(502).end();
    }
    const headers: Record<string, string> = {};
    if (req.headers.range) headers.Range = String(req.headers.range);
    const controller = new AbortController();
    const headerTimer = setTimeout(() => controller.abort(), 15_000);
    const up = await fetch(upstream, { headers, redirect: 'error', signal: controller.signal })
      .finally(() => clearTimeout(headerTimer));
    const maximumBytes = t.contentType.toLowerCase().startsWith('image/') ? 32 * 1024 * 1024 : 2 * 1024 ** 4;
    const declaredBytes = Number(up.headers.get('content-length'));
    if (Number.isFinite(declaredBytes) && (declaredBytes < 0 || declaredBytes > maximumBytes)) {
      controller.abort();
      return res.status(502).end();
    }
    res.status(up.status);
    for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges']) {
      const v = up.headers.get(h);
      if (v) res.setHeader(h, v);
    }
    if (!up.headers.get('content-type')) res.setHeader('content-type', t.contentType);
    if (!up.body) return res.end();
    const readable = Readable.fromWeb(up.body as any);
    let streamedBytes = 0;
    let lastAuthorization = Date.now();
    let idleTimer: NodeJS.Timeout;
    const abort = () => { controller.abort(); readable.destroy(); };
    const armIdleWatchdog = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(abort, 30_000);
    };
    const limiter = new Transform({
      transform(chunk, _encoding, callback) {
        streamedBytes += chunk.length;
        if (streamedBytes > maximumBytes) return callback(new Error('cast_stream_too_large'));
        if (Date.now() - lastAuthorization >= 5_000) {
          lastAuthorization = Date.now();
          if (!authorized()) return callback(new Error('cast_stream_revoked'));
        }
        armIdleWatchdog();
        callback(null, chunk);
      },
    });
    armIdleWatchdog();
    res.on('close', () => { if (!res.writableEnded) abort(); });
    pipeline(readable, limiter, res, error => {
      clearTimeout(idleTimer);
      if (error) {
        controller.abort();
        if (!res.headersSent) res.status(502).end();
        else if (!res.destroyed) res.destroy(error);
      }
    });
  } catch {
    if (!res.headersSent) res.status(502);
    res.end();
  }
});
