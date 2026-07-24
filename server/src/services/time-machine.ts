import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { config } from '../config.js';
import { db } from '../lib/db.js';
import { timeMachinePaths } from '../lib/persistence-bootstrap.js';
import * as storage from './storage.js';
import * as writes from './storage-write.js';

export type SnapshotEntryType = 'file' | 'directory' | 'symlink';
export type SnapshotEntry = {
  path: string;
  type: SnapshotEntryType;
  size: number;
  mtimeMs: number;
  mode: number;
  ctimeMs?: number;
  ino?: number;
  dev?: number;
  sha256?: string;
  linkTarget?: string;
};

export type SnapshotManifest = {
  format: 1;
  id: string;
  userId: number;
  createdAt: string;
  label: string | null;
  entries: SnapshotEntry[];
  warnings: string[];
};

export type SnapshotSummary = {
  id: string;
  createdAt: string;
  label: string | null;
  entryCount: number;
  fileCount: number;
  totalBytes: number;
  warningCount: number;
  manifestHash: string;
};

export type RetentionPolicy = {
  enabled: boolean;
  intervalHours: number;
  hourlyHours: number;
  dailyDays: number;
  weeklyWeeks: number;
  monthlyMonths: number;
  minimumSnapshots: number;
  maximumBytes: number | null;
  lastSnapshotAt: string | null;
};

export type RestoreMode = 'skip' | 'rename' | 'overwrite';
export type SnapshotTask = {
  id: string;
  status: 'queued' | 'running' | 'completed' | 'failed';
  label: string | null;
  currentPath: string | null;
  processedFiles: number;
  processedBytes: number;
  snapshotId: string | null;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
};

type SnapshotProgress = { path: string; processedFiles: number; processedBytes: number };

const { manifestRoot, objectRoot, tempRoot, restoreRoot } = timeMachinePaths;

// A content capture cannot be resumed midway because a snapshot is committed as
// one immutable manifest. Interrupted tasks are explicit failures; already
// captured CAS objects remain harmless and are reclaimed by the next prune.
db.prepare(`UPDATE time_machine_tasks SET status='failed',error='server_restarted',finished_at=?
  WHERE status IN ('queued','running')`).run(new Date().toISOString());

const DEFAULT_POLICY: RetentionPolicy = {
  enabled: true,
  intervalHours: 24,
  hourlyHours: 48,
  dailyDays: 30,
  weeklyWeeks: 12,
  monthlyMonths: 12,
  minimumSnapshots: 3,
  maximumBytes: null,
  lastSnapshotAt: null,
};

const userOperations = new Map<number, Promise<unknown>>();
const activeObjects = new Map<string, number>();

function httpError(message: string, status: number) {
  return Object.assign(new Error(message), { status });
}

type OperationGuard = () => void;

export function assertTimeMachineUserActive(userId: number): void {
  if (!db.prepare('SELECT 1 FROM users WHERE id=? AND disabled_at IS NULL').get(userId)) {
    throw httpError('account_deactivated', 403);
  }
}

function assertSnapshotTaskActive(taskId: string, userId: number): void {
  if (!db.prepare(`SELECT 1 FROM time_machine_tasks t JOIN users u ON u.id=t.user_id
    WHERE t.id=? AND t.user_id=? AND t.status='running' AND u.disabled_at IS NULL`).get(taskId, userId)) {
    throw httpError('snapshot_task_cancelled', 409);
  }
}

function isOperationCancelled(error: any): boolean {
  return ['account_deactivated', 'snapshot_task_cancelled'].includes(String(error?.message || ''));
}

function quotaAccount(userId: number, username: string) {
  const row = db.prepare(`SELECT storage_quota_bytes FROM users
    WHERE id=? AND username=? COLLATE NOCASE AND disabled_at IS NULL`).get(userId, username) as any;
  if (!row) throw httpError('account_deactivated', 403);
  return {
    id: userId,
    username,
    storageQuotaBytes: row.storage_quota_bytes == null ? null : Number(row.storage_quota_bytes),
  };
}

export function normalizeVirtual(input: unknown, fallback = '/'): string {
  if (input === undefined || input === null || input === '') return fallback;
  if (typeof input !== 'string' || input.includes('\0')) throw httpError('invalid_path', 400);
  const slash = input.replace(/\\/g, '/');
  if (slash.split('/').some(part => part === '..')) throw httpError('invalid_path', 400);
  if (slash.split('/').some(part => part.startsWith('.aerie-time-machine-'))) throw httpError('reserved_path', 400);
  return path.posix.normalize('/' + slash.replace(/^\/+/, ''));
}

function withUserOperation<T>(userId: number, operation: () => Promise<T>): Promise<T> {
  if (userOperations.has(userId)) return Promise.reject(httpError('time_machine_busy', 409));
  const running = operation().finally(() => userOperations.delete(userId));
  userOperations.set(userId, running);
  return running;
}

function objectPath(hash: string): string {
  if (!/^[a-f0-9]{64}$/.test(hash)) throw httpError('invalid_object_hash', 500);
  return path.join(objectRoot, hash.slice(0, 2), hash.slice(2));
}

function retainActive(hash: string) {
  activeObjects.set(hash, (activeObjects.get(hash) || 0) + 1);
}

function releaseActive(hash: string) {
  const count = (activeObjects.get(hash) || 1) - 1;
  if (count > 0) activeObjects.set(hash, count); else activeObjects.delete(hash);
}

async function captureObject(real: string, guard: OperationGuard,
  beforeWrite?: (size: number) => Promise<void>): Promise<{
  sha256: string; size: number; mtimeMs: number; ctimeMs: number; mode: number; ino: number; dev: number;
}> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const temp = path.join(tempRoot, `object-${crypto.randomUUID()}.tmp`);
    let handle: fsp.FileHandle | undefined;
    try {
      guard();
      const noFollow = (fs.constants as any).O_NOFOLLOW || 0;
      handle = await fsp.open(real, fs.constants.O_RDONLY | noFollow);
      const before = await handle.stat();
      if (!before.isFile()) throw httpError('snapshot_source_changed', 409);
      await beforeWrite?.(before.size);
      guard();
      const hash = crypto.createHash('sha256');
      let lastGuard = 0;
      let copied = 0;
      const hasher = new Transform({
        transform(chunk, _encoding, callback) {
          try {
            if (Date.now() - lastGuard >= 250) { guard(); lastGuard = Date.now(); }
            copied += chunk.length;
            // A growing source must never write beyond the bytes reserved for
            // this attempt. Retry from a fresh stat instead.
            if (copied > before.size) throw httpError('snapshot_source_changed', 409);
            hash.update(chunk);
            callback(null, chunk);
          } catch (error: any) { callback(error); }
        },
      });
      await pipeline(handle.createReadStream({ autoClose: false }), hasher, fs.createWriteStream(temp, { flags: 'wx', mode: 0o600 }));
      const after = await handle.stat();
      await handle.close(); handle = undefined;
      if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
        await fsp.rm(temp, { force: true });
        continue;
      }
      const sha256 = hash.digest('hex');
      const destination = objectPath(sha256);
      retainActive(sha256);
      try {
        await fsp.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
        try {
          // link(), unlike rename(), never replaces an existing content object.
          await fsp.link(temp, destination);
          await fsp.chmod(destination, 0o444);
        } catch (error: any) {
          if (error?.code !== 'EEXIST') throw error;
          const existing = await fsp.stat(destination);
          if (existing.size !== after.size) throw httpError('content_store_corrupt', 500);
        }
      } catch (error) {
        releaseActive(sha256);
        throw error;
      } finally {
        await fsp.rm(temp, { force: true });
      }
      return {
        sha256,
        size: after.size,
        mtimeMs: after.mtimeMs,
        ctimeMs: after.ctimeMs,
        mode: after.mode & 0o777,
        ino: after.ino,
        dev: after.dev,
      };
    } catch (error) {
      try { await handle?.close(); } catch { /* best effort */ }
      await fsp.rm(temp, { force: true }).catch(() => {});
      if ((error as any)?.code === 'ENOENT' && attempt < 2) continue;
      if ((error as any)?.message === 'snapshot_source_changed' && attempt < 2) continue;
      throw error;
    }
  }
  throw httpError('snapshot_source_kept_changing', 409);
}

async function hashFile(real: string): Promise<string> {
  const hash = crypto.createHash('sha256');
  const hasher = new Transform({ transform(chunk, _encoding, callback) { hash.update(chunk); callback(null, chunk); } });
  await pipeline(fs.createReadStream(real), hasher);
  return hash.digest('hex');
}

function safeSymlink(root: string, real: string, target: string): boolean {
  if (path.isAbsolute(target)) return false;
  const resolved = path.resolve(path.dirname(real), target);
  return resolved === root || resolved.startsWith(root + path.sep);
}

async function scanForSnapshot(username: string, previousEntries: SnapshotEntry[] = [], onProgress?: (progress: SnapshotProgress) => void,
  guard: OperationGuard = () => {}, beforeCapture?: (virtual: string, size: number) => Promise<void>): Promise<{
  entries: SnapshotEntry[]; warnings: string[]; held: string[];
}> {
  guard();
  const userRoot = await storage.userRootAsync(username);
  const entries: SnapshotEntry[] = [];
  const warnings: string[] = [];
  const held: string[] = [];
  const previousByPath = new Map(previousEntries.map(entry => [entry.path, entry]));
  let processedFiles = 0, processedBytes = 0;

  const walk = async (real: string, virtual: string): Promise<void> => {
    guard();
    let stat: fs.Stats;
    try { stat = await fsp.lstat(real); }
    catch (error: any) { warnings.push(`${virtual}: ${error?.code || 'unreadable'}`); return; }
    const mode = stat.mode & 0o777;
    if (stat.isSymbolicLink()) {
      try {
        const target = await fsp.readlink(real);
        if (!safeSymlink(userRoot, real, target)) warnings.push(`${virtual}: unsafe symlink skipped`);
        else entries.push({ path: virtual, type: 'symlink', size: Buffer.byteLength(target), mtimeMs: stat.mtimeMs, mode, linkTarget: target });
      } catch (error: any) { warnings.push(`${virtual}: ${error?.code || 'unreadable symlink'}`); }
      return;
    }
    if (stat.isDirectory()) {
      entries.push({ path: virtual, type: 'directory', size: 0, mtimeMs: stat.mtimeMs, mode });
      let children: fs.Dirent[];
      try { children = await fsp.readdir(real, { withFileTypes: true }); }
      catch (error: any) { warnings.push(`${virtual}: ${error?.code || 'unreadable directory'}`); return; }
      children.sort((a, b) => a.name.localeCompare(b.name));
      for (const child of children) {
        guard();
        if (child.name.startsWith('.aerie-time-machine-')) continue;
        const childVirtual = virtual === '/' ? `/${child.name}` : `${virtual}/${child.name}`;
        await walk(path.join(real, child.name), childVirtual);
      }
      return;
    }
    if (!stat.isFile()) { warnings.push(`${virtual}: unsupported file type skipped`); return; }
    try {
      const previous = previousByPath.get(virtual);
      if (previous?.type === 'file' && previous.sha256 && previous.size === stat.size && previous.mtimeMs === stat.mtimeMs
        && previous.ctimeMs === stat.ctimeMs && previous.ino === stat.ino && previous.dev === stat.dev) {
        const existing = await fsp.stat(objectPath(previous.sha256)).catch(() => null);
        if (existing?.isFile() && existing.size === stat.size) {
          retainActive(previous.sha256);
          held.push(previous.sha256);
          entries.push({ ...previous, mode, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs, ino: stat.ino, dev: stat.dev });
          processedFiles++; processedBytes += stat.size;
          onProgress?.({ path: virtual, processedFiles, processedBytes });
          return;
        }
      }
      const object = await captureObject(real, guard, size => beforeCapture?.(virtual, size) || Promise.resolve());
      guard();
      held.push(object.sha256);
      entries.push({ path: virtual, type: 'file', size: object.size, mtimeMs: object.mtimeMs, ctimeMs: object.ctimeMs,
        mode: object.mode, ino: object.ino, dev: object.dev, sha256: object.sha256 });
      processedFiles++; processedBytes += object.size;
      onProgress?.({ path: virtual, processedFiles, processedBytes });
    } catch (error: any) {
      if (isOperationCancelled(error) || Number(error?.status) === 507) throw error;
      warnings.push(`${virtual}: ${error?.message || error?.code || 'capture failed'}`);
    }
  };

  try {
    await walk(userRoot, '/');
    entries.sort((a, b) => a.path.localeCompare(b.path));
    return { entries, warnings, held };
  } catch (error) {
    for (const hash of held) releaseActive(hash);
    throw error;
  }
}

function addBytes(total: number, bytes: number): number {
  const next = total + Math.max(0, Number(bytes) || 0);
  if (!Number.isSafeInteger(next)) throw httpError('snapshot_too_large', 413);
  return next;
}

// Read-only metadata preflight. It reserves a safe upper bound before capture
// creates any temporary/CAS bytes, while unchanged files reuse the previous
// immutable object and therefore need no additional reservation.
async function captureUpperBound(username: string, previousEntries: SnapshotEntry[], guard: OperationGuard): Promise<number> {
  const root = await storage.userRootAsync(username);
  const previousByPath = new Map(previousEntries.map(entry => [entry.path, entry]));
  let total = 0;
  const walk = async (real: string, virtual: string): Promise<void> => {
    guard();
    let stat: fs.Stats;
    try { stat = await fsp.lstat(real); } catch { return; }
    if (stat.isSymbolicLink()) return;
    if (stat.isDirectory()) {
      let children: fs.Dirent[];
      try { children = await fsp.readdir(real, { withFileTypes: true }); } catch { return; }
      for (const child of children) {
        guard();
        if (child.name.startsWith('.aerie-time-machine-')) continue;
        await walk(path.join(real, child.name), virtual === '/' ? `/${child.name}` : `${virtual}/${child.name}`);
      }
      return;
    }
    if (!stat.isFile()) return;
    const previous = previousByPath.get(virtual);
    if (previous?.type === 'file' && previous.sha256 && previous.size === stat.size
      && previous.mtimeMs === stat.mtimeMs && previous.ctimeMs === stat.ctimeMs
      && previous.ino === stat.ino && previous.dev === stat.dev) {
      const object = await fsp.stat(objectPath(previous.sha256)).catch(() => null);
      if (object?.isFile() && object.size === stat.size) return;
    }
    total = addBytes(total, stat.size);
  };
  await walk(root, '/');
  return total;
}

function manifestPath(userId: number, snapshotId: string) {
  return path.join(manifestRoot, String(userId), `${snapshotId}.json`);
}

function rowToSummary(row: any): SnapshotSummary {
  return {
    id: row.id,
    createdAt: row.created_at,
    label: row.label || null,
    entryCount: row.entry_count,
    fileCount: row.file_count,
    totalBytes: row.total_bytes,
    warningCount: row.warning_count || 0,
    manifestHash: row.manifest_hash,
  };
}

export async function createSnapshot(userId: number, username: string, label?: string,
  onProgress?: (progress: SnapshotProgress) => void, operationGuard?: OperationGuard): Promise<SnapshotSummary> {
  return withUserOperation(userId, async () => {
    const baseGuard = operationGuard || (() => assertTimeMachineUserActive(userId));
    const reservations: writes.StorageReservation[] = [];
    let lastReservationRefresh = Date.now();
    const guard = () => {
      baseGuard();
      if (reservations.length && Date.now() - lastReservationRefresh >= 15 * 60_000) {
        for (const reservation of reservations) writes.refreshStorageReservation(reservation);
        lastReservationRefresh = Date.now();
      }
    };
    guard();
    const account = quotaAccount(userId, username);
    const id = `tm_${Date.now().toString(36)}_${crypto.randomBytes(5).toString('hex')}`;
    const createdAt = new Date().toISOString();
    const safeLabel = String(label || '').trim().slice(0, 120) || null;
    const destination = manifestPath(userId, id);
    const temp = `${destination}.${crypto.randomUUID()}.tmp`;
    let scanned: Awaited<ReturnType<typeof scanForSnapshot>> | null = null;
    let attemptedCapture = false;
    let committed = false;
    let previousEntries: SnapshotEntry[] = [];
    try {
      const previous = db.prepare('SELECT id FROM time_machine_snapshots WHERE user_id=? ORDER BY created_at DESC LIMIT 1').get(userId) as any;
      if (previous?.id) {
        try { guard(); previousEntries = (await loadManifest(userId, previous.id)).entries; }
        catch (error) {
          if (isOperationCancelled(error)) throw error;
          // A damaged older snapshot must not prevent a fresh one.
        }
      }
      guard();
      const preflightBytes = await captureUpperBound(username, previousEntries, guard);
      if (preflightBytes > 0) reservations.push(
        await writes.reserveStorageOperation(account, preflightBytes, preflightBytes, objectRoot));
      let captureReserved = preflightBytes;
      let captureDemand = 0;
      const pathDemand = new Map<string, number>();
      attemptedCapture = true;
      scanned = await scanForSnapshot(username, previousEntries, onProgress, guard, async (virtual, size) => {
        guard();
        const prior = pathDemand.get(virtual) || 0;
        if (size <= prior) return;
        captureDemand = addBytes(captureDemand, size - prior);
        pathDemand.set(virtual, size);
        if (captureDemand > captureReserved) {
          const extra = captureDemand - captureReserved;
          reservations.push(await writes.reserveStorageOperation(account, extra, extra, objectRoot));
          captureReserved += extra;
        }
      });
      // CAS objects are now materialized and statfs already includes them; keep
      // their quota reservation but stop treating them as future disk writes.
      for (const reservation of reservations) writes.settleStorageReservationPhysical(reservation);
      guard();
      const manifest: SnapshotManifest = { format: 1, id, userId, createdAt, label: safeLabel, entries: scanned.entries, warnings: scanned.warnings };
      const bytes = Buffer.from(JSON.stringify(manifest));
      reservations.push(await writes.reserveStorageOperation(account, bytes.length, bytes.length, manifestRoot));
      guard();
      const manifestHash = crypto.createHash('sha256').update(bytes).digest('hex');
      guard();
      await fsp.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
      guard();
      await fsp.writeFile(temp, bytes, { flag: 'wx', mode: 0o600 });
      guard();
      await fsp.rename(temp, destination);
      guard();
      await fsp.chmod(destination, 0o444);
      const fileCount = manifest.entries.filter(entry => entry.type === 'file').length;
      const totalBytes = manifest.entries.reduce((sum, entry) => sum + (entry.type === 'file' ? entry.size : 0), 0);
      db.transaction(() => {
        guard();
        db.prepare(`INSERT INTO time_machine_snapshots
          (id,user_id,created_at,label,manifest_path,manifest_hash,entry_count,file_count,total_bytes,warning_count)
          VALUES (?,?,?,?,?,?,?,?,?,?)`).run(id, userId, createdAt, safeLabel, destination, manifestHash,
            manifest.entries.length, fileCount, totalBytes, manifest.warnings.length);
        db.prepare(`INSERT INTO time_machine_retention (user_id,last_snapshot_at) VALUES (?,?)
          ON CONFLICT(user_id) DO UPDATE SET last_snapshot_at=excluded.last_snapshot_at`).run(userId, createdAt);
      })();
      committed = true;
      return { id, createdAt, label: safeLabel, entryCount: manifest.entries.length, fileCount, totalBytes,
        warningCount: manifest.warnings.length, manifestHash };
    } catch (error) {
      await fsp.rm(temp, { force: true }).catch(() => {});
      await fsp.rm(destination, { force: true }).catch(() => {});
      throw error;
    } finally {
      if (scanned) for (const hash of scanned.held) releaseActive(hash);
      for (const reservation of reservations) writes.releaseStorage(reservation);
      if (!committed && attemptedCapture) await garbageCollectObjects().catch(() => {});
    }
  });
}

export function listSnapshots(userId: number): SnapshotSummary[] {
  return (db.prepare('SELECT * FROM time_machine_snapshots WHERE user_id=? ORDER BY created_at DESC').all(userId) as any[]).map(rowToSummary);
}

function rowToTask(row: any): SnapshotTask {
  return {
    id: row.id,
    status: row.status,
    label: row.label || null,
    currentPath: row.current_path || null,
    processedFiles: Number(row.processed_files || 0),
    processedBytes: Number(row.processed_bytes || 0),
    snapshotId: row.snapshot_id || null,
    error: row.error || null,
    createdAt: row.created_at,
    startedAt: row.started_at || null,
    finishedAt: row.finished_at || null,
  };
}

export function getSnapshotTask(userId: number, taskId: string): SnapshotTask {
  const row = db.prepare('SELECT * FROM time_machine_tasks WHERE id=? AND user_id=?').get(taskId, userId) as any;
  if (!row) throw httpError('snapshot_task_not_found', 404);
  return rowToTask(row);
}

export function getLatestSnapshotTask(userId: number): SnapshotTask | null {
  const row = db.prepare('SELECT * FROM time_machine_tasks WHERE user_id=? ORDER BY created_at DESC LIMIT 1').get(userId) as any;
  return row ? rowToTask(row) : null;
}

async function executeSnapshotTask(taskId: string, userId: number, username: string, label: string | null) {
  const startedAt = new Date().toISOString();
  const claimed = db.prepare(`UPDATE time_machine_tasks SET status='running',started_at=?,current_path='/'
    WHERE id=? AND user_id=? AND status='queued'
      AND EXISTS (SELECT 1 FROM users WHERE id=? AND disabled_at IS NULL)`)
    .run(startedAt, taskId, userId, userId);
  if (!claimed.changes) return;
  const guard = () => assertSnapshotTaskActive(taskId, userId);
  let lastProgressWrite = 0;
  try {
    const snapshot = await createSnapshot(userId, username, label || undefined, progress => {
      guard();
      const now = Date.now();
      if (now - lastProgressWrite < 500 && progress.processedFiles % 50 !== 0) return;
      lastProgressWrite = now;
      const updated = db.prepare(`UPDATE time_machine_tasks SET current_path=?,processed_files=?,processed_bytes=?
        WHERE id=? AND user_id=? AND status='running'
          AND EXISTS (SELECT 1 FROM users WHERE id=? AND disabled_at IS NULL)`)
        .run(progress.path, progress.processedFiles, progress.processedBytes, taskId, userId, userId);
      if (!updated.changes) throw httpError('snapshot_task_cancelled', 409);
    }, guard);
    guard();
    try { await pruneSnapshots(userId, guard); } catch { /* retention can run on the next schedule */ }
    guard();
    const finishedAt = new Date().toISOString();
    const completed = db.prepare(`UPDATE time_machine_tasks SET status='completed',snapshot_id=?,current_path=NULL,
      processed_files=?,processed_bytes=?,finished_at=? WHERE id=? AND user_id=? AND status='running'
        AND EXISTS (SELECT 1 FROM users WHERE id=? AND disabled_at IS NULL)`).run(snapshot.id, snapshot.fileCount,
          snapshot.totalBytes, finishedAt, taskId, userId, userId);
    if (!completed.changes) return;
    try {
      const hooks = await import('../lib/db.js');
      assertTimeMachineUserActive(userId);
      hooks.audit(userId, username, 'time_machine_snapshot', snapshot.id);
      assertTimeMachineUserActive(userId);
      hooks.notify(userId, 'Time Machine snapshot complete', `${snapshot.fileCount} files protected`, 'success', '/time-machine');
    } catch { /* completion is committed even if notification delivery fails */ }
  } catch (error: any) {
    const message = String(error?.message || 'snapshot_failed').slice(0, 500);
    const failed = db.prepare(`UPDATE time_machine_tasks SET status='failed',error=?,finished_at=?
      WHERE id=? AND user_id=? AND status='running'
        AND EXISTS (SELECT 1 FROM users WHERE id=? AND disabled_at IS NULL)`)
      .run(message, new Date().toISOString(), taskId, userId, userId);
    if (!failed.changes) return;
    try {
      const hooks = await import('../lib/db.js');
      assertTimeMachineUserActive(userId);
      hooks.audit(userId, username, 'time_machine_snapshot_failed', taskId, undefined, { error: message });
      assertTimeMachineUserActive(userId);
      hooks.notify(userId, 'Time Machine snapshot failed', message, 'error', '/time-machine');
    } catch { /* task failure remains visible through polling */ }
  }
}

export function queueSnapshot(userId: number, username: string, label?: string): SnapshotTask {
  assertTimeMachineUserActive(userId);
  const active = db.prepare(`SELECT id FROM time_machine_tasks WHERE user_id=? AND status IN ('queued','running') LIMIT 1`).get(userId) as any;
  if (active || userOperations.has(userId)) throw httpError('time_machine_busy', 409);
  const id = `tmt_${Date.now().toString(36)}_${crypto.randomBytes(5).toString('hex')}`;
  const createdAt = new Date().toISOString();
  const safeLabel = String(label || '').trim().slice(0, 120) || null;
  db.prepare(`INSERT INTO time_machine_tasks (id,user_id,status,label,created_at) VALUES (?,?,'queued',?,?)`)
    .run(id, userId, safeLabel, createdAt);
  // Keep task history bounded without touching active or snapshot metadata.
  db.prepare(`DELETE FROM time_machine_tasks WHERE user_id=? AND status IN ('completed','failed') AND id NOT IN
    (SELECT id FROM time_machine_tasks WHERE user_id=? ORDER BY created_at DESC LIMIT 50)`).run(userId, userId);
  // Start immediately far enough to acquire the per-user operation lock before
  // another restore/snapshot request can race this queued task. The async file
  // scan yields back to the HTTP handler without holding up the response.
  void executeSnapshotTask(id, userId, username, safeLabel);
  return getSnapshotTask(userId, id);
}

async function loadManifest(userId: number, snapshotId: string): Promise<SnapshotManifest> {
  const row = db.prepare('SELECT * FROM time_machine_snapshots WHERE id=? AND user_id=?').get(snapshotId, userId) as any;
  if (!row) throw httpError('snapshot_not_found', 404);
  let bytes: Buffer;
  try { bytes = await fsp.readFile(row.manifest_path); }
  catch { throw httpError('snapshot_manifest_missing', 409); }
  const actual = crypto.createHash('sha256').update(bytes).digest('hex');
  const expected = String(row.manifest_hash || '');
  if (actual.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(actual), Buffer.from(expected))) {
    throw httpError('snapshot_integrity_failed', 409);
  }
  let manifest: SnapshotManifest;
  try { manifest = JSON.parse(bytes.toString('utf8')); }
  catch { throw httpError('snapshot_manifest_invalid', 409); }
  if (manifest.format !== 1 || manifest.id !== snapshotId || manifest.userId !== userId || !Array.isArray(manifest.entries)) {
    throw httpError('snapshot_manifest_invalid', 409);
  }
  return manifest;
}

function underPath(entryPath: string, parent: string): boolean {
  return parent === '/' || entryPath === parent || entryPath.startsWith(parent + '/');
}

export async function browseSnapshot(userId: number, snapshotId: string, inputPath: unknown) {
  const virtual = normalizeVirtual(inputPath);
  const manifest = await loadManifest(userId, snapshotId);
  const selected = manifest.entries.find(entry => entry.path === virtual);
  if (!selected) throw httpError('snapshot_path_not_found', 404);
  if (selected.type !== 'directory') return { path: virtual, entry: selected, entries: [] as SnapshotEntry[], warnings: manifest.warnings };
  const entries = manifest.entries.filter(entry => entry.path !== virtual && path.posix.dirname(entry.path) === virtual);
  return { path: virtual, entry: selected, entries, warnings: virtual === '/' ? manifest.warnings : [] };
}

async function scanCurrent(username: string, selectedPath: string, baseline: SnapshotEntry[]): Promise<SnapshotEntry[]> {
  const userRoot = await storage.userRootAsync(username);
  const selectedReal = await storage.resolveAsync(username, selectedPath);
  const entries: SnapshotEntry[] = [];
  const baselineByPath = new Map(baseline.map(entry => [entry.path, entry]));
  const walk = async (real: string, virtual: string): Promise<void> => {
    let stat: fs.Stats;
    try { stat = await fsp.lstat(real); } catch (error: any) { if (error?.code === 'ENOENT') return; throw error; }
    const mode = stat.mode & 0o777;
    if (stat.isSymbolicLink()) {
      const target = await fsp.readlink(real);
      if (safeSymlink(userRoot, real, target)) entries.push({ path: virtual, type: 'symlink', size: Buffer.byteLength(target), mtimeMs: stat.mtimeMs, mode, linkTarget: target });
    } else if (stat.isDirectory()) {
      entries.push({ path: virtual, type: 'directory', size: 0, mtimeMs: stat.mtimeMs, mode });
      const children = await fsp.readdir(real, { withFileTypes: true });
      children.sort((a, b) => a.name.localeCompare(b.name));
      for (const child of children) {
        if (child.name.startsWith('.aerie-time-machine-')) continue;
        await walk(path.join(real, child.name), virtual === '/' ? `/${child.name}` : `${virtual}/${child.name}`);
      }
    } else if (stat.isFile()) {
      const previous = baselineByPath.get(virtual);
      const sha256 = previous?.type === 'file' && previous.sha256 && previous.size === stat.size
        && previous.mtimeMs === stat.mtimeMs && previous.ctimeMs === stat.ctimeMs && previous.ino === stat.ino && previous.dev === stat.dev
        ? previous.sha256 : await hashFile(real);
      entries.push({ path: virtual, type: 'file', size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs,
        mode, ino: stat.ino, dev: stat.dev, sha256 });
    }
  };
  await walk(selectedReal, selectedPath);
  return entries;
}

function entriesDiffer(a: SnapshotEntry, b: SnapshotEntry): boolean {
  if (a.type !== b.type) return true;
  if (a.type === 'file') return a.sha256 !== b.sha256;
  if (a.type === 'symlink') return a.linkTarget !== b.linkTarget;
  return false;
}

export async function diffSnapshot(userId: number, username: string, snapshotId: string, against: string, inputPath: unknown,
  offset = 0, limit = 500) {
  const virtual = normalizeVirtual(inputPath);
  const base = await loadManifest(userId, snapshotId);
  const baseEntries = base.entries.filter(entry => underPath(entry.path, virtual));
  const targetEntries = against === 'current'
    ? await scanCurrent(username, virtual, baseEntries)
    : (await loadManifest(userId, against)).entries.filter(entry => underPath(entry.path, virtual));
  const left = new Map(baseEntries.map(entry => [entry.path, entry]));
  const right = new Map(targetEntries.map(entry => [entry.path, entry]));
  const paths = [...new Set([...left.keys(), ...right.keys()])].sort();
  const changes: { path: string; change: 'added' | 'removed' | 'modified' | 'type-changed'; before?: SnapshotEntry; after?: SnapshotEntry }[] = [];
  const summary = { added: 0, removed: 0, modified: 0, typeChanged: 0, unchanged: 0 };
  for (const itemPath of paths) {
    const before = left.get(itemPath), after = right.get(itemPath);
    if (!before && after) { summary.added++; changes.push({ path: itemPath, change: 'added', after }); }
    else if (before && !after) { summary.removed++; changes.push({ path: itemPath, change: 'removed', before }); }
    else if (before && after && before.type !== after.type) {
      summary.typeChanged++; changes.push({ path: itemPath, change: 'type-changed', before, after });
    } else if (before && after && entriesDiffer(before, after)) {
      summary.modified++; changes.push({ path: itemPath, change: 'modified', before, after });
    } else summary.unchanged++;
  }
  return { against, path: virtual, summary, total: changes.length, offset, limit, changes: changes.slice(offset, offset + limit) };
}

async function stageEntry(entry: SnapshotEntry, stagePath: string, finalPath: string, userRoot: string,
  guard: OperationGuard): Promise<void> {
  guard();
  await fsp.mkdir(path.dirname(stagePath), { recursive: true, mode: 0o700 });
  if (entry.type === 'directory') {
    await fsp.mkdir(stagePath, { recursive: true, mode: entry.mode & 0o777 });
    return;
  }
  if (entry.type === 'symlink') {
    if (!entry.linkTarget || !safeSymlink(userRoot, finalPath, entry.linkTarget)) throw httpError('unsafe_snapshot_symlink', 409);
    await fsp.symlink(entry.linkTarget, stagePath);
    return;
  }
  if (!entry.sha256) throw httpError('snapshot_object_missing', 409);
  const source = objectPath(entry.sha256);
  const hash = crypto.createHash('sha256');
  let lastGuard = 0;
  let copied = 0;
  const hasher = new Transform({
    transform(chunk, _encoding, callback) {
      try {
        if (Date.now() - lastGuard >= 250) { guard(); lastGuard = Date.now(); }
        copied += chunk.length;
        if (copied > entry.size) throw httpError('snapshot_object_corrupt', 409);
        hash.update(chunk);
        callback(null, chunk);
      } catch (error: any) { callback(error); }
    },
  });
  try { await pipeline(fs.createReadStream(source), hasher, fs.createWriteStream(stagePath, { flags: 'wx', mode: entry.mode & 0o777 })); }
  catch (error: any) { if (error?.code === 'ENOENT') throw httpError('snapshot_object_missing', 409); throw error; }
  if (hash.digest('hex') !== entry.sha256) throw httpError('snapshot_object_corrupt', 409);
  await fsp.chmod(stagePath, entry.mode & 0o777);
  await fsp.utimes(stagePath, new Date(entry.mtimeMs), new Date(entry.mtimeMs));
}

async function exists(real: string) {
  try { await fsp.lstat(real); return true; } catch (error: any) { if (error?.code === 'ENOENT') return false; throw error; }
}

function restoredName(virtual: string): string {
  const stamp = new Date().toISOString().slice(0, 10);
  const dir = path.posix.dirname(virtual);
  const extension = path.posix.extname(virtual);
  const base = path.posix.basename(virtual, extension);
  return path.posix.join(dir, `${base} (restored ${stamp})${extension}`);
}

async function uniqueDestination(username: string, preferred: string): Promise<string> {
  let candidate = preferred;
  for (let n = 2; await exists(await storage.resolveAsync(username, candidate)); n++) {
    const extension = path.posix.extname(preferred);
    candidate = path.posix.join(path.posix.dirname(preferred), `${path.posix.basename(preferred, extension)} ${n}${extension}`);
  }
  return candidate;
}

async function assertSafeDestinationParents(username: string, virtual: string): Promise<void> {
  const root = await storage.userRootAsync(username);
  const parts = normalizeVirtual(virtual).split('/').filter(Boolean).slice(0, -1);
  let current = root;
  for (const part of parts) {
    current = path.join(current, part);
    try {
      const stat = await fsp.lstat(current);
      if (stat.isSymbolicLink()) throw httpError('unsafe_destination_symlink', 409);
      if (!stat.isDirectory()) throw httpError('destination_parent_not_directory', 409);
    } catch (error: any) {
      if (error?.code === 'ENOENT') return;
      throw error;
    }
  }
}

function snapshotFileBytes(entries: SnapshotEntry[]): number {
  return entries.reduce((total, entry) => entry.type === 'file' ? addBytes(total, entry.size) : total, 0);
}

async function treeFileBytes(target: string): Promise<number> {
  let stat: fs.Stats;
  try { stat = await fsp.lstat(target); } catch (error: any) {
    if (error?.code === 'ENOENT') return 0;
    throw error;
  }
  if (stat.isSymbolicLink()) return 0;
  if (stat.isFile()) return stat.size;
  if (!stat.isDirectory()) return 0;
  let total = 0;
  for (const child of await fsp.readdir(target)) total = addBytes(total, await treeFileBytes(path.join(target, child)));
  return total;
}

// Mirrors mergeSkipping without writing: a file is restored only when the first
// missing component is reached. An existing leaf or non-directory ancestor is
// skipped. This gives quota the actual final delta while the separate physical
// reservation still covers the complete staged snapshot payload.
async function skipRestoreBytes(username: string, sourcePath: string, destinationPath: string,
  relevant: SnapshotEntry[]): Promise<number> {
  const destination = await storage.resolveAsync(username, destinationPath);
  const kinds = new Map<string, 'missing' | 'directory' | 'other'>();
  const kind = async (target: string) => {
    const cached = kinds.get(target);
    if (cached) return cached;
    let value: 'missing' | 'directory' | 'other';
    try { value = (await fsp.lstat(target)).isDirectory() ? 'directory' : 'other'; }
    catch (error: any) { if (error?.code === 'ENOENT') value = 'missing'; else throw error; }
    kinds.set(target, value);
    return value;
  };
  let total = 0;
  for (const entry of relevant) {
    if (entry.type !== 'file') continue;
    const relative = sourcePath === '/' ? entry.path.slice(1) : path.posix.relative(sourcePath, entry.path);
    const components = relative ? relative.split('/') : [];
    const candidates = [destination];
    let current = destination;
    for (const component of components) { current = path.join(current, component); candidates.push(current); }
    let restored = false;
    for (let index = 0; index < candidates.length; index++) {
      const existing = await kind(candidates[index]);
      if (existing === 'missing') { restored = true; break; }
      if (index === candidates.length - 1 || existing !== 'directory') break;
    }
    if (restored) total = addBytes(total, entry.size);
  }
  return total;
}

async function restoreQuotaDelta(username: string, sourcePath: string, destinationPath: string,
  mode: RestoreMode, relevant: SnapshotEntry[], sourceBytes: number): Promise<number> {
  if (mode === 'rename') return sourceBytes;
  if (mode === 'skip') return skipRestoreBytes(username, sourcePath, destinationPath, relevant);
  const destination = await storage.resolveAsync(username, destinationPath);
  return Math.max(0, sourceBytes - await treeFileBytes(destination));
}

async function mergeSkipping(source: string, destination: string, guard: OperationGuard): Promise<{ restored: number; skipped: number }> {
  guard();
  if (!(await exists(destination))) { await storage.safeMove(source, destination); return { restored: 1, skipped: 0 }; }
  const sourceStat = await fsp.lstat(source), destinationStat = await fsp.lstat(destination);
  if (!sourceStat.isDirectory() || !destinationStat.isDirectory()) return { restored: 0, skipped: 1 };
  let restored = 0, skipped = 0;
  for (const child of await fsp.readdir(source)) {
    const result = await mergeSkipping(path.join(source, child), path.join(destination, child), guard);
    restored += result.restored; skipped += result.skipped;
  }
  await fsp.rm(source, { recursive: true, force: true });
  return { restored, skipped };
}

async function reconcileRestoredSync(userId: number, username: string, destinationPath: string) {
  try {
    const sync = await import('./sync-fabric.js');
    await sync.reconcileRestoredPath(userId, await storage.userRootAsync(username), destinationPath);
    return { reconciled: true as const };
  } catch (error: any) {
    // The restore is already committed at this point. Reporting a post-commit
    // failure as if the restore failed would invite a destructive retry; Sync
    // Fabric also reconciles again when a device next requests its journal.
    return { reconciled: false as const, error: String(error?.message || 'sync_reconciliation_failed').slice(0, 200) };
  }
}

export async function restoreSnapshot(userId: number, username: string, snapshotId: string, inputPath: unknown,
  inputDestination: unknown, mode: RestoreMode) {
  if (!['skip', 'rename', 'overwrite'].includes(mode)) throw httpError('invalid_restore_mode', 400);
  return withUserOperation(userId, async () => {
    const reservations: writes.StorageReservation[] = [];
    let lastReservationRefresh = Date.now();
    const guard = () => {
      assertTimeMachineUserActive(userId);
      if (reservations.length && Date.now() - lastReservationRefresh >= 15 * 60_000) {
        for (const reservation of reservations) writes.refreshStorageReservation(reservation);
        lastReservationRefresh = Date.now();
      }
    };
    guard();
    const account = quotaAccount(userId, username);
    const sourcePath = normalizeVirtual(inputPath);
    guard();
    const manifest = await loadManifest(userId, snapshotId);
    const selected = manifest.entries.find(entry => entry.path === sourcePath);
    if (!selected) throw httpError('snapshot_path_not_found', 404);
    let destinationPath = inputDestination ? normalizeVirtual(inputDestination) : sourcePath;
    if (sourcePath === '/' && (!inputDestination || destinationPath === '/')) {
      if (mode !== 'rename') throw httpError('root_restore_requires_new_destination', 400);
      destinationPath = `/${restoredName('Aerie restore').replace(/^\//, '')}`;
    }
    if (destinationPath === '/') throw httpError('cannot_replace_storage_root', 400);
    if (mode === 'rename' && await exists(await storage.resolveAsync(username, destinationPath))) {
      destinationPath = await uniqueDestination(username, restoredName(destinationPath));
    }
    guard();
    await assertSafeDestinationParents(username, destinationPath);

    const operationId = `${userId}-${crypto.randomUUID()}`;
    const stageRoot = path.join(restoreRoot, operationId);
    const payload = path.join(stageRoot, 'payload');
    const userRoot = await storage.userRootAsync(username);
    const relevant = manifest.entries.filter(entry => underPath(entry.path, sourcePath));
    const sourceBytes = snapshotFileBytes(relevant);
    const directories: { entry: SnapshotEntry; staged: string }[] = [];
    let quotaReserved = 0;
    try {
      const initialDelta = await restoreQuotaDelta(username, sourcePath, destinationPath, mode, relevant, sourceBytes);
      if (initialDelta > 0 || sourceBytes > 0) {
        reservations.push(await writes.reserveStorageOperation(account, initialDelta, sourceBytes, restoreRoot));
        quotaReserved = initialDelta;
      }
      const ensureCurrentDelta = async () => {
        guard();
        const current = await restoreQuotaDelta(username, sourcePath, destinationPath, mode, relevant, sourceBytes);
        if (current > quotaReserved) {
          const extra = current - quotaReserved;
          reservations.push(await writes.reserveStorageOperation(account, extra, 0, restoreRoot));
          quotaReserved += extra;
        }
      };
      for (const entry of relevant) {
        guard();
        const relative = sourcePath === '/' ? entry.path.slice(1) : path.posix.relative(sourcePath, entry.path);
        const staged = relative ? path.join(payload, ...relative.split('/')) : payload;
        const finalVirtual = relative ? path.posix.join(destinationPath, relative) : destinationPath;
        const finalReal = await storage.resolveAsync(username, finalVirtual);
        await stageEntry(entry, staged, finalReal, userRoot, guard);
        if (entry.type === 'directory') directories.push({ entry, staged });
      }
      // Directory timestamps must be applied after their children are written.
      for (const { entry, staged } of directories.reverse()) {
        guard();
        await fsp.chmod(staged, entry.mode & 0o777).catch(() => {});
        guard();
        await fsp.utimes(staged, new Date(entry.mtimeMs), new Date(entry.mtimeMs)).catch(() => {});
      }
      // The complete stage now exists on disk. Retain its quota delta until the
      // commit, but do not double-count materialized bytes as future headroom.
      for (const reservation of reservations) writes.settleStorageReservationPhysical(reservation);
      guard();
      const destination = await storage.resolveAsync(username, destinationPath);
      guard();
      await fsp.mkdir(path.dirname(destination), { recursive: true });
      if (mode === 'skip') {
        await ensureCurrentDelta();
        const result = await mergeSkipping(payload, destination, guard);
        guard();
        const sync = await reconcileRestoredSync(userId, username, destinationPath);
        guard();
        return { snapshotId, sourcePath, destinationPath, mode, ...result, replaced: false, sync };
      }
      if (mode === 'rename') {
        destinationPath = await uniqueDestination(username, destinationPath);
        await ensureCurrentDelta();
        guard();
        await storage.safeMove(payload, await storage.resolveAsync(username, destinationPath));
        guard();
        const sync = await reconcileRestoredSync(userId, username, destinationPath);
        guard();
        return { snapshotId, sourcePath, destinationPath, mode, restored: relevant.length, skipped: 0, replaced: false, sync };
      }
      const rollback = path.join(stageRoot, 'previous');
      await ensureCurrentDelta();
      const hadDestination = await exists(destination);
      guard();
      if (hadDestination) await storage.safeMove(destination, rollback);
      try {
        await storage.safeMove(payload, destination);
      } catch (error) {
        if (hadDestination && await exists(rollback)) await storage.safeMove(rollback, destination).catch(() => {});
        throw error;
      }
      await fsp.rm(rollback, { recursive: true, force: true });
      guard();
      const sync = await reconcileRestoredSync(userId, username, destinationPath);
      guard();
      return { snapshotId, sourcePath, destinationPath, mode, restored: relevant.length, skipped: 0, replaced: hadDestination, sync };
    } finally {
      await fsp.rm(stageRoot, { recursive: true, force: true }).catch(() => {});
      for (const reservation of reservations) writes.releaseStorage(reservation);
    }
  });
}

function ensurePolicy(userId: number) {
  db.prepare('INSERT OR IGNORE INTO time_machine_retention (user_id) VALUES (?)').run(userId);
}

function policyFromRow(row: any): RetentionPolicy {
  return {
    enabled: !!row.enabled,
    intervalHours: row.interval_hours,
    hourlyHours: row.hourly_hours,
    dailyDays: row.daily_days,
    weeklyWeeks: row.weekly_weeks,
    monthlyMonths: row.monthly_months,
    minimumSnapshots: row.minimum_snapshots,
    maximumBytes: row.maximum_bytes ?? null,
    lastSnapshotAt: row.last_snapshot_at || null,
  };
}

export function getRetentionPolicy(userId: number): RetentionPolicy {
  ensurePolicy(userId);
  return policyFromRow(db.prepare('SELECT * FROM time_machine_retention WHERE user_id=?').get(userId));
}

function bounded(value: unknown, min: number, max: number, fallback: number): number {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(min, Math.min(max, Math.floor(number))) : fallback;
}

export function updateRetentionPolicy(userId: number, input: Partial<RetentionPolicy>): RetentionPolicy {
  const current = getRetentionPolicy(userId);
  const next: RetentionPolicy = {
    enabled: typeof input.enabled === 'boolean' ? input.enabled : current.enabled,
    intervalHours: bounded(input.intervalHours, 1, 24 * 30, current.intervalHours),
    hourlyHours: bounded(input.hourlyHours, 0, 24 * 31, current.hourlyHours),
    dailyDays: bounded(input.dailyDays, 0, 3650, current.dailyDays),
    weeklyWeeks: bounded(input.weeklyWeeks, 0, 520, current.weeklyWeeks),
    monthlyMonths: bounded(input.monthlyMonths, 0, 240, current.monthlyMonths),
    minimumSnapshots: bounded(input.minimumSnapshots, 1, 100, current.minimumSnapshots),
    maximumBytes: input.maximumBytes === null ? null : input.maximumBytes === undefined ? current.maximumBytes
      : bounded(input.maximumBytes, 1024 * 1024, Number.MAX_SAFE_INTEGER, current.maximumBytes || 0),
    lastSnapshotAt: current.lastSnapshotAt,
  };
  db.prepare(`UPDATE time_machine_retention SET enabled=?,interval_hours=?,hourly_hours=?,daily_days=?,weekly_weeks=?,
    monthly_months=?,minimum_snapshots=?,maximum_bytes=? WHERE user_id=?`).run(next.enabled ? 1 : 0, next.intervalHours,
      next.hourlyHours, next.dailyDays, next.weeklyWeeks, next.monthlyMonths, next.minimumSnapshots, next.maximumBytes, userId);
  return getRetentionPolicy(userId);
}

function retentionKey(date: Date, tier: 'hour' | 'day' | 'week' | 'month'): string {
  if (tier === 'hour') return date.toISOString().slice(0, 13);
  if (tier === 'day') return date.toISOString().slice(0, 10);
  if (tier === 'month') return date.toISOString().slice(0, 7);
  return String(Math.floor(date.getTime() / (7 * 864e5)));
}

async function garbageCollectObjects(): Promise<{ removedObjects: number; removedBytes: number; skipped: boolean }> {
  const referenced = new Set(activeObjects.keys());
  const rows = db.prepare('SELECT user_id,id,manifest_path,manifest_hash FROM time_machine_snapshots').all() as any[];
  try {
    for (const row of rows) {
      const bytes = await fsp.readFile(row.manifest_path);
      const hash = crypto.createHash('sha256').update(bytes).digest('hex');
      if (hash !== row.manifest_hash) return { removedObjects: 0, removedBytes: 0, skipped: true };
      const manifest = JSON.parse(bytes.toString('utf8')) as SnapshotManifest;
      for (const entry of manifest.entries) if (entry.sha256) referenced.add(entry.sha256);
    }
  } catch {
    // A missing/corrupt manifest means the safe choice is to retain all objects.
    return { removedObjects: 0, removedBytes: 0, skipped: true };
  }
  let removedObjects = 0, removedBytes = 0;
  for (const prefix of await fsp.readdir(objectRoot).catch(() => [] as string[])) {
    const dir = path.join(objectRoot, prefix);
    let files: string[]; try { files = await fsp.readdir(dir); } catch { continue; }
    for (const suffix of files) {
      const hash = prefix + suffix;
      if (!/^[a-f0-9]{64}$/.test(hash) || referenced.has(hash)) continue;
      const file = path.join(dir, suffix);
      try { const stat = await fsp.stat(file); await fsp.rm(file); removedObjects++; removedBytes += stat.size; } catch { /* best effort */ }
    }
    await fsp.rmdir(dir).catch(() => {});
  }
  return { removedObjects, removedBytes, skipped: false };
}

async function pruneUnlocked(userId: number, policy = getRetentionPolicy(userId),
  guard: OperationGuard = () => assertTimeMachineUserActive(userId)) {
  guard();
  const rows = db.prepare('SELECT * FROM time_machine_snapshots WHERE user_id=? ORDER BY created_at DESC').all(userId) as any[];
  const keep = new Set<string>();
  rows.slice(0, policy.minimumSnapshots).forEach(row => keep.add(row.id));
  const buckets = new Set<string>();
  const now = Date.now();
  for (const row of rows) {
    if (keep.has(row.id)) continue;
    const date = new Date(row.created_at), ageHours = Math.max(0, (now - date.getTime()) / 36e5);
    let tier: 'hour' | 'day' | 'week' | 'month' | null = null;
    if (ageHours <= policy.hourlyHours) tier = 'hour';
    else if (ageHours <= policy.dailyDays * 24) tier = 'day';
    else if (ageHours <= policy.weeklyWeeks * 7 * 24) tier = 'week';
    else if (ageHours <= policy.monthlyMonths * 31 * 24) tier = 'month';
    if (!tier) continue;
    const key = `${tier}:${retentionKey(date, tier)}`;
    if (!buckets.has(key)) { buckets.add(key); keep.add(row.id); }
  }
  if (policy.maximumBytes !== null) {
    let total = rows.filter(row => keep.has(row.id)).reduce((sum, row) => sum + Number(row.total_bytes || 0), 0);
    for (const row of [...rows].reverse()) {
      if (total <= policy.maximumBytes) break;
      if (!keep.has(row.id) || rows.indexOf(row) < policy.minimumSnapshots) continue;
      keep.delete(row.id); total -= Number(row.total_bytes || 0);
    }
  }
  const remove = rows.filter(row => !keep.has(row.id));
  const transaction = db.transaction(() => {
    guard();
    for (const row of remove) {
      guard();
      db.prepare('DELETE FROM time_machine_snapshots WHERE id=? AND user_id=?').run(row.id, userId);
    }
  });
  transaction();
  for (const row of remove) {
    guard();
    await fsp.rm(row.manifest_path, { force: true }).catch(() => {});
  }
  guard();
  const gc = await garbageCollectObjects();
  return { removedSnapshots: remove.length, keptSnapshots: keep.size, ...gc };
}

export async function pruneSnapshots(userId: number, guard?: OperationGuard) {
  return withUserOperation(userId, () => pruneUnlocked(userId, getRetentionPolicy(userId), guard));
}

export async function deleteSnapshot(userId: number, snapshotId: string) {
  return withUserOperation(userId, async () => {
    const row = db.prepare('SELECT * FROM time_machine_snapshots WHERE id=? AND user_id=?').get(snapshotId, userId) as any;
    if (!row) throw httpError('snapshot_not_found', 404);
    db.prepare('DELETE FROM time_machine_snapshots WHERE id=? AND user_id=?').run(snapshotId, userId);
    await fsp.rm(row.manifest_path, { force: true }).catch(() => {});
    const gc = await garbageCollectObjects();
    return { deleted: true, ...gc };
  });
}

// Account deletion should call this before removing the user row. It removes
// only that account's manifests; shared content objects survive while any other
// user's immutable manifest still references them.
export async function deleteAllSnapshotsForUser(userId: number) {
  return withUserOperation(userId, async () => {
    const rows = db.prepare('SELECT manifest_path FROM time_machine_snapshots WHERE user_id=?').all(userId) as any[];
    const transaction = db.transaction(() => {
      db.prepare('DELETE FROM time_machine_snapshots WHERE user_id=?').run(userId);
      db.prepare('DELETE FROM time_machine_retention WHERE user_id=?').run(userId);
      db.prepare('DELETE FROM time_machine_tasks WHERE user_id=?').run(userId);
    });
    transaction();
    for (const row of rows) await fsp.rm(row.manifest_path, { force: true }).catch(() => {});
    await fsp.rm(path.join(manifestRoot, String(userId)), { recursive: true, force: true }).catch(() => {});
    const gc = await garbageCollectObjects();
    return { deletedSnapshots: rows.length, ...gc };
  });
}

// The scheduler should call this periodically. It is idempotent per policy
// interval and deliberately catches per-user failures so one account cannot
// prevent the others from being protected.
export async function runDueSnapshots() {
  db.prepare('INSERT OR IGNORE INTO time_machine_retention (user_id) SELECT id FROM users WHERE disabled_at IS NULL').run();
  const due = db.prepare(`SELECT p.*,u.username FROM time_machine_retention p JOIN users u ON u.id=p.user_id
    WHERE p.enabled=1 AND u.disabled_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM time_machine_tasks t WHERE t.user_id=p.user_id AND t.status IN ('queued','running'))
      AND (p.last_snapshot_at IS NULL OR datetime(p.last_snapshot_at, '+' || p.interval_hours || ' hours')<=datetime('now'))`).all() as any[];
  const results: { userId: number; ok: boolean; snapshotId?: string; error?: string }[] = [];
  for (const row of due) {
    try {
      const snapshot = await createSnapshot(row.user_id, row.username, 'Automatic snapshot');
      await pruneSnapshots(row.user_id);
      results.push({ userId: row.user_id, ok: true, snapshotId: snapshot.id });
    } catch (error: any) {
      results.push({ userId: row.user_id, ok: false, error: error?.message || 'snapshot_failed' });
    }
  }
  return results;
}

export { timeMachinePaths };
export const defaultRetentionPolicy = DEFAULT_POLICY;
