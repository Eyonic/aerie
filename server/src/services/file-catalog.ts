// Persistent, per-user filesystem catalog used by search and bounded listings.
// Filesystem reconciliation is asynchronous; SQLite work is committed in small
// batches with event-loop yields between them.
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import mime from 'mime-types';
import { db } from '../lib/db.js';
import type { FileEntry, FileKind } from '../lib/model.js';
import * as storage from './storage.js';
import { markContentSearchStale } from './content-search-state.js';

export interface FileCatalogUser {
  id: number;
  username: string;
}

export interface FileCatalogEntry {
  path: string;
  parent: string;
  name: string;
  extension: string;
  kind: FileKind;
  mime: string;
  size: number;
  mtimeMs: number;
  birthtimeMs: number;
  isFolder: boolean;
}

export interface FileCatalogRefreshResult {
  userId: number;
  refreshed: boolean;
  refreshing: boolean;
  scanned: number;
  removed: number;
  fileCount: number;
  completedAtMs: number;
}

export interface EnsureFileCatalogOptions {
  maxAgeMs?: number;
  waitForRefresh?: boolean;
}

export interface SearchFileCatalogOptions {
  limit?: number;
  includeFolders?: boolean;
  kinds?: readonly FileKind[];
  modifiedAfterMs?: number;
}

export interface ListFileCatalogOptions {
  extensions?: readonly string[];
  kinds?: readonly FileKind[];
  includeFolders?: boolean;
  sort?: 'recent' | 'name' | 'largest';
  limit?: number;
}

export interface FileCatalogUsage {
  usedBytes: number;
  fileCount: number;
  byKind: Record<string, { count: number; bytes: number }>;
}

interface CatalogRow {
  path: string;
  parent: string;
  name: string;
  extension: string;
  kind: FileKind;
  mime: string;
  size: number;
  mtime_ms: number;
  birthtime_ms: number;
  is_folder: number;
}

interface CatalogStateRow {
  last_started_ms: number;
  last_completed_ms: number;
  invalidated_at_ms: number;
  status: string;
  last_error: string | null;
  file_count: number;
}

interface PendingRow extends CatalogRow {
  name_folded: string;
  name_length: number;
  scan_id: string;
}

const DEFAULT_MAX_AGE_MS = 15_000;
const MAX_QUERY_LIMIT = 200;
const MAX_QUERY_CHARACTERS = 256;
const WRITE_BATCH_SIZE = 128;
const MAX_FUZZY_CANDIDATES = 768;
const VALID_KINDS = new Set<FileKind>([
  'folder', 'text', 'markdown', 'document', 'spreadsheet', 'csv', 'pdf',
  'image', 'video', 'audio', 'archive', 'code', 'other',
]);
const refreshes = new Map<number, Promise<FileCatalogRefreshResult>>();

const upsertRow = db.prepare(`INSERT INTO file_catalog
  (user_id,path,parent,name,name_folded,name_length,extension,kind,mime,size,
   mtime_ms,birthtime_ms,is_folder,scan_id)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  ON CONFLICT(user_id,path) DO UPDATE SET
    parent=excluded.parent,
    name=excluded.name,
    name_folded=excluded.name_folded,
    name_length=excluded.name_length,
    extension=excluded.extension,
    kind=excluded.kind,
    mime=excluded.mime,
    size=excluded.size,
    mtime_ms=excluded.mtime_ms,
    birthtime_ms=excluded.birthtime_ms,
    is_folder=excluded.is_folder,
    scan_id=excluded.scan_id`);

const writeBatch = db.transaction((userId: number, rows: PendingRow[]) => {
  for (const row of rows) {
    upsertRow.run(userId, row.path, row.parent, row.name, row.name_folded,
      row.name_length, row.extension, row.kind, row.mime, row.size,
      row.mtime_ms, row.birthtime_ms, row.is_folder, row.scan_id);
  }
});

function folded(value: string): string {
  return value.normalize('NFKD').replace(/\p{M}/gu, '').toLocaleLowerCase('en-US')
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

function finiteTime(value: number): number {
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

function boundedLimit(value: number | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(1, Math.min(MAX_QUERY_LIMIT, Math.floor(parsed))) : fallback;
}

function asEntry(row: CatalogRow): FileCatalogEntry {
  return {
    path: String(row.path),
    parent: String(row.parent),
    name: String(row.name),
    extension: String(row.extension || ''),
    kind: row.kind,
    mime: String(row.mime),
    size: Number(row.size),
    mtimeMs: Number(row.mtime_ms),
    birthtimeMs: Number(row.birthtime_ms),
    isFolder: !!row.is_folder,
  };
}

function stateFor(userId: number): CatalogStateRow | null {
  return (db.prepare(`SELECT last_started_ms,last_completed_ms,invalidated_at_ms,
    status,last_error,file_count FROM file_catalog_state WHERE user_id=?`).get(userId) as CatalogStateRow | undefined) || null;
}

function resultFromState(userId: number, state: CatalogStateRow | null, refreshing = false): FileCatalogRefreshResult {
  return {
    userId,
    refreshed: false,
    refreshing,
    scanned: 0,
    removed: 0,
    fileCount: Number(state?.file_count || 0),
    completedAtMs: Number(state?.last_completed_ms || 0),
  };
}

function errorText(error: unknown): string {
  return String((error as any)?.message || error || 'catalog_scan_failed').slice(0, 500);
}

function isInside(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(root + path.sep);
}

function virtualPath(root: string, absolute: string): string {
  const relative = path.relative(root, absolute);
  if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
    throw new Error('catalog_path_escape');
  }
  return '/' + relative.split(path.sep).join('/');
}

async function yieldToEventLoop(): Promise<void> {
  await new Promise<void>(resolve => setImmediate(resolve));
}

async function scanFilesystem(user: FileCatalogUser, scanId: string): Promise<number> {
  const root = await storage.userRootAsync(user.username);
  const rootStat = await fsp.lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('unsafe_catalog_root');
  const canonicalRoot = await fsp.realpath(root);
  if (canonicalRoot !== path.resolve(root)) throw new Error('unsafe_catalog_root');

  const directories = [root];
  let directoryIndex = 0;
  let processed = 0;
  let batch: PendingRow[] = [];

  const flush = async () => {
    if (!batch.length) return;
    const pending = batch;
    batch = [];
    writeBatch(user.id, pending);
    await yieldToEventLoop();
  };

  while (directoryIndex < directories.length) {
    const directory = directories[directoryIndex++];
    const directoryStat = await fsp.lstat(directory);
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) continue;
    const canonicalDirectory = await fsp.realpath(directory);
    if (!isInside(canonicalRoot, canonicalDirectory)) continue;

    const handle = await fsp.opendir(directory);
    for await (const dirent of handle) {
      if (dirent.name.startsWith('.')) continue;
      const absolute = path.join(directory, dirent.name);
      let stat;
      try {
        stat = await fsp.lstat(absolute);
      } catch (error: any) {
        // A concurrent deletion is safe to treat as absent. Permission and I/O
        // failures make the scan incomplete and must not permit stale deletion.
        if (error?.code === 'ENOENT') continue;
        throw error;
      }
      if (stat.isSymbolicLink()) continue;

      const isFolder = stat.isDirectory();
      if (!isFolder && !stat.isFile()) continue;
      if (isFolder) {
        let canonicalChild: string;
        try { canonicalChild = await fsp.realpath(absolute); }
        catch (error: any) { if (error?.code === 'ENOENT') continue; throw error; }
        if (!isInside(canonicalRoot, canonicalChild)) continue;
        directories.push(absolute);
      }

      const vpath = virtualPath(root, absolute);
      const name = dirent.name;
      const extension = isFolder ? '' : path.extname(name).slice(1).toLocaleLowerCase('en-US');
      const nameFolded = folded(name);
      batch.push({
        path: vpath,
        parent: path.posix.dirname(vpath),
        name,
        name_folded: nameFolded,
        name_length: Array.from(nameFolded).length,
        extension,
        kind: storage.kindOf(name, isFolder),
        mime: (mime.lookup(name) || (isFolder ? 'inode/directory' : 'application/octet-stream')) as string,
        size: isFolder ? 0 : Number(stat.size),
        mtime_ms: finiteTime(stat.mtimeMs),
        birthtime_ms: finiteTime(stat.birthtimeMs),
        is_folder: isFolder ? 1 : 0,
        scan_id: scanId,
      });
      processed++;
      if (batch.length >= WRITE_BATCH_SIZE) await flush();
    }
  }
  await flush();
  return processed;
}

async function runRefresh(user: FileCatalogUser): Promise<FileCatalogRefreshResult> {
  if (!Number.isSafeInteger(user.id) || user.id <= 0 || !user.username) throw new Error('invalid_catalog_user');
  const startedAt = Date.now();
  const scanId = crypto.randomUUID();
  db.prepare(`INSERT INTO file_catalog_state
    (user_id,last_started_ms,status,last_error) VALUES (?,?,'scanning',NULL)
    ON CONFLICT(user_id) DO UPDATE SET
      last_started_ms=excluded.last_started_ms,status='scanning',last_error=NULL`).run(user.id, startedAt);

  try {
    const scanned = await scanFilesystem(user, scanId);
    const completedAt = Date.now();
    let removed = 0;
    db.transaction(() => {
      const deletion = db.prepare('DELETE FROM file_catalog WHERE user_id=? AND scan_id<>?').run(user.id, scanId);
      removed = Number(deletion.changes || 0);
      db.prepare(`UPDATE file_catalog_state SET
        last_completed_ms=?,status='ready',last_error=NULL,file_count=?
        WHERE user_id=?`).run(completedAt, scanned, user.id);
    })();
    return {
      userId: user.id,
      refreshed: true,
      refreshing: false,
      scanned,
      removed,
      fileCount: scanned,
      completedAtMs: completedAt,
    };
  } catch (error) {
    db.prepare(`UPDATE file_catalog_state SET status='error',last_error=? WHERE user_id=?`)
      .run(errorText(error), user.id);
    throw error;
  }
}

/** Force an on-demand refresh, joining an already-running refresh for the user. */
export function refreshFileCatalog(user: FileCatalogUser): Promise<FileCatalogRefreshResult> {
  const running = refreshes.get(user.id);
  if (running) return running;
  const refresh = runRefresh(user).finally(() => {
    if (refreshes.get(user.id) === refresh) refreshes.delete(user.id);
  });
  refreshes.set(user.id, refresh);
  return refresh;
}

/**
 * Ensure the catalog exists. A cold start is awaited. Once populated, stale
 * catalogs are served while a refresh runs unless waitForRefresh is requested.
 */
export async function ensureFileCatalog(
  user: FileCatalogUser,
  options: EnsureFileCatalogOptions = {},
): Promise<FileCatalogRefreshResult> {
  const state = stateFor(user.id);
  const maxAgeMs = Number.isFinite(options.maxAgeMs)
    ? Math.max(0, Number(options.maxAgeMs))
    : DEFAULT_MAX_AGE_MS;
  const completedAt = Number(state?.last_completed_ms || 0);
  const invalidatedAt = Number(state?.invalidated_at_ms || 0);
  const stale = !completedAt || invalidatedAt > completedAt || Date.now() - completedAt >= maxAgeMs;
  if (!stale) return resultFromState(user.id, state);

  const refresh = refreshFileCatalog(user);
  if (!completedAt || options.waitForRefresh === true) return refresh;
  void refresh.catch(() => { /* prior complete catalog remains usable */ });
  return resultFromState(user.id, state, true);
}

/** Mark prior results stale without discarding them. */
export function markFileCatalogStale(userId: number): void {
  if (!Number.isSafeInteger(userId) || userId <= 0) return;
  const state = stateFor(userId);
  const invalidatedAt = Math.max(Date.now(), Number(state?.last_completed_ms || 0) + 1);
  db.prepare(`INSERT INTO file_catalog_state (user_id,invalidated_at_ms,status)
    VALUES (?,?,'idle')
    ON CONFLICT(user_id) DO UPDATE SET invalidated_at_ms=excluded.invalidated_at_ms`).run(userId, invalidatedAt);
  markContentSearchStale(userId);
}

function normalizeExtensions(values: readonly string[] | undefined): string[] | null {
  if (!values) return null;
  return [...new Set(values.slice(0, 64).map(value => String(value).trim().replace(/^\.+/, '')
    .toLocaleLowerCase('en-US')).filter(Boolean))];
}

function normalizeKinds(values: readonly FileKind[] | undefined): FileKind[] | null {
  if (!values) return null;
  return [...new Set(values.slice(0, 32).filter(value => VALID_KINDS.has(value)))];
}

/** Indexed and hard-bounded extension/type/recent/name listing. */
export function listFileCatalog(userId: number, options: ListFileCatalogOptions = {}): FileCatalogEntry[] {
  const limit = boundedLimit(options.limit, 24);
  const extensions = normalizeExtensions(options.extensions);
  const kinds = normalizeKinds(options.kinds);
  if ((options.extensions && !extensions?.length) || (options.kinds && !kinds?.length)) return [];

  const where = ['user_id=?'];
  const params: Array<string | number> = [userId];
  if (options.includeFolders !== true) where.push('is_folder=0');
  if (extensions?.length) {
    where.push(`extension IN (${extensions.map(() => '?').join(',')})`);
    params.push(...extensions);
  }
  if (kinds?.length) {
    where.push(`kind IN (${kinds.map(() => '?').join(',')})`);
    params.push(...kinds);
  }
  const order = options.sort === 'name'
    ? 'is_folder DESC, name_folded ASC, path ASC'
    : options.sort === 'largest'
      ? 'size DESC, path ASC'
      : 'mtime_ms DESC, path ASC';
  params.push(limit);
  const rows = db.prepare(`SELECT path,parent,name,extension,kind,mime,size,mtime_ms,birthtime_ms,is_folder
    FROM file_catalog WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT ?`).all(...params) as CatalogRow[];
  return rows.map(asEntry);
}

/** Constant-query-count usage summary; FileKind bounds the GROUP BY cardinality. */
export function fileCatalogUsage(userId: number): FileCatalogUsage {
  const rows = db.prepare(`SELECT kind,COUNT(*) count,COALESCE(SUM(size),0) bytes
    FROM file_catalog WHERE user_id=? AND is_folder=0 GROUP BY kind`).all(userId) as Array<{
      kind: string;
      count: number;
      bytes: number;
    }>;
  const byKind: Record<string, { count: number; bytes: number }> = {};
  let usedBytes = 0;
  let fileCount = 0;
  for (const row of rows) {
    if (!VALID_KINDS.has(row.kind as FileKind) || row.kind === 'folder') continue;
    const count = Number(row.count || 0);
    const bytes = Number(row.bytes || 0);
    byKind[row.kind] = { count, bytes };
    fileCount += count;
    usedBytes += bytes;
  }
  return { usedBytes, fileCount, byKind };
}

function levenshtein(a: string, b: string): number {
  const previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let ai = 1; ai <= a.length; ai++) {
    let diagonal = previous[0];
    previous[0] = ai;
    for (let bi = 1; bi <= b.length; bi++) {
      const above = previous[bi];
      previous[bi] = Math.min(previous[bi] + 1, previous[bi - 1] + 1,
        diagonal + (a[ai - 1] === b[bi - 1] ? 0 : 1));
      diagonal = above;
    }
  }
  return previous[b.length];
}

function fuzzyScore(query: string, entry: CatalogRow): number {
  const name = folded(entry.name);
  const parent = folded(entry.parent);
  const value = `${name} ${parent}`.trim();
  if (name === query) return 1_000;
  if (name.startsWith(query)) return 900 - Math.min(100, name.length - query.length);
  if (value.split(' ').some(word => word.startsWith(query))) return 820;
  const at = value.indexOf(query);
  if (at >= 0) return 750 - Math.min(100, at);
  const queryTokens = query.split(' ');
  if (queryTokens.length > 1 && queryTokens.every(token => value.includes(token))) return 650;
  if (queryTokens.length === 1) {
    let best = Infinity;
    for (const word of name.split(' ')) {
      if (Math.abs(word.length - query.length) <= 3) best = Math.min(best, levenshtein(query, word));
    }
    const allowance = Math.max(1, Math.min(3, Math.floor(query.length / 4)));
    if (best <= allowance) return 620 - best * 70;
    let qi = 0;
    for (const character of name) if (character === query[qi]) qi++;
    if (qi === query.length && query.length >= 4) return 350;
  }
  return 0;
}

function ftsQuery(query: string, broad = false): string {
  return query.split(' ').filter(Boolean).slice(0, 8)
    .map(token => {
      const candidate = broad && token.length >= 4
        ? token.slice(0, Math.max(2, Math.min(4, token.length - 2)))
        : token;
      return `"${candidate.replace(/"/g, '""')}"*`;
    }).join(' AND ');
}

function addCandidates(target: Map<string, CatalogRow>, rows: CatalogRow[]): void {
  for (const row of rows) target.set(row.path, row);
}

/** Indexed token/prefix search with a bounded typo-candidate fallback. */
export function searchFileCatalog(
  userId: number,
  query: string,
  options: SearchFileCatalogOptions = {},
): FileCatalogEntry[] {
  const normalized = Array.from(folded(String(query || ''))).slice(0, MAX_QUERY_CHARACTERS).join('');
  if (!normalized) return [];
  const limit = boundedLimit(options.limit, 20);
  const kinds = normalizeKinds(options.kinds);
  if (options.kinds && !kinds?.length) return [];
  const folderSql = options.includeFolders === false ? ' AND c.is_folder=0' : '';
  const kindSql = kinds?.length ? ` AND c.kind IN (${kinds.map(() => '?').join(',')})` : '';
  const modifiedAfter = Number(options.modifiedAfterMs);
  const modifiedSql = Number.isFinite(modifiedAfter) && modifiedAfter > 0 ? ' AND c.mtime_ms>=?' : '';
  const filterSql = `${folderSql}${kindSql}${modifiedSql}`;
  const filterParams: Array<string | number> = [...(kinds || [])];
  if (modifiedSql) filterParams.push(modifiedAfter);
  const select = `SELECT c.path,c.parent,c.name,c.extension,c.kind,c.mime,c.size,
    c.mtime_ms,c.birthtime_ms,c.is_folder FROM file_catalog_fts
    JOIN file_catalog c ON c.id=file_catalog_fts.rowid`;
  const candidates = new Map<string, CatalogRow>();

  const tokenRows = db.prepare(`${select}
    WHERE file_catalog_fts MATCH ? AND c.user_id=?${filterSql}
    ORDER BY bm25(file_catalog_fts), c.name_folded, c.path LIMIT ?`)
    .all(ftsQuery(normalized), userId, ...filterParams,
      Math.min(MAX_FUZZY_CANDIDATES, limit * 8)) as CatalogRow[];
  addCandidates(candidates, tokenRows);

  if (normalized.split(' ').every(token => token.length >= 4)
      && candidates.size < MAX_FUZZY_CANDIDATES) {
    const broadRows = db.prepare(`${select}
      WHERE file_catalog_fts MATCH ? AND c.user_id=?${filterSql}
      ORDER BY bm25(file_catalog_fts), c.name_folded, c.path LIMIT ?`)
      .all(ftsQuery(normalized, true), userId, ...filterParams,
        MAX_FUZZY_CANDIDATES - candidates.size) as CatalogRow[];
    addCandidates(candidates, broadRows);
  }

  const first = Array.from(normalized)[0];
  if (first) {
    const prefixRows = db.prepare(`SELECT c.path,c.parent,c.name,c.extension,c.kind,c.mime,c.size,
      c.mtime_ms,c.birthtime_ms,c.is_folder FROM file_catalog c
      WHERE c.user_id=? AND c.name_folded>=? AND c.name_folded<?${filterSql}
      ORDER BY c.name_folded,c.path LIMIT ?`)
      .all(userId, first, first + '\u{10ffff}', ...filterParams, MAX_FUZZY_CANDIDATES) as CatalogRow[];
    addCandidates(candidates, prefixRows);
  }

  // A misspelling in the first character cannot use the prefix index. A
  // tightly bounded length-index range supplies candidates for edit distance.
  if (normalized.indexOf(' ') < 0 && candidates.size < MAX_FUZZY_CANDIDATES) {
    const length = Array.from(normalized).length;
    const remaining = MAX_FUZZY_CANDIDATES - candidates.size;
    const lengthRows = db.prepare(`SELECT c.path,c.parent,c.name,c.extension,c.kind,c.mime,c.size,
      c.mtime_ms,c.birthtime_ms,c.is_folder FROM file_catalog c
      WHERE c.user_id=? AND c.name_length BETWEEN ? AND ?${filterSql}
      ORDER BY ABS(c.name_length-?),c.name_folded,c.path LIMIT ?`)
      .all(userId, Math.max(0, length - 3), length + 3, ...filterParams, length, remaining) as CatalogRow[];
    addCandidates(candidates, lengthRows);
  }

  return [...candidates.values()]
    .map(row => ({ row, score: fuzzyScore(normalized, row) }))
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score || a.row.name.localeCompare(b.row.name)
      || a.row.path.localeCompare(b.row.path))
    .slice(0, limit)
    .map(item => asEntry(item.row));
}

/** Convert a catalog row to the existing files API contract. */
export function toFileEntry(row: FileCatalogEntry, options: { starred?: boolean } = {}): FileEntry {
  const entry: FileEntry = {
    id: Buffer.from(row.path).toString('base64url'),
    name: row.name,
    path: row.path,
    parent: row.parent,
    kind: row.kind,
    mime: row.mime,
    size: row.size,
    modifiedAt: new Date(row.mtimeMs).toISOString(),
    createdAt: new Date(row.birthtimeMs).toISOString(),
    isFolder: row.isFolder,
    starred: options.starred === true,
  };
  if (row.kind === 'image' || row.kind === 'video') {
    entry.thumbUrl = `/api/files/thumb?path=${encodeURIComponent(row.path)}`;
  }
  return entry;
}
