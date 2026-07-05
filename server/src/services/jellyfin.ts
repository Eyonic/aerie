// Jellyfin client — powers Movies, TV, Music, Videos sections.
// Uses an API key (server-side). Streams are proxied through Aerie so the
// user never leaves the app or sees the Jellyfin origin.
import { config } from '../config.js';
import type { MediaItem } from '../lib/model.js';

const base = () => config.jellyfin.url.replace(/\/$/, '');
const key = () => config.jellyfin.apiKey;

function authHeaders() {
  return {
    'X-Emby-Token': key(),
    'Accept': 'application/json',
  };
}

export function configured(): boolean { return !!key(); }

async function jf(path: string, params: Record<string, any> = {}): Promise<any> {
  const url = new URL(base() + path);
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  const res = await fetch(url, { headers: authHeaders() });
  if (!res.ok) throw new Error(`jellyfin ${res.status} ${path}`);
  return res.json();
}

let cachedUserId: string | null = null;
export async function jellyUserId(): Promise<string> {
  if (cachedUserId) return cachedUserId;
  const users = await jf('/Users');
  cachedUserId = users?.[0]?.Id || '';
  return cachedUserId!;
}

export function imageUrl(id: string, type = 'Primary', tag?: string): string {
  const u = new URL(`${base()}/Items/${id}/Images/${type}`);
  u.searchParams.set('quality', '90');
  if (tag) u.searchParams.set('tag', tag);
  // proxied form for the browser:
  return `/api/media/image/${id}/${type}${tag ? `?tag=${tag}` : ''}`;
}

export function directImageUrl(id: string, type = 'Primary'): string {
  return `${base()}/Items/${id}/Images/${type}?api_key=${key()}`;
}

function mapItem(it: any): MediaItem {
  const ud = it.UserData || {};
  return {
    id: it.Id,
    type: it.Type,
    name: it.Name,
    overview: it.Overview,
    year: it.ProductionYear,
    posterUrl: it.ImageTags?.Primary ? imageUrl(it.Id, 'Primary', it.ImageTags.Primary) : undefined,
    backdropUrl: it.BackdropImageTags?.[0] ? imageUrl(it.Id, 'Backdrop', it.BackdropImageTags[0]) : undefined,
    thumbUrl: it.ImageTags?.Thumb ? imageUrl(it.Id, 'Thumb', it.ImageTags.Thumb) : undefined,
    runtimeTicks: it.RunTimeTicks,
    runtimeMinutes: it.RunTimeTicks ? Math.round(it.RunTimeTicks / 600000000) : undefined,
    progressPct: ud.PlayedPercentage,
    positionTicks: ud.PlaybackPositionTicks || 0,   // exact resume position (for seek-back)
    playedPct: ud.Played ? 100 : ud.PlayedPercentage,
    seriesName: it.SeriesName,
    seasonNumber: it.ParentIndexNumber,
    episodeNumber: it.IndexNumber,
    albumArtist: it.AlbumArtist,
    album: it.Album,
    genres: it.Genres,
    communityRating: it.CommunityRating,
  };
}

export async function listByType(includeItemTypes: string, params: Record<string, any> = {}): Promise<MediaItem[]> {
  const uid = await jellyUserId();
  const data = await jf(`/Users/${uid}/Items`, {
    IncludeItemTypes: includeItemTypes,
    Recursive: true,
    Fields: 'Overview,Genres,ProductionYear,RunTimeTicks',
    SortBy: params.SortBy || 'SortName',
    SortOrder: params.SortOrder || 'Ascending',
    Limit: params.Limit || 200,
    ...params,
  });
  return (data.Items || []).map(mapItem);
}

export async function resumeItems(mediaType: 'Video' | 'Audio'): Promise<MediaItem[]> {
  const uid = await jellyUserId();
  const data = await jf(`/Users/${uid}/Items/Resume`, {
    MediaTypes: mediaType,
    Limit: 20,
    Fields: 'Overview,ProductionYear,RunTimeTicks',
  });
  return (data.Items || []).map(mapItem);
}

export async function itemDetail(id: string): Promise<MediaItem & { children?: MediaItem[] }> {
  const uid = await jellyUserId();
  const it = await jf(`/Users/${uid}/Items/${id}`);
  const base = mapItem(it);
  return base;
}

export async function children(parentId: string): Promise<MediaItem[]> {
  const uid = await jellyUserId();
  const data = await jf(`/Users/${uid}/Items`, {
    ParentId: parentId, Fields: 'Overview,RunTimeTicks', SortBy: 'SortName',
  });
  return (data.Items || []).map(mapItem);
}

export function streamUrl(id: string, isAudio = false): string {
  // HLS master for video, direct for audio — both proxied.
  return `/api/media/stream/${id}${isAudio ? '?audio=1' : ''}`;
}

// Audio + subtitle tracks for a video (for the player's track pickers).
export async function mediaStreams(id: string): Promise<{ audio: any[]; subtitles: any[] }> {
  const uid = await jellyUserId();
  const it = await jf(`/Users/${uid}/Items/${id}`);
  const src = it.MediaSources?.[0];
  const streams = src?.MediaStreams || [];
  const audio = streams.filter((s: any) => s.Type === 'Audio').map((s: any) => ({
    index: s.Index, name: s.DisplayTitle || s.Language || `Audio ${s.Index}`, lang: s.Language, codec: s.Codec, default: s.IsDefault,
  }));
  const subtitles = streams.filter((s: any) => s.Type === 'Subtitle').map((s: any) => ({
    index: s.Index, name: s.DisplayTitle || s.Language || `Subtitle ${s.Index}`, lang: s.Language, codec: s.Codec, default: s.IsDefault,
    url: `/api/media/subtitle/${id}/${src?.Id || id}/${s.Index}`,
  }));
  return { audio, subtitles };
}

export function directSubtitleUrl(id: string, mediaSourceId: string, index: number): string {
  return `${base()}/Videos/${id}/${mediaSourceId}/Subtitles/${index}/0/Stream.vtt?api_key=${key()}`;
}

// Progressive MP4 for Google Cast (no CORS requirements, unlike HLS). Direct-play
// the original file when it's already Cast-compatible — that path supports Range
// requests so the TV can seek and resume; otherwise fall back to a live ffmpeg
// transcode, which is not seekable (no Content-Length/Range), so resume is done
// server-side via StartTimeTicks and the TV timeline starts at 0.
export async function castSource(id: string, startSec = 0): Promise<{ url: string; contentType: string; canSeek: boolean }> {
  try {
    const uid = await jellyUserId();
    const it = await jf(`/Users/${uid}/Items/${id}`);
    const src = it.MediaSources?.[0];
    const container = String(src?.Container || '').toLowerCase();
    const streams = src?.MediaStreams || [];
    const v = streams.find((s: any) => s.Type === 'Video');
    const a = streams.find((s: any) => s.Type === 'Audio');
    const direct = /(^|,)(mp4|mov|m4v)(,|$)/.test(container)
      && v && /h264|avc/i.test(v.Codec || '') && (v.Width || 0) <= 1920
      && a && /aac|mp3/i.test(a.Codec || '') && (a.Channels || 2) <= 6;
    if (direct) {
      return {
        url: `${base()}/Videos/${id}/stream.mp4?Static=true&api_key=${key()}&MediaSourceId=${src.Id}`,
        contentType: 'video/mp4',
        canSeek: true,
      };
    }
  } catch { /* fall through to the transcode URL */ }
  const st = startSec > 0 ? `&StartTimeTicks=${Math.round(startSec * 1e7)}` : '';
  return {
    url: `${base()}/Videos/${id}/stream.mp4?api_key=${key()}&VideoCodec=h264&AudioCodec=aac&MaxWidth=1920&MaxAudioChannels=2&VideoBitrate=12000000&AudioBitrate=192000${st}`,
    contentType: 'video/mp4',
    canSeek: false,
  };
}

export function directStreamUrl(id: string, isAudio: boolean): string {
  if (isAudio) {
    return `${base()}/Audio/${id}/universal?api_key=${key()}&UserId=&Container=mp3,aac,flac&AudioCodec=aac&TranscodingContainer=ts&TranscodingProtocol=hls&MaxStreamingBitrate=320000`;
  }
  return `${base()}/Videos/${id}/master.m3u8?api_key=${key()}&MediaSourceId=${id}&VideoCodec=h264&AudioCodec=aac,mp3&TranscodingMaxAudioChannels=2&SegmentContainer=ts&MinSegments=1`;
}

export async function reportProgress(id: string, positionTicks: number) {
  try {
    const uid = await jellyUserId();
    // The UserData endpoint reliably persists the resume position (the
    // /Sessions/Playing lifecycle needs a real device session and doesn't stick
    // with a bare API key). This is what makes "Continue watching" work.
    await fetch(`${base()}/UserItems/${id}/UserData?userId=${uid}`, {
      method: 'POST',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ PlaybackPositionTicks: Math.round(positionTicks) }),
    });
  } catch { /* best-effort */ }
}

// Mark an item fully played / unplayed (for the "mark watched" affordance).
export async function setPlayed(id: string, played: boolean) {
  try {
    const uid = await jellyUserId();
    await fetch(`${base()}/UserPlayedItems/${id}?userId=${uid}`, { method: played ? 'POST' : 'DELETE', headers: authHeaders() });
  } catch { /* */ }
}

// Recommendations: "Because you watched", Next Up (TV), and suggestions.
export async function recommendations(): Promise<{ nextUp: MediaItem[]; suggestions: MediaItem[]; recentlyAdded: MediaItem[] }> {
  const uid = await jellyUserId();
  const [nextUpRaw, sugRaw, recentRaw] = await Promise.all([
    jf('/Shows/NextUp', { UserId: uid, Limit: 20, Fields: 'Overview,ProductionYear' }).catch(() => ({ Items: [] })),
    jf(`/Users/${uid}/Suggestions`, { Limit: 20, Type: 'Movie,Series', Fields: 'Overview,ProductionYear' }).catch(() => ({ Items: [] })),
    jf(`/Users/${uid}/Items`, { IncludeItemTypes: 'Movie,Series', Recursive: true, SortBy: 'DateCreated', SortOrder: 'Descending', Limit: 20, Fields: 'Overview,ProductionYear' }).catch(() => ({ Items: [] })),
  ]);
  return {
    nextUp: (nextUpRaw.Items || []).map(mapItem),
    suggestions: (sugRaw.Items || []).map(mapItem),
    recentlyAdded: (recentRaw.Items || []).map(mapItem),
  };
}

// "More like this" for a specific item.
export async function similar(id: string): Promise<MediaItem[]> {
  try {
    const data = await jf(`/Items/${id}/Similar`, { Limit: 16, Fields: 'ProductionYear' });
    return (data.Items || []).map(mapItem);
  } catch { return []; }
}

export async function search(term: string): Promise<MediaItem[]> {
  const uid = await jellyUserId();
  const data = await jf(`/Users/${uid}/Items`, {
    SearchTerm: term, Recursive: true, Limit: 24,
    IncludeItemTypes: 'Movie,Series,Audio,MusicAlbum',
    Fields: 'ProductionYear',
  });
  return (data.Items || []).map(mapItem);
}

export { base as jellyfinBase, key as jellyfinKey };
