// Central typed API client. Every page uses this — no raw fetch in pages.
import type {
  AuthResponse, User, FileListing, FileEntry, StorageUsage, DashboardData,
  MediaItem, NativePhoto, PhotoAlbum, PhotoAlbumShare, SharedPhotoAlbum, Book, Chapter, DocMeta, AiJob, GeneratedImage,
  Share, AccountShare, AccountSharePermission, DocVersion,
  ServiceStatus, SystemHealth, BackupStatus, BackupConfiguration, AuditEvent, Device,
  Automation, Notification, SearchResponse, MusicResult, MusicRequest,
  HistoryKind, HistoryEntry, HistoryStats, HouseholdInvite, AppCapabilities, TranslationCapabilities, TranslationProvider,
} from './model';
import { refreshNativeAccess } from './native-device';
import { readAuthSyncMarker } from './auth-sync';
import type { VideoPlaybackPlan } from './video-playback-plan';

// Browser authentication is an HttpOnly cookie. Absorb a pre-upgrade token
// once into memory so existing sessions migrate without another login, then
// remove the XSS-readable persistent copy.
let TOKEN: string | null = (() => {
  try {
    const legacy = localStorage.getItem('cb_token');
    localStorage.removeItem('cb_token');
    return legacy;
  } catch { return null; }
})();
let ACCOUNT_SCOPE = 'locked';
let ACCOUNT_GENERATION = 0;
let ACCOUNT_ABORT = new AbortController();
let COOKIE_SESSION_SYNC = false;
let OBSERVED_AUTH_MARKER: string | null = null;

export class ApiAccountChangedError extends Error {
  name = 'AbortError';
  constructor() { super('account_session_changed'); }
}

function emitWindowEvent(name: string, detail?: unknown) {
  if (typeof window === 'undefined') return;
  try { window.dispatchEvent(new CustomEvent(name, { detail })); }
  catch {
    try {
      const event = new Event(name) as Event & { detail?: unknown };
      event.detail = detail;
      window.dispatchEvent(event);
    } catch { /* no DOM event runtime */ }
  }
}

function advanceAccountGeneration() {
  ACCOUNT_GENERATION += 1;
  try { ACCOUNT_ABORT.abort('account_session_changed'); } catch { ACCOUNT_ABORT.abort(); }
  ACCOUNT_ABORT = new AbortController();
}

export function invalidateApiAccountScope() {
  ACCOUNT_SCOPE = 'locked';
  advanceAccountGeneration();
}

export function configureApiCookieSessionSync(enabled: boolean) {
  COOKIE_SESSION_SYNC = !!enabled;
  OBSERVED_AUTH_MARKER = COOKIE_SESSION_SYNC ? readAuthSyncMarker() : null;
}

export function acknowledgeApiAuthMarker(marker?: string | null) {
  if (!COOKIE_SESSION_SYNC) return;
  OBSERVED_AUTH_MARKER = marker === undefined ? readAuthSyncMarker() : marker;
}

export function getApiAccountGeneration() { return ACCOUNT_GENERATION; }

function checkCookieSessionMarker() {
  if (!COOKIE_SESSION_SYNC) return;
  const current = readAuthSyncMarker();
  if (!current || current === OBSERVED_AUTH_MARKER) return;
  OBSERVED_AUTH_MARKER = current;
  invalidateApiAccountScope();
  emitWindowEvent('aerie:peer-auth-marker', { marker: current });
  throw new ApiAccountChangedError();
}

function captureAccountGeneration() {
  checkCookieSessionMarker();
  return { generation: ACCOUNT_GENERATION, signal: ACCOUNT_ABORT.signal };
}

function assertAccountGeneration(generation: number) {
  checkCookieSessionMarker();
  if (generation !== ACCOUNT_GENERATION) throw new ApiAccountChangedError();
}

function accountSignal(external: AbortSignal | undefined, internal: AbortSignal): AbortSignal {
  if (!external || external === internal) return internal;
  const anySignal = (AbortSignal as any).any;
  if (typeof anySignal === 'function') return (AbortSignal as any).any([external, internal]);
  const controller = new AbortController();
  const abort = (event: Event) => {
    const source = event.target as AbortSignal;
    try { controller.abort(source.reason); } catch { controller.abort(); }
  };
  if (external.aborted) controller.abort(external.reason);
  else if (internal.aborted) controller.abort(internal.reason);
  else {
    external.addEventListener('abort', abort, { once: true });
    internal.addEventListener('abort', abort, { once: true });
  }
  return controller.signal;
}

export function setApiAccountScope(userId: number | null) {
  const next = Number.isSafeInteger(userId) && Number(userId) > 0 ? `user-${userId}` : 'locked';
  if (next !== ACCOUNT_SCOPE) {
    ACCOUNT_SCOPE = next;
    advanceAccountGeneration();
  }
  // Legacy keys were not account-scoped. They cannot be assigned safely after
  // an account switch, so discard only those old resumable pointers.
  try {
    for (let index = localStorage.length - 1; index >= 0; index--) {
      const key = localStorage.key(index);
      if (key?.startsWith('aerie_upload:') && !key.startsWith('aerie_upload:v2:')) localStorage.removeItem(key);
    }
  } catch { /* storage can be disabled */ }
}
export function setToken(t: string | null) {
  // Mirror to the native app so it can restore the session across an origin hop.
  try { (window as any).CloudBoxNative?.authToken?.(t || ''); } catch { /* not in app */ }
  try { (window as any).aerieSync?.setAuth?.(t || ''); } catch { /* not in desktop */ }
  TOKEN = t;
}
export function getToken() { return TOKEN; }

async function blobSha256(blob: Blob): Promise<string | null> {
  try {
    const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
    return [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('');
  } catch {
    return null;
  }
}

class ApiError extends Error {
  constructor(public status: number, message: string, public requestId?: string) { super(message); }
}

type AdminUserParams = Partial<Pick<User, 'username' | 'displayName' | 'email' | 'role' | 'storageQuotaBytes' | 'aiMode' | 'features'>> & { password?: string };

async function req<T>(method: string, path: string, body?: any, opts: {
  raw?: boolean;
  form?: FormData;
  signal?: AbortSignal;
  surviveAccountChange?: boolean;
} = {}, nativeRetry = true): Promise<T> {
  const account = opts.surviveAccountChange ? null : captureAccountGeneration();
  const headers: Record<string, string> = {};
  if (TOKEN) headers.Authorization = `Bearer ${TOKEN}`;
  let payload: any;
  if (opts.form) { payload = opts.form; }
  else if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  const signal = account ? accountSignal(opts.signal, account.signal) : opts.signal;
  const res = await fetch(path, { method, headers, body: payload, credentials: 'same-origin', signal });
  if (account) assertAccountGeneration(account.generation);
  if (res.status === 401 && !path.includes('/auth/')) {
    // Paired native clients use short-lived, proof-bound sessions. Renew once
    // with the hardware/OS key before treating a 401 as a real sign-out.
    if (nativeRetry) {
      const renewed = await refreshNativeAccess();
      if (account) assertAccountGeneration(account.generation);
      if (renewed?.token) {
        setToken(renewed.token);
        return req<T>(method, path, body, opts, false);
      }
    }
    setToken(null);
    invalidateApiAccountScope();
    emitWindowEvent('aerie:auth-invalidated');
    if (!location.pathname.startsWith('/login')) location.href = '/login';
    throw new ApiError(401, 'unauthorized');
  }
  if (!res.ok) {
    let msg = res.statusText;
    let requestId: string | undefined;
    try {
      const j = await res.json();
      msg = j.error || msg;
      requestId = typeof j.requestId === 'string' ? j.requestId : undefined;
    } catch { /* */ }
    if (res.status >= 500 && requestId) {
      msg = `${msg === 'server_error' ? 'Server error' : msg} (reference ${requestId.slice(0, 8)})`;
    }
    throw new ApiError(res.status, msg, requestId);
  }
  if (opts.raw) return res as any;
  const ct = res.headers.get('content-type') || '';
  const result = ct.includes('application/json') ? await res.json() : await res.text();
  if (account) assertAccountGeneration(account.generation);
  return result as T;
}

// Bare media elements send the same-origin HttpOnly session cookie. Never put
// the full account credential into URLs, logs, history or referrers.
const tokUrl = (u?: string) => u;
const tokMedia = <T extends { posterUrl?: string; backdropUrl?: string; thumbUrl?: string }>(it: T): T =>
  ({ ...it, posterUrl: tokUrl(it.posterUrl), backdropUrl: tokUrl(it.backdropUrl), thumbUrl: tokUrl(it.thumbUrl) });
const tokMediaList = (arr: MediaItem[]) => (arr || []).map(tokMedia);
export type Paged<T> = { items: T[]; total: number; offset: number; limit: number; hasMore: boolean };
const pageQuery = (offset = 0, limit = 50, opts: { q?: string; genre?: string; sort?: string } = {}) => {
  const p = new URLSearchParams({ paged: '1', offset: String(offset), limit: String(limit) });
  if (opts.q) p.set('q', opts.q); if (opts.genre && opts.genre !== 'all') p.set('genre', opts.genre); if (opts.sort) p.set('sort', opts.sort);
  return p.toString();
};
const tokPage = (p: Paged<MediaItem>) => ({ ...p, items: tokMediaList(p.items) });

export const api = {
  // Protected media uses the same-origin HttpOnly session cookie.
  url: (path: string) => path,

  sync: {
    bases: () => req<{ bases: { base: string; files: number; bytes: number; lastChange: number }[] }>('GET', '/api/sync/bases'),
    conflicts: () => req<{ items: any[] }>('GET', '/api/sync/conflicts'),
    resolveConflict: (id: string, action: 'device' | 'server' | 'dismiss') => req('POST', `/api/sync/conflicts/${id}/resolve`, { action }),
  },

  jobs: {
    list: (limit = 100) => req<{ items: { id: string; type: string; status: string; prompt?: string; progress: number; error?: string; createdAt: string; finishedAt?: string; result?: any }[]; active: number }>('GET', `/api/jobs?limit=${limit}`),
  },

  dedup: {
    scan: () => req<{ jobId: string }>('POST', '/api/dedup/scan'),
    remove: () => req<{ jobId: string }>('POST', '/api/dedup/remove'),
    job: (id: string) => req<{ status: string; progress: number; error?: string; result?: any }>('GET', `/api/dedup/job/${id}`),
    last: () => req<{ type: 'scan' | 'remove' | null; status: string; progress: number; error?: string; result?: any; jobId?: string }>('GET', '/api/dedup/last'),
  },

  // ---- auth ----
  login: (username: string, password: string, code?: string) => req<AuthResponse | { needs2fa: true }>('POST', '/api/auth/login', {
    username, password, code,
    deviceName: /Android|iPhone|iPad/i.test(navigator.userAgent) ? `${navigator.platform || 'Mobile'} app` : navigator.platform || 'Web browser',
    deviceType: /Android/i.test(navigator.userAgent) ? 'android' : /iPhone|iPad/i.test(navigator.userAgent) ? 'ios' : 'web',
  }),
  // Logout must reach the server even after the local UI generation is locked;
  // otherwise its shared HttpOnly cookie could survive the visible sign-out.
  logout: () => req('POST', '/api/auth/logout', undefined, { surviveAccountChange: true }),
  me: () => req<{ user: User }>('GET', '/api/auth/me'),
  users: () => req<{ id: number; username: string; displayName: string; avatarColor: string }[]>('GET', '/api/auth/users'),
  invite: {
    inspect: (token: string) => req<{ displayName: string; email: string | null; role: 'admin' | 'user'; expiresAt: string }>('GET', `/api/auth/invite/${encodeURIComponent(token)}`),
    accept: (token: string, data: { username: string; displayName: string; password: string }) =>
      req<{ id: number; username: string; displayName: string }>('POST', `/api/auth/invite/${encodeURIComponent(token)}/accept`, data),
  },

  // ---- dashboard ----
  dashboard: () => req<DashboardData>('GET', '/api/dashboard')
    .then(d => d ? { ...d, continueWatching: tokMediaList(d.continueWatching) } : d),
  capabilities: () => req<AppCapabilities>('GET', '/api/capabilities'),

  // ---- history ----
  history: {
    beat: (params: { kind: HistoryKind; itemId: string; title: string; subtitle?: string; imageUrl?: string; positionSec?: number; durationSec?: number }) =>
      req<{ ok: boolean }>('POST', '/api/history/beat', params),
    list: (kind?: string) => req<{ entries: HistoryEntry[] }>('GET', `/api/history${kind ? `?kind=${encodeURIComponent(kind)}` : ''}`),
    stats: () => req<HistoryStats>('GET', '/api/history/stats'),
  },

  // ---- files ----
  files: {
    list: (path = '/', sort = 'name', dir = 'asc') => req<FileListing>('GET', `/api/files/list?path=${encodeURIComponent(path)}&sort=${sort}&dir=${dir}`),
    recent: (limit = 24) => req<FileEntry[]>('GET', `/api/files/recent?limit=${limit}`),
    starred: () => req<FileEntry[]>('GET', '/api/files/starred'),
    star: (path: string, starred: boolean) => req('POST', '/api/files/star', { path, starred }),
    usage: () => req<StorageUsage>('GET', '/api/files/usage'),
    mkdir: (path: string, name: string) => req('POST', '/api/files/mkdir', { path, name }),
    rename: (path: string, newName: string) => req<{ path: string }>('POST', '/api/files/rename', { path, newName }),
    move: (paths: string[], toDir: string) => req('POST', '/api/files/move', { paths, toDir }),
    copy: (paths: string[], toDir: string) => req('POST', '/api/files/copy', { paths, toDir }),
    delete: (paths: string[]) => req('POST', '/api/files/delete', { paths }),
    trash: () => req<any[]>('GET', '/api/files/trash'),
    restore: (id: string) => req('POST', '/api/files/trash/restore', { id }),
    purge: (id?: string) => req('POST', '/api/files/trash/purge', { id }),
    content: (path: string) => req<{ path: string; content: string; revision: string; modifiedAt: string }>('GET', `/api/files/content?path=${encodeURIComponent(path)}`),
    revision: (path: string) => req<{ path: string; revision: string; modifiedAt: string; size: number }>('GET', `/api/files/revision?path=${encodeURIComponent(path)}`),
    saveContent: (path: string, content: string, revision?: string) => req<{ ok: boolean; revision: string; versionId?: string }>('POST', '/api/files/content', { path, content, revision }),
    create: (path: string, name: string, content = '') => req<{ path: string }>('POST', '/api/files/create', { path, name, content }),
    rawUrl: (path: string, download = false) => api.url(`/api/files/raw?path=${encodeURIComponent(path)}${download ? '&download=1' : ''}`),
    thumbUrl: (path: string) => api.url(`/api/files/thumb?path=${encodeURIComponent(path)}`),
    videoThumbUrl: (path: string) => api.url(`/api/files/thumb?path=${encodeURIComponent(path)}&videoFrame=1`),
    versions: (path: string) => req<any[]>('GET', `/api/files/versions?path=${encodeURIComponent(path)}`),
    restoreVersion: (path: string, versionId: string, revision?: string) => req<{ ok: boolean; revision: string }>('POST', '/api/files/versions/restore', { path, versionId, revision }),
    upload: (path: string, files: File[], relativePaths?: string[], onProgress?: (pct: number) => void, signal?: AbortSignal) => {
      if (files.some(f => f.size >= 8 * 1024 * 1024)) return (async () => {
        const uploadAccount = captureAccountGeneration();
        const uploadSignal = accountSignal(signal, uploadAccount.signal);
        const total = files.reduce((sum, f) => sum + f.size, 0) || 1; let finished = 0; const saved: string[] = [];
        for (let i = 0; i < files.length; i++) {
          assertAccountGeneration(uploadAccount.generation);
          if (uploadSignal.aborted) throw new DOMException('Upload cancelled', 'AbortError');
          const file = files[i]; const relativePath = relativePaths?.[i] || file.name;
          const resumeKey = `aerie_upload:v2:${ACCOUNT_SCOPE}:${path}:${relativePath}:${file.size}:${file.lastModified}`;
          const previous = localStorage.getItem(resumeKey) || undefined;
          const init = await req<{ uploadId: string; offset: number }>('POST', '/api/files/upload-resumable/init', { path, relativePath, name: file.name, size: file.size, lastModified: file.lastModified, uploadId: previous }, { signal: uploadSignal });
          assertAccountGeneration(uploadAccount.generation);
          localStorage.setItem(resumeKey, init.uploadId); let offset = init.offset;
          try {
            const chunkSize = 8 * 1024 * 1024;
            while (offset < file.size) {
              const chunk = file.slice(offset, Math.min(file.size, offset + chunkSize));
              const headers: Record<string, string> = { 'Content-Type': 'application/octet-stream', 'X-Upload-Offset': String(offset) };
              const chunkHash = await blobSha256(chunk);
              assertAccountGeneration(uploadAccount.generation);
              if (chunkHash) headers['X-Chunk-SHA256'] = chunkHash;
              if (TOKEN) headers.Authorization = `Bearer ${TOKEN}`;
              const response = await fetch(`/api/files/upload-resumable/${init.uploadId}`, { method: 'PATCH', headers, body: chunk, signal: uploadSignal, credentials: 'same-origin' });
              assertAccountGeneration(uploadAccount.generation);
              if (response.status === 409) {
                const state = await response.json();
                assertAccountGeneration(uploadAccount.generation);
                offset = Number(state.offset) || 0;
                continue;
              }
              if (!response.ok) throw new Error(`upload_failed_${response.status}`);
              const state = await response.json();
              assertAccountGeneration(uploadAccount.generation);
              offset = Number(state.offset) || offset + chunk.size;
              onProgress?.(Math.round(((finished + offset) / total) * 100));
            }
            const done = await req<{ saved: string[] }>('POST', `/api/files/upload-resumable/${init.uploadId}/complete`, undefined, { signal: uploadSignal });
            assertAccountGeneration(uploadAccount.generation);
            saved.push(...done.saved); localStorage.removeItem(resumeKey); finished += file.size;
          } catch (error) {
            if (signal?.aborted) {
              await req('DELETE', `/api/files/upload-resumable/${init.uploadId}`).catch(() => {});
              localStorage.removeItem(resumeKey);
            }
            throw error;
          }
        }
        assertAccountGeneration(uploadAccount.generation);
        onProgress?.(100); return { saved };
      })();
      return new Promise<{ saved: string[] }>((resolve, reject) => {
        const uploadAccount = captureAccountGeneration();
        const form = new FormData();
        form.append('path', path);
        files.forEach((f, i) => { form.append('files', f); form.append('relativePaths', relativePaths?.[i] || f.name); });
        const xhr = new XMLHttpRequest();
        const abort = () => xhr.abort();
        const cleanup = () => {
          signal?.removeEventListener('abort', abort);
          uploadAccount.signal.removeEventListener('abort', abort);
        };
        xhr.open('POST', '/api/files/upload');
        if (TOKEN) xhr.setRequestHeader('Authorization', `Bearer ${TOKEN}`);
        xhr.setRequestHeader('X-Aerie-Upload-Length', String(files.reduce((total, file) => total + file.size, 0)));
        xhr.upload.onprogress = (e) => {
          try {
            assertAccountGeneration(uploadAccount.generation);
            if (e.lengthComputable && onProgress) onProgress(Math.round((e.loaded / e.total) * 100));
          } catch { xhr.abort(); }
        };
        xhr.onload = () => {
          cleanup();
          try {
            assertAccountGeneration(uploadAccount.generation);
            if (xhr.status >= 300) reject(new Error(xhr.responseText));
            else resolve(JSON.parse(xhr.responseText));
          } catch (error) { reject(error); }
        };
        xhr.onerror = () => { cleanup(); reject(new Error('upload_failed')); };
        xhr.onabort = () => {
          cleanup();
          reject(uploadAccount.signal.aborted ? new ApiAccountChangedError() : new DOMException('Upload cancelled', 'AbortError'));
        };
        if (signal?.aborted || uploadAccount.signal.aborted) {
          reject(uploadAccount.signal.aborted ? new ApiAccountChangedError() : new DOMException('Upload cancelled', 'AbortError'));
          return;
        }
        signal?.addEventListener('abort', abort, { once: true });
        uploadAccount.signal.addEventListener('abort', abort, { once: true });
        xhr.send(form);
      });
    },
  },

  // ---- media (jellyfin) ----
  media: {
    status: () => req<{ configured: boolean }>('GET', '/api/media/status'),
    movies: (limit?: number) => req<MediaItem[]>('GET', `/api/media/movies${limit ? `?limit=${limit}` : ''}`).then(tokMediaList),
    series: (limit?: number) => req<MediaItem[]>('GET', `/api/media/series${limit ? `?limit=${limit}` : ''}`).then(tokMediaList),
    videos: (limit?: number) => req<MediaItem[]>('GET', `/api/media/videos${limit ? `?limit=${limit}` : ''}`).then(tokMediaList),
    albums: (limit?: number) => req<MediaItem[]>('GET', `/api/media/music/albums${limit ? `?limit=${limit}` : ''}`).then(tokMediaList),
    artists: (limit?: number) => req<MediaItem[]>('GET', `/api/media/music/artists${limit ? `?limit=${limit}` : ''}`).then(tokMediaList),
    songs: (limit?: number) => req<MediaItem[]>('GET', `/api/media/music/songs${limit ? `?limit=${limit}` : ''}`).then(tokMediaList),
    moviesPage: (offset = 0, limit = 50, opts: { q?: string; genre?: string; sort?: string } = {}) => req<Paged<MediaItem>>('GET', `/api/media/movies?${pageQuery(offset, limit, opts)}`).then(tokPage),
    seriesPage: (offset = 0, limit = 50, opts: { q?: string; genre?: string; sort?: string } = {}) => req<Paged<MediaItem>>('GET', `/api/media/series?${pageQuery(offset, limit, opts)}`).then(tokPage),
    albumsPage: (offset = 0, limit = 50, q = '') => req<Paged<MediaItem>>('GET', `/api/media/music/albums?${pageQuery(offset, limit, { q })}`).then(tokPage),
    artistsPage: (offset = 0, limit = 50, q = '') => req<Paged<MediaItem>>('GET', `/api/media/music/artists?${pageQuery(offset, limit, { q })}`).then(tokPage),
    songsPage: (offset = 0, limit = 50, q = '') => req<Paged<MediaItem>>('GET', `/api/media/music/songs?${pageQuery(offset, limit, { q })}`).then(tokPage),
    genres: (type: 'movies' | 'series') => req<{ genres: string[] }>('GET', `/api/media/genres/${type}`),
    resumeVideo: () => req<MediaItem[]>('GET', '/api/media/resume/video').then(tokMediaList),
    resumeAudio: () => req<MediaItem[]>('GET', '/api/media/resume/audio').then(tokMediaList),
    item: (id: string) => req<MediaItem>('GET', `/api/media/item/${id}`).then(tokMedia),
    children: (id: string) => req<MediaItem[]>('GET', `/api/media/item/${id}/children`).then(tokMediaList),
    episodes: (seriesId: string) => req<MediaItem[]>('GET', `/api/media/series/${seriesId}/episodes`).then(tokMediaList),
    streams: (id: string, sourceId?: string) => req<{ audio: any[]; subtitles: any[]; chapters?: { name: string; startSec: number; endSec?: number }[] }>(
      'GET', `/api/media/streams/${id}${sourceId ? `?source=${encodeURIComponent(sourceId)}` : ''}`,
    ),
    chapters: (id: string) => req<{ chapters: { name: string; startSec: number; endSec?: number }[] }>('GET', `/api/media/item/${id}/chapters`),
    // Forward-compatible integration point for the server's bounded playback
    // planner. The current player keeps its proven HLS path as a fallback while
    // older Aerie servers are still in use.
    playbackPlan: (id: string, query: Record<string, string | number | boolean> = {}) => {
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(query)) params.set(key, String(value));
      return req<VideoPlaybackPlan>('GET', `/api/media/playback/${id}${params.size ? `?${params}` : ''}`);
    },
    subtitleUrl: (url: string) => api.url(url),
    search: (q: string) => req<MediaItem[]>('GET', `/api/media/search?q=${encodeURIComponent(q)}`).then(tokMediaList),
    streamUrl: (id: string, audio = false) => api.url(`/api/media/stream/${id}${audio ? '?audio=1' : ''}`),
    offlineUrl: (id: string) => api.url(`/api/media/offline/${id}`),
    previewUrl: (id: string, sec: number, width = 240) => api.url(`/api/media/preview/${id}?t=${Math.max(0, Math.round(sec))}&w=${width}`),
    imageUrl: (id: string, type = 'Primary') => api.url(`/api/media/image/${id}/${type}`),
    progress: (id: string, positionTicks: number, durationTicks?: number, seriesId?: string) =>
      req('POST', '/api/media/progress', { id, positionTicks, durationTicks, seriesId }),
    setPlayed: (id: string, played: boolean, durationTicks?: number) => req('POST', '/api/media/played', { id, played, durationTicks }),
    recommendations: () => req<{ nextUp: MediaItem[]; suggestions: MediaItem[]; recentlyAdded: MediaItem[] }>('GET', '/api/media/recommendations')
      .then(r => ({ nextUp: tokMediaList(r.nextUp), suggestions: tokMediaList(r.suggestions), recentlyAdded: tokMediaList(r.recentlyAdded) })),
    similar: (id: string) => req<MediaItem[]>('GET', `/api/media/similar/${id}`).then(tokMediaList),
    segments: (id: string) => req<{ segments: { kind: 'intro' | 'credits'; startSec: number; endSec: number; source: string }[] }>('GET', `/api/media/item/${id}/segments`),
    saveSegments: (id: string, segments: any[]) => req('PUT', `/api/media/item/${id}/segments`, { segments }),
    scanStatus: () => req<any>('GET', '/api/media/library-scan'),
    startScan: () => req('POST', '/api/media/library-scan'),
    metadata: (id: string) => req<any>('GET', `/api/media/item/${id}/metadata`),
    saveMetadata: (id: string, data: any) => req('PATCH', `/api/media/item/${id}/metadata`, data),
    refreshMetadata: (id: string) => req('POST', `/api/media/item/${id}/refresh`),
    collections: () => req<{ items: any[] }>('GET', '/api/media/collections'),
    collectionItems: (id: string) => req<{ items: MediaItem[]; total: number }>('GET', `/api/media/collections/${id}/items`).then(r => ({ ...r, items: tokMediaList(r.items) })),
    createCollection: (data: any) => req<any>('POST', '/api/media/collections', data),
    updateCollection: (id: string, data: any) => req<any>('PATCH', `/api/media/collections/${id}`, data),
    removeCollection: (id: string) => req('DELETE', `/api/media/collections/${id}`),
  },

  // ---- subtitles ----
  subtitles: {
    list: (itemId: string) => req<{ subtitles: { id: string; lang: string; label: string; origin: string; createdAt: string }[] }>('GET', `/api/subtitles/item/${itemId}`),
    generate: (itemId: string) => req<{ jobId: string }>('POST', '/api/subtitles/generate', { itemId }),
    translate: (itemId: string, source: any, lang?: string) => req<{ jobId: string; targetLanguage: string; provider: TranslationProvider }>('POST', '/api/subtitles/translate', { itemId, source, lang }),
    sync: (itemId: string, source: any) => req<{ jobId: string }>('POST', '/api/subtitles/sync', { itemId, source }),
    cleanup: (itemId: string, source: any) => req<{ subtitle: any }>('POST', '/api/subtitles/cleanup', { itemId, source }),
    job: (id: string) => req<{ id: string; action: string; status: string; progress: number; error?: string; subtitleId?: string }>('GET', `/api/subtitles/job/${id}`),
    active: (itemId: string) => req<{ job: { id: string; action: string; status: string; progress: number } | null }>('GET', `/api/subtitles/active/${itemId}`),
    fileUrl: (id: string) => api.url(`/api/subtitles/file/${id}`),
    remove: (id: string) => req('DELETE', `/api/subtitles/${id}`),
  },

  // ---- photos ----
  photos: {
    status: () => req<{ configured: boolean; native: boolean }>('GET', '/api/photos/status'),
    native: {
      status: () => req<{ enabled: true; count: number; lastScan: string | null }>('GET', '/api/photos/native/status'),
      scan: () => req<{ count: number }>('POST', '/api/photos/native/scan'),
      timeline: (cursor?: string, limit = 200) => req<{ items: NativePhoto[]; nextCursor: string | null }>('GET', `/api/photos/native/timeline?limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`),
      months: () => req<{ month: string; count: number }[]>('GET', '/api/photos/native/months'),
      geo: () => req<{ path: string; lat: number; lon: number; takenAt: string | null }[]>('GET', '/api/photos/native/geo'),
      favorites: (limit = 1000) => req<{ items: NativePhoto[] }>('GET', `/api/photos/native/favorites?limit=${limit}`),
      favorite: (path: string, favorite: boolean) => req<{ path: string; favorite: boolean }>('POST', '/api/photos/native/favorite', { path, favorite }),
      albums: () => req<{ items: PhotoAlbum[] }>('GET', '/api/photos/native/albums'),
      sharedAlbums: () => req<{ items: SharedPhotoAlbum[] }>('GET', '/api/photos/native/albums/shared'),
      createAlbum: (data: { name: string; description?: string }) => req<PhotoAlbum>('POST', '/api/photos/native/albums', data),
      updateAlbum: (id: string, data: { name?: string; description?: string; coverPath?: string | null }) =>
        req<PhotoAlbum>('PATCH', `/api/photos/native/albums/${encodeURIComponent(id)}`, data),
      removeAlbum: (id: string) => req<{ ok: true }>('DELETE', `/api/photos/native/albums/${encodeURIComponent(id)}`),
      albumItems: (id: string) => req<{ items: NativePhoto[] }>('GET', `/api/photos/native/albums/${encodeURIComponent(id)}/items`),
      addAlbumItems: (id: string, paths: string[]) => req<{ added: number }>('POST', `/api/photos/native/albums/${encodeURIComponent(id)}/items`, { paths }),
      removeAlbumItems: (id: string, paths: string[]) => req<{ removed: number }>('DELETE', `/api/photos/native/albums/${encodeURIComponent(id)}/items`, { paths }),
      albumShares: (id: string) => req<{ items: PhotoAlbumShare[] }>('GET', `/api/photos/native/albums/${encodeURIComponent(id)}/shares`),
      shareAlbum: (id: string, recipientId: number) => req<PhotoAlbumShare>('POST', `/api/photos/native/albums/${encodeURIComponent(id)}/shares`, { recipientId, permission: 'viewer' }),
      revokeAlbumShare: (albumId: string, shareId: string) => req<{ ok: true }>('DELETE', `/api/photos/native/albums/${encodeURIComponent(albumId)}/shares/${encodeURIComponent(shareId)}`),
      sharedAlbumItems: (shareId: string) => req<{ items: NativePhoto[] }>('GET', `/api/photos/native/albums/shared/${encodeURIComponent(shareId)}/items`),
      upload: (files: File[], onProgress?: (done: number, total: number, pct: number) => void) => {
        return new Promise<{ items: NativePhoto[] }>((resolve, reject) => {
          const account = captureAccountGeneration();
          const form = new FormData();
          files.forEach(f => { form.append('files', f); form.append('lastModified', String(f.lastModified || Date.now())); });
          const xhr = new XMLHttpRequest();
          const abort = () => xhr.abort();
          const cleanup = () => account.signal.removeEventListener('abort', abort);
          xhr.open('POST', '/api/photos/native/upload');
          if (TOKEN) xhr.setRequestHeader('Authorization', `Bearer ${TOKEN}`);
          xhr.setRequestHeader('X-Aerie-Upload-Length', String(files.reduce((total, file) => total + file.size, 0)));
          xhr.upload.onprogress = (e) => {
            try {
              assertAccountGeneration(account.generation);
              if (e.lengthComputable && onProgress) onProgress(0, files.length, Math.round((e.loaded / e.total) * 100));
            } catch { xhr.abort(); }
          };
          xhr.onload = () => {
            cleanup();
            try {
              assertAccountGeneration(account.generation);
              if (xhr.status < 300) resolve(JSON.parse(xhr.responseText));
              else reject(new Error(xhr.responseText || 'upload_failed'));
            } catch (error) { reject(error); }
          };
          xhr.onerror = () => { cleanup(); reject(new Error('upload_failed')); };
          xhr.onabort = () => { cleanup(); reject(new ApiAccountChangedError()); };
          account.signal.addEventListener('abort', abort, { once: true });
          xhr.send(form);
        });
      },
      thumbUrl: (path: string) => api.url(`/api/photos/native/thumb?path=${encodeURIComponent(path)}`),
      fileUrl: (path: string) => api.url(`/api/photos/native/file?path=${encodeURIComponent(path)}`),
      sharedThumbUrl: (shareId: string, path: string) => api.url(`/api/photos/native/albums/shared/${encodeURIComponent(shareId)}/thumb?path=${encodeURIComponent(path)}`),
      sharedFileUrl: (shareId: string, path: string) => api.url(`/api/photos/native/albums/shared/${encodeURIComponent(shareId)}/file?path=${encodeURIComponent(path)}`),
      remove: (paths: string[]) => req<{ ok: true }>('DELETE', '/api/photos/native', { paths }),
    },
  },

  // ---- books (audiobookshelf) ----
  books: {
    status: () => req<{ configured: boolean }>('GET', '/api/books/status'),
    audiobooks: (limit?: number) => req<Book[]>('GET', `/api/books/audiobooks${limit ? `?limit=${limit}` : ''}`),
    audiobooksPage: (offset = 0, limit = 50, q = '') => req<Paged<Book>>('GET', `/api/books/audiobooks?${pageQuery(offset, limit, { q })}`),
    podcasts: () => req<Book[]>('GET', '/api/books/podcasts'),
    item: (id: string) => req<Book & { chapters: Chapter[]; overview?: string }>('GET', `/api/books/item/${id}`),
    tracks: (id: string) => req<{ ino: string; index: number; title: string; durationSec: number; mimeType: string; streamUrl: string }[]>('GET', `/api/books/tracks/${id}`),
    streamUrl: (id: string) => api.url(`/api/books/stream/${id}`),
    trackUrl: (streamUrl: string) => api.url(streamUrl),
    coverUrl: (url: string) => api.url(url),
    progress: (id: string, currentTime: number, duration: number) => req('POST', '/api/books/progress', { id, currentTime, duration }),
  },

  // ---- documents / spreadsheets ----
  docs: {
    list: () => req<DocMeta[]>('GET', '/api/docs'),
    import: (file: File) => {
      const form = new FormData(); form.append('file', file);
      return req<{ path: string; warnings: string[] }>('POST', '/api/docs/import', undefined, { form });
    },
    importExisting: (path: string) => req<{ path: string; warnings: string[] }>('POST', '/api/docs/import-existing', { path }),
    export: async (path: string, format: 'docx' | 'odt') => {
      const account = captureAccountGeneration();
      const response = await req<Response>('GET', `/api/docs/export?path=${encodeURIComponent(path)}&format=${format}`, undefined, { raw: true });
      const blob = await response.blob();
      assertAccountGeneration(account.generation);
      return blob;
    },
  },
  sheets: {
    list: () => req<DocMeta[]>('GET', '/api/sheets'),
    parseCsv: (path: string) => req<{ grid: string[][] }>('GET', `/api/sheets/parse-csv?path=${encodeURIComponent(path)}`),
    import: (file: File) => {
      const form = new FormData(); form.append('file', file);
      return req<{ path: string; warnings: string[] }>('POST', '/api/sheets/import', undefined, { form });
    },
    importExisting: (path: string) => req<{ path: string; warnings: string[] }>('POST', '/api/sheets/import-existing', { path }),
    export: async (path: string, format: 'xlsx' | 'ods') => {
      const account = captureAccountGeneration();
      const response = await req<Response>('GET', `/api/sheets/export?path=${encodeURIComponent(path)}&format=${format}`, undefined, { raw: true });
      const blob = await response.blob();
      assertAccountGeneration(account.generation);
      return blob;
    },
  },

  // ---- ai ----
  ai: {
    status: () => req<{ available: boolean; models: string[]; provider: string; external: boolean; consentRequired: boolean }>('GET', '/api/ai/status'),
    docAction: (action: string, text: string, targetLanguage?: string) => req<{
      action: string; original: string; suggestion: string; provider?: 'local' | 'external'; targetLanguage?: string;
    }>('POST', '/api/ai/doc-action', { action, text, ...(targetLanguage ? { targetLanguage } : {}) }),
    // Speech-to-text via local Whisper. pcmBase64 = 16kHz mono 16-bit LE PCM (base64).
    transcribe: (pcmBase64: string, lang = 'en') => req<{ text: string }>('POST', '/api/ai/transcribe', { pcm: pcmBase64, lang }),
    transcribeStatus: () => req<{ available: boolean }>('GET', '/api/ai/transcribe/status'),
    // Interpret a spoken command into an editor action.
    voiceCommand: (transcript: string, kind: 'sheet' | 'doc', context?: string) => req<any>('POST', '/api/ai/voice-command', { transcript, kind, context }),
    sheetAction: (action: string, grid: any) => req<{ action: string; suggestion: string }>('POST', '/api/ai/sheet-action', { action, grid }),
    // Agentic assistant with tools. onEvent gets {type:'tool'|'tool_result'|'text'|'done', ...}.
    agent: async (messages: { role: string; content: string }[], onEvent: (e: any) => void,
      options: { externalConsent?: boolean; signal?: AbortSignal } = {}) => {
      const account = captureAccountGeneration();
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (TOKEN) headers.Authorization = `Bearer ${TOKEN}`;
      if (options.externalConsent) headers['X-Aerie-External-AI-Consent'] = '1';
      const res = await fetch('/api/ai/agent', { method: 'POST', headers, credentials: 'same-origin',
        signal: accountSignal(options.signal, account.signal), body: JSON.stringify({ messages }) });
      assertAccountGeneration(account.generation);
      if (!res.ok || !res.body) throw new Error('ai_unavailable');
      const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = '';
      while (true) {
        const { done, value } = await reader.read(); if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split('\n'); buf = lines.pop() || '';
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const event = JSON.parse(line);
            assertAccountGeneration(account.generation);
            onEvent(event);
          } catch (error) {
            if (error instanceof ApiAccountChangedError) throw error;
          }
        }
      }
      assertAccountGeneration(account.generation);
    },
    // Streaming chat: calls onChunk for each token; returns full text.
    chat: async (messages: { role: string; content: string }[], context: string | undefined, onChunk: (t: string) => void,
      options: { externalConsent?: boolean; signal?: AbortSignal } = {}) => {
      const account = captureAccountGeneration();
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (TOKEN) headers.Authorization = `Bearer ${TOKEN}`;
      if (options.externalConsent) headers['X-Aerie-External-AI-Consent'] = '1';
      const res = await fetch('/api/ai/chat', { method: 'POST', headers, credentials: 'same-origin',
        signal: accountSignal(options.signal, account.signal), body: JSON.stringify({ messages, context }) });
      assertAccountGeneration(account.generation);
      if (!res.ok || !res.body) throw new Error('ai_unavailable');
      const reader = res.body.getReader(); const dec = new TextDecoder(); let full = '';
      while (true) {
        const { done, value } = await reader.read(); if (done) break;
        assertAccountGeneration(account.generation);
        const t = dec.decode(value, { stream: true }); full += t; onChunk(t);
      }
      assertAccountGeneration(account.generation);
      return full;
    },
  },

  // ---- ai images ----
  images: {
    status: () => req<{ available: boolean }>('GET', '/api/images/status'),
    gallery: () => req<GeneratedImage[]>('GET', '/api/images/gallery'),
    generate: (params: any) => req<{ images: GeneratedImage[] }>('POST', '/api/images/generate', params),
    edit: (params: any) => req<{ images: GeneratedImage[] }>('POST', '/api/images/edit', params),
    remove: (id: string) => req('DELETE', `/api/images/${id}`),
    saveToFiles: (id: string, destDir?: string) => req<{ path: string }>('POST', '/api/images/save-to-files', { id, destDir }),
  },

  // ---- native app downloads ----
  apps: () => req<{ schemaVersion: 1; platforms: {
    key: string; label: string; kind: string; available: boolean; url: string | null;
    filename: string | null; sizeBytes: number; sha256: string | null; version: string | null;
    build: number | null; certificateSha256: string | null; minServerVersion: string | null;
    publishedAt: string | null; notes: string | null; signatureAlgorithm: string | null;
    signatureKeyId: string | null; signature: string | null; verified: boolean; signatureVerified: boolean;
  }[] }>('GET', '/api/apps'),

  // ---- requests (jellyseerr) ----
  requests: {
    status: () => req<{ configured: boolean; online: boolean; music?: { configured: boolean; online: boolean } }>('GET', '/api/requests/status'),
    list: () => req<any[]>('GET', '/api/requests'),
    search: (q: string) => req<any[]>('GET', `/api/requests/search?q=${encodeURIComponent(q)}`),
    trending: () => req<any[]>('GET', '/api/requests/trending'),
    create: (mediaType: 'movie' | 'tv', mediaId: number, seasons?: string) => req<{ ok: boolean }>('POST', '/api/requests', { mediaType, mediaId, seasons }),
    imageUrl: (posterUrl: string) => api.url(posterUrl),
    // Music requests via Lidarr
    musicSearch: (q: string) => req<MusicResult[]>('GET', `/api/requests/music/search?q=${encodeURIComponent(q)}`),
    musicTrending: () => req<MusicResult[]>('GET', '/api/requests/music/trending'),
    musicMine: () => req<MusicRequest[]>('GET', '/api/requests/music/mine'),
    // Search results carry a MusicBrainz id; trending chart entries only a name —
    // the server resolves names via Lidarr's lookup.
    requestMusic: (artist: { foreignArtistId?: string; name?: string }) => req<{ ok: boolean; name?: string; already?: boolean }>('POST', '/api/requests/music', artist),
  },

  autorequest: {
    suggestions: () => req<{
      movies: any[];
      tv: any[];
      artists: { name: string; why?: string }[];
      reason?: string;
      profile?: { topGenres: string[]; topArtists: string[] };
    }>('GET', '/api/autorequest/suggestions'),
    run: () => req<{ requested?: { kind: string; title: string; why?: string }; capped?: boolean; none?: boolean; noHistory?: boolean }>('POST', '/api/autorequest/run'),
    status: () => req<{ enabled: boolean; thisWeek: number; cap: number; recent: { title: string; ts: string; meta: any }[] }>('GET', '/api/autorequest/status'),
    setEnabled: (enabled: boolean) => req<{ enabled: boolean }>('POST', '/api/autorequest/enabled', { enabled }),
  },

  // ---- Cast to TV (server-side Google Cast — works from the app too) ----
  cast: {
    devices: (refresh = false) => req<{ ip: string; name: string }[]>('GET', `/api/cast/devices${refresh ? '?refresh=1' : ''}`),
    play: (ip: string, itemId: string, positionSec = 0, controllerGeneration?: string) =>
      req<{ ok: boolean; canSeek: boolean; offset: number; controllerGeneration: string }>('POST', '/api/cast/play', {
        ip, itemId, positionSec, ...(controllerGeneration ? { controllerGeneration } : {}),
      }),
    playAudio: (ip: string, track: { source: 'jellyfin' | 'audiobookshelf'; itemId: string; fileId?: string }, positionSec = 0,
      controllerGeneration?: string) => req<{ ok: boolean; canSeek: boolean; offset: number; controllerGeneration: string }>(
      'POST', '/api/cast/play-audio', { ip, ...track, positionSec, ...(controllerGeneration ? { controllerGeneration } : {}) },
    ),
    control: (ip: string, action: 'play' | 'pause' | 'stop' | 'seek' | 'quit', value?: number, controllerGeneration?: string) =>
      req<{ ok: boolean }>('POST', '/api/cast/control', { ip, action, value, ...(controllerGeneration ? { controllerGeneration } : {}) }),
    status: (ip: string, controllerGeneration?: string) => req<{
      active: boolean; playerState?: string; idleReason?: string; currentTime?: number; duration?: number; controllerGeneration?: string;
    }>('GET', `/api/cast/status?ip=${encodeURIComponent(ip)}${controllerGeneration ? `&controllerGeneration=${encodeURIComponent(controllerGeneration)}` : ''}`),
  },

  // ---- AI music generation (ace-step) ----
  musicGen: {
    status: () => req<{ up: boolean; queue?: number }>('GET', '/api/music-gen/status'),
    tracks: () => req<any[]>('GET', '/api/music-gen/tracks'),
    generate: (params: { prompt: string; lyrics?: string; durationSec?: number; steps?: number; guidance?: number }) => req<{ id: string; status: string }>('POST', '/api/music-gen/generate', params),
    remove: (id: string) => req('DELETE', `/api/music-gen/${id}`),
    audioUrl: (url: string) => api.url(url),
  },

  // ---- search ----
  search: (q: string, kind = 'all', modified = 'any') => req<SearchResponse>('GET',
    `/api/search?q=${encodeURIComponent(q)}&kind=${encodeURIComponent(kind)}&modified=${encodeURIComponent(modified)}`)
    .then(r => ({ ...r, groups: (r.groups || []).map(g => ({ ...g, results: g.results.map(x => ({ ...x, thumbUrl: tokUrl(x.thumbUrl) })) })) })),

  // ---- shares ----
  shares: {
    list: () => req<Share[]>('GET', '/api/shares'),
    create: (params: any) => req<Share>('POST', '/api/shares', params),
    remove: (id: string) => req('DELETE', `/api/shares/${id}`),
    public: (id: string) => req<{ id: string; name: string; hasPassword: boolean; allowDownload: boolean; isFolder: boolean; sizeBytes: number | null; expiresAt: string | null }>('GET', `/api/shares/public/${id}`),
    open: (id: string, password?: string) => req<{ ok: boolean; name: string; allowDownload: boolean; isFolder: boolean; sizeBytes: number | null }>('POST', `/api/shares/public/${id}/open`, { password }),
    publicList: (id: string, path = '') => req<{ path: string; entries: { name: string; path: string; isFolder: boolean; size: number; modifiedAt: string; kind: string }[] }>('GET', `/api/shares/public/${id}/list${path ? `?path=${encodeURIComponent(path)}` : ''}`),
    // Share sessions are HttpOnly cookies. Never append an account token or a
    // password to this public capability URL.
    publicDownloadUrl: (id: string, path = '') => `/api/shares/public/${id}/download${path ? `?path=${encodeURIComponent(path)}` : ''}`,
  },

  accountShares: {
    received: () => req<AccountShare[]>('GET', '/api/shares/account/received'),
    owned: () => req<AccountShare[]>('GET', '/api/shares/account/owned'),
    create: (path: string, recipientId: number, permission: AccountSharePermission) =>
      req<AccountShare>('POST', '/api/shares/account', { path, recipientId, permission }),
    setPermission: (id: string, permission: AccountSharePermission) =>
      req<{ ok: true; permission: AccountSharePermission }>('PATCH', `/api/shares/account/${id}`, { permission }),
    revoke: (id: string) => req<{ ok: true }>('DELETE', `/api/shares/account/${id}`),
    leave: (id: string) => req<{ ok: true }>('DELETE', `/api/shares/account/${id}/leave`),
    list: (id: string, path = '', sort = 'name', dir: 'asc' | 'desc' = 'asc') =>
      req<FileListing>('GET', `/api/shares/account/${id}/list?path=${encodeURIComponent(path)}&sort=${encodeURIComponent(sort)}&dir=${dir}`),
    rawUrl: (id: string, path = '', download = false) =>
      `/api/shares/account/${id}/raw?path=${encodeURIComponent(path)}${download ? '&download=1' : ''}`,
    thumbUrl: (id: string, path = '') =>
      `/api/shares/account/${id}/thumb?path=${encodeURIComponent(path)}`,
    content: (id: string, path = '') => req<{ path: string; content: string; revision: string; modifiedAt: string; permission: AccountSharePermission }>(
      'GET', `/api/shares/account/${id}/content?path=${encodeURIComponent(path)}`),
    saveContent: (id: string, path: string, content: string, revision?: string) =>
      req<{ ok: true; revision: string; versionId?: string }>('POST', `/api/shares/account/${id}/content`, { path, content, revision }),
    createFile: (id: string, path: string, name: string, content = '') =>
      req<{ ok: true; path: string; revision: string }>('POST', `/api/shares/account/${id}/create`, { path, name, content }),
    mkdir: (id: string, path: string, name: string) =>
      req<{ ok: true; path: string }>('POST', `/api/shares/account/${id}/mkdir`, { path, name }),
    rename: (id: string, path: string, newName: string) =>
      req<{ ok: true; path: string }>('POST', `/api/shares/account/${id}/rename`, { path, newName }),
    remove: (id: string, paths: string[]) =>
      req<{ ok: true; deleted: number }>('POST', `/api/shares/account/${id}/delete`, { paths }),
    versions: (id: string, path: string) =>
      req<DocVersion[]>('GET', `/api/shares/account/${id}/versions?path=${encodeURIComponent(path)}`),
    restoreVersion: (id: string, path: string, versionId: string, revision?: string) =>
      req<{ ok: true; revision: string }>('POST', `/api/shares/account/${id}/versions/restore`, { path, versionId, revision }),
    upload: (id: string, path: string, files: File[], relativePaths?: string[], onProgress?: (pct: number) => void) =>
      new Promise<{ ok: true; saved: string[] }>((resolve, reject) => {
        const account = captureAccountGeneration();
        const form = new FormData();
        form.append('path', path);
        files.forEach((file, index) => {
          form.append('files', file);
          form.append('relativePaths', relativePaths?.[index] || file.name);
        });
        const xhr = new XMLHttpRequest();
        const abort = () => xhr.abort();
        const cleanup = () => account.signal.removeEventListener('abort', abort);
        xhr.open('POST', `/api/shares/account/${id}/upload`);
        if (TOKEN) xhr.setRequestHeader('Authorization', `Bearer ${TOKEN}`);
        xhr.setRequestHeader('X-Aerie-Upload-Length', String(files.reduce((total, file) => total + file.size, 0)));
        xhr.upload.onprogress = event => {
          try {
            assertAccountGeneration(account.generation);
            if (event.lengthComputable) onProgress?.(Math.round(event.loaded / event.total * 100));
          } catch { xhr.abort(); }
        };
        xhr.onload = () => {
          cleanup();
          try {
            assertAccountGeneration(account.generation);
            if (xhr.status < 300) resolve(JSON.parse(xhr.responseText));
            else {
              let message = 'upload_failed';
              try { message = JSON.parse(xhr.responseText)?.error || message; } catch { /* malformed response */ }
              reject(new Error(message));
            }
          } catch (error) { reject(error); }
        };
        xhr.onerror = () => { cleanup(); reject(new Error('upload_failed')); };
        xhr.onabort = () => { cleanup(); reject(new ApiAccountChangedError()); };
        account.signal.addEventListener('abort', abort, { once: true });
        xhr.send(form);
      }),
  },

  // ---- admin ----
  admin: {
    users: () => req<User[]>('GET', '/api/admin/users'),
    invites: () => req<{ items: HouseholdInvite[] }>('GET', '/api/admin/invites'),
    createInvite: (params: AdminUserParams & { expiresInHours?: number }) =>
      req<{ invite: HouseholdInvite; token: string }>('POST', '/api/admin/invites', params),
    revokeInvite: (id: string) => req<{ ok: boolean }>('DELETE', `/api/admin/invites/${encodeURIComponent(id)}`),
    createUser: (params: AdminUserParams) => req<User>('POST', '/api/admin/users', params),
    updateUser: (id: number, params: AdminUserParams) => req<User>('PATCH', `/api/admin/users/${id}`, params),
    deactivateUser: (id: number) => req<{ ok: boolean; disabledAt: string }>('DELETE', `/api/admin/users/${id}`),
    restoreUser: (id: number) => req<User>('POST', `/api/admin/users/${id}/restore`),
    settings: () => req<any>('GET', '/api/admin/settings'),
    saveSettings: (params: any) => req('POST', '/api/admin/settings', params),
  },

  // ---- integrations (admin) ----
  integrations: {
    get: () => req<{ fields: Record<string, { value?: string; set: boolean; source: 'app' | 'env' | 'none' }> }>('GET', '/api/integrations'),
    // Send only changed keys; an empty string clears the in-app override (env fallback applies).
    save: (changes: Record<string, string>) => req<{ ok: boolean; applied: string[] }>('PUT', '/api/integrations', changes),
    test: (service: string) => req<{ ok: boolean; detail: string }>('POST', `/api/integrations/test/${service}`),
  },

  // ---- monitoring / backups / activity / automations / devices / notifications / settings ----
  monitoring: {
    all: () => req<{ health: SystemHealth; services: ServiceStatus[] }>('GET', '/api/monitoring'),
    health: () => req<SystemHealth>('GET', '/api/monitoring/health'),
    services: () => req<ServiceStatus[]>('GET', '/api/monitoring/services'),
    transcoding: () => req<any>('GET', '/api/monitoring/transcoding'),
    alerts: () => req<any>('GET', '/api/monitoring/alerts'),
    saveAlerts: (settings: { enabled: boolean; storagePct: number; cpuPct: number; memoryPct: number }) => req('POST', '/api/monitoring/alerts/settings', settings),
  },
  backups: {
    list: () => req<BackupStatus[]>('GET', '/api/backups'),
    configuration: () => req<BackupConfiguration>('GET', '/api/backups/configuration'),
    history: () => req<any[]>('GET', '/api/backups/history'),
    run: () => req('POST', '/api/backups/run'),
    restore: (name: string) => req<{ ok: boolean; note: string }>('POST', '/api/backups/restore', { name }),
  },
  activity: (limit = 100) => req<AuditEvent[]>('GET', `/api/activity?limit=${limit}`),
  automations: {
    list: () => req<Automation[]>('GET', '/api/automations'),
    toggle: (id: string) => req<Automation>('POST', `/api/automations/${id}/toggle`),
  },
  devices: {
    list: () => req<Device[]>('GET', '/api/devices'),
    heartbeat: (name: string, type: string) => req<Device>('POST', '/api/devices/heartbeat', { name, type }),
    revoke: (id: string) => req('DELETE', `/api/devices/${id}`),
    revokeOthers: () => req('POST', '/api/devices/revoke-others'),
  },
  deviceTrust: {
    list: () => req<any[]>('GET', '/api/device-trust'),
    createPairing: (params: { name: string; type: string; capabilities: string[] }) =>
      req<any>('POST', '/api/device-trust/pairings', params),
    pairing: (id: string) => req<any>('GET', `/api/device-trust/pairings/${id}`),
    cancelPairing: (id: string) => req('DELETE', `/api/device-trust/pairings/${id}`),
    revoke: (id: string) => req('DELETE', `/api/device-trust/${id}`),
  },
  deviceFabric: {
    presence: (params: any) => req<any>('POST', '/api/device-fabric/presence', params),
    devices: () => req<{ currentDeviceId: string; devices: any[] }>('GET', '/api/device-fabric/devices'),
    inbox: () => req<{ deviceId: string; messages: any[] }>('GET', '/api/device-fabric/inbox'),
    send: (targetDeviceId: string, kind: string, payload: any) =>
      req<any>('POST', '/api/device-fabric/messages', { targetDeviceId, kind, payload }),
    ack: (id: string) => req('POST', `/api/device-fabric/messages/${id}/ack`),
    meshTicket: (sourceDeviceId: string, resource: any) =>
      req<any>('POST', '/api/device-fabric/mesh/tickets', { sourceDeviceId, resource }),
    subscribe: (onEvent: (event: any) => void): (() => void) => {
      let account: ReturnType<typeof captureAccountGeneration>;
      try { account = captureAccountGeneration(); } catch { return () => {}; }
      let es: EventSource | null = null;
      const close = () => { try { es?.close(); } catch { /* */ } };
      try {
        es = new EventSource('/api/device-fabric/events');
        es.onmessage = message => {
          try { assertAccountGeneration(account.generation); onEvent(JSON.parse(message.data)); }
          catch (error) { if (error instanceof ApiAccountChangedError) close(); }
        };
        account.signal.addEventListener('abort', close, { once: true });
      } catch { /* browser without SSE */ }
      return () => { account.signal.removeEventListener('abort', close); close(); };
    },
  },
  drive: {
    credentials: () => req<{ items: any[]; mountUrl: string; username: string }>('GET', '/api/drive/credentials'),
    createCredential: (name: string) => req<any>('POST', '/api/drive/credentials', { name }),
    revokeCredential: (id: string) => req('DELETE', `/api/drive/credentials/${id}`),
    // Best-effort cleanup for an unacknowledged one-time password during page
    // teardown. keepalive lets the revocation finish after navigation/unload.
    revokeCredentialOnUnload: (id: string) => {
      let account: ReturnType<typeof captureAccountGeneration>;
      try { account = captureAccountGeneration(); } catch { return; }
      const headers: Record<string, string> = {};
      if (TOKEN) headers.Authorization = `Bearer ${TOKEN}`;
      void fetch(`/api/drive/credentials/${encodeURIComponent(id)}`, {
        method: 'DELETE', headers, credentials: 'same-origin', keepalive: true, signal: account.signal,
      }).then(() => assertAccountGeneration(account.generation)).catch(() => undefined);
    },
  },
  notifications: {
    list: () => req<Notification[]>('GET', '/api/notifications'),
    read: (id?: string) => req('POST', '/api/notifications/read', { id }),
    // Live push via SSE. onEvent gets {type:'notification',...}. Returns unsubscribe.
    subscribe: (onEvent: (e: any) => void): (() => void) => {
      let account: ReturnType<typeof captureAccountGeneration>;
      try { account = captureAccountGeneration(); } catch { return () => {}; }
      let es: EventSource | null = null;
      const close = () => { try { es?.close(); } catch { /* */ } };
      try {
        es = new EventSource('/api/notifications/stream');
        es.onmessage = (m) => {
          try {
            assertAccountGeneration(account.generation);
            const d = JSON.parse(m.data);
            if (d.type === 'notification') onEvent(d);
          } catch (error) { if (error instanceof ApiAccountChangedError) close(); }
        };
        account.signal.addEventListener('abort', close, { once: true });
      } catch { /* */ }
      return () => { account.signal.removeEventListener('abort', close); close(); };
    },
  },
  settings: {
    get: () => req<{ user: User; preferences: any; translationCapabilities: TranslationCapabilities }>('GET', '/api/settings'),
    profile: (params: any) => req<User>('PATCH', '/api/settings/profile', params),
    avatar: {
      upload: (file: File) => { const form = new FormData(); form.append('file', file); return req<User>('POST', '/api/settings/avatar', undefined, { form }); },
      remove: () => req<User>('DELETE', '/api/settings/avatar'),
    },
    password: (current: string, next: string) => req('POST', '/api/settings/password', { current, next }),
    preferences: (params: any) => req<{ preferences: any }>('PATCH', '/api/settings/preferences', params),
    twoFa: {
      status: () => req<{ enabled: boolean; recoveryCodesRemaining: number }>('GET', '/api/settings/2fa'),
      setup: (password: string) => req<{ secret: string; otpauth: string }>('POST', '/api/settings/2fa/setup', { password }),
      enable: (code: string) => req<{ ok: boolean; enabled: boolean; recoveryCodes: string[] }>('POST', '/api/settings/2fa/enable', { code }),
      disable: (password: string) => req<{ ok: boolean }>('POST', '/api/settings/2fa/disable', { password }),
    },
  },
};

export { ApiError };
