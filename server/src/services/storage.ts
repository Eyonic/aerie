// Filesystem-backed file storage, sandboxed per user under FILES_ROOT/<username>.
// All public functions take a user and a POSIX "virtual" path (rooted at /).
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import mime from 'mime-types';
import { config } from '../config.js';
import type { FileEntry, FileKind, FileListing, StorageUsage } from '../lib/model.js';
import { db } from '../lib/db.js';

export function userRoot(username: string): string {
  const root = path.join(config.filesRoot, username);
  fs.mkdirSync(root, { recursive: true });
  return root;
}

// Resolve a virtual path to a real path, refusing traversal outside the root.
export function resolve(username: string, vpath: string): string {
  const root = userRoot(username);
  const clean = path.posix.normalize('/' + (vpath || '/')).replace(/^(\.\.[/\\])+/, '/');
  const real = path.join(root, clean);
  if (real !== root && !real.startsWith(root + path.sep)) {
    throw Object.assign(new Error('path_escape'), { status: 400 });
  }
  return real;
}

export function toVirtual(username: string, real: string): string {
  const root = userRoot(username);
  const v = '/' + path.relative(root, real).split(path.sep).join('/');
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

export function entryFor(username: string, userId: number, real: string): FileEntry {
  const st = fs.statSync(real);
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
    starred: star(userId, vpath),
    itemCount,
  };
  if (kind === 'image' || kind === 'video') {
    entry.thumbUrl = `/api/files/thumb?path=${encodeURIComponent(vpath)}`;
  }
  return entry;
}

export function list(username: string, userId: number, vpath: string, opts: { sort?: string; dir?: 'asc' | 'desc' } = {}): FileListing {
  const real = resolve(username, vpath);
  const st = fs.statSync(real);
  if (!st.isDirectory()) throw Object.assign(new Error('not_a_folder'), { status: 400 });
  const names = fs.readdirSync(real).filter(n => !n.startsWith('.'));
  let entries = names.map(n => {
    try { return entryFor(username, userId, path.join(real, n)); } catch { return null; }
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

export async function mkdir(username: string, vpath: string): Promise<void> {
  await fsp.mkdir(resolve(username, vpath), { recursive: true });
}

export async function rename(username: string, from: string, to: string): Promise<void> {
  await fsp.rename(resolve(username, from), resolve(username, to));
}

export async function copy(username: string, from: string, to: string): Promise<void> {
  await fsp.cp(resolve(username, from), resolve(username, to), { recursive: true });
}

export async function move(username: string, from: string, toDir: string): Promise<void> {
  const dest = path.posix.join(toDir, path.posix.basename(from));
  await fsp.rename(resolve(username, from), resolve(username, dest));
}

export function statReal(username: string, vpath: string) {
  const real = resolve(username, vpath);
  return { real, stat: fs.statSync(real) };
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
