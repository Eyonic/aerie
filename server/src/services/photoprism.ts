// PhotoPrism client — powers the Photos section. Per-user PhotoPrism instances.
// Session tokens are cached and refreshed on demand.
import { config } from '../config.js';
import type { Photo, PhotoAlbum } from '../lib/model.js';

interface Session { token: string; downloadToken: string; previewToken: string; expires: number; }
const sessions: Record<string, Session> = {};

function instanceFor(username: string): string {
  return config.photoprism.users[username] || config.photoprism.users[config.photoprism.defaultUser];
}

export function configured(): boolean {
  return !!config.photoprism.password && Object.keys(config.photoprism.users).length > 0;
}

export function configuredFor(username: string): boolean {
  if (!configured()) return false;
  const users = config.photoprism.users;
  if (users[username.toLowerCase()]) return true;
  // instanceFor() falls back to the default instance; only treat that as
  // "configured" when PP_DEFAULT was set on purpose (pre-native-photos setups).
  return config.photoprism.explicitDefault && !!users[config.photoprism.defaultUser];
}

async function auth(username: string): Promise<Session> {
  const cached = sessions[username];
  if (cached && cached.expires > Date.now()) return cached;
  const url = instanceFor(username);
  const res = await fetch(`${url}/api/v1/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: config.photoprism.user, password: config.photoprism.password }),
  });
  if (!res.ok) throw new Error(`photoprism auth ${res.status}`);
  const data = await res.json();
  const token = data.id || res.headers.get('X-Session-ID') || '';
  const cfg = data.config || {};
  const sess: Session = {
    token,
    downloadToken: cfg.downloadToken || data.data?.tokens?.download || '',
    previewToken: cfg.previewToken || data.data?.tokens?.preview || '',
    expires: Date.now() + 1000 * 60 * 25,
  };
  sessions[username] = sess;
  return sess;
}

async function pp(username: string, path: string, params: Record<string, any> = {}): Promise<any> {
  const sess = await auth(username);
  const url = new URL(instanceFor(username) + path);
  for (const [k, v] of Object.entries(params)) if (v != null) url.searchParams.set(k, String(v));
  const res = await fetch(url, { headers: { 'X-Session-ID': sess.token } });
  if (res.status === 401) { delete sessions[username]; return pp(username, path, params); }
  if (!res.ok) throw new Error(`photoprism ${res.status} ${path}`);
  return res.json();
}

function mapPhoto(username: string, p: any): Photo {
  return {
    id: p.ID?.toString() || p.UID,
    uid: p.UID,
    title: p.Title || p.FileName || 'Photo',
    takenAt: p.TakenAt || p.CreatedAt,
    thumbUrl: `/api/photos/thumb/${username}/${p.Hash}/tile_500`,
    previewUrl: `/api/photos/thumb/${username}/${p.Hash}/fit_1920`,
    downloadUrl: `/api/photos/download/${username}/${p.UID}`,
    width: p.Width, height: p.Height,
    type: p.Type === 'video' ? 'video' : p.Type === 'live' ? 'live' : p.Type === 'raw' ? 'raw' : 'image',
    favorite: !!p.Favorite,
    camera: p.CameraMake ? `${p.CameraMake} ${p.CameraModel || ''}`.trim() : undefined,
    lat: p.Lat || undefined, lng: p.Lng || undefined,
  };
}

export async function thumbToken(username: string): Promise<string> {
  const s = await auth(username); return s.previewToken;
}
export async function downloadTokenFor(username: string): Promise<string> {
  const s = await auth(username); return s.downloadToken;
}

export async function listPhotos(username: string, opts: { count?: number; offset?: number; q?: string; favorite?: boolean; album?: string } = {}): Promise<Photo[]> {
  const params: any = { count: opts.count || 120, offset: opts.offset || 0, order: 'newest', merged: true };
  if (opts.q) params.q = opts.q;
  if (opts.favorite) params.favorite = true;
  if (opts.album) params.album = opts.album;
  const data = await pp(username, '/api/v1/photos', params);
  return (Array.isArray(data) ? data : []).map(p => mapPhoto(username, p));
}

// Object/scene categories (PhotoPrism labels) — powers an "Explore" view.
export async function listLabels(username: string, count = 60): Promise<{ name: string; slug: string; count: number; thumbUrl?: string }[]> {
  const data = await pp(username, '/api/v1/labels', { count, order: 'count', all: true });
  return (Array.isArray(data) ? data : [])
    .filter((l: any) => (l.PhotoCount || 0) > 0)
    .map((l: any) => ({
      name: l.Name, slug: l.Slug || l.CustomSlug, count: l.PhotoCount,
      thumbUrl: l.Thumb ? `/api/photos/thumb/${username}/${l.Thumb}/tile_500` : undefined,
    }));
}
export async function photosByLabel(username: string, slug: string, count = 500): Promise<Photo[]> {
  const data = await pp(username, '/api/v1/photos', { count, order: 'newest', merged: true, q: `label:${slug}` });
  return (Array.isArray(data) ? data : []).map(p => mapPhoto(username, p));
}

// Named people (face subjects). Empty until faces are named in PhotoPrism.
export async function listPeople(username: string): Promise<{ uid: string; name: string; count: number; thumbUrl?: string }[]> {
  const data = await pp(username, '/api/v1/subjects', { count: 100, type: 'person', order: 'count' });
  return (Array.isArray(data) ? data : []).map((s: any) => ({
    uid: s.UID, name: s.Name, count: s.PhotoCount || s.Files || 0,
    thumbUrl: s.Thumb ? `/api/photos/thumb/${username}/${s.Thumb}/tile_500` : undefined,
  }));
}
export async function photosByPerson(username: string, uid: string, count = 500): Promise<Photo[]> {
  const data = await pp(username, '/api/v1/photos', { count, order: 'newest', merged: true, q: `subject:${uid}` });
  return (Array.isArray(data) ? data : []).map(p => mapPhoto(username, p));
}
export async function faceClusterCount(username: string): Promise<number> {
  try { const d = await pp(username, '/api/v1/faces', { count: 1 }); return Array.isArray(d) ? d.length : 0; } catch { return 0; }
}

export async function listAlbums(username: string): Promise<PhotoAlbum[]> {
  const data = await pp(username, '/api/v1/albums', { count: 100, type: 'album', order: 'newest' });
  const s = await auth(username);
  return (Array.isArray(data) ? data : []).map((a: any) => ({
    uid: a.UID, title: a.Title, count: a.PhotoCount || 0,
    coverUrl: a.Thumb ? `/api/photos/thumb/${username}/${a.Thumb}/tile_500` : undefined,
    type: a.Type,
  }));
}

export { instanceFor };
