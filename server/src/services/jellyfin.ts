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
  const width = type === 'Backdrop' ? 1280 : type === 'Thumb' ? 640 : 480;
  const q = new URLSearchParams({ w: String(width) });
  if (tag) q.set('tag', tag);
  return `/api/media/image/${id}/${type}?${q}`;
}

export function directImageUrl(id: string, type = 'Primary', maxWidth?: number): string {
  const u = new URL(`${base()}/Items/${id}/Images/${type}`);
  u.searchParams.set('api_key', key());
  u.searchParams.set('quality', '90');
  if (maxWidth) u.searchParams.set('maxWidth', String(maxWidth));
  return u.toString();
}

function mapItem(it: any): MediaItem {
  const primary = it.ImageTags?.Primary ? imageUrl(it.Id, 'Primary', it.ImageTags.Primary) : undefined;
  const thumb = it.ImageTags?.Thumb ? imageUrl(it.Id, 'Thumb', it.ImageTags.Thumb) : undefined;
  const backdrop = it.BackdropImageTags?.[0] ? imageUrl(it.Id, 'Backdrop', it.BackdropImageTags[0]) : undefined;
  return {
    id: it.Id,
    type: it.Type,
    name: it.Name,
    overview: it.Overview,
    year: it.ProductionYear,
    posterUrl: primary,
    backdropUrl: backdrop,
    thumbUrl: thumb || (!primary && !backdrop && it.Type === 'Video' ? `/api/media/video-thumbnail/${it.Id}?w=480` : undefined),
    runtimeTicks: it.RunTimeTicks,
    runtimeMinutes: it.RunTimeTicks ? Math.round(it.RunTimeTicks / 600000000) : undefined,
    // Per-user progress/played state is Aerie-owned (playback_progress) and
    // layered on by the route overlay. Jellyfin's UserData is the SHARED backend
    // account's state, so we deliberately ignore it here — no row = clean/zero.
    progressPct: 0,
    positionTicks: 0,
    playedPct: 0,
    played: false,
    seriesId: it.SeriesId || (it.Type === 'Series' ? it.Id : undefined),
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

const pageCache = new Map<string, { expires: number; value: { items: MediaItem[]; total: number } }>();

export async function pageByType(includeItemTypes: string, offset: number, limit: number, params: Record<string, any> = {}) {
  const uid = await jellyUserId();
  const cacheKey = `${uid}:${includeItemTypes}:${offset}:${limit}:${JSON.stringify(params)}`;
  const cached = pageCache.get(cacheKey);
  if (cached && cached.expires > Date.now()) return cached.value;
  const data = await jf(`/Users/${uid}/Items`, {
    IncludeItemTypes: includeItemTypes,
    Recursive: true,
    Fields: 'Overview,Genres,ProductionYear,RunTimeTicks',
    SortBy: params.SortBy || 'SortName',
    SortOrder: params.SortOrder || 'Ascending',
    ...params,
    StartIndex: Math.max(0, offset),
    Limit: Math.min(100, Math.max(1, limit)),
  });
  const value = { items: (data.Items || []).map(mapItem), total: Number(data.TotalRecordCount || 0) };
  pageCache.set(cacheKey, { expires: Date.now() + 60_000, value });
  return value;
}

const genreCache = new Map<string, { expires: number; items: string[] }>();
export async function genres(includeItemTypes: string): Promise<string[]> {
  const uid = await jellyUserId();
  const cached = genreCache.get(includeItemTypes);
  if (cached && cached.expires > Date.now()) return cached.items;
  const data = await jf('/Genres', { UserId: uid, IncludeItemTypes: includeItemTypes, Recursive: true, Limit: 300, SortBy: 'SortName' });
  const items = (data.Items || []).map((g: any) => String(g.Name || '')).filter(Boolean);
  genreCache.set(includeItemTypes, { expires: Date.now() + 300_000, items });
  return items;
}

const fullLibraryCache = new Map<string, { expires: number; items: MediaItem[] }>();

// Full-library variant for screens that must show every title. Jellyfin caps a
// request at Limit, so keep advancing StartIndex until TotalRecordCount (or a
// short final page) says the library is complete. listByType intentionally
// remains a bounded request because assistant/automation callers use Limit as
// an actual result cap.
export async function listAllByType(includeItemTypes: string, params: Record<string, any> = {}): Promise<MediaItem[]> {
  const uid = await jellyUserId();
  const cacheKey = `${uid}:${includeItemTypes}:${JSON.stringify(params)}`;
  const cached = fullLibraryCache.get(cacheKey);
  if (cached && cached.expires > Date.now()) return cached.items;

  const pageSize = 500;
  const out: any[] = [];
  const seen = new Set<string>();
  let startIndex = 0;

  while (true) {
    const data = await jf(`/Users/${uid}/Items`, {
      IncludeItemTypes: includeItemTypes,
      Recursive: true,
      Fields: 'Overview,Genres,ProductionYear,RunTimeTicks',
      SortBy: params.SortBy || 'SortName',
      SortOrder: params.SortOrder || 'Ascending',
      ...params,
      StartIndex: startIndex,
      Limit: pageSize,
    });
    const batch = Array.isArray(data.Items) ? data.Items : [];
    const before = out.length;
    for (const item of batch) {
      const id = String(item?.Id || '');
      if (!id || seen.has(id)) continue;
      seen.add(id);
      out.push(item);
    }

    startIndex += batch.length;
    const total = Number(data.TotalRecordCount);
    if (batch.length === 0
      || out.length === before
      || batch.length < pageSize
      || (Number.isFinite(total) && startIndex >= total)) break;
  }

  const items = out.map(mapItem);
  fullLibraryCache.set(cacheKey, { expires: Date.now() + 60_000, items });
  return items;
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

export async function itemPath(id: string): Promise<string> {
  const uid = await jellyUserId();
  const it = await jf(`/Users/${uid}/Items/${id}`, { Fields: 'Path' });
  return String(it?.Path || '');
}

export async function children(parentId: string): Promise<MediaItem[]> {
  const uid = await jellyUserId();
  const data = await jf(`/Users/${uid}/Items`, {
    ParentId: parentId, Fields: 'Overview,RunTimeTicks', SortBy: 'SortName',
  });
  return (data.Items || []).map(mapItem);
}

export async function episodes(seriesId: string): Promise<MediaItem[]> {
  const uid = await jellyUserId();
  const data = await jf(`/Users/${uid}/Items`, {
    ParentId: seriesId,
    IncludeItemTypes: 'Episode',
    Recursive: true,
    Fields: 'Overview,ProductionYear,RunTimeTicks',
    SortBy: 'ParentIndexNumber,IndexNumber,SortName',
    SortOrder: 'Ascending',
  });
  return (data.Items || []).map(mapItem).sort((a: MediaItem, b: MediaItem) =>
    (a.seasonNumber || 0) - (b.seasonNumber || 0)
    || (a.episodeNumber || 0) - (b.episodeNumber || 0)
    || a.name.localeCompare(b.name));
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
    mediaSourceId: src?.Id || id, url: `/api/media/subtitle/${id}/${src?.Id || id}/${s.Index}`,
  }));
  return { audio, subtitles };
}

export function directSubtitleUrl(id: string, mediaSourceId: string, index: number): string {
  return `${base()}/Videos/${id}/${mediaSourceId}/Subtitles/${index}/0/Stream.vtt?api_key=${key()}`;
}

export function directVideoStreamUrl(id: string): string {
  return `${base()}/Videos/${id}/stream?static=true&api_key=${key()}`;
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

// Progressive audio for Google Cast. Direct-play the common Cast-supported
// containers so Range seeking works; transcode anything else to MP3. A live
// transcode resumes server-side because its response is not Range-seekable.
export async function castAudioSource(id: string, startSec = 0): Promise<{ url: string; contentType: string; canSeek: boolean }> {
  try {
    const uid = await jellyUserId();
    const it = await jf(`/Users/${uid}/Items/${id}`);
    const src = it.MediaSources?.[0];
    const container = String(src?.Container || '').toLowerCase().split(',')[0];
    const contentTypes: Record<string, string> = {
      mp3: 'audio/mpeg', aac: 'audio/aac', m4a: 'audio/mp4', m4b: 'audio/mp4',
      mp4: 'audio/mp4', flac: 'audio/flac', wav: 'audio/wav', ogg: 'audio/ogg',
      oga: 'audio/ogg', opus: 'audio/ogg', webm: 'audio/webm',
    };
    if (src?.Id && contentTypes[container]) {
      return {
        url: `${base()}/Audio/${id}/stream?Static=true&api_key=${key()}&MediaSourceId=${src.Id}`,
        contentType: contentTypes[container],
        canSeek: true,
      };
    }
  } catch { /* fall through to the transcode URL */ }

  const uid = await jellyUserId();
  const st = startSec > 0 ? `&StartTimeTicks=${Math.round(startSec * 1e7)}` : '';
  return {
    url: `${base()}/Audio/${id}/universal?api_key=${key()}&UserId=${uid}&DeviceId=aerie-cast`
      + `&Container=mp3&TranscodingContainer=mp3&TranscodingProtocol=http&AudioCodec=mp3&MaxStreamingBitrate=320000${st}`,
    contentType: 'audio/mpeg',
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

export async function recommendationCatalog(): Promise<{ suggestions: MediaItem[]; recentlyAdded: MediaItem[] }> {
  const uid = await jellyUserId();
  const [sugRaw, recentRaw] = await Promise.all([
    jf(`/Users/${uid}/Suggestions`, { Limit: 20, Type: 'Movie,Series', Fields: 'Overview,ProductionYear' }).catch(() => ({ Items: [] })),
    jf(`/Users/${uid}/Items`, { IncludeItemTypes: 'Movie,Series', Recursive: true, SortBy: 'DateCreated', SortOrder: 'Descending', Limit: 20, Fields: 'Overview,ProductionYear' }).catch(() => ({ Items: [] })),
  ]);
  return {
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

export async function transcodingStatus() {
  if (!configured()) return { configured: false, hardwareAcceleration: 'none', active: [], directPlaying: 0 };
  const [sessions, encoding, info] = await Promise.all([
    jf('/Sessions', { ActiveWithinSeconds: 600 }).catch(() => []),
    jf('/System/Configuration/encoding').catch(() => ({})),
    jf('/System/Info').catch(() => ({})),
  ]);
  const all = Array.isArray(sessions) ? sessions : [];
  const active = all.filter((s: any) => s.NowPlayingItem).map((s: any) => {
    const t = s.TranscodingInfo || {};
    return {
      id: String(s.Id || ''), device: s.DeviceName || s.Client || 'Unknown device', title: s.NowPlayingItem?.Name || 'Unknown title',
      mediaType: s.NowPlayingItem?.MediaType || s.NowPlayingItem?.Type,
      method: t.IsVideoDirect ? 'Direct play' : t.IsAudioDirect && t.IsVideoDirect !== false ? 'Direct stream' : t.VideoCodec || t.AudioCodec ? 'Transcoding' : 'Direct play',
      hardwareAcceleration: t.HardwareAccelerationType || null, videoCodec: t.VideoCodec || null, audioCodec: t.AudioCodec || null,
      width: t.Width || null, height: t.Height || null, completionPct: t.CompletionPercentage || null,
      reasons: Array.isArray(t.TranscodeReasons) ? t.TranscodeReasons : [],
    };
  });
  const hw = String(encoding.HardwareAccelerationType || encoding.EncodingThreadCount === -1 && encoding.EnableHardwareEncoding ? 'enabled' : 'none');
  return {
    configured: true, serverVersion: info.Version || null, hardwareAcceleration: hw || 'none',
    hardwareEncoding: !!encoding.EnableHardwareEncoding, active,
    transcoding: active.filter((s: any) => s.method === 'Transcoding').length,
    directPlaying: active.filter((s: any) => s.method !== 'Transcoding').length,
  };
}

export async function libraryScanStatus() {
  if (!configured()) return { configured: false, running: false, progress: 0, libraries: [] };
  const [tasks, folders] = await Promise.all([
    jf('/ScheduledTasks').catch(() => []), jf('/Library/VirtualFolders').catch(() => []),
  ]);
  const scan = (Array.isArray(tasks) ? tasks : []).find((t: any) => /scan media library/i.test(t.Name || '') || /RefreshLibrary/i.test(t.Key || ''));
  return {
    configured: true, running: scan?.State === 'Running', progress: Number(scan?.CurrentProgressPercentage || 0),
    lastResult: scan?.LastExecutionResult ? { status: scan.LastExecutionResult.Status, start: scan.LastExecutionResult.StartTimeUtc, end: scan.LastExecutionResult.EndTimeUtc, error: scan.LastExecutionResult.ErrorMessage } : null,
    libraries: (Array.isArray(folders) ? folders : []).map((f: any) => ({ name: f.Name, type: f.CollectionType || 'mixed', paths: f.Locations || [] })),
  };
}

export async function startLibraryScan() {
  const res = await fetch(`${base()}/Library/Refresh`, { method: 'POST', headers: authHeaders() });
  if (!res.ok) throw new Error(`jellyfin ${res.status} library refresh`);
}

export async function chapters(id: string): Promise<{ name: string; startSec: number }[]> {
  const uid = await jellyUserId();
  const it = await jf(`/Users/${uid}/Items/${id}`, { Fields: 'Chapters' });
  return (Array.isArray(it?.Chapters) ? it.Chapters : []).map((c: any) => ({ name: String(c.Name || ''), startSec: Number(c.StartPositionTicks || 0) / 1e7 }));
}

export async function metadata(id: string) {
  const uid = await jellyUserId();
  const it = await jf(`/Users/${uid}/Items/${id}`, { Fields: 'Path,Genres,Overview,Studios,ProviderIds,DateCreated' });
  return {
    id: it.Id, name: it.Name || '', sortName: it.SortName || '', overview: it.Overview || '', year: it.ProductionYear || null,
    genres: it.Genres || [], communityRating: it.CommunityRating || null, officialRating: it.OfficialRating || '',
    path: it.Path || '', type: it.Type || '', locked: !!it.LockData,
  };
}

export async function updateMetadata(id: string, changes: Record<string, any>) {
  const uid = await jellyUserId();
  const current = await jf(`/Users/${uid}/Items/${id}`, { Fields: 'Path,Genres,Overview,Studios,ProviderIds' });
  const body = { ...current, ...changes, Id: id };
  const res = await fetch(`${base()}/Items/${id}`, { method: 'POST', headers: { ...authHeaders(), 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`jellyfin ${res.status} metadata update`);
  fullLibraryCache.clear(); pageCache.clear();
}

export async function refreshItem(id: string) {
  const url = new URL(`${base()}/Items/${id}/Refresh`);
  url.searchParams.set('MetadataRefreshMode', 'FullRefresh'); url.searchParams.set('ImageRefreshMode', 'FullRefresh');
  url.searchParams.set('ReplaceAllMetadata', 'false'); url.searchParams.set('ReplaceAllImages', 'false');
  const res = await fetch(url, { method: 'POST', headers: authHeaders() });
  if (!res.ok) throw new Error(`jellyfin ${res.status} metadata refresh`);
}

export { base as jellyfinBase, key as jellyfinKey };
