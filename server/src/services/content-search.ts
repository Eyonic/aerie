// Durable, per-user full-content search. Reconciliation builds an isolated
// generation and only publishes it after every candidate has been processed;
// the last complete generation therefore survives crashes and malformed files.
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import sanitizeHtml from 'sanitize-html';
import { OfficeParser } from 'officeparser';
import { db } from '../lib/db.js';
import type { FileKind } from '../lib/model.js';
import { ensureFileCatalog, type FileCatalogUser } from './file-catalog.js';
import * as storage from './storage.js';

export { markContentSearchStale } from './content-search-state.js';

export const CONTENT_SEARCH_LIMITS = {
  maxCandidates: 20_000,
  maxTextBytes: 4 * 1024 * 1024,
  maxPdfBytes: 20 * 1024 * 1024,
  maxCharsPerFile: 512 * 1024,
  maxCharsPerUser: 64 * 1024 * 1024,
  maxPdfParseMs: 12_000,
  maxArchiveBytes: 64 * 1024 * 1024,
  maxArchiveEntries: 2_000,
  maxTableCells: 500_000,
} as const;

const SUPPORTED_EXTENSIONS = ['cbxdoc', 'md', 'markdown', 'txt', 'cbxsheet', 'csv', 'tsv', 'pdf'] as const;
const DEFAULT_MAX_AGE_MS = 60_000;
const refreshes = new Map<number, Promise<ContentIndexState>>();

interface CatalogCandidate {
  path: string;
  parent: string;
  name: string;
  extension: string;
  kind: FileKind;
  size: number;
  mtime_ms: number;
}

interface StateRow {
  active_scan_id: string | null;
  last_started_ms: number;
  last_completed_ms: number;
  invalidated_at_ms: number;
  status: string;
  last_error: string | null;
  indexed_count: number;
  skipped_count: number;
  truncated_count: number;
  indexed_chars: number;
}

export interface ContentIndexState {
  ready: boolean;
  refreshing: boolean;
  stale: boolean;
  indexedCount: number;
  skippedCount: number;
  truncatedCount: number;
  indexedChars: number;
  completedAtMs: number;
}

export interface ContentSearchResult {
  path: string;
  parent: string;
  name: string;
  extension: string;
  kind: FileKind;
  size: number;
  mtimeMs: number;
  snippet: string;
}

export interface ContentSearchOptions {
  kinds?: readonly FileKind[];
  modifiedAfterMs?: number;
  limit?: number;
}

function stateRow(userId: number): StateRow | null {
  return (db.prepare(`SELECT active_scan_id,last_started_ms,last_completed_ms,invalidated_at_ms,
    status,last_error,indexed_count,skipped_count,truncated_count,indexed_chars
    FROM content_search_state WHERE user_id=?`).get(userId) as StateRow | undefined) || null;
}

function publicState(row: StateRow | null, refreshing = false): ContentIndexState {
  const ready = !!row?.active_scan_id;
  const stale = !ready || Number(row?.invalidated_at_ms || 0) > Number(row?.last_started_ms || 0);
  return {
    ready,
    refreshing: refreshing || row?.status === 'scanning',
    stale,
    indexedCount: Number(row?.indexed_count || 0),
    skippedCount: Number(row?.skipped_count || 0),
    truncatedCount: Number(row?.truncated_count || 0),
    indexedChars: Number(row?.indexed_chars || 0),
    completedAtMs: Number(row?.last_completed_ms || 0),
  };
}

function errorText(error: unknown): string {
  return String((error as any)?.message || error || 'content_index_failed').slice(0, 500);
}

function normalizeBody(value: string): string {
  return value.replace(/\0/g, ' ').replace(/\r\n?/g, '\n')
    .replace(/[\t\f\v ]+/g, ' ').replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n').trim();
}

export function htmlToSearchText(html: string): string {
  const separated = html.replace(/<\/?(?:address|article|aside|blockquote|br|caption|div|dd|dt|figcaption|footer|h[1-6]|header|hr|li|main|nav|p|pre|section|td|th|tr)\b[^>]*>/gi, '\n');
  return normalizeBody(sanitizeHtml(separated, { allowedTags: [], allowedAttributes: {} }));
}

function sheetToSearchText(raw: string): string {
  const parsed = JSON.parse(raw || '{}') as any;
  if (!parsed || typeof parsed !== 'object') throw new Error('invalid_spreadsheet');
  const sheets = Array.isArray(parsed.sheets) ? parsed.sheets : [{ name: 'Sheet 1', grid: parsed.grid }];
  const out: string[] = [];
  let cells = 0;
  let characters = 0;
  const append = (value: string) => {
    out.push(value);
    characters += value.length + 1;
  };
  for (const sheet of sheets.slice(0, 64)) {
    if (typeof sheet?.name === 'string') append(sheet.name.slice(0, 500));
    if (!Array.isArray(sheet?.grid)) continue;
    for (const row of sheet.grid) {
      if (!Array.isArray(row)) continue;
      const values: string[] = [];
      for (const cell of row) {
        if (++cells > CONTENT_SEARCH_LIMITS.maxTableCells) return normalizeBody(out.join('\n'));
        if (typeof cell === 'string' || typeof cell === 'number' || typeof cell === 'boolean') {
          values.push(String(cell).slice(0, 16_384));
        }
      }
      if (values.length) append(values.join(' '));
      if (characters >= CONTENT_SEARCH_LIMITS.maxCharsPerFile) return normalizeBody(out.join('\n'));
    }
  }
  return normalizeBody(out.join('\n'));
}

async function readBounded(real: string, maximum: number): Promise<Buffer> {
  const handle = await fsp.open(real, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > maximum) throw new Error('content_file_too_large');
    const buffer = Buffer.allocUnsafe(stat.size);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    return offset === buffer.length ? buffer : buffer.subarray(0, offset);
  } finally {
    await handle.close();
  }
}

async function pdfText(buffer: Buffer): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CONTENT_SEARCH_LIMITS.maxPdfParseMs);
  try {
    const ast = await OfficeParser.parseOffice(buffer, {
      fileType: 'pdf',
      abortSignal: controller.signal,
      ocr: false,
      extractAttachments: false,
      includeRawContent: false,
      ignoreComments: true,
      ignoreNotes: true,
      decompressionLimits: {
        maxUncompressedBytes: CONTENT_SEARCH_LIMITS.maxArchiveBytes,
        maxZipEntries: CONTENT_SEARCH_LIMITS.maxArchiveEntries,
        maxTableCells: CONTENT_SEARCH_LIMITS.maxTableCells,
      },
    });
    return normalizeBody(ast.toText());
  } finally {
    clearTimeout(timeout);
  }
}

async function extractCandidate(user: FileCatalogUser, item: CatalogCandidate): Promise<{ body: string; truncated: boolean } | null> {
  const extension = item.extension.toLowerCase();
  const maximum = extension === 'pdf' ? CONTENT_SEARCH_LIMITS.maxPdfBytes : CONTENT_SEARCH_LIMITS.maxTextBytes;
  if (item.size > maximum) return null;
  const { real, stat } = await storage.statRealAsync(user.username, item.path);
  if (!stat.isFile() || stat.size > maximum) return null;
  const buffer = await readBounded(real, maximum);
  let body: string;
  if (extension === 'pdf') body = await pdfText(buffer);
  else {
    const raw = buffer.toString('utf8');
    if (extension === 'cbxdoc') body = htmlToSearchText(raw);
    else if (extension === 'cbxsheet') body = sheetToSearchText(raw);
    else body = normalizeBody(raw);
  }
  if (!body) return null;
  const truncated = body.length > CONTENT_SEARCH_LIMITS.maxCharsPerFile;
  return { body: body.slice(0, CONTENT_SEARCH_LIMITS.maxCharsPerFile), truncated };
}

const insertEntry = db.prepare(`INSERT INTO content_search_entries
  (user_id,scan_id,path,parent,name,extension,kind,size,mtime_ms,body,body_truncated)
  VALUES (?,?,?,?,?,?,?,?,?,?,?)`);

const insertBatch = db.transaction((userId: number, scanId: string, rows: Array<CatalogCandidate & { body: string; truncated: boolean }>) => {
  for (const row of rows) insertEntry.run(userId, scanId, row.path, row.parent, row.name,
    row.extension, row.kind, row.size, row.mtime_ms, row.body, row.truncated ? 1 : 0);
});

async function eventLoopYield(): Promise<void> {
  await new Promise<void>(resolve => setImmediate(resolve));
}

async function runRefresh(user: FileCatalogUser): Promise<ContentIndexState> {
  if (!Number.isSafeInteger(user.id) || user.id < 1 || !user.username) throw new Error('invalid_content_index_user');
  await ensureFileCatalog(user, { waitForRefresh: true });
  const previous = stateRow(user.id);
  const startedAt = Math.max(Date.now(), Number(previous?.invalidated_at_ms || 0) + 1,
    Number(previous?.last_started_ms || 0) + 1);
  const scanId = crypto.randomUUID();

  db.transaction(() => {
    // Remove only abandoned generations. The active generation remains
    // searchable throughout this scan.
    if (previous?.active_scan_id) {
      db.prepare('DELETE FROM content_search_entries WHERE user_id=? AND scan_id<>?')
        .run(user.id, previous.active_scan_id);
    } else db.prepare('DELETE FROM content_search_entries WHERE user_id=?').run(user.id);
    db.prepare(`INSERT INTO content_search_state
      (user_id,last_started_ms,status,last_error) VALUES (?,?,'scanning',NULL)
      ON CONFLICT(user_id) DO UPDATE SET
        last_started_ms=excluded.last_started_ms,status='scanning',last_error=NULL`)
      .run(user.id, startedAt);
  })();

  let indexed = 0;
  let skipped = 0;
  let truncated = 0;
  let chars = 0;
  let batch: Array<CatalogCandidate & { body: string; truncated: boolean }> = [];
  const placeholders = SUPPORTED_EXTENSIONS.map(() => '?').join(',');
  const total = Number((db.prepare(`SELECT COUNT(*) count FROM file_catalog
    WHERE user_id=? AND is_folder=0 AND extension IN (${placeholders})`)
    .get(user.id, ...SUPPORTED_EXTENSIONS) as any)?.count || 0);
  const candidates = db.prepare(`SELECT path,parent,name,extension,kind,size,mtime_ms
    FROM file_catalog WHERE user_id=? AND is_folder=0 AND extension IN (${placeholders})
    ORDER BY mtime_ms DESC,path LIMIT ?`)
    .all(user.id, ...SUPPORTED_EXTENSIONS, CONTENT_SEARCH_LIMITS.maxCandidates) as CatalogCandidate[];
  skipped += Math.max(0, total - candidates.length);

  const flush = async () => {
    if (!batch.length) return;
    const pending = batch;
    batch = [];
    insertBatch(user.id, scanId, pending);
    await eventLoopYield();
  };

  try {
    for (const item of candidates) {
      if (chars >= CONTENT_SEARCH_LIMITS.maxCharsPerUser) { skipped++; continue; }
      let extracted: Awaited<ReturnType<typeof extractCandidate>>;
      try {
        extracted = await extractCandidate(user, item);
      } catch {
        // A single corrupt, concurrently removed, encrypted or unsupported PDF
        // cannot make the prior complete index disappear.
        skipped++;
        continue;
      }
      if (!extracted) { skipped++; continue; }
      const remaining = CONTENT_SEARCH_LIMITS.maxCharsPerUser - chars;
      const body = extracted.body.slice(0, remaining);
      if (!body) { skipped++; continue; }
      const wasTruncated = extracted.truncated || body.length < extracted.body.length;
      batch.push({ ...item, body, truncated: wasTruncated });
      indexed++;
      chars += body.length;
      if (wasTruncated) truncated++;
      // Database failures must abort this generation. Treating them like a
      // malformed source file could publish a silently incomplete index.
      if (batch.length >= 24) await flush();
    }
    await flush();
    const completedAt = Date.now();
    db.transaction(() => {
      const current = stateRow(user.id);
      if (Number(current?.last_started_ms || 0) !== startedAt) {
        throw new Error('content_index_superseded');
      }
      const staleAgain = Number(current?.invalidated_at_ms || 0) > startedAt;
      db.prepare(`UPDATE content_search_state SET active_scan_id=?,last_completed_ms=?,
        status=?,last_error=NULL,indexed_count=?,skipped_count=?,truncated_count=?,indexed_chars=?
        WHERE user_id=? AND last_started_ms=?`)
        .run(scanId, completedAt, staleAgain ? 'idle' : 'ready', indexed, skipped, truncated, chars, user.id, startedAt);
      db.prepare('DELETE FROM content_search_entries WHERE user_id=? AND scan_id<>?').run(user.id, scanId);
    })();
    return publicState(stateRow(user.id));
  } catch (error) {
    db.transaction(() => {
      db.prepare('DELETE FROM content_search_entries WHERE user_id=? AND scan_id=?').run(user.id, scanId);
      db.prepare(`UPDATE content_search_state SET status='error',last_error=?
        WHERE user_id=? AND last_started_ms=?`).run(errorText(error), user.id, startedAt);
    })();
    throw error;
  }
}

export function refreshContentSearchIndex(user: FileCatalogUser): Promise<ContentIndexState> {
  const running = refreshes.get(user.id);
  if (running) return running;
  const refresh = runRefresh(user).finally(() => {
    if (refreshes.get(user.id) === refresh) refreshes.delete(user.id);
  });
  refreshes.set(user.id, refresh);
  return refresh;
}

export async function ensureContentSearchIndex(
  user: FileCatalogUser,
  options: { maxAgeMs?: number; coldWaitMs?: number } = {},
): Promise<ContentIndexState> {
  const row = stateRow(user.id);
  const maxAgeMs = Number.isFinite(options.maxAgeMs) ? Math.max(0, Number(options.maxAgeMs)) : DEFAULT_MAX_AGE_MS;
  const stale = !row?.active_scan_id || Number(row.invalidated_at_ms || 0) > Number(row.last_started_ms || 0)
    || Date.now() - Number(row.last_completed_ms || 0) >= maxAgeMs;
  if (!stale) return publicState(row);
  const refresh = refreshContentSearchIndex(user);
  const coldWaitMs = row?.active_scan_id ? 0 : Math.max(0, Math.min(5_000, Number(options.coldWaitMs ?? 1_200)));
  if (coldWaitMs > 0) {
    await Promise.race([refresh.catch(() => undefined), new Promise(resolve => setTimeout(resolve, coldWaitMs))]);
  } else void refresh.catch(() => { /* the previous complete generation remains queryable */ });
  return publicState(stateRow(user.id), refreshes.has(user.id));
}

function ftsBodyQuery(query: string): string {
  const tokens = query.normalize('NFKC').match(/[\p{L}\p{N}]+/gu)?.slice(0, 8) || [];
  return tokens.map(token => `body : "${token.replace(/"/g, '""')}"*`).join(' AND ');
}

function boundedLimit(value: number | undefined): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(1, Math.min(50, Math.floor(parsed))) : 12;
}

export function searchContentIndex(userId: number, query: string, options: ContentSearchOptions = {}): ContentSearchResult[] {
  const match = ftsBodyQuery(String(query || '').slice(0, 256));
  const active = stateRow(userId)?.active_scan_id;
  if (!match || !active) return [];
  const where = ['e.user_id=?', 'e.scan_id=?'];
  const params: Array<string | number> = [match, userId, active];
  const kinds = [...new Set((options.kinds || []).filter(Boolean))].slice(0, 16);
  if (kinds.length) {
    where.push(`e.kind IN (${kinds.map(() => '?').join(',')})`);
    params.push(...kinds);
  }
  if (Number.isFinite(options.modifiedAfterMs) && Number(options.modifiedAfterMs) > 0) {
    where.push('e.mtime_ms>=?');
    params.push(Number(options.modifiedAfterMs));
  }
  params.push(boundedLimit(options.limit));
  const rows = db.prepare(`SELECT e.path,e.parent,e.name,e.extension,e.kind,e.size,e.mtime_ms,
    snippet(content_search_fts,2,'','', ' … ',24) snippet
    FROM content_search_fts JOIN content_search_entries e ON e.id=content_search_fts.rowid
    WHERE content_search_fts MATCH ? AND ${where.join(' AND ')}
    ORDER BY bm25(content_search_fts,0.0,0.0,1.0),e.mtime_ms DESC,e.path LIMIT ?`)
    .all(...params) as any[];
  return rows.map(row => ({
    path: String(row.path), parent: String(row.parent), name: String(row.name),
    extension: String(row.extension), kind: row.kind as FileKind, size: Number(row.size),
    mtimeMs: Number(row.mtime_ms), snippet: normalizeBody(String(row.snippet || '')).slice(0, 320),
  }));
}

export function contentIndexState(userId: number): ContentIndexState {
  return publicState(stateRow(userId), refreshes.has(userId));
}
