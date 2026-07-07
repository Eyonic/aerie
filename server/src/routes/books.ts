// Audiobooks + Podcasts — Audiobookshelf-backed, streamed through Aerie.
import { Router } from 'express';
import * as abs from '../services/audiobookshelf.js';
import { type AuthedRequest } from '../lib/auth.js';

const r = Router();

r.use((req: AuthedRequest, res, next) => {
  if (req.user!.features?.audiobooks === false) return res.status(403).json({ error: 'feature_disabled' });
  next();
});

r.get('/status', (_req, res) => res.json({ configured: abs.configured() }));

r.get('/audiobooks', async (_req, res, next) => {
  try { res.json(await abs.allBooks('book')); } catch (e) { if (!abs.configured()) return res.json([]); next(e); }
});
r.get('/podcasts', async (_req, res, next) => {
  try { res.json(await abs.allBooks('podcast')); } catch (e) { if (!abs.configured()) return res.json([]); next(e); }
});

r.get('/item/:id', async (req, res, next) => {
  try { res.json(await abs.itemDetail(req.params.id)); } catch (e) { next(e); }
});

r.get('/cover/:id', async (req, res, next) => {
  try {
    const upstream = await fetch(abs.directCoverUrl(req.params.id));
    if (!upstream.ok) return res.status(404).end();
    res.setHeader('Content-Type', upstream.headers.get('content-type') || 'image/jpeg');
    res.setHeader('Cache-Control', 'private, max-age=86400');
    res.end(Buffer.from(await upstream.arrayBuffer()));
  } catch (e) { next(e); }
});

// Range-aware, backpressure-safe proxy of any ABS URL to the browser.
async function proxyAudio(req: any, res: any, target: string) {
  const range = req.headers.range;
  const upstream = await fetch(target, { headers: range ? { Range: range } : {} });
  res.status(upstream.status);
  upstream.headers.forEach((v: string, k: string) => {
    if (['content-type', 'content-length', 'content-range', 'accept-ranges'].includes(k)) res.setHeader(k, v);
  });
  if (!res.getHeader('accept-ranges')) res.setHeader('Accept-Ranges', 'bytes');
  if (!upstream.body) return res.end();
  const { Readable } = await import('node:stream');
  const nodeStream = Readable.fromWeb(upstream.body as any);
  nodeStream.pipe(res);
  nodeStream.on('error', () => res.end());
  req.on('close', () => nodeStream.destroy());
}

// Per-book tracks (one per audio file) — the frontend plays these as a queue so
// multi-file audiobooks work; single-file books just get a one-item queue.
r.get('/tracks/:id', async (req, res, next) => {
  try {
    const tracks = await abs.getAudioTracks(req.params.id);
    res.json(tracks.map(t => ({ ...t, streamUrl: abs.fileStreamUrl(req.params.id, t.ino) })));
  } catch (e) { next(e); }
});

// Stream a specific audio FILE (correct for multi-file + folders with extras).
r.get('/file/:id/:ino', async (req, res, next) => {
  try { await proxyAudio(req, res, abs.directFileUrl(req.params.id, req.params.ino)); }
  catch (e) { next(e); }
});

// Back-compat single stream: resolve to the book's FIRST audio file (never the
// item-level /download, which returns a ZIP when the folder has cover/metadata).
r.get('/stream/:id', async (req, res, next) => {
  try {
    const tracks = await abs.getAudioTracks(req.params.id);
    if (!tracks.length) return res.status(404).json({ error: 'no_audio' });
    await proxyAudio(req, res, abs.directFileUrl(req.params.id, tracks[0].ino));
  } catch (e) { next(e); }
});

r.post('/progress', async (req, res) => {
  const { id, currentTime, duration } = req.body || {};
  await abs.updateProgress(id, currentTime || 0, duration || 0);
  res.json({ ok: true });
});

export default r;
