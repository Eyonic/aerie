// Agentic AI tools — lets the local assistant actually DO things (not just chat):
// search files, find the largest/recent files, summarize documents, look at the
// media library, build playlists, generate images, etc. Executed server-side and
// fed back to the Ollama tool-calling loop.
import fsp from 'node:fs/promises';
import * as storage from './storage.js';
import * as jf from './jellyfin.js';
import * as abs from './audiobookshelf.js';
import * as progress from './progress.js';
import * as ai from './ai.js';
import * as writes from './storage-write.js';
import { ensureFileCatalog, fileCatalogUsage, listFileCatalog, searchFileCatalog } from './file-catalog.js';
import { db } from '../lib/db.js';
import type { User } from '../lib/model.js';
import { enqueueImageJob } from './image-jobs.js';
import {
  assertContentFeature, contentFeatureEnabled, jellyfinFeatureForType, type ContentFeature,
} from './content-access.js';

export interface Ctx { username: string; userId: number; user?: User; }

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

const FILE_TOOLS = new Set(['search_files', 'largest_files', 'recent_files', 'storage_usage', 'read_document']);
const MEDIA_KINDS: Record<string, ContentFeature> = {
  movies: 'movies', series: 'tv', albums: 'music', songs: 'music', audiobooks: 'audiobooks',
};

/** Only advertise tools and media-kind enum values the current member may use.
 *  execTool repeats the checks, so a forged tool call cannot bypass this UI/model hint. */
export function toolsForUser(user: User): any[] {
  const mediaKinds = Object.entries(MEDIA_KINDS).filter(([, feature]) => contentFeatureEnabled(user, feature)).map(([kind]) => kind);
  return TOOLS.flatMap<any>(tool => {
    const name = tool.function.name;
    if (FILE_TOOLS.has(name) && !contentFeatureEnabled(user, 'files')) return [];
    if (name === 'find_duplicate_photos' && !contentFeatureEnabled(user, 'photos')) return [];
    if (name === 'create_playlist' && !contentFeatureEnabled(user, 'music')) return [];
    if (name === 'continue_media' && !(['videos', 'movies', 'tv', 'audiobooks'] as ContentFeature[])
      .some(feature => contentFeatureEnabled(user, feature))) return [];
    if (name === 'list_media') {
      if (!mediaKinds.length) return [];
      return [{
        ...tool,
        function: {
          ...tool.function,
          parameters: {
            ...tool.function.parameters,
            properties: {
              ...tool.function.parameters.properties,
              kind: { ...tool.function.parameters.properties.kind, enum: mediaKinds },
            },
          },
        },
      }];
    }
    return [tool];
  });
}

async function safe<T>(p: Promise<T>, f: T): Promise<T> { try { return await p; } catch { return f; } }

function fmtBytes(b: number) { if (!b) return '0 B'; const u = ['B', 'KB', 'MB', 'GB', 'TB']; const i = Math.min(Math.floor(Math.log(b) / Math.log(1024)), u.length - 1); return `${(b / 1024 ** i).toFixed(1)} ${u[i]}`; }
function resultLimit(value: unknown, fallback = 10): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(50, Math.floor(parsed)) : fallback;
}

export async function execTool(name: string, args: any, ctx: Ctx): Promise<any> {
  const { username, userId } = ctx;
  const user = ctx.user;
  if (!user) throw Object.assign(new Error('unauthorized'), { status: 401 });
  const audiobooksEnabled = contentFeatureEnabled(user, 'audiobooks');
  switch (name) {
    case 'search_files': {
      assertContentFeature(user, 'files');
      const q = String(args.query || '').trim();
      await ensureFileCatalog({ id: userId, username });
      const hits = searchFileCatalog(userId, q, { limit: 25, includeFolders: false });
      return { count: hits.length, files: hits.map(f => ({ name: f.name, path: f.path, size: fmtBytes(f.size) })) };
    }
    case 'largest_files': {
      assertContentFeature(user, 'files');
      const limit = resultLimit(args.limit);
      await ensureFileCatalog({ id: userId, username });
      const files = listFileCatalog(userId, { includeFolders: false, sort: 'largest', limit });
      return { files: files.map(f => ({ name: f.name, path: f.path, size: fmtBytes(f.size) })) };
    }
    case 'recent_files': {
      assertContentFeature(user, 'files');
      const limit = resultLimit(args.limit);
      await ensureFileCatalog({ id: userId, username });
      const files = listFileCatalog(userId, { includeFolders: false, sort: 'recent', limit });
      return { files: files.map(f => ({ name: f.name, path: f.path, modified: new Date(f.mtimeMs).toISOString() })) };
    }
    case 'storage_usage': {
      assertContentFeature(user, 'files');
      await ensureFileCatalog({ id: userId, username });
      const u = fileCatalogUsage(userId);
      u.usedBytes = await safe(writes.chargedUsageBytes({ id: userId, username }), u.usedBytes);
      return { used: fmtBytes(u.usedBytes), files: u.fileCount, byType: Object.fromEntries(Object.entries(u.byKind).map(([k, v]: any) => [k, fmtBytes(v.bytes)])) };
    }
    case 'read_document': {
      assertContentFeature(user, 'files');
      try {
        const { real, stat } = await storage.statRealAsync(username, args.path);
        if (stat.size > 2_000_000) return { error: 'file too large' };
        const content = await fsp.readFile(real, 'utf8');
        return { path: args.path, content: content.slice(0, 12000) };
      } catch { return { error: 'could not read file' }; }
    }
    case 'find_duplicate_photos': {
      assertContentFeature(user, 'photos');
      const rows = db.prepare(`SELECT size,width,height,COUNT(*) count,GROUP_CONCAT(rel_path, char(10)) paths
        FROM photo_index
        WHERE user_id=? AND size > 0 AND width IS NOT NULL AND height IS NOT NULL
        GROUP BY size,width,height HAVING COUNT(*) > 1
        ORDER BY count DESC LIMIT 50`).all(userId) as any[];
      return {
        duplicateGroups: rows.length,
        totalDuplicates: rows.reduce((s, g) => s + Number(g.count || 0) - 1, 0),
        examples: rows.slice(0, 5).map(g => String(g.paths || '').split('\n')[0]).filter(Boolean),
      };
    }
    case 'list_media': {
      const limit = args.limit || 15;
      const required = MEDIA_KINDS[String(args.kind || '')];
      if (!required) return { items: [] };
      assertContentFeature(user, required);
      if (args.kind === 'movies') return { items: (await safe(jf.listByType('Movie', { Limit: limit, SortBy: 'DateCreated', SortOrder: 'Descending' }), [])).map((m: any) => ({ name: m.name, year: m.year })) };
      if (args.kind === 'series') return { items: (await safe(jf.listByType('Series', { Limit: limit }), [])).map((m: any) => ({ name: m.name, year: m.year })) };
      if (args.kind === 'albums') return { items: (await safe(jf.listByType('MusicAlbum', { Limit: limit }), [])).map((m: any) => ({ name: m.name, artist: m.albumArtist })) };
      if (args.kind === 'songs') return { items: (await safe(jf.listByType('Audio', { Limit: limit }), [])).map((m: any) => ({ name: m.name, album: m.album })) };
      if (args.kind === 'audiobooks') {
        if (!audiobooksEnabled) return { items: [] };
        return { items: (await safe(abs.allBooks('book'), [])).slice(0, limit).map((b: any) => ({ title: b.title, author: b.author })) };
      }
      return { items: [] };
    }
    case 'continue_media': {
      const videoEnabled = (['videos', 'movies', 'tv'] as ContentFeature[]).some(feature => contentFeatureEnabled(user, feature));
      const [vids, books] = await Promise.all([
        videoEnabled ? safe(Promise.all(progress.resume(userId, 'video', 24).map(async p => {
          const v = await jf.itemDetail(p.itemId);
          if (!contentFeatureEnabled(user, jellyfinFeatureForType(v.type))) return null;
          const dur = p.durationTicks || v.runtimeTicks || 0;
          return { ...v, positionTicks: p.positionTicks, progressPct: dur ? Math.round((p.positionTicks / dur) * 100) : v.progressPct };
        })), [] as any[]) : Promise.resolve([]),
        audiobooksEnabled ? safe(Promise.all(progress.resume(userId, 'audio', 8).map(async p => {
          const b = await abs.itemDetail(p.itemId);
          const dur = p.durationTicks || Math.round((b.durationSec || 0) * 1e7);
          return { ...b, currentTimeSec: p.positionTicks / 1e7, progressPct: dur ? Math.round((p.positionTicks / dur) * 100) : 0 };
        })), [] as any[]) : Promise.resolve([]),
      ]);
      return {
        // Carry id/type/series so the UI can deep-link episodes to /tv (not /movies) and
        // show real series context instead of a bare episode name ("Pilot").
        watching: vids.filter(Boolean).slice(0, 8).map((v: any) => ({
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
      assertContentFeature(user, 'music');
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
      const id = enqueueImageJob(user, args.prompt);
      return { id, status: 'queued', note: 'Image generation is queued. Progress appears in Jobs and the result will be saved to AI Image Studio.' };
    }
    default:
      return { error: 'unknown tool' };
  }
}
