// AI music generation via ACE-Step 1.5 (FastAPI on :8019). Correct async flow:
// POST /release_task {prompt,lyrics,audio_duration,inference_steps,guidance_scale}
//   -> {data:{task_id,status:"queued"}} ; POST /query_result {task_id_list:"[id]"}
//   -> results incl. audio_paths[] when done ; GET /v1/audio?path=... -> the file.
// (/v1/create_sample is a random-example endpoint, NOT generation.) Shares the
// single GPU with ComfyUI — the GPU manager frees its VRAM first.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { config } from '../config.js';
import * as gpu from './gpu.js';
import { outboundJson, outboundVoid, validateOutboundUrl } from './outbound-http.js';

const base = () => config.acestep.url.replace(/\/$/, '');

export async function available(): Promise<{ up: boolean; queue?: number; gpuBusy?: boolean }> {
  try {
    await outboundVoid(`${base()}/health`, { timeoutMs: 3000 });
    const stats = await outboundJson<any>(`${base()}/v1/stats`, { timeoutMs: 3000, maxBytes: 1024 * 1024 })
      .then(result => result.body).catch(() => null);
    return { up: true, queue: stats?.data?.queue_size };
  } catch { return { up: false }; }
}

export interface MusicParams {
  prompt: string;        // genre/style tags, e.g. "lofi hip hop, chill, mellow piano"
  lyrics?: string;       // or "[inst]" for instrumental
  durationSec?: number;
  steps?: number;
  guidance?: number;
}

export interface MusicGenerationOptions {
  // Persisted ACE-Step task IDs let the durable queue resume polling after an
  // Aerie restart instead of submitting the same composition a second time.
  taskId?: string;
  onTaskId?: (taskId: string) => void | Promise<void>;
}

// ACE-Step's /query_result -> { data: [ { status, progress_text, result: "<json>" } ] }
// where `result` is an EMBEDDED JSON STRING that parses to [{ file, wave, status,
// stage }]. On success stage is "completed"/"success" and file is a non-empty audio
// path ("/v1/audio?path=…"); on failure stage is "failed" and progress_text carries
// the reason. Must PARSE the inner string (JSON.stringify would double-escape it).
function parseItems(o: any): { file?: string; stage?: string; progress_text?: string }[] {
  const rows = Array.isArray(o?.data) ? o.data : (o?.data ? [o.data] : []);
  const out: any[] = [];
  for (const row of rows) {
    let inner = row?.result;
    if (typeof inner === 'string') { try { inner = JSON.parse(inner); } catch { inner = null; } }
    const items = Array.isArray(inner) ? inner : (inner ? [inner] : []);
    if (!items.length) out.push({ progress_text: row?.progress_text });
    for (const x of items) out.push({ file: x?.file, stage: x?.stage, progress_text: row?.progress_text ?? x?.progress_text });
  }
  return out;
}
function extractAudio(o: any): string | undefined {
  for (const x of parseItems(o)) {
    if (x.stage && /fail|error/i.test(x.stage)) continue;
    if (x.file && x.file.length > 3) return x.file;
  }
  return undefined;
}
// Returns the failure reason if the task clearly failed, else null.
function isFailed(o: any): string | null {
  for (const x of parseItems(o)) {
    if (x.stage && /fail|error/i.test(x.stage)) {
      return String(x.progress_text || 'generation failed').split('|').pop()!.trim().slice(0, 160);
    }
  }
  if (o?.error) return String(o.error);
  return null;
}

export async function generate(p: MusicParams, options: MusicGenerationOptions = {}): Promise<{ audioPath: string }> {
  // Run under the GPU lock: never overlaps image gen, and frees ComfyUI's VRAM
  // first so ACE-Step's model can fit on the shared 3090.
  return gpu.run('music', async () => {
    let taskId = options.taskId;
    if (taskId && !/^[A-Za-z0-9._:-]{1,256}$/.test(taskId)) throw new Error('ACE-Step: invalid task id');
    if (!taskId) {
      const body = {
        prompt: p.prompt,
        lyrics: p.lyrics || '[inst]',
        audio_duration: p.durationSec ?? 30,
        inference_steps: p.steps ?? 8,
        guidance_scale: p.guidance ?? 7,
        batch_size: 1, // one sample — halves VRAM (default is 2 → ~19.5GB peak) + faster
      };
      const res = await outboundJson<any>(`${base()}/release_task`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body), timeoutMs: 20_000, maxBytes: 2 * 1024 * 1024, requireOk: false,
      });
      const data = res.body || {};
      if (res.status < 200 || res.status >= 300 || (data.code && data.code >= 400) || data.error) {
        throw new Error(`ACE-Step: ${data.error || `HTTP ${res.status}`}`.slice(0, 240));
      }
      const releasedTaskId = data?.data?.task_id || data?.task_id || data?.data?.job_id;
      if (!releasedTaskId) throw new Error('ACE-Step: no task id returned');
      taskId = String(releasedTaskId);
      if (!/^[A-Za-z0-9._:-]{1,256}$/.test(taskId)) throw new Error('ACE-Step: invalid task id');
      await options.onTaskId?.(taskId);
    }
    const audioPath = await poll(taskId);
    if (!audioPath) throw new Error('ACE-Step: generation produced no audio');
    return { audioPath };
  });
}

async function poll(taskId: string, timeoutMs = 300000): Promise<string> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    await new Promise(r => setTimeout(r, 3000));
    try {
      const res = await outboundJson<any>(`${base()}/query_result`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ task_id_list: JSON.stringify([taskId]) }), timeoutMs: 8000,
        maxBytes: 4 * 1024 * 1024, requireOk: false,
      });
      if (res.status < 200 || res.status >= 300) continue;
      const d = res.body || {};
      const fail = isFailed(d);
      if (fail) throw new Error(`ACE-Step: ${fail}`.slice(0, 200));
      const audio = extractAudio(d);
      if (audio) return audio;
    } catch (e: any) { if (/ACE-Step:/.test(e.message)) throw e; }
  }
  throw new Error('ACE-Step: generation timed out');
}

// Fetch the rendered audio and store it under the app's data dir; return filename.
// ACE-Step returns `file` already as "/v1/audio?path=<enc>" — use it as-is (only
// wrap a bare filesystem path).
export async function fetchAndStore(userId: number, audioPath: string, maxBytes: number): Promise<{ filename: string; size: number }> {
  const service = new URL(base());
  const url = audioPath.startsWith('http') ? new URL(audioPath)
    : audioPath.startsWith('/') ? new URL(audioPath, service)
    : new URL(`/v1/audio?path=${encodeURIComponent(audioPath)}`, service);
  const validated = validateOutboundUrl(url);
  // ACE-Step commonly returns a root-relative `/v1/audio` URL even when the
  // configured service URL includes a reverse-proxy base path. Accept only
  // those two exact endpoint paths on the configured origin.
  const allowedAudioPaths = new Set([
    new URL(`${base()}/v1/audio`).pathname,
    new URL('/v1/audio', service).pathname,
  ]);
  if (validated.origin !== service.origin || !allowedAudioPaths.has(validated.pathname)) {
    throw new Error('acestep_audio_origin_rejected');
  }
  const controller = new AbortController();
  const headerTimer = setTimeout(() => controller.abort(), 15_000);
  const res = await fetch(validated, { signal: controller.signal, redirect: 'error' }).finally(() => clearTimeout(headerTimer));
  if (!res.ok) throw new Error(`acestep audio ${res.status}`);
  if (!res.body) throw new Error('acestep audio empty');
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) throw Object.assign(new Error('file_too_large'), { status: 413 });
  const dir = path.join(config.dataDir, 'music');
  await fs.promises.mkdir(dir, { recursive: true });
  const filename = `music_${userId}_${crypto.randomUUID()}.mp3`;
  const destination = path.join(dir, filename);
  const temporary = `${destination}.partial`;
  let size = 0;
  let idleTimer: NodeJS.Timeout;
  const resetIdle = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => controller.abort(), 60_000);
  };
  const limiter = new Transform({
    transform(chunk, _encoding, callback) {
      resetIdle();
      size += chunk.length;
      callback(size > maxBytes ? Object.assign(new Error('file_too_large'), { status: 413 }) : null, chunk);
    },
  });
  try {
    resetIdle();
    await pipeline(Readable.fromWeb(res.body as any), limiter, fs.createWriteStream(temporary, { flags: 'wx', mode: 0o600 }));
    await fs.promises.rename(temporary, destination);
    return { filename, size };
  } catch (error) {
    await fs.promises.rm(temporary, { force: true }).catch(() => {});
    await fs.promises.rm(destination, { force: true }).catch(() => {});
    throw error;
  } finally { clearTimeout(idleTimer!); controller.abort(); }
}

export function storedPath(filename: string): string {
  return path.join(config.dataDir, 'music', path.basename(filename));
}
