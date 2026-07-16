// Audiobookshelf client — powers Audiobooks and Podcasts sections.
import { config } from '../config.js';
import type { Book, Chapter } from '../lib/model.js';

const base = config.audiobookshelf.url.replace(/\/$/, '');
const key = () => config.audiobookshelf.apiKey;

export function configured(): boolean { return !!key(); }

async function abs(path: string, params: Record<string, any> = {}): Promise<any> {
  const url = new URL(base + path);
  for (const [k, v] of Object.entries(params)) if (v != null) url.searchParams.set(k, String(v));
  const res = await fetch(url, { headers: { Authorization: `Bearer ${key()}` } });
  if (!res.ok) throw new Error(`abs ${res.status} ${path}`);
  return res.json();
}

export function coverUrl(itemId: string): string {
  return `/api/books/cover/${itemId}?w=480`;
}
export function directCoverUrl(itemId: string): string {
  return `${base}/api/items/${itemId}/cover?token=${key()}`;
}

export async function libraries(): Promise<{ id: string; name: string; mediaType: string }[]> {
  const data = await abs('/api/libraries');
  return (data.libraries || []).map((l: any) => ({ id: l.id, name: l.name, mediaType: l.mediaType }));
}

// Per-user listening progress lives in /api/me (mediaProgress[]), NOT on the
// library-items response — reading it inline always yields 0%. Fetch it once and
// merge by libraryItemId so "Continue listening" and resume actually work.
export async function progressMap(): Promise<Map<string, { progress: number; currentTime: number }>> {
  const map = new Map<string, { progress: number; currentTime: number }>();
  try {
    const me = await abs('/api/me');
    for (const p of me.mediaProgress || []) {
      if (p.libraryItemId) map.set(p.libraryItemId, { progress: p.progress || 0, currentTime: p.currentTime || 0 });
    }
  } catch { /* best-effort */ }
  return map;
}

function mapItem(it: any, progMap?: Map<string, { progress: number; currentTime: number }>): Book {
  const media = it.media || {};
  const meta = media.metadata || {};
  const prog = progMap?.get(it.id) || it.userMediaProgress || it.progress;
  return {
    id: it.id,
    libraryItemId: it.id,
    title: meta.title || it.title || 'Untitled',
    author: meta.authorName || (meta.authors?.map((a: any) => a.name).join(', ')),
    narrator: meta.narratorName,
    series: meta.seriesName || meta.series?.[0]?.name,
    coverUrl: coverUrl(it.id),
    durationSec: media.duration,
    numChapters: media.numChapters || media.chapters?.length,
    progressPct: prog ? Math.round((prog.progress || 0) * 100) : 0,
    currentTimeSec: prog?.currentTime,
    mediaType: it.mediaType || media.metadata?.type === 'podcast' ? 'podcast' : 'book',
  };
}

export async function listLibraryItems(libraryId: string): Promise<Book[]> {
  const pageSize = 200;
  const items: any[] = [];
  let page = 0;

  // Audiobookshelf paginates this endpoint. Fetch every page instead of
  // silently treating the first 200 results as the complete library.
  while (true) {
    const data = await abs(`/api/libraries/${libraryId}/items`, {
      limit: pageSize,
      page,
      sort: 'media.metadata.title',
    });
    const results = Array.isArray(data.results) ? data.results : [];
    items.push(...results);

    const total = Number(data.total);
    if (results.length === 0
      || (Number.isFinite(total) && items.length >= total)
      || results.length < pageSize) break;
    page++;
  }

  const progs = await progressMap();
  return items.map((it: any) => mapItem(it, progs));
}

const libraryCache = new Map<'book' | 'podcast', { expires: number; items: Book[] }>();

export async function allBooks(mediaType: 'book' | 'podcast'): Promise<Book[]> {
  const cached = libraryCache.get(mediaType);
  if (cached && cached.expires > Date.now()) return cached.items;
  const libs = await libraries();
  const target = libs.filter(l => l.mediaType === mediaType);
  const out: Book[] = [];
  for (const l of target) {
    try { out.push(...await listLibraryItems(l.id)); } catch { /* skip */ }
  }
  libraryCache.set(mediaType, { expires: Date.now() + 60_000, items: out });
  return out;
}

export async function itemDetail(id: string): Promise<Book & { chapters: Chapter[]; tracks?: any[]; overview?: string }> {
  const it = await abs(`/api/items/${id}`, { expanded: 1 });
  const book = mapItem(it);
  const chapters: Chapter[] = (it.media?.chapters || []).map((c: any) => ({
    id: c.id, title: c.title, start: c.start, end: c.end,
  }));
  return { ...book, chapters, overview: it.media?.metadata?.description };
}

// One playable track per audio file (audiobooks can be multi-file — one MP3 per
// chapter — and even single-file books must be streamed per-FILE, because the
// item-level /download zips the whole folder when it contains cover/metadata).
export async function getAudioTracks(id: string): Promise<{ ino: string; index: number; title: string; durationSec: number; mimeType: string }[]> {
  const it = await abs(`/api/items/${id}`, { expanded: 1 });
  const files = it.media?.audioFiles || [];
  return files
    .filter((f: any) => !f.exclude && f.ino)
    .sort((a: any, b: any) => (a.index || 0) - (b.index || 0))
    .map((f: any) => ({
      ino: String(f.ino),
      index: f.index,
      title: f.metadata?.filename?.replace(/\.[^.]+$/, '') || `Part ${f.index}`,
      durationSec: f.duration || 0,
      mimeType: f.mimeType || 'audio/mpeg',
    }));
}

export function directFileUrl(id: string, ino: string): string {
  return `${base}/api/items/${id}/file/${ino}/download?token=${key()}`;
}

export function streamUrl(id: string): string {
  return `/api/books/stream/${id}`;
}
export function fileStreamUrl(id: string, ino: string): string {
  return `/api/books/file/${id}/${ino}`;
}
export function directPlayUrl(id: string): string {
  return `${base}/api/items/${id}/play?token=${key()}`;
}

export async function updateProgress(id: string, currentTime: number, duration: number) {
  try {
    await fetch(`${base}/api/me/progress/${id}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${key()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ currentTime, duration, progress: duration ? currentTime / duration : 0 }),
    });
  } catch { /* best-effort */ }
}

export { base as absBase, key as absKey };
