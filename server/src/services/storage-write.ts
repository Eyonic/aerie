// One commit path for user-visible file writes. It centralizes policy, quota
// reservations, versions, fsync + atomic replacement, and crash breadcrumbs.
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { User } from '../lib/model.js';
import { config } from '../config.js';
import { db } from '../lib/db.js';
import { assertFileAllowed } from './policy.js';
import * as storage from './storage.js';
import { markFileCatalogStale } from './file-catalog.js';

const RESERVATION_MS = 2 * 3600_000;
const MAX_VERSIONS_PER_FILE = 20;
let reservationTail: Promise<void> = Promise.resolve();

// Filesystem headroom is shared by every account, so reservation checks must be
// serialized globally rather than only per user. Otherwise two users can both
// observe the same free bytes and over-commit the volume concurrently.
async function withReservationLock<T>(operation: () => Promise<T>): Promise<T> {
  const previous = reservationTail;
  let release!: () => void;
  const current = new Promise<void>(resolve => { release = resolve; });
  reservationTail = previous.then(() => current);
  await previous;
  try { return await operation(); }
  finally { release(); }
}

async function treeBytes(target: string): Promise<number> {
  let stat: fs.Stats;
  try { stat = await fsp.lstat(target); } catch { return 0; }
  if (stat.isSymbolicLink()) return 0;
  if (stat.isFile()) return stat.size;
  if (!stat.isDirectory()) return 0;
  let total = 0;
  let entries: fs.Dirent[] = [];
  try { entries = await fsp.readdir(target, { withFileTypes: true }); } catch { return 0; }
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    total += await treeBytes(path.join(target, entry.name));
  }
  return total;
}

async function assertTreeAllowed(target: string): Promise<void> {
  const stat = await fsp.lstat(target);
  if (stat.isSymbolicLink()) throw Object.assign(new Error('unsafe_symlink'), { status: 400 });
  if (stat.isFile()) { assertFileAllowed(path.basename(target), stat.size); return; }
  if (!stat.isDirectory()) throw Object.assign(new Error('unsupported_file_type'), { status: 400 });
  for (const entry of await fsp.readdir(target, { withFileTypes: true })) {
    if (entry.name.startsWith('.aerie-')) continue;
    await assertTreeAllowed(path.join(target, entry.name));
  }
}

async function fileBytes(target: string): Promise<number> {
  try { const stat = await fsp.stat(target); return stat.isFile() ? stat.size : 0; } catch { return 0; }
}

async function exists(target: string): Promise<boolean> {
  return fsp.access(target).then(() => true, () => false);
}

function tableExists(name: string): boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
}

function containedBy(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
}

/** Physical Time Machine bytes charged once per user/object, even when several
 * immutable snapshots reference the same content-addressed object. Manifests
 * are distinct files and are therefore charged individually. A corrupt
 * manifest falls back to its logical snapshot size so damage can never turn
 * into a quota bypass. */
export async function timeMachineUsageBytes(userId: number): Promise<number> {
  if (!tableExists('time_machine_snapshots')) return 0;
  const root = path.join(config.dataDir, 'time-machine');
  const manifests = path.join(root, 'manifests', String(userId));
  const objects = path.join(root, 'objects');
  const rows = db.prepare(`SELECT manifest_path,manifest_hash,total_bytes FROM time_machine_snapshots
    WHERE user_id=?`).all(userId) as any[];
  const referenced = new Set<string>();
  let total = 0;
  for (const row of rows) {
    const manifest = path.resolve(String(row.manifest_path || ''));
    if (!containedBy(manifests, manifest)) {
      total += Math.max(0, Number(row.total_bytes) || 0);
      continue;
    }
    try {
      const bytes = await fsp.readFile(manifest);
      total += bytes.length;
      if (crypto.createHash('sha256').update(bytes).digest('hex') !== String(row.manifest_hash || '')) {
        total += Math.max(0, Number(row.total_bytes) || 0);
        continue;
      }
      const parsed = JSON.parse(bytes.toString('utf8')) as { entries?: Array<{ sha256?: unknown }> };
      if (!Array.isArray(parsed.entries)) throw new Error('invalid_time_machine_manifest');
      for (const entry of parsed.entries) {
        const hash = String(entry?.sha256 || '');
        if (/^[a-f0-9]{64}$/.test(hash)) referenced.add(hash);
      }
    } catch {
      total += Math.max(0, Number(row.total_bytes) || 0);
    }
  }
  for (const hash of referenced) total += await fileBytes(path.join(objects, hash.slice(0, 2), hash.slice(2)));
  return total;
}

export async function chargedUsageBytes(user: Pick<User, 'id' | 'username'>): Promise<number> {
  let total = await treeBytes(await storage.userRootAsync(user.username));

  // Versions and trash live outside the user root but are still the user's
  // data. Count physical bytes rather than optimistic metadata where possible.
  const versions = db.prepare('SELECT stored_path FROM versions WHERE user_id=?').all(user.id) as any[];
  for (const item of versions) total += await fileBytes(String(item.stored_path));
  const trash = db.prepare('SELECT trashed_path FROM trash WHERE user_id=?').all(user.id) as any[];
  for (const item of trash) total += await treeBytes(String(item.trashed_path));
  const images = db.prepare('SELECT filename FROM generated_images WHERE user_id=?').all(user.id) as any[];
  for (const item of images) total += await fileBytes(path.join(config.generatedDir, path.basename(String(item.filename))));
  const music = db.prepare('SELECT filename FROM generated_music WHERE user_id=? AND filename IS NOT NULL').all(user.id) as any[];
  for (const item of music) total += await fileBytes(path.join(config.dataDir, 'music', path.basename(String(item.filename))));
  const subtitles = db.prepare('SELECT filename FROM subtitles WHERE created_by=?').all(user.id) as any[];
  for (const item of subtitles) total += await fileBytes(path.join(config.subtitlesDir, path.basename(String(item.filename))));
  total += await timeMachineUsageBytes(user.id);
  return total;
}

function purgeExpiredReservations(): void {
  db.prepare("DELETE FROM storage_reservations WHERE datetime(expires_at)<=datetime('now')").run();
}

function activeReservations(userId: number): number {
  const row = db.prepare(`SELECT COALESCE(SUM(bytes),0) total FROM storage_reservations
    WHERE user_id=? AND datetime(expires_at)>datetime('now')`).get(userId) as any;
  return Number(row?.total || 0);
}

function activePhysicalReservations(): number {
  const row = db.prepare(`SELECT COALESCE(SUM(COALESCE(physical_bytes,bytes)),0) total FROM storage_reservations
    WHERE datetime(expires_at)>datetime('now')`).get() as any;
  return Number(row?.total || 0);
}

export interface StorageReservation { id: string; bytes: number; physicalBytes?: number; }

export async function reserveStorageOperation(user: Pick<User, 'id' | 'username' | 'storageQuotaBytes'>,
  quotaBytes: number, physicalBytes = quotaBytes, physicalPath?: string): Promise<StorageReservation> {
  const wanted = Math.max(0, Math.ceil(Number(quotaBytes) || 0));
  const wantedPhysical = Math.max(0, Math.ceil(Number(physicalBytes) || 0));
  return withReservationLock(async () => {
    purgeExpiredReservations();
    const quota = user.storageQuotaBytes;
    const used = await chargedUsageBytes(user);
    const reserved = activeReservations(user.id);
    if (quota != null && used + reserved + wanted > quota) {
      throw Object.assign(new Error('storage_quota_exceeded'), {
        status: 507, usedBytes: used, reservedBytes: reserved, requestedBytes: wanted, quotaBytes: quota,
      });
    }
    if (wantedPhysical > 0) {
      try {
        const stats = await fsp.statfs(physicalPath || await storage.userRootAsync(user.username));
        const available = Number(stats.bavail) * Number(stats.bsize);
        const physicallyReserved = activePhysicalReservations();
        if (Number.isFinite(available) && wantedPhysical + physicallyReserved + 64 * 1024 * 1024 > available) {
          throw Object.assign(new Error('storage_device_full'), {
            status: 507, availableBytes: available, requestedPhysicalBytes: wantedPhysical,
          });
        }
      } catch (error: any) {
        if (error?.status === 507) throw error;
        // Some filesystems/Node builds do not expose statfs. Quota remains active.
      }
    }
    const id = `reserve_${crypto.randomUUID()}`;
    db.prepare(`INSERT INTO storage_reservations (id,user_id,bytes,physical_bytes,expires_at)
      VALUES (?,?,?,?,?)`).run(id, user.id, wanted, wantedPhysical, new Date(Date.now() + RESERVATION_MS).toISOString());
    return { id, bytes: wanted, physicalBytes: wantedPhysical };
  });
}

export async function reserveStorage(user: Pick<User, 'id' | 'username' | 'storageQuotaBytes'>,
  bytes: number): Promise<StorageReservation> {
  return reserveStorageOperation(user, bytes, bytes);
}

export function refreshStorageReservation(reservation: StorageReservation | string | null | undefined): void {
  const id = typeof reservation === 'string' ? reservation : reservation?.id;
  if (id) db.prepare('UPDATE storage_reservations SET expires_at=? WHERE id=?')
    .run(new Date(Date.now() + RESERVATION_MS).toISOString(), id);
}

// Once reserved bytes have been materialized, statfs already reflects them.
// Clearing the remaining physical headroom avoids counting the same bytes both
// as used space and as a future write while the quota reservation stays active.
export function settleStorageReservationPhysical(reservation: StorageReservation | string | null | undefined): void {
  const id = typeof reservation === 'string' ? reservation : reservation?.id;
  if (!id) return;
  db.prepare('UPDATE storage_reservations SET physical_bytes=0 WHERE id=?').run(id);
  if (typeof reservation === 'object' && reservation) reservation.physicalBytes = 0;
}

export function releaseStorage(reservation: StorageReservation | string | null | undefined): void {
  const id = typeof reservation === 'string' ? reservation : reservation?.id;
  if (id) db.prepare('DELETE FROM storage_reservations WHERE id=?').run(id);
}

export function revisionFor(stat: fs.Stats): string {
  return `"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs * 1000).toString(16)}"`;
}

async function syncFile(target: string): Promise<void> {
  const handle = await fsp.open(target, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}

async function stageSource(source: string, destination: string, operationId: string): Promise<string> {
  const stage = path.join(path.dirname(destination), `.aerie-stage-${operationId}`);
  await fsp.mkdir(path.dirname(destination), { recursive: true });
  try { await fsp.rename(source, stage); }
  catch (error: any) {
    if (error?.code !== 'EXDEV') throw error;
    await fsp.copyFile(source, stage, fs.constants.COPYFILE_EXCL | fs.constants.COPYFILE_FICLONE);
    await fsp.rm(source, { force: true });
  }
  await syncFile(stage);
  return stage;
}

async function makeVersion(user: Pick<User, 'id' | 'username' | 'displayName'>, virtualPath: string,
  destination: string, note?: string): Promise<string | null> {
  let stat: fs.Stats;
  try { stat = await fsp.stat(destination); } catch { return null; }
  if (!stat.isFile()) return null;
  const id = `v_${crypto.randomUUID()}`;
  const directory = path.join(config.versionsDir, String(user.id));
  const stored = path.join(directory, id);
  await fsp.mkdir(directory, { recursive: true, mode: 0o700 });
  await fsp.copyFile(destination, stored, fs.constants.COPYFILE_FICLONE);
  await syncFile(stored);
  db.prepare('INSERT INTO versions (id,user_id,path,stored_path,author,note,size_bytes) VALUES (?,?,?,?,?,?,?)')
    .run(id, user.id, virtualPath, stored, user.displayName, note || null, stat.size);
  return id;
}

async function pruneVersions(userId: number, virtualPath: string): Promise<void> {
  const rows = db.prepare(`SELECT id,stored_path,created_at FROM versions WHERE user_id=? AND path=?
    ORDER BY created_at DESC,id DESC`).all(userId, virtualPath) as any[];
  const cutoff = Date.now() - 90 * 86400_000;
  const remove = rows.filter((row, index) => index >= MAX_VERSIONS_PER_FILE || (index >= 5 && Date.parse(row.created_at + 'Z') < cutoff));
  const del = db.prepare('DELETE FROM versions WHERE id=? AND user_id=?');
  for (const row of remove) {
    await fsp.rm(String(row.stored_path), { force: true }).catch(() => {});
    del.run(row.id, userId);
  }
}

export interface CommitOptions {
  user: User;
  virtualPath: string;
  tempPath: string;
  expectedRevision?: string | null;
  createVersion?: boolean;
  versionNote?: string;
  mtimeMs?: number;
  reservation?: StorageReservation;
  releaseReservation?: boolean;
}

export async function commitTempFile(options: CommitOptions): Promise<{ revision: string; versionId: string | null; size: number }> {
  const { user } = options;
  const virtualPath = path.posix.normalize('/' + String(options.virtualPath || '').replace(/^\/+/, ''));
  const tempStat = await fsp.stat(options.tempPath);
  if (!tempStat.isFile()) throw Object.assign(new Error('upload_not_file'), { status: 400 });
  assertFileAllowed(path.posix.basename(virtualPath), tempStat.size);
  const destination = await storage.resolveAsync(user.username, virtualPath);
  let previous: fs.Stats | null = null;
  try { previous = await fsp.stat(destination); } catch { /* new file */ }
  if (previous?.isDirectory()) throw Object.assign(new Error('destination_is_folder'), { status: 409 });
  if (options.expectedRevision && options.expectedRevision !== '*' && previous
    && revisionFor(previous) !== options.expectedRevision) {
    throw Object.assign(new Error('revision_conflict'), { status: 409, currentRevision: revisionFor(previous) });
  }
  if (options.expectedRevision === '*' && previous) throw Object.assign(new Error('already_exists'), { status: 409 });

  const versioned = options.createVersion !== false && !!previous;
  const charge = versioned ? tempStat.size : Math.max(0, tempStat.size - (previous?.size || 0));
  const reservation = options.reservation || await reserveStorage(user, charge);
  const operationId = crypto.randomUUID();
  let stage = '';
  let versionId: string | null = null;
  try {
    stage = await stageSource(options.tempPath, destination, operationId);
    db.prepare(`INSERT INTO storage_operations (id,user_id,kind,path,stage_path,status)
      VALUES (?,?,?,?,?,'staged')`).run(operationId, user.id, previous ? 'replace' : 'create', virtualPath, stage);
    if (versioned) versionId = await makeVersion(user, virtualPath, destination, options.versionNote);
    await fsp.rename(stage, destination);
    stage = '';
    if (Number.isFinite(options.mtimeMs)) {
      const time = new Date(Number(options.mtimeMs));
      await fsp.utimes(destination, time, time).catch(() => {});
    }
    const stat = await fsp.stat(destination);
    db.prepare("UPDATE storage_operations SET status='completed',stage_path=NULL,updated_at=datetime('now') WHERE id=?")
      .run(operationId);
    await pruneVersions(user.id, virtualPath);
    markFileCatalogStale(user.id);
    return { revision: revisionFor(stat), versionId, size: stat.size };
  } catch (error: any) {
    if (stage) await fsp.rm(stage, { force: true }).catch(() => {});
    db.prepare("UPDATE storage_operations SET status='failed',error=?,updated_at=datetime('now') WHERE id=?")
      .run(String(error?.message || error).slice(0, 500), operationId);
    throw error;
  } finally { if (options.releaseReservation !== false) releaseStorage(reservation); }
}

export async function writeFileAtomic(options: Omit<CommitOptions, 'tempPath'> & { data: string | Buffer }): Promise<{ revision: string; versionId: string | null; size: number }> {
  const destination = await storage.resolveAsync(options.user.username, options.virtualPath);
  await fsp.mkdir(path.dirname(destination), { recursive: true });
  const temp = path.join(path.dirname(destination), `.aerie-input-${crypto.randomUUID()}.tmp`);
  try {
    const handle = await fsp.open(temp, 'wx', 0o600);
    try { await handle.writeFile(options.data); await handle.sync(); } finally { await handle.close(); }
    return await commitTempFile({ ...options, tempPath: temp });
  } catch (error) {
    await fsp.rm(temp, { force: true }).catch(() => {});
    throw error;
  }
}

export async function assertCopyFits(user: User, source: string, replaced = 0): Promise<StorageReservation> {
  return reserveStorage(user, Math.max(0, await treeBytes(source) - replaced));
}

function normalizedPath(value: string): string {
  return path.posix.normalize('/' + String(value || '').replace(/^\/+/, ''));
}

function rollbackPath(destination: string, operationId: string): string {
  return path.join(path.dirname(destination), `.aerie-rollback-${operationId}`);
}

function rekeyTable(table: 'versions' | 'stars' | 'shares', userId: number, from: string, to: string): void {
  const rows = db.prepare(`SELECT rowid,path FROM ${table} WHERE user_id=? AND (path=? OR path LIKE ?)`)
    .all(userId, from, from + '/%') as Array<{ rowid: number; path: string }>;
  const update = db.prepare(`UPDATE OR REPLACE ${table} SET path=? WHERE rowid=? AND user_id=?`);
  for (const row of rows) update.run(to + row.path.slice(from.length), row.rowid, userId);
}

function rekeyAccountShares(userId: number, from: string, to: string): void {
  const rows = db.prepare(`SELECT rowid,root_path FROM account_shares
    WHERE owner_user_id=? AND revoked_at IS NULL AND (root_path=? OR root_path LIKE ?)`)
    .all(userId, from, from + '/%') as Array<{ rowid: number; root_path: string }>;
  const update = db.prepare(`UPDATE account_shares
    SET root_path=?,updated_at=datetime('now') WHERE rowid=? AND owner_user_id=?`);
  for (const row of rows) update.run(to + row.root_path.slice(from.length), row.rowid, userId);
}

export function rekeyPathMetadata(userId: number, fromValue: string, toValue: string): void {
  const from = normalizedPath(fromValue), to = normalizedPath(toValue);
  db.transaction(() => {
    rekeyTable('versions', userId, from, to);
    rekeyTable('stars', userId, from, to);
    rekeyTable('shares', userId, from, to);
    rekeyAccountShares(userId, from, to);
  })();
}

export async function copyPathAtomic(options: {
  user: User; from: string; to: string; overwrite?: boolean; versionNote?: string;
}): Promise<void> {
  const from = normalizedPath(options.from), to = normalizedPath(options.to);
  if (from === '/' || to === '/' || to === from || to.startsWith(from + '/')) {
    throw Object.assign(new Error('invalid_copy_destination'), { status: 400 });
  }
  const source = await storage.resolveAsync(options.user.username, from);
  const destination = await storage.resolveAsync(options.user.username, to);
  const sourceStat = await fsp.stat(source);
  await assertTreeAllowed(source);
  let destinationStat: fs.Stats | null = null;
  try { destinationStat = await fsp.stat(destination); } catch { /* missing */ }
  if (destinationStat && !options.overwrite) throw Object.assign(new Error('already_exists'), { status: 409 });

  if (sourceStat.isFile()) {
    await fsp.mkdir(path.dirname(destination), { recursive: true });
    const temp = path.join(path.dirname(destination), `.aerie-copy-${crypto.randomUUID()}.tmp`);
    try {
      await fsp.copyFile(source, temp, fs.constants.COPYFILE_EXCL | fs.constants.COPYFILE_FICLONE);
      await commitTempFile({
        user: options.user, virtualPath: to, tempPath: temp,
        expectedRevision: options.overwrite ? undefined : '*',
        versionNote: options.versionNote || 'Before copy replacement',
      });
    } finally { await fsp.rm(temp, { force: true }).catch(() => {}); }
    return;
  }

  const sourceBytes = await treeBytes(source);
  const replaced = destinationStat ? await treeBytes(destination) : 0;
  const reservation = await reserveStorage(options.user, Math.max(0, sourceBytes - replaced));
  const operationId = crypto.randomUUID();
  const stage = path.join(path.dirname(destination), `.aerie-stage-${operationId}`);
  const rollback = rollbackPath(destination, operationId);
  try {
    await fsp.mkdir(path.dirname(destination), { recursive: true });
    db.prepare(`INSERT INTO storage_operations (id,user_id,kind,path,stage_path,status)
      VALUES (?,?,?,?,?,'prepared')`).run(operationId, options.user.id, 'copy', to, stage);
    await fsp.cp(source, stage, { recursive: true, force: false, errorOnExist: true, preserveTimestamps: true });
    db.prepare("UPDATE storage_operations SET status='staged',updated_at=datetime('now') WHERE id=?").run(operationId);
    if (destinationStat) {
      await fsp.rename(destination, rollback);
      db.prepare("UPDATE storage_operations SET status='rollback_ready',updated_at=datetime('now') WHERE id=?").run(operationId);
    }
    await fsp.rename(stage, destination);
    db.prepare("UPDATE storage_operations SET status='committed',stage_path=NULL,updated_at=datetime('now') WHERE id=?").run(operationId);
    await fsp.rm(rollback, { recursive: true, force: true });
    db.prepare("UPDATE storage_operations SET status='completed',updated_at=datetime('now') WHERE id=?").run(operationId);
    markFileCatalogStale(options.user.id);
  } catch (error: any) {
    await fsp.rm(stage, { recursive: true, force: true }).catch(() => {});
    if (!(await exists(destination)) && await exists(rollback)) await fsp.rename(rollback, destination).catch(() => {});
    db.prepare("UPDATE storage_operations SET status='failed',error=?,updated_at=datetime('now') WHERE id=?")
      .run(String(error?.message || error).slice(0, 500), operationId);
    throw error;
  } finally { releaseStorage(reservation); }
}

export async function movePathAtomic(options: {
  user: User; from: string; to: string; overwrite?: boolean; versionNote?: string;
}): Promise<void> {
  const from = normalizedPath(options.from), to = normalizedPath(options.to);
  if (from === '/' || to === '/' || to === from || to.startsWith(from + '/')) {
    throw Object.assign(new Error('invalid_move_destination'), { status: 400 });
  }
  const source = await storage.resolveAsync(options.user.username, from);
  const destination = await storage.resolveAsync(options.user.username, to);
  const sourceStat = await fsp.stat(source);
  if (sourceStat.isFile()) assertFileAllowed(path.basename(to), sourceStat.size);
  let destinationStat: fs.Stats | null = null;
  try { destinationStat = await fsp.stat(destination); } catch { /* missing */ }
  if (destinationStat && !options.overwrite) throw Object.assign(new Error('already_exists'), { status: 409 });
  const operationId = crypto.randomUUID();
  const rollback = rollbackPath(destination, operationId);
  let sourceMoved = false;
  try {
    await fsp.mkdir(path.dirname(destination), { recursive: true });
    db.prepare(`INSERT INTO storage_operations (id,user_id,kind,path,stage_path,status)
      VALUES (?,?,?,?,?,'prepared')`).run(operationId, options.user.id, 'move', JSON.stringify({ from, to }), rollback);
    if (destinationStat) {
      if (destinationStat.isFile()) {
        await makeVersion(options.user, to, destination, options.versionNote || 'Before move replacement');
      }
      await fsp.rename(destination, rollback);
      db.prepare("UPDATE storage_operations SET status='rollback_ready',updated_at=datetime('now') WHERE id=?").run(operationId);
    }
    await fsp.rename(source, destination);
    sourceMoved = true;
    rekeyPathMetadata(options.user.id, from, to);
    db.prepare("UPDATE storage_operations SET status='committed',updated_at=datetime('now') WHERE id=?").run(operationId);
    await fsp.rm(rollback, { recursive: true, force: true });
    db.prepare("UPDATE storage_operations SET status='completed',stage_path=NULL,updated_at=datetime('now') WHERE id=?").run(operationId);
    markFileCatalogStale(options.user.id);
  } catch (error: any) {
    if (sourceMoved && !(await exists(source)) && await exists(destination)) {
      await fsp.rename(destination, source).catch(() => {});
      if (await exists(source)) rekeyPathMetadata(options.user.id, to, from);
    }
    if (!(await exists(destination)) && await exists(rollback)) await fsp.rename(rollback, destination).catch(() => {});
    db.prepare("UPDATE storage_operations SET status='failed',error=?,updated_at=datetime('now') WHERE id=?")
      .run(String(error?.message || error).slice(0, 500), operationId);
    throw error;
  }
}

export async function restoreTrashAtomic(user: User, trashId: string): Promise<void> {
  const item = db.prepare('SELECT * FROM trash WHERE id=? AND user_id=?').get(trashId, user.id) as any;
  if (!item) throw Object.assign(new Error('not_found'), { status: 404 });
  const destination = await storage.resolveAsync(user.username, item.original_path);
  if (await exists(destination)) throw Object.assign(new Error('restore_destination_exists'), { status: 409 });
  if (!(await exists(String(item.trashed_path)))) throw Object.assign(new Error('trash_content_missing'), { status: 410 });
  const operationId = crypto.randomUUID();
  let moved = false;
  try {
    await fsp.mkdir(path.dirname(destination), { recursive: true });
    db.prepare(`INSERT INTO storage_operations (id,user_id,kind,path,stage_path,status)
      VALUES (?,?,?,?,?,'staged')`).run(operationId, user.id, 'restore', item.original_path, item.trashed_path);
    await storage.safeMove(item.trashed_path, destination);
    moved = true;
    db.transaction(() => {
      db.prepare('DELETE FROM trash WHERE id=? AND user_id=?').run(trashId, user.id);
      db.prepare("UPDATE storage_operations SET status='completed',stage_path=NULL,updated_at=datetime('now') WHERE id=?").run(operationId);
    })();
    markFileCatalogStale(user.id);
  } catch (error: any) {
    if (moved && await exists(destination) && !(await exists(String(item.trashed_path)))) {
      await storage.safeMove(destination, item.trashed_path).catch(() => {});
    }
    db.prepare("UPDATE storage_operations SET status='failed',error=?,updated_at=datetime('now') WHERE id=?")
      .run(String(error?.message || error).slice(0, 500), operationId);
    throw error;
  }
}

export async function reconcileInterruptedStorageOperations(): Promise<void> {
  db.prepare("DELETE FROM storage_reservations WHERE datetime(expires_at)<=datetime('now')").run();
  const rows = db.prepare("SELECT * FROM storage_operations WHERE status IN ('prepared','staged','rollback_ready','committed')").all() as any[];
  for (const row of rows) {
    try {
      if (row.kind === 'trash' && row.stage_path) {
        const user = db.prepare('SELECT username FROM users WHERE id=?').get(row.user_id) as any;
        const original = user ? await storage.resolveAsync(user.username, row.path) : '';
        if (original && !(await exists(original)) && await exists(String(row.stage_path))) {
          await fsp.mkdir(path.dirname(original), { recursive: true });
          await storage.safeMove(String(row.stage_path), original);
        }
      } else if (row.kind === 'restore' && row.stage_path) {
        const user = db.prepare('SELECT username FROM users WHERE id=?').get(row.user_id) as any;
        const destination = user ? await storage.resolveAsync(user.username, row.path) : '';
        if (destination && !(await exists(String(row.stage_path))) && await exists(destination)) {
          const trash = db.prepare('SELECT id FROM trash WHERE user_id=? AND original_path=? AND trashed_path=?')
            .get(row.user_id, row.path, row.stage_path) as any;
          if (trash) db.prepare('DELETE FROM trash WHERE id=? AND user_id=?').run(trash.id, row.user_id);
        }
      } else if (row.kind === 'copy') {
        const user = db.prepare('SELECT username FROM users WHERE id=?').get(row.user_id) as any;
        const destination = user ? await storage.resolveAsync(user.username, row.path) : '';
        const rollback = destination ? rollbackPath(destination, row.id) : '';
        if (row.status === 'committed' || (row.status === 'rollback_ready' && destination
          && !(await exists(String(row.stage_path))) && await exists(destination))) {
          await fsp.rm(rollback, { recursive: true, force: true });
        } else {
          if (row.stage_path) await fsp.rm(String(row.stage_path), { recursive: true, force: true });
          if (destination && !(await exists(destination)) && await exists(rollback)) await fsp.rename(rollback, destination);
        }
      } else if (row.kind === 'move') {
        const user = db.prepare('SELECT username FROM users WHERE id=?').get(row.user_id) as any;
        const parsed = JSON.parse(String(row.path));
        const source = user ? await storage.resolveAsync(user.username, parsed.from) : '';
        const destination = user ? await storage.resolveAsync(user.username, parsed.to) : '';
        if (source && destination && !(await exists(source)) && await exists(destination)) {
          rekeyPathMetadata(row.user_id, parsed.from, parsed.to);
          if (row.stage_path) await fsp.rm(String(row.stage_path), { recursive: true, force: true });
        } else if (destination && !(await exists(destination))
          && row.stage_path && await exists(String(row.stage_path))) {
          await fsp.rename(String(row.stage_path), destination);
        }
      } else if (row.stage_path) {
        await fsp.rm(String(row.stage_path), { recursive: true, force: true });
      }
      db.prepare("UPDATE storage_operations SET status='recovered',stage_path=NULL,updated_at=datetime('now') WHERE id=?").run(row.id);
      markFileCatalogStale(Number(row.user_id));
    } catch (error: any) {
      db.prepare("UPDATE storage_operations SET error=?,updated_at=datetime('now') WHERE id=?")
        .run(String(error?.message || error).slice(0, 500), row.id);
    }
  }
  await cleanupOrphanFiles();
  db.prepare("DELETE FROM storage_operations WHERE status IN ('completed','recovered') AND datetime(updated_at)<datetime('now','-30 days')").run();
  db.prepare("DELETE FROM storage_operations WHERE status='failed' AND datetime(updated_at)<datetime('now','-180 days')").run();
}

async function cleanupHiddenTemps(root: string): Promise<void> {
  let entries: fs.Dirent[];
  try { entries = await fsp.readdir(root, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (/^\.aerie-(?:stage|input|copy|dav|image-copy)-/.test(entry.name)) {
      await fsp.rm(full, { recursive: true, force: true }).catch(() => {});
    } else if (entry.isDirectory()) {
      await cleanupHiddenTemps(full);
    }
  }
}

async function cleanupOrphanFiles(): Promise<void> {
  const users = db.prepare('SELECT username FROM users').all() as Array<{ username: string }>;
  for (const user of users) await cleanupHiddenTemps(await storage.userRootAsync(user.username));

  const uploadDir = path.join(config.filesRoot, '.uploads-tmp');
  const resumable = new Set((db.prepare("SELECT id FROM upload_sessions WHERE status='uploading'").all() as any[])
    .map(row => `resume-${row.id}`));
  for (const name of await fsp.readdir(uploadDir).catch(() => [] as string[])) {
    if (!resumable.has(name)) await fsp.rm(path.join(uploadDir, name), { recursive: true, force: true }).catch(() => {});
  }
  const syncDir = path.join(config.filesRoot, '.sync-uploads-tmp');
  const syncNames = await fsp.readdir(syncDir).catch(() => [] as string[]);
  const recentResumeMetadata = new Set<string>();
  const resumeCutoff = Date.now() - 24 * 60 * 60 * 1000;
  for (const name of syncNames) {
    const match = /^resume-([a-f0-9-]{36})\.json$/.exec(name);
    if (!match) continue;
    const stat = await fsp.lstat(path.join(syncDir, name)).catch(() => null);
    if (stat?.isFile() && !stat.isSymbolicLink() && stat.mtimeMs >= resumeCutoff) {
      recentResumeMetadata.add(match[1]);
    }
  }
  for (const name of syncNames) {
    const match = /^resume-([a-f0-9-]{36})\.(json|part)$/.exec(name);
    if (match && recentResumeMetadata.has(match[1])) continue;
    await fsp.rm(path.join(syncDir, name), { recursive: true, force: true }).catch(() => {});
  }

  const imageRefs = new Set((db.prepare('SELECT filename FROM generated_images').all() as any[]).map(row => String(row.filename)));
  for (const name of await fsp.readdir(config.generatedDir).catch(() => [] as string[])) {
    if (name.endsWith('.partial') || (/^gen_\d+_[a-f0-9-]+\.png$/i.test(name) && !imageRefs.has(name))) {
      await fsp.rm(path.join(config.generatedDir, name), { force: true }).catch(() => {});
    }
  }
  const musicDir = path.join(config.dataDir, 'music');
  const musicRefs = new Set((db.prepare('SELECT filename FROM generated_music WHERE filename IS NOT NULL').all() as any[])
    .map(row => String(row.filename)));
  for (const name of await fsp.readdir(musicDir).catch(() => [] as string[])) {
    if (name.endsWith('.partial') || (/^music_\d+_[a-f0-9-]+\.mp3$/i.test(name) && !musicRefs.has(name))) {
      await fsp.rm(path.join(musicDir, name), { force: true }).catch(() => {});
    }
  }
}
