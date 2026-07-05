// Central typed API client. Every page uses this — no raw fetch in pages.
import type {
  AuthResponse, User, FileListing, FileEntry, StorageUsage, DashboardData,
  MediaItem, Photo, PhotoAlbum, Book, Chapter, DocMeta, AiJob, GeneratedImage,
  Share, ServiceStatus, SystemHealth, BackupStatus, AuditEvent, Device,
  Automation, Notification, SearchResponse, MusicResult, MusicRequest,
} from './model';

let TOKEN: string | null = localStorage.getItem('cb_token');
export function setToken(t: string | null) {
  // Mirror to the native app so it can restore the session across an origin hop.
  try { (window as any).CloudBoxNative?.authToken?.(t || ''); } catch { /* not in app */ }
  TOKEN = t;
  if (t) localStorage.setItem('cb_token', t); else localStorage.removeItem('cb_token');
}
export function getToken() { return TOKEN; }

class ApiError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

async function req<T>(method: string, path: string, body?: any, opts: { raw?: boolean; form?: FormData } = {}): Promise<T> {
  const headers: Record<string, string> = {};
  if (TOKEN) headers.Authorization = `Bearer ${TOKEN}`;
  let payload: any;
  if (opts.form) { payload = opts.form; }
  else if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  const res = await fetch(path, { method, headers, body: payload });
  if (res.status === 401 && !path.includes('/auth/')) {
    setToken(null);
    if (!location.pathname.startsWith('/login')) location.href = '/login';
    throw new ApiError(401, 'unauthorized');
  }
  if (!res.ok) {
    let msg = res.statusText;
    try { const j = await res.json(); msg = j.error || msg; } catch { /* */ }
    throw new ApiError(res.status, msg);
  }
  if (opts.raw) return res as any;
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('application/json')) return res.json();
  return res.text() as any;
}

// Artwork URLs are rendered via bare <img src>, which can't send the Authorization
// header. The httpOnly cookie covers the origin the user logged in on, but not the
// other origin after a native-app network hop — so bake the token into the URLs,
// like every other protected image URL in the app (photos, book covers, thumbs).
const tokUrl = (u?: string) => (u && TOKEN && !u.includes('token=')) ? `${u}${u.includes('?') ? '&' : '?'}token=${TOKEN}` : u;
const tokMedia = <T extends { posterUrl?: string; backdropUrl?: string; thumbUrl?: string }>(it: T): T =>
  ({ ...it, posterUrl: tokUrl(it.posterUrl), backdropUrl: tokUrl(it.backdropUrl), thumbUrl: tokUrl(it.thumbUrl) });
const tokMediaList = (arr: MediaItem[]) => (arr || []).map(tokMedia);

export const api = {
  // token-appended URL for <img>/<video>/<audio> src that hit protected routes
  url: (path: string) => TOKEN ? `${path}${path.includes('?') ? '&' : '?'}token=${TOKEN}` : path,

  // ---- auth ----
  login: (username: string, password: string, code?: string) => req<AuthResponse | { needs2fa: true }>('POST', '/api/auth/login', { username, password, code }),
  logout: () => req('POST', '/api/auth/logout'),
  me: () => req<{ user: User }>('GET', '/api/auth/me'),
  users: () => req<{ id: number; username: string; displayName: string; avatarColor: string }[]>('GET', '/api/auth/users'),

  // ---- dashboard ----
  dashboard: () => req<DashboardData>('GET', '/api/dashboard')
    .then(d => d ? { ...d, continueWatching: tokMediaList(d.continueWatching) } : d),

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
    content: (path: string) => req<{ path: string; content: string }>('GET', `/api/files/content?path=${encodeURIComponent(path)}`),
    saveContent: (path: string, content: string) => req('POST', '/api/files/content', { path, content }),
    create: (path: string, name: string, content = '') => req<{ path: string }>('POST', '/api/files/create', { path, name, content }),
    rawUrl: (path: string, download = false) => api.url(`/api/files/raw?path=${encodeURIComponent(path)}${download ? '&download=1' : ''}`),
    thumbUrl: (path: string) => api.url(`/api/files/thumb?path=${encodeURIComponent(path)}`),
    versions: (path: string) => req<any[]>('GET', `/api/files/versions?path=${encodeURIComponent(path)}`),
    restoreVersion: (path: string, versionId: string) => req('POST', '/api/files/versions/restore', { path, versionId }),
    upload: (path: string, files: File[], relativePaths?: string[], onProgress?: (pct: number) => void) => {
      return new Promise<{ saved: string[] }>((resolve, reject) => {
        const form = new FormData();
        form.append('path', path);
        files.forEach((f, i) => { form.append('files', f); form.append('relativePaths', relativePaths?.[i] || f.name); });
        const xhr = new XMLHttpRequest();
        xhr.open('POST', '/api/files/upload');
        if (TOKEN) xhr.setRequestHeader('Authorization', `Bearer ${TOKEN}`);
        xhr.upload.onprogress = (e) => { if (e.lengthComputable && onProgress) onProgress(Math.round((e.loaded / e.total) * 100)); };
        xhr.onload = () => { xhr.status < 300 ? resolve(JSON.parse(xhr.responseText)) : reject(new Error(xhr.responseText)); };
        xhr.onerror = () => reject(new Error('upload_failed'));
        xhr.send(form);
      });
    },
  },

  // ---- media (jellyfin) ----
  media: {
    status: () => req<{ configured: boolean }>('GET', '/api/media/status'),
    movies: () => req<MediaItem[]>('GET', '/api/media/movies').then(tokMediaList),
    series: () => req<MediaItem[]>('GET', '/api/media/series').then(tokMediaList),
    videos: () => req<MediaItem[]>('GET', '/api/media/videos').then(tokMediaList),
    albums: () => req<MediaItem[]>('GET', '/api/media/music/albums').then(tokMediaList),
    artists: () => req<MediaItem[]>('GET', '/api/media/music/artists').then(tokMediaList),
    songs: () => req<MediaItem[]>('GET', '/api/media/music/songs').then(tokMediaList),
    resumeVideo: () => req<MediaItem[]>('GET', '/api/media/resume/video').then(tokMediaList),
    resumeAudio: () => req<MediaItem[]>('GET', '/api/media/resume/audio').then(tokMediaList),
    item: (id: string) => req<MediaItem>('GET', `/api/media/item/${id}`).then(tokMedia),
    children: (id: string) => req<MediaItem[]>('GET', `/api/media/item/${id}/children`).then(tokMediaList),
    streams: (id: string) => req<{ audio: any[]; subtitles: any[] }>('GET', `/api/media/streams/${id}`),
    subtitleUrl: (url: string) => api.url(url),
    search: (q: string) => req<MediaItem[]>('GET', `/api/media/search?q=${encodeURIComponent(q)}`).then(tokMediaList),
    streamUrl: (id: string, audio = false) => api.url(`/api/media/stream/${id}${audio ? '?audio=1' : ''}`),
    imageUrl: (id: string, type = 'Primary') => api.url(`/api/media/image/${id}/${type}`),
    progress: (id: string, positionTicks: number) => req('POST', '/api/media/progress', { id, positionTicks }),
    setPlayed: (id: string, played: boolean) => req('POST', '/api/media/played', { id, played }),
    recommendations: () => req<{ nextUp: MediaItem[]; suggestions: MediaItem[]; recentlyAdded: MediaItem[] }>('GET', '/api/media/recommendations')
      .then(r => ({ nextUp: tokMediaList(r.nextUp), suggestions: tokMediaList(r.suggestions), recentlyAdded: tokMediaList(r.recentlyAdded) })),
    similar: (id: string) => req<MediaItem[]>('GET', `/api/media/similar/${id}`).then(tokMediaList),
  },

  // ---- photos (photoprism) ----
  photos: {
    status: () => req<{ configured: boolean }>('GET', '/api/photos/status'),
    timeline: (offset = 0, count = 120, q = '') => req<Photo[]>('GET', `/api/photos/timeline?offset=${offset}&count=${count}${q ? `&q=${encodeURIComponent(q)}` : ''}`),
    favorites: () => req<Photo[]>('GET', '/api/photos/favorites'),
    albums: () => req<PhotoAlbum[]>('GET', '/api/photos/albums'),
    album: (uid: string) => req<Photo[]>('GET', `/api/photos/album/${uid}`),
    geo: () => req<{ id: string; uid: string; lat: number; lng: number; thumbUrl: string; previewUrl: string; title: string; takenAt: string; type: string }[]>('GET', '/api/photos/geo'),
    labels: () => req<{ name: string; slug: string; count: number; thumbUrl?: string }[]>('GET', '/api/photos/labels'),
    label: (slug: string) => req<Photo[]>('GET', `/api/photos/label/${encodeURIComponent(slug)}`),
    people: () => req<{ people: { uid: string; name: string; count: number; thumbUrl?: string }[]; faceClusters: number }>('GET', '/api/photos/people'),
    person: (uid: string) => req<Photo[]>('GET', `/api/photos/person/${uid}`),
    thumbUrl: (url: string) => api.url(url),
  },

  // ---- books (audiobookshelf) ----
  books: {
    status: () => req<{ configured: boolean }>('GET', '/api/books/status'),
    audiobooks: () => req<Book[]>('GET', '/api/books/audiobooks'),
    podcasts: () => req<Book[]>('GET', '/api/books/podcasts'),
    item: (id: string) => req<Book & { chapters: Chapter[]; overview?: string }>('GET', `/api/books/item/${id}`),
    tracks: (id: string) => req<{ ino: string; index: number; title: string; durationSec: number; mimeType: string; streamUrl: string }[]>('GET', `/api/books/tracks/${id}`),
    streamUrl: (id: string) => api.url(`/api/books/stream/${id}`),
    trackUrl: (streamUrl: string) => api.url(streamUrl),
    coverUrl: (url: string) => api.url(url),
    progress: (id: string, currentTime: number, duration: number) => req('POST', '/api/books/progress', { id, currentTime, duration }),
  },

  // ---- documents / spreadsheets ----
  docs: { list: () => req<DocMeta[]>('GET', '/api/docs') },
  sheets: {
    list: () => req<DocMeta[]>('GET', '/api/sheets'),
    parseCsv: (path: string) => req<{ grid: string[][] }>('GET', `/api/sheets/parse-csv?path=${encodeURIComponent(path)}`),
  },

  // ---- ai ----
  ai: {
    status: () => req<{ available: boolean; models: string[] }>('GET', '/api/ai/status'),
    docAction: (action: string, text: string) => req<{ action: string; original: string; suggestion: string }>('POST', '/api/ai/doc-action', { action, text }),
    // Speech-to-text via local Whisper. pcmBase64 = 16kHz mono 16-bit LE PCM (base64).
    transcribe: (pcmBase64: string, lang = 'en') => req<{ text: string }>('POST', '/api/ai/transcribe', { pcm: pcmBase64, lang }),
    transcribeStatus: () => req<{ available: boolean }>('GET', '/api/ai/transcribe/status'),
    // Interpret a spoken command into an editor action.
    voiceCommand: (transcript: string, kind: 'sheet' | 'doc', context?: string) => req<any>('POST', '/api/ai/voice-command', { transcript, kind, context }),
    sheetAction: (action: string, grid: any) => req<{ action: string; suggestion: string }>('POST', '/api/ai/sheet-action', { action, grid }),
    // Agentic assistant with tools. onEvent gets {type:'tool'|'tool_result'|'text'|'done', ...}.
    agent: async (messages: { role: string; content: string }[], onEvent: (e: any) => void) => {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (TOKEN) headers.Authorization = `Bearer ${TOKEN}`;
      const res = await fetch('/api/ai/agent', { method: 'POST', headers, body: JSON.stringify({ messages }) });
      if (!res.ok || !res.body) throw new Error('ai_unavailable');
      const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = '';
      while (true) {
        const { done, value } = await reader.read(); if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split('\n'); buf = lines.pop() || '';
        for (const line of lines) { if (line.trim()) { try { onEvent(JSON.parse(line)); } catch { /* */ } } }
      }
    },
    // Streaming chat: calls onChunk for each token; returns full text.
    chat: async (messages: { role: string; content: string }[], context: string | undefined, onChunk: (t: string) => void) => {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (TOKEN) headers.Authorization = `Bearer ${TOKEN}`;
      const res = await fetch('/api/ai/chat', { method: 'POST', headers, body: JSON.stringify({ messages, context }) });
      if (!res.ok || !res.body) throw new Error('ai_unavailable');
      const reader = res.body.getReader(); const dec = new TextDecoder(); let full = '';
      while (true) { const { done, value } = await reader.read(); if (done) break; const t = dec.decode(value, { stream: true }); full += t; onChunk(t); }
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
  apps: () => req<{ platforms: { key: string; label: string; kind: string; available: boolean; url: string | null; filename: string | null; sizeBytes: number }[] }>('GET', '/api/apps'),

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

  // ---- Cast to TV (server-side Google Cast — works from the app too) ----
  cast: {
    devices: (refresh = false) => req<{ ip: string; name: string }[]>('GET', `/api/cast/devices${refresh ? '?refresh=1' : ''}`),
    play: (ip: string, itemId: string, positionSec = 0) => req<{ ok: boolean }>('POST', '/api/cast/play', { ip, itemId, positionSec }),
    control: (ip: string, action: 'play' | 'pause' | 'stop' | 'seek' | 'quit', value?: number) => req<{ ok: boolean }>('POST', '/api/cast/control', { ip, action, value }),
    status: (ip: string) => req<{ active: boolean; playerState?: string; currentTime?: number; duration?: number }>('GET', `/api/cast/status?ip=${encodeURIComponent(ip)}`),
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
  search: (q: string) => req<SearchResponse>('GET', `/api/search?q=${encodeURIComponent(q)}`)
    .then(r => ({ ...r, groups: (r.groups || []).map(g => ({ ...g, results: g.results.map(x => ({ ...x, thumbUrl: tokUrl(x.thumbUrl) })) })) })),

  // ---- shares ----
  shares: {
    list: () => req<Share[]>('GET', '/api/shares'),
    create: (params: any) => req<Share>('POST', '/api/shares', params),
    remove: (id: string) => req('DELETE', `/api/shares/${id}`),
    public: (id: string) => req<{ id: string; name: string; hasPassword: boolean; allowDownload: boolean }>('GET', `/api/shares/public/${id}`),
    open: (id: string, password?: string) => req<{ ok: boolean; download?: string; listing?: any }>('POST', `/api/shares/public/${id}/open`, { password }),
    publicDownloadUrl: (id: string, password?: string) => api.url(`/api/shares/public/${id}/download${password ? `?password=${encodeURIComponent(password)}` : ''}`),
  },

  // ---- admin ----
  admin: {
    users: () => req<User[]>('GET', '/api/admin/users'),
    createUser: (params: any) => req<User>('POST', '/api/admin/users', params),
    updateUser: (id: number, params: any) => req<User>('PATCH', `/api/admin/users/${id}`, params),
    deleteUser: (id: number) => req('DELETE', `/api/admin/users/${id}`),
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
  },
  backups: {
    list: () => req<BackupStatus[]>('GET', '/api/backups'),
    history: () => req<any[]>('GET', '/api/backups/history'),
    run: () => req('POST', '/api/backups/run'),
    restore: (name: string) => req<{ ok: boolean; note: string }>('POST', '/api/backups/restore', { name }),
  },
  activity: (limit = 100) => req<AuditEvent[]>('GET', `/api/activity?limit=${limit}`),
  automations: {
    list: () => req<Automation[]>('GET', '/api/automations'),
    toggle: (id: string) => req<Automation>('POST', `/api/automations/${id}/toggle`),
    create: (params: any) => req<Automation>('POST', '/api/automations', params),
    update: (id: string, params: any) => req<Automation>('PATCH', `/api/automations/${id}`, params),
    remove: (id: string) => req('DELETE', `/api/automations/${id}`),
  },
  devices: {
    list: () => req<Device[]>('GET', '/api/devices'),
    heartbeat: (name: string, type: string) => req<Device>('POST', '/api/devices/heartbeat', { name, type }),
    revoke: (id: string) => req('DELETE', `/api/devices/${id}`),
  },
  notifications: {
    list: () => req<Notification[]>('GET', '/api/notifications'),
    read: (id?: string) => req('POST', '/api/notifications/read', { id }),
    // Live push via SSE. onEvent gets {type:'notification',...}. Returns unsubscribe.
    subscribe: (onEvent: (e: any) => void): (() => void) => {
      let es: EventSource | null = null;
      try {
        es = new EventSource(`/api/notifications/stream${TOKEN ? `?token=${TOKEN}` : ''}`);
        es.onmessage = (m) => { try { const d = JSON.parse(m.data); if (d.type === 'notification') onEvent(d); } catch { /* */ } };
      } catch { /* */ }
      return () => { try { es?.close(); } catch { /* */ } };
    },
  },
  settings: {
    get: () => req<{ user: User; preferences: any }>('GET', '/api/settings'),
    profile: (params: any) => req<User>('PATCH', '/api/settings/profile', params),
    avatar: {
      upload: (file: File) => { const form = new FormData(); form.append('file', file); return req<User>('POST', '/api/settings/avatar', undefined, { form }); },
      remove: () => req<User>('DELETE', '/api/settings/avatar'),
    },
    password: (current: string, next: string) => req('POST', '/api/settings/password', { current, next }),
    preferences: (params: any) => req<{ preferences: any }>('PATCH', '/api/settings/preferences', params),
    twoFa: {
      status: () => req<{ enabled: boolean }>('GET', '/api/settings/2fa'),
      setup: () => req<{ secret: string; otpauth: string }>('POST', '/api/settings/2fa/setup'),
      enable: (code: string) => req<{ ok: boolean; enabled: boolean }>('POST', '/api/settings/2fa/enable', { code }),
      disable: (password: string) => req<{ ok: boolean }>('POST', '/api/settings/2fa/disable', { password }),
    },
  },
};

export { ApiError };
