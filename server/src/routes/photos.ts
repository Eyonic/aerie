// Photos — native Aerie photo library.
import { Router } from 'express';
import multer from 'multer';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import mime from 'mime-types';
import { type AuthedRequest } from '../lib/auth.js';
import { db, audit, notify } from '../lib/db.js';
import { config } from '../config.js';
import * as photolib from '../services/photolib.js';
import * as storage from '../services/storage.js';
import { markFileCatalogStale } from '../services/file-catalog.js';
import * as writes from '../services/storage-write.js';
import * as albums from '../services/photo-albums.js';
import * as albumShares from '../services/photo-album-shares.js';
import { assertFileAllowed } from '../services/policy.js';
import {
  boundedDiskStorage, claimUploadIngress, releaseIngress, reserveUploadIngress, withUploadIngressCleanup,
} from '../services/upload-ingress.js';
import sharp from 'sharp';

const r = Router();
const uploadTmp = path.join(config.filesRoot, '.photo-uploads-tmp');
fs.mkdirSync(uploadTmp, { recursive: true });
const upload = multer({ storage: boundedDiskStorage(uploadTmp), limits: {
  files: 50, fields: 60, parts: 111, fieldNameSize: 100, fieldSize: 1024,
} });

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
    try { await fsp.access(await storage.resolveAsync(username, rel)); rel = path.posix.join(dir, `${stem} (${n++})${ext}`); }
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

r.get('/native/favorites', (req: AuthedRequest, res, next) => {
  try { res.json({ items: albums.favorites(u(req).id, Number(req.query.limit) || undefined) }); }
  catch (e) { next(e); }
});

r.post('/native/favorite', (req: AuthedRequest, res, next) => {
  try {
    const result = albums.setFavorite(u(req).id, photolib.assertPhotoPath(req.body?.path), req.body?.favorite === true);
    audit(u(req).id, u(req).username, result.favorite ? 'photo_favorited' : 'photo_unfavorited', result.path, req.ip);
    res.json(result);
  } catch (e) { next(e); }
});

r.get('/native/albums', (req: AuthedRequest, res, next) => {
  try { res.json({ items: albums.listAlbums(u(req).id) }); } catch (e) { next(e); }
});

// Authenticated household album sharing is intentionally separate from public
// file links. Recipients can only read photos that remain in the granted album.
r.get('/native/albums/shared', (req: AuthedRequest, res, next) => {
  try {
    res.setHeader('Cache-Control', 'no-store');
    res.json({ items: albumShares.listSharedAlbums(u(req).id) });
  } catch (e) { next(e); }
});

r.get('/native/albums/shared/:shareId/items', (req: AuthedRequest, res, next) => {
  try {
    const access = albumShares.sharedAlbumAccess(u(req).id, req.params.shareId);
    const items = albumShares.sharedAlbumItems(access);
    audit(u(req).id, u(req).username, 'photo_album_share_viewed', access.album.id, req.ip, {
      shareId: access.share.id, ownerUserId: access.owner.id, itemCount: items.length,
    });
    res.setHeader('Cache-Control', 'no-store');
    res.json({ items });
  } catch (e) { next(e); }
});

r.get('/native/albums/shared/:shareId/thumb', async (req: AuthedRequest, res, next) => {
  try {
    const access = albumShares.sharedAlbumAccess(u(req).id, req.params.shareId);
    const relPath = albumShares.assertSharedAlbumPhoto(access, req.query.path);
    const file = await photolib.thumb(access.owner, relPath);
    res.setHeader('Content-Type', 'image/webp');
    res.setHeader('Cache-Control', 'private, no-store');
    res.sendFile(file);
  } catch (e) { next(e); }
});

r.get('/native/albums/shared/:shareId/file', async (req: AuthedRequest, res, next) => {
  try {
    const access = albumShares.sharedAlbumAccess(u(req).id, req.params.shareId);
    const relPath = albumShares.assertSharedAlbumPhoto(access, req.query.path);
    const { real, stat } = await storage.statRealAsync(access.owner.username, relPath);
    if (!stat.isFile()) return res.status(404).json({ error: 'not_found' });
    res.setHeader('Content-Type', mime.lookup(relPath) || 'application/octet-stream');
    res.setHeader('Cache-Control', 'private, no-store');
    res.sendFile(real);
  } catch (e) { next(e); }
});

r.post('/native/albums', (req: AuthedRequest, res, next) => {
  try {
    const album = albums.createAlbum(u(req).id, req.body || {});
    audit(u(req).id, u(req).username, 'photo_album_created', album.id, req.ip, { name: album.name });
    res.status(201).json(album);
  } catch (e) { next(e); }
});

r.patch('/native/albums/:id', (req: AuthedRequest, res, next) => {
  try {
    const album = albums.updateAlbum(u(req).id, String(req.params.id), req.body || {});
    audit(u(req).id, u(req).username, 'photo_album_updated', album.id, req.ip);
    res.json(album);
  } catch (e) { next(e); }
});

r.delete('/native/albums/:id', (req: AuthedRequest, res, next) => {
  try {
    const id = String(req.params.id);
    if (!albums.deleteAlbum(u(req).id, id)) return res.status(404).json({ error: 'album_not_found' });
    audit(u(req).id, u(req).username, 'photo_album_deleted', id, req.ip);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

r.get('/native/albums/:id/shares', (req: AuthedRequest, res, next) => {
  try {
    res.setHeader('Cache-Control', 'no-store');
    res.json({ items: albumShares.listOwnedAlbumShares(u(req).id, req.params.id) });
  } catch (e) { next(e); }
});

r.post('/native/albums/:id/shares', (req: AuthedRequest, res, next) => {
  try {
    if (req.body?.permission !== undefined && req.body.permission !== 'viewer') {
      return res.status(400).json({ error: 'photo_album_shares_are_view_only' });
    }
    const share = albumShares.createAlbumShare(u(req), req.params.id, req.body?.recipientId);
    const album = db.prepare('SELECT name FROM photo_albums WHERE id=? AND user_id=?')
      .get(share.albumId, u(req).id) as any;
    audit(u(req).id, u(req).username, 'photo_album_share_created', share.albumId, req.ip, {
      shareId: share.id, recipientUserId: share.recipient.id, permission: 'viewer',
    });
    notify(share.recipient.id, `${u(req).displayName} shared “${String(album?.name || 'Photo album')}”`,
      'You can privately view this album. Only the owner can change it.', 'info', `/photos?tab=albums&shared=${share.id}`);
    res.status(201).json(share);
  } catch (e) { next(e); }
});

r.delete('/native/albums/:id/shares/:shareId', (req: AuthedRequest, res, next) => {
  try {
    const revoked = albumShares.revokeAlbumShare(u(req).id, req.params.id, req.params.shareId);
    audit(u(req).id, u(req).username, 'photo_album_share_revoked', revoked.albumId, req.ip, {
      shareId: revoked.id, recipientUserId: revoked.recipientUserId,
    });
    notify(revoked.recipientUserId, `Access to “${revoked.albumName}” was removed`,
      'The album owner revoked this private photo share.', 'info', '/photos?tab=albums');
    res.json({ ok: true });
  } catch (e) { next(e); }
});

r.get('/native/albums/:id/items', (req: AuthedRequest, res, next) => {
  try { res.json({ items: albums.albumItems(u(req).id, String(req.params.id)) }); }
  catch (e) { next(e); }
});

r.post('/native/albums/:id/items', (req: AuthedRequest, res, next) => {
  try {
    const id = String(req.params.id);
    const result = albums.addAlbumItems(u(req).id, id, req.body?.paths);
    audit(u(req).id, u(req).username, 'photo_album_items_added', id, req.ip, result);
    res.json(result);
  } catch (e) { next(e); }
});

r.delete('/native/albums/:id/items', (req: AuthedRequest, res, next) => {
  try {
    const id = String(req.params.id);
    const result = albums.removeAlbumItems(u(req).id, id, req.body?.paths);
    audit(u(req).id, u(req).username, 'photo_album_items_removed', id, req.ip, result);
    res.json(result);
  } catch (e) { next(e); }
});

r.post('/native/upload', reserveUploadIngress, withUploadIngressCleanup(upload.array('files', 50)), async (req: AuthedRequest, res, next) => {
  const files = ((req as any).files as any[]) || [];
  let failure: unknown;
  try {
    const reservation = claimUploadIngress(req);
    const lastModified: string[] = [].concat(req.body?.lastModified || []);
    if (!files.length) return res.status(400).json({ error: 'missing_file' });
    for (const f of files) {
      photolib.assertPhotoPath(`Photos/_/${f.originalname}`);
      assertFileAllowed(f.originalname, f.size);
      const metadata = await sharp(f.path, { failOn: 'error', limitInputPixels: 200_000_000 }).metadata()
        .catch(() => { throw Object.assign(new Error('invalid_image'), { status: 415 }); });
      if (!metadata.format || !metadata.width || !metadata.height) throw Object.assign(new Error('invalid_image'), { status: 415 });
    }
    const created = [];
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      const dir = photoDateDir(Number(lastModified[i]));
      const rel = await uniquePhotoPath(u(req).username, dir, f.originalname);
      const lm = Number(lastModified[i]);
      await writes.commitTempFile({ user: u(req), virtualPath: rel, tempPath: f.path,
        reservation, releaseReservation: false, createVersion: false,
        mtimeMs: Number.isFinite(lm) && lm > 0 ? lm : undefined });
      const item = await photolib.indexFile(u(req), rel);
      if (item) created.push(item);
    }
    res.json({ items: created });
  } catch (e) {
    failure = e;
  } finally {
    await Promise.all(files.map(f => fsp.rm(f.path, { force: true }).catch(() => {})));
    releaseIngress(req);
  }
  if (failure) next(failure);
});

r.get('/native/thumb', async (req: AuthedRequest, res, next) => {
  try {
    const file = await photolib.thumb(u(req), req.query.path as string);
    res.setHeader('Content-Type', 'image/webp');
    res.setHeader('Cache-Control', 'private, max-age=86400');
    res.sendFile(file);
  } catch (e) { next(e); }
});

r.get('/native/file', async (req: AuthedRequest, res, next) => {
  try {
    const rel = photolib.assertPhotoPath(req.query.path as string);
    const { real, stat } = await storage.statRealAsync(u(req).username, rel);
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
    markFileCatalogStale(u(req).id);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

export default r;
