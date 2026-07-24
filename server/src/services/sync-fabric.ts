import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { db } from '../lib/db.js';
export { deterministicConflictRel, parseByteRange } from './sync-protocol.js';

export type SyncEntry = {
  stableId: string;
  base: string;
  rel: string;
  contentHash: string;
  size: number;
  mtimeMs: number;
};

export type SyncChange = SyncEntry & {
  cursor: number;
  kind: 'upsert' | 'rename' | 'delete';
  previousRel: string | null;
  originDevice: string | null;
  createdAt: string;
};

export type SyncChangePage = {
  items: SyncChange[];
  nextCursor: number;
  hasMore: boolean;
  latestCursor: number;
  retainedFromCursor: number;
  fullManifestRequired: boolean;
  reason?: 'cursor_compacted' | 'cursor_ahead';
};

export const SYNC_MAX_RETAINED_CHANGES = 10_000;
const ACTIVE_CURSOR_DAYS = 30;
const CURSOR_RECORD_DAYS = 90;
const COMPACT_EVERY_CHANGES = 128;

type EntryRow = {
  stable_id: string;
  user_id: number;
  base: string;
  rel_path: string;
  content_hash: string;
  size: number;
  mtime_ms: number;
  deleted: number;
};

const locks = new Map<string, Promise<void>>();
const changesSinceCompaction = new Map<string, number>();

function compactAfterAppend(userId: number, base: string): void {
  const key = `${userId}:${base}`;
  // Compact on the first append after a process restart, then amortize the
  // indexed watermark queries across a bounded batch of journal writes.
  const count = (changesSinceCompaction.get(key) ?? (COMPACT_EVERY_CHANGES - 1)) + 1;
  if (count >= COMPACT_EVERY_CHANGES) {
    compactJournal(userId, base, SYNC_MAX_RETAINED_CHANGES - COMPACT_EVERY_CHANGES);
    changesSinceCompaction.set(key, 0);
  } else {
    changesSinceCompaction.set(key, count);
  }
}

/** Serialize reconciliation and mutations within one user's sync root. */
export async function withSyncLock<T>(userId: number, base: string, work: () => Promise<T>): Promise<T> {
  const key = `${userId}:${base}`;
  const previous = locks.get(key) || Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>(resolve => { release = resolve; });
  locks.set(key, current);
  await previous;
  try {
    return await work();
  } finally {
    release();
    if (locks.get(key) === current) locks.delete(key);
  }
}

export async function hashFile(filename: string): Promise<string> {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(filename)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

function publicEntry(row: EntryRow): SyncEntry {
  return {
    stableId: row.stable_id,
    base: row.base,
    rel: row.rel_path,
    contentHash: row.content_hash,
    size: row.size,
    mtimeMs: row.mtime_ms,
  };
}

export function activeByPath(userId: number, base: string, rel: string): EntryRow | undefined {
  return db.prepare('SELECT * FROM sync_entries WHERE user_id=? AND base=? AND rel_path=? AND deleted=0')
    .get(userId, base, rel) as EntryRow | undefined;
}

export function activeByStableId(userId: number, stableId: string): EntryRow | undefined {
  return db.prepare('SELECT * FROM sync_entries WHERE user_id=? AND stable_id=? AND deleted=0')
    .get(userId, stableId) as EntryRow | undefined;
}

export function latestCursor(userId: number, base: string): number {
  const row = db.prepare(`SELECT MAX(value) cursor FROM (
      SELECT COALESCE(MAX(cursor),0) value FROM sync_changes WHERE user_id=? AND base=?
      UNION ALL
      SELECT COALESCE(MAX(compacted_through),0) value FROM sync_journal_state WHERE user_id=? AND base=?
    )`).get(userId, base, userId, base) as { cursor: number };
  return Number(row?.cursor || 0);
}

export function journalWatermark(userId: number, base: string): number {
  const row = db.prepare('SELECT compacted_through FROM sync_journal_state WHERE user_id=? AND base=?')
    .get(userId, base) as { compacted_through: number } | undefined;
  return Number(row?.compacted_through || 0);
}

/** Record liveness without treating an uncommitted request cursor as an ACK. */
export function noteSyncDeviceSeen(userId: number, base: string, deviceId: string): void {
  db.prepare(`INSERT INTO sync_device_cursors (user_id,base,device_id,ack_cursor,last_seen)
    VALUES (?,?,?,0,datetime('now'))
    ON CONFLICT(user_id,base,device_id) DO UPDATE SET last_seen=datetime('now')`)
    .run(userId, base, deviceId);
}

/**
 * Bound a base journal while preserving a durable high-water mark. ACKed rows
 * are removed as soon as every active device has applied them. A hard row cap
 * prevents an abandoned device from growing the database forever; that device
 * receives the explicit full-manifest response when it eventually returns.
 */
export function compactJournal(
  userId: number,
  base: string,
  maxChanges = SYNC_MAX_RETAINED_CHANGES,
): { deleted: number; compactedThrough: number; retainedFromCursor: number; retained: number } {
  const boundedMax = Math.max(1, Math.floor(maxChanges));
  return db.transaction(() => {
    db.prepare(`DELETE FROM sync_device_cursors
      WHERE user_id=? AND base=? AND last_seen < datetime('now', ?)`)
      .run(userId, base, `-${CURSOR_RECORD_DAYS} days`);

    const active = db.prepare(`SELECT MIN(ack_cursor) cursor FROM sync_device_cursors
      WHERE user_id=? AND base=? AND last_seen >= datetime('now', ?)`)
      .get(userId, base, `-${ACTIVE_CURSOR_DAYS} days`) as { cursor: number | null };
    const overflow = db.prepare(`SELECT cursor FROM sync_changes
      WHERE user_id=? AND base=? ORDER BY cursor DESC LIMIT 1 OFFSET ?`)
      .get(userId, base, boundedMax) as { cursor: number } | undefined;
    const safeThrough = active?.cursor == null ? 0 : Number(active.cursor);
    const requiredThrough = Number(overflow?.cursor || 0);
    const candidate = Math.max(safeThrough, requiredThrough);
    const deletable = db.prepare(`SELECT MAX(cursor) cursor FROM sync_changes
      WHERE user_id=? AND base=? AND cursor<=?`)
      .get(userId, base, candidate) as { cursor: number | null };
    const deleteThrough = Number(deletable?.cursor || 0);
    let deleted = 0;
    if (deleteThrough > 0) {
      db.prepare(`INSERT INTO sync_journal_state (user_id,base,compacted_through,updated_at)
        VALUES (?,?,?,datetime('now'))
        ON CONFLICT(user_id,base) DO UPDATE SET
          compacted_through=MAX(sync_journal_state.compacted_through,excluded.compacted_through),
          updated_at=datetime('now')`).run(userId, base, deleteThrough);
      deleted = Number(db.prepare('DELETE FROM sync_changes WHERE user_id=? AND base=? AND cursor<=?')
        .run(userId, base, deleteThrough).changes || 0);
    }
    const compactedThrough = journalWatermark(userId, base);
    const retained = Number((db.prepare('SELECT COUNT(*) count FROM sync_changes WHERE user_id=? AND base=?')
      .get(userId, base) as { count: number }).count || 0);
    return { deleted, compactedThrough, retainedFromCursor: compactedThrough + 1, retained };
  })();
}

export function acknowledgeCursor(userId: number, base: string, deviceId: string, cursor: number): {
  ok: boolean;
  cursor: number;
  compactedThrough: number;
  retainedFromCursor: number;
  fullManifestRequired?: boolean;
  reason?: 'cursor_compacted' | 'cursor_ahead' | 'cursor_unknown';
} {
  const latest = latestCursor(userId, base);
  const compacted = journalWatermark(userId, base);
  if (cursor < compacted || cursor > latest) {
    return {
      ok: false,
      cursor: latest,
      compactedThrough: compacted,
      retainedFromCursor: compacted + 1,
      fullManifestRequired: true,
      reason: cursor < compacted ? 'cursor_compacted' : 'cursor_ahead',
    };
  }
  const known = cursor === 0 || cursor === compacted
    || !!db.prepare('SELECT 1 found FROM sync_changes WHERE user_id=? AND base=? AND cursor=?')
      .get(userId, base, cursor);
  if (!known) {
    return {
      ok: false,
      cursor: latest,
      compactedThrough: compacted,
      retainedFromCursor: compacted + 1,
      fullManifestRequired: true,
      reason: 'cursor_unknown',
    };
  }
  db.prepare(`INSERT INTO sync_device_cursors (user_id,base,device_id,ack_cursor,last_seen)
    VALUES (?,?,?,?,datetime('now'))
    ON CONFLICT(user_id,base,device_id) DO UPDATE SET
      ack_cursor=MAX(sync_device_cursors.ack_cursor,excluded.ack_cursor),
      last_seen=datetime('now')`).run(userId, base, deviceId, cursor);
  const compactedResult = compactJournal(userId, base);
  const stored = db.prepare(`SELECT ack_cursor FROM sync_device_cursors
    WHERE user_id=? AND base=? AND device_id=?`).get(userId, base, deviceId) as { ack_cursor: number };
  return { ok: true, cursor: Number(stored.ack_cursor), ...compactedResult };
}

function appendChange(userId: number, row: EntryRow, kind: SyncChange['kind'], previousRel: string | null, originDevice: string | null) {
  const info = db.prepare(`INSERT INTO sync_changes
    (user_id,base,stable_id,kind,rel_path,previous_rel_path,content_hash,size,mtime_ms,origin_device)
    VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
      userId, row.base, row.stable_id, kind, row.rel_path, previousRel,
      row.content_hash, row.size, row.mtime_ms, originDevice,
    );
  return Number(info.lastInsertRowid);
}

export function registerUpsert(input: {
  userId: number; base: string; rel: string; contentHash: string; size: number; mtimeMs: number;
  stableId?: string | null; originDevice?: string | null;
}): { entry: SyncEntry; cursor: number } {
  const existing = (input.stableId && activeByStableId(input.userId, input.stableId))
    || activeByPath(input.userId, input.base, input.rel);
  const stableId = existing?.stable_id || crypto.randomUUID();
  const previousRel = existing && existing.rel_path !== input.rel ? existing.rel_path : null;
  let cursor = 0;
  const tx = db.transaction(() => {
    db.prepare(`INSERT INTO sync_entries
      (stable_id,user_id,base,rel_path,content_hash,size,mtime_ms,deleted,updated_at)
      VALUES (?,?,?,?,?,?,?,0,datetime('now'))
      ON CONFLICT(stable_id) DO UPDATE SET base=excluded.base,rel_path=excluded.rel_path,
        content_hash=excluded.content_hash,size=excluded.size,mtime_ms=excluded.mtime_ms,
        deleted=0,updated_at=datetime('now')`)
      .run(stableId, input.userId, input.base, input.rel, input.contentHash, input.size, input.mtimeMs);
    const row = activeByStableId(input.userId, stableId)!;
    cursor = appendChange(input.userId, row, previousRel ? 'rename' : 'upsert', previousRel, input.originDevice || null);
  });
  tx();
  compactAfterAppend(input.userId, input.base);
  return { entry: publicEntry(activeByStableId(input.userId, stableId)!), cursor };
}

export function registerRename(input: {
  userId: number; stableId: string; toRel: string; size: number; mtimeMs: number; contentHash: string;
  originDevice?: string | null;
}): { entry: SyncEntry; cursor: number } {
  const existing = activeByStableId(input.userId, input.stableId);
  if (!existing) throw Object.assign(new Error('sync_entry_not_found'), { status: 404 });
  const previousRel = existing.rel_path;
  let cursor = 0;
  const tx = db.transaction(() => {
    db.prepare(`UPDATE sync_entries SET rel_path=?,content_hash=?,size=?,mtime_ms=?,updated_at=datetime('now')
      WHERE user_id=? AND stable_id=? AND deleted=0`)
      .run(input.toRel, input.contentHash, input.size, input.mtimeMs, input.userId, input.stableId);
    const row = activeByStableId(input.userId, input.stableId)!;
    cursor = appendChange(input.userId, row, 'rename', previousRel, input.originDevice || null);
  });
  tx();
  compactAfterAppend(input.userId, existing.base);
  return { entry: publicEntry(activeByStableId(input.userId, input.stableId)!), cursor };
}

export function registerDelete(input: { userId: number; stableId: string; originDevice?: string | null }): { entry: SyncEntry; cursor: number } {
  const existing = activeByStableId(input.userId, input.stableId);
  if (!existing) throw Object.assign(new Error('sync_entry_not_found'), { status: 404 });
  let cursor = 0;
  const tx = db.transaction(() => {
    db.prepare("UPDATE sync_entries SET deleted=1,updated_at=datetime('now') WHERE user_id=? AND stable_id=?")
      .run(input.userId, input.stableId);
    const deleted = { ...existing, deleted: 1 };
    cursor = appendChange(input.userId, deleted, 'delete', null, input.originDevice || null);
  });
  tx();
  compactAfterAppend(input.userId, existing.base);
  return { entry: publicEntry(existing), cursor };
}

async function walk(root: string): Promise<Array<{ rel: string; real: string; size: number; mtimeMs: number }>> {
  const files: Array<{ rel: string; real: string; size: number; mtimeMs: number }> = [];
  async function step(dir: string, prefix: string) {
    let entries: fs.Dirent[];
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const real = path.join(dir, entry.name);
      const rel = prefix ? path.posix.join(prefix, entry.name) : entry.name;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) await step(real, rel);
      else if (entry.isFile()) {
        try {
          const stat = await fsp.stat(real);
          files.push({ rel, real, size: stat.size, mtimeMs: stat.mtimeMs });
        } catch { /* file changed during scan; the next reconciliation picks it up */ }
      }
    }
  }
  await step(root, '');
  return files;
}

/**
 * Reconcile out-of-band changes made through the Files UI or directly on disk.
 * A unique content-hash match is treated as a rename, retaining the stable ID.
 */
export async function reconcileBase(userId: number, base: string, root: string): Promise<void> {
  const disk = await walk(root);
  const rows = db.prepare('SELECT * FROM sync_entries WHERE user_id=? AND base=? AND deleted=0 ORDER BY rel_path')
    .all(userId, base) as EntryRow[];
  const rowsByRel = new Map(rows.map(row => [row.rel_path, row]));
  const seen = new Set<string>();
  const unmatchedDisk: Array<(typeof disk)[number] & { contentHash: string }> = [];

  for (const file of disk) {
    const row = rowsByRel.get(file.rel);
    if (!row) {
      unmatchedDisk.push({ ...file, contentHash: await hashFile(file.real) });
      continue;
    }
    seen.add(row.stable_id);
    if (row.size === file.size && Math.abs(row.mtime_ms - file.mtimeMs) < 1) continue;
    const contentHash = await hashFile(file.real);
    if (contentHash === row.content_hash && row.size === file.size) {
      registerUpsert({
        userId, base, rel: file.rel, contentHash, size: file.size, mtimeMs: file.mtimeMs,
        stableId: row.stable_id, originDevice: 'server',
      });
      continue;
    }
    registerUpsert({ userId, base, rel: file.rel, contentHash, size: file.size, mtimeMs: file.mtimeMs, stableId: row.stable_id, originDevice: 'server' });
  }

  const missing = rows.filter(row => !seen.has(row.stable_id));
  const missingByFingerprint = new Map<string, EntryRow[]>();
  for (const row of missing) {
    const key = `${row.size}:${row.content_hash}`;
    const group = missingByFingerprint.get(key) || [];
    group.push(row);
    missingByFingerprint.set(key, group);
  }
  for (const group of missingByFingerprint.values()) group.sort((a, b) => a.stable_id.localeCompare(b.stable_id));

  for (const file of unmatchedDisk.sort((a, b) => a.rel.localeCompare(b.rel))) {
    const candidates = missingByFingerprint.get(`${file.size}:${file.contentHash}`);
    const renamed = candidates?.shift();
    if (renamed) {
      seen.add(renamed.stable_id);
      registerRename({ userId, stableId: renamed.stable_id, toRel: file.rel, size: file.size, mtimeMs: file.mtimeMs, contentHash: file.contentHash, originDevice: 'server' });
    } else {
      registerUpsert({ userId, base, rel: file.rel, contentHash: file.contentHash, size: file.size, mtimeMs: file.mtimeMs, originDevice: 'server' });
    }
  }

  for (const row of missing) {
    if (!seen.has(row.stable_id)) registerDelete({ userId, stableId: row.stable_id, originDevice: 'server' });
  }
}

export function changesAfter(userId: number, base: string, cursor: number, limit: number): SyncChangePage {
  const latest = latestCursor(userId, base);
  const compactedThrough = journalWatermark(userId, base);
  const retainedFromCursor = compactedThrough + 1;
  if (cursor < compactedThrough || cursor > latest) {
    return {
      items: [],
      nextCursor: latest,
      hasMore: false,
      latestCursor: latest,
      retainedFromCursor,
      fullManifestRequired: true,
      reason: cursor < compactedThrough ? 'cursor_compacted' : 'cursor_ahead',
    };
  }
  const rows = db.prepare(`SELECT cursor,stable_id,base,kind,rel_path,previous_rel_path,content_hash,size,mtime_ms,origin_device,created_at
    FROM sync_changes WHERE user_id=? AND base=? AND cursor>? ORDER BY cursor LIMIT ?`)
    .all(userId, base, cursor, limit + 1) as any[];
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  const items: SyncChange[] = page.map(row => ({
    cursor: Number(row.cursor), stableId: row.stable_id, base: row.base, kind: row.kind,
    rel: row.rel_path, previousRel: row.previous_rel_path || null, contentHash: row.content_hash,
    size: Number(row.size), mtimeMs: Number(row.mtime_ms), originDevice: row.origin_device || null,
    createdAt: row.created_at,
  }));
  return {
    items,
    nextCursor: items.length ? items[items.length - 1].cursor : cursor,
    hasMore,
    latestCursor: latest,
    retainedFromCursor,
    fullManifestRequired: false,
  };
}

export function manifest(userId: number, base: string): { entries: SyncEntry[]; cursor: number; retainedFromCursor: number } {
  const rows = db.prepare('SELECT * FROM sync_entries WHERE user_id=? AND base=? AND deleted=0 ORDER BY rel_path')
    .all(userId, base) as EntryRow[];
  return {
    entries: rows.map(publicEntry),
    cursor: latestCursor(userId, base),
    retainedFromCursor: journalWatermark(userId, base) + 1,
  };
}

function restoredBase(virtualPath: string): string | null {
  const parts = virtualPath.split('/').filter(Boolean);
  if (parts[0] === 'Sync' && parts.length >= 2) return path.posix.join('Sync', parts[1]);
  if (parts[0] === 'Photos' && parts[1] === 'Camera' && parts.length >= 3) {
    return path.posix.join('Photos', 'Camera', parts[2]);
  }
  return null;
}

async function diskBases(userRoot: string, family: 'sync' | 'camera'): Promise<string[]> {
  const prefix = family === 'sync' ? ['Sync'] : ['Photos', 'Camera'];
  const root = path.join(userRoot, ...prefix);
  let entries: fs.Dirent[];
  try { entries = await fsp.readdir(root, { withFileTypes: true }); } catch { return []; }
  return entries
    .filter(entry => entry.isDirectory() && !entry.isSymbolicLink() && !entry.name.startsWith('.') && !entry.name.includes('\\'))
    .map(entry => path.posix.join(...prefix, entry.name));
}

/**
 * Reconcile a filesystem restore into Sync Fabric's durable journal.
 *
 * A restore may replace a whole family root, so known database bases are
 * included alongside bases currently on disk. That is what turns files removed
 * by an overwrite restore into tombstones for connected devices.
 */
export async function reconcileRestoredPath(userId: number, inputUserRoot: string, inputVirtualDestination: string): Promise<void> {
  const userRoot = path.resolve(inputUserRoot);
  const raw = String(inputVirtualDestination || '/').replace(/\\/g, '/');
  if (raw.includes('\0') || raw.split('/').some(part => part === '..')) {
    throw Object.assign(new Error('invalid_restored_path'), { status: 400 });
  }
  const virtualDestination = path.posix.normalize('/' + raw.replace(/^\/+/, ''));
  const bases = new Set<string>();
  const direct = restoredBase(virtualDestination);
  if (direct) bases.add(direct);

  const affectsSyncFamily = virtualDestination === '/' || virtualDestination === '/Sync';
  const affectsCameraFamily = virtualDestination === '/' || virtualDestination === '/Photos' || virtualDestination === '/Photos/Camera';
  if (affectsSyncFamily || affectsCameraFamily) {
    const known = db.prepare('SELECT DISTINCT base FROM sync_entries WHERE user_id=? AND deleted=0').all(userId) as { base: string }[];
    for (const row of known) {
      if (affectsSyncFamily && /^Sync\/[^/]+$/.test(row.base)) bases.add(row.base);
      if (affectsCameraFamily && /^Photos\/Camera\/[^/]+$/.test(row.base)) bases.add(row.base);
    }
    if (affectsSyncFamily) for (const base of await diskBases(userRoot, 'sync')) bases.add(base);
    if (affectsCameraFamily) for (const base of await diskBases(userRoot, 'camera')) bases.add(base);
  }

  for (const base of [...bases].sort()) {
    if (!/^Sync\/[^/]+$/.test(base) && !/^Photos\/Camera\/[^/]+$/.test(base)) continue;
    const root = path.resolve(userRoot, ...base.split('/'));
    if (root !== userRoot && !root.startsWith(userRoot + path.sep)) {
      throw Object.assign(new Error('sync_root_escape'), { status: 400 });
    }
    try {
      if ((await fsp.lstat(root)).isSymbolicLink()) throw Object.assign(new Error('sync_root_symlink'), { status: 409 });
    } catch (error: any) {
      if (error?.code !== 'ENOENT') throw error;
    }
    await withSyncLock(userId, base, () => reconcileBase(userId, base, root));
  }
}
