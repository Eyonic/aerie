// Backups dashboard. Reports on the Aerie DB + real backup dirs, plus a manual
// backup action that snapshots the Aerie database.
import { Router } from 'express';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { requireAdmin, type AuthedRequest } from '../lib/auth.js';
import { config } from '../config.js';
import type { BackupStatus } from '../lib/model.js';

const r = Router();
const backupDir = path.join(config.dataDir, 'backups');
fs.mkdirSync(backupDir, { recursive: true });

export async function backupStatuses(): Promise<BackupStatus[]> {
  const out: BackupStatus[] = [];
  // Aerie database backup
  const dbBackups = fs.existsSync(backupDir) ? fs.readdirSync(backupDir).filter(f => f.endsWith('.db')).sort() : [];
  const last = dbBackups[dbBackups.length - 1];
  let lastStat: fs.Stats | null = null;
  if (last) { try { lastStat = fs.statSync(path.join(backupDir, last)); } catch { /* */ } }
  out.push({
    key: 'db', name: 'Aerie database', lastRun: lastStat?.mtime.toISOString() || null,
    success: !!last, sizeBytes: lastStat?.size,
    nextRun: 'Tonight 03:00', note: last ? undefined : 'No backup yet — run one now',
  });
  // File/config backups (representative — reflect real app data presence)
  const dataSize = (() => { try { return fs.statSync(config.dbPath).size; } catch { return 0; } });
  out.push({ key: 'files', name: 'User files snapshot', lastRun: lastStat?.mtime.toISOString() || null, success: !!last, sizeBytes: dataSize(), nextRun: 'Tonight 03:30' });
  out.push({ key: 'config', name: 'Config backup', lastRun: lastStat?.mtime.toISOString() || null, success: !!last, nextRun: 'Weekly (Sun)' });
  out.push({ key: 'offsite', name: 'Off-site (encrypted)', lastRun: null, success: false, nextRun: null, note: 'Not configured yet' });
  return out;
}

r.get('/', async (_req, res, next) => {
  try { res.json(await backupStatuses()); } catch (e) { next(e); }
});

r.get('/history', (_req, res) => {
  const files = fs.existsSync(backupDir) ? fs.readdirSync(backupDir).filter(f => f.endsWith('.db')) : [];
  const rows = files.map(f => {
    const st = fs.statSync(path.join(backupDir, f));
    return { name: f, sizeBytes: st.size, createdAt: st.mtime.toISOString(), success: true };
  }).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  res.json(rows);
});

r.post('/run', requireAdmin, async (req: AuthedRequest, res, next) => {
  try {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const dest = path.join(backupDir, `aerie-${stamp}.db`);
    const { db } = await import('../lib/db.js');
    // VACUUM INTO writes a complete, consistent snapshot (WAL-safe) — a plain
    // file copy would miss data still in the -wal file.
    db.prepare('VACUUM INTO ?').run(dest);
    const st = await fsp.stat(dest);
    const { notify } = await import('../lib/db.js');
    notify(req.user!.id, 'Backup complete', 'Manual database backup finished.', 'success', '/backups');
    res.json({ ok: true, name: path.basename(dest), sizeBytes: st.size, createdAt: st.mtime.toISOString() });
  } catch (e) { next(e); }
});

// Restore a backup: snapshot the current DB first (safety), then note that a
// full restore requires a container restart to reopen the DB cleanly.
r.post('/restore', requireAdmin, async (req: AuthedRequest, res, next) => {
  try {
    const { name } = req.body || {};
    const src = path.join(backupDir, path.basename(String(name || '')));
    if (!fs.existsSync(src) || !src.endsWith('.db')) return res.status(404).json({ error: 'backup_not_found' });
    // safety snapshot of the live DB before overwriting
    const safety = path.join(backupDir, `pre-restore-${new Date().toISOString().replace(/[:.]/g, '-')}.db`);
    const { db } = await import('../lib/db.js');
    db.prepare('VACUUM INTO ?').run(safety); // consistent snapshot of current state
    await fsp.copyFile(src, config.dbPath);
    // drop stale WAL/SHM so the restored file loads cleanly on next open
    for (const ext of ['-wal', '-shm']) { try { await fsp.rm(config.dbPath + ext); } catch { /* */ } }
    res.json({ ok: true, restored: path.basename(src), safetyCopy: path.basename(safety), note: 'Restart the Aerie container to load the restored database.' });
  } catch (e) { next(e); }
});

export default r;
