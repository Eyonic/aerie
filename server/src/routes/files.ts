import { Router } from 'express';
import multer from 'multer';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { type AuthedRequest } from '../lib/auth.js';
import { db, audit, notify } from '../lib/db.js';
import { config } from '../config.js';
import * as storage from '../services/storage.js';
import { cachedWebp, imageWidth } from '../services/image-cache.js';
import { videoFrame } from '../services/video-thumbnail.js';

const r = Router();
// temp dir lives under FILES_ROOT so the final move is a same-mount rename
const uploadTmp = path.join(config.filesRoot, '.uploads-tmp');
fs.mkdirSync(uploadTmp, { recursive: true });
const upload = multer({ dest: uploadTmp, limits: { fileSize: 20 * 1024 * 1024 * 1024 } });
const VIDEO_THUMB_EXT = /\.(mp4|mov|m4v|webm|mkv|avi|wmv|flv|mpg|mpeg|3gp|ogv|ts)$/i;

function u(req: AuthedRequest) { return req.user!; }

// List a folder
r.get('/list', (req: AuthedRequest, res, next) => {
  try {
    const p = (req.query.path as string) || '/';
    const listing = storage.list(u(req).username, u(req).id, p, {
      sort: req.query.sort as string, dir: req.query.dir as any,
    });
    res.json(listing);
  } catch (e) { next(e); }
});

// Recent files (across the tree)
r.get('/recent', (req: AuthedRequest, res, next) => {
  try {
    const root = storage.userRoot(u(req).username);
    const out: any[] = [];
    const walk = (dir: string, depth: number) => {
      if (depth > 6) return;
      let names: string[]; try { names = fs.readdirSync(dir); } catch { return; }
      for (const n of names) {
        if (n.startsWith('.')) continue;
        const full = path.join(dir, n);
        let st: fs.Stats; try { st = fs.statSync(full); } catch { continue; }
        if (st.isDirectory()) walk(full, depth + 1);
        else out.push(storage.entryFor(u(req).username, u(req).id, full));
      }
    };
    walk(root, 0);
    out.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
    res.json(out.slice(0, Number(req.query.limit) || 24));
  } catch (e) { next(e); }
});

// Starred
r.get('/starred', (req: AuthedRequest, res, next) => {
  try {
    const rows = db.prepare('SELECT path FROM stars WHERE user_id=? ORDER BY created_at DESC').all(u(req).id) as any[];
    const out = rows.map(row => {
      try { return storage.entryFor(u(req).username, u(req).id, storage.resolve(u(req).username, row.path)); }
      catch { return null; }
    }).filter(Boolean);
    res.json(out);
  } catch (e) { next(e); }
});

r.post('/star', (req: AuthedRequest, res) => {
  const { path: p, starred } = req.body || {};
  if (starred) db.prepare('INSERT OR IGNORE INTO stars (user_id,path) VALUES (?,?)').run(u(req).id, p);
  else db.prepare('DELETE FROM stars WHERE user_id=? AND path=?').run(u(req).id, p);
  res.json({ ok: true });
});

r.get('/usage', async (req: AuthedRequest, res, next) => {
  try { res.json(await storage.computeUsage(u(req).username, u(req).id)); } catch (e) { next(e); }
});

r.post('/mkdir', async (req: AuthedRequest, res, next) => {
  try {
    const { path: parent, name } = req.body || {};
    await storage.mkdir(u(req).username, path.posix.join(parent || '/', name));
    audit(u(req).id, u(req).username, 'mkdir', path.posix.join(parent || '/', name));
    res.json({ ok: true });
  } catch (e) { next(e); }
});

r.post('/rename', async (req: AuthedRequest, res, next) => {
  try {
    const { path: p, newName } = req.body || {};
    const dest = path.posix.join(path.posix.dirname(p), newName);
    await storage.rename(u(req).username, p, dest);
    // Re-key version history (keyed by path) so a rename keeps the file's history.
    db.prepare('UPDATE versions SET path=? WHERE user_id=? AND path=?').run(dest, u(req).id, p);
    audit(u(req).id, u(req).username, 'rename', `${p} -> ${dest}`);
    res.json({ ok: true, path: dest });
  } catch (e) { next(e); }
});

r.post('/move', async (req: AuthedRequest, res, next) => {
  try {
    const { paths, toDir } = req.body || {};
    for (const p of paths || []) await storage.move(u(req).username, p, toDir);
    audit(u(req).id, u(req).username, 'move', `${(paths || []).length} -> ${toDir}`);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

r.post('/copy', async (req: AuthedRequest, res, next) => {
  try {
    const { paths, toDir } = req.body || {};
    for (const p of paths || []) {
      const dest = path.posix.join(toDir, path.posix.basename(p));
      await storage.copy(u(req).username, p, dest);
    }
    audit(u(req).id, u(req).username, 'copy', `${(paths || []).length} -> ${toDir}`);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// Soft delete -> trash
r.post('/delete', async (req: AuthedRequest, res, next) => {
  try {
    const { paths } = req.body || {};
    for (const p of paths || []) {
      await storage.trash(u(req).username, u(req).id, p);
    }
    audit(u(req).id, u(req).username, 'delete', `${(paths || []).length} items`);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

r.get('/trash', (req: AuthedRequest, res) => {
  const rows = db.prepare('SELECT * FROM trash WHERE user_id=? ORDER BY deleted_at DESC').all(u(req).id) as any[];
  res.json(rows.map(t => ({
    id: t.id, name: t.name, originalPath: t.original_path, isFolder: !!t.is_folder,
    size: t.size, deletedAt: t.deleted_at,
  })));
});

r.post('/trash/restore', async (req: AuthedRequest, res, next) => {
  try {
    const { id } = req.body || {};
    const t = db.prepare('SELECT * FROM trash WHERE id=? AND user_id=?').get(id, u(req).id) as any;
    if (!t) return res.status(404).json({ error: 'not_found' });
    const dest = storage.resolve(u(req).username, t.original_path);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    await storage.safeMove(t.trashed_path, dest);
    db.prepare('DELETE FROM trash WHERE id=?').run(id);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

r.post('/trash/purge', async (req: AuthedRequest, res, next) => {
  try {
    const { id } = req.body || {};
    const rows = id
      ? [db.prepare('SELECT * FROM trash WHERE id=? AND user_id=?').get(id, u(req).id)]
      : db.prepare('SELECT * FROM trash WHERE user_id=?').all(u(req).id);
    for (const t of rows.filter(Boolean) as any[]) {
      try { await fsp.rm(t.trashed_path, { recursive: true, force: true }); } catch { /* */ }
      db.prepare('DELETE FROM trash WHERE id=?').run(t.id);
    }
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// Raw download / inline view
r.get('/raw', (req: AuthedRequest, res, next) => {
  try {
    const p = req.query.path as string;
    const { real, stat } = storage.statReal(u(req).username, p);
    if (stat.isDirectory()) return res.status(400).json({ error: 'is_folder' });
    if (req.query.download) res.setHeader('Content-Disposition', `attachment; filename="${path.basename(p)}"`);
    res.sendFile(real);
  } catch (e) { next(e); }
});

// Text content (for editors)
r.get('/content', async (req: AuthedRequest, res, next) => {
  try {
    const p = req.query.path as string;
    const { real } = storage.statReal(u(req).username, p);
    const content = await fsp.readFile(real, 'utf8');
    res.json({ path: p, content });
  } catch (e) { next(e); }
});

// Save text content (used by editors)
r.post('/content', async (req: AuthedRequest, res, next) => {
  try {
    const { path: p, content } = req.body || {};
    const { real } = storage.statReal(u(req).username, p);
    // snapshot old version
    try {
      const old = await fsp.readFile(real, 'utf8');
      const vid = 'v_' + Date.now().toString(36);
      const stored = path.join(config.versionsDir, vid);
      await fsp.writeFile(stored, old);
      db.prepare('INSERT INTO versions (id,user_id,path,stored_path,author,size_bytes) VALUES (?,?,?,?,?,?)')
        .run(vid, u(req).id, p, stored, u(req).displayName, Buffer.byteLength(old));
    } catch { /* new file, no prior version */ }
    await fsp.writeFile(real, content ?? '');
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// Create empty file (new doc/sheet/text)
r.post('/create', async (req: AuthedRequest, res, next) => {
  try {
    const { path: parent, name, content } = req.body || {};
    const dest = path.posix.join(parent || '/', name);
    const real = storage.resolve(u(req).username, dest);
    fs.mkdirSync(path.dirname(real), { recursive: true });
    await fsp.writeFile(real, content ?? '');
    res.json({ ok: true, path: dest });
  } catch (e) { next(e); }
});

// Thumbnails for images/videos
r.get('/thumb', async (req: AuthedRequest, res, next) => {
  try {
    const p = req.query.path as string;
    const { real, stat } = storage.statReal(u(req).username, p);
    const kind = storage.kindOf(path.basename(p), false);
    if (kind === 'image') {
      const width = imageWidth(req.query.w, 480, 960);
      const cached = await cachedWebp({
        namespace: 'files', key: `${u(req).id}:${p}`, source: real,
        sourceMtimeMs: stat.mtimeMs, width, quality: 78,
      });
      res.setHeader('Content-Type', 'image/webp');
      res.setHeader('Cache-Control', 'private, max-age=86400');
      res.setHeader('X-Aerie-Image-Cache', cached.hit ? 'HIT' : 'MISS');
      return res.sendFile(cached.file);
    }
    // Opt-in is used by the Videos page. The general Files browser keeps its
    // lightweight file-type tile instead of starting frame extraction there.
    if ((kind === 'video' || VIDEO_THUMB_EXT.test(p)) && req.query.videoFrame === '1') {
      const width = imageWidth(req.query.w, 480, 960);
      const cached = await cachedWebp({
        namespace: 'file-videos', key: `${u(req).id}:${p}`, source: () => videoFrame(real),
        sourceMtimeMs: stat.mtimeMs, width, height: Math.round(width * 9 / 16), fit: 'cover', quality: 76,
      });
      res.setHeader('Content-Type', 'image/webp');
      res.setHeader('Cache-Control', 'private, max-age=86400');
      res.setHeader('X-Aerie-Image-Cache', cached.hit ? 'HIT' : 'MISS');
      return res.sendFile(cached.file);
    }
    res.status(204).end();
  } catch (e) { res.status(204).end(); }
});

// Upload (multipart, multiple files, optional relativePath for folder uploads)
r.post('/upload', upload.array('files'), async (req: AuthedRequest, res, next) => {
  try {
    const dest = (req.body?.path as string) || '/';
    const relPaths: string[] = [].concat(req.body?.relativePaths || []);
    const files = (req.files as Express.Multer.File[]) || [];
    const saved: string[] = [];
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      const rel = relPaths[i] || f.originalname;
      const vdest = path.posix.join(dest, rel);
      const real = storage.resolve(u(req).username, vdest);
      fs.mkdirSync(path.dirname(real), { recursive: true });
      await storage.safeMove(f.path, real);
      saved.push(vdest);
    }
    audit(u(req).id, u(req).username, 'upload', `${saved.length} files -> ${dest}`);
    if (saved.length) notify(u(req).id, 'Upload complete', `${saved.length} file(s) uploaded to ${dest}`, 'success', '/files');
    res.json({ ok: true, saved });
  } catch (e) { next(e); }
});

// Version history for a file
r.get('/versions', (req: AuthedRequest, res) => {
  const p = req.query.path as string;
  const rows = db.prepare('SELECT * FROM versions WHERE user_id=? AND path=? ORDER BY created_at DESC').all(u(req).id, p) as any[];
  res.json(rows.map(v => ({ id: v.id, createdAt: v.created_at, author: v.author, note: v.note, sizeBytes: v.size_bytes })));
});

r.post('/versions/restore', async (req: AuthedRequest, res, next) => {
  try {
    const { path: p, versionId } = req.body || {};
    const v = db.prepare('SELECT * FROM versions WHERE id=? AND user_id=?').get(versionId, u(req).id) as any;
    if (!v) return res.status(404).json({ error: 'not_found' });
    const content = await fsp.readFile(v.stored_path, 'utf8');
    const real = storage.resolve(u(req).username, p);
    await fsp.writeFile(real, content);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

export default r;
