// Universal search across files, media, photos, books.
import { Router } from 'express';
import { type AuthedRequest } from '../lib/auth.js';
import fs from 'node:fs';
import path from 'node:path';
import * as storage from '../services/storage.js';
import * as jf from '../services/jellyfin.js';
import * as abs from '../services/audiobookshelf.js';
import * as pp from '../services/photoprism.js';

const r = Router();

async function safe<T>(p: Promise<T>, f: T): Promise<T> { try { return await p; } catch { return f; } }

r.get('/', async (req: AuthedRequest, res) => {
  const q = String(req.query.q || '').trim();
  const user = req.user!;
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
    safe(abs.allBooks('book').then(bs => bs.filter(b => b.title.toLowerCase().includes(ql)).slice(0, 12)), [] as any[]),
    safe(pp.listPhotos(user.username, { q, count: 12 }), [] as any[]),
  ]);

  const groups: any[] = [];
  if (fileResults.length) groups.push({ kind: 'file', label: 'Files', results: fileResults.slice(0, 12) });
  if (media.length) groups.push({ kind: 'media', label: 'Movies, TV & Music', results: media.map(m => ({
    id: m.id, kind: m.type, title: m.name, subtitle: m.year ? String(m.year) : m.type, thumbUrl: m.posterUrl,
    link: m.type === 'Movie' ? '/movies' : m.type === 'Series' ? '/tv' : '/music' })) });
  if (books.length) groups.push({ kind: 'book', label: 'Audiobooks', results: books.map(b => ({
    id: b.id, kind: 'book', title: b.title, subtitle: b.author, thumbUrl: b.coverUrl, link: '/audiobooks' })) });
  if (photos.length) groups.push({ kind: 'photo', label: 'Photos', results: photos.map(p => ({
    id: p.id, kind: 'photo', title: p.title, subtitle: new Date(p.takenAt).toLocaleDateString(), thumbUrl: p.thumbUrl, link: '/photos' })) });

  res.json({ query: q, groups });
});

export default r;
