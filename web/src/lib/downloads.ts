// Offline media downloads. Stores audio (music / audiobooks / podcasts) in the
// Cache Storage API so it plays with no connection. The service worker serves
// any request whose URL is in the 'cloudbox-media' cache from disk first, so the
// existing <audio> element plays offline transparently — no player changes needed.
const CACHE = 'cloudbox-media'; // legacy cache name — keep (must match sw.js; renaming loses users' downloads)
const METAKEY = 'cb_downloads';

export interface DownloadMeta {
  id: string;           // stable id (e.g. book/track id)
  url: string;          // the exact stream URL cached (incl. token) — the cache key
  title: string;
  subtitle?: string;
  artUrl?: string;
  kind: 'music' | 'audiobook' | 'podcast' | 'video';
  mediaItem?: any;
  sizeBytes: number;
  savedAt: number;
}

function readMeta(): DownloadMeta[] {
  try { return JSON.parse(localStorage.getItem(METAKEY) || '[]'); } catch { return []; }
}
function writeMeta(list: DownloadMeta[]) { localStorage.setItem(METAKEY, JSON.stringify(list)); }

export const downloads = {
  supported(): boolean { return typeof caches !== 'undefined'; },

  list(): DownloadMeta[] { return readMeta().sort((a, b) => b.savedAt - a.savedAt); },

  has(id: string): boolean { return readMeta().some(d => d.id === id); },

  // Download with progress. onProgress gets 0..1 (or -1 when total unknown).
  async save(meta: Omit<DownloadMeta, 'sizeBytes' | 'savedAt'>, onProgress?: (p: number) => void): Promise<void> {
    if (!this.supported()) throw new Error('offline_unsupported');
    const res = await fetch(meta.url);
    if (!res.ok || !res.body) throw new Error(`download_failed_${res.status}`);
    const total = Number(res.headers.get('content-length')) || 0;
    const cache = await caches.open(CACHE);
    const u = new URL(meta.url, location.origin);
    const key = u.origin + u.pathname;
    const [progressBody, cacheBody] = res.body.tee();
    const reader = progressBody.getReader();
    let received = 0;
    const headers = new Headers({ 'Content-Type': res.headers.get('content-type') || (meta.kind === 'video' ? 'video/mp4' : 'audio/mpeg'), 'Accept-Ranges': 'bytes' });
    if (total) headers.set('Content-Length', String(total));
    const put = cache.put(key, new Response(cacheBody, { status: 200, headers }));
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.length;
      if (onProgress) onProgress(total ? received / total : -1);
    }
    await put;
    // Cache under the token-free PATH so playback still resolves after re-login
    // (the ?token= changes, the path doesn't). The SW matches by path.
    const list = readMeta().filter(d => d.id !== meta.id);
    list.push({ ...meta, url: key, sizeBytes: total || received, savedAt: Date.now() });
    writeMeta(list);
  },

  async remove(id: string): Promise<void> {
    const list = readMeta();
    const item = list.find(d => d.id === id);
    if (item && this.supported()) { try { const c = await caches.open(CACHE); await c.delete(item.url); } catch { /* */ } }
    writeMeta(list.filter(d => d.id !== id));
  },

  async clear(): Promise<void> {
    if (this.supported()) { try { await caches.delete(CACHE); } catch { /* */ } }
    writeMeta([]);
  },

  totalBytes(): number { return readMeta().reduce((s, d) => s + (d.sizeBytes || 0), 0); },
};
