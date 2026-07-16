import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { config } from '../config.js';
import { db, notify } from '../lib/db.js';
import * as jf from './jellyfin.js';
import * as whisper from './whisper.js';
import { instruct } from './ai.js';

export type SubtitleSource = { type: 'jf'; mediaSourceId: string; index: number } | { type: 'custom'; id: string };
type Cue = { start: number; end: number; text: string };
type JobTask = { id: string; userId: number; run: (jobId: string) => Promise<string> };

const queue: JobTask[] = [];
let active = false;

// Work is held in this process, so a queued/running row left in SQLite at boot
// belongs to a worker that no longer exists. Mark it clearly instead of letting
// the player's recovered progress bar sit at the same percentage forever.
db.prepare(`
  UPDATE jobs
  SET status='error', error='Interrupted by a server restart. Start the subtitle job again.', finished_at=datetime('now')
  WHERE type='subtitles' AND status IN ('queued','running')
`).run();

const uid = (p: string) => `${p}_${Date.now().toString(36)}${crypto.randomBytes(4).toString('hex')}`;
const full = (filename: string) => path.join(config.subtitlesDir, path.basename(filename));
const now = () => new Date().toISOString();
const fmt = (s: number) => {
  s = Math.max(0, s);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = Math.floor(s % 60);
  const ms = Math.round((s - Math.floor(s)) * 1000);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}.${String(ms).padStart(3, '0')}`;
};

export function list(itemId: string) {
  return db.prepare('SELECT id,lang,label,origin,created_at createdAt FROM subtitles WHERE item_id=? ORDER BY created_at DESC').all(itemId);
}

function insertSubtitle(itemId: string, lang: string, label: string, origin: string, userId: number, vtt: string) {
  const id = uid('sub');
  const filename = `${id}.vtt`;
  fs.writeFileSync(full(filename), vtt);
  db.prepare('INSERT INTO subtitles (id,item_id,lang,label,origin,filename,created_by) VALUES (?,?,?,?,?,?,?)')
    .run(id, itemId, lang || 'und', label, origin, filename, userId);
  return { id, lang: lang || 'und', label, origin, createdAt: now() };
}

function enqueue(userId: number, prompt: string, run: (jobId: string) => Promise<string>) {
  const id = uid('job');
  db.prepare('INSERT INTO jobs (id,user_id,type,status,prompt,progress) VALUES (?,?,?,?,?,0)').run(id, userId, 'subtitles', 'queued', prompt);
  queue.push({ id, userId, run });
  drain();
  return id;
}

async function drain() {
  if (active) return;
  const task = queue.shift();
  if (!task) return;
  active = true;
  db.prepare("UPDATE jobs SET status='running', progress=0 WHERE id=?").run(task.id);
  try {
    const sid = await task.run(task.id);
    db.prepare("UPDATE jobs SET status='done', progress=1, result_urls=?, finished_at=datetime('now') WHERE id=?").run(JSON.stringify([sid]), task.id);
    notify(task.userId, 'Subtitles ready', 'AI subtitle job finished.', 'success');
  } catch (e: any) {
    const msg = String(e?.message || 'subtitle job failed');
    db.prepare("UPDATE jobs SET status='error', error=?, finished_at=datetime('now') WHERE id=?").run(msg, task.id);
    notify(task.userId, 'Subtitle job failed', msg, 'error');
  } finally {
    active = false;
    drain();
  }
}

function progress(id: string, p: number) {
  db.prepare('UPDATE jobs SET progress=? WHERE id=?').run(Math.max(0, Math.min(0.99, p)), id);
}

export async function resolveMediaPath(itemId: string): Promise<string> {
  const p = await jf.itemPath(itemId).catch(() => '');
  // Jellyfin reports paths as ITS container sees them; MEDIA_PATH_MAP
  // ("/data/movies=/media/Films,...") translates known prefixes to ours.
  for (const pair of config.mediaPathMap.split(',')) {
    const eq = pair.indexOf('=');
    if (eq < 1) continue;
    const from = pair.slice(0, eq).trim(), to = pair.slice(eq + 1).trim();
    if (from && to && p.startsWith(from)) {
      const candidate = path.join(to, p.slice(from.length));
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  const parts = p.split(/[\\/]+/).filter(Boolean);
  for (let i = 0; i < parts.length; i++) {
    const candidate = path.join(config.mediaRoot, ...parts.slice(i));
    if (fs.existsSync(candidate)) return candidate;
  }
  return jf.directVideoStreamUrl(itemId);
}

function ffmpegPcm(src: string) {
  return spawn('ffmpeg', ['-nostdin', '-v', 'error', '-i', src, '-vn', '-ac', '1', '-ar', '16000', '-f', 's16le', '-']);
}

async function durationSec(itemId: string, src: string) {
  const probed = await new Promise<number>(resolve => {
    const p = spawn('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', src]);
    let out = '';
    p.stdout.on('data', d => out += d);
    p.on('close', () => resolve(Number(out.trim()) || 0));
    p.on('error', () => resolve(0));
  });
  if (probed) return probed;
  const d = await jf.itemDetail(itemId).catch(() => null as any);
  return d?.runtimeTicks ? d.runtimeTicks / 1e7 : 0;
}

function rms(frame: Buffer) {
  let sum = 0;
  for (let i = 0; i + 1 < frame.length; i += 2) { const v = frame.readInt16LE(i) / 32768; sum += v * v; }
  return Math.sqrt(sum / Math.max(1, frame.length / 2));
}

function garbage(text: string) {
  const t = text.trim();
  return !t || !/[A-Za-z0-9\u00C0-\u017E]/.test(t) || /^[\s.,!?;:'"()[\]-]+$/.test(t);
}

function splitText(text: string) {
  const sentences = text.replace(/\s+/g, ' ').trim().match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [text.trim()];
  const pieces: string[] = [];
  for (const s of sentences.map(x => x.trim()).filter(Boolean)) {
    if (s.length <= 84) pieces.push(s);
    else {
      let cur = '';
      for (const w of s.split(/\s+/)) {
        if ((cur + ' ' + w).trim().length > 84 && cur) { pieces.push(cur); cur = w; }
        else cur = (cur + ' ' + w).trim();
      }
      if (cur) pieces.push(cur);
    }
  }
  return pieces.length ? pieces : [text.trim()];
}

function wrap(text: string) {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let cur = '';
  for (const w of words) {
    if ((cur + ' ' + w).trim().length > 42 && cur && lines.length < 1) { lines.push(cur); cur = w; }
    else cur = (cur + ' ' + w).trim();
  }
  if (cur) lines.push(cur);
  return lines.slice(0, 2).join('\n');
}

function cuesForSegment(start: number, end: number, text: string): Cue[] {
  const parts = splitText(text);
  const total = parts.reduce((n, p) => n + p.length, 0) || 1;
  let t = start;
  return parts.map((p, i) => {
    const remaining = end - t;
    const dur = i === parts.length - 1 ? remaining : Math.max(1, Math.min(7, (end - start) * (p.length / total)));
    const cue = { start: t, end: Math.min(end, t + dur), text: wrap(p) };
    t = cue.end;
    return cue;
  }).filter(c => c.end > c.start + 0.05);
}

function toVtt(cues: Cue[]) {
  return 'WEBVTT\n\n' + cues.map((c, i) => `${i + 1}\n${fmt(c.start)} --> ${fmt(c.end)}\n${c.text.trim()}\n`).join('\n');
}

async function generate(jobId: string, itemId: string, userId: number) {
  const src = await resolveMediaPath(itemId);
  progress(jobId, 0.01);
  const dur = await durationSec(itemId, src);
  progress(jobId, 0.02);
  const proc = ffmpegPcm(src);
  const cues: Cue[] = [];
  let carry = Buffer.alloc(0), frames: { b: Buffer; r: number; t: number }[] = [], frameNo = 0;
  const cut = async (take: number) => {
    const seg = frames.splice(0, take);
    const avg = seg.reduce((n, f) => n + f.r, 0) / Math.max(1, seg.length);
    const start = seg[0]?.t || 0, end = (seg.at(-1)?.t || start) + 0.02;
    if (avg < 0.004) return;
    // One flaky Whisper roundtrip must not kill a 2h job: retry once, then skip the segment.
    let text = '';
    for (let attempt = 0; attempt < 2 && !text; attempt++) {
      try { text = (await whisper.transcribe(Buffer.concat(seg.map(f => f.b)), 'en')).trim(); }
      catch { if (attempt) return; }
    }
    if (!garbage(text)) cues.push(...cuesForSegment(start, end, text));
    if (dur) progress(jobId, 0.02 + (end / dur) * 0.96);
  };
  for await (const chunk of proc.stdout) {
    carry = Buffer.concat([carry, chunk as Buffer]);
    while (carry.length >= 640) {
      const b = carry.subarray(0, 640); carry = carry.subarray(640);
      frames.push({ b, r: rms(b), t: frameNo * 0.02 }); frameNo++;
      if (frames.length >= 300) {
        let best = 300, bestR = Infinity;
        const max = Math.min(frames.length - 15, 1100);
        for (let i = 300; i <= max; i++) {
          const r = frames.slice(i - 15, i).reduce((n, f) => n + f.r, 0) / 15;
          if (r < bestR) { bestR = r; best = i; }
        }
        if (bestR < 0.006 || frames.length >= 1100) await cut(best);
      }
    }
  }
  if (frames.length >= 50) await cut(frames.length);
  if (proc.exitCode && proc.exitCode !== 0) throw new Error('ffmpeg failed');
  if (!cues.length) throw new Error('no speech detected in the audio');
  progress(jobId, 0.99);
  const row = insertSubtitle(itemId, 'en', 'English (AI)', 'generated', userId, toVtt(cues));
  return row.id;
}

export function generateSubtitles(itemId: string, userId: number) {
  return enqueue(userId, `generate:${itemId}`, jobId => generate(jobId, itemId, userId));
}

function parseTime(t: string) {
  const m = t.trim().replace(',', '.').match(/(?:(\d+):)?(\d{1,2}):(\d{2})(?:\.(\d{1,3}))?/);
  if (!m) return null;
  return (Number(m[1] || 0) * 3600) + Number(m[2]) * 60 + Number(m[3]) + Number((m[4] || '').padEnd(3, '0')) / 1000;
}

export function parseSubs(text: string): Cue[] {
  const blocks = text.replace(/^\uFEFF/, '').replace(/\r/g, '').split(/\n{2,}/);
  const cues: Cue[] = [];
  for (const block of blocks) {
    const lines = block.split('\n').map(l => l.trimEnd()).filter(l => l.trim() && l.trim() !== 'WEBVTT');
    const ti = lines.findIndex(l => l.includes('-->'));
    if (ti < 0) continue;
    const [a, b] = lines[ti].split('-->');
    // The end half may carry cue settings ("... region:x line:90%") and starts
    // with a space after split('-->') — trim first or [0] is the empty string.
    const start = parseTime(a), end = parseTime((b || '').trim().split(/\s+/)[0]);
    if (start == null || end == null || end <= start) continue;
    cues.push({ start, end, text: lines.slice(ti + 1).join('\n').trim() });
  }
  return cues;
}

async function sourceBytes(itemId: string, source: SubtitleSource): Promise<{ bytes: Buffer; lang: string; label: string }> {
  if (source.type === 'custom') {
    const row = db.prepare('SELECT * FROM subtitles WHERE id=?').get(source.id) as any;
    if (!row) throw new Error('subtitle not found');
    return { bytes: fs.readFileSync(full(row.filename)), lang: row.lang, label: row.label };
  }
  const streams = await jf.mediaStreams(itemId);
  const st = streams.subtitles.find((s: any) => Number(s.index) === Number(source.index));
  const up = await fetch(jf.directSubtitleUrl(itemId, source.mediaSourceId, Number(source.index)));
  if (!up.ok) throw new Error('source subtitle unavailable');
  return { bytes: Buffer.from(await up.arrayBuffer()), lang: st?.lang || 'und', label: st?.name || st?.lang || `Subtitle ${source.index}` };
}

function languageName(code: string) {
  const m: Record<string, string> = { en: 'English', nl: 'Dutch', de: 'German', fr: 'French', es: 'Spanish', it: 'Italian', pt: 'Portuguese', cs: 'Czech', da: 'Danish', sv: 'Swedish', no: 'Norwegian', pl: 'Polish' };
  return m[String(code || '').toLowerCase()] || code;
}

function extractJson(text: string) {
  const s = text.trim().replace(/^```(?:json)?|```$/g, '').trim();
  const a = s.indexOf('['), b = s.lastIndexOf(']');
  return JSON.parse(s.slice(a, b + 1));
}

async function translateBatch(batch: { i: number; text: string }[], lang: string) {
  const sys = `You are a professional subtitle translator into ${lang}. Keep meaning, natural colloquial phrasing, keep line breaks (\\n) inside text, do NOT translate names, return ONLY the same JSON shape.`;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const out = await instruct(sys, JSON.stringify(batch), 0.2);
      const arr = extractJson(out);
      if (Array.isArray(arr) && arr.length === batch.length) return arr.map((x: any, i: number) => String(x?.text ?? batch[i].text));
    } catch { /* retry once */ }
  }
  return batch.map(x => x.text);
}

async function translate(jobId: string, itemId: string, source: SubtitleSource, targetLang: string, userId: number) {
  const src = await sourceBytes(itemId, source);
  progress(jobId, 0.02);
  const cues = parseSubs(decodeSubtitle(src.bytes));
  const total = Math.max(1, Math.ceil(cues.length / 40));
  for (let b = 0; b < total; b++) {
    const slice = cues.slice(b * 40, b * 40 + 40).map((c, i) => ({ i, text: c.text }));
    const translated = await translateBatch(slice, targetLang);
    translated.forEach((t, i) => { cues[b * 40 + i].text = t; });
    progress(jobId, 0.05 + ((b + 1) / total) * 0.93);
  }
  progress(jobId, 0.99);
  return insertSubtitle(itemId, targetLang, `${languageName(targetLang)} (AI)`, 'translated', userId, toVtt(cues)).id;
}

export function translateSubtitles(itemId: string, source: SubtitleSource, targetLang: string | undefined, userId: number) {
  const lang = targetLang || config.translateLang;
  return enqueue(userId, `translate:${itemId}:${lang}`, jobId => translate(jobId, itemId, source, lang, userId));
}

function audioChannels(src: string): Promise<number> {
  return new Promise(resolve => {
    const p = spawn('ffprobe', ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=channels', '-of', 'default=nw=1:nk=1', src]);
    let out = '';
    p.stdout.on('data', d => out += d);
    p.on('close', () => resolve(Number(out.trim()) || 2));
    p.on('error', () => resolve(2));
  });
}

// 10 Hz speech-activity envelope. Two things make auto-sync actually lock on:
// (1) on 5.1+ audio, isolate the front-center channel — it is near-pure dialogue
//     (music/effects sit in L/R/surround), so a stereo downmix's wall of sound is
//     removed; (2) mark speech as energy standing ABOVE the local background floor
//     (rolling 10 s minimum), which drops sustained score/ambience and leaves the
//     dialogue onsets that track the subtitles. Validated against a known-aligned
//     reference sub (peaks at offset 0) where a plain-energy envelope found noise.
async function audioEnvelope(itemId: string, jobId: string) {
  const src = await resolveMediaPath(itemId), dur = await durationSec(itemId, src);
  const ch = await audioChannels(src);
  const af = ch >= 3 ? ['-af', 'pan=mono|c0=FC'] : [];
  const proc = spawn('ffmpeg', ['-nostdin', '-v', 'error', '-i', src, ...af, '-vn', '-ac', '1', '-ar', '16000', '-f', 's16le', '-']);
  let carry = Buffer.alloc(0), frame = Buffer.alloc(0), idx = 0;
  const energy: number[] = [];
  for await (const chunk of proc.stdout) {
    carry = Buffer.concat([carry, chunk as Buffer]);
    while (carry.length >= 640) {
      frame = Buffer.concat([frame, carry.subarray(0, 640)]); carry = carry.subarray(640);
      if (frame.length >= 3200) { energy.push(rms(frame)); frame = Buffer.alloc(0); idx++; if (dur && idx % 50 === 0) progress(jobId, 0.05 + ((idx / 10) / dur) * 0.65); }
    }
  }
  const n = energy.length, half = 50; // 100-frame (10 s) rolling window
  const sorted = [...energy].sort((a, b) => a - b), base = Math.max(0.003, sorted[Math.floor(n * 0.3)] || 0);
  const bits = new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    let m = Infinity;
    for (let j = Math.max(0, i - half); j < Math.min(n, i + half); j++) if (energy[j] < m) m = energy[j];
    bits[i] = energy[i] > Math.max(m * 1.7, base) ? 1 : 0;
  }
  return bits;
}

// Subtitle activity at 10 Hz. `scale` applies a framerate ratio (e.g. 25→23.976)
// so a PAL-sourced sub can be tested against a film-rate track.
function subEnvelope(cues: Cue[], len: number, scale = 1) {
  const bits = new Array(len).fill(0);
  for (const c of cues) for (let i = Math.max(0, Math.floor(c.start * scale * 10)); i < Math.min(len, Math.ceil(c.end * scale * 10)); i++) bits[i] = 1;
  return bits;
}

// Pearson-style correlation of mean-centered activity signals. Plain overlap
// counting saturates when music keeps the audio envelope dense; centering
// still yields a distinct peak at the true speech/subtitle alignment.
function correlate(a: number[], s: number[], from = 0, to = a.length) {
  const n = to - from;
  const am = a.slice(from, to).reduce((x, y) => x + y, 0) / Math.max(1, n);
  const sm = s.reduce((x, y) => x + y, 0) / Math.max(1, s.length);
  const va = Math.sqrt(a.slice(from, to).reduce((x, y) => x + (y - am) ** 2, 0) / Math.max(1, n));
  const vs = Math.sqrt(s.reduce((x, y) => x + (y - sm) ** 2, 0) / Math.max(1, s.length));
  if (!va || !vs) return { off: 0, score: 0, median: 1 };
  const r = (off: number) => {
    let dot = 0, cnt = 0;
    for (let i = 0; i < s.length; i++) {
      const j = i + off;
      if (j >= from && j < to) { dot += (a[j] - am) * (s[i] - sm); cnt++; }
    }
    return cnt ? dot / (cnt * va * vs) : 0;
  };
  // Coarse (0.5s) sweep over ±150s for the landscape, then fine (100ms) refine.
  const landscape: number[] = [];
  let best = { off: 0, score: -Infinity, median: 0 };
  for (let off = -1500; off <= 1500; off += 5) {
    const score = r(off);
    landscape.push(score);
    if (score > best.score) best = { off, score, median: 0 };
  }
  for (let off = best.off - 5; off <= best.off + 5; off++) {
    const score = r(off);
    if (score > best.score) best = { off, score, median: 0 };
  }
  best.median = [...landscape].sort((x, y) => x - y)[Math.floor(landscape.length / 2)] || 0;
  return best;
}

// Common framerate ratios: identity, PAL↔film (25↔23.976), and NTSC 24↔23.976.
// A subtitle authored at the wrong rate drifts progressively; scaling by the
// right ratio makes a single offset fit again.
const FPS_RATIOS = [1, 23.976 / 25, 25 / 23.976, 23.976 / 24, 24 / 23.976];

async function sync(jobId: string, itemId: string, source: SubtitleSource, userId: number) {
  const src = await sourceBytes(itemId, source);
  progress(jobId, 0.02);
  const cues = parseSubs(decodeSubtitle(src.bytes));
  if (!cues.length) throw new Error('subtitle has no readable cues');
  progress(jobId, 0.05);
  const a = await audioEnvelope(itemId, jobId);
  progress(jobId, 0.72);
  const maxEnd = Math.max(...cues.map(c => c.end), 0);
  const envFor = (ratio: number) => {
    const len = Math.max(a.length, Math.ceil(maxEnd * ratio * 10) + 1);
    const aP = a.length < len ? a.concat(new Array(len - a.length).fill(0)) : a;
    return { aP, s: subEnvelope(cues, len, ratio) };
  };
  // Pick the framerate ratio whose best offset gives the most prominent peak.
  let best = { score: -Infinity, off: 0, median: 0, ratio: 1 };
  for (const [index, ratio] of FPS_RATIOS.entries()) {
    const { aP, s } = envFor(ratio);
    const r = correlate(aP, s);
    if (r.score - r.median > best.score - best.median) best = { ...r, ratio };
    progress(jobId, 0.75 + ((index + 1) / FPS_RATIOS.length) * 0.17);
  }
  // Energy↔subtitle correlation tops out around 0.1 even on a perfect match, so
  // gate on the peak's prominence over the landscape, not an absolute r.
  if (best.score < 0.05 || best.score - best.median < 0.05) {
    throw new Error('could not confidently match this subtitle to the audio');
  }
  const { aP, s } = envFor(best.ratio);
  const mid = Math.floor(a.length / 2);
  const h1 = correlate(aP, s, 0, mid), h2 = correlate(aP, s, mid, a.length);
  progress(jobId, 0.96);
  const shifted = cues.map(c => ({ ...c }));
  // Residual drift after ratio scaling: if the two halves disagree by >2s and both
  // are confident, fit a line through their centres; otherwise a constant offset.
  if (Math.abs(h1.off - h2.off) > 20 && h1.score - h1.median > 0.04 && h2.score - h2.median > 0.04) {
    const x1 = mid / 20, x2 = (mid + a.length) / 20, y1 = h1.off / 10, y2 = h2.off / 10;
    const slope = (y2 - y1) / Math.max(1, x2 - x1);
    shifted.forEach(c => {
      const st = c.start * best.ratio, en = c.end * best.ratio;
      c.start = Math.max(0, st + y1 + slope * (st - x1));
      c.end = Math.max(c.start + 0.1, en + y1 + slope * (en - x1));
    });
  } else {
    const off = best.off / 10;
    shifted.forEach(c => { c.start = Math.max(0, c.start * best.ratio + off); c.end = Math.max(c.start + 0.1, c.end * best.ratio + off); });
  }
  progress(jobId, 0.99);
  return insertSubtitle(itemId, src.lang, `${src.label} (synced)`, 'synced', userId, toVtt(shifted)).id;
}

export function syncSubtitles(itemId: string, source: SubtitleSource, userId: number) {
  return enqueue(userId, `sync:${itemId}`, jobId => sync(jobId, itemId, source, userId));
}

function mojibakeCount(s: string) {
  return (s.match(/\uFFFD|\u00C3.|\u00C2.|\u00E2\u20AC.|\u00E2\u20AC\u2122|\u00E2\u20AC\u0153|\u00E2\u20AC\u009D|\u00E2\u20AC\u201C|\u00E2\u20AC\u201D/g) || []).length;
}

export function decodeSubtitle(bytes: Buffer) {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes.subarray(2));
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes.subarray(2));
  const utf8 = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  if (!utf8.includes('\uFFFD')) return repairDoubleUtf8(utf8);
  const encs = ['windows-1252', 'iso-8859-1', 'iso-8859-15', 'utf-16le', 'utf-16be'];
  let best = utf8, score = mojibakeCount(utf8);
  for (const enc of encs) {
    try {
      const s = new TextDecoder(enc).decode(bytes);
      const sc = mojibakeCount(s);
      if (sc < score) { best = s; score = sc; }
    } catch { /* unsupported encoding */ }
  }
  return repairDoubleUtf8(best);
}

function repairDoubleUtf8(s: string) {
  if (!/[\u00C3\u00C2\u00E2\u20AC]/.test(s)) return s;
  const fixed = Buffer.from(s, 'latin1').toString('utf8');
  return mojibakeCount(fixed) < mojibakeCount(s) ? fixed : s;
}

function htmlEntities(s: string) {
  const named: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  return s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (_m, e) => {
    if (e[0] === '#') return String.fromCodePoint(parseInt(e.slice(e[1]?.toLowerCase() === 'x' ? 2 : 1), e[1]?.toLowerCase() === 'x' ? 16 : 10));
    return named[e.toLowerCase()] ?? '';
  });
}

function cleanText(t: string) {
  return htmlEntities(t.replace(/\{\\[^}]*\}/g, '').replace(/<[^>]+>/g, '').replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '')
    .replace(/\u00E2\u20AC\u2122/g, "'").replace(/\u00E2\u20AC\u0153|\u00E2\u20AC\u009D/g, '"').replace(/\.{3,}/g, '\u2026'))
    .split('\n').map(l => l.replace(/[ \t]+/g, ' ').trim()).filter(Boolean).join('\n').trim();
}

export async function cleanSubtitles(itemId: string, source: SubtitleSource, userId: number) {
  const src = await sourceBytes(itemId, source);
  const raw = parseSubs(decodeSubtitle(src.bytes)).map(c => ({ ...c, text: cleanText(c.text) })).filter(c => c.text);
  const cues: Cue[] = [];
  for (const c of raw) {
    const prev = cues.at(-1);
    if (prev && prev.text === c.text) prev.end = Math.max(prev.end, c.end);
    else cues.push(c);
  }
  for (let i = 0; i < cues.length - 1; i++) if (cues[i].end > cues[i + 1].start) cues[i].end = cues[i + 1].start;
  return insertSubtitle(itemId, src.lang, `${src.label} (cleaned)`, 'cleaned', userId, toVtt(cues.filter(c => c.end > c.start)));
}
