// Photos — native Aerie photo library.
import { Router } from 'express';
import multer from 'multer';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import mime from 'mime-types';
import { type AuthedRequest } from '../lib/auth.js';
import { db } from '../lib/db.js';
import { config } from '../config.js';
import * as photolib from '../services/photolib.js';
import * as storage from '../services/storage.js';

const r = Router();
const uploadTmp = path.join(config.filesRoot, '.photo-uploads-tmp');
fs.mkdirSync(uploadTmp, { recursive: true });
const upload = multer({ dest: uploadTmp, limits: { files: 50, fileSize: 1024 * 1024 * 1024 } });

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

r.get('/status', (_req: AuthedRequest, res) => res.json({ configured: true, native: true }));

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

r.get('/native/geo', (req: AuthedRequest, res, next) => {
  try { res.json(photolib.geo(u(req).id)); } catch (e) { next(e); }
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

export default r;
