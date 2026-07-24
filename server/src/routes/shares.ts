// Capability-based public sharing. Passwords are submitted once via POST and
// exchanged for a short-lived HttpOnly share session; secrets never enter URLs.
import { Router } from 'express';
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import multer from 'multer';
import { authMiddleware, csrfProtection, requireFeature, rowToUser, type AuthedRequest } from '../lib/auth.js';
import { db, audit, notify } from '../lib/db.js';
import { config } from '../config.js';
import * as storage from '../services/storage.js';
import { assertFileAllowed, assertPublicSharingEnabled } from '../services/policy.js';
import { validateFileName, validateVirtualPath } from '../lib/validation.js';
import * as accountShares from '../services/account-shares.js';
import * as writes from '../services/storage-write.js';
import { cachedWebp, imageWidth } from '../services/image-cache.js';
import { markFileCatalogStale } from '../services/file-catalog.js';
import {
  boundedDiskStorage, claimUploadIngress, releaseIngress, reserveUploadIngress, withUploadIngressCleanup,
} from '../services/upload-ingress.js';

const r = Router();
const SHARE_COOKIE = 'aerie_share';
const attempts = new Map<string, { count: number; resetAt: number }>();
const accountUploadTmp = path.join(config.filesRoot, '.uploads-tmp');
fs.mkdirSync(accountUploadTmp, { recursive: true });
const accountUpload = multer({ storage: boundedDiskStorage(accountUploadTmp), limits: {
  files: 100, fields: 200, parts: 301, fieldNameSize: 100, fieldSize: 16 * 1024,
} });

function mapShare(s: any) {
  return {
    id: s.id, path: s.path, name: s.name, type: s.type, permission: s.permission,
    allowDownload: !!s.allow_download, hasPassword: !!s.password_hash, expiresAt: s.expires_at,
    url: s.type === 'link' ? `/s/${s.id}` : null, sharedWith: s.shared_with, createdAt: s.created_at,
  };
}

function publicShare(id: unknown): any | null {
  const token = String(id || '');
  if (!/^sh_[A-Za-z0-9_-]{32}$/.test(token)) return null;
  return db.prepare("SELECT * FROM shares WHERE id=? AND type='link'").get(token) as any || null;
}

function assertAvailable(share: any): void {
  assertPublicSharingEnabled();
  if (!share) throw Object.assign(new Error('not_found'), { status: 404 });
  if (share.expires_at && Date.parse(share.expires_at) <= Date.now()) {
    throw Object.assign(new Error('expired'), { status: 410 });
  }
}

function sendError(res: any, error: any) {
  const status = Number(error?.status) || 404;
  // A globally-disabled sharing feature should not disclose existing links.
  res.status(error?.message === 'public_sharing_disabled' ? 404 : status).json({ error: error?.message || 'not_found' });
}

function requestIp(req: any): string {
  return String(req.ip || req.socket?.remoteAddress || '').slice(0, 80);
}

function checkUnlockRate(req: any, shareId: string): void {
  const now = Date.now();
  const key = `${requestIp(req)}:${shareId}`;
  const item = attempts.get(key);
  if (!item || item.resetAt <= now) {
    attempts.set(key, { count: 1, resetAt: now + 15 * 60_000 });
    return;
  }
  item.count++;
  if (item.count > 10) throw Object.assign(new Error('too_many_attempts'), { status: 429 });
}

function shareSession(req: any, share: any): boolean {
  if (!share.password_hash) return true;
  const token = req.cookies?.[SHARE_COOKIE];
  if (!token) return false;
  try {
    const payload = jwt.verify(token, config.jwtSecret, { audience: 'aerie-share' }) as any;
    return payload?.kind === 'share' && payload?.shareId === share.id;
  } catch { return false; }
}

function setShareSession(req: any, res: any, share: any) {
  const expiresAt = share.expires_at ? Date.parse(share.expires_at) : Number.POSITIVE_INFINITY;
  const maxAge = Math.max(60_000, Math.min(12 * 3600_000, expiresAt - Date.now()));
  const token = jwt.sign({ kind: 'share', shareId: share.id }, config.jwtSecret,
    { audience: 'aerie-share', expiresIn: Math.max(60, Math.floor(maxAge / 1000)) });
  const secure = !!req.secure;
  res.cookie(SHARE_COOKIE, token, { httpOnly: true, secure, sameSite: 'lax', maxAge,
    path: `/api/shares/public/${share.id}` });
}

function ownerFor(share: any): any {
  const owner = db.prepare('SELECT id,username FROM users WHERE id=? AND disabled_at IS NULL').get(share.user_id) as any;
  if (!owner) throw Object.assign(new Error('not_found'), { status: 404 });
  return owner;
}

async function shareStat(share: any) {
  const owner = ownerFor(share);
  const { stat } = await storage.statRealAsync(owner.username, share.path);
  return { owner, stat };
}

function selectedPath(share: any, requested: unknown): string {
  const base = path.posix.normalize('/' + String(share.path || '').replace(/^\/+/, ''));
  if (!requested) return base;
  const relative = String(requested).replace(/^\/+/, '');
  const selected = path.posix.normalize(path.posix.join(base, relative));
  if (selected !== base && !selected.startsWith(base.endsWith('/') ? base : base + '/')) {
    throw Object.assign(new Error('bad_path'), { status: 400 });
  }
  return selected;
}

async function publicInfo(share: any) {
  const { stat } = await shareStat(share);
  return {
    id: share.id, name: share.name, hasPassword: !!share.password_hash,
    permission: 'view', allowDownload: !!share.allow_download,
    isFolder: stat.isDirectory(), sizeBytes: stat.isFile() ? stat.size : null,
    expiresAt: share.expires_at,
  };
}

// Public metadata deliberately contains no owner/path information.
r.get('/public/:id', async (req, res) => {
  try {
    const share = publicShare(req.params.id);
    assertAvailable(share);
    res.setHeader('Cache-Control', 'no-store');
    res.json(await publicInfo(share));
  } catch (error) { sendError(res, error); }
});

// Password unlock. Successful authentication becomes a path-scoped HttpOnly
// cookie, so subsequent media/download requests contain no password.
r.post('/public/:id/open', async (req, res) => {
  try {
    const share = publicShare(req.params.id);
    assertAvailable(share);
    checkUnlockRate(req, share.id);
    if (share.password_hash && !(await bcrypt.compare(String(req.body?.password || ''), share.password_hash))) {
      audit(share.user_id, 'public', 'share_unlock_failure', share.id, requestIp(req));
      return res.status(403).json({ error: 'wrong_password' });
    }
    attempts.delete(`${requestIp(req)}:${share.id}`);
    setShareSession(req, res, share);
    audit(share.user_id, 'public', 'share_unlocked', share.id, requestIp(req));
    res.setHeader('Cache-Control', 'no-store');
    res.json({ ok: true, ...(await publicInfo(share)) });
  } catch (error) { sendError(res, error); }
});

r.get('/public/:id/list', async (req, res) => {
  try {
    const share = publicShare(req.params.id);
    assertAvailable(share);
    if (!shareSession(req, share)) return res.status(401).json({ error: 'share_locked' });
    const { owner, stat } = await shareStat(share);
    if (!stat.isDirectory()) return res.status(400).json({ error: 'not_a_folder' });
    const selected = selectedPath(share, req.query.path);
    const listing = await storage.listAsync(owner.username, owner.id, selected, {});
    const base = path.posix.normalize('/' + String(share.path).replace(/^\/+/, ''));
    res.setHeader('Cache-Control', 'no-store');
    res.json({
      path: selected === base ? '' : path.posix.relative(base, selected),
      entries: listing.entries.map(entry => ({
        name: entry.name, path: path.posix.relative(base, entry.path), isFolder: entry.isFolder,
        size: entry.size, modifiedAt: entry.modifiedAt, kind: entry.kind,
      })),
    });
  } catch (error) { sendError(res, error); }
});

// Public file response. For folder shares, `path` is constrained under the
// shared root. Passwords are never accepted in the query string.
r.get('/public/:id/download', async (req, res) => {
  try {
    const share = publicShare(req.params.id);
    assertAvailable(share);
    if (!shareSession(req, share)) return res.status(401).json({ error: 'share_locked' });
    if (share.allow_download === 0) return res.status(403).json({ error: 'download_disabled' });
    const owner = ownerFor(share);
    const selected = selectedPath(share, req.query.path);
    const { real, stat } = await storage.statRealAsync(owner.username, selected);
    if (!stat.isFile()) return res.status(400).json({ error: 'is_folder' });
    audit(share.user_id, 'public', 'share_downloaded', share.id, requestIp(req), { path: selected });
    res.setHeader('Cache-Control', 'private, no-store');
    res.download(real, path.posix.basename(selected));
  } catch (error) { sendError(res, error); }
});

// Authenticated owner routes.
r.use(authMiddleware);
r.use(csrfProtection);
r.use(requireFeature('files'));

r.get('/', (req: AuthedRequest, res) => {
  const rows = db.prepare("SELECT * FROM shares WHERE user_id=? AND type='link' ORDER BY created_at DESC")
    .all(req.user!.id) as any[];
  res.json(rows.map(mapShare));
});

r.post('/', async (req: AuthedRequest, res) => {
  try {
    assertPublicSharingEnabled();
    const { path: requestedPath, type, permission, allowDownload, password, expiresAt } = req.body || {};
    if (type && type !== 'link') return res.status(400).json({ error: 'recipient_sharing_not_available' });
    if (permission && permission !== 'view') return res.status(400).json({ error: 'public_edit_not_supported' });
    const cleanPath = path.posix.normalize('/' + String(requestedPath || '').replace(/^\/+/, ''));
    if (!requestedPath || cleanPath === '/') return res.status(400).json({ error: 'path_required' });
    const { stat } = await storage.statRealAsync(req.user!.username, cleanPath);
    const active = (db.prepare(`SELECT COUNT(*) count FROM shares WHERE user_id=?
      AND (expires_at IS NULL OR datetime(expires_at)>datetime('now'))`).get(req.user!.id) as any).count;
    if (active >= 1000) return res.status(409).json({ error: 'share_limit_reached' });
    let expiry: string | null = null;
    if (expiresAt) {
      const ms = Date.parse(String(expiresAt));
      if (!Number.isFinite(ms) || ms <= Date.now() || ms > Date.now() + 366 * 86400_000) {
        return res.status(400).json({ error: 'invalid_expiry' });
      }
      expiry = new Date(ms).toISOString();
    }
    const sharePassword = password ? String(password) : '';
    if (sharePassword && (sharePassword.length < 8 || sharePassword.length > 256)) {
      return res.status(400).json({ error: 'share_password_length' });
    }
    const id = 'sh_' + crypto.randomBytes(24).toString('base64url');
    db.prepare(`INSERT INTO shares (id,user_id,path,name,type,permission,allow_download,password_hash,shared_with,expires_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
      id, req.user!.id, cleanPath, path.posix.basename(cleanPath), 'link', 'view',
      allowDownload === false ? 0 : 1, sharePassword ? await bcrypt.hash(sharePassword, 12) : null,
      null, expiry);
    audit(req.user!.id, req.user!.username, 'share_created', cleanPath, requestIp(req),
      { id, folder: stat.isDirectory(), passwordProtected: !!sharePassword, expiresAt: expiry });
    const share = db.prepare('SELECT * FROM shares WHERE id=?').get(id);
    res.status(201).json(mapShare(share));
  } catch (error: any) { res.status(error?.status || 400).json({ error: error?.message || 'share_failed' }); }
});

// ---------------------------------------------------------------------------
// Household Shared Spaces. These authenticated recipient grants do not reuse
// public-link ids, rows, cookies, or authorization rules.
// ---------------------------------------------------------------------------

function accountAccess(req: AuthedRequest, editor = false): accountShares.AccountShareAccess {
  return accountShares.accountShareAccess(req.user!, req.params.id, { editor });
}

function ownerWriteUser(access: accountShares.AccountShareAccess) {
  // Quota/storage ownership remains with the owner, while file versions show
  // the household member who actually made the change.
  return { ...access.owner, displayName: access.actor.displayName };
}

function ownerGrant(req: AuthedRequest): accountShares.AccountShareGrant {
  const id = accountShares.validateAccountShareId(req.params.id);
  const row = db.prepare(`SELECT * FROM account_shares
    WHERE id=? AND owner_user_id=? AND revoked_at IS NULL`).get(id, req.user!.id) as any;
  if (!row) throw Object.assign(new Error('not_found'), { status: 404 });
  return accountShares.rowToAccountShare(row);
}

function accountAudit(req: AuthedRequest, access: accountShares.AccountShareAccess,
  action: string, ownerPath: string, meta: Record<string, unknown> = {}) {
  audit(req.user!.id, req.user!.username, action, ownerPath, requestIp(req), {
    shareId: access.grant.id, ownerUserId: access.owner.id, ...meta,
  });
}

function selectedSharedPaths(value: unknown): string[] {
  if (!Array.isArray(value) || !value.length || value.length > 1000) {
    throw Object.assign(new Error('invalid_paths'), { status: 400 });
  }
  const unique = [...new Set(value.map(item =>
    accountShares.normalizeShareRelativePath(item, { allowRoot: false })))]
    .sort((a, b) => a.length - b.length);
  return unique.filter((item, index) => !unique.slice(0, index).some(parent => item.startsWith(parent + '/')));
}

async function reserveAccountUpload(req: AuthedRequest, res: any, next: any) {
  let access: accountShares.AccountShareAccess;
  try {
    access = accountAccess(req, true);
    (req as any).accountShareAccess = access;
  } catch (error) { return next(error); }
  const actor = req.user;
  // The generic ingress layer reserves against req.user before reading a byte.
  // Temporarily supply the storage owner, then restore the authenticated actor
  // before Multer or the route sees the request.
  req.user = access.owner;
  await reserveUploadIngress(req, res, (error?: unknown) => {
    req.user = actor;
    next(error);
  });
}

r.get('/account/received', async (req: AuthedRequest, res, next) => {
  try {
    res.setHeader('Cache-Control', 'no-store');
    res.json(await accountShares.receivedAccountShares(req.user!));
  } catch (error) { next(error); }
});

r.get('/account/owned', async (req: AuthedRequest, res, next) => {
  try {
    res.setHeader('Cache-Control', 'no-store');
    res.json(await accountShares.ownedAccountShares(req.user!));
  } catch (error) { next(error); }
});

r.post('/account', async (req: AuthedRequest, res, next) => {
  try {
    const owner = req.user!;
    const rootPath = validateVirtualPath(req.body?.path);
    const recipientId = Number(req.body?.recipientId);
    if (!Number.isSafeInteger(recipientId) || recipientId <= 0) {
      return res.status(400).json({ error: 'invalid_recipient' });
    }
    if (recipientId === owner.id) return res.status(400).json({ error: 'cannot_share_with_self' });
    const permission = String(req.body?.permission || 'viewer');
    if (permission !== 'viewer' && permission !== 'editor') {
      return res.status(400).json({ error: 'invalid_permission' });
    }
    const recipientRow = db.prepare('SELECT * FROM users WHERE id=? AND disabled_at IS NULL').get(recipientId) as any;
    if (!recipientRow) return res.status(404).json({ error: 'recipient_not_found' });
    const recipient = rowToUser(recipientRow);
    if (recipient.features?.files === false) return res.status(409).json({ error: 'recipient_files_disabled' });
    const { stat } = await storage.statRealAsync(owner.username, rootPath);
    if (!stat.isFile() && !stat.isDirectory()) return res.status(400).json({ error: 'unsupported_file_type' });
    const count = Number((db.prepare(`SELECT COUNT(*) count FROM account_shares
      WHERE owner_user_id=? AND revoked_at IS NULL`).get(owner.id) as any)?.count || 0);
    if (count >= 5000) return res.status(409).json({ error: 'account_share_limit_reached' });

    const id = `as_${crypto.randomBytes(24).toString('base64url')}`;
    try {
      db.prepare(`INSERT INTO account_shares
        (id,owner_user_id,recipient_user_id,root_path,permission,created_by_user_id)
        VALUES (?,?,?,?,?,?)`).run(id, owner.id, recipient.id, rootPath, permission, owner.id);
    } catch (error: any) {
      if (String(error?.code || '').startsWith('SQLITE_CONSTRAINT')) {
        return res.status(409).json({ error: 'already_shared_with_recipient' });
      }
      throw error;
    }
    audit(owner.id, owner.username, 'account_share_created', rootPath, requestIp(req), {
      shareId: id, recipientUserId: recipient.id, permission, folder: stat.isDirectory(),
    });
    notify(recipient.id, `${owner.displayName} shared “${path.posix.basename(rootPath)}”`,
      permission === 'editor' ? 'You can view and edit this shared space.' : 'You can view this shared space.',
      'info', '/files?tab=shared');
    res.status(201).json({
      id, name: path.posix.basename(rootPath), rootPath, permission,
      isFolder: stat.isDirectory(), sizeBytes: stat.isFile() ? stat.size : null,
      available: true, recipient: {
        id: recipient.id, username: recipient.username, displayName: recipient.displayName,
        avatarColor: recipient.avatarColor, active: true,
      }, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });
  } catch (error) { next(error); }
});

r.patch('/account/:id', (req: AuthedRequest, res, next) => {
  try {
    const grant = ownerGrant(req);
    const permission = String(req.body?.permission || '');
    if (permission !== 'viewer' && permission !== 'editor') {
      return res.status(400).json({ error: 'invalid_permission' });
    }
    db.prepare(`UPDATE account_shares SET permission=?,updated_at=datetime('now')
      WHERE id=? AND owner_user_id=? AND revoked_at IS NULL`).run(permission, grant.id, req.user!.id);
    audit(req.user!.id, req.user!.username, 'account_share_permission_changed', grant.rootPath, requestIp(req), {
      shareId: grant.id, recipientUserId: grant.recipientUserId, from: grant.permission, to: permission,
    });
    notify(grant.recipientUserId, `Access to “${path.posix.basename(grant.rootPath)}” changed`,
      permission === 'editor' ? 'You can now edit this shared space.' : 'This shared space is now view-only.',
      'info', '/files?tab=shared');
    res.json({ ok: true, permission });
  } catch (error) { next(error); }
});

r.delete('/account/:id', (req: AuthedRequest, res, next) => {
  try {
    const grant = ownerGrant(req);
    db.prepare(`UPDATE account_shares SET revoked_at=datetime('now'),updated_at=datetime('now')
      WHERE id=? AND owner_user_id=? AND revoked_at IS NULL`).run(grant.id, req.user!.id);
    audit(req.user!.id, req.user!.username, 'account_share_revoked', grant.rootPath, requestIp(req), {
      shareId: grant.id, recipientUserId: grant.recipientUserId, permission: grant.permission,
    });
    notify(grant.recipientUserId, `Access to “${path.posix.basename(grant.rootPath)}” was removed`,
      'The owner revoked this household share.', 'info', '/files?tab=shared');
    res.json({ ok: true });
  } catch (error) { next(error); }
});

r.delete('/account/:id/leave', (req: AuthedRequest, res, next) => {
  try {
    const access = accountAccess(req);
    db.prepare(`UPDATE account_shares SET revoked_at=datetime('now'),updated_at=datetime('now')
      WHERE id=? AND recipient_user_id=? AND revoked_at IS NULL`).run(access.grant.id, req.user!.id);
    accountAudit(req, access, 'account_share_left', access.grant.rootPath);
    notify(access.owner.id, `${req.user!.displayName} left “${path.posix.basename(access.grant.rootPath)}”`,
      'Their household access was removed.', 'info', '/files?tab=shared');
    res.json({ ok: true });
  } catch (error) { next(error); }
});

r.get('/account/:id/list', async (req: AuthedRequest, res, next) => {
  try {
    const access = accountAccess(req);
    const listing = await accountShares.listSharedFolder(access, req.query.path,
      String(req.query.sort || 'name'), req.query.dir === 'desc' ? 'desc' : 'asc');
    res.setHeader('Cache-Control', 'no-store');
    res.json(listing);
  } catch (error) { next(error); }
});

r.get('/account/:id/raw', async (req: AuthedRequest, res, next) => {
  try {
    const access = accountAccess(req);
    const { ownerPath, relativePath } = accountShares.ownerPathForGrant(access.grant, req.query.path);
    const { real, stat } = await storage.statRealAsync(access.owner.username, ownerPath);
    if (!stat.isFile()) return res.status(400).json({ error: 'is_folder' });
    res.setHeader('Cache-Control', 'private, no-store');
    if (req.query.download) {
      accountAudit(req, access, 'shared_file_downloaded', ownerPath, { relativePath });
      return res.download(real, path.posix.basename(ownerPath));
    }
    res.sendFile(real);
  } catch (error) { next(error); }
});

r.get('/account/:id/thumb', async (req: AuthedRequest, res) => {
  try {
    const access = accountAccess(req);
    const { ownerPath } = accountShares.ownerPathForGrant(access.grant, req.query.path);
    const { real, stat } = await storage.statRealAsync(access.owner.username, ownerPath);
    if (!stat.isFile() || storage.kindOf(path.posix.basename(ownerPath), false) !== 'image') return res.status(204).end();
    const width = imageWidth(req.query.w, 480, 960);
    const cached = await cachedWebp({
      namespace: 'account-shares', key: `${access.grant.id}:${ownerPath}`, source: real,
      sourceMtimeMs: stat.mtimeMs, width, quality: 78,
    });
    res.setHeader('Content-Type', 'image/webp');
    res.setHeader('Cache-Control', 'private, no-store');
    res.sendFile(cached.file);
  } catch { res.status(204).end(); }
});

r.get('/account/:id/content', async (req: AuthedRequest, res, next) => {
  try {
    const access = accountAccess(req);
    const { ownerPath, relativePath } = accountShares.ownerPathForGrant(access.grant, req.query.path);
    const { real, stat } = await storage.statRealAsync(access.owner.username, ownerPath);
    if (!stat.isFile()) return res.status(400).json({ error: 'is_folder' });
    if (stat.size > 32 * 1024 * 1024) return res.status(413).json({ error: 'file_too_large_for_editor' });
    const revision = writes.revisionFor(stat);
    res.setHeader('ETag', revision);
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({ path: relativePath, content: await fsp.readFile(real, 'utf8'), revision,
      modifiedAt: stat.mtime.toISOString(), permission: access.grant.permission });
  } catch (error) { next(error); }
});

r.post('/account/:id/content', async (req: AuthedRequest, res, next) => {
  try {
    const access = accountAccess(req, true);
    const { ownerPath, relativePath } = accountShares.ownerPathForGrant(access.grant, req.body?.path);
    const content = req.body?.content;
    if (typeof content !== 'string') return res.status(400).json({ error: 'content_required' });
    if (Buffer.byteLength(content) > 32 * 1024 * 1024) return res.status(413).json({ error: 'content_too_large' });
    const current = await storage.statRealAsync(access.owner.username, ownerPath);
    if (!current.stat.isFile()) return res.status(400).json({ error: 'is_folder' });
    const expectedRevision = String(req.get('if-match') || req.body?.revision || '') || undefined;
    const result = await writes.writeFileAtomic({ user: ownerWriteUser(access), virtualPath: ownerPath,
      data: content, expectedRevision, versionNote: `Shared edit by ${access.actor.displayName}` });
    accountAudit(req, access, 'shared_file_saved', ownerPath, { relativePath, revision: result.revision });
    res.setHeader('ETag', result.revision);
    res.json({ ok: true, revision: result.revision, versionId: result.versionId });
  } catch (error) { next(error); }
});

r.post('/account/:id/create', async (req: AuthedRequest, res, next) => {
  try {
    const access = accountAccess(req, true);
    const parent = accountShares.normalizeShareRelativePath(req.body?.path);
    const name = validateFileName(req.body?.name);
    const parentTarget = accountShares.ownerPathForGrant(access.grant, parent).ownerPath;
    if (!(await fsp.stat(await storage.resolveAsync(access.owner.username, parentTarget))).isDirectory()) {
      return res.status(400).json({ error: 'destination_not_folder' });
    }
    const relativePath = parent ? path.posix.join(parent, name) : name;
    const { ownerPath } = accountShares.ownerPathForGrant(access.grant, relativePath, { allowRoot: false });
    const data = typeof req.body?.content === 'string' ? req.body.content : '';
    if (Buffer.byteLength(data) > 32 * 1024 * 1024) return res.status(413).json({ error: 'content_too_large' });
    const result = await writes.writeFileAtomic({ user: ownerWriteUser(access), virtualPath: ownerPath,
      data, expectedRevision: '*', createVersion: false });
    accountAudit(req, access, 'shared_file_created', ownerPath, { relativePath });
    res.status(201).json({ ok: true, path: relativePath, revision: result.revision });
  } catch (error) { next(error); }
});

r.post('/account/:id/mkdir', async (req: AuthedRequest, res, next) => {
  try {
    const access = accountAccess(req, true);
    const parent = accountShares.normalizeShareRelativePath(req.body?.path);
    const name = validateFileName(req.body?.name);
    const relativePath = parent ? path.posix.join(parent, name) : name;
    const { ownerPath } = accountShares.ownerPathForGrant(access.grant, relativePath, { allowRoot: false });
    await fsp.mkdir(await storage.resolveAsync(access.owner.username, ownerPath));
    markFileCatalogStale(access.owner.id);
    accountAudit(req, access, 'shared_folder_created', ownerPath, { relativePath });
    res.status(201).json({ ok: true, path: relativePath });
  } catch (error) { next(error); }
});

r.post('/account/:id/rename', async (req: AuthedRequest, res, next) => {
  try {
    const access = accountAccess(req, true);
    const { ownerPath, relativePath } = accountShares.ownerPathForGrant(access.grant, req.body?.path,
      { allowRoot: false });
    const newName = validateFileName(req.body?.newName);
    const relativeDestination = path.posix.join(path.posix.dirname(relativePath), newName).replace(/^\.\//, '');
    const { ownerPath: destination } = accountShares.ownerPathForGrant(access.grant, relativeDestination,
      { allowRoot: false });
    await writes.movePathAtomic({ user: ownerWriteUser(access), from: ownerPath, to: destination });
    accountAudit(req, access, 'shared_item_renamed', ownerPath, {
      relativePath, destination, relativeDestination,
    });
    res.json({ ok: true, path: relativeDestination });
  } catch (error) { next(error); }
});

r.post('/account/:id/delete', async (req: AuthedRequest, res, next) => {
  try {
    const access = accountAccess(req, true);
    const relativePaths = selectedSharedPaths(req.body?.paths);
    for (const relativePath of relativePaths) {
      const { ownerPath } = accountShares.ownerPathForGrant(access.grant, relativePath, { allowRoot: false });
      await storage.trash(access.owner.username, access.owner.id, ownerPath);
      accountAudit(req, access, 'shared_item_deleted', ownerPath, { relativePath });
    }
    markFileCatalogStale(access.owner.id);
    res.json({ ok: true, deleted: relativePaths.length });
  } catch (error) { next(error); }
});

r.post('/account/:id/upload', reserveAccountUpload,
  withUploadIngressCleanup(accountUpload.array('files')), async (req: AuthedRequest, res, next) => {
    const files = ((req as any).files as any[]) || [];
    let failure: unknown;
    try {
      const access = (req as any).accountShareAccess as accountShares.AccountShareAccess;
      const reservation = claimUploadIngress(req);
      const parent = accountShares.normalizeShareRelativePath(req.body?.path);
      const parentTarget = accountShares.ownerPathForGrant(access.grant, parent).ownerPath;
      if (!(await fsp.stat(await storage.resolveAsync(access.owner.username, parentTarget))).isDirectory()) {
        return res.status(400).json({ error: 'destination_not_folder' });
      }
      if (!files.length) return res.status(400).json({ error: 'missing_file' });
      const relPaths: string[] = ([] as string[]).concat(req.body?.relativePaths || []);
      const saved: string[] = [];
      for (let index = 0; index < files.length; index++) {
        const file = files[index];
        assertFileAllowed(file.originalname, file.size);
        const rawRelative = String(relPaths[index] || file.originalname).replace(/\\/g, '/');
        const segments = rawRelative.split('/');
        if (!segments.length || segments.some(segment => !segment || segment === '.' || segment === '..')) {
          throw Object.assign(new Error('invalid_path'), { status: 400 });
        }
        const safeRelative = segments.map(segment => validateFileName(segment)).join('/');
        const relativePath = parent ? path.posix.join(parent, safeRelative) : safeRelative;
        const { ownerPath } = accountShares.ownerPathForGrant(access.grant, relativePath, { allowRoot: false });
        await writes.commitTempFile({ user: ownerWriteUser(access), virtualPath: ownerPath,
          tempPath: file.path, reservation, releaseReservation: false,
          versionNote: `Shared upload by ${access.actor.displayName}` });
        saved.push(relativePath);
      }
      accountAudit(req, access, 'shared_upload', access.grant.rootPath, { count: saved.length, saved });
      res.json({ ok: true, saved });
    } catch (error) { failure = error; }
    finally {
      await Promise.all(files.map(file => fsp.rm(file.path, { force: true }).catch(() => {})));
      releaseIngress(req);
    }
    if (failure) next(failure);
  });

r.get('/account/:id/versions', (req: AuthedRequest, res, next) => {
  try {
    const access = accountAccess(req);
    const { ownerPath } = accountShares.ownerPathForGrant(access.grant, req.query.path);
    const rows = db.prepare(`SELECT id,created_at,author,note,size_bytes FROM versions
      WHERE user_id=? AND path=? ORDER BY created_at DESC,id DESC LIMIT 100`).all(access.owner.id, ownerPath) as any[];
    res.setHeader('Cache-Control', 'no-store');
    res.json(rows.map(version => ({ id: version.id, createdAt: version.created_at, author: version.author,
      note: version.note, sizeBytes: version.size_bytes })));
  } catch (error) { next(error); }
});

r.post('/account/:id/versions/restore', async (req: AuthedRequest, res, next) => {
  let temp = '';
  let reservation: writes.StorageReservation | undefined;
  try {
    const access = accountAccess(req, true);
    const { ownerPath, relativePath } = accountShares.ownerPathForGrant(access.grant, req.body?.path);
    const versionId = String(req.body?.versionId || '');
    const version = db.prepare(`SELECT * FROM versions WHERE id=? AND user_id=? AND path=?`)
      .get(versionId, access.owner.id, ownerPath) as any;
    if (!version) return res.status(404).json({ error: 'not_found' });
    const source = String(version.stored_path);
    const sourceStat = await fsp.lstat(source);
    if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) {
      return res.status(410).json({ error: 'version_content_unavailable' });
    }
    reservation = await writes.reserveStorage(access.owner, sourceStat.size);
    temp = path.join(accountUploadTmp, `shared-version-${crypto.randomUUID()}`);
    await fsp.copyFile(source, temp, fs.constants.COPYFILE_EXCL | fs.constants.COPYFILE_FICLONE);
    const result = await writes.commitTempFile({ user: ownerWriteUser(access), virtualPath: ownerPath,
      tempPath: temp, expectedRevision: req.body?.revision || undefined,
      versionNote: `Before shared restore by ${access.actor.displayName}`, reservation });
    temp = '';
    reservation = undefined;
    accountAudit(req, access, 'shared_version_restored', ownerPath, { relativePath, versionId });
    res.json({ ok: true, revision: result.revision });
  } catch (error) { next(error); }
  finally {
    if (temp) await fsp.rm(temp, { force: true }).catch(() => {});
    writes.releaseStorage(reservation);
  }
});

r.delete('/:id', (req: AuthedRequest, res) => {
  const shareId = String(req.params.id);
  const result = db.prepare('DELETE FROM shares WHERE id=? AND user_id=?').run(shareId, req.user!.id);
  if (!result.changes) return res.status(404).json({ error: 'not_found' });
  audit(req.user!.id, req.user!.username, 'share_revoked', shareId, requestIp(req));
  res.json({ ok: true });
});

export default r;
