// Aerie Drive: a mountable WebDAV view of each member's private file root.
//
// Operating systems speak WebDAV directly, so files can be opened by native
// applications and hydrated on demand without installing a second copy of the
// storage backend. Dedicated high-entropy app passwords are revocable and never
// expose the member's login password to an OS credential manager.
import { Router, type NextFunction, type Response } from 'express';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import mime from 'mime-types';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { type AuthedRequest, authMiddleware, requireFeature, rowToUser } from '../lib/auth.js';
import { config } from '../config.js';
import { db, audit } from '../lib/db.js';
import * as storage from '../services/storage.js';
import * as writes from '../services/storage-write.js';
import { adminPolicy, assertFileAllowed } from '../services/policy.js';
import { reconcileBase, withSyncLock } from '../services/sync-fabric.js';
import { markFileCatalogStale } from '../services/file-catalog.js';
import { parseUploadByteLength } from '../services/upload-ingress.js';

export const webdavRouter = Router();
const manage = Router();
const locks = new Map<string, { token: string; expires: number; owner: string }>();

function secretHash(value: string) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function safeEqual(a: string, b: string) {
  try {
    const aa = Buffer.from(a, 'hex'), bb = Buffer.from(b, 'hex');
    return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
  } catch { return false; }
}

function challenge(res: Response) {
  res.setHeader('WWW-Authenticate', 'Basic realm="Aerie Drive", charset="UTF-8"');
  return res.status(401).end();
}

function driveAuth(req: AuthedRequest, res: Response, next: NextFunction) {
  const header = String(req.headers.authorization || '');
  if (!header.startsWith('Basic ')) return authMiddleware(req, res, next);
  try {
    const raw = Buffer.from(header.slice(6), 'base64').toString('utf8');
    const split = raw.indexOf(':');
    if (split <= 0) return challenge(res);
    const username = raw.slice(0, split);
    const password = raw.slice(split + 1);
    const userRow = db.prepare(`SELECT * FROM users
      WHERE username=? COLLATE NOCASE AND disabled_at IS NULL`).get(username) as any;
    if (!userRow || !password.startsWith('aerie_')) return challenge(res);
    const wanted = secretHash(password);
    const credentials = db.prepare(`SELECT id,secret_hash FROM drive_credentials
      WHERE user_id=? AND revoked_at IS NULL`).all(userRow.id) as any[];
    const match = credentials.find(row => safeEqual(row.secret_hash, wanted));
    if (!match) return challenge(res);
    db.prepare(`UPDATE drive_credentials SET last_used_at=datetime('now')
      WHERE id=? AND (last_used_at IS NULL OR last_used_at < datetime('now','-5 minutes'))`).run(match.id);
    req.user = rowToUser(userRow);
    next();
  } catch { return challenge(res); }
}

function canonicalVirtualPath(raw: string): string {
  if (raw.includes('\0') || raw.includes('\\')) {
    throw Object.assign(new Error('invalid_path'), { status: 400 });
  }
  const rooted = raw.startsWith('/') ? raw : '/' + raw;
  // Reject traversal syntax before normalization; checking afterwards is too
  // late because path.normalize has already erased the evidence.
  if (rooted.split('/').some(part => part === '.' || part === '..')) {
    throw Object.assign(new Error('path_escape'), { status: 400 });
  }
  return path.posix.normalize(rooted);
}

function virtualPath(req: AuthedRequest): string {
  let raw = req.path || '/';
  try { raw = decodeURIComponent(raw); } catch { throw Object.assign(new Error('invalid_path'), { status: 400 }); }
  return canonicalVirtualPath(raw);
}

function xml(value: string) {
  return value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]!));
}

function href(vpath: string, directory: boolean) {
  const encoded = vpath.split('/').map((part, i) => i === 0 ? '' : encodeURIComponent(part)).join('/');
  return '/dav' + (encoded === '/' ? '/' : encoded) + (directory && !encoded.endsWith('/') ? '/' : '');
}

function etag(st: fs.Stats) {
  return writes.revisionFor(st);
}

async function propResponse(username: string, vpath: string) {
  const real = await storage.resolveAsync(username, vpath);
  const st = await fsp.stat(real);
  const directory = st.isDirectory();
  const contentType = directory ? 'httpd/unix-directory' : String(mime.lookup(real) || 'application/octet-stream');
  return `<d:response><d:href>${xml(href(vpath, directory))}</d:href><d:propstat><d:prop>`
    + `<d:displayname>${xml(vpath === '/' ? 'Aerie Drive' : path.posix.basename(vpath))}</d:displayname>`
    + `<d:resourcetype>${directory ? '<d:collection/>' : ''}</d:resourcetype>`
    + `<d:getcontenttype>${xml(contentType)}</d:getcontenttype>`
    + `<d:getcontentlength>${directory ? 0 : st.size}</d:getcontentlength>`
    + `<d:getlastmodified>${st.mtime.toUTCString()}</d:getlastmodified>`
    + `<d:creationdate>${st.birthtime.toISOString()}</d:creationdate>`
    + `<d:getetag>${xml(etag(st))}</d:getetag>`
    + `</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`;
}

function destinationPath(req: AuthedRequest): string {
  const raw = String(req.headers.destination || '');
  if (!raw) throw Object.assign(new Error('missing_destination'), { status: 400 });
  let pathname: string;
  try { pathname = new URL(raw, `${req.protocol}://${req.get('host') || 'aerie'}`).pathname; }
  catch { throw Object.assign(new Error('invalid_destination'), { status: 400 }); }
  const prefix = req.baseUrl || '/dav';
  if (!(pathname === prefix || pathname.startsWith(prefix + '/'))) {
    throw Object.assign(new Error('cross_server_destination'), { status: 502 });
  }
  try { pathname = decodeURIComponent(pathname.slice(prefix.length) || '/'); }
  catch { throw Object.assign(new Error('invalid_destination'), { status: 400 }); }
  return canonicalVirtualPath(pathname);
}

function assertLockToken(req: AuthedRequest, ...paths: string[]): void {
  const supplied = `${String(req.headers.if || '')} ${String(req.headers['lock-token'] || '')}`;
  const prefix = `${req.user!.id}:`;
  for (const [key, lock] of locks) {
    if (lock.expires <= Date.now()) { locks.delete(key); continue; }
    if (!key.startsWith(prefix)) continue;
    const lockedPath = key.slice(prefix.length);
    if (paths.some(value => value === lockedPath || value.startsWith(lockedPath + '/') || lockedPath.startsWith(value + '/'))
      && !supplied.includes(lock.token)) {
      throw Object.assign(new Error('locked'), { status: 423 });
    }
  }
}

/** Keep WebDAV writes in the same journal consumed by Aerie Sync. */
async function journalDriveMutation(req: AuthedRequest, changedPaths: string[]) {
  const bases = new Set<string>();
  const existing = db.prepare('SELECT DISTINCT base FROM sync_entries WHERE user_id=?')
    .all(req.user!.id) as Array<{ base: string }>;
  for (const { base } of existing) {
    const root = '/' + base;
    if (changedPaths.some(value => value === root || value.startsWith(root + '/') || root.startsWith(value + '/'))) {
      bases.add(base);
    }
  }
  for (const value of changedPaths) {
    const parts = value.split('/').filter(Boolean);
    if (parts[0] === 'Sync' && parts[1]) bases.add(`Sync/${parts[1]}`);
    if (parts[0] === 'Photos' && parts[1] === 'Camera' && parts[2]) bases.add(`Photos/Camera/${parts[2]}`);
  }
  for (const base of bases) {
    const root = await storage.resolveAsync(req.user!.username, '/' + base);
    await withSyncLock(req.user!.id, base, () =>
      reconcileBase(req.user!.id, base, root));
  }
}

webdavRouter.use(driveAuth);
// App passwords are an alternate authentication mechanism, not a way around
// the account's Files entitlement. This also makes a revoked Files feature take
// effect for already-mounted OS clients on their next request.
webdavRouter.use(requireFeature('files'));

// Android's HttpURLConnection only guarantees the standard HTTP verb set.
// Authenticated native clients tunnel WebDAV mutations through POST while the
// route keeps the exact same authorization, validation and journaling path.
webdavRouter.use((req, res, next) => {
  const override = String(req.headers['x-http-method-override'] || '').toUpperCase();
  if (req.method === 'POST' && ['MKCOL', 'DELETE', 'MOVE'].includes(override)) req.method = override;
  else if (override) return res.status(400).json({ error: 'invalid_method_override' });
  next();
});

webdavRouter.use((req, res, next) => {
  res.setHeader('DAV', '1, 2');
  res.setHeader('MS-Author-Via', 'DAV');
  res.setHeader('Allow', 'OPTIONS, PROPFIND, GET, HEAD, PUT, DELETE, MKCOL, COPY, MOVE, LOCK, UNLOCK');
  next();
});

webdavRouter.options('/{*splat}', (_req, res) => res.status(200).end());

webdavRouter.use((req: AuthedRequest, res, next) => {
  if (req.method !== 'PROPFIND') return next();
  (async () => {
    const vpath = virtualPath(req);
    const real = await storage.resolveAsync(req.user!.username, vpath);
    const st = await fsp.stat(real);
    const responses = [await propResponse(req.user!.username, vpath)];
    const depth = String(req.headers.depth || '1');
    if (st.isDirectory() && depth !== '0') {
      for (const name of await fsp.readdir(real)) {
        if (name.startsWith('.')) continue;
        try { responses.push(await propResponse(req.user!.username, path.posix.join(vpath, name))); } catch { /* raced */ }
      }
    }
    res.status(207).type('application/xml; charset=utf-8').send(
      `<?xml version="1.0" encoding="utf-8"?><d:multistatus xmlns:d="DAV:">${responses.join('')}</d:multistatus>`);
  })().catch((e: any) => { if (e?.code === 'ENOENT') return res.status(404).end(); next(e); });
});

webdavRouter.use((req: AuthedRequest, res, next) => {
  if (!['GET', 'HEAD'].includes(req.method)) return next();
  (async () => {
    const real = await storage.resolveAsync(req.user!.username, virtualPath(req));
    const st = await fsp.stat(real);
    if (!st.isFile()) return res.status(405).end();
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('ETag', etag(st));
    res.setHeader('Last-Modified', st.mtime.toUTCString());
    res.type(String(mime.lookup(real) || 'application/octet-stream'));
    const range = String(req.headers.range || '');
    let start = 0, end = st.size - 1;
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (match) {
      start = match[1] ? Number(match[1]) : Math.max(0, st.size - Number(match[2] || 0));
      end = match[2] ? Math.min(st.size - 1, Number(match[2])) : st.size - 1;
      if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || start > end || start >= st.size) {
        res.setHeader('Content-Range', `bytes */${st.size}`); return res.status(416).end();
      }
      res.status(206).setHeader('Content-Range', `bytes ${start}-${end}/${st.size}`);
    }
    res.setHeader('Content-Length', String(Math.max(0, end - start + 1)));
    if (req.method === 'HEAD' || st.size === 0) return res.end();
    fs.createReadStream(real, { start, end }).on('error', next).pipe(res);
  })().catch((e: any) => { if (e?.code === 'ENOENT') return res.status(404).end(); next(e); });
});

webdavRouter.use((req: AuthedRequest, res, next) => {
  if (req.method !== 'PUT') return next();
  (async () => {
    const vpath = virtualPath(req);
    if (vpath === '/') return res.status(403).end();
    assertLockToken(req, vpath);
    const real = await storage.resolveAsync(req.user!.username, vpath);
    let previous: fs.Stats | null = null;
    try { previous = await fsp.stat(real); } catch { /* new */ }
    if (previous?.isDirectory()) return res.status(405).end();
    const existed = !!previous;
    if (existed && String(req.headers['if-none-match'] || '') === '*') return res.status(412).end();
    const ifMatch = String(req.headers['if-match'] || '');
    if (ifMatch && (!previous || (ifMatch !== '*' && !ifMatch.split(',').map(value => value.trim()).includes(etag(previous))))) {
      return res.status(412).end();
    }
    const explicit = parseUploadByteLength(req.headers['x-aerie-upload-length'], 'invalid_upload_length');
    const contentLength = parseUploadByteLength(req.headers['content-length'], 'invalid_content_length');
    const maxBytes = adminPolicy().maxUploadBytes;
    const declared = explicit ?? contentLength ?? maxBytes;
    assertFileAllowed(path.posix.basename(vpath), declared);
    // Reserve before the first body byte reaches disk. Undeclared chunked PUTs
    // reserve the whole policy ceiling and are released as soon as the request
    // finishes; native clients can send X-Aerie-Upload-Length for an exact hold.
    let reservation: writes.StorageReservation | null = await writes.reserveStorage(req.user!, declared);
    const temp = path.join(path.dirname(real), `.aerie-dav-${crypto.randomUUID()}.tmp`);
    let received = 0;
    const limiter = new Transform({
      transform(chunk, _encoding, callback) {
        received += chunk.length;
        callback(received > declared ? Object.assign(new Error('file_too_large'), { status: 413 }) : null, chunk);
      },
    });
    try {
      await fsp.mkdir(path.dirname(real), { recursive: true });
      await pipeline(req, limiter, fs.createWriteStream(temp, { flags: 'wx', mode: 0o600 }));
      if (explicit !== undefined && received !== explicit) {
        throw Object.assign(new Error('upload_length_mismatch'), {
          status: 400, expectedBytes: explicit, receivedBytes: received,
        });
      }
      assertFileAllowed(path.posix.basename(vpath), received);
      const committed = await writes.commitTempFile({
        user: req.user!, virtualPath: vpath, tempPath: temp,
        expectedRevision: previous ? etag(previous) : '*', reservation: reservation || undefined,
        versionNote: 'WebDAV replacement',
      });
      reservation = null;
      res.setHeader('ETag', committed.revision);
    } catch (e) {
      writes.releaseStorage(reservation);
      await fsp.rm(temp, { force: true }).catch(() => {});
      throw e;
    }
    await journalDriveMutation(req, [vpath]);
    audit(req.user!.id, req.user!.username, existed ? 'drive_file_updated' : 'drive_file_created', vpath, req.ip);
    res.status(existed ? 204 : 201).end();
  })().catch(next);
});

webdavRouter.use((req: AuthedRequest, res, next) => {
  if (req.method !== 'MKCOL') return next();
  (async () => {
    if (Number(req.headers['content-length'] || 0) > 0) return res.status(415).end();
    const vpath = virtualPath(req);
    if (vpath === '/') return res.status(405).end();
    assertLockToken(req, vpath);
    try { await fsp.mkdir(await storage.resolveAsync(req.user!.username, vpath)); }
    catch (e: any) { if (e?.code === 'EEXIST') return res.status(405).end(); throw e; }
    await journalDriveMutation(req, [vpath]);
    markFileCatalogStale(req.user!.id);
    audit(req.user!.id, req.user!.username, 'drive_folder_created', vpath, req.ip);
    res.status(201).end();
  })().catch(next);
});

webdavRouter.use((req: AuthedRequest, res, next) => {
  if (req.method !== 'DELETE') return next();
  (async () => {
    const vpath = virtualPath(req);
    if (vpath === '/') return res.status(403).end();
    assertLockToken(req, vpath);
    await storage.trash(req.user!.username, req.user!.id, vpath);
    await journalDriveMutation(req, [vpath]);
    markFileCatalogStale(req.user!.id);
    audit(req.user!.id, req.user!.username, 'drive_item_trashed', vpath, req.ip);
    res.status(204).end();
  })().catch(next);
});

webdavRouter.use((req: AuthedRequest, res, next) => {
  if (!['MOVE', 'COPY'].includes(req.method)) return next();
  (async () => {
    const from = virtualPath(req), to = destinationPath(req);
    if (from === '/' || to === '/') return res.status(403).end();
    if (from === to) return res.status(204).end();
    assertLockToken(req, from, to);
    const source = await storage.resolveAsync(req.user!.username, from);
    const target = await storage.resolveAsync(req.user!.username, to);
    let existed = false;
    try { await fsp.stat(source); } catch { return res.status(404).end(); }
    try { await fsp.stat(target); existed = true; } catch { /* new */ }
    if (existed && String(req.headers.overwrite || 'T').toUpperCase() === 'F') return res.status(412).end();
    if (req.method === 'COPY') {
      await writes.copyPathAtomic({ user: req.user!, from, to, overwrite: existed, versionNote: 'Before WebDAV copy replacement' });
    } else {
      await writes.movePathAtomic({ user: req.user!, from, to, overwrite: existed, versionNote: 'Before WebDAV move replacement' });
    }
    await journalDriveMutation(req, [from, to]);
    audit(req.user!.id, req.user!.username, req.method === 'COPY' ? 'drive_item_copied' : 'drive_item_moved', from, req.ip, { to });
    res.status(existed ? 204 : 201).end();
  })().catch(next);
});

webdavRouter.use((req: AuthedRequest, res, next) => {
  if (req.method !== 'LOCK') return next();
  const key = `${req.user!.id}:${virtualPath(req)}`;
  const token = `opaquelocktoken:${crypto.randomUUID()}`;
  const timeout = Math.min(3600, Math.max(60, Number(String(req.headers.timeout || '').match(/Second-(\d+)/)?.[1]) || 900));
  locks.set(key, { token, expires: Date.now() + timeout * 1000, owner: req.user!.username });
  res.setHeader('Lock-Token', `<${token}>`);
  res.status(200).type('application/xml').send(`<?xml version="1.0"?><d:prop xmlns:d="DAV:"><d:lockdiscovery><d:activelock>`
    + `<d:locktype><d:write/></d:locktype><d:lockscope><d:exclusive/></d:lockscope><d:depth>infinity</d:depth>`
    + `<d:owner>${xml(req.user!.username)}</d:owner><d:timeout>Second-${timeout}</d:timeout>`
    + `<d:locktoken><d:href>${token}</d:href></d:locktoken></d:activelock></d:lockdiscovery></d:prop>`);
});

webdavRouter.use((req: AuthedRequest, res, next) => {
  if (req.method !== 'UNLOCK') return next();
  const key = `${req.user!.id}:${virtualPath(req)}`;
  const lock = locks.get(key), token = String(req.headers['lock-token'] || '').replace(/[<>]/g, '');
  if (!lock || lock.expires < Date.now() || lock.token !== token) return res.status(409).end();
  locks.delete(key);
  res.status(204).end();
});

webdavRouter.use((_req, res) => res.status(405).end());

manage.get('/credentials', (req: AuthedRequest, res) => {
  const items = db.prepare(`SELECT id,name,created_at createdAt,last_used_at lastUsedAt
    FROM drive_credentials WHERE user_id=? AND revoked_at IS NULL ORDER BY created_at DESC`).all(req.user!.id);
  const mountUrl = config.publicUrl ? new URL('/dav', config.publicUrl).toString().replace(/\/$/, '') : '/dav';
  res.json({ items, mountUrl, username: req.user!.username });
});

manage.post('/credentials', (req: AuthedRequest, res) => {
  const name = String(req.body?.name || 'Aerie Drive').trim().slice(0, 80);
  if (!name) return res.status(400).json({ error: 'name_required' });
  const id = `drv_${crypto.randomUUID()}`;
  const secret = `aerie_${crypto.randomBytes(24).toString('base64url')}`;
  db.prepare('INSERT INTO drive_credentials (id,user_id,name,secret_hash) VALUES (?,?,?,?)')
    .run(id, req.user!.id, name, secretHash(secret));
  audit(req.user!.id, req.user!.username, 'drive_credential_created', id, req.ip, { name });
  const mountUrl = config.publicUrl ? new URL('/dav', config.publicUrl).toString().replace(/\/$/, '') : '/dav';
  res.status(201).json({ id, name, username: req.user!.username, password: secret,
    mountUrl, note: 'This password is shown once.' });
});

manage.delete('/credentials/:id', (req: AuthedRequest, res) => {
  const result = db.prepare(`UPDATE drive_credentials SET revoked_at=datetime('now')
    WHERE id=? AND user_id=? AND revoked_at IS NULL`).run(String(req.params.id), req.user!.id);
  if (!result.changes) return res.status(404).json({ error: 'not_found' });
  audit(req.user!.id, req.user!.username, 'drive_credential_revoked', String(req.params.id), req.ip);
  res.json({ ok: true });
});

export default manage;
