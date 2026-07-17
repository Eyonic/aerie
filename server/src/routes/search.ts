// Universal search across files, media, photos, books.
import { Router } from 'express';
import { type AuthedRequest } from '../lib/auth.js';
import fs from 'node:fs';
import path from 'node:path';
import * as storage from '../services/storage.js';
import * as jf from '../services/jellyfin.js';
import * as abs from '../services/audiobookshelf.js';
import { db } from '../lib/db.js';

const r = Router();

async function safe<T>(p: Promise<T>, f: T): Promise<T> { try { return await p; } catch { return f; } }

function nativePhotoSearch(userId: number, q: string) {
  return (db.prepare(`SELECT rel_path path, taken_at takenAt FROM photo_index
    WHERE user_id=? ORDER BY taken_at DESC, rel_path ASC LIMIT 2000`).all(userId) as any[])
    .map(p => ({ ...p, score: fuzzyScore(q, path.posix.basename(p.path)) })).filter(p => p.score > 0).sort((a, b) => b.score - a.score).slice(0, 20);
}

const norm = (v: string) => String(v || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
function distance(a: string, b: string) {
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let last = prev[0]; prev[0] = i;
    for (let j = 1; j <= b.length; j++) { const old = prev[j]; prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, last + (a[i - 1] === b[j - 1] ? 0 : 1)); last = old; }
  }
  return prev[b.length];
}
function fuzzyScore(query: string, value: string) {
  const q = norm(query), v = norm(value); if (!q || !v) return 0;
  if (v === q) return 1000; if (v.startsWith(q)) return 900 - Math.min(100, v.length - q.length);
  if (v.split(' ').some(w => w.startsWith(q))) return 820;
  const at = v.indexOf(q); if (at >= 0) return 750 - Math.min(100, at);
  const words = v.split(' '); let best = Infinity;
  for (const word of words) if (Math.abs(word.length - q.length) <= 3) best = Math.min(best, distance(q, word));
  best = Math.min(best, Math.abs(v.length - q.length) <= 3 ? distance(q, v) : Infinity);
  const allowance = Math.max(1, Math.min(3, Math.floor(q.length / 4)));
  if (best <= allowance) return 620 - best * 70;
  const tokens = q.split(' '); if (tokens.length > 1 && tokens.every(t => v.includes(t))) return 560;
  let qi = 0; for (const c of v) if (c === q[qi]) qi++;
  return qi === q.length && q.length >= 4 ? 350 : 0;
}

function mediaAllowed(user: any, type: string) {
  if (type === 'Movie') return user.features?.movies !== false;
  if (type === 'Series' || type === 'Season' || type === 'Episode') return user.features?.tv !== false;
  if (type === 'Video') return user.features?.videos !== false;
  return user.features?.music !== false;
}

r.get('/', async (req: AuthedRequest, res) => {
  const q = String(req.query.q || '').trim();
  const user = req.user!;
  const audiobooksEnabled = user.features?.audiobooks !== false;
  const only = String(req.query.kind || 'all');
  if (!q) return res.json({ query: q, groups: [] });

  // Files (name match)
  const fileResults: any[] = [];
  if (user.features?.files !== false && (only === 'all' || only === 'file')) try {
    const root = storage.userRoot(user.username);
    let scanned = 0;
    const walk = (dir: string, d: number) => {
      if (d > 8 || scanned > 10_000) return;
      let names: string[]; try { names = fs.readdirSync(dir); } catch { return; }
      for (const n of names) {
        if (n.startsWith('.')) continue;
        scanned++;
        const full = path.join(dir, n);
        let st: fs.Stats; try { st = fs.statSync(full); } catch { continue; }
        const score = fuzzyScore(q, n);
        if (score > 0) {
          const v = storage.toVirtual(user.username, full);
          fileResults.push({ id: v, kind: 'file', title: n, subtitle: path.posix.dirname(v),
            thumbUrl: /\.(jpg|jpeg|png|gif|webp)$/i.test(n) ? `/api/files/thumb?path=${encodeURIComponent(v)}` : undefined,
            link: `/files?path=${encodeURIComponent(st.isDirectory() ? v : path.posix.dirname(v))}`, score });
        }
        if (st.isDirectory()) walk(full, d + 1);
      }
    };
    walk(root, 0);
    fileResults.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title));
  } catch { /* */ }

  const [media, books, photos] = await Promise.all([
    only === 'all' || only === 'media' ? safe(Promise.all([jf.search(q), q.length >= 3 ? jf.listAllByType('Movie,Series,Audio,MusicAlbum') : Promise.resolve([])]).then(([direct, all]) =>
      [...direct.map((m: any) => ({ ...m, _score: 1100 })), ...all.map((m: any) => ({ ...m, _score: fuzzyScore(q, `${m.name} ${m.albumArtist || ''} ${m.album || ''}`) }))]
        .filter((m: any) => m._score > 0 && mediaAllowed(user, m.type)).sort((a: any, b: any) => b._score - a._score)
        .filter((m: any, i: number, arr: any[]) => arr.findIndex(x => x.id === m.id) === i).slice(0, 24)), [] as any[]) : Promise.resolve([]),
    audiobooksEnabled && (only === 'all' || only === 'book') ? safe(abs.allBooks('book').then(bs => bs.map(b => ({ ...b, _score: fuzzyScore(q, `${b.title} ${b.author}`) })).filter(b => b._score > 0).sort((a, b) => b._score - a._score).slice(0, 20)), [] as any[]) : Promise.resolve([]),
    user.features?.photos !== false && (only === 'all' || only === 'photo') ? safe(Promise.resolve(nativePhotoSearch(user.id, q)), [] as any[]) : Promise.resolve([]),
  ]);

  const groups: any[] = [];
  if (fileResults.length) groups.push({ kind: 'file', label: 'Files', results: fileResults.slice(0, 12) });
  if (media.length) groups.push({ kind: 'media', label: 'Movies, TV & Music', results: media.map(m => ({
    id: m.id, kind: m.type, title: m.name, subtitle: m.year ? String(m.year) : m.type, thumbUrl: m.posterUrl,
    link: m.type === 'Movie' ? '/movies' : m.type === 'Series' ? '/tv' : '/music' })) });
  if (books.length) groups.push({ kind: 'book', label: 'Audiobooks', results: books.map(b => ({
    id: b.id, kind: 'book', title: b.title, subtitle: b.author, thumbUrl: b.coverUrl, link: '/audiobooks' })) });
  if (photos.length) groups.push({ kind: 'photo', label: 'Photos', results: photos.map(p => ({
    id: p.path, kind: 'photo', title: path.posix.basename(p.path), subtitle: p.takenAt ? new Date(p.takenAt).toLocaleDateString() : '',
    thumbUrl: `/api/photos/native/thumb?path=${encodeURIComponent(p.path)}`, link: '/photos' })) });

  res.json({ query: q, groups });
});

export default r;
