import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { db, notify } from '../lib/db.js';
import type { User } from '../lib/model.js';
import * as storage from './storage.js';
import { IMAGE_EXT } from './photolib.js';

type WalkFile = { rel: string; size: number; mtimeMs: number };
type Group = { hash: string; size: number; keep: string; remove: string[] };
type JobTask = { id: string; userId: number; run: (jobId: string) => Promise<any>; done: (result: any) => void };

const VIDEO_EXT = new Set(['.mp4', '.mov', '.m4v', '.mkv', '.avi', '.webm', '.3gp', '.mts', '.m2ts', '.wmv', '.flv']);
const MAX_FILES = 200_000;
const queue: JobTask[] = [];
let active = false;

const uid = (p: string) => `${p}_${Date.now().toString(36)}${crypto.randomBytes(4).toString('hex')}`;
const isMediaName = (name: string) => IMAGE_EXT.has(path.extname(name).toLowerCase()) || VIDEO_EXT.has(path.extname(name).toLowerCase());
const isImagePath = (rel: string) => IMAGE_EXT.has(path.extname(rel).toLowerCase());

export async function walkFiles(root: string): Promise<WalkFile[]> {
  const out: WalkFile[] = [];
  const walk = async (dir: string) => {
    if (out.length >= MAX_FILES) return;
    let entries: fs.Dirent[];
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (out.length >= MAX_FILES) return;
      if (e.name.startsWith('.') || e.isSymbolicLink()) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        await walk(full);
      } else if (e.isFile() && isMediaName(e.name)) {
        try {
          const st = await fsp.stat(full);
          if (st.isFile()) out.push({ rel: path.relative(root, full).split(path.sep).join('/'), size: st.size, mtimeMs: st.mtimeMs });
        } catch { /* skip unreadable files */ }
      }
    }
  };
  for (const prefix of ['Photos', 'Sync']) await walk(path.join(root, prefix));
  return out;
}

export function hashFile(real: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    const s = fs.createReadStream(real);
    s.on('data', chunk => h.update(chunk));
    s.on('error', reject);
    s.on('end', () => resolve(h.digest('hex')));
  });
}

function pickKeep(items: WalkFile[]) {
  return [...items].sort((a, b) =>
    (a.mtimeMs - b.mtimeMs) || (a.rel.length - b.rel.length) || a.rel.localeCompare(b.rel)
  )[0];
}

export async function groupsFor(user: User, onProgress?: (p: number) => void) {
  const root = storage.userRoot(user.username);
  const files = await walkFiles(root);
  const bySize = new Map<number, WalkFile[]>();
  for (const f of files) {
    const arr = bySize.get(f.size) || [];
    arr.push(f);
    bySize.set(f.size, arr);
  }
  const candidates = [...bySize.values()].filter(v => v.length > 1).flat();
  const total = candidates.length;
  let done = 0;
  const byHash = new Map<string, WalkFile[]>();
  for (const f of candidates) {
    try {
      const mtime = Math.floor(f.mtimeMs);
      const cached = db.prepare('SELECT hash FROM file_hashes WHERE user_id=? AND rel_path=? AND size=? AND mtime=?')
        .get(user.id, f.rel, f.size, mtime) as any;
      const hash = cached?.hash || await hashFile(path.join(root, f.rel));
      if (!cached) {
        db.prepare(`INSERT INTO file_hashes (user_id,rel_path,size,mtime,hash) VALUES (?,?,?,?,?)
          ON CONFLICT(user_id,rel_path) DO UPDATE SET size=excluded.size,mtime=excluded.mtime,hash=excluded.hash`)
          .run(user.id, f.rel, f.size, mtime, hash);
      }
      const arr = byHash.get(hash) || [];
      arr.push(f);
      byHash.set(hash, arr);
    } catch { /* one bad file should not abort the scan */ }
    done++;
    if (onProgress) onProgress(total ? done / total : 1);
  }
  const groups: Group[] = [];
  for (const [hash, items] of byHash) {
    if (items.length < 2) continue;
    const keep = pickKeep(items);
    groups.push({ hash, size: keep.size, keep: keep.rel, remove: items.filter(f => f.rel !== keep.rel).map(f => f.rel) });
  }
  groups.sort((a, b) => a.keep.localeCompare(b.keep));
  const bytesRemovable = groups.reduce((n, g) => n + g.size * g.remove.length, 0);
  const removable = groups.reduce((n, g) => n + g.remove.length, 0);
  return { groups, bytesRemovable, sets: groups.length, removable };
}

function progress(id: string, p: number) {
  db.prepare('UPDATE jobs SET progress=? WHERE id=?').run(Math.max(0, Math.min(0.99, p)), id);
}

function enqueue(userId: number, prompt: 'scan' | 'remove', run: (jobId: string) => Promise<any>) {
  const id = uid('job');
  db.prepare('INSERT INTO jobs (id,user_id,type,status,prompt,progress) VALUES (?,?,?,?,?,0)').run(id, userId, 'dedup', 'queued', prompt);
  queue.push({ id, userId, run, done: result => {
    db.prepare("UPDATE jobs SET status='done', progress=1, result_urls=?, finished_at=datetime('now') WHERE id=?").run(JSON.stringify(result), id);
  } });
  drain();
  return id;
}

async function drain() {
  if (active) return;
  const task = queue.shift();
  if (!task) return;
  active = true;
  db.prepare("UPDATE jobs SET status='running', progress=0 WHERE id=?").run(task.id);
  try {
    task.done(await task.run(task.id));
  } catch (e: any) {
    const msg = String(e?.message || 'dedup job failed');
    db.prepare("UPDATE jobs SET status='error', error=?, finished_at=datetime('now') WHERE id=?").run(msg, task.id);
    notify(task.userId, 'Duplicate cleanup failed', msg, 'error');
  } finally {
    active = false;
    drain();
  }
}

export function scan(user: User) {
  return enqueue(user.id, 'scan', async jobId => {
    const r = await groupsFor(user, p => progress(jobId, p));
    notify(user.id, 'Duplicate scan complete', `Found ${r.sets} duplicate sets.`, 'success');
    return {
      sets: r.sets,
      removable: r.removable,
      bytesRemovable: r.bytesRemovable,
      samples: r.groups.slice(0, 8).map(g => ({
        keepThumb: isImagePath(g.keep) ? `/api/photos/native/thumb?path=${encodeURIComponent(g.keep)}` : null,
        count: g.remove.length + 1,
        size: g.size,
      })),
    };
  });
}

export function remove(user: User) {
  return enqueue(user.id, 'remove', async jobId => {
    const r = await groupsFor(user);
    const total = r.removable;
    let removed = 0, bytesFreed = 0;
    for (const g of r.groups) {
      for (const rel of g.remove) {
        await storage.trash(user.username, user.id, rel);
        if (isImagePath(rel)) db.prepare('DELETE FROM photo_index WHERE user_id=? AND rel_path=?').run(user.id, rel);
        db.prepare(`INSERT OR REPLACE INTO dedup_removed (user_id,rel_path,size,hash,removed_at)
          VALUES (?,?,?,?,datetime('now'))`).run(user.id, rel, g.size, g.hash);
        removed++;
        bytesFreed += g.size;
        progress(jobId, total ? removed / total : 1);
      }
    }
    notify(user.id, 'Duplicates removed', `Removed ${removed} duplicate files, freed ${bytesFreed} bytes.`, 'success');
    return { removed, bytesFreed };
  });
}

export function jobStatus(user: User, id: string) {
  const row = db.prepare('SELECT * FROM jobs WHERE id=? AND user_id=? AND type=?').get(id, user.id, 'dedup') as any;
  if (!row) return null;
  let result: any = null;
  try { result = row.result_urls ? JSON.parse(row.result_urls) : null; } catch { result = null; }
  return { status: row.status, progress: Number(row.progress || 0), error: row.error || undefined, result };
}

export function last(user: User) {
  const row = db.prepare(`SELECT * FROM jobs WHERE user_id=? AND type=? ORDER BY created_at DESC, rowid DESC LIMIT 1`).get(user.id, 'dedup') as any;
  if (!row) return null;
  const st = jobStatus(user, row.id);
  return st ? { type: row.prompt, status: st.status, progress: st.progress, error: st.error, result: st.result, jobId: row.id } : null;
}

export function isTombstoned(userId: number, vpath: string, size: number): boolean {
  const rel = String(vpath || '').replace(/^\/+/, '');
  const row = db.prepare('SELECT size FROM dedup_removed WHERE user_id=? AND rel_path=?').get(userId, rel) as any;
  return !!row && Number(row.size) === Number(size);
}

export function clearTombstone(userId: number, vpath: string) {
  const rel = String(vpath || '').replace(/^\/+/, '');
  db.prepare('DELETE FROM dedup_removed WHERE user_id=? AND rel_path=?').run(userId, rel);
}
