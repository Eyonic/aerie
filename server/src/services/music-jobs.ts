// Durable AI-music queue. generated_music remains the public track catalog;
// jobs stores the complete, restartable worker payload and lifecycle metadata.
// A conditional SQLite claim keeps execution globally bounded to one worker in
// this process, while the GPU service remains the cross-feature serialization
// point for image and music generation.
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { db, audit, notify } from '../lib/db.js';
import { rowToUser } from '../lib/auth.js';
import type { User } from '../lib/model.js';
import { adminPolicy, assertFileAllowed } from './policy.js';
import * as engine from './musicgen.js';
import * as writes from './storage-write.js';

const MAX_ACTIVE_PER_USER = 3;
const DEFAULT_STEPS = 60;
const DEFAULT_GUIDANCE = 15;

interface MusicPayload {
  lyrics: string | null;
  durationSec: number;
  steps: number;
  guidance: number;
  taskId?: string;
  reservationId?: string;
}

export interface MusicJobInput {
  prompt?: unknown;
  lyrics?: unknown;
  durationSec?: unknown;
  steps?: unknown;
  guidance?: unknown;
}

function bounded(value: unknown, fallback: number, minimum: number, maximum: number, integer = false): number {
  const parsed = Number(value);
  const safe = Number.isFinite(parsed) ? parsed : fallback;
  const limited = Math.min(maximum, Math.max(minimum, safe));
  return integer ? Math.round(limited) : limited;
}

function normalized(input: MusicJobInput) {
  const prompt = String(input.prompt || '').trim().slice(0, 2000);
  if (!prompt) throw Object.assign(new Error('prompt_required'), { status: 400 });
  const payload: MusicPayload = {
    lyrics: input.lyrics == null ? null : String(input.lyrics).slice(0, 20_000),
    durationSec: bounded(input.durationSec, 30, 5, 600, true),
    steps: bounded(input.steps, DEFAULT_STEPS, 1, 200, true),
    guidance: bounded(input.guidance, DEFAULT_GUIDANCE, 0, 30),
  };
  return { prompt, payload };
}

function payloadFor(row: any): MusicPayload {
  let value: Partial<MusicPayload> = {};
  try { value = JSON.parse(String(row.payload || '{}')); } catch { /* use durable row fallbacks */ }
  return {
    lyrics: value.lyrics == null ? (row.lyrics == null ? null : String(row.lyrics)) : String(value.lyrics),
    durationSec: bounded(value.durationSec ?? row.duration_sec, 30, 5, 600, true),
    steps: bounded(value.steps, DEFAULT_STEPS, 1, 200, true),
    guidance: bounded(value.guidance, DEFAULT_GUIDANCE, 0, 30),
    ...(typeof value.taskId === 'string' && value.taskId ? { taskId: value.taskId } : {}),
    ...(typeof value.reservationId === 'string' && value.reservationId ? { reservationId: value.reservationId } : {}),
  };
}

function mapTrack(row: any) {
  return {
    id: row.id,
    prompt: row.prompt,
    lyrics: row.lyrics,
    status: row.status,
    url: row.status === 'done' && row.filename ? `/api/music-gen/audio/${row.filename}` : null,
    durationSec: row.duration_sec,
    error: row.error,
    createdAt: row.created_at,
  };
}

export function listMusicTracks(userId: number) {
  const rows = db.prepare('SELECT * FROM generated_music WHERE user_id=? ORDER BY created_at DESC LIMIT 100')
    .all(userId) as any[];
  return rows.map(mapTrack);
}

export async function musicAudioPath(userId: number, filenameValue: unknown): Promise<string | null> {
  const filename = String(filenameValue || '');
  if (!filename) return null;
  if (!db.prepare('SELECT 1 FROM generated_music WHERE filename=? AND user_id=? AND status=\'done\'')
    .get(filename, userId)) return null;
  const stored = engine.storedPath(filename);
  return fsp.access(stored).then(() => stored, () => null);
}

export function enqueueMusicJob(user: User, input: MusicJobInput): { id: string; status: 'queued' } {
  const { prompt, payload } = normalized(input);
  const id = `m_${crypto.randomUUID()}`;
  const enqueue = db.transaction(() => {
    if (!db.prepare('SELECT 1 FROM users WHERE id=? AND disabled_at IS NULL').get(user.id)) {
      throw Object.assign(new Error('account_deactivated'), { status: 403 });
    }
    const active = db.prepare("SELECT COUNT(*) count FROM generated_music WHERE user_id=? AND status IN ('queued','running')")
      .get(user.id) as any;
    if (Number(active?.count || 0) >= MAX_ACTIVE_PER_USER) {
      throw Object.assign(new Error('too_many_active_music_jobs'), { status: 429 });
    }
    db.prepare('INSERT INTO generated_music (id,user_id,prompt,lyrics,duration_sec,status) VALUES (?,?,?,?,?,?)')
      .run(id, user.id, prompt, payload.lyrics, payload.durationSec, 'queued');
    db.prepare('INSERT INTO jobs (id,user_id,type,status,prompt,payload,progress) VALUES (?,?,?,?,?,?,0)')
      .run(id, user.id, 'music', 'queued', prompt, JSON.stringify(payload));
  });
  enqueue();
  try { audit(user.id, user.username, 'music_generation_queued', prompt.slice(0, 200)); } catch { /* queue is authoritative */ }
  kickWorker();
  return { id, status: 'queued' };
}

function terminalJob(id: string, status: 'done' | 'error', error?: string | null, filename?: string | null) {
  const result = filename ? JSON.stringify([`/api/music-gen/audio/${filename}`]) : null;
  db.prepare(`UPDATE jobs SET status=?,progress=?,result_urls=?,error=?,finished_at=datetime('now')
    WHERE id=? AND type='music' AND status='running'`)
    .run(status, status === 'done' ? 1 : 0, result, error || null, id);
}

function claimNext(): any | null | undefined {
  const candidate = db.prepare(`SELECT j.*,m.lyrics,m.duration_sec,m.filename,m.status track_status,m.error track_error
    FROM jobs j
    JOIN generated_music m ON m.id=j.id AND m.user_id=j.user_id
    JOIN users u ON u.id=j.user_id AND u.disabled_at IS NULL
    WHERE j.type='music' AND j.status='queued'
    ORDER BY j.created_at,j.rowid LIMIT 1`).get() as any;
  if (!candidate) return null;
  const claim = db.transaction(() => {
    const job = db.prepare("UPDATE jobs SET status='running',progress=0,error=NULL,finished_at=NULL WHERE id=? AND type='music' AND status='queued'")
      .run(candidate.id);
    if (!job.changes) return false;
    if (candidate.track_status === 'done' && candidate.filename) {
      terminalJob(candidate.id, 'done', null, candidate.filename);
      return false;
    }
    if (!['queued', 'running'].includes(String(candidate.track_status))) {
      terminalJob(candidate.id, 'error', candidate.track_error || 'music_track_not_runnable');
      return false;
    }
    const track = db.prepare(`UPDATE generated_music SET status='running',error=NULL
      WHERE id=? AND user_id=? AND status IN ('queued','running')
        AND EXISTS (SELECT 1 FROM users WHERE id=? AND disabled_at IS NULL)`)
      .run(candidate.id, candidate.user_id, candidate.user_id);
    if (!track.changes) {
      terminalJob(candidate.id, 'error', 'music_track_not_runnable');
      return false;
    }
    return true;
  });
  return claim() ? candidate : undefined;
}

function stillRunnable(id: string, userId: number): boolean {
  return !!db.prepare(`SELECT 1 FROM generated_music m JOIN jobs j ON j.id=m.id AND j.user_id=m.user_id
    JOIN users u ON u.id=m.user_id AND u.disabled_at IS NULL
    WHERE m.id=? AND m.user_id=? AND m.status='running' AND j.type='music' AND j.status='running'`)
    .get(id, userId);
}

function finalize(id: string, userId: number, filename: string): boolean {
  const complete = db.transaction(() => {
    const track = db.prepare(`UPDATE generated_music SET status='done',filename=?,error=NULL
      WHERE id=? AND user_id=? AND status='running'
        AND EXISTS (SELECT 1 FROM users WHERE id=? AND disabled_at IS NULL)`)
      .run(filename, id, userId, userId);
    if (!track.changes) return false;
    const job = db.prepare(`UPDATE jobs SET status='done',progress=1,result_urls=?,error=NULL,finished_at=datetime('now')
      WHERE id=? AND user_id=? AND type='music' AND status='running'
        AND EXISTS (SELECT 1 FROM users WHERE id=? AND disabled_at IS NULL)`)
      .run(JSON.stringify([`/api/music-gen/audio/${filename}`]), id, userId, userId);
    if (!job.changes) throw new Error('music_job_finalize_conflict');
    return true;
  });
  return complete();
}

function markFailed(id: string, userId: number, message: string): boolean {
  const fail = db.transaction(() => {
    const track = db.prepare(`UPDATE generated_music SET status='error',error=?
      WHERE id=? AND user_id=? AND status='running'
        AND EXISTS (SELECT 1 FROM users WHERE id=? AND disabled_at IS NULL)`)
      .run(message, id, userId, userId);
    if (!track.changes) return false;
    db.prepare(`UPDATE jobs SET status='error',progress=0,error=?,finished_at=datetime('now')
      WHERE id=? AND user_id=? AND type='music' AND status='running'`)
      .run(message, id, userId);
    return true;
  });
  return fail();
}

async function execute(row: any): Promise<void> {
  const payload = payloadFor(row);
  const account = db.prepare('SELECT * FROM users WHERE id=? AND disabled_at IS NULL').get(row.user_id);
  let stored: { filename: string; size: number } | null = null;
  let reservation: writes.StorageReservation | null = null;
  let committed = false;
  try {
    if (!account) throw new Error('account_inactive');
    const user = rowToUser(account);
    if (user.aiMode === 'disabled' || user.features?.ai === false) throw new Error('ai_disabled');
    const { audioPath } = await engine.generate({
      prompt: String(row.prompt || ''),
      lyrics: payload.lyrics || undefined,
      durationSec: payload.durationSec,
      steps: payload.steps,
      guidance: payload.guidance,
    }, {
      taskId: payload.taskId,
      onTaskId: async taskId => {
        payload.taskId = taskId;
        const saved = db.prepare(`UPDATE jobs SET payload=? WHERE id=? AND user_id=? AND type='music' AND status='running'
          AND EXISTS (SELECT 1 FROM users WHERE id=? AND disabled_at IS NULL)`)
          .run(JSON.stringify(payload), row.id, row.user_id, row.user_id);
        if (!saved.changes) throw new Error('music_job_no_longer_active');
      },
    });
    if (!stillRunnable(row.id, row.user_id)) throw new Error('music_job_no_longer_active');
    stored = await engine.fetchAndStore(row.user_id, audioPath, adminPolicy().maxUploadBytes);
    assertFileAllowed(stored.filename, stored.size);
    reservation = await writes.reserveStorage(user, stored.size);
    payload.reservationId = reservation.id;
    const reservationSaved = db.prepare(`UPDATE jobs SET payload=?
      WHERE id=? AND user_id=? AND type='music' AND status='running'
        AND EXISTS (SELECT 1 FROM users WHERE id=? AND disabled_at IS NULL)`)
      .run(JSON.stringify(payload), row.id, row.user_id, row.user_id);
    if (!reservationSaved.changes) throw new Error('music_job_no_longer_active');
    committed = finalize(row.id, row.user_id, stored.filename);
    if (!committed) throw new Error('music_job_no_longer_active');
    try { audit(user.id, user.username, 'music_generated', String(row.prompt || '').slice(0, 200)); }
    catch { /* completed media remains authoritative */ }
    try {
      notify(user.id, 'Music ready', `"${String(row.prompt || '').slice(0, 40)}" finished`, 'success', '/music-studio');
    } catch { /* completion is already durable */ }
  } catch (error: any) {
    const message = String(error?.message || error || 'music_generation_failed').slice(0, 300);
    if (stored && !committed) await fs.promises.rm(engine.storedPath(stored.filename), { force: true }).catch(() => {});
    if (markFailed(row.id, row.user_id, message)) {
      try {
        notify(row.user_id, 'Music generation failed', 'Open Music Studio for details and retry when ready.', 'error', '/music-studio');
      } catch { /* best-effort */ }
    }
  } finally {
    let released = !reservation;
    try { writes.releaseStorage(reservation); released = true; } catch { /* restart recovery retries persisted reservations */ }
    if (released && payload.reservationId) {
      delete payload.reservationId;
      try {
        db.prepare("UPDATE jobs SET payload=? WHERE id=? AND user_id=? AND type='music'")
          .run(JSON.stringify(payload), row.id, row.user_id);
      } catch { /* a deleted job has no durable reservation to retain */ }
    }
  }
}

async function drainLoop(): Promise<void> {
  for (;;) {
    const row = claimNext();
    if (row === null) return;
    if (row === undefined) continue;
    await execute(row);
  }
}

let drainPromise: Promise<void> | null = null;
function kickWorker(): void {
  if (drainPromise) return;
  const running = drainLoop();
  drainPromise = running;
  void running.catch(error => console.error('[music-worker]', error)).finally(() => {
    if (drainPromise === running) drainPromise = null;
  });
}

let recoveryStarted = false;
export function recoverMusicJobs(): void {
  if (recoveryStarted) return;
  recoveryStarted = true;
  const recover = db.transaction(() => {
    // A crash can occur after quota reservation but before the worker's finally
    // block. Reservation IDs live in the durable payload so restart can release
    // them immediately rather than charging the account until TTL expiry.
    const persisted = db.prepare("SELECT id,user_id,payload FROM jobs WHERE type='music' AND payload IS NOT NULL").all() as any[];
    for (const job of persisted) {
      const payload = payloadFor(job);
      if (!payload.reservationId) continue;
      try {
        writes.releaseStorage(payload.reservationId);
        delete payload.reservationId;
        db.prepare("UPDATE jobs SET payload=? WHERE id=? AND user_id=? AND type='music'")
          .run(JSON.stringify(payload), job.id, job.user_id);
      } catch { /* leave the ID persisted so a later restart can retry */ }
    }
    const rows = db.prepare(`SELECT m.* FROM generated_music m
      JOIN users u ON u.id=m.user_id AND u.disabled_at IS NULL
      WHERE m.status IN ('queued','running') ORDER BY m.created_at,m.rowid`).all() as any[];
    const findJob = db.prepare("SELECT id,payload FROM jobs WHERE id=? AND type='music'");
    const insertJob = db.prepare(`INSERT INTO jobs
      (id,user_id,type,status,prompt,payload,progress,created_at,finished_at)
      VALUES (?,?,?,?,?,?,0,?,NULL)`);
    const resetJob = db.prepare(`UPDATE jobs SET status='queued',progress=0,result_urls=NULL,error=NULL,finished_at=NULL
      WHERE id=? AND type='music'`);
    for (const row of rows) {
      const existing = findJob.get(row.id) as any;
      if (existing) resetJob.run(row.id);
      else {
        const payload: MusicPayload = {
          lyrics: row.lyrics == null ? null : String(row.lyrics),
          durationSec: bounded(row.duration_sec, 30, 5, 600, true),
          steps: DEFAULT_STEPS,
          guidance: DEFAULT_GUIDANCE,
        };
        insertJob.run(row.id, row.user_id, 'music', 'queued', row.prompt, JSON.stringify(payload), row.created_at);
      }
      db.prepare("UPDATE generated_music SET status='queued',error=NULL WHERE id=? AND status IN ('queued','running')")
        .run(row.id);
    }
    db.prepare(`UPDATE jobs SET status='error',progress=0,error='music_track_or_owner_unavailable',finished_at=datetime('now')
      WHERE type='music' AND status IN ('queued','running')
        AND NOT EXISTS (
          SELECT 1 FROM generated_music m JOIN users u ON u.id=m.user_id AND u.disabled_at IS NULL
          WHERE m.id=jobs.id AND m.user_id=jobs.user_id AND m.status IN ('queued','running')
        )`).run();
  });
  recover();
  kickWorker();
}

export async function deleteMusicTrack(userId: number, idValue: unknown): Promise<{ ok: true }> {
  const id = String(idValue || '');
  const remove = db.transaction(() => {
    const row = db.prepare('SELECT filename FROM generated_music WHERE id=? AND user_id=?').get(id, userId) as any;
    db.prepare("DELETE FROM jobs WHERE id=? AND user_id=? AND type='music'").run(id, userId);
    db.prepare('DELETE FROM generated_music WHERE id=? AND user_id=?').run(id, userId);
    return row?.filename ? String(row.filename) : null;
  });
  const filename = remove();
  if (filename) await fs.promises.rm(engine.storedPath(filename), { force: true }).catch(() => {});
  return { ok: true };
}

export const musicJobTestApi = {
  async waitForIdle() {
    while (drainPromise) await drainPromise.catch(() => {});
  },
  kick: kickWorker,
  resetRecovery() { recoveryStarted = false; },
};
