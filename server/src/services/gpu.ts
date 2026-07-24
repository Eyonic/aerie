// GPU manager. The server has ONE GPU (RTX 3090). Image generation (ComfyUI) and
// music generation (ACE-Step) both need most of its VRAM, so they must never run
// at the same time — this serializes them with a FIFO mutex. The LLM is DeepSeek
// (cloud), so it never touches the GPU and needs no coordination here.
import { config } from '../config.js';
import { outboundVoid } from './outbound-http.js';

const comfy = config.sd.url.replace(/\/$/, '');
export type GpuKind = 'image' | 'music';

let active: { kind: GpuKind; since: number } | null = null;
const queue: { kind: GpuKind; resolve: () => void }[] = [];

function pump() {
  if (active || queue.length === 0) return;
  const w = queue.shift()!;
  active = { kind: w.kind, since: Date.now() };
  w.resolve();
}
function acquire(kind: GpuKind): Promise<void> {
  return new Promise<void>((resolve) => { queue.push({ kind, resolve }); pump(); });
}
function release() { active = null; pump(); }

// Ask ComfyUI to unload its models + free VRAM (it reloads on the next image job).
// Done before a music job so ACE-Step's model can fit in memory.
export async function freeImageVram(): Promise<void> {
  try {
    await outboundVoid(`${comfy}/free`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ unload_models: true, free_memory: true }),
      timeoutMs: 10_000,
    });
    await new Promise(r => setTimeout(r, 1500)); // let the driver reclaim
  } catch { /* best-effort */ }
}

// Run a GPU task under the lock. Only one image/music task runs at a time; others
// queue and run in order. Music jobs free the image engine's VRAM first.
export async function run<T>(kind: GpuKind, fn: () => Promise<T>): Promise<T> {
  await acquire(kind);
  try {
    if (kind === 'music') await freeImageVram();
    return await fn();
  } finally {
    release();
  }
}

export function status() {
  return {
    busy: !!active,
    running: active?.kind ?? null,
    since: active?.since ?? null,
    runningSeconds: active ? Math.round((Date.now() - active.since) / 1000) : 0,
    queued: queue.length,
    queue: queue.map(w => w.kind),
  };
}
