// Photos — PhotoPrism-backed, proxied through Aerie (per-user instances).
import { Router } from 'express';
import { type AuthedRequest } from '../lib/auth.js';
import * as pp from '../services/photoprism.js';

const r = Router();

function ppUser(req: AuthedRequest): string {
  // map Aerie user -> photoprism instance; fall back to default
  return (req.query.lib as string) || req.user!.username;
}

r.get('/status', (_req, res) => res.json({ configured: pp.configured() }));

r.get('/timeline', async (req: AuthedRequest, res, next) => {
  try {
    res.json(await pp.listPhotos(ppUser(req), {
      count: Number(req.query.count) || 120,
      offset: Number(req.query.offset) || 0,
      q: req.query.q as string,
    }));
  } catch (e) { if (!pp.configured()) return res.json([]); next(e); }
});

r.get('/favorites', async (req: AuthedRequest, res, next) => {
  try { res.json(await pp.listPhotos(ppUser(req), { favorite: true, count: 200 })); }
  catch (e) { if (!pp.configured()) return res.json([]); next(e); }
});

// Explore by objects/scenes (labels) + People (named faces).
r.get('/labels', async (req: AuthedRequest, res, next) => {
  try { res.json(await pp.listLabels(ppUser(req))); } catch (e) { if (!pp.configured()) return res.json([]); next(e); }
});
r.get('/label/:slug', async (req: AuthedRequest, res, next) => {
  try { res.json(await pp.photosByLabel(ppUser(req), req.params.slug)); } catch (e) { next(e); }
});
r.get('/people', async (req: AuthedRequest, res, next) => {
  try { res.json({ people: await pp.listPeople(ppUser(req)), faceClusters: await pp.faceClusterCount(ppUser(req)) }); }
  catch (e) { if (!pp.configured()) return res.json({ people: [], faceClusters: 0 }); next(e); }
});
r.get('/person/:uid', async (req: AuthedRequest, res, next) => {
  try { res.json(await pp.photosByPerson(ppUser(req), req.params.uid)); } catch (e) { next(e); }
});

// Geotagged photos for the Places map view (Google/Apple Photos style).
r.get('/geo', async (req: AuthedRequest, res, next) => {
  try {
    const photos = await pp.listPhotos(ppUser(req), { count: 2000 });
    res.json(photos.filter(p => p.lat && p.lng).map(p => ({
      id: p.id, uid: p.uid, lat: p.lat, lng: p.lng,
      thumbUrl: p.thumbUrl, previewUrl: p.previewUrl, title: p.title, takenAt: p.takenAt, type: p.type,
    })));
  } catch (e) { if (!pp.configured()) return res.json([]); next(e); }
});

r.get('/albums', async (req: AuthedRequest, res, next) => {
  try { res.json(await pp.listAlbums(ppUser(req))); }
  catch (e) { if (!pp.configured()) return res.json([]); next(e); }
});

r.get('/album/:uid', async (req: AuthedRequest, res, next) => {
  try { res.json(await pp.listPhotos(ppUser(req), { album: req.params.uid, count: 500 })); }
  catch (e) { next(e); }
});

// Thumb proxy: /thumb/:lib/:hash/:size
r.get('/thumb/:lib/:hash/:size', async (req, res, next) => {
  try {
    const token = await pp.thumbToken(req.params.lib);
    const url = `${pp.instanceFor(req.params.lib)}/api/v1/t/${req.params.hash}/${token}/${req.params.size}`;
    const upstream = await fetch(url);
    if (!upstream.ok) return res.status(404).end();
    res.setHeader('Content-Type', upstream.headers.get('content-type') || 'image/jpeg');
    res.setHeader('Cache-Control', 'private, max-age=86400');
    res.end(Buffer.from(await upstream.arrayBuffer()));
  } catch (e) { next(e); }
});

// Full download proxy
r.get('/download/:lib/:uid', async (req, res, next) => {
  try {
    const token = await pp.downloadTokenFor(req.params.lib);
    const url = `${pp.instanceFor(req.params.lib)}/api/v1/photos/${req.params.uid}/dl?t=${token}`;
    const upstream = await fetch(url);
    if (!upstream.ok) return res.status(404).end();
    res.setHeader('Content-Type', upstream.headers.get('content-type') || 'application/octet-stream');
    res.end(Buffer.from(await upstream.arrayBuffer()));
  } catch (e) { next(e); }
});

export default r;
