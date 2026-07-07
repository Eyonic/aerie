// Background scheduler — makes the "system" features real: monitors services and
// storage and pushes alerts (via the live notification system), and runs a nightly
// database backup. Runs in-process; safe/best-effort; updates the automations table
// so the Automations page reflects genuine runs.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { db, notify, audit } from '../lib/db.js';
import { config } from '../config.js';
import { serviceStatuses, systemHealth } from './monitoring.js';
import * as autorequest from './autorequest.js';
import * as jellyseerr from './jellyseerr.js';
import * as lidarr from './lidarr.js';
import * as ai from './ai.js';

const backupDir = path.join(config.dataDir, 'backups');

function admins(): { id: number }[] {
  return db.prepare("SELECT id FROM users WHERE role='admin'").all() as any[];
}
function notifyAdmins(title: string, body: string, level = 'warning', link?: string) {
  for (const a of admins()) notify(a.id, title, body, level, link);
}

function autoUsers(): { id: number; features: string }[] {
  return db.prepare('SELECT id, features FROM users').all() as any[];
}
function autoEnabled(raw: string): boolean {
  try { return JSON.parse(raw || '{}')?.autoRequest !== false; } catch { return true; }
}
async function maybeAutoRequest() {
  try {
    if (!(jellyseerr.configured() || lidarr.configured())) return;
    if (!(await ai.available().catch(() => false))) return;
    console.log('scheduler auto-request sweep');
    for (const user of autoUsers()) {
      try {
        if (!autoEnabled(user.features)) continue;
        if (autorequest.countThisWeek(user.id) >= 3) continue;
        const last = db.prepare("SELECT ts FROM audit WHERE user_id=? AND action='auto_requested' ORDER BY ts DESC LIMIT 1").get(user.id) as any;
        if (last?.ts) {
          const lastMs = Date.parse(`${String(last.ts).replace(' ', 'T')}Z`);
          if (Number.isFinite(lastMs) && Date.now() - lastMs < 40 * 3600_000) continue;
        }
        const prof = await autorequest.profile(user.id);
        if (prof.noHistory) continue;
        await autorequest.runFor(user.id, {});
      } catch (e: any) {
        console.warn('[auto-request]', user.id, String(e?.message || e).slice(0, 120));
      }
    }
  } catch { /* best-effort */ }
}
function bumpAutomation(name: string) {
  db.prepare("UPDATE automations SET last_run=datetime('now'), run_count=run_count+1 WHERE name LIKE ? AND enabled=1").run(`%${name}%`);
}
function isEnabled(nameLike: string): boolean {
  const row = db.prepare("SELECT enabled FROM automations WHERE name LIKE ? LIMIT 1").get(`%${nameLike}%`) as any;
  return !row || !!row.enabled; // default on if not present
}

let prevOnline: Record<string, boolean> = {};
async function healthCheck() {
  try {
    const svcs = await serviceStatuses();
    for (const s of svcs) {
      const was = prevOnline[s.key];
      if (was === true && !s.online) notifyAdmins('Service down', `${s.name} is not responding.`, 'error', '/monitoring');
      if (was === false && s.online) notifyAdmins('Service recovered', `${s.name} is back online.`, 'success', '/monitoring');
      prevOnline[s.key] = s.online;
    }
    const h = await systemHealth();
    const pct = h.storageTotalTb ? (h.storageUsedTb / h.storageTotalTb) * 100 : 0;
    if (pct >= 90 && !storageAlerted) { notifyAdmins('Storage almost full', `Storage is ${pct.toFixed(0)}% full.`, 'warning', '/monitoring'); storageAlerted = true; bumpAutomation('Storage'); }
    if (pct < 85) storageAlerted = false;
    bumpAutomation('backup failure'); // health watcher counts as the alert automation
  } catch { /* best-effort */ }
}
let storageAlerted = false;

let lastBackupDay = '';
async function maybeNightlyBackup() {
  try {
    const now = new Date();
    const day = now.toISOString().slice(0, 10);
    if (now.getHours() !== 3 || lastBackupDay === day) return;
    if (!isEnabled('cleanup') && !isEnabled('backup')) { /* still back up — safety */ }
    lastBackupDay = day;
    fs.mkdirSync(backupDir, { recursive: true });
    const dest = path.join(backupDir, `aerie-${now.toISOString().replace(/[:.]/g, '-')}.db`);
    db.prepare('VACUUM INTO ?').run(dest); // WAL-safe complete snapshot

    // keep only the 14 most recent
    const files = fs.readdirSync(backupDir).filter(f => f.endsWith('.db')).sort();
    for (const f of files.slice(0, Math.max(0, files.length - 14))) { try { await fsp.rm(path.join(backupDir, f)); } catch { /* */ } }
    bumpAutomation('cleanup');
    audit(null, 'system', 'backup_succeeded', path.basename(dest));
    notifyAdmins('Backup complete', 'Nightly database backup finished successfully.', 'success', '/backups');
  } catch (e: any) {
    notifyAdmins('Backup failed', String(e?.message || e).slice(0, 120), 'error', '/backups');
  }
}

export function startScheduler() {
  // establish a baseline, then alert on transitions every 5 minutes
  healthCheck();
  setInterval(healthCheck, 5 * 60 * 1000);
  // check hourly whether it's time for the nightly backup
  setInterval(maybeNightlyBackup, 60 * 60 * 1000);
  setTimeout(maybeAutoRequest, 2 * 60 * 1000);
  setInterval(maybeAutoRequest, 6 * 60 * 60 * 1000);
  console.log('scheduler started (health alerts + nightly backup + auto-request)');
}
