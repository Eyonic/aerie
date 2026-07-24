import express, { Router } from 'express';
import crypto from 'node:crypto';
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
import * as writes from '../services/storage-write.js';
import { assertFileAllowed } from '../services/policy.js';
import { validateFileName, validateVirtualPath } from '../lib/validation.js';
import { ensureFileCatalog, fileCatalogUsage, listFileCatalog, markFileCatalogStale, toFileEntry } from '../services/file-catalog.js';
import {
  boundedDiskStorage, claimUploadIngress, releaseIngress, reserveUploadIngress, withUploadIngressCleanup,
} from '../services/upload-ingress.js';
import { KeyedLock } from '../lib/keyed-lock.js';

const r = Router();
// temp dir lives under FILES_ROOT so the final move is a same-mount rename
const uploadTmp = path.join(config.filesRoot, '.uploads-tmp');
fs.mkdirSync(uploadTmp, { recursive: true });
const upload = multer({ storage: boundedDiskStorage(uploadTmp), limits: {
  files: 1000, fields: 1100, parts: 2101, fieldNameSize: 100, fieldSize: 16 * 1024,
} });
const VIDEO_THUMB_EXT = /\.(mp4|mov|m4v|webm|mkv|avi|wmv|flv|mpg|mpeg|3gp|ogv|ts)$/i;
const resumableLocks = new KeyedLock();

function u(req: AuthedRequest) { return req.user!; }
function vpath(value: unknown, allowRoot = false) {
  return validateVirtualPath(String(value ?? '/'), { allowRoot });
}
function selectedPaths(value: unknown): string[] {
  if (!Array.isArray(value) || !value.length || value.length > 1000) {
    throw Object.assign(new Error('invalid_paths'), { status: 400 });
  }
  const unique = [...new Set(value.map(item => vpath(item)))].sort((a, b) => a.length - b.length);
  return unique.filter((item, index) => !unique.slice(0, index).some(parent => item.startsWith(parent + '/')));
}

// List a folder
r.get('/list', async (req: AuthedRequest, res, next) => {
  try {
    const p = vpath(req.query.path ?? '/', true);
    const listing = await storage.listAsync(u(req).username, u(req).id, p, {
      sort: req.query.sort as string, dir: req.query.dir as any,
    });
    res.json(listing);
  } catch (e) { next(e); }
});

// Recent files (across the tree)
r.get('/recent', async (req: AuthedRequest, res, next) => {
  try {
    const user = u(req);
    const requestedLimit = Number(req.query.limit);
    const limit = Number.isFinite(requestedLimit) && requestedLimit > 0
      ? Math.min(200, Math.floor(requestedLimit))
      : 24;
    await ensureFileCatalog(user);
    const entries = listFileCatalog(user.id, {
      includeFolders: false,
      sort: 'recent',
      limit,
    });
    const starred = new Set(entries.length
      ? (db.prepare(`SELECT path FROM stars WHERE user_id=? AND path IN (${entries.map(() => '?').join(',')})`)
        .all(user.id, ...entries.map(entry => entry.path)) as any[]).map(row => String(row.path))
      : []);
    const out = entries.map(entry => toFileEntry(entry, { starred: starred.has(entry.path) }));
    res.json(out);
  } catch (e) { next(e); }
});

// Starred
r.get('/starred', async (req: AuthedRequest, res, next) => {
  try {
    const rows = db.prepare('SELECT path FROM stars WHERE user_id=? ORDER BY created_at DESC').all(u(req).id) as any[];
    const out: any[] = [];
    for (let offset = 0; offset < rows.length; offset += 64) {
      const batch = await Promise.all(rows.slice(offset, offset + 64).map(async row => {
        try { return await storage.entryForAsync(u(req).username, u(req).id, await storage.resolveAsync(u(req).username, row.path), true); }
        catch { return null; }
      }));
      out.push(...batch.filter(Boolean));
    }
    res.json(out);
  } catch (e) { next(e); }
});

r.post('/star', async (req: AuthedRequest, res, next) => {
  try {
    const p = vpath(req.body?.path);
    const starred = req.body?.starred === true;
    if (starred) {
      await storage.statRealAsync(u(req).username, p);
      const exists = db.prepare('SELECT 1 FROM stars WHERE user_id=? AND path=?').get(u(req).id, p);
      const count = exists ? 0 : (db.prepare('SELECT COUNT(*) count FROM stars WHERE user_id=?').get(u(req).id) as any).count;
      if (!exists && Number(count) >= 10_000) return res.status(409).json({ error: 'star_limit_reached' });
      db.prepare('INSERT OR IGNORE INTO stars (user_id,path) VALUES (?,?)').run(u(req).id, p);
    } else db.prepare('DELETE FROM stars WHERE user_id=? AND path=?').run(u(req).id, p);
    res.json({ ok: true });
  } catch (error) { next(error); }
});

r.get('/usage', async (req: AuthedRequest, res, next) => {
  try {
    const user = u(req);
    await ensureFileCatalog(user);
    const usage = { ...fileCatalogUsage(user.id), quotaBytes: user.storageQuotaBytes };
    usage.usedBytes = await writes.chargedUsageBytes(user);
    res.json(usage);
  } catch (e) { next(e); }
});

r.post('/mkdir', async (req: AuthedRequest, res, next) => {
  try {
    const parent = vpath(req.body?.path ?? '/', true);
    const name = validateFileName(req.body?.name);
    const destination = path.posix.join(parent, name);
    await fsp.mkdir(await storage.resolveAsync(u(req).username, destination));
    markFileCatalogStale(u(req).id);
    audit(u(req).id, u(req).username, 'mkdir', destination);
    res.status(201).json({ ok: true, path: destination });
  } catch (e) { next(e); }
});

r.post('/rename', async (req: AuthedRequest, res, next) => {
  try {
    const p = vpath(req.body?.path);
    const newName = validateFileName(req.body?.newName);
    const dest = path.posix.join(path.posix.dirname(p), newName);
    await writes.movePathAtomic({ user: u(req), from: p, to: dest });
    audit(u(req).id, u(req).username, 'rename', `${p} -> ${dest}`);
    res.json({ ok: true, path: dest });
  } catch (e) { next(e); }
});

r.post('/move', async (req: AuthedRequest, res, next) => {
  try {
    const paths = selectedPaths(req.body?.paths);
    const toDir = vpath(req.body?.toDir ?? '/', true);
    if (!(await fsp.stat(await storage.resolveAsync(u(req).username, toDir))).isDirectory()) {
      throw Object.assign(new Error('destination_not_folder'), { status: 400 });
    }
    for (const p of paths) {
      await writes.movePathAtomic({ user: u(req), from: p, to: path.posix.join(toDir, path.posix.basename(p)) });
    }
    audit(u(req).id, u(req).username, 'move', `${paths.length} -> ${toDir}`);
    res.json({ ok: true, moved: paths.length });
  } catch (e) { next(e); }
});

r.post('/copy', async (req: AuthedRequest, res, next) => {
  try {
    const paths = selectedPaths(req.body?.paths);
    const toDir = vpath(req.body?.toDir ?? '/', true);
    if (!(await fsp.stat(await storage.resolveAsync(u(req).username, toDir))).isDirectory()) {
      throw Object.assign(new Error('destination_not_folder'), { status: 400 });
    }
    for (const p of paths) {
      const dest = path.posix.join(toDir, path.posix.basename(p));
      await writes.copyPathAtomic({ user: u(req), from: p, to: dest });
    }
    audit(u(req).id, u(req).username, 'copy', `${paths.length} -> ${toDir}`);
    res.json({ ok: true, copied: paths.length });
  } catch (e) { next(e); }
});

// Soft delete -> trash
r.post('/delete', async (req: AuthedRequest, res, next) => {
  try {
    const paths = selectedPaths(req.body?.paths);
    for (const p of paths) {
      await storage.trash(u(req).username, u(req).id, p);
    }
    markFileCatalogStale(u(req).id);
    audit(u(req).id, u(req).username, 'delete', `${paths.length} items`);
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
    const id = String(req.body?.id || '');
    if (!/^t_[a-f0-9-]{36}$/i.test(id)) return res.status(400).json({ error: 'invalid_id' });
    await writes.restoreTrashAtomic(u(req), id);
    audit(u(req).id, u(req).username, 'trash_restored', id, req.ip);
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
r.get('/raw', async (req: AuthedRequest, res, next) => {
  try {
    const p = vpath(req.query.path);
    const { real, stat } = await storage.statRealAsync(u(req).username, p);
    if (stat.isDirectory()) return res.status(400).json({ error: 'is_folder' });
    if (req.query.download) res.setHeader('Content-Disposition', `attachment; filename="${path.basename(p)}"`);
    res.sendFile(real);
  } catch (e) { next(e); }
});

// Text content (for editors)
r.get('/content', async (req: AuthedRequest, res, next) => {
  try {
    const p = vpath(req.query.path);
    const { real, stat } = await storage.statRealAsync(u(req).username, p);
    if (stat.size > 32 * 1024 * 1024) return res.status(413).json({ error: 'file_too_large_for_editor' });
    const content = await fsp.readFile(real, 'utf8');
    const revision = writes.revisionFor(stat);
    res.setHeader('ETag', revision);
    res.json({ path: p, content, revision, modifiedAt: stat.mtime.toISOString() });
  } catch (e) { next(e); }
});

// Lightweight optimistic-concurrency metadata for binary files. Editors can
// obtain this from /content, but version restore also applies to large media
// that must never be decoded as UTF-8 just to obtain its current revision.
r.get('/revision', async (req: AuthedRequest, res, next) => {
  try {
    const p = vpath(req.query.path);
    const { stat } = await storage.statRealAsync(u(req).username, p);
    if (!stat.isFile()) return res.status(400).json({ error: 'is_folder' });
    const revision = writes.revisionFor(stat);
    res.setHeader('ETag', revision);
    res.json({ path: p, revision, modifiedAt: stat.mtime.toISOString(), size: stat.size });
  } catch (e) { next(e); }
});

// Save text content (used by editors)
r.post('/content', async (req: AuthedRequest, res, next) => {
  try {
    const p = vpath(req.body?.path);
    const content = req.body?.content;
    if (typeof content !== 'string') return res.status(400).json({ error: 'content_required' });
    if (Buffer.byteLength(content) > 32 * 1024 * 1024) return res.status(413).json({ error: 'content_too_large' });
    const expectedRevision = String(req.get('if-match') || req.body?.revision || '') || undefined;
    const result = await writes.writeFileAtomic({ user: u(req), virtualPath: p, data: content,
      expectedRevision, versionNote: 'Editor save' });
    audit(u(req).id, u(req).username, 'file_saved', p, req.ip, { revision: result.revision });
    res.setHeader('ETag', result.revision);
    res.json({ ok: true, revision: result.revision, versionId: result.versionId });
  } catch (e) { next(e); }
});

// Create empty file (new doc/sheet/text)
r.post('/create', async (req: AuthedRequest, res, next) => {
  try {
    const parent = vpath(req.body?.path ?? '/', true);
    const cleanName = validateFileName(req.body?.name);
    const content = req.body?.content;
    const dest = path.posix.join(parent, cleanName);
    const data = typeof content === 'string' ? content : '';
    const result = await writes.writeFileAtomic({ user: u(req), virtualPath: dest, data, expectedRevision: '*', createVersion: false });
    audit(u(req).id, u(req).username, 'file_created', dest, req.ip);
    res.status(201).json({ ok: true, path: dest, revision: result.revision });
  } catch (e) { next(e); }
});

// Thumbnails for images/videos
r.get('/thumb', async (req: AuthedRequest, res, next) => {
  try {
    const p = req.query.path as string;
    const { real, stat } = await storage.statRealAsync(u(req).username, p);
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
r.post('/upload', reserveUploadIngress, withUploadIngressCleanup(upload.array('files')), async (req: AuthedRequest, res, next) => {
  const files = ((req as any).files as any[]) || [];
  let failure: unknown;
  try {
    const reservation = claimUploadIngress(req);
    const dest = (req.body?.path as string) || '/';
    const relPaths: string[] = [].concat(req.body?.relativePaths || []);
    if (!files.length) return res.status(400).json({ error: 'missing_file' });
    for (const file of files) assertFileAllowed(file.originalname, file.size);
    const saved: string[] = [];
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      const rel = relPaths[i] || f.originalname;
      if (!rel || String(rel).replace(/\\/g, '/').split('/').some(part => !part || part === '.' || part === '..')) {
        throw Object.assign(new Error('invalid_path'), { status: 400 });
      }
      const vdest = path.posix.join(dest, rel);
      await writes.commitTempFile({ user: u(req), virtualPath: vdest, tempPath: f.path,
        reservation, releaseReservation: false, versionNote: 'Upload replacement' });
      saved.push(vdest);
    }
    audit(u(req).id, u(req).username, 'upload', `${saved.length} files -> ${dest}`);
    if (saved.length) notify(u(req).id, 'Upload complete', `${saved.length} file(s) uploaded to ${dest}`, 'success', '/files');
    res.json({ ok: true, saved });
  } catch (e) { failure = e; }
  finally {
    await Promise.all(files.map(file => fsp.rm(file.path, { force: true }).catch(() => {})));
    releaseIngress(req);
  }
  if (failure) next(failure);
});

// Chunked uploads survive a dropped mobile connection or browser restart. The
// client keeps the session id and asks for the server offset before continuing.
r.post('/upload-resumable/init', async (req: AuthedRequest, res, next) => {
  try {
    const stale = db.prepare("SELECT id,reservation_id FROM upload_sessions WHERE datetime(updated_at)<datetime('now','-24 hours')").all() as any[];
    for (const item of stale) {
      await fsp.rm(path.join(uploadTmp, `resume-${item.id}`), { force: true }).catch(() => {});
      writes.releaseStorage(item.reservation_id);
      db.prepare('DELETE FROM upload_sessions WHERE id=?').run(item.id);
    }
    const total = Math.max(0, Math.floor(Number(req.body?.size)));
    if (!Number.isFinite(total)) return res.status(400).json({ error: 'invalid_size' });
    const parent = String(req.body?.path || '/');
    const rel = String(req.body?.relativePath || req.body?.name || '').replace(/\\/g, '/').replace(/^\/+/, '');
    if (!rel || rel.split('/').some(p => !p || p === '.' || p === '..')) return res.status(400).json({ error: 'invalid_path' });
    const display = path.posix.join(parent, rel);
    assertFileAllowed(display, total);
    const dest = await storage.resolveAsync(u(req).username, display);
    const wanted = String(req.body?.uploadId || '');
    let row = wanted ? db.prepare(`SELECT * FROM upload_sessions WHERE id=? AND user_id=? AND status='uploading'`).get(wanted, u(req).id) as any : null;
    if (row) {
      const present = await fsp.access(path.join(uploadTmp, `resume-${row.id}`)).then(() => true, () => false);
      if (row.dest_path !== dest || row.total_size !== total || !present) row = null;
    }
    if (row) {
      if (!row.reservation_id || !db.prepare("SELECT 1 FROM storage_reservations WHERE id=? AND datetime(expires_at)>datetime('now')").get(row.reservation_id)) {
        const restored = await writes.reserveStorage(u(req), total);
        row.reservation_id = restored.id;
        db.prepare('UPDATE upload_sessions SET reservation_id=? WHERE id=?').run(restored.id, row.id);
      }
      const actual = (await fsp.stat(path.join(uploadTmp, `resume-${row.id}`))).size;
      if (actual !== row.received_size) db.prepare("UPDATE upload_sessions SET received_size=?,updated_at=datetime('now') WHERE id=?").run(actual, row.id);
      return res.json({ uploadId: row.id, offset: actual, size: total });
    }
    const reservation = await writes.reserveStorage(u(req), total);
    const id = crypto.randomUUID(); const temp = path.join(uploadTmp, `resume-${id}`);
    try {
      await fsp.writeFile(temp, Buffer.alloc(0), { flag: 'wx', mode: 0o600 });
      db.prepare(`INSERT INTO upload_sessions (id,user_id,dest_path,display_path,total_size,last_modified,reservation_id) VALUES (?,?,?,?,?,?,?)`)
        .run(id, u(req).id, dest, display, total, Number(req.body?.lastModified) || null, reservation.id);
    } catch (error) { writes.releaseStorage(reservation); await fsp.rm(temp, { force: true }).catch(() => {}); throw error; }
    res.json({ uploadId: id, offset: 0, size: total });
  } catch (e) { next(e); }
});

r.patch('/upload-resumable/:id', express.raw({ type: 'application/octet-stream', limit: '9mb' }), async (req: AuthedRequest, res, next) => {
  try {
    const id = String(req.params.id);
    await resumableLocks.run(id, async () => {
      const row = db.prepare(`SELECT * FROM upload_sessions WHERE id=? AND user_id=? AND status='uploading'`).get(id, u(req).id) as any;
      if (!row) return res.status(404).json({ error: 'upload_session_not_found' });
      const rawOffset = Number(req.headers['x-upload-offset']);
      if (!Number.isSafeInteger(rawOffset) || rawOffset < 0) return res.status(400).json({ error: 'invalid_upload_offset' });
      const offset = rawOffset;
      const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      const claimedHash = String(req.headers['x-chunk-sha256'] || '').trim().toLowerCase();
      if (claimedHash) {
        const actualHash = crypto.createHash('sha256').update(body).digest('hex');
        if (!/^[a-f0-9]{64}$/.test(claimedHash)
          || !crypto.timingSafeEqual(Buffer.from(actualHash, 'hex'), Buffer.from(claimedHash, 'hex'))) {
          return res.status(400).json({ error: 'chunk_hash_mismatch', offset });
        }
      }
      const temp = path.join(uploadTmp, `resume-${id}`); const actual = (await fsp.stat(temp)).size;
      if (offset !== actual) return res.status(409).json({ error: 'offset_mismatch', offset: actual });
      if (actual + body.length > row.total_size) return res.status(400).json({ error: 'chunk_exceeds_size' });
      await fsp.appendFile(temp, body); const received = actual + body.length;
      db.prepare("UPDATE upload_sessions SET received_size=?,updated_at=datetime('now') WHERE id=? AND status='uploading'").run(received, id);
      if (row.reservation_id) db.prepare("UPDATE storage_reservations SET expires_at=? WHERE id=?")
        .run(new Date(Date.now() + 2 * 3600_000).toISOString(), row.reservation_id);
      res.json({ uploadId: id, offset: received, complete: received === row.total_size });
    });
  } catch (e) { next(e); }
});

r.post('/upload-resumable/:id/complete', async (req: AuthedRequest, res, next) => {
  try {
    const id = String(req.params.id);
    await resumableLocks.run(id, async () => {
      const row = db.prepare(`SELECT * FROM upload_sessions WHERE id=? AND user_id=? AND status='uploading'`).get(id, u(req).id) as any;
      if (!row) return res.status(404).json({ error: 'upload_session_not_found' });
      const temp = path.join(uploadTmp, `resume-${id}`); const actual = (await fsp.stat(temp)).size;
      if (actual !== row.total_size) return res.status(409).json({ error: 'upload_incomplete', offset: actual, size: row.total_size });
      const claimedHash = String(req.body?.sha256 || '').trim().toLowerCase();
      if (claimedHash) {
        if (!/^[a-f0-9]{64}$/.test(claimedHash)) return res.status(400).json({ error: 'invalid_content_hash' });
        const actualHash = await new Promise<string>((resolve, reject) => {
          const hash = crypto.createHash('sha256');
          const stream = fs.createReadStream(temp);
          stream.on('error', reject);
          stream.on('data', chunk => hash.update(chunk));
          stream.on('end', () => resolve(hash.digest('hex')));
        });
        if (!crypto.timingSafeEqual(Buffer.from(actualHash, 'hex'), Buffer.from(claimedHash, 'hex'))) {
          return res.status(409).json({ error: 'content_hash_mismatch', offset: actual });
        }
      }
      const claimed = db.prepare("UPDATE upload_sessions SET status='committing',updated_at=datetime('now') WHERE id=? AND user_id=? AND status='uploading'")
        .run(id, u(req).id);
      if (claimed.changes !== 1) return res.status(409).json({ error: 'upload_already_committing' });
      try {
        const result = await writes.commitTempFile({ user: u(req), virtualPath: row.display_path, tempPath: temp,
          reservation: row.reservation_id ? { id: row.reservation_id, bytes: row.total_size } : undefined,
          mtimeMs: row.last_modified || undefined, versionNote: 'Resumable upload replacement' });
        db.prepare('DELETE FROM upload_sessions WHERE id=?').run(id);
        audit(u(req).id, u(req).username, 'resumable_upload', row.display_path);
        notify(u(req).id, 'Upload complete', `${path.posix.basename(row.display_path)} uploaded`, 'success', '/files');
        res.json({ ok: true, saved: [row.display_path], revision: result.revision });
      } catch (error) {
        db.prepare("UPDATE upload_sessions SET status='failed',updated_at=datetime('now') WHERE id=?").run(id);
        throw error;
      }
    });
  } catch (e) { next(e); }
});

r.delete('/upload-resumable/:id', async (req: AuthedRequest, res, next) => {
  try {
    const id = String(req.params.id);
    await resumableLocks.run(id, async () => {
      const row = db.prepare('SELECT * FROM upload_sessions WHERE id=? AND user_id=?').get(id, u(req).id) as any;
      if (!row) return res.status(404).json({ error: 'upload_session_not_found' });
      await fsp.rm(path.join(uploadTmp, `resume-${row.id}`), { force: true });
      writes.releaseStorage(row.reservation_id);
      db.prepare('DELETE FROM upload_sessions WHERE id=?').run(row.id);
      res.json({ ok: true });
    });
  } catch (error) { next(error); }
});

// Version history for a file
r.get('/versions', (req: AuthedRequest, res) => {
  const p = req.query.path as string;
  const rows = db.prepare('SELECT * FROM versions WHERE user_id=? AND path=? ORDER BY created_at DESC').all(u(req).id, p) as any[];
  res.json(rows.map(v => ({ id: v.id, createdAt: v.created_at, author: v.author, note: v.note, sizeBytes: v.size_bytes })));
});

r.post('/versions/restore', async (req: AuthedRequest, res, next) => {
  let temp = '';
  let reservation: writes.StorageReservation | undefined;
  try {
    const { path: p, versionId } = req.body || {};
    const v = db.prepare('SELECT * FROM versions WHERE id=? AND user_id=?').get(versionId, u(req).id) as any;
    if (!v) return res.status(404).json({ error: 'not_found' });
    const source = String(v.stored_path);
    const sourceStat = await fsp.lstat(source);
    if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) {
      throw Object.assign(new Error('version_content_unavailable'), { status: 410 });
    }
    // Versions can be many gigabytes. Clone/copy into the atomic write path
    // instead of materializing the entire file in the Node heap.
    reservation = await writes.reserveStorage(u(req), sourceStat.size);
    temp = path.join(uploadTmp, `version-restore-${crypto.randomUUID()}`);
    await fsp.copyFile(source, temp, fs.constants.COPYFILE_EXCL | fs.constants.COPYFILE_FICLONE);
    const result = await writes.commitTempFile({ user: u(req), virtualPath: vpath(p), tempPath: temp,
      expectedRevision: req.body?.revision || undefined, versionNote: `Before restoring ${versionId}`, reservation });
    temp = '';
    reservation = undefined; // commitTempFile released it
    res.json({ ok: true, revision: result.revision });
  } catch (e) { next(e); }
  finally {
    if (temp) await fsp.rm(temp, { force: true }).catch(() => {});
    writes.releaseStorage(reservation);
  }
});

export default r;
