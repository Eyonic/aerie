// Cast to TV — server-side Google Cast (works from any client, incl. the app).
import { Router } from 'express';
import { pipeline } from 'node:stream';
import { Readable } from 'node:stream';
import { type AuthedRequest } from '../lib/auth.js';
import { config } from '../config.js';
import { audit } from '../lib/db.js';
import * as cast from '../services/cast.js';
import * as jellyfin from '../services/jellyfin.js';

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
    if (!isPrivateLanIp(String(ip || '')) || !itemId) return res.status(400).json({ error: 'missing_device_or_item' });
    if (!(await cast.isKnownDevice(String(ip)))) return res.status(400).json({ error: 'unknown_device' });
    const startSec = Number(positionSec) > 0 && Number.isFinite(Number(positionSec)) ? Number(positionSec) : 0;
    const item = await jellyfin.itemDetail(String(itemId));
    const title = item.name || 'Aerie';
    const subtitle = (item as any).seriesName
      ? `${(item as any).seriesName} · S${(item as any).seasonNumber}E${(item as any).episodeNumber}`
      : (item.year ? String(item.year) : '');
    const source = await jellyfin.castSource(String(itemId), startSec);
    const streamToken = cast.mintStreamToken(source.url, source.contentType);
    const artToken = cast.mintStreamToken(jellyfin.directImageUrl(String(itemId)), 'image/jpeg');
    await cast.play(String(ip), {
      url: `${lanBase()}/api/cast-stream/${streamToken}.mp4`,
      contentType: source.contentType,
      title,
      subtitle,
      imageUrl: `${lanBase()}/api/cast-stream/${artToken}`,
      // Transcoded streams resume via StartTimeTicks server-side; the TV's own
      // timeline then starts at 0 and the client compensates with `offset`.
      startTime: source.canSeek ? startSec : 0,
    });
    audit(req.user!.id, req.user!.username, 'cast_play', `${itemId} -> ${ip}`);
    res.json({ ok: true, canSeek: source.canSeek, offset: source.canSeek ? 0 : startSec });
  } catch (e) { next(e); }
});

r.post('/control', async (req: AuthedRequest, res, next) => {
  try {
    const { ip, action, value } = req.body || {};
    if (!isPrivateLanIp(String(ip || ''))) return res.status(400).json({ error: 'missing_device' });
    if (!['play', 'pause', 'stop', 'seek', 'quit'].includes(action)) return res.status(400).json({ error: 'bad_action' });
    const seekTo = action === 'seek' ? Number(value) : undefined;
    if (action === 'seek' && (!Number.isFinite(seekTo!) || seekTo! < 0)) return res.status(400).json({ error: 'bad_value' });
    const ok = await cast.control(String(ip), action, seekTo);
    res.json({ ok });
  } catch (e) { next(e); }
});

r.get('/status', async (req, res) => {
  const ip = String(req.query.ip || '');
  if (!isPrivateLanIp(ip)) return res.status(400).json({ error: 'missing_device' });
  // An unreachable TV reads as "no active session" — the client's strike counter
  // clears the overlay instead of a 500 leaving it stuck forever.
  try { res.json(await cast.status(ip)); }
  catch { res.json({ active: false }); }
});

export default r;

// Public (token-authed) media proxy the TV fetches from — mounted OUTSIDE the
// auth middleware. The random token stands in for credentials; the Jellyfin
// api_key never leaves the server.
export const castStreamRouter = Router();
castStreamRouter.get('/:token', async (req, res) => {
  const t = cast.resolveStreamToken(String(req.params.token || '').replace(/\.mp4$/, ''));
  if (!t) return res.status(404).end();
  try {
    const headers: Record<string, string> = {};
    if (req.headers.range) headers.Range = String(req.headers.range);
    const up = await fetch(t.url, { headers });
    res.status(up.status);
    for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges']) {
      const v = up.headers.get(h);
      if (v) res.setHeader(h, v);
    }
    if (!up.headers.get('content-type')) res.setHeader('content-type', t.contentType);
    if (!up.body) return res.end();
    pipeline(Readable.fromWeb(up.body as any), res, () => { /* client hung up / done */ });
  } catch {
    if (!res.headersSent) res.status(502);
    res.end();
  }
});
