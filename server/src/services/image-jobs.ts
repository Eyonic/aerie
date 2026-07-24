import crypto from 'node:crypto';
import { db, notify } from '../lib/db.js';
import { rowToUser } from '../lib/auth.js';
import type { User } from '../lib/model.js';
import * as engine from './images.js';
import { discardGeneratedImages, saveGeneratedImages } from './generated-media.js';

interface ImagePayload {
  width: number;
  height: number;
  steps: number;
  cfgScale: number;
}

let working = false;
let recoveryStarted = false;

function resultForExisting(userId: number, workflow: string): string[] {
  return (db.prepare('SELECT filename FROM generated_images WHERE user_id=? AND workflow=? ORDER BY created_at')
    .all(userId, workflow) as any[]).map(row => `/api/images/file/${row.filename}`);
}

async function execute(row: any): Promise<void> {
  const workflow = `assistant:${row.id}`;
  const existing = resultForExisting(row.user_id, workflow);
  if (existing.length) {
    db.prepare("UPDATE jobs SET status='done',progress=1,result_urls=?,finished_at=datetime('now') WHERE id=?")
      .run(JSON.stringify(existing), row.id);
    return;
  }
  const account = db.prepare('SELECT * FROM users WHERE id=? AND disabled_at IS NULL').get(row.user_id);
  if (!account) throw new Error('user_not_found');
  const user = rowToUser(account);
  if (user.aiMode === 'disabled' || user.features?.ai === false) throw new Error('ai_disabled');
  const payload: ImagePayload = (() => {
    try { return JSON.parse(String(row.payload || '{}')); } catch { return {} as ImagePayload; }
  })();
  const width = Math.round(Math.min(2048, Math.max(256, Number(payload.width) || 832)) / 64) * 64;
  const height = Math.round(Math.min(2048, Math.max(256, Number(payload.height) || 1216)) / 64) * 64;
  const steps = Math.min(100, Math.max(1, Number(payload.steps) || 24));
  const cfgScale = Math.min(30, Math.max(0, Number(payload.cfgScale) || 7));
  if (!(await engine.available())) throw new Error('image_engine_offline');
  const rendered = await engine.txt2img({ prompt: row.prompt, width, height, steps, cfgScale, batch: 1 });
  const saved = await saveGeneratedImages(user, row.prompt, rendered, width, height, workflow);
  const urls = saved.map(item => item.url);
  const completed = db.prepare(`UPDATE jobs SET status='done',progress=1,result_urls=?,finished_at=datetime('now')
    WHERE id=? AND status='running' AND EXISTS
      (SELECT 1 FROM users WHERE id=jobs.user_id AND disabled_at IS NULL)`)
    .run(JSON.stringify(urls), row.id);
  if (!completed.changes) {
    await discardGeneratedImages(user.id, saved.map(item => item.id));
    return;
  }
  notify(user.id, 'AI image ready', 'Your assistant image is available in AI Image Studio.', 'success', '/ai-images');
}

async function drain(): Promise<void> {
  if (working) return;
  working = true;
  try {
    for (;;) {
      const row = db.prepare("SELECT * FROM jobs WHERE type='image' AND status='queued' ORDER BY created_at,rowid LIMIT 1").get() as any;
      if (!row) break;
      const claimed = db.prepare("UPDATE jobs SET status='running',progress=0,error=NULL WHERE id=? AND status='queued'").run(row.id);
      if (!claimed.changes) continue;
      try { await execute(row); }
      catch (error: any) {
        const message = String(error?.message || error || 'image_job_failed').slice(0, 300);
        const failed = db.prepare("UPDATE jobs SET status='error',error=?,finished_at=datetime('now') WHERE id=? AND status='running'")
          .run(message, row.id);
        if (failed.changes) notify(row.user_id, 'AI image failed', message, 'error', '/ai-images');
      }
    }
  } finally { working = false; }
}

export function enqueueImageJob(user: User, promptValue: unknown): string {
  const prompt = String(promptValue || '').trim().slice(0, 4000);
  if (!prompt) throw Object.assign(new Error('prompt_required'), { status: 400 });
  const active = db.prepare("SELECT COUNT(*) count FROM jobs WHERE user_id=? AND type='image' AND status IN ('queued','running')")
    .get(user.id) as any;
  if (Number(active?.count || 0) >= 3) throw Object.assign(new Error('too_many_active_image_jobs'), { status: 429 });
  const id = `j_${crypto.randomUUID()}`;
  const payload: ImagePayload = { width: 832, height: 1216, steps: 24, cfgScale: 7 };
  db.prepare('INSERT INTO jobs (id,user_id,type,status,prompt,payload,progress) VALUES (?,?,?,?,?,?,0)')
    .run(id, user.id, 'image', 'queued', prompt, JSON.stringify(payload));
  void drain();
  return id;
}

export function recoverImageJobs(): void {
  if (recoveryStarted) return;
  recoveryStarted = true;
  db.prepare("UPDATE jobs SET status='queued',progress=0,error=NULL,finished_at=NULL WHERE type='image' AND status='running'").run();
  void drain();
}

// Defer recovery until all top-level modules (including persisted integration
// overrides) have finished initializing.
setTimeout(recoverImageJobs, 0).unref();
