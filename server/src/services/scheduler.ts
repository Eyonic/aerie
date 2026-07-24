// Background scheduler — makes the "system" features real: monitors services and
// storage and pushes alerts (via the live notification system), and runs a nightly
// verified recovery-bundle backup. Runs in-process; safe/best-effort; updates the automations table
// so the Automations page reflects genuine runs.
import crypto from 'node:crypto';
import { db, notify, audit, getSetting } from '../lib/db.js';
import { serviceStatuses, systemHealth } from './monitoring.js';
import * as autorequest from './autorequest.js';
import * as jellyseerr from './jellyseerr.js';
import * as lidarr from './lidarr.js';
import * as ai from './ai.js';
import { runDueSnapshots } from './time-machine.js';
import {
  abortActiveBackup,
  BACKUP_INTERRUPTED_BY_SHUTDOWN,
  backupPaths,
  createBackup,
} from './backup.js';
import { sqliteBackupCallbacks } from './sqlite-backup.js';
import { automationEnabled, recordAutomationRun } from './automations.js';
import { createDurableScheduleStore } from '../lib/durable-schedule.js';
import {
  backupScheduleHour,
  latestNightlyBackup,
  localScheduleTime,
  nextNightlyBackup,
  serverTimeZone,
} from '../lib/backup-schedule.js';

function admins(): { id: number }[] {
  return db.prepare("SELECT id FROM users WHERE role='admin' AND disabled_at IS NULL").all() as any[];
}
function notifyAdmins(title: string, body: string, level = 'warning', link?: string) {
  for (const a of admins()) notify(a.id, title, body, level, link);
}
function alertEvent(service: string, title: string, body: string, level = 'warning') {
  db.prepare('INSERT INTO alert_events (id,service,level,title,body) VALUES (?,?,?,?,?)')
    .run(crypto.randomUUID(), service, level, title, body);
  notifyAdmins(title, body, level, '/monitoring');
}

function autoUsers(): { id: number; features: string }[] {
  return db.prepare('SELECT id, features FROM users WHERE disabled_at IS NULL').all() as any[];
}
function autoEnabled(raw: string): boolean {
  try { return JSON.parse(raw || '{}')?.autoRequest !== false; } catch { return true; }
}
async function maybeAutoRequest() {
  if (!automationEnabled('auto-request-sweep')) return;
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
    recordAutomationRun('auto-request-sweep');
  } catch { /* best-effort */ }
}
const failureStreak: Record<string, number> = {};
const serviceAlerted: Record<string, boolean> = {};
const resourceAlerted: Record<string, boolean> = {};
async function healthCheck() {
  if (!automationEnabled('health-alerts')) return;
  try {
    if (getSetting('service_alerts', 'true') !== 'true') return;
    const svcs = await serviceStatuses();
    for (const s of svcs) {
      failureStreak[s.key] = s.online ? 0 : (failureStreak[s.key] || 0) + 1;
      if (!s.online && failureStreak[s.key] === 2 && !serviceAlerted[s.key]) { alertEvent(s.key, 'Service down', `${s.name} has failed two consecutive checks.`, 'error'); serviceAlerted[s.key] = true; }
      if (s.online && serviceAlerted[s.key]) { alertEvent(s.key, 'Service recovered', `${s.name} is back online.`, 'success'); serviceAlerted[s.key] = false; }
    }
    const h = await systemHealth();
    const pct = h.storageTotalTb ? (h.storageUsedTb / h.storageTotalTb) * 100 : 0;
    const storageThreshold = Number(getSetting('storage_alert_pct', '90'));
    if (pct >= storageThreshold && !storageAlerted) { alertEvent('storage', 'Storage almost full', `Storage is ${pct.toFixed(0)}% full.`, 'warning'); storageAlerted = true; }
    if (pct < storageThreshold - 5) storageAlerted = false;
    const memPct = h.memTotalGb ? h.memUsedGb / h.memTotalGb * 100 : 0;
    for (const [key, value, threshold] of [
      ['cpu', h.cpuPct, Number(getSetting('cpu_alert_pct', '95'))],
      ['memory', memPct, Number(getSetting('memory_alert_pct', '95'))],
    ] as const) {
      if (value >= threshold && !resourceAlerted[key]) { alertEvent(key, `${key === 'cpu' ? 'CPU' : 'Memory'} pressure`, `${key === 'cpu' ? 'CPU' : 'Memory'} usage reached ${value.toFixed(0)}%.`); resourceAlerted[key] = true; }
      if (value < threshold - 10) resourceAlerted[key] = false;
    }
    recordAutomationRun('health-alerts');
  } catch { /* best-effort */ }
}
let storageAlerted = false;

const NIGHTLY_BACKUP_TASK = 'nightly-recovery-bundle';
const BACKUP_RETRY_MS = 15 * 60_000;
const BACKUP_LEASE_MS = 30 * 60_000;
const BACKUP_HEARTBEAT_MS = 60_000;
const BACKUP_STARTUP_GRACE_MS = 2 * 60_000;
const DISABLED_TASK_RECHECK_MS = 15 * 60_000;
const schedulerOwner = `${process.pid}:${crypto.randomUUID()}`;
const scheduleStore = createDurableScheduleStore(db);

const schedulerTimers = new Set<NodeJS.Timeout>();
const activeTasks = new Set<Promise<unknown>>();
let schedulerStarted = false;
let schedulerStopping = false;
let nightlyBackupTimer: NodeJS.Timeout | undefined;

function scheduleKey(): string {
  return `${serverTimeZone()}@${localScheduleTime()}`;
}

function ensureNightlyState(now: Date) {
  return scheduleStore.ensure(
    NIGHTLY_BACKUP_TASK,
    scheduleKey(),
    latestNightlyBackup(now).getTime(),
    now.getTime(),
    nextNightlyBackup(now).getTime(),
  );
}

function reportBackupFailure(error: unknown) {
  const detail = String((error as any)?.message || error).slice(0, 120);
  try { audit(null, 'system', 'backup_failed', undefined, undefined, { error: detail }); } catch { /* non-fatal */ }
  try { notifyAdmins('Backup failed', detail, 'error', '/backups'); } catch { /* non-fatal */ }
}

async function maybeNightlyBackup(now = new Date()) {
  if (!automationEnabled(NIGHTLY_BACKUP_TASK)) return false;

  let claimed = false;
  let heartbeat: NodeJS.Timeout | undefined;
  try {
    ensureNightlyState(now);
    claimed = !!scheduleStore.claim(
      NIGHTLY_BACKUP_TASK, schedulerOwner, now.getTime(), BACKUP_LEASE_MS,
    );
    if (!claimed) return false;

    // Keep a long-running bundle owned by this process. If the process dies,
    // renewal stops and another instance can safely catch up after the lease.
    heartbeat = setInterval(() => {
      try {
        if (!scheduleStore.renew(
          NIGHTLY_BACKUP_TASK, schedulerOwner, Date.now(), BACKUP_LEASE_MS,
        ) && heartbeat) {
          clearInterval(heartbeat);
          heartbeat = undefined;
        }
      } catch (error) {
        console.warn('[scheduler backup lease]', error);
      }
    }, BACKUP_HEARTBEAT_MS);
    heartbeat.unref?.();

    const paths = backupPaths();
    const result = await createBackup({ paths, ...sqliteBackupCallbacks(paths.dbPath) });
    const completedAt = Date.now();
    const committed = scheduleStore.complete(
      NIGHTLY_BACKUP_TASK,
      schedulerOwner,
      completedAt,
      nextNightlyBackup(new Date(completedAt)).getTime(),
    );
    if (!committed) throw new Error('backup_schedule_lease_lost');

    // The recovery artifact and durable cursor are authoritative. Auxiliary
    // history/notifications must never turn a completed backup into a retry.
    try { recordAutomationRun(NIGHTLY_BACKUP_TASK); } catch (error) { console.warn('[scheduler automation history]', error); }
    try { audit(null, 'system', 'backup_succeeded', result.name, undefined, { sha256: result.sha256 }); } catch { /* non-fatal */ }
    try { notifyAdmins('Backup complete', 'Nightly recovery bundle was created and verified.', 'success', '/backups'); } catch { /* non-fatal */ }
    return true;
  } catch (error) {
    if (claimed) {
      const failedAt = Date.now();
      const regularDue = nextNightlyBackup(new Date(failedAt)).getTime();
      const interruptedByShutdown = String((error as any)?.message || error) === BACKUP_INTERRUPTED_BY_SHUTDOWN;
      const retryAt = interruptedByShutdown
        ? failedAt
        : Math.min(failedAt + BACKUP_RETRY_MS, regularDue);
      try {
        scheduleStore.fail(
          NIGHTLY_BACKUP_TASK,
          schedulerOwner,
          failedAt,
          retryAt,
          interruptedByShutdown
            ? BACKUP_INTERRUPTED_BY_SHUTDOWN
            : String((error as any)?.message || error),
        );
      } catch (stateError) {
        console.warn('[scheduler backup state]', stateError);
      }
      if (interruptedByShutdown) {
        console.log('[scheduler backup] interrupted by graceful shutdown; retry remains due');
      } else {
        reportBackupFailure(error);
      }
    } else {
      // A database/schema error here usually prevents notifications too; keep
      // the log useful without creating a noisy notification loop.
      console.warn('[scheduler backup claim]', error);
    }
    return false;
  } finally {
    if (heartbeat) clearInterval(heartbeat);
  }
}

function runTracked(work: () => unknown | Promise<unknown>): Promise<unknown> | undefined {
  if (schedulerStopping) return undefined;
  const task = Promise.resolve().then(work);
  activeTasks.add(task);
  task.then(
    () => activeTasks.delete(task),
    error => {
      activeTasks.delete(task);
      console.warn('[scheduler task]', error);
    },
  );
  return task;
}

function trackInterval(work: () => unknown | Promise<unknown>, intervalMs: number) {
  const timer = setInterval(() => { void runTracked(work); }, intervalMs);
  schedulerTimers.add(timer);
  timer.unref?.();
  return timer;
}

function trackTimeout(work: () => unknown | Promise<unknown>, delayMs: number) {
  const timer = setTimeout(() => {
    schedulerTimers.delete(timer);
    void runTracked(work);
  }, delayMs);
  schedulerTimers.add(timer);
  timer.unref?.();
  return timer;
}

function clearTrackedTimer(timer: NodeJS.Timeout | undefined) {
  if (!timer) return;
  clearTimeout(timer);
  clearInterval(timer);
  schedulerTimers.delete(timer);
}

function nightlyDelay(now: Date): number {
  if (!automationEnabled(NIGHTLY_BACKUP_TASK)) {
    return Math.min(
      DISABLED_TASK_RECHECK_MS,
      Math.max(1_000, nextNightlyBackup(now).getTime() - now.getTime()),
    );
  }
  try {
    const state = scheduleStore.get(NIGHTLY_BACKUP_TASK);
    if (!state) return 1_000;
    if (state.dueAtMs > now.getTime()) return Math.max(1_000, state.dueAtMs - now.getTime());
    if (state.leaseUntilMs && state.leaseUntilMs > now.getTime()) {
      return Math.max(1_000, state.leaseUntilMs - now.getTime() + 100);
    }
    return 1_000;
  } catch (error) {
    console.warn('[scheduler backup timer]', error);
    return 60_000;
  }
}

function scheduleNightlyBackup(now = new Date()) {
  clearTrackedTimer(nightlyBackupTimer);
  nightlyBackupTimer = undefined;
  if (!schedulerStarted || schedulerStopping) return;
  const delay = nightlyDelay(now);
  const timer = setTimeout(() => {
    schedulerTimers.delete(timer);
    if (nightlyBackupTimer === timer) nightlyBackupTimer = undefined;
    void runTracked(async () => {
      try { await maybeNightlyBackup(new Date()); }
      finally { scheduleNightlyBackup(new Date()); }
    });
  }, delay);
  nightlyBackupTimer = timer;
  schedulerTimers.add(timer);
  nightlyBackupTimer.unref?.();
}

async function maybeTimeMachineSnapshots() {
  if (!automationEnabled('time-machine-scheduler')) return;
  try {
    await runDueSnapshots();
    recordAutomationRun('time-machine-scheduler');
  } catch (error) {
    console.warn('[time-machine]', error);
  }
}

export function startScheduler() {
  if (schedulerStarted) return;
  schedulerStarted = true;
  schedulerStopping = false;
  // establish a baseline, then alert on transitions every 5 minutes
  void runTracked(healthCheck);
  trackInterval(healthCheck, 5 * 60 * 1000);
  // Give mounts, storage and other containers time to settle after a host boot,
  // then recover at most one missed occurrence and re-arm from the cursor.
  trackTimeout(async () => {
    try { await maybeNightlyBackup(new Date()); }
    finally { scheduleNightlyBackup(new Date()); }
  }, BACKUP_STARTUP_GRACE_MS);
  trackTimeout(maybeAutoRequest, 2 * 60 * 1000);
  trackInterval(maybeAutoRequest, 6 * 60 * 60 * 1000);
  // Time Machine evaluates per-user policies frequently; content hashing only
  // runs for accounts whose configured interval is actually due.
  trackTimeout(maybeTimeMachineSnapshots, 30_000);
  trackInterval(maybeTimeMachineSnapshots, 30 * 60 * 1000);
  console.log('scheduler started (health alerts + nightly backup + auto-request + time machine)');
}

export async function stopScheduler() {
  schedulerStopping = true;
  schedulerStarted = false;
  for (const timer of [...schedulerTimers]) clearTrackedTimer(timer);
  nightlyBackupTimer = undefined;
  // A recovery bundle can take hours on large libraries, while Docker grants
  // seconds to stop. Cooperative cancellation closes its streams, removes
  // only its staging paths, and lets maybeNightlyBackup release the owned
  // durable lease before the process closes SQLite. A verified bundle already
  // crossing its atomic publication barrier is allowed to finish instead.
  await abortActiveBackup(new Error(BACKUP_INTERRUPTED_BY_SHUTDOWN));
  await Promise.allSettled([...activeTasks]);
}

export const schedulerTestApi = {
  healthCheck,
  maybeNightlyBackup,
  runTrackedNightlyBackup(now: Date) {
    return runTracked(() => maybeNightlyBackup(now));
  },
  maybeAutoRequest,
  maybeTimeMachineSnapshots,
  reset() {
    for (const timer of [...schedulerTimers]) clearTrackedTimer(timer);
    nightlyBackupTimer = undefined;
    schedulerStarted = false;
    schedulerStopping = false;
    activeTasks.clear();
    storageAlerted = false;
    for (const key of Object.keys(failureStreak)) delete failureStreak[key];
    for (const key of Object.keys(serviceAlerted)) delete serviceAlerted[key];
    for (const key of Object.keys(resourceAlerted)) delete resourceAlerted[key];
  },
};
