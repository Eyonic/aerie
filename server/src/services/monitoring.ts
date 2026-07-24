// System + service monitoring. Pings known backends, reads host stats.
import os from 'node:os';
import net from 'node:net';
import fs from 'node:fs/promises';
import { config } from '../config.js';
import type { ServiceStatus, SystemHealth } from '../lib/model.js';
import { outboundJson, outboundVoid } from './outbound-http.js';

// probe: HTTP path, OR tcp:true for line/socket protocols (e.g. Wyoming Whisper,
// which is NOT HTTP — an HTTP GET returns nothing and falsely reads as offline).
const SERVICES = (): { key: string; name: string; url: string; probe: string; tcp?: boolean }[] => [
  { key: 'aerie', name: 'Aerie Web', url: `http://127.0.0.1:${config.port}`, probe: '/api/health' },
  { key: 'jellyfin', name: 'Media Engine (Jellyfin)', url: config.jellyfin.url, probe: '/System/Info/Public' },
  { key: 'abs', name: 'Audiobook Engine', url: config.audiobookshelf.url, probe: '/healthcheck' },
  { key: 'ai', name: config.deepseek.apiKey ? `AI Engine (DeepSeek ${config.deepseek.model})` : `AI Engine (Local ${config.ollama.model})`, url: config.deepseek.apiKey ? config.deepseek.url : config.ollama.url, probe: config.deepseek.apiKey ? '/models' : '/api/tags' },
  { key: 'comfyui', name: 'AI Image (ComfyUI)', url: config.sd.url, probe: '/system_stats' },
  { key: 'acestep', name: 'AI Music (ACE-Step)', url: config.acestep.url, probe: '/health' },
  { key: 'whisper', name: 'Transcription (Whisper)', url: config.whisper.url, probe: '', tcp: true },
];

function tcpCheck(url: string, timeout = 3000): Promise<boolean> {
  return new Promise(resolve => {
    let host = '127.0.0.1', port = 80;
    try { const u = new URL(url); host = u.hostname; port = Number(u.port) || 80; } catch { /* */ }
    const sock = net.connect({ host, port });
    const done = (ok: boolean) => { try { sock.destroy(); } catch { /* */ } resolve(ok); };
    const t = setTimeout(() => done(false), timeout);
    sock.on('connect', () => { clearTimeout(t); done(true); });
    sock.on('error', () => { clearTimeout(t); done(false); });
  });
}

export async function serviceStatuses(): Promise<ServiceStatus[]> {
  return Promise.all(SERVICES().map(async s => {
    const start = Date.now();
    try {
      if (s.tcp) {
        const ok = await tcpCheck(s.url);
        return { key: s.key, name: s.name, online: ok, latencyMs: Date.now() - start, url: s.url, detail: ok ? undefined : 'unreachable' };
      }
      const headers: any = {};
      if (s.key === 'ai' && config.deepseek.apiKey) headers.Authorization = `Bearer ${config.deepseek.apiKey}`;
      const res = await outboundVoid(s.url.replace(/\/$/, '') + s.probe, {
        timeoutMs: 3_000, headers, requireOk: false,
      });
      return { key: s.key, name: s.name, online: res.status < 500, latencyMs: Date.now() - start, url: s.url };
    } catch {
      return { key: s.key, name: s.name, online: false, url: s.url, detail: 'unreachable' };
    }
  }));
}

async function diskUsage(path: string): Promise<{ used: number; total: number } | null> {
  try {
    const s = await (fs as any).statfs(path);
    const total = s.blocks * s.bsize;
    const free = s.bfree * s.bsize;
    return { used: total - free, total };
  } catch { return null; }
}

let lastCpu = os.cpus();
let lastCpuTime = Date.now();
function cpuPercent(): number {
  const now = os.cpus();
  let idle = 0, total = 0;
  for (let i = 0; i < now.length; i++) {
    const a = lastCpu[i]?.times, b = now[i].times;
    if (!a) continue;
    const idleDiff = b.idle - a.idle;
    const totalDiff = (b.user + b.nice + b.sys + b.idle + b.irq) - (a.user + a.nice + a.sys + a.idle + a.irq);
    idle += idleDiff; total += totalDiff;
  }
  lastCpu = now; lastCpuTime = Date.now();
  if (total <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((1 - idle / total) * 100)));
}

export async function systemHealth(): Promise<SystemHealth> {
  const memTotal = os.totalmem();
  const memFree = os.freemem();
  const disk = await diskUsage(config.mediaRoot) || await diskUsage(config.filesRoot) || await diskUsage('/');
  const gpu = await gpuStats();
  return {
    cpuPct: cpuPercent(),
    memUsedGb: +((memTotal - memFree) / 1e9).toFixed(1),
    memTotalGb: +(memTotal / 1e9).toFixed(1),
    gpuName: gpu?.name,
    gpuMemUsedMb: gpu?.memUsed,
    gpuMemTotalMb: gpu?.memTotal,
    gpuUtilPct: gpu?.util,
    storageUsedTb: disk ? +((disk.used) / 1e12).toFixed(2) : 0,
    storageTotalTb: disk ? +((disk.total) / 1e12).toFixed(2) : 0,
    uptimeSec: Math.round(os.uptime()),
    loadAvg: os.loadavg().map(n => +n.toFixed(2)),
  };
}

// GPU stats read from a host-written stats file if present (see deploy notes),
// else null. Path: DATA_DIR/gpu.json written by an optional host cron.
async function gpuStats(): Promise<{ name: string; memUsed: number; memTotal: number; util?: number } | null> {
  // Preferred: a host cron writing gpu.json (has utilization%).
  try {
    const j = JSON.parse(await fs.readFile(config.dataDir + '/gpu.json', 'utf8'));
    return { name: j.name, memUsed: j.memUsed, memTotal: j.memTotal, util: j.util };
  } catch { /* fall through to ComfyUI */ }
  // Fallback: ComfyUI /system_stats exposes real VRAM (no util%, but accurate memory).
  try {
    const d = (await outboundJson<any>(`${config.sd.url}/system_stats`,
      { timeoutMs: 3000, maxBytes: 2 * 1024 * 1024 })).body;
    const dev = (d.devices || []).find((x: any) => x.type === 'cuda') || d.devices?.[0];
    if (dev && dev.vram_total) {
      const total = dev.vram_total / 1048576, free = (dev.vram_free ?? 0) / 1048576;
      const name = String(dev.name || 'GPU').replace(/^cuda:\d+\s*/i, '').replace(/\s*:\s*native.*$/i, '').trim();
      return { name: name || 'GPU', memUsed: Math.round(total - free), memTotal: Math.round(total) };
    }
  } catch { /* GPU engine offline */ }
  return null;
}
