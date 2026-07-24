// Filesystem-backed file storage, sandboxed per user under FILES_ROOT/<username>.
// All public functions take a user and a POSIX "virtual" path (rooted at /).
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import mime from 'mime-types';
import { config } from '../config.js';
import type { FileEntry, FileKind, FileListing, StorageUsage } from '../lib/model.js';
import { db } from '../lib/db.js';

const storageIdentityCache = new Map<string, string>();
const verifiedRoots = new Set<string>();
const rootChecks = new Map<string, Promise<string>>();

export function invalidateStorageIdentity(username?: string): void {
  if (username) storageIdentityCache.delete(String(username).toLowerCase());
  else storageIdentityCache.clear();
  // Account renames/storage migrations are rare. Clearing this tiny cache is
  // safer than retaining a verified path for an identity that may have moved.
  verifiedRoots.clear();
  rootChecks.clear();
}

function userRootPath(username: string): string {
  const base = path.resolve(config.filesRoot);
  const cacheKey = String(username).toLowerCase();
  let storageId = storageIdentityCache.get(cacheKey) || username;
  if (!storageIdentityCache.has(cacheKey)) {
    try {
      const row = db.prepare('SELECT storage_id FROM users WHERE username=? COLLATE NOCASE').get(username) as any;
      storageId = String(row?.storage_id || username);
      storageIdentityCache.set(cacheKey, storageId);
    } catch { /* standalone service tests may intentionally provide no users table */ }
  }
  // storage_id is generated internally. The fallback supports isolated service
  // tests without a users row but still cannot escape FILES_ROOT.
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(storageId) || storageId === '..') {
    throw Object.assign(new Error('unsafe_storage_identity'), { status: 500 });
  }
  const root = path.resolve(base, storageId);
  if (!root.startsWith(base + path.sep)) throw Object.assign(new Error('unsafe_storage_identity'), { status: 500 });
  return root;
}

function validateRootStat(rootStat: fs.Stats): void {
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw Object.assign(new Error('unsafe_storage_root'), { status: 500 });
  }
}

export function userRoot(username: string): string {
  const root = userRootPath(username);
  if (verifiedRoots.has(root)) return root;
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const rootStat = fs.lstatSync(root);
  validateRootStat(rootStat);
  verifiedRoots.add(root);
  return root;
}

export async function userRootAsync(username: string): Promise<string> {
  const root = userRootPath(username);
  if (verifiedRoots.has(root)) return root;
  const existing = rootChecks.get(root);
  if (existing) return existing;
  const checking = (async () => {
    await fsp.mkdir(root, { recursive: true, mode: 0o700 });
    validateRootStat(await fsp.lstat(root));
    verifiedRoots.add(root);
    return root;
  })().finally(() => rootChecks.delete(root));
  rootChecks.set(root, checking);
  return checking;
}

function assertNoSymlink(root: string, target: string): void {
  const relative = path.relative(root, target);
  let current = root;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    try {
      if (fs.lstatSync(current).isSymbolicLink()) {
        throw Object.assign(new Error('unsafe_symlink'), { status: 400 });
      }
    } catch (error: any) {
      if (error?.code === 'ENOENT') return;
      throw error;
    }
  }
}

async function assertNoSymlinkAsync(root: string, target: string): Promise<void> {
  const relative = path.relative(root, target);
  let current = root;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    try {
      if ((await fsp.lstat(current)).isSymbolicLink()) {
        throw Object.assign(new Error('unsafe_symlink'), { status: 400 });
      }
    } catch (error: any) {
      if (error?.code === 'ENOENT') return;
      throw error;
    }
  }
}

function pathWithinRoot(root: string, vpath: string): string {
  const clean = path.posix.normalize('/' + (vpath || '/')).replace(/^(\.\.[/\\])+/, '/');
  const real = path.resolve(root, '.' + clean);
  if (real !== root && !real.startsWith(root + path.sep)) {
    throw Object.assign(new Error('path_escape'), { status: 400 });
  }
  return real;
}

// Resolve a virtual path to a real path, refusing traversal outside the root.
export function resolve(username: string, vpath: string): string {
  const root = userRoot(username);
  const real = pathWithinRoot(root, vpath);
  assertNoSymlink(root, real);
  return real;
}

export async function resolveAsync(username: string, vpath: string): Promise<string> {
  const root = await userRootAsync(username);
  const real = pathWithinRoot(root, vpath);
  await assertNoSymlinkAsync(root, real);
  return real;
}

export function toVirtual(username: string, real: string): string {
  // Conversion is pure: callers that already performed an async filesystem
  // check must not fall back to synchronous lstat for every listed child.
  const root = userRootPath(username);
  const relative = path.relative(root, real);
  if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
    throw Object.assign(new Error('path_escape'), { status: 400 });
  }
  const v = '/' + relative.split(path.sep).join('/');
  return v === '/.' ? '/' : v;
}

const KIND_BY_EXT: Record<string, FileKind> = {
  '.txt': 'text', '.log': 'text', '.md': 'markdown', '.markdown': 'markdown',
  '.doc': 'document', '.docx': 'document', '.rtf': 'document', '.odt': 'document',
  '.cbxdoc': 'document', '.cbxsheet': 'spreadsheet',
  '.csv': 'csv', '.tsv': 'csv', '.xls': 'spreadsheet', '.xlsx': 'spreadsheet', '.ods': 'spreadsheet',
  '.pdf': 'pdf',
  '.jpg': 'image', '.jpeg': 'image', '.png': 'image', '.gif': 'image', '.webp': 'image',
  '.heic': 'image', '.bmp': 'image', '.svg': 'image', '.tiff': 'image', '.avif': 'image',
  '.mp4': 'video', '.mkv': 'video', '.mov': 'video', '.avi': 'video', '.webm': 'video', '.m4v': 'video',
  '.mp3': 'audio', '.flac': 'audio', '.wav': 'audio', '.m4a': 'audio', '.aac': 'audio', '.ogg': 'audio', '.opus': 'audio',
  '.zip': 'archive', '.tar': 'archive', '.gz': 'archive', '.7z': 'archive', '.rar': 'archive',
  '.js': 'code', '.ts': 'code', '.tsx': 'code', '.jsx': 'code', '.py': 'code', '.json': 'code',
  '.html': 'code', '.css': 'code', '.sh': 'code', '.go': 'code', '.rs': 'code', '.java': 'code', '.c': 'code', '.cpp': 'code',
};

export function kindOf(name: string, isFolder: boolean): FileKind {
  if (isFolder) return 'folder';
  return KIND_BY_EXT[path.extname(name).toLowerCase()] || 'other';
}

function star(userId: number, vpath: string): boolean {
  return !!db.prepare('SELECT 1 FROM stars WHERE user_id=? AND path=?').get(userId, vpath);
}

export function entryFor(username: string, userId: number, real: string, starredOverride?: boolean): FileEntry {
  const st = fs.lstatSync(real);
  if (st.isSymbolicLink()) throw Object.assign(new Error('unsafe_symlink'), { status: 400 });
  const isFolder = st.isDirectory();
  const vpath = toVirtual(username, real);
  const name = path.basename(real) || '/';
  const kind = kindOf(name, isFolder);
  let itemCount: number | undefined;
  if (isFolder) {
    try { itemCount = fs.readdirSync(real).filter(n => !n.startsWith('.')).length; } catch { itemCount = 0; }
  }
  const entry: FileEntry = {
    id: Buffer.from(vpath).toString('base64url'),
    name,
    path: vpath,
    parent: path.posix.dirname(vpath),
    kind,
    mime: (mime.lookup(name) || (isFolder ? 'inode/directory' : 'application/octet-stream')) as string,
    size: isFolder ? 0 : st.size,
    modifiedAt: st.mtime.toISOString(),
    createdAt: st.birthtime.toISOString(),
    isFolder,
    starred: starredOverride ?? star(userId, vpath),
    itemCount,
  };
  if (kind === 'image' || kind === 'video') {
    entry.thumbUrl = `/api/files/thumb?path=${encodeURIComponent(vpath)}`;
  }
  return entry;
}

async function visibleChildCount(directory: string): Promise<number> {
  let count = 0;
  const handle = await fsp.opendir(directory);
  for await (const child of handle) if (!child.name.startsWith('.')) count++;
  return count;
}

export async function entryForAsync(username: string, userId: number, real: string,
  starredOverride?: boolean): Promise<FileEntry> {
  const st = await fsp.lstat(real);
  if (st.isSymbolicLink()) throw Object.assign(new Error('unsafe_symlink'), { status: 400 });
  const isFolder = st.isDirectory();
  if (!isFolder && !st.isFile()) throw Object.assign(new Error('unsupported_file_type'), { status: 400 });
  const vpath = toVirtual(username, real);
  const name = path.basename(real) || '/';
  const kind = kindOf(name, isFolder);
  const entry: FileEntry = {
    id: Buffer.from(vpath).toString('base64url'),
    name,
    path: vpath,
    parent: path.posix.dirname(vpath),
    kind,
    mime: (mime.lookup(name) || (isFolder ? 'inode/directory' : 'application/octet-stream')) as string,
    size: isFolder ? 0 : st.size,
    modifiedAt: st.mtime.toISOString(),
    createdAt: st.birthtime.toISOString(),
    isFolder,
    starred: starredOverride ?? star(userId, vpath),
    ...(isFolder ? { itemCount: await visibleChildCount(real) } : {}),
  };
  if (kind === 'image' || kind === 'video') entry.thumbUrl = `/api/files/thumb?path=${encodeURIComponent(vpath)}`;
  return entry;
}

export async function listAsync(username: string, userId: number, vpath: string,
  opts: { sort?: string; dir?: 'asc' | 'desc' } = {}): Promise<FileListing> {
  const real = await resolveAsync(username, vpath);
  const rootStat = await fsp.lstat(real);
  if (rootStat.isSymbolicLink()) throw Object.assign(new Error('unsafe_symlink'), { status: 400 });
  if (!rootStat.isDirectory()) throw Object.assign(new Error('not_a_folder'), { status: 400 });
  const dirents = (await fsp.readdir(real, { withFileTypes: true })).filter(entry => !entry.name.startsWith('.'));
  const starred = new Set((db.prepare('SELECT path FROM stars WHERE user_id=?').all(userId) as any[])
    .map(row => String(row.path)));
  const entries: FileEntry[] = [];
  // Bound filesystem concurrency: large folders stay responsive without
  // opening thousands of descriptors or monopolizing the event loop.
  for (let offset = 0; offset < dirents.length; offset += 64) {
    const batch = await Promise.all(dirents.slice(offset, offset + 64).map(async entry => {
      try {
        const full = path.join(real, entry.name);
        const itemPath = toVirtual(username, full);
        return await entryForAsync(username, userId, full, starred.has(itemPath));
      } catch { return null; }
    }));
    entries.push(...batch.filter((entry): entry is FileEntry => !!entry));
    if (offset + 64 < dirents.length) await new Promise<void>(resolve => setImmediate(resolve));
  }
  const sort = opts.sort || 'name';
  const direction = opts.dir === 'desc' ? -1 : 1;
  entries.sort((a, b) => {
    if (a.isFolder !== b.isFolder) return a.isFolder ? -1 : 1;
    let comparison = 0;
    if (sort === 'size') comparison = a.size - b.size;
    else if (sort === 'modified') comparison = a.modifiedAt.localeCompare(b.modifiedAt);
    else if (sort === 'kind') comparison = a.kind.localeCompare(b.kind);
    else comparison = a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
    return comparison * direction;
  });
  const clean = toVirtual(username, real);
  const parts = clean.split('/').filter(Boolean);
  const breadcrumbs = [{ name: 'Home', path: '/' }];
  let accumulated = '';
  for (const part of parts) {
    accumulated += '/' + part;
    breadcrumbs.push({ name: part, path: accumulated });
  }
  return { path: clean, parent: clean === '/' ? null : path.posix.dirname(clean), breadcrumbs, entries };
}

export function list(username: string, userId: number, vpath: string, opts: { sort?: string; dir?: 'asc' | 'desc' } = {}): FileListing {
  const real = resolve(username, vpath);
  const st = fs.statSync(real);
  if (!st.isDirectory()) throw Object.assign(new Error('not_a_folder'), { status: 400 });
  const names = fs.readdirSync(real).filter(n => !n.startsWith('.'));
  const starred = new Set((db.prepare('SELECT path FROM stars WHERE user_id=?').all(userId) as any[])
    .map(row => String(row.path)));
  let entries = names.map(n => {
    try {
      const full = path.join(real, n);
      const itemPath = toVirtual(username, full);
      return entryFor(username, userId, full, starred.has(itemPath));
    } catch { return null; }
  }).filter(Boolean) as FileEntry[];

  const sort = opts.sort || 'name';
  const dirMul = opts.dir === 'desc' ? -1 : 1;
  entries.sort((a, b) => {
    if (a.isFolder !== b.isFolder) return a.isFolder ? -1 : 1;
    let cmp = 0;
    if (sort === 'size') cmp = a.size - b.size;
    else if (sort === 'modified') cmp = a.modifiedAt.localeCompare(b.modifiedAt);
    else if (sort === 'kind') cmp = a.kind.localeCompare(b.kind);
    else cmp = a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
    return cmp * dirMul;
  });

  const clean = toVirtual(username, real);
  const parts = clean.split('/').filter(Boolean);
  const breadcrumbs = [{ name: 'Home', path: '/' }];
  let acc = '';
  for (const p of parts) { acc += '/' + p; breadcrumbs.push({ name: p, path: acc }); }

  return {
    path: clean,
    parent: clean === '/' ? null : path.posix.dirname(clean),
    breadcrumbs,
    entries,
  };
}

// Move that survives cross-device (EXDEV) boundaries — /data and /files are
// separate Unraid FUSE bind mounts, so plain rename() fails between them.
export async function safeMove(src: string, dest: string): Promise<void> {
  try {
    await fsp.rename(src, dest);
  } catch (e: any) {
    if (e && e.code === 'EXDEV') {
      await fsp.cp(src, dest, { recursive: true });
      await fsp.rm(src, { recursive: true, force: true });
    } else {
      throw e;
    }
  }
}

export async function trash(username: string, userId: number, vpath: string): Promise<void> {
  const trashRoot = path.join(config.dataDir, 'trash', String(userId));
  await fsp.mkdir(trashRoot, { recursive: true, mode: 0o700 });
  let real: string, stat: fs.Stats;
  try { ({ real, stat } = await statRealAsync(username, vpath)); }
  catch (e: any) { if (e?.code === 'ENOENT') return; throw e; }
  const id = 't_' + crypto.randomUUID();
  const trashedPath = path.join(trashRoot, id + '__' + path.basename(vpath));
  db.prepare(`INSERT INTO storage_operations (id,user_id,kind,path,stage_path,status)
    VALUES (?,?,?,?,?,'staged')`).run(id, userId, 'trash', vpath, trashedPath);
  try {
    await safeMove(real, trashedPath);
    db.transaction(() => {
      db.prepare('INSERT INTO trash (id,user_id,original_path,trashed_path,name,is_folder,size) VALUES (?,?,?,?,?,?,?)')
        .run(id, userId, vpath, trashedPath, path.basename(vpath), stat.isDirectory() ? 1 : 0, stat.isDirectory() ? 0 : stat.size);
      db.prepare("UPDATE storage_operations SET status='completed',stage_path=NULL,updated_at=datetime('now') WHERE id=?").run(id);
    })();
  } catch (error) {
    const [staged, original] = await Promise.all([
      fsp.access(trashedPath).then(() => true, () => false),
      fsp.access(real).then(() => true, () => false),
    ]);
    if (staged && !original) await safeMove(trashedPath, real).catch(() => {});
    db.prepare("UPDATE storage_operations SET status='failed',error=?,updated_at=datetime('now') WHERE id=?")
      .run(String((error as any)?.message || error).slice(0, 500), id);
    throw error;
  }
}

export async function mkdir(username: string, vpath: string): Promise<void> {
  await fsp.mkdir(await resolveAsync(username, vpath), { recursive: true });
}

export async function rename(username: string, from: string, to: string): Promise<void> {
  await fsp.rename(await resolveAsync(username, from), await resolveAsync(username, to));
}

export async function copy(username: string, from: string, to: string): Promise<void> {
  await fsp.cp(await resolveAsync(username, from), await resolveAsync(username, to), { recursive: true });
}

export async function move(username: string, from: string, toDir: string): Promise<void> {
  const dest = path.posix.join(toDir, path.posix.basename(from));
  await fsp.rename(await resolveAsync(username, from), await resolveAsync(username, dest));
}

export function statReal(username: string, vpath: string) {
  const real = resolve(username, vpath);
  return { real, stat: fs.statSync(real) };
}

export async function statRealAsync(username: string, vpath: string) {
  const real = await resolveAsync(username, vpath);
  return { real, stat: await fsp.stat(real) };
}

export async function computeUsage(username: string, userId: number): Promise<StorageUsage> {
  const root = userRoot(username);
  const byKind: Record<string, { count: number; bytes: number }> = {};
  let usedBytes = 0, fileCount = 0;
  const walk = (dir: string) => {
    let names: string[]; try { names = fs.readdirSync(dir); } catch { return; }
    for (const n of names) {
      if (n.startsWith('.')) continue;
      const full = path.join(dir, n);
      let st: fs.Stats; try { st = fs.statSync(full); } catch { continue; }
      if (st.isDirectory()) walk(full);
      else {
        usedBytes += st.size; fileCount++;
        const k = kindOf(n, false);
        byKind[k] = byKind[k] || { count: 0, bytes: 0 };
        byKind[k].count++; byKind[k].bytes += st.size;
      }
    }
  };
  walk(root);
  const u = db.prepare('SELECT storage_quota_bytes q FROM users WHERE id=?').get(userId) as any;
  return { usedBytes, quotaBytes: u?.q ?? null, fileCount, byKind };
}

export function decodeId(id: string): string {
  try { return Buffer.from(id, 'base64url').toString('utf8'); } catch { return '/'; }
}
