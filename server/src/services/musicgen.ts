// AI music generation via ACE-Step 1.5 (FastAPI on :8019). Correct async flow:
// POST /release_task {prompt,lyrics,audio_duration,inference_steps,guidance_scale}
//   -> {data:{task_id,status:"queued"}} ; POST /query_result {task_id_list:"[id]"}
//   -> results incl. audio_paths[] when done ; GET /v1/audio?path=... -> the file.
// (/v1/create_sample is a random-example endpoint, NOT generation.) Shares the
// single GPU with ComfyUI — the GPU manager frees its VRAM first.
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import * as gpu from './gpu.js';

const base = () => config.acestep.url.replace(/\/$/, '');

export async function available(): Promise<{ up: boolean; queue?: number; gpuBusy?: boolean }> {
  try {
    const h = await fetch(`${base()}/health`, { signal: AbortSignal.timeout(3000) });
    if (!h.ok) return { up: false };
    const stats = await fetch(`${base()}/v1/stats`, { signal: AbortSignal.timeout(3000) }).then(r => r.json()).catch(() => null);
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

export async function generate(p: MusicParams): Promise<{ audioPath: string }> {
  // Run under the GPU lock: never overlaps image gen, and frees ComfyUI's VRAM
  // first so ACE-Step's model can fit on the shared 3090.
  return gpu.run('music', async () => {
    const body = {
      prompt: p.prompt,
      lyrics: p.lyrics || '[inst]',
      audio_duration: p.durationSec || 30,
      inference_steps: p.steps || 8,
      guidance_scale: p.guidance || 7,
      batch_size: 1, // one sample — halves VRAM (default is 2 → ~19.5GB peak) + faster
    };
    const res = await fetch(`${base()}/release_task`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(20000),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || (data.code && data.code >= 400) || data.error) {
      throw new Error(`ACE-Step: ${data.error || `HTTP ${res.status}`}`.slice(0, 240));
    }
    const taskId = data?.data?.task_id || data?.task_id || data?.data?.job_id;
    if (!taskId) throw new Error('ACE-Step: no task id returned');
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
      const res = await fetch(`${base()}/query_result`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ task_id_list: JSON.stringify([taskId]) }), signal: AbortSignal.timeout(8000),
      });
      const d = await res.json().catch(() => ({}));
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
export async function fetchAndStore(userId: number, audioPath: string): Promise<string> {
  const url = audioPath.startsWith('http') ? audioPath
    : audioPath.startsWith('/') ? `${base()}${audioPath}`
    : `${base()}/v1/audio?path=${encodeURIComponent(audioPath)}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(60000) });
  if (!res.ok) throw new Error(`acestep audio ${res.status}`);
  const dir = path.join(config.dataDir, 'music');
  fs.mkdirSync(dir, { recursive: true });
  const filename = `music_${userId}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}.mp3`;
  fs.writeFileSync(path.join(dir, filename), Buffer.from(await res.arrayBuffer()));
  return filename;
}

export function storedPath(filename: string): string {
  return path.join(config.dataDir, 'music', path.basename(filename));
}
