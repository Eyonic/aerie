// Agentic AI tools — lets the local assistant actually DO things (not just chat):
// search files, find the largest/recent files, summarize documents, look at the
// media library, build playlists, generate images, etc. Executed server-side and
// fed back to the Ollama tool-calling loop.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import * as storage from './storage.js';
import * as jf from './jellyfin.js';
import * as abs from './audiobookshelf.js';
import * as pp from './photoprism.js';
import * as ai from './ai.js';
import { db } from '../lib/db.js';

export interface Ctx { username: string; userId: number; }

// ---- Ollama tool (function) definitions ----
export const TOOLS = [
  { type: 'function', function: { name: 'search_files', description: "Search the user's files and folders by name/keyword.", parameters: { type: 'object', properties: { query: { type: 'string', description: 'keyword to search for' } }, required: ['query'] } } },
  { type: 'function', function: { name: 'largest_files', description: 'List the largest files taking up space.', parameters: { type: 'object', properties: { limit: { type: 'integer', description: 'how many (default 10)' } } } } },
  { type: 'function', function: { name: 'recent_files', description: 'List the most recently modified files.', parameters: { type: 'object', properties: { limit: { type: 'integer' } } } } },
  { type: 'function', function: { name: 'storage_usage', description: 'Get total storage used, file count, and a breakdown by file type.', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'read_document', description: 'Read the text content of a document/text/markdown/code file by its path (use search_files first to find the path).', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } },
  { type: 'function', function: { name: 'find_duplicate_photos', description: 'Find likely duplicate photos in the photo library.', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'list_media', description: 'List items from the media library.', parameters: { type: 'object', properties: { kind: { type: 'string', enum: ['movies', 'series', 'albums', 'songs', 'audiobooks'], description: 'what to list' }, limit: { type: 'integer' } }, required: ['kind'] } } },
  { type: 'function', function: { name: 'continue_media', description: 'What the user can continue watching or listening to (in-progress movies/shows/audiobooks).', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'create_playlist', description: 'Build a playlist of songs matching a mood/genre/keyword from the music library. Returns the chosen tracks.', parameters: { type: 'object', properties: { mood: { type: 'string', description: 'mood, genre, artist or keyword' }, count: { type: 'integer', description: 'number of songs (default 20)' } }, required: ['mood'] } } },
  { type: 'function', function: { name: 'generate_image', description: 'Generate an AI image from a text prompt (queues it; result appears in AI Image Studio).', parameters: { type: 'object', properties: { prompt: { type: 'string' } }, required: ['prompt'] } } },
] as const;

async function safe<T>(p: Promise<T>, f: T): Promise<T> { try { return await p; } catch { return f; } }

function walkFiles(username: string, userId: number, maxDepth = 6): { name: string; path: string; size: number; modifiedAt: string }[] {
  const root = storage.userRoot(username);
  const out: any[] = [];
  const walk = (dir: string, d: number) => {
    if (d > maxDepth) return;
    let names: string[]; try { names = fs.readdirSync(dir); } catch { return; }
    for (const n of names) {
      if (n.startsWith('.')) continue;
      const full = path.join(dir, n);
      let st: fs.Stats; try { st = fs.statSync(full); } catch { continue; }
      if (st.isDirectory()) walk(full, d + 1);
      else out.push({ name: n, path: storage.toVirtual(username, full), size: st.size, modifiedAt: st.mtime.toISOString() });
    }
  };
  walk(root, 0);
  return out as any;
}

function fmtBytes(b: number) { if (!b) return '0 B'; const u = ['B', 'KB', 'MB', 'GB', 'TB']; const i = Math.min(Math.floor(Math.log(b) / Math.log(1024)), u.length - 1); return `${(b / 1024 ** i).toFixed(1)} ${u[i]}`; }

export async function execTool(name: string, args: any, ctx: Ctx): Promise<any> {
  const { username, userId } = ctx;
  switch (name) {
    case 'search_files': {
      const q = String(args.query || '').toLowerCase();
      const hits = walkFiles(username, userId).filter(f => f.name.toLowerCase().includes(q)).slice(0, 25);
      return { count: hits.length, files: hits.map(f => ({ name: f.name, path: f.path, size: fmtBytes(f.size) })) };
    }
    case 'largest_files': {
      const files = walkFiles(username, userId).sort((a, b) => b.size - a.size).slice(0, args.limit || 10);
      return { files: files.map(f => ({ name: f.name, path: f.path, size: fmtBytes(f.size) })) };
    }
    case 'recent_files': {
      const files = walkFiles(username, userId).sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt)).slice(0, args.limit || 10);
      return { files: files.map(f => ({ name: f.name, path: f.path, modified: f.modifiedAt })) };
    }
    case 'storage_usage': {
      const u = await safe(storage.computeUsage(username, userId), { usedBytes: 0, fileCount: 0, byKind: {} } as any);
      return { used: fmtBytes(u.usedBytes), files: u.fileCount, byType: Object.fromEntries(Object.entries(u.byKind).map(([k, v]: any) => [k, fmtBytes(v.bytes)])) };
    }
    case 'read_document': {
      try {
        const { real, stat } = storage.statReal(username, args.path);
        if (stat.size > 2_000_000) return { error: 'file too large' };
        const content = await fsp.readFile(real, 'utf8');
        return { path: args.path, content: content.slice(0, 12000) };
      } catch { return { error: 'could not read file' }; }
    }
    case 'find_duplicate_photos': {
      const photos = await safe(pp.listPhotos(username, { count: 1000 }), [] as any[]);
      const byKey = new Map<string, any[]>();
      for (const p of photos) { const k = `${p.title}|${p.width}x${p.height}`; (byKey.get(k) || byKey.set(k, []).get(k))!.push(p); }
      const dups = [...byKey.values()].filter(g => g.length > 1);
      return { duplicateGroups: dups.length, totalDuplicates: dups.reduce((s, g) => s + g.length - 1, 0), examples: dups.slice(0, 5).map(g => g[0].title) };
    }
    case 'list_media': {
      const limit = args.limit || 15;
      if (args.kind === 'movies') return { items: (await safe(jf.listByType('Movie', { Limit: limit, SortBy: 'DateCreated', SortOrder: 'Descending' }), [])).map((m: any) => ({ name: m.name, year: m.year })) };
      if (args.kind === 'series') return { items: (await safe(jf.listByType('Series', { Limit: limit }), [])).map((m: any) => ({ name: m.name, year: m.year })) };
      if (args.kind === 'albums') return { items: (await safe(jf.listByType('MusicAlbum', { Limit: limit }), [])).map((m: any) => ({ name: m.name, artist: m.albumArtist })) };
      if (args.kind === 'songs') return { items: (await safe(jf.listByType('Audio', { Limit: limit }), [])).map((m: any) => ({ name: m.name, album: m.album })) };
      if (args.kind === 'audiobooks') return { items: (await safe(abs.allBooks('book'), [])).slice(0, limit).map((b: any) => ({ title: b.title, author: b.author })) };
      return { items: [] };
    }
    case 'continue_media': {
      const [vids, books] = await Promise.all([
        safe(jf.resumeItems('Video'), [] as any[]),
        safe(abs.allBooks('book').then(bs => bs.filter(b => (b.progressPct || 0) > 0 && (b.progressPct || 0) < 100)), [] as any[]),
      ]);
      return {
        // Carry id/type/series so the UI can deep-link episodes to /tv (not /movies) and
        // show real series context instead of a bare episode name ("Pilot").
        watching: vids.slice(0, 8).map((v: any) => ({
          id: v.id,
          type: v.type,                 // 'Movie' | 'Episode'
          name: v.name,
          seriesName: v.seriesName,
          season: v.seasonNumber,
          episode: v.episodeNumber,
          progress: Math.round(v.progressPct || 0) + '%',
        })),
        listening: books.slice(0, 8).map((b: any) => ({ id: b.id, title: b.title, author: b.author, progress: Math.round(b.progressPct || 0) + '%' })),
      };
    }
    case 'create_playlist': {
      const q = String(args.mood || '').toLowerCase();
      const all = await safe(jf.listByType('Audio', { Limit: 500 }), [] as any[]);
      let picked = all.filter((s: any) => `${s.name} ${s.album} ${s.albumArtist} ${(s.genres || []).join(' ')}`.toLowerCase().includes(q));
      // Don't pad a themed request with a random grab-bag of unrelated songs. If little/nothing
      // matches the mood, return only the genuine matches (fewer/none) — the UI renders an empty
      // result as "No songs matched" rather than a misleading "chill mix" of unrelated tracks.
      picked = picked.slice(0, args.count || 20);
      return { name: `${args.mood} mix`, tracks: picked.map((s: any) => ({ id: s.id, title: s.name, artist: s.albumArtist || s.album })) };
    }
    case 'generate_image': {
      const id = 'j_' + Math.random().toString(36).slice(2, 10);
      db.prepare('INSERT INTO jobs (id,user_id,type,status,prompt) VALUES (?,?,?,?,?)').run(id, userId, 'image', 'queued', args.prompt);
      // fire-and-forget; the AI Image Studio has the full flow
      (async () => {
        try {
          const sd = await import('./images.js');
          const imgs = await sd.txt2img({ prompt: args.prompt });
          for (const b of imgs) {
            const { filename } = sd.saveGenerated(userId, b);
            const gid = 'g_' + Math.random().toString(36).slice(2, 8);
            db.prepare('INSERT INTO generated_images (id,user_id,prompt,filename,width,height,workflow) VALUES (?,?,?,?,?,?,?)').run(gid, userId, args.prompt, filename, 832, 1216, 'assistant');
          }
          db.prepare("UPDATE jobs SET status='done', finished_at=datetime('now') WHERE id=?").run(id);
        } catch { db.prepare("UPDATE jobs SET status='error' WHERE id=?").run(id); }
      })();
      return { status: 'started', note: 'Image is generating — it will appear in AI Image Studio in ~20s.' };
    }
    default:
      return { error: 'unknown tool' };
  }
}
