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
  return db.prepare(`SELECT rel_path path, taken_at takenAt
    FROM photo_index
    WHERE user_id=? AND lower(rel_path) LIKE ?
    ORDER BY taken_at DESC, rel_path ASC LIMIT 12`).all(userId, `%${q.toLowerCase()}%`) as any[];
}

r.get('/', async (req: AuthedRequest, res) => {
  const q = String(req.query.q || '').trim();
  const user = req.user!;
  const audiobooksEnabled = user.features?.audiobooks !== false;
  if (!q) return res.json({ query: q, groups: [] });
  const ql = q.toLowerCase();

  // Files (name match)
  const fileResults: any[] = [];
  try {
    const root = storage.userRoot(user.username);
    const walk = (dir: string, d: number) => {
      if (d > 6 || fileResults.length > 30) return;
      let names: string[]; try { names = fs.readdirSync(dir); } catch { return; }
      for (const n of names) {
        if (n.startsWith('.')) continue;
        const full = path.join(dir, n);
        let st: fs.Stats; try { st = fs.statSync(full); } catch { continue; }
        if (n.toLowerCase().includes(ql)) {
          const v = storage.toVirtual(user.username, full);
          fileResults.push({ id: v, kind: 'file', title: n, subtitle: path.posix.dirname(v),
            thumbUrl: /\.(jpg|jpeg|png|gif|webp)$/i.test(n) ? `/api/files/thumb?path=${encodeURIComponent(v)}` : undefined,
            link: `/files?path=${encodeURIComponent(st.isDirectory() ? v : path.posix.dirname(v))}` });
        }
        if (st.isDirectory()) walk(full, d + 1);
      }
    };
    walk(root, 0);
  } catch { /* */ }

  const [media, books, photos] = await Promise.all([
    safe(jf.search(q), [] as any[]),
    audiobooksEnabled ? safe(abs.allBooks('book').then(bs => bs.filter(b => b.title.toLowerCase().includes(ql)).slice(0, 12)), [] as any[]) : Promise.resolve([]),
    safe(Promise.resolve(nativePhotoSearch(user.id, q)), [] as any[]),
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
