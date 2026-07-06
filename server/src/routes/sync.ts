import { Router } from 'express';
import multer from 'multer';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import mime from 'mime-types';
import { type AuthedRequest } from '../lib/auth.js';
import { config } from '../config.js';
import * as storage from '../services/storage.js';

const r = Router();
const uploadTmp = path.join(config.filesRoot, '.sync-uploads-tmp');
fs.mkdirSync(uploadTmp, { recursive: true });
const upload = multer({ dest: uploadTmp, limits: { fileSize: 20 * 1024 * 1024 * 1024 } });
const TOLERANCE_MS = 2000;
const basesCache = new Map<number, { ts: number; data: any }>();

function u(req: AuthedRequest) { return req.user!; }

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
  if (!s.startsWith('Sync/')) throw Object.assign(new Error('invalid_base'), { status: 400 });
  return s;
}

function cleanRel(v: string): string {
  return cleanPart(v, 'rel');
}

function realFor(username: string, base: string, rel = '') {
  return storage.resolve(username, '/' + path.posix.join(base, rel || ''));
}

function listFiles(username: string, base: string) {
  const root = realFor(username, base);
  const files: { rel: string; size: number; mtimeMs: number }[] = [];
  const walk = (dir: string, prefix: string) => {
    let names: string[];
    try { names = fs.readdirSync(dir); } catch { return; }
    for (const n of names) {
      if (n.startsWith('.')) continue;
      const full = path.join(dir, n);
      let st: fs.Stats;
      try { st = fs.statSync(full); } catch { continue; }
      const rel = prefix ? path.posix.join(prefix, n) : n;
      if (st.isDirectory()) walk(full, rel);
      else if (st.isFile()) files.push({ rel, size: st.size, mtimeMs: st.mtimeMs });
    }
  };
  walk(root, '');
  return files;
}

r.post('/check', (req: AuthedRequest, res, next) => {
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
      const real = realFor(u(req).username, base, rel);
      let st: fs.Stats | null = null;
      try { st = fs.statSync(real); } catch { /* missing */ }
      if (!st || !st.isFile()) { needed.push(rel); continue; }
      if (mtimeMs > st.mtimeMs + TOLERANCE_MS) needed.push(rel);
      else if (st.mtimeMs > mtimeMs + TOLERANCE_MS && st.size !== size) conflicts.push(rel);
    }
    res.json({ needed, conflicts });
  } catch (e) { next(e); }
});

r.post('/upload', upload.single('file'), async (req: AuthedRequest, res, next) => {
  try {
    const f = (req as any).file;
    if (!f) return res.status(400).json({ error: 'missing_file' });
    const base = cleanBase(req.body?.base || '');
    const rel = cleanRel(req.body?.rel || '');
    const mtimeMs = Number(req.body?.mtimeMs);
    const dest = realFor(u(req).username, base, rel);
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    await storage.safeMove(f.path, dest);
    if (Number.isFinite(mtimeMs)) {
      const t = new Date(mtimeMs);
      await fsp.utimes(dest, t, t).catch(() => {});
    }
    basesCache.delete(u(req).id);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

r.get('/list', (req: AuthedRequest, res, next) => {
  try {
    const base = cleanBase(String(req.query.base || ''));
    res.json({ files: listFiles(u(req).username, base) });
  } catch (e) { next(e); }
});

r.get('/bases', (req: AuthedRequest, res, next) => {
  try {
    const cached = basesCache.get(u(req).id);
    if (cached && Date.now() - cached.ts < 30_000) return res.json(cached.data);
    const syncRoot = realFor(u(req).username, 'Sync');
    const bases: any[] = [];
    let names: string[] = [];
    try { names = fs.readdirSync(syncRoot); } catch { names = []; }
    for (const n of names) {
      if (n.startsWith('.')) continue;
      const full = path.join(syncRoot, n);
      let st: fs.Stats;
      try { st = fs.statSync(full); } catch { continue; }
      if (!st.isDirectory()) continue;
      const files = listFiles(u(req).username, `Sync/${n}`);
      bases.push({
        base: `Sync/${n}`,
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

r.get('/file', (req: AuthedRequest, res, next) => {
  try {
    const base = cleanBase(String(req.query.base || ''));
    const rel = cleanRel(String(req.query.rel || ''));
    const real = realFor(u(req).username, base, rel);
    const st = fs.statSync(real);
    if (!st.isFile()) return res.status(400).json({ error: 'not_file' });
    res.setHeader('Content-Type', (mime.lookup(path.basename(real)) || 'application/octet-stream') as string);
    res.setHeader('Content-Length', String(st.size));
    res.setHeader('X-Mtime-Ms', String(st.mtimeMs));
    fs.createReadStream(real).pipe(res);
  } catch (e) { next(e); }
});

export default r;
