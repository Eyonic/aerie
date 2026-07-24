import express, { Router } from 'express';
import multer from 'multer';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import mime from 'mime-types';
import { type AuthedRequest } from '../lib/auth.js';
import { config } from '../config.js';
import * as storage from '../services/storage.js';
import { markFileCatalogStale } from '../services/file-catalog.js';
import * as writes from '../services/storage-write.js';
import * as dedup from '../services/dedup.js';
import * as photolib from '../services/photolib.js';
import { assertFileAllowed } from '../services/policy.js';
import {
  boundedDiskStorage, claimUploadIngress, releaseIngress, reserveUploadIngress, withUploadIngressCleanup,
} from '../services/upload-ingress.js';
import {
  activeByPath,
  activeByStableId,
  acknowledgeCursor,
  changesAfter,
  deterministicConflictRel,
  hashFile,
  latestCursor,
  manifest,
  noteSyncDeviceSeen,
  parseByteRange,
  reconcileBase,
  registerDelete,
  registerRename,
  registerUpsert,
  withSyncLock,
} from '../services/sync-fabric.js';
import { db, audit } from '../lib/db.js';
import { KeyedLock } from '../lib/keyed-lock.js';

const r = Router();
const uploadTmp = path.join(config.filesRoot, '.sync-uploads-tmp');
fs.mkdirSync(uploadTmp, { recursive: true });
const upload = multer({ storage: boundedDiskStorage(uploadTmp), limits: {
  files: 1, fields: 12, parts: 14, fieldNameSize: 100, fieldSize: 16 * 1024,
} });
const TOLERANCE_MS = 2000;
const basesCache = new Map<number, { ts: number; data: any }>();
const resumableLocks = new KeyedLock();
const RESUMABLE_TTL_MS = 24 * 60 * 60 * 1000;
const RESUMABLE_META_MAX = 64 * 1024;
const RESUMABLE_ID = /^[a-f0-9-]{36}$/;
const SHA256 = /^[a-f0-9]{64}$/;

type SyncResumeMeta = {
  schemaVersion: 1;
  id: string;
  userId: number;
  base: string;
  rel: string;
  size: number;
  mtimeMs?: number;
  contentHash: string;
  stableId: string | null;
  expectedHash?: string;
  deviceId: string;
  reservationId: string | null;
  status: 'uploading' | 'completed';
  offset: number;
  createdAt: number;
  updatedAt: number;
  commitRel?: string;
  commitConflict?: boolean;
  result?: any;
};

function u(req: AuthedRequest) { return req.user!; }
function conflictId(userId: number, base: string, rel: string) {
  return crypto.createHash('sha256').update(`${userId}:${base}:${rel}`).digest('hex').slice(0, 32);
}

function cleanPart(v: string, name: string): string {
  if (typeof v !== 'string') throw Object.assign(new Error(`invalid_${name}`), { status: 400 });
  const s = v.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');
  if (!s || path.posix.isAbsolute(v) || s.split('/').some(p => !p || p === '.' || p === '..')) {
    throw Object.assign(new Error(`invalid_${name}`), { status: 400 });
  }
  return s;
}

function cleanBase(v: string): string {
  const s = cleanPart(v, 'base');
  if (!s.startsWith('Sync/') && !s.startsWith('Photos/Camera/')) throw Object.assign(new Error('invalid_base'), { status: 400 });
  return s;
}

function cleanRel(v: string): string {
  return cleanPart(v, 'rel');
}

async function realFor(username: string, base: string, rel = '') {
  return storage.resolveAsync(username, '/' + path.posix.join(base, rel || ''));
}

function cleanDeviceId(v: unknown): string {
  const value = String(v || 'desktop').trim();
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(value)) throw Object.assign(new Error('invalid_device_id'), { status: 400 });
  return value;
}

function cleanRequiredDeviceId(v: unknown): string {
  if (v == null || String(v).trim() === '') {
    throw Object.assign(new Error('missing_device_id'), { status: 400 });
  }
  return cleanDeviceId(v);
}

function cleanStableId(v: unknown): string | null {
  if (v == null || v === '') return null;
  const value = String(v);
  if (!/^[a-zA-Z0-9_-]{8,64}$/.test(value)) throw Object.assign(new Error('invalid_stable_id'), { status: 400 });
  return value;
}

function cleanExpectedHash(v: unknown): string | undefined {
  if (v == null || v === '') return undefined;
  const value = String(v).toLowerCase();
  if (value === 'missing' || /^[a-f0-9]{64}$/.test(value)) return value;
  throw Object.assign(new Error('invalid_expected_hash'), { status: 400 });
}

function publicRow(row: any) {
  if (!row) return null;
  return {
    stableId: row.stable_id,
    base: row.base,
    rel: row.rel_path,
    contentHash: row.content_hash,
    size: Number(row.size),
    mtimeMs: Number(row.mtime_ms),
  };
}

function resumePaths(id: string) {
  if (!RESUMABLE_ID.test(id)) throw Object.assign(new Error('upload_session_not_found'), { status: 404 });
  return {
    meta: path.join(uploadTmp, `resume-${id}.json`),
    part: path.join(uploadTmp, `resume-${id}.part`),
  };
}

async function writeResumeMeta(meta: SyncResumeMeta): Promise<void> {
  const paths = resumePaths(meta.id);
  const bytes = Buffer.from(JSON.stringify(meta));
  if (bytes.length > RESUMABLE_META_MAX) throw new Error('sync_upload_metadata_too_large');
  const temp = `${paths.meta}.tmp`;
  const handle = await fsp.open(temp, 'w', 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
  await fsp.rename(temp, paths.meta);
}

async function readResumeMeta(id: string): Promise<SyncResumeMeta | null> {
  const paths = resumePaths(id);
  try {
    const stat = await fsp.lstat(paths.meta);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > RESUMABLE_META_MAX) return null;
    const parsed = JSON.parse(await fsp.readFile(paths.meta, 'utf8')) as SyncResumeMeta;
    if (parsed?.schemaVersion !== 1 || parsed.id !== id || !Number.isSafeInteger(parsed.userId)
      || !['uploading', 'completed'].includes(parsed.status)) return null;
    return parsed;
  } catch { return null; }
}

async function removeResumeSession(meta: SyncResumeMeta | null, id: string): Promise<void> {
  const paths = resumePaths(id);
  await Promise.all([
    fsp.rm(paths.meta, { force: true }), fsp.rm(paths.part, { force: true }),
    fsp.rm(`${paths.meta}.tmp`, { force: true }),
  ]);
  if (meta?.reservationId) writes.releaseStorage(meta.reservationId);
}

async function cleanupStaleResumeSessions(): Promise<void> {
  const now = Date.now();
  const names = await fsp.readdir(uploadTmp).catch(() => [] as string[]);
  const retained = new Set<string>();
  for (const name of names) {
    const match = /^resume-([a-f0-9-]{36})\.json$/.exec(name);
    if (!match) continue;
    const meta = await readResumeMeta(match[1]);
    if (!meta || now - Number(meta.updatedAt || 0) > RESUMABLE_TTL_MS) {
      await removeResumeSession(meta, match[1]).catch(() => {});
    } else retained.add(match[1]);
  }
  for (const name of names) {
    const match = /^resume-([a-f0-9-]{36})\.part$/.exec(name);
    if (match && !retained.has(match[1])) {
      const stat = await fsp.stat(path.join(uploadTmp, name)).catch(() => null);
      if (!stat || now - stat.mtimeMs > 60 * 60 * 1000) {
        await fsp.rm(path.join(uploadTmp, name), { force: true }).catch(() => {});
      }
    }
    if (/^resume-[a-f0-9-]{36}\.json\.tmp$/.test(name)) {
      const stat = await fsp.stat(path.join(uploadTmp, name)).catch(() => null);
      if (!stat || now - stat.mtimeMs > 60 * 60 * 1000) await fsp.rm(path.join(uploadTmp, name), { force: true }).catch(() => {});
    }
  }
}

type SyncUploadInput = {
  base: string;
  rel: string;
  mtimeMs?: number;
  stableId: string | null;
  expectedHash?: string;
  deviceId: string;
  contentHash: string;
  tempPath: string;
  reservation: writes.StorageReservation;
  beforeCommit?: (rel: string, conflict: boolean) => Promise<void>;
};

/** One conflict/precondition implementation for multipart and resumable uploads. */
async function finalizeSyncUpload(req: AuthedRequest, input: SyncUploadInput): Promise<any> {
  const { base, rel, stableId, expectedHash, deviceId, contentHash, tempPath, reservation } = input;
  return withSyncLock(u(req).id, base, async () => {
    await reconcileBase(u(req).id, base, await realFor(u(req).username, base));
    const stableCurrent = stableId ? activeByStableId(u(req).id, stableId) : undefined;
    const pathCurrent = activeByPath(u(req).id, base, rel);
    const current = stableCurrent || pathCurrent;
    const violatesPrecondition = expectedHash === 'missing'
      ? !!current
      : !!expectedHash && (!current || current.content_hash !== expectedHash || current.rel_path !== rel);

    if (violatesPrecondition) {
      const conflictRel = deterministicConflictRel(rel, deviceId, contentHash);
      const existingConflict = activeByPath(u(req).id, base, conflictRel);
      if (existingConflict?.content_hash === contentHash) {
        return {
          ok: true, conflict: true, conflictRel, entry: publicRow(existingConflict),
          current: publicRow(current), cursor: latestCursor(u(req).id, base),
        };
      }
      if (existingConflict) {
        return { error: 'conflict_name_collision', status: 409, current: publicRow(existingConflict) };
      }
      if (input.beforeCommit) await input.beforeCommit(conflictRel, true);
      const conflictPath = '/' + path.posix.join(base, conflictRel);
      await writes.commitTempFile({
        user: u(req), virtualPath: conflictPath, tempPath,
        reservation, releaseReservation: false, createVersion: false, mtimeMs: input.mtimeMs,
      });
      const conflictDest = await realFor(u(req).username, base, conflictRel);
      const stat = await fsp.stat(conflictDest);
      const created = registerUpsert({
        userId: u(req).id, base, rel: conflictRel, contentHash, size: stat.size,
        mtimeMs: stat.mtimeMs, originDevice: deviceId,
      });
      audit(u(req).id, u(req).username, 'sync_conflict_preserved', path.posix.join(base, rel), req.ip, {
        deviceId, conflictRel: path.posix.join(base, conflictRel), currentHash: current?.content_hash || null,
        incomingHash: contentHash,
      });
      basesCache.delete(u(req).id);
      return { ok: true, conflict: true, conflictRel, ...created, current: publicRow(current) };
    }

    const acceptedStableId = stableCurrent?.base === base ? stableCurrent.stable_id : pathCurrent?.stable_id;
    if (input.beforeCommit) await input.beforeCommit(rel, false);
    const virtualPath = '/' + path.posix.join(base, rel);
    const dest = await realFor(u(req).username, base, rel);
    await writes.commitTempFile({
      user: u(req), virtualPath, tempPath, reservation, releaseReservation: false,
      createVersion: true, versionNote: `Synced from ${deviceId}`, mtimeMs: input.mtimeMs,
    });
    const stat = await fsp.stat(dest);
    const saved = registerUpsert({
      userId: u(req).id, base, rel, contentHash, size: stat.size, mtimeMs: stat.mtimeMs,
      stableId: acceptedStableId, originDevice: deviceId,
    });
    if (base.startsWith('Photos/Camera/') && photolib.IMAGE_EXT.has(path.extname(rel).toLowerCase())) {
      await photolib.indexFile(u(req), path.posix.join(base, rel)).catch(() => null);
    }
    basesCache.delete(u(req).id);
    db.prepare('DELETE FROM sync_conflicts WHERE id=?').run(conflictId(u(req).id, base, rel));
    return { ok: true, ...saved };
  });
}

async function recoverCommittedResume(req: AuthedRequest, meta: SyncResumeMeta): Promise<any | null> {
  if (!meta.commitRel) return null;
  return withSyncLock(u(req).id, meta.base, async () => {
    await reconcileBase(u(req).id, meta.base, await realFor(u(req).username, meta.base));
    const entry = activeByPath(u(req).id, meta.base, meta.commitRel!);
    if (!entry || entry.content_hash !== meta.contentHash) return null;
    const current = meta.commitConflict ? activeByPath(u(req).id, meta.base, meta.rel) : undefined;
    return {
      ok: true,
      ...(meta.commitConflict ? { conflict: true, conflictRel: meta.commitRel } : {}),
      entry: publicRow(entry), current: publicRow(current), cursor: latestCursor(u(req).id, meta.base),
    };
  });
}

async function removeEmptyParents(filename: string, stopAt: string) {
  let dir = path.dirname(filename);
  while (dir !== stopAt && dir.startsWith(stopAt + path.sep)) {
    try { await fsp.rmdir(dir); } catch { break; }
    dir = path.dirname(dir);
  }
}

async function listFiles(username: string, base: string) {
  const root = await realFor(username, base);
  const files: { rel: string; size: number; mtimeMs: number }[] = [];
  const directories: Array<{ dir: string; prefix: string }> = [{ dir: root, prefix: '' }];
  for (let index = 0; index < directories.length; index++) {
    const current = directories[index];
    let handle: fs.Dir;
    try { handle = await fsp.opendir(current.dir); } catch { continue; }
    for await (const entry of handle) {
      if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue;
      const full = path.join(current.dir, entry.name);
      let stat: fs.Stats;
      try { stat = await fsp.lstat(full); } catch { continue; }
      if (stat.isSymbolicLink()) continue;
      const rel = current.prefix ? path.posix.join(current.prefix, entry.name) : entry.name;
      if (stat.isDirectory()) directories.push({ dir: full, prefix: rel });
      else if (stat.isFile()) files.push({ rel, size: stat.size, mtimeMs: stat.mtimeMs });
    }
    if (index && index % 64 === 0) await new Promise<void>(resolve => setImmediate(resolve));
  }
  return files;
}

// Sync Fabric v2. Legacy /check, /list and /upload semantics remain available
// below so existing Android and desktop releases continue to interoperate.
r.get('/capabilities', (_req: AuthedRequest, res) => {
  res.json({
    protocol: 2,
    features: [
      'stable_ids', 'change_journal', 'journal_ack', 'journal_compaction', 'full_manifest_fallback',
      'tombstones', 'content_hashes', 'range_downloads', 'resumable_uploads', 'rename', 'delete',
    ],
    hash: 'sha256',
  });
});

r.get('/changes', async (req: AuthedRequest, res, next) => {
  try {
    const base = cleanBase(String(req.query.base || ''));
    const cursor = Number(req.query.cursor || 0);
    const limit = Math.min(1000, Math.max(1, Number(req.query.limit || 250)));
    const deviceId = cleanDeviceId(req.query.deviceId);
    if (!Number.isSafeInteger(cursor) || cursor < 0 || !Number.isSafeInteger(limit)) {
      return res.status(400).json({ error: 'invalid_cursor' });
    }
    const result = await withSyncLock(u(req).id, base, async () => {
      await reconcileBase(u(req).id, base, await realFor(u(req).username, base));
      noteSyncDeviceSeen(u(req).id, base, deviceId);
      return changesAfter(u(req).id, base, cursor, limit);
    });
    res.json(result);
  } catch (e) { next(e); }
});

r.get('/manifest', async (req: AuthedRequest, res, next) => {
  try {
    const base = cleanBase(String(req.query.base || ''));
    const deviceId = cleanDeviceId(req.query.deviceId);
    const result = await withSyncLock(u(req).id, base, async () => {
      await reconcileBase(u(req).id, base, await realFor(u(req).username, base));
      noteSyncDeviceSeen(u(req).id, base, deviceId);
      return manifest(u(req).id, base);
    });
    res.json(result);
  } catch (e) { next(e); }
});

r.post('/ack', async (req: AuthedRequest, res, next) => {
  try {
    const base = cleanBase(req.body?.base || '');
    const deviceId = cleanRequiredDeviceId(req.body?.deviceId);
    const cursor = Number(req.body?.cursor);
    if (!Number.isSafeInteger(cursor) || cursor < 0) return res.status(400).json({ error: 'invalid_cursor' });
    const result = await withSyncLock(u(req).id, base,
      async () => acknowledgeCursor(u(req).id, base, deviceId, cursor));
    if (!result.ok) return res.status(409).json({ error: 'sync_cursor_invalid', ...result });
    res.json(result);
  } catch (e) { next(e); }
});

r.post('/delete', async (req: AuthedRequest, res, next) => {
  try {
    const base = cleanBase(req.body?.base || '');
    const rel = cleanRel(req.body?.rel || '');
    const stableId = cleanStableId(req.body?.stableId);
    const expectedHash = cleanExpectedHash(req.body?.expectedHash);
    const deviceId = cleanDeviceId(req.body?.deviceId);
    const result = await withSyncLock(u(req).id, base, async () => {
      await reconcileBase(u(req).id, base, await realFor(u(req).username, base));
      const current = (stableId && activeByStableId(u(req).id, stableId)) || activeByPath(u(req).id, base, rel);
      if (!current) return { ok: true, alreadyDeleted: true, cursor: latestCursor(u(req).id, base) };
      if (expectedHash && expectedHash !== current.content_hash) {
        return { conflict: true, status: 409, current: publicRow(current), cursor: latestCursor(u(req).id, base) };
      }
      const real = await realFor(u(req).username, base, current.rel_path);
      await fsp.unlink(real).catch((error: any) => { if (error?.code !== 'ENOENT') throw error; });
      await removeEmptyParents(real, await realFor(u(req).username, base));
      const deleted = registerDelete({ userId: u(req).id, stableId: current.stable_id, originDevice: deviceId });
      basesCache.delete(u(req).id);
      markFileCatalogStale(u(req).id);
      return { ok: true, ...deleted };
    });
    if ((result as any).status === 409) return res.status(409).json(result);
    res.json(result);
  } catch (e) { next(e); }
});

r.post('/rename', async (req: AuthedRequest, res, next) => {
  try {
    const base = cleanBase(req.body?.base || '');
    const from = cleanRel(req.body?.from || '');
    const to = cleanRel(req.body?.to || '');
    const stableId = cleanStableId(req.body?.stableId);
    const expectedHash = cleanExpectedHash(req.body?.expectedHash);
    const deviceId = cleanDeviceId(req.body?.deviceId);
    if (from === to) return res.json({ ok: true, cursor: latestCursor(u(req).id, base) });
    const result = await withSyncLock(u(req).id, base, async () => {
      await reconcileBase(u(req).id, base, await realFor(u(req).username, base));
      const current = (stableId && activeByStableId(u(req).id, stableId)) || activeByPath(u(req).id, base, from);
      if (!current) return { error: 'not_found', status: 404 };
      if (current.rel_path === to) return { ok: true, entry: publicRow(current), cursor: latestCursor(u(req).id, base) };
      if (current.rel_path !== from || (expectedHash && expectedHash !== current.content_hash)) {
        return { conflict: true, status: 409, current: publicRow(current), cursor: latestCursor(u(req).id, base) };
      }
      const occupied = activeByPath(u(req).id, base, to);
      if (occupied && occupied.stable_id !== current.stable_id) {
        return { conflict: true, status: 409, reason: 'destination_exists', current: publicRow(occupied), cursor: latestCursor(u(req).id, base) };
      }
      const src = await realFor(u(req).username, base, current.rel_path);
      const dest = await realFor(u(req).username, base, to);
      await fsp.mkdir(path.dirname(dest), { recursive: true });
      await fsp.rename(src, dest);
      await removeEmptyParents(src, await realFor(u(req).username, base));
      const stat = await fsp.stat(dest);
      const renamed = registerRename({
        userId: u(req).id, stableId: current.stable_id, toRel: to, contentHash: current.content_hash,
        size: stat.size, mtimeMs: stat.mtimeMs, originDevice: deviceId,
      });
      basesCache.delete(u(req).id);
      markFileCatalogStale(u(req).id);
      return { ok: true, ...renamed };
    });
    const status = Number((result as any).status || 200);
    if (status !== 200) return res.status(status).json(result);
    res.json(result);
  } catch (e) { next(e); }
});

r.post('/check', async (req: AuthedRequest, res, next) => {
  try {
    const base = cleanBase(req.body?.base || '');
    const files = Array.isArray(req.body?.files) ? req.body.files.slice(0, 5000) : [];
    const needed: string[] = [];
    const conflicts: string[] = [];
    for (const it of files) {
      const rel = cleanRel(String(it?.rel || ''));
      const size = Number(it?.size);
      const mtimeMs = Number(it?.mtimeMs);
      if (!Number.isFinite(size) || !Number.isFinite(mtimeMs)) continue;
      const real = await realFor(u(req).username, base, rel);
      let st: fs.Stats | null = null;
      try { st = await fsp.stat(real); } catch { /* missing */ }
      if (!st || !st.isFile()) {
        const vpath = path.posix.join(base, rel);
        if (dedup.isTombstoned(u(req).id, vpath, size)) continue;
        dedup.clearTombstone(u(req).id, vpath);
        needed.push(rel);
        db.prepare('DELETE FROM sync_conflicts WHERE id=?').run(conflictId(u(req).id, base, rel));
        continue;
      }
      if (mtimeMs > st.mtimeMs + TOLERANCE_MS) needed.push(rel);
      else if (st.mtimeMs > mtimeMs + TOLERANCE_MS && st.size !== size) {
        const id = conflictId(u(req).id, base, rel);
        const existing = db.prepare('SELECT resolution,status FROM sync_conflicts WHERE id=?').get(id) as any;
        if (existing?.resolution === 'device') needed.push(rel);
        else if (existing?.resolution !== 'server') {
          conflicts.push(rel);
          db.prepare(`INSERT INTO sync_conflicts (id,user_id,base,rel_path,device_size,device_mtime,server_size,server_mtime,status,resolution)
            VALUES (?,?,?,?,?,?,?,?, 'open',NULL)
            ON CONFLICT(id) DO UPDATE SET device_size=excluded.device_size,device_mtime=excluded.device_mtime,
              server_size=excluded.server_size,server_mtime=excluded.server_mtime,status='open',updated_at=datetime('now')`)
            .run(id, u(req).id, base, rel, size, mtimeMs, st.size, st.mtimeMs);
        }
      } else db.prepare('DELETE FROM sync_conflicts WHERE id=?').run(conflictId(u(req).id, base, rel));
    }
    res.json({ needed, conflicts });
  } catch (e) { next(e); }
});

r.post('/upload', reserveUploadIngress, withUploadIngressCleanup(upload.single('file')), async (req: AuthedRequest, res, next) => {
  const f = (req as any).file;
  let failure: unknown;
  try {
    const reservation = claimUploadIngress(req);
    if (!f) return res.status(400).json({ error: 'missing_file' });
    const base = cleanBase(req.body?.base || '');
    const rel = cleanRel(req.body?.rel || '');
    const mtimeMs = Number(req.body?.mtimeMs);
    const stableId = cleanStableId(req.body?.stableId);
    const expectedHash = cleanExpectedHash(req.body?.expectedHash);
    const deviceId = cleanDeviceId(req.body?.deviceId);
    assertFileAllowed(path.posix.basename(rel), Number(f.size));
    const claimedHash = req.body?.contentHash ? String(req.body.contentHash).toLowerCase() : '';
    if (claimedHash && !/^[a-f0-9]{64}$/.test(claimedHash)) {
      return res.status(400).json({ error: 'invalid_content_hash' });
    }
    const contentHash = await hashFile(f.path);
    if (claimedHash && claimedHash !== contentHash) {
      return res.status(422).json({ error: 'content_hash_mismatch', actualHash: contentHash });
    }

    const result = await finalizeSyncUpload(req, {
      base, rel, mtimeMs: Number.isFinite(mtimeMs) ? mtimeMs : undefined,
      stableId, expectedHash, deviceId, contentHash, tempPath: f.path, reservation: reservation!,
    });
    const status = Number((result as any).status || 200);
    if (status !== 200) return res.status(status).json(result);
    res.json(result);
  } catch (e) {
    failure = e;
  } finally {
    if (f?.path) await fsp.unlink(f.path).catch(() => {});
    releaseIngress(req);
  }
  if (failure) next(failure);
});

// Protocol-2 resumable uploads keep only bounded metadata and a private part
// file. Sessions are scoped to the authenticated user and expire after 24h.
r.post('/upload-resumable/init', async (req: AuthedRequest, res, next) => {
  try {
    await cleanupStaleResumeSessions();
    const base = cleanBase(req.body?.base || '');
    const rel = cleanRel(req.body?.rel || '');
    const size = Number(req.body?.size);
    const mtimeValue = req.body?.mtimeMs == null ? undefined : Number(req.body.mtimeMs);
    const mtimeMs = Number.isFinite(mtimeValue) && Number(mtimeValue) >= 0 ? Number(mtimeValue) : undefined;
    const stableId = cleanStableId(req.body?.stableId);
    const expectedHash = cleanExpectedHash(req.body?.expectedHash);
    const deviceId = cleanRequiredDeviceId(req.body?.deviceId);
    const contentHash = String(req.body?.contentHash || '').toLowerCase();
    if (!Number.isSafeInteger(size) || size < 0) return res.status(400).json({ error: 'invalid_size' });
    if (!SHA256.test(contentHash)) return res.status(400).json({ error: 'invalid_content_hash' });
    assertFileAllowed(path.posix.basename(rel), size);
    const wanted = String(req.body?.uploadId || '');

    if (RESUMABLE_ID.test(wanted)) {
      const existing = await resumableLocks.run(wanted, async () => {
        const meta = await readResumeMeta(wanted);
        if (!meta || meta.userId !== u(req).id || meta.base !== base || meta.rel !== rel
          || meta.size !== size || meta.contentHash !== contentHash || meta.stableId !== stableId
          || meta.expectedHash !== expectedHash || meta.deviceId !== deviceId
          || (meta.mtimeMs ?? undefined) !== mtimeMs) return null;
        if (meta.status === 'completed' && meta.result) {
          if (meta.reservationId) writes.releaseStorage(meta.reservationId);
          return { uploadId: wanted, offset: size, size, completed: true, result: meta.result };
        }
        const paths = resumePaths(wanted);
        let stat: fs.Stats | null = null;
        try { stat = await fsp.stat(paths.part); } catch { /* commit may have moved it */ }
        if (!stat) {
          const recovered = await recoverCommittedResume(req, meta);
          if (!recovered) return null;
          meta.status = 'completed'; meta.offset = size; meta.result = recovered; meta.updatedAt = Date.now();
          await writeResumeMeta(meta);
          if (meta.reservationId) writes.releaseStorage(meta.reservationId);
          return { uploadId: wanted, offset: size, size, completed: true, result: recovered };
        }
        if (!stat.isFile() || stat.size < 0 || stat.size > size) return null;
        const activeReservation = meta.reservationId && db.prepare(`SELECT 1 FROM storage_reservations
          WHERE id=? AND user_id=? AND datetime(expires_at)>datetime('now')`).get(meta.reservationId, u(req).id);
        if (!activeReservation) {
          const restored = await writes.reserveStorage(u(req), size);
          meta.reservationId = restored.id;
        } else writes.refreshStorageReservation(meta.reservationId);
        meta.offset = stat.size; meta.updatedAt = Date.now();
        await writeResumeMeta(meta);
        return { uploadId: wanted, offset: stat.size, size };
      });
      if (existing) return res.json(existing);
      const staleMeta = await readResumeMeta(wanted);
      if (staleMeta?.userId === u(req).id) await removeResumeSession(staleMeta, wanted).catch(() => {});
    }

    const reservation = await writes.reserveStorage(u(req), size);
    const id = crypto.randomUUID();
    const paths = resumePaths(id);
    try {
      const part = await fsp.open(paths.part, 'wx', 0o600);
      try { await part.sync(); } finally { await part.close(); }
      const now = Date.now();
      const meta: SyncResumeMeta = {
        schemaVersion: 1, id, userId: u(req).id, base, rel, size, mtimeMs,
        contentHash, stableId, expectedHash, deviceId, reservationId: reservation.id,
        status: 'uploading', offset: 0, createdAt: now, updatedAt: now,
      };
      await writeResumeMeta(meta);
      res.json({ uploadId: id, offset: 0, size });
    } catch (error) {
      writes.releaseStorage(reservation);
      await removeResumeSession(null, id).catch(() => {});
      throw error;
    }
  } catch (error) { next(error); }
});

r.patch('/upload-resumable/:id', express.raw({ type: 'application/octet-stream', limit: '9mb' }),
  async (req: AuthedRequest, res, next) => {
    try {
      const id = String(req.params.id || '');
      if (!RESUMABLE_ID.test(id)) return res.status(404).json({ error: 'upload_session_not_found' });
      await resumableLocks.run(id, async () => {
        const meta = await readResumeMeta(id);
        if (!meta || meta.userId !== u(req).id) return res.status(404).json({ error: 'upload_session_not_found' });
        if (meta.status === 'completed') return res.json({ uploadId: id, offset: meta.size, complete: true });
        const offset = Number(req.headers['x-upload-offset']);
        if (!Number.isSafeInteger(offset) || offset < 0) return res.status(400).json({ error: 'invalid_upload_offset' });
        const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
        const claimedHash = String(req.headers['x-chunk-sha256'] || '').trim().toLowerCase();
        if (!SHA256.test(claimedHash)) return res.status(400).json({ error: 'invalid_chunk_hash' });
        const actualHash = crypto.createHash('sha256').update(body).digest('hex');
        if (!crypto.timingSafeEqual(Buffer.from(actualHash, 'hex'), Buffer.from(claimedHash, 'hex'))) {
          return res.status(400).json({ error: 'chunk_hash_mismatch', offset: meta.offset });
        }
        const paths = resumePaths(id);
        const actual = (await fsp.stat(paths.part)).size;
        if (offset !== actual) return res.status(409).json({ error: 'offset_mismatch', offset: actual });
        if (body.length === 0 && actual < meta.size) return res.status(400).json({ error: 'empty_upload_chunk' });
        if (actual + body.length > meta.size) return res.status(400).json({ error: 'chunk_exceeds_size' });
        const handle = await fsp.open(paths.part, 'a');
        try { await handle.write(body); await handle.sync(); } finally { await handle.close(); }
        meta.offset = actual + body.length; meta.updatedAt = Date.now();
        writes.refreshStorageReservation(meta.reservationId);
        await writeResumeMeta(meta);
        res.json({ uploadId: id, offset: meta.offset, complete: meta.offset === meta.size });
      });
    } catch (error) { next(error); }
  });

r.post('/upload-resumable/:id/complete', async (req: AuthedRequest, res, next) => {
  try {
    const id = String(req.params.id || '');
    if (!RESUMABLE_ID.test(id)) return res.status(404).json({ error: 'upload_session_not_found' });
    await resumableLocks.run(id, async () => {
      const meta = await readResumeMeta(id);
      if (!meta || meta.userId !== u(req).id) return res.status(404).json({ error: 'upload_session_not_found' });
      if (meta.status === 'completed' && meta.result) {
        if (meta.reservationId) writes.releaseStorage(meta.reservationId);
        return res.json(meta.result);
      }
      const paths = resumePaths(id);
      let stat: fs.Stats | null = null;
      try { stat = await fsp.stat(paths.part); } catch { /* recover a commit with a lost response */ }
      if (!stat) {
        const recovered = await recoverCommittedResume(req, meta);
        if (!recovered) return res.status(409).json({ error: 'upload_state_unavailable' });
        meta.status = 'completed'; meta.offset = meta.size; meta.result = recovered; meta.updatedAt = Date.now();
        await writeResumeMeta(meta);
        if (meta.reservationId) writes.releaseStorage(meta.reservationId);
        return res.json(recovered);
      }
      if (!stat.isFile() || stat.size !== meta.size) {
        return res.status(409).json({ error: 'upload_incomplete', offset: stat.size, size: meta.size });
      }
      const activeReservation = meta.reservationId && db.prepare(`SELECT 1 FROM storage_reservations
        WHERE id=? AND user_id=? AND datetime(expires_at)>datetime('now')`).get(meta.reservationId, u(req).id);
      if (!activeReservation) {
        const restored = await writes.reserveStorage(u(req), meta.size);
        meta.reservationId = restored.id; meta.updatedAt = Date.now();
        await writeResumeMeta(meta);
      } else writes.refreshStorageReservation(meta.reservationId);
      const actualHash = await hashFile(paths.part);
      if (actualHash !== meta.contentHash) {
        return res.status(409).json({ error: 'content_hash_mismatch', offset: stat.size });
      }
      const result = await finalizeSyncUpload(req, {
        base: meta.base, rel: meta.rel, mtimeMs: meta.mtimeMs, stableId: meta.stableId,
        expectedHash: meta.expectedHash, deviceId: meta.deviceId, contentHash: meta.contentHash,
        tempPath: paths.part, reservation: { id: meta.reservationId!, bytes: meta.size },
        beforeCommit: async (commitRel, conflict) => {
          meta.commitRel = commitRel; meta.commitConflict = conflict; meta.updatedAt = Date.now();
          await writeResumeMeta(meta);
        },
      });
      const status = Number(result?.status || 200);
      if (status !== 200) return res.status(status).json(result);
      meta.status = 'completed'; meta.offset = meta.size; meta.result = result; meta.updatedAt = Date.now();
      await writeResumeMeta(meta);
      if (meta.reservationId) writes.releaseStorage(meta.reservationId);
      await fsp.rm(paths.part, { force: true }).catch(() => {});
      res.json(result);
    });
  } catch (error) { next(error); }
});

r.get('/conflicts', (req: AuthedRequest, res) => {
  const items = db.prepare(`SELECT id,base,rel_path relPath,device_size deviceSize,device_mtime deviceMtime,
    server_size serverSize,server_mtime serverMtime,status,resolution,created_at createdAt,updated_at updatedAt
    FROM sync_conflicts WHERE user_id=? AND status='open' ORDER BY updated_at DESC`).all(u(req).id);
  res.json({ items });
});

r.post('/conflicts/:id/resolve', (req: AuthedRequest, res) => {
  const id = String(req.params.id); const action = String(req.body?.action || '');
  if (!['device', 'server', 'dismiss'].includes(action)) return res.status(400).json({ error: 'invalid_resolution' });
  const result = action === 'dismiss'
    ? db.prepare("UPDATE sync_conflicts SET status='dismissed',resolution=NULL,updated_at=datetime('now') WHERE id=? AND user_id=?").run(id, u(req).id)
    : db.prepare("UPDATE sync_conflicts SET status='resolved',resolution=?,updated_at=datetime('now') WHERE id=? AND user_id=?").run(action, id, u(req).id);
  if (!result.changes) return res.status(404).json({ error: 'not_found' });
  audit(u(req).id, u(req).username, 'sync_conflict_resolved', id, undefined, { action });
  res.json({ ok: true });
});

r.get('/list', async (req: AuthedRequest, res, next) => {
  try {
    const base = cleanBase(String(req.query.base || ''));
    res.json({ files: await listFiles(u(req).username, base) });
  } catch (e) { next(e); }
});

r.get('/bases', async (req: AuthedRequest, res, next) => {
  try {
    const cached = basesCache.get(u(req).id);
    if (cached && Date.now() - cached.ts < 30_000) return res.json(cached.data);
    const syncRoot = await realFor(u(req).username, 'Sync');
    const bases: any[] = [];
    let entries: fs.Dirent[] = [];
    try { entries = await fsp.readdir(syncRoot, { withFileTypes: true }); } catch { entries = []; }
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue;
      const full = path.join(syncRoot, entry.name);
      let st: fs.Stats;
      try { st = await fsp.lstat(full); } catch { continue; }
      if (!st.isDirectory()) continue;
      const files = await listFiles(u(req).username, `Sync/${entry.name}`);
      bases.push({
        base: `Sync/${entry.name}`,
        files: files.length,
        bytes: files.reduce((a, f) => a + f.size, 0),
        lastChange: files.reduce((a, f) => Math.max(a, f.mtimeMs), st.mtimeMs),
      });
    }
    const data = { bases };
    basesCache.set(u(req).id, { ts: Date.now(), data });
    res.json(data);
  } catch (e) { next(e); }
});

r.get('/file', async (req: AuthedRequest, res, next) => {
  try {
    const base = cleanBase(String(req.query.base || ''));
    const rel = cleanRel(String(req.query.rel || ''));
    const result = await withSyncLock(u(req).id, base, async () => {
      const real = await realFor(u(req).username, base, rel);
      const stat = await fsp.stat(real);
      if (!stat.isFile()) throw Object.assign(new Error('not_file'), { status: 400 });
      let entry = activeByPath(u(req).id, base, rel);
      if (!entry || entry.size !== stat.size || Math.abs(entry.mtime_ms - stat.mtimeMs) >= 1) {
        await reconcileBase(u(req).id, base, await realFor(u(req).username, base));
        entry = activeByPath(u(req).id, base, rel);
      }
      if (!entry) throw Object.assign(new Error('not_found'), { status: 404 });
      return { real, stat, entry };
    });
    const { real, stat: st, entry } = result;
    const etag = `\"sha256-${entry.content_hash}\"`;
    res.setHeader('Content-Type', (mime.lookup(path.basename(real)) || 'application/octet-stream') as string);
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('ETag', etag);
    res.setHeader('X-Content-SHA256', entry.content_hash);
    res.setHeader('X-Stable-Id', entry.stable_id);
    res.setHeader('X-Mtime-Ms', String(st.mtimeMs));
    if (!req.headers.range && req.headers['if-none-match'] === etag) return res.status(304).end();

    const rangeHeader = req.headers['if-range'] && req.headers['if-range'] !== etag ? undefined : req.headers.range;
    const range = parseByteRange(rangeHeader, st.size);
    if (rangeHeader && !range) {
      res.setHeader('Content-Range', `bytes */${st.size}`);
      return res.status(416).end();
    }
    if (range) {
      res.status(206);
      res.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${st.size}`);
      res.setHeader('Content-Length', String(range.end - range.start + 1));
      const stream = fs.createReadStream(real, range);
      stream.on('error', error => res.destroy(error));
      return stream.pipe(res);
    }
    res.setHeader('Content-Length', String(st.size));
    const stream = fs.createReadStream(real);
    stream.on('error', error => res.destroy(error));
    stream.pipe(res);
  } catch (e) { next(e); }
});

export default r;
