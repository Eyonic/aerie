import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { db, notify } from '../lib/db.js';
import type { User } from '../lib/model.js';
import * as storage from './storage.js';
import { IMAGE_EXT } from './photolib.js';
import { markFileCatalogStale } from './file-catalog.js';

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
  const root = await storage.userRootAsync(user.username);
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
  const updated = db.prepare(`UPDATE jobs SET progress=? WHERE id=? AND status='running' AND EXISTS
    (SELECT 1 FROM users WHERE id=jobs.user_id AND disabled_at IS NULL)`)
    .run(Math.max(0, Math.min(0.99, p)), id);
  if (!updated.changes) throw new Error('job_cancelled');
}

function enqueue(userId: number, prompt: 'scan' | 'remove', run: (jobId: string) => Promise<any>) {
  const pending = db.prepare("SELECT COUNT(*) count FROM jobs WHERE user_id=? AND type='dedup' AND status IN ('queued','running')")
    .get(userId) as any;
  if (Number(pending?.count || 0) >= 2) throw Object.assign(new Error('too_many_active_dedup_jobs'), { status: 429 });
  const id = uid('job');
  db.prepare('INSERT INTO jobs (id,user_id,type,status,prompt,payload,progress) VALUES (?,?,?,?,?,?,0)')
    .run(id, userId, 'dedup', 'queued', prompt, JSON.stringify({ kind: prompt }));
  queue.push({ id, userId, run, done: result => {
    db.prepare(`UPDATE jobs SET status='done', progress=1, result_urls=?, finished_at=datetime('now')
      WHERE id=? AND status='running' AND EXISTS
        (SELECT 1 FROM users WHERE id=jobs.user_id AND disabled_at IS NULL)`).run(JSON.stringify(result), id);
  } });
  drain();
  return id;
}

async function drain() {
  if (active) return;
  const task = queue.shift();
  if (!task) return;
  active = true;
  const claimed = db.prepare(`UPDATE jobs SET status='running', progress=0 WHERE id=? AND status='queued' AND EXISTS
    (SELECT 1 FROM users WHERE id=jobs.user_id AND disabled_at IS NULL)`).run(task.id);
  if (!claimed.changes) { active = false; drain(); return; }
  try {
    task.done(await task.run(task.id));
  } catch (e: any) {
    const msg = String(e?.message || 'dedup job failed');
    const failed = db.prepare("UPDATE jobs SET status='error', error=?, finished_at=datetime('now') WHERE id=? AND status='running'")
      .run(msg, task.id);
    if (failed.changes) notify(task.userId, 'Duplicate cleanup failed', msg, 'error');
  } finally {
    active = false;
    drain();
  }
}

async function execute(user: User, kind: 'scan' | 'remove', jobId: string) {
  progress(jobId, 0);
  if (kind === 'scan') {
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
  }
  const r = await groupsFor(user);
    const total = r.removable;
    let removed = 0, bytesMovedToTrash = 0;
    for (const g of r.groups) {
      for (const rel of g.remove) {
        progress(jobId, total ? removed / total : 0);
        await storage.trash(user.username, user.id, rel);
        if (isImagePath(rel)) db.prepare('DELETE FROM photo_index WHERE user_id=? AND rel_path=?').run(user.id, rel);
        db.prepare(`INSERT OR REPLACE INTO dedup_removed (user_id,rel_path,size,hash,removed_at)
          VALUES (?,?,?,?,datetime('now'))`).run(user.id, rel, g.size, g.hash);
        removed++;
        bytesMovedToTrash += g.size;
        progress(jobId, total ? removed / total : 1);
      }
    }
    notify(user.id, 'Duplicates moved to trash',
      `Moved ${removed} duplicate files (${bytesMovedToTrash} bytes) to trash. Empty trash to reclaim the space.`, 'success');
    if (removed) markFileCatalogStale(user.id);
    return { removed, bytesMovedToTrash };
}

export function scan(user: User) {
  return enqueue(user.id, 'scan', jobId => execute(user, 'scan', jobId));
}

export function remove(user: User) {
  return enqueue(user.id, 'remove', jobId => execute(user, 'remove', jobId));
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

export function recoverDedupJobs() {
  const rows = db.prepare(`SELECT j.id,j.user_id userId,j.prompt,u.username FROM jobs j
    JOIN users u ON u.id=j.user_id WHERE j.type='dedup' AND j.status IN ('queued','running') AND u.disabled_at IS NULL
    ORDER BY j.created_at,j.rowid`).all() as any[];
  for (const row of rows) {
    const kind = row.prompt === 'remove' ? 'remove' : row.prompt === 'scan' ? 'scan' : null;
    if (!kind) {
      db.prepare("UPDATE jobs SET status='error',error='Interrupted job cannot be resumed.',finished_at=datetime('now') WHERE id=?").run(row.id);
      continue;
    }
    const user = { id: row.userId, username: row.username } as User;
    db.prepare("UPDATE jobs SET status='queued',progress=0,error=NULL,finished_at=NULL WHERE id=?").run(row.id);
    queue.push({ id: row.id, userId: row.userId, run: id => execute(user, kind, id), done: result => {
      db.prepare("UPDATE jobs SET status='done',progress=1,result_urls=?,finished_at=datetime('now') WHERE id=? AND status='running'")
        .run(JSON.stringify(result), row.id);
    } });
  }
  drain();
}

// Persisted integration/config overrides and every route module finish loading
// before recovery gets CPU time. This avoids a recovered job observing a
// half-initialized process during deployment.
setTimeout(recoverDedupJobs, 0).unref();
