import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { config } from '../config.js';
import * as jf from './jellyfin.js';

// Thumbnail requests arrive in bursts as a grid scrolls into view. Keep FFmpeg
// work bounded so a large personal-video folder cannot saturate the server.
const pending: { source: string; atSec: number; resolve: (b: Buffer) => void; reject: (e: Error) => void }[] = [];
let active = 0;

function extract(source: string, atSec: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', [
      '-nostdin', '-v', 'error', '-ss', String(Math.max(0, atSec)), '-i', source,
      '-map', '0:v:0', '-frames:v', '1', '-vf', 'scale=min(1280\\,iw):-2',
      '-f', 'image2pipe', '-vcodec', 'mjpeg', 'pipe:1',
    ]);
    const chunks: Buffer[] = [];
    let bytes = 0, stderr = '', settled = false;
    const timer = setTimeout(() => proc.kill('SIGKILL'), 30_000);
    proc.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 20 * 1024 * 1024) proc.kill('SIGKILL');
      else chunks.push(chunk);
    });
    proc.stderr.on('data', d => { stderr += String(d).slice(0, 1000); });
    proc.on('error', e => { if (!settled) { settled = true; clearTimeout(timer); reject(e); } });
    proc.on('close', code => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      const out = Buffer.concat(chunks);
      if (code === 0 && out.length) resolve(out);
      else reject(new Error(stderr.trim() || 'video_thumbnail_failed'));
    });
  });
}

function pump() {
  while (active < 2 && pending.length) {
    const job = pending.shift()!;
    active++;
    extract(job.source, job.atSec).then(job.resolve, job.reject).finally(() => { active--; pump(); });
  }
}

export function videoFrame(source: string, atSec = 1): Promise<Buffer> {
  return new Promise((resolve, reject) => { pending.push({ source, atSec, resolve, reject }); pump(); });
}

export async function jellyfinSource(itemId: string): Promise<{ source: string; mtimeMs?: number }> {
  const reported = await jf.itemPath(itemId).catch(() => '');
  const candidates: string[] = [];
  for (const pair of config.mediaPathMap.split(',')) {
    const eq = pair.indexOf('=');
    if (eq < 1) continue;
    const from = pair.slice(0, eq).trim(), to = pair.slice(eq + 1).trim();
    if (from && to && reported.startsWith(from)) candidates.push(path.join(to, reported.slice(from.length)));
  }
  const parts = reported.split(/[\\/]+/).filter(Boolean);
  for (let i = 0; i < parts.length; i++) candidates.push(path.join(config.mediaRoot, ...parts.slice(i)));
  for (const source of candidates) {
    try { const stat = fs.statSync(source); if (stat.isFile()) return { source, mtimeMs: stat.mtimeMs }; } catch { /* next mapping */ }
  }
  return { source: jf.directVideoStreamUrl(itemId) };
}
