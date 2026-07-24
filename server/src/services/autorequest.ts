import { db, audit, notify } from '../lib/db.js';
import * as jf from './jellyfin.js';
import * as jellyseerr from './jellyseerr.js';
import { mediaRequestAuditRecord } from './request-ownership.js';
import * as lidarr from './lidarr.js';
import * as ai from './ai.js';
import { aiDecision } from './policy.js';
import { findUserById, rowToUser } from '../lib/auth.js';

type Profile = {
  topArtists: string[];
  topGenres: string[];
  likedTitles: string[];
  hasVideo: boolean;
  hasMusic: boolean;
  noHistory?: boolean;
};

type AutoMovie = { tmdbId: number; mediaType: 'movie' | 'tv'; title: string; year?: string; posterUrl?: string; why: string };
type AutoArtist = { name: string; why: string };
type Suggestions = { movies: AutoMovie[]; tv: AutoMovie[]; artists: AutoArtist[]; reason?: string; profile?: Pick<Profile, 'topGenres' | 'topArtists'> };
type LibraryIndex = { movieTitles: Set<string>; seriesTitles: Set<string>; requested: Set<string>; artists: Set<string> };

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const uniq = (arr: string[]) => Array.from(new Set(arr.map(s => s.trim()).filter(Boolean)));
const titleMatches = (a: string, b: string) => {
  const na = norm(a);
  const nb = norm(b);
  return !!na && !!nb && (na === nb || na.includes(nb) || nb.includes(na));
};
const setMatches = (set: Set<string>, title: string) => {
  const n = norm(title);
  if (!n) return false;
  if (set.has(n)) return true;
  for (const existing of set) if (existing && (existing.includes(n) || n.includes(existing))) return true;
  return false;
};

export async function profile(userId: number): Promise<Profile> {
  const music = db.prepare(`
    SELECT subtitle artist, SUM(seconds) s
    FROM play_history
    WHERE user_id=? AND kind='music' AND subtitle IS NOT NULL
    GROUP BY subtitle
    ORDER BY s DESC
    LIMIT 12
  `).all(userId) as any[];

  const video = db.prepare(`
    SELECT item_id itemId,title,subtitle,kind,SUM(seconds) s
    FROM play_history
    WHERE user_id=? AND kind IN ('movie','episode','video')
    GROUP BY item_id
    ORDER BY s DESC
    LIMIT 15
  `).all(userId) as any[];

  const genres = new Map<string, number>();
  await Promise.all(video.map(async row => {
    try {
      const detail = await jf.itemDetail(String(row.itemId));
      for (const g of detail.genres || []) genres.set(g, (genres.get(g) || 0) + Number(row.s || 0));
    } catch { /* best-effort */ }
  }));

  const likedTitles = uniq(video.map(row => String(row.kind) === 'episode' && row.subtitle ? String(row.subtitle) : String(row.title || ''))).slice(0, 15);
  const topArtists = uniq(music.map(row => String(row.artist || ''))).slice(0, 12);
  const topGenres = [...genres.entries()].sort((a, b) => b[1] - a[1]).map(([g]) => g).slice(0, 12);
  return {
    topArtists,
    topGenres,
    likedTitles,
    hasVideo: likedTitles.length > 0,
    hasMusic: topArtists.length > 0,
    noHistory: topArtists.length === 0 && likedTitles.length === 0,
  };
}

let indexCache: { at: number; value: LibraryIndex } | null = null;
export async function libraryIndex(): Promise<LibraryIndex> {
  if (indexCache && Date.now() - indexCache.at < 10 * 60_000) return indexCache.value;
  const [movies, series, reqs, artists] = await Promise.all([
    jf.configured() ? jf.listByType('Movie', { Limit: 10000 }).catch(() => []) : Promise.resolve([]),
    jf.configured() ? jf.listByType('Series', { Limit: 10000 }).catch(() => []) : Promise.resolve([]),
    jellyseerr.configured() ? jellyseerr.listRequests().catch(() => []) : Promise.resolve([]),
    lidarr.configured() ? lidarr.listArtistNames().catch(() => []) : Promise.resolve([]),
  ]);
  const value = {
    movieTitles: new Set(movies.map(m => norm(m.name)).filter(Boolean)),
    seriesTitles: new Set(series.map(s => norm(s.name)).filter(Boolean)),
    requested: new Set(reqs.map((r: any) => norm(String(r.title || ''))).filter(Boolean)),
    artists: new Set(artists.map(norm).filter(Boolean)),
  };
  indexCache = { at: Date.now(), value };
  return value;
}

function stripJson(raw: string): string {
  return raw.trim().replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
}

async function ask(profile: Profile, idx: LibraryIndex, provider: 'local' | 'external'): Promise<any | null> {
  const exclude = [
    ...[...idx.movieTitles].slice(0, 20),
    ...[...idx.seriesTitles].slice(0, 20),
    ...[...idx.requested].slice(0, 20),
    ...[...idx.artists].slice(0, 20),
  ].slice(0, 60);
  const prompt = [
    `Liked titles: ${profile.likedTitles.join(', ') || 'none'}`,
    `Top video genres: ${profile.topGenres.join(', ') || 'none'}`,
    `Top music artists: ${profile.topArtists.join(', ') || 'none'}`,
    `Exclude these already-owned/requested titles and artists: ${exclude.join(', ') || 'none'}`,
    'Suggest about 6 movies, 6 TV shows, and 6 music artists.',
    'Return JSON exactly as {"movies":[{"title":"...","year":"YYYY","why":"..."}],"tv":[{"title":"...","year":"YYYY","why":"..."}],"artists":[{"name":"...","why":"..."}]}.',
    'Only use specific, well-known real titles/artists. Do not include audiobooks or podcasts.',
  ].join('\n');
  for (let i = 0; i < 2; i++) {
    try {
      const raw = await ai.instruct('You are a media recommender. Given a person\'s taste, suggest specific real titles they\'d likely enjoy. Return ONLY compact JSON.', prompt, 0.7, { provider });
      return JSON.parse(stripJson(raw));
    } catch { /* retry once */ }
  }
  return null;
}

function avoidedMedia(result: any, idx: LibraryIndex): boolean {
  const title = String(result.title || '');
  return !norm(title)
    || setMatches(idx.requested, title)
    || (result.mediaType === 'movie' ? setMatches(idx.movieTitles, title) : setMatches(idx.seriesTitles, title));
}

async function validateMedia(items: any[], mediaType: 'movie' | 'tv', idx: LibraryIndex): Promise<AutoMovie[]> {
  if (!jellyseerr.configured()) return [];
  const out: AutoMovie[] = [];
  for (const item of (Array.isArray(items) ? items : []).slice(0, 8)) {
    const title = String(item?.title || '').trim();
    if (!title) continue;
    try {
      const results = (await jellyseerr.search(title)).filter((r: any) => r.mediaType === mediaType && titleMatches(r.title, title));
      const year = String(item?.year || '');
      const picked = results.find((r: any) => year && String(r.year || '') === year) || results[0];
      if (!picked || picked.status >= 1 || avoidedMedia(picked, idx)) continue;
      out.push({
        tmdbId: Number(picked.tmdbId),
        mediaType,
        title: picked.title,
        year: picked.year,
        posterUrl: picked.posterUrl,
        why: String(item?.why || 'Matches your recent taste.').slice(0, 240),
      });
    } catch { /* drop bad suggestion */ }
  }
  return out;
}

function validateArtists(items: any[], idx: LibraryIndex): AutoArtist[] {
  if (!lidarr.configured()) return [];
  const seen = new Set<string>();
  const out: AutoArtist[] = [];
  for (const item of (Array.isArray(items) ? items : []).slice(0, 8)) {
    const name = String(item?.name || '').trim();
    const n = norm(name);
    if (!name || !n || seen.has(n) || idx.artists.has(n)) continue;
    seen.add(n);
    out.push({ name, why: String(item?.why || 'Matches your recent listening.').slice(0, 240) });
  }
  return out;
}

const suggestionCache = new Map<number, { at: number; value: Suggestions }>();
export async function suggest(userId: number): Promise<Suggestions> {
  const cached = suggestionCache.get(userId);
  if (cached && Date.now() - cached.at < 15 * 60_000) return cached.value;
  const prof = await profile(userId);
  if (prof.noHistory) return { movies: [], tv: [], artists: [], reason: 'no history yet' };
  const row = findUserById(userId);
  if (!row) return { movies: [], tv: [], artists: [], reason: 'user unavailable' };
  let provider: 'local' | 'external';
  try { provider = aiDecision(rowToUser(row)).provider; }
  catch { return { movies: [], tv: [], artists: [], reason: 'ai disabled', profile: { topGenres: prof.topGenres, topArtists: prof.topArtists } }; }
  if (!(await ai.available({ provider }).catch(() => false))) return { movies: [], tv: [], artists: [], reason: 'ai unavailable', profile: { topGenres: prof.topGenres, topArtists: prof.topArtists } };
  const idx = await libraryIndex();
  const raw = await ask(prof, idx, provider);
  if (!raw) return { movies: [], tv: [], artists: [], profile: { topGenres: prof.topGenres, topArtists: prof.topArtists } };
  const [movies, tv] = await Promise.all([
    validateMedia(raw.movies, 'movie', idx),
    validateMedia(raw.tv, 'tv', idx),
  ]);
  const value = { movies, tv, artists: validateArtists(raw.artists, idx), profile: { topGenres: prof.topGenres, topArtists: prof.topArtists } };
  suggestionCache.set(userId, { at: Date.now(), value });
  return value;
}

export function countThisWeek(userId: number): number {
  const row = db.prepare("SELECT COUNT(*) c FROM audit WHERE user_id=? AND action='auto_requested' AND ts >= datetime('now','-7 days')").get(userId) as any;
  return Number(row?.c || 0);
}

function ranked(s: Suggestions, prof: Profile): ({ kind: 'movie' | 'tv' | 'artist'; title: string; why: string; item: AutoMovie | AutoArtist }[]) {
  const media = [...s.movies.map(item => ({ kind: 'movie' as const, title: item.title, why: item.why, item })), ...s.tv.map(item => ({ kind: 'tv' as const, title: item.title, why: item.why, item }))];
  const artists = s.artists.map(item => ({ kind: 'artist' as const, title: item.name, why: item.why, item }));
  if (prof.hasMusic && !prof.hasVideo) return [...artists, ...media];
  if (prof.hasVideo && !prof.hasMusic) return [...media, ...artists];
  const out: ({ kind: 'movie' | 'tv' | 'artist'; title: string; why: string; item: AutoMovie | AutoArtist })[] = [];
  for (let i = 0; i < Math.max(media.length, artists.length); i++) {
    if (media[i]) out.push(media[i]);
    if (artists[i]) out.push(artists[i]);
  }
  return out;
}

export async function runFor(userId: number, _opts: { manual?: boolean } = {}): Promise<any> {
  try {
    if (countThisWeek(userId) >= 3) return { capped: true };
    const prof = await profile(userId);
    if (prof.noHistory) return { noHistory: true };
    const s = await suggest(userId);
    const user = db.prepare('SELECT username FROM users WHERE id=? AND disabled_at IS NULL').get(userId) as any;
    if (!user) return { none: true };
    for (const c of ranked(s, prof)) {
      try {
        let auditTarget = c.title;
        let requestOwnership: Record<string, unknown> = {};
        if (c.kind === 'artist') {
          const res = await lidarr.requestArtistByName(c.title);
          if (!res.ok || res.already) continue;
        } else {
          const item = c.item as AutoMovie;
          const result = await jellyseerr.requestMedia(item.mediaType, item.tmdbId);
          const record = mediaRequestAuditRecord({ mediaType: item.mediaType, mediaId: item.tmdbId }, result);
          auditTarget = record.target;
          requestOwnership = record.meta;
        }
        audit(userId, user?.username || 'system', 'auto_requested', auditTarget, undefined,
          { kind: c.kind, title: c.title, why: c.why, ...requestOwnership });
        notify(userId, 'Added something you might like', `${c.title} — ${c.why}`, 'success', '/requests');
        suggestionCache.delete(userId);
        indexCache = null;
        return { requested: { kind: c.kind, title: c.title, why: c.why } };
      } catch { /* try next candidate */ }
    }
    return { none: true };
  } catch {
    return { none: true };
  }
}
