// Dashboard aggregator — one call that assembles the home screen.
import { Router } from 'express';
import { type AuthedRequest } from '../lib/auth.js';
import { db } from '../lib/db.js';
import fs from 'node:fs';
import path from 'node:path';
import * as storage from '../services/storage.js';
import * as jf from '../services/jellyfin.js';
import * as abs from '../services/audiobookshelf.js';
import * as progress from '../services/progress.js';
import { serviceStatuses, systemHealth } from '../services/monitoring.js';
import { backupStatuses } from './backups.js';
import type { Book, MediaItem } from '../lib/model.js';

const r = Router();

async function safe<T>(p: Promise<T>, fallback: T): Promise<T> {
  try { return await p; } catch { return fallback; }
}

function recentNativePhotos(userId: number, limit: number) {
  return db.prepare(`SELECT rel_path path, taken_at takenAt, width, height, size, camera, lat, lon
    FROM photo_index WHERE user_id=? ORDER BY taken_at DESC, rel_path ASC LIMIT ?`).all(userId, limit) as any[];
}

function overlayMedia(item: MediaItem, row: { positionTicks: number; durationTicks: number; played: boolean }): MediaItem {
  const runtimeTicks = item.runtimeTicks || row.durationTicks || undefined;
  const progressPct = row.durationTicks > 0 ? Math.round((row.positionTicks / row.durationTicks) * 100) : item.progressPct;
  return {
    ...item,
    runtimeTicks,
    runtimeMinutes: runtimeTicks ? Math.round(runtimeTicks / 600000000) : item.runtimeMinutes,
    positionTicks: row.positionTicks,
    progressPct,
    playedPct: row.played ? 100 : progressPct,
    played: row.played,
  };
}

async function buildContinueWatching(userId: number): Promise<MediaItem[]> {
  const rows = progress.resume(userId, 'video', 12);
  const items = await Promise.all(rows.map(async row => {
    try { return overlayMedia(await jf.itemDetail(row.itemId), row); }
    catch { return null; }
  }));
  return items.filter(Boolean) as MediaItem[];
}

function overlayBook(book: Book, row: { positionTicks: number; durationTicks: number; played: boolean }): Book {
  const durationTicks = row.durationTicks || Math.round((book.durationSec || 0) * 1e7);
  const pct = durationTicks > 0 ? Math.round((row.positionTicks / durationTicks) * 100) : (row.played ? 100 : 0);
  return { ...book, currentTimeSec: row.positionTicks / 1e7, progressPct: pct };
}

async function buildContinueListening(userId: number): Promise<Book[]> {
  const rows = progress.resume(userId, 'audio', 8);
  const books = await Promise.all(rows.map(async row => {
    try { return overlayBook(await abs.itemDetail(row.itemId), row); }
    catch { return null; }
  }));
  return (books.filter(Boolean) as Book[]).filter(b => (b.progressPct || 0) > 0 && (b.progressPct || 0) < 100);
}

r.get('/', async (req: AuthedRequest, res) => {
  const user = req.user!;
  const audiobooksEnabled = user.features?.audiobooks !== false;

  // recent files (shallow walk)
  const recentFiles = (() => {
    try {
      const root = storage.userRoot(user.username);
      const out: any[] = [];
      const walk = (dir: string, d: number) => {
        if (d > 4) return;
        let names: string[]; try { names = fs.readdirSync(dir); } catch { return; }
        for (const n of names) {
          if (n.startsWith('.')) continue;
          const full = path.join(dir, n);
          let st: fs.Stats; try { st = fs.statSync(full); } catch { continue; }
          if (st.isDirectory()) walk(full, d + 1);
          else out.push(storage.entryFor(user.username, user.id, full));
        }
      };
      walk(root, 0);
      out.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
      return out.slice(0, 8);
    } catch { return []; }
  })();

  const [storageUsage, recentPhotos, continueWatching, continueListening, services, health, backups] = await Promise.all([
    safe(storage.computeUsage(user.username, user.id), { usedBytes: 0, quotaBytes: null, fileCount: 0, byKind: {} }),
    safe(Promise.resolve(recentNativePhotos(user.id, 12)), [] as any[]),
    safe(buildContinueWatching(user.id), [] as any[]),
    audiobooksEnabled ? safe(buildContinueListening(user.id), [] as any[]) : Promise.resolve([]),
    safe(serviceStatuses(), [] as any[]),
    safe(systemHealth(), null as any),
    safe(backupStatuses(), [] as any[]),
  ]);

  const aiJobs = db.prepare('SELECT * FROM jobs WHERE user_id=? ORDER BY created_at DESC LIMIT 6').all(user.id) as any[];
  const genImages = db.prepare('SELECT * FROM generated_images WHERE user_id=? ORDER BY created_at DESC LIMIT 6').all(user.id) as any[];
  const devices = db.prepare('SELECT * FROM devices WHERE user_id=? ORDER BY last_seen DESC').all(user.id) as any[];
  const notifications = db.prepare('SELECT * FROM notifications WHERE user_id=? ORDER BY ts DESC LIMIT 10').all(user.id) as any[];

  res.json({
    storage: storageUsage,
    recentFiles,
    recentPhotos,
    continueWatching,
    continueListening,
    aiJobs: aiJobs.map(j => ({ id: j.id, type: j.type, status: j.status, prompt: j.prompt, progress: j.progress, createdAt: j.created_at, finishedAt: j.finished_at, resultUrls: j.result_urls ? JSON.parse(j.result_urls) : [] })),
    generatedImages: genImages.map(g => ({ id: g.id, prompt: g.prompt, url: `/api/images/file/${g.filename}`, thumbUrl: `/api/images/file/${g.filename}`, createdAt: g.created_at, width: g.width, height: g.height, workflow: g.workflow })),
    backups,
    health,
    services,
    devices: devices.map(d => ({ id: d.id, name: d.name, type: d.type, lastSeen: d.last_seen, backupStatus: d.backup_status, trusted: !!d.trusted })),
    phoneBackup: { lastBackup: recentPhotos[0]?.takenAt || null, pending: 0, status: recentPhotos.length ? 'completed' : 'idle' },
    notifications: notifications.map(n => ({ id: n.id, ts: n.ts, title: n.title, body: n.body, level: n.level, read: !!n.read, link: n.link })),
  });
});

export default r;
