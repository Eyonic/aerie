// Map tile proxy for the Photos "Places" map. Tiles are fetched by THE SERVER
// (not the user's browser) from OpenStreetMap, so browsing photo locations never
// leaks the user's IP/coordinates to a third-party tile host. Cached aggressively.
import { Router } from 'express';

const r = Router();
const cache = new Map<string, { buf: Buffer; at: number }>();
const MAX = 4000;

r.get('/:z/:x/:y', async (req, res) => {
  const { z, x, y } = req.params;
  if (!/^\d+$/.test(z) || !/^\d+$/.test(x) || !/^\d+$/.test(y.replace(/\.png$/, ''))) return res.status(400).end();
  const yy = y.replace(/\.png$/, '');
  const keyStr = `${z}/${x}/${yy}`;
  const hit = cache.get(keyStr);
  if (hit) { res.setHeader('Content-Type', 'image/png'); res.setHeader('Cache-Control', 'public, max-age=2592000'); return res.end(hit.buf); }
  try {
    const sub = ['a', 'b', 'c'][(Number(x) + Number(yy)) % 3];
    const up = await fetch(`https://${sub}.tile.openstreetmap.org/${z}/${x}/${yy}.png`, {
      headers: { 'User-Agent': 'Aerie/1.0 (self-hosted)' }, signal: AbortSignal.timeout(8000),
    });
    if (!up.ok) return res.status(up.status).end();
    const buf = Buffer.from(await up.arrayBuffer());
    if (cache.size > MAX) cache.clear();
    cache.set(keyStr, { buf, at: Date.now() });
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'public, max-age=2592000');
    res.end(buf);
  } catch { res.status(502).end(); }
});

export default r;
