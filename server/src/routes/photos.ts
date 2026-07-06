// Photos — PhotoPrism-backed, proxied through Aerie (per-user instances).
import { Router } from 'express';
import multer from 'multer';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import mime from 'mime-types';
import { type AuthedRequest } from '../lib/auth.js';
import { db } from '../lib/db.js';
import { config } from '../config.js';
import * as pp from '../services/photoprism.js';
import * as photolib from '../services/photolib.js';
import * as storage from '../services/storage.js';

const r = Router();
const uploadTmp = path.join(config.filesRoot, '.photo-uploads-tmp');
fs.mkdirSync(uploadTmp, { recursive: true });
const upload = multer({ dest: uploadTmp, limits: { files: 50, fileSize: 1024 * 1024 * 1024 } });

function ppUser(req: AuthedRequest): string {
  // map Aerie user -> photoprism instance; fall back to default
  return (req.query.lib as string) || req.user!.username;
}

function u(req: AuthedRequest) { return req.user!; }

function photoDateDir(ms: number): string {
  const d = Number.isFinite(ms) ? new Date(ms) : new Date();
  const valid = Number.isNaN(d.getTime()) ? new Date() : d;
  return `Photos/${valid.getFullYear()}/${String(valid.getMonth() + 1).padStart(2, '0')}`;
}

async function uniquePhotoPath(username: string, dir: string, filename: string): Promise<string> {
  const parsed = path.parse(filename.replace(/[\\/]/g, '_'));
  const stem = parsed.name || 'photo';
  const ext = parsed.ext;
  let rel = path.posix.join(dir, stem + ext);
  let n = 2;
  while (true) {
    try { await fsp.access(storage.resolve(username, rel)); rel = path.posix.join(dir, `${stem} (${n++})${ext}`); }
    catch { return rel; }
  }
}

r.get('/status', (req: AuthedRequest, res) => res.json({ configured: pp.configuredFor(u(req).username) }));

r.get('/native/status', (req: AuthedRequest, res) => {
  res.json(photolib.status(u(req).id));
});

r.post('/native/scan', async (req: AuthedRequest, res, next) => {
  try { res.json({ count: await photolib.scan(u(req)) }); } catch (e) { next(e); }
});

r.get('/native/timeline', (req: AuthedRequest, res, next) => {
  try { res.json(photolib.timeline(u(req), { cursor: req.query.cursor as string, limit: Number(req.query.limit) || undefined })); }
  catch (e) { next(e); }
});

r.get('/native/months', (req: AuthedRequest, res, next) => {
  try { res.json(photolib.months(u(req).id)); } catch (e) { next(e); }
});

r.post('/native/upload', upload.array('files', 50), async (req: AuthedRequest, res, next) => {
  const files = ((req as any).files as any[]) || [];
  try {
    const lastModified: string[] = [].concat(req.body?.lastModified || []);
    for (const f of files) photolib.assertPhotoPath(`Photos/_/${f.originalname}`);
    const created = [];
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      const dir = photoDateDir(Number(lastModified[i]));
      const rel = await uniquePhotoPath(u(req).username, dir, f.originalname);
      const real = storage.resolve(u(req).username, rel);
      await fsp.mkdir(path.dirname(real), { recursive: true });
      await storage.safeMove(f.path, real);
      // No-EXIF photos fall back to file mtime for takenAt — make that the
      // client's original date rather than the upload moment.
      const lm = Number(lastModified[i]);
      if (Number.isFinite(lm) && lm > 0) await fsp.utimes(real, new Date(lm), new Date(lm)).catch(() => {});
      const item = await photolib.indexFile(u(req), rel);
      if (item) created.push(item);
    }
    res.json({ items: created });
  } catch (e) {
    await Promise.all(files.map(f => fsp.rm(f.path, { force: true }).catch(() => {})));
    next(e);
  }
});

r.get('/native/thumb', async (req: AuthedRequest, res, next) => {
  try {
    const file = await photolib.thumb(u(req), req.query.path as string);
    res.setHeader('Content-Type', 'image/webp');
    res.setHeader('Cache-Control', 'private, max-age=86400');
    res.sendFile(file);
  } catch (e) { next(e); }
});

r.get('/native/file', (req: AuthedRequest, res, next) => {
  try {
    const rel = photolib.assertPhotoPath(req.query.path as string);
    const { real, stat } = storage.statReal(u(req).username, rel);
    if (stat.isDirectory()) return res.status(400).json({ error: 'is_folder' });
    res.setHeader('Content-Type', mime.lookup(rel) || 'application/octet-stream');
    res.setHeader('Cache-Control', 'private, max-age=86400');
    res.sendFile(real);
  } catch (e) { next(e); }
});

r.delete('/native', async (req: AuthedRequest, res, next) => {
  try {
    const paths = Array.isArray(req.body?.paths) ? req.body.paths.map((p: string) => photolib.assertPhotoPath(p)) : [];
    for (const p of paths) {
      await storage.trash(u(req).username, u(req).id, p);
      db.prepare('DELETE FROM photo_index WHERE user_id=? AND rel_path=?').run(u(req).id, p);
    }
    res.json({ ok: true });
  } catch (e) { next(e); }
});

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
  try { res.json(await pp.photosByLabel(ppUser(req), String(req.params.slug))); } catch (e) { next(e); }
});
r.get('/people', async (req: AuthedRequest, res, next) => {
  try { res.json({ people: await pp.listPeople(ppUser(req)), faceClusters: await pp.faceClusterCount(ppUser(req)) }); }
  catch (e) { if (!pp.configured()) return res.json({ people: [], faceClusters: 0 }); next(e); }
});
r.get('/person/:uid', async (req: AuthedRequest, res, next) => {
  try { res.json(await pp.photosByPerson(ppUser(req), String(req.params.uid))); } catch (e) { next(e); }
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
  try { res.json(await pp.listPhotos(ppUser(req), { album: String(req.params.uid), count: 500 })); }
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
