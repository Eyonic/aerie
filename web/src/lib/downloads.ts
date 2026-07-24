// Account-scoped offline media downloads. Cache Storage and metadata are both
// partitioned by the current Aerie origin plus the server-issued immutable user
// id. The service worker will only read a cache after this page binds its client
// to the same account.
import type { MediaItem } from './model';

const CACHE_PREFIX = 'aerie-media-v2-';
const META_PREFIX = 'aerie-downloads-v2:';
const LEGACY_CACHE = 'cloudbox-media';
const LEGACY_META = 'cb_downloads';
const MEDIA_PATH = /^\/api\/(books|media)\/(stream|file|offline)\//;

export interface DownloadMeta {
  id: string;
  url: string;
  title: string;
  subtitle?: string;
  artUrl?: string;
  kind: 'music' | 'audiobook' | 'podcast' | 'video';
  mediaItem?: MediaItem;
  sizeBytes: number;
  savedAt: number;
}

export interface OfflineAccountScope {
  accountId: number;
  serverOrigin: string;
  key: string;
  cacheName: string;
  metadataKey: string;
}

type StoredDownloadMeta = DownloadMeta & { ownerScope: string };
type DownloadInput = Omit<DownloadMeta, 'sizeBytes' | 'savedAt'>;

let activeScope: OfflineAccountScope | null = null;
let activeScopeTransition = 0;
let scopeTransition = 0;
const listeners = new Set<() => void>();
const activeTransfers = new Map<string, Set<AbortController>>();

function storage(): Storage | null {
  try { return typeof localStorage === 'undefined' ? null : localStorage; }
  catch { return null; }
}

function runtimeOrigin(): string {
  if (typeof location === 'undefined' || !location.origin) throw new Error('offline_origin_unavailable');
  return location.origin;
}

function normalizeOrigin(value: string): string {
  const url = new URL(value);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('offline_origin_invalid');
  return url.origin;
}

function hex(value: string): string {
  return Array.from(new TextEncoder().encode(value), byte => byte.toString(16).padStart(2, '0')).join('');
}

export function offlineAccountScope(accountId: number, serverOrigin = runtimeOrigin()): OfflineAccountScope {
  if (!Number.isSafeInteger(accountId) || accountId < 1) throw new Error('offline_account_invalid');
  const origin = normalizeOrigin(serverOrigin);
  const originKey = hex(origin);
  const key = `${origin}#${accountId}`;
  return {
    accountId,
    serverOrigin: origin,
    key,
    cacheName: `${CACHE_PREFIX}${originKey}-u${accountId}`,
    metadataKey: `${META_PREFIX}${originKey}:u${accountId}`,
  };
}

export function tokenFreeCacheKey(input: string, serverOrigin = runtimeOrigin()): string {
  const origin = normalizeOrigin(serverOrigin);
  const url = new URL(input, origin);
  if (url.origin !== origin || !MEDIA_PATH.test(url.pathname)) throw new Error('offline_url_invalid');
  url.hash = '';
  url.searchParams.delete('token');
  url.searchParams.delete('access_token');
  url.searchParams.sort();
  return url.toString();
}

function stripToken(input: string | undefined, serverOrigin: string): string | undefined {
  if (!input) return undefined;
  try {
    const url = new URL(input, serverOrigin);
    if (url.origin !== serverOrigin) return undefined;
    url.searchParams.delete('token');
    url.searchParams.delete('access_token');
    return url.toString();
  } catch { return undefined; }
}

function sanitizedMediaItem(item: MediaItem | undefined, serverOrigin: string): MediaItem | undefined {
  if (!item) return undefined;
  return {
    ...item,
    posterUrl: stripToken(item.posterUrl, serverOrigin),
    backdropUrl: stripToken(item.backdropUrl, serverOrigin),
    thumbUrl: stripToken(item.thumbUrl, serverOrigin),
  };
}

function isStoredMeta(value: unknown, scope: OfflineAccountScope): value is StoredDownloadMeta {
  if (!value || typeof value !== 'object') return false;
  const item = value as Partial<StoredDownloadMeta>;
  return item.ownerScope === scope.key
    && typeof item.id === 'string'
    && typeof item.url === 'string'
    && typeof item.title === 'string'
    && ['music', 'audiobook', 'podcast', 'video'].includes(String(item.kind))
    && typeof item.sizeBytes === 'number'
    && Number.isFinite(item.sizeBytes)
    && typeof item.savedAt === 'number'
    && Number.isFinite(item.savedAt);
}

function readMeta(scope = activeScope): DownloadMeta[] {
  if (!scope) return [];
  try {
    const parsed: unknown = JSON.parse(storage()?.getItem(scope.metadataKey) || '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(item => isStoredMeta(item, scope)).map(({ ownerScope: _owner, ...item }) => item);
  } catch { return []; }
}

function writeMeta(scope: OfflineAccountScope, list: DownloadMeta[]): void {
  const records: StoredDownloadMeta[] = list.map(item => ({ ...item, ownerScope: scope.key }));
  const target = storage();
  if (!target) throw new Error('offline_metadata_unavailable');
  try { target.setItem(scope.metadataKey, JSON.stringify(records)); }
  catch { throw new Error('offline_metadata_unavailable'); }
}

function emitChange(): void {
  for (const listener of listeners) {
    try { listener(); } catch { /* one view must not block cache locking */ }
  }
}

function serviceWorkers(): ServiceWorkerContainer | null {
  return typeof navigator !== 'undefined' && 'serviceWorker' in navigator ? navigator.serviceWorker : null;
}

async function postToServiceWorker(message: Record<string, unknown>): Promise<void> {
  const container = serviceWorkers();
  if (!container) return;
  const sent = new Set<ServiceWorker>();
  if (container.controller) {
    try {
      container.controller.postMessage(message);
      sent.add(container.controller);
    } catch { /* a replacing worker may become active below */ }
  }
  try {
    const registration = await container.getRegistration();
    if (registration?.active && !sent.has(registration.active)) registration.active.postMessage(message);
  } catch { /* a new install will bind on controllerchange */ }
}

async function purgeLegacySharedStorage(): Promise<void> {
  // The legacy cache had no owner information. Assigning it to whichever member
  // logs in first could disclose another member's media, so migration is deletion.
  try { storage()?.removeItem(LEGACY_META); } catch { /* never read it again */ }
  if (typeof caches !== 'undefined') {
    try { await caches.delete(LEGACY_CACHE); } catch { /* the new worker never reads it */ }
  }
}

function abortTransfers(scope: OfflineAccountScope): void {
  const transfers = activeTransfers.get(scope.key);
  if (!transfers) return;
  for (const controller of transfers) controller.abort('offline_account_locked');
  activeTransfers.delete(scope.key);
}

async function lockScope(scope: OfflineAccountScope, allClients: boolean): Promise<void> {
  abortTransfers(scope);
  if (activeScope?.key === scope.key) {
    activeScope = null;
    activeScopeTransition = 0;
  }
  // Update mounted download views before waiting for service-worker discovery.
  emitChange();
  await postToServiceWorker({
    type: 'AERIE_OFFLINE_LOCK',
    accountId: scope.accountId,
    serverOrigin: scope.serverOrigin,
    allClients,
  });
}

// Remove shared metadata immediately, even before authentication has completed.
try { storage()?.removeItem(LEGACY_META); } catch { /* never read it again */ }

const workerContainer = serviceWorkers();
workerContainer?.addEventListener('controllerchange', () => {
  if (activeScope) void postToServiceWorker({
    type: 'AERIE_OFFLINE_ACTIVATE',
    accountId: activeScope.accountId,
    serverOrigin: activeScope.serverOrigin,
  });
});

export const downloads = {
  supported(): boolean {
    return typeof caches !== 'undefined' && serviceWorkers() !== null;
  },

  async activate(accountId: number, serverOrigin?: string): Promise<void> {
    const transition = ++scopeTransition;
    const previous = activeScope;
    let next: OfflineAccountScope;
    try { next = offlineAccountScope(accountId, serverOrigin ?? runtimeOrigin()); }
    catch (error) {
      if (previous) await lockScope(previous, false);
      throw error;
    }
    if (previous && previous.key !== next.key) await lockScope(previous, false);
    if (transition !== scopeTransition) return;
    activeScope = next;
    activeScopeTransition = transition;
    await purgeLegacySharedStorage();
    if (transition !== scopeTransition) {
      if (activeScopeTransition === transition) {
        activeScope = null;
        activeScopeTransition = 0;
      }
      return;
    }
    await postToServiceWorker({
      type: 'AERIE_OFFLINE_ACTIVATE',
      accountId: next.accountId,
      serverOrigin: next.serverOrigin,
    });
    if (transition !== scopeTransition) {
      if (activeScopeTransition === transition) await lockScope(next, false);
      return;
    }
    emitChange();
  },

  async lock(accountId?: number, serverOrigin?: string): Promise<void> {
    ++scopeTransition;
    const current = activeScope;
    let requested: OfflineAccountScope | null = null;
    try {
      if (accountId !== undefined) requested = offlineAccountScope(accountId, serverOrigin ?? runtimeOrigin());
    } catch (error) {
      if (current) await lockScope(current, true);
      else await postToServiceWorker({ type: 'AERIE_OFFLINE_LOCK', allClients: false });
      throw error;
    }
    if (current) {
      await lockScope(current, true);
      if (requested && requested.key !== current.key) await lockScope(requested, true);
      return;
    }
    if (requested) {
      await lockScope(requested, true);
      return;
    }
    await postToServiceWorker({ type: 'AERIE_OFFLINE_LOCK', allClients: false });
    emitChange();
  },

  onChange(listener: () => void): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  },

  list(): DownloadMeta[] {
    return readMeta().sort((a, b) => b.savedAt - a.savedAt);
  },

  has(id: string): boolean {
    return readMeta().some(item => item.id === id);
  },

  // Download with progress. onProgress gets 0..1 (or -1 when total is unknown).
  async save(meta: DownloadInput, onProgress?: (progress: number) => void): Promise<void> {
    if (!this.supported()) throw new Error('offline_unsupported');
    const scope = activeScope;
    if (!scope) throw new Error('offline_account_locked');
    const cacheKey = tokenFreeCacheKey(meta.url, scope.serverOrigin);
    const controller = new AbortController();
    const transfers = activeTransfers.get(scope.key) || new Set<AbortController>();
    transfers.add(controller);
    activeTransfers.set(scope.key, transfers);

    try {
      const response = await fetch(meta.url, { signal: controller.signal });
      if (!response.ok || !response.body) throw new Error(`download_failed_${response.status}`);
      const total = Number(response.headers.get('content-length')) || 0;
      const cache = await caches.open(scope.cacheName);
      const [progressBody, cacheBody] = response.body.tee();
      const reader = progressBody.getReader();
      let received = 0;
      const headers = new Headers({
        'Content-Type': response.headers.get('content-type') || (meta.kind === 'video' ? 'video/mp4' : 'audio/mpeg'),
        'Accept-Ranges': 'bytes',
        'X-Aerie-Offline-Scope': scope.key,
      });
      if (total) headers.set('Content-Length', String(total));
      const put = cache.put(cacheKey, new Response(cacheBody, { status: 200, headers })).then(
        () => ({ ok: true as const }),
        error => ({ ok: false as const, error }),
      );
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value.length;
        onProgress?.(total ? received / total : -1);
      }
      const putResult = await put;
      if ('error' in putResult) throw putResult.error;
      if (activeScope?.key !== scope.key || controller.signal.aborted) {
        await cache.delete(cacheKey);
        throw new Error('offline_account_changed');
      }
      const list = readMeta(scope).filter(item => item.id !== meta.id);
      list.push({
        ...meta,
        url: cacheKey,
        artUrl: stripToken(meta.artUrl, scope.serverOrigin),
        mediaItem: sanitizedMediaItem(meta.mediaItem, scope.serverOrigin),
        sizeBytes: total || received,
        savedAt: Date.now(),
      });
      try { writeMeta(scope, list); }
      catch (error) {
        await cache.delete(cacheKey);
        throw error;
      }
      emitChange();
    } finally {
      transfers.delete(controller);
      if (!transfers.size) activeTransfers.delete(scope.key);
    }
  },

  async remove(id: string): Promise<void> {
    const scope = activeScope;
    if (!scope) throw new Error('offline_account_locked');
    const list = readMeta(scope);
    const item = list.find(download => download.id === id);
    if (item && this.supported()) {
      const cache = await caches.open(scope.cacheName);
      await cache.delete(item.url);
    }
    writeMeta(scope, list.filter(download => download.id !== id));
    emitChange();
  },

  async clear(): Promise<void> {
    const scope = activeScope;
    if (!scope) throw new Error('offline_account_locked');
    abortTransfers(scope);
    if (this.supported()) await caches.delete(scope.cacheName);
    writeMeta(scope, []);
    emitChange();
  },

  totalBytes(): number {
    return readMeta().reduce((sum, item) => sum + (item.sizeBytes || 0), 0);
  },
};
