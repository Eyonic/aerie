// Jellyseerr client — search + request movies/TV. Optional integration:
// unset JELLYSEERR_URL/JELLYSEERR_API_KEY simply disables the Requests page.
import { config } from '../config.js';

const base = () => config.jellyseerr.url.replace(/\/$/, '');
const key = () => config.jellyseerr.apiKey;

export function configured(): boolean { return !!base() && !!key(); }

async function js(path: string, opts: RequestInit = {}): Promise<any> {
  const res = await fetch(base() + path, {
    ...opts,
    headers: { 'X-Api-Key': key(), 'Content-Type': 'application/json', ...(opts.headers || {}) },
    signal: AbortSignal.timeout(12000),
  });
  if (!res.ok) throw new Error(`jellyseerr ${res.status} ${path}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

function posterUrl(p?: string, width = 480): string | undefined {
  return p ? `/api/requests/image?p=${encodeURIComponent(p)}&w=${width}` : undefined;
}

export async function status(): Promise<boolean> {
  try { await js('/api/v1/status'); return true; } catch { return false; }
}

export async function search(query: string): Promise<any[]> {
  if (!query.trim()) return [];
  const data = await js(`/api/v1/search?query=${encodeURIComponent(query)}&page=1`);
  return (data.results || [])
    .filter((r: any) => r.mediaType === 'movie' || r.mediaType === 'tv')
    .map((r: any) => ({
      id: r.id,
      tmdbId: r.id,
      mediaType: r.mediaType,
      title: r.title || r.name,
      overview: r.overview,
      year: (r.releaseDate || r.firstAirDate || '').slice(0, 4),
      posterUrl: posterUrl(r.posterPath, 480),
      backdropUrl: posterUrl(r.backdropPath, 1280),
      rating: r.voteAverage,
      status: r.mediaInfo?.status,        // 0 unknown,1 pending,2 processing,3 partial,4 partially avail,5 available
    }));
}

export async function trending(): Promise<any[]> {
  try {
    const data = await js('/api/v1/discover/trending?page=1');
    return (data.results || [])
      .filter((r: any) => r.mediaType === 'movie' || r.mediaType === 'tv')
      .map((r: any) => ({
        id: r.id, tmdbId: r.id, mediaType: r.mediaType, title: r.title || r.name,
        overview: r.overview, year: (r.releaseDate || r.firstAirDate || '').slice(0, 4),
        posterUrl: posterUrl(r.posterPath, 480), backdropUrl: posterUrl(r.backdropPath, 1280),
        rating: r.voteAverage, status: r.mediaInfo?.status,
      }));
  } catch { return []; }
}

export async function requestMedia(mediaType: 'movie' | 'tv', mediaId: number, seasons?: string): Promise<any> {
  const body: any = { mediaType, mediaId };
  if (mediaType === 'tv') body.seasons = seasons === undefined ? 'all' : seasons;
  return js('/api/v1/request', { method: 'POST', body: JSON.stringify(body) });
}

// Jellyseerr's request records store only a tmdbId, not the title/poster — fetch
// the TMDB detail (cached) so "My requests" shows real titles + posters.
const detailCache = new Map<string, { title?: string; posterPath?: string }>();
async function tmdbDetail(mediaType: string, tmdbId: number): Promise<{ title?: string; posterPath?: string }> {
  const k = `${mediaType}:${tmdbId}`;
  if (detailCache.has(k)) return detailCache.get(k)!;
  try {
    const d = await js(`/api/v1/${mediaType === 'tv' ? 'tv' : 'movie'}/${tmdbId}`);
    const info = { title: d.title || d.name, posterPath: d.posterPath };
    detailCache.set(k, info);
    return info;
  } catch { return {}; }
}

export async function listRequests(): Promise<any[]> {
  const data = await js('/api/v1/request?take=40&sort=added');
  return Promise.all((data.results || []).map(async (r: any) => {
    let title = r.media?.title || r.media?.name;
    let posterPath = r.media?.posterPath;
    const tmdbId = r.media?.tmdbId;
    const mediaType = r.type || r.media?.mediaType;
    if ((!title || !posterPath) && tmdbId) {
      const d = await tmdbDetail(mediaType, tmdbId);
      title = title || d.title;
      posterPath = posterPath || d.posterPath;
    }
    return {
      id: r.id,
      status: r.status,        // 1 pending approval, 2 approved, 3 declined
      mediaType,
      title: title || `${mediaType === 'tv' ? 'TV' : 'Movie'} request`,
      tmdbId,
      posterUrl: posterUrl(posterPath),
      mediaStatus: r.media?.status,
      requestedBy: r.requestedBy?.displayName,
      createdAt: r.createdAt,
    };
  }));
}

// Artist art hosts Lidarr hands out — anything else absolute is refused so the
// proxy can't be aimed at the LAN or arbitrary internet hosts.
const IMAGE_HOSTS = ['lidarr.audio', 'fanart.tv', 'coverartarchive.org', 'dzcdn.net'];

export async function imageProxy(p: string, width = 480): Promise<{ buf: Buffer; type: string } | null> {
  // TMDB images (relative paths) and allowlisted artist-art URLs are public;
  // proxy them same-origin so browsers never hotlink external hosts.
  try {
    let url: string;
    if (/^https?:\/\//i.test(p)) {
      const u = new URL(p);
      if (!IMAGE_HOSTS.some(h => u.hostname === h || u.hostname.endsWith(`.${h}`))) return null;
      url = u.toString();
    } else {
      const clean = p.startsWith('/') ? p : `/${p}`;
      const tmdbSize = width <= 320 ? 'w342' : width <= 480 ? 'w500' : width <= 960 ? 'w780' : 'w1280';
      url = `https://image.tmdb.org/t/p/${tmdbSize}${clean}`;
    }
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) return null;
    return { buf: Buffer.from(await res.arrayBuffer()), type: res.headers.get('content-type') || 'image/jpeg' };
  } catch { return null; }
}
