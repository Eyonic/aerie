// Lidarr client (:8686) — music requests. Jellyseerr can't do music, so Aerie
// talks to Lidarr directly: search artists (MusicBrainz lookup) and add them
// (monitored + search), which makes Lidarr grab their discography.
import { config } from '../config.js';
import { OutboundHttpError, outboundJson, outboundText } from './outbound-http.js';
const base = () => config.lidarr.url.replace(/\/$/, '');
const key = () => config.lidarr.apiKey;

export function configured(): boolean { return !!base() && !!key(); }

class LidarrApiError extends Error {
  constructor(status: number, path: string, readonly duplicate: boolean) {
    super(`lidarr ${status} ${path}`);
    this.name = 'LidarrApiError';
  }
}

async function ld(path: string, opts: RequestInit = {}): Promise<any> {
  const res = await outboundText(`${base()}/api/v1${path}`, {
    ...opts,
    headers: { 'X-Api-Key': key(), 'Content-Type': 'application/json', ...(opts.headers || {}) },
    timeoutMs: 15_000,
    maxBytes: 8 * 1024 * 1024,
    requireOk: false,
  });
  if (res.status < 200 || res.status >= 300) {
    throw new LidarrApiError(res.status, path, /already been added|already exists/i.test(res.body.slice(0, 200)));
  }
  if (res.status !== 200 || !res.body.trim()) return {};
  try { return JSON.parse(res.body); }
  catch { throw new OutboundHttpError('invalid_json'); }
}

export async function status(): Promise<boolean> {
  try { await ld('/system/status'); return true; } catch { return false; }
}

// Artist art lives on third-party hosts (fanart.tv / coverartarchive / lidarr's image
// cache). Serve it through our own image proxy so browsers never hotlink external hosts;
// relative Lidarr-cache paths can't be proxied without auth, so treat them as missing.
function pickImage(images: any[] = [], prefer = 'poster'): string | undefined {
  const byType = images.find(i => i.coverType === prefer) || images.find(i => i.coverType === 'cover') || images[0];
  const raw = byType?.remoteUrl || byType?.url;
  if (!raw || !/^https?:\/\//i.test(raw)) return undefined;
  return `/api/requests/image?p=${encodeURIComponent(raw)}`;
}

export interface MusicResult {
  foreignArtistId: string;
  name: string;
  type?: string;
  disambiguation?: string;
  overview?: string;
  posterUrl?: string;
  genres?: string[];
  status: 'available' | 'requested' | 'none';
}

// Search artists by name. Marks any already in the library as 'requested', or
// 'available' once Lidarr has actually downloaded some of their tracks.
export async function searchArtists(term: string): Promise<MusicResult[]> {
  if (!term.trim()) return [];
  const [results, existing] = await Promise.all([
    ld(`/artist/lookup?term=${encodeURIComponent(term)}`),
    existingIds(),
  ]);
  return (results || []).slice(0, 20).map((a: any): MusicResult => ({
    foreignArtistId: a.foreignArtistId,
    name: a.artistName,
    type: a.artistType,
    disambiguation: a.disambiguation,
    overview: a.overview,
    posterUrl: pickImage(a.images),
    genres: a.genres,
    status: existing.has(a.foreignArtistId)
      ? (existing.get(a.foreignArtistId) ? 'available' : 'requested')
      : 'none',
  }));
}

// Artists already added to Lidarr, MBID → "has downloaded tracks" (so the UI can
// show "In library" vs "Requested").
async function existingIds(): Promise<Map<string, boolean>> {
  try {
    const list = await ld('/artist');
    return new Map((list || []).map((a: any) => [a.foreignArtistId, (a.statistics?.trackFileCount || 0) > 0]));
  } catch { return new Map(); }
}

// Trending artists via Deezer's public chart (no API key) so music mode gets a
// "Trending now" rail like movies. Chart entries carry no MBID — 24 MusicBrainz
// lookups per load would be far too slow — so library status is matched by
// normalized name and the MBID is resolved lazily at request time. Cached 6h.
let trendCache: { at: number; items: Omit<MusicResult, 'status'>[] } | null = null;
const normName = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

export async function trendingArtists(): Promise<MusicResult[]> {
  let base = trendCache && Date.now() - trendCache.at < 6 * 3600_000 ? trendCache.items : null;
  if (!base) {
    const res = await outboundJson<any>('https://api.deezer.com/chart/0/artists?limit=24', {
      timeoutMs: 10_000, maxBytes: 2 * 1024 * 1024,
    });
    const data = res.body;
    base = (((data?.data as any[]) || []))
      .filter((d: any) => d?.name)
      .map((d: any) => {
        const pic = d.picture_big || d.picture_medium || d.picture;
        return {
          foreignArtistId: '', // resolved at request time via requestArtistByName
          name: d.name,
          posterUrl: pic && /^https?:\/\//i.test(pic) ? `/api/requests/image?p=${encodeURIComponent(pic)}` : undefined,
        };
      });
    if (base.length) trendCache = { at: Date.now(), items: base };
  }
  // Only the Deezer chart is cached; library status is merged live on every call —
  // a status baked into the 6h cache would show Request buttons for added artists.
  let byName = new Map<string, boolean>();
  try {
    const lib = await ld('/artist');
    byName = new Map((lib || []).map((a: any) => [normName(a.artistName), (a.statistics?.trackFileCount || 0) > 0]));
  } catch { /* library unreachable — statuses degrade to 'none' for this response */ }
  return base.map((it): MusicResult => {
    const n = normName(it.name);
    return { ...it, status: byName.has(n) ? (byName.get(n) ? 'available' : 'requested') : 'none' };
  });
}

// Live library detail per MBID, for the music "My requests" rail. Deliberately
// throws on a Lidarr outage: an empty map would make every request read as
// "Removed", while a 500 lets the frontend keep its last-known statuses.
export async function artistStatuses(): Promise<Map<string, { name: string; posterUrl?: string; status: 'requested' | 'downloading' | 'available'; percent: number }>> {
  const list = await ld('/artist');
  return new Map((list || []).map((a: any) => {
    const files = a.statistics?.trackFileCount || 0;
    const percent = Math.round(a.statistics?.percentOfTracks ?? (files > 0 ? 100 : 0));
    const status = files > 0 ? (percent >= 100 ? 'available' : 'downloading') : 'requested';
    return [a.foreignArtistId, { name: a.artistName, posterUrl: pickImage(a.images), status, percent }];
  }));
}

export async function listArtistNames(): Promise<string[]> {
  const list = await ld('/artist');
  return (list || []).map((a: any) => a.artistName).filter(Boolean);
}

// Add an artist to Lidarr (monitored + search its discography) = "request music".
export async function requestArtist(foreignArtistId: string): Promise<{ ok: boolean; name?: string; already?: boolean; foreignArtistId?: string }> {
  // Already added? Answer with the name so the audit row stays meaningful.
  const lib = await ld('/artist').catch(() => []);
  const hit = (lib || []).find((a: any) => a.foreignArtistId === foreignArtistId);
  if (hit) return { ok: true, already: true, name: hit.artistName, foreignArtistId };
  // Re-look-up the full artist object by MBID (Lidarr's `lidarr:` term prefix).
  const found = await ld(`/artist/lookup?term=${encodeURIComponent('lidarr:' + foreignArtistId)}`);
  const artist = (found || []).find((a: any) => a.foreignArtistId === foreignArtistId) || found?.[0];
  if (!artist) throw new Error('artist not found');
  return addArtist(artist);
}

// "Request" from the trending rail: no MBID on chart entries, so add Lidarr's top
// lookup match for the name.
export async function requestArtistByName(name: string): Promise<{ ok: boolean; name?: string; already?: boolean; foreignArtistId?: string }> {
  if (!name.trim()) throw new Error('artist not found');
  const found = await ld(`/artist/lookup?term=${encodeURIComponent(name)}`);
  // The lookup is fuzzy — prefer an exact (normalized) name match over the top
  // hit so short chart names can't silently add the wrong artist's discography.
  const n = normName(name);
  const artist = (found || []).find((a: any) => normName(a.artistName || '') === n) || (found || [])[0];
  if (!artist) throw new Error('artist not found');
  if ((await existingIds()).has(artist.foreignArtistId)) return { ok: true, already: true, name: artist.artistName, foreignArtistId: artist.foreignArtistId };
  return addArtist(artist);
}

async function addArtist(artist: any): Promise<{ ok: boolean; name?: string; already?: boolean; foreignArtistId?: string }> {
  const roots = await ld('/rootfolder');
  const root = (roots || [])[0];
  if (!root) throw new Error('no root folder configured in Lidarr');
  const payload = {
    ...artist,
    qualityProfileId: root.defaultQualityProfileId || 1,
    metadataProfileId: root.defaultMetadataProfileId || 1,
    rootFolderPath: root.path,
    monitored: true,
    monitorNewItems: 'all',
    addOptions: { monitor: root.defaultMonitorOption || 'all', searchForMissingAlbums: true },
  };
  // The callers' pre-checks race (and existingIds() degrades to empty on a Lidarr
  // timeout), so treat Lidarr's duplicate-add 400 as idempotent success.
  try {
    const added = await ld('/artist', { method: 'POST', body: JSON.stringify(payload) });
    return { ok: true, name: added?.artistName || artist.artistName, foreignArtistId: artist.foreignArtistId };
  } catch (e: any) {
    if (e?.duplicate === true || /already been added|already exists/i.test(String(e?.message))) {
      return { ok: true, already: true, name: artist.artistName, foreignArtistId: artist.foreignArtistId };
    }
    throw e;
  }
}
