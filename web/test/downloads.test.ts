import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

class MemoryStorage {
  private values = new Map<string, string>();

  get length() { return this.values.size; }
  clear() { this.values.clear(); }
  getItem(key: string) { return this.values.get(key) ?? null; }
  key(index: number) { return [...this.values.keys()][index] ?? null; }
  removeItem(key: string) { this.values.delete(key); }
  setItem(key: string, value: string) { this.values.set(key, String(value)); }
  entries() { return [...this.values.entries()]; }
}

function requestKey(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

class MemoryCache {
  readonly values = new Map<string, Response>();

  async match(input: RequestInfo | URL): Promise<Response | undefined> {
    return this.values.get(requestKey(input))?.clone();
  }

  async put(input: RequestInfo | URL, response: Response): Promise<void> {
    this.values.set(requestKey(input), response.clone());
  }

  async delete(input: RequestInfo | URL): Promise<boolean> {
    return this.values.delete(requestKey(input));
  }
}

class MemoryCacheStorage {
  readonly values = new Map<string, MemoryCache>();

  async open(name: string): Promise<MemoryCache> {
    let cache = this.values.get(name);
    if (!cache) {
      cache = new MemoryCache();
      this.values.set(name, cache);
    }
    return cache;
  }

  async delete(name: string): Promise<boolean> { return this.values.delete(name); }
  async keys(): Promise<string[]> { return [...this.values.keys()]; }
}

describe('account-scoped offline downloads', () => {
  let localStorage: MemoryStorage;
  let cacheStorage: MemoryCacheStorage;
  let postMessage: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.resetModules();
    localStorage = new MemoryStorage();
    cacheStorage = new MemoryCacheStorage();
    postMessage = vi.fn();
    const worker = { postMessage };
    vi.stubGlobal('location', { origin: 'https://aerie.example' });
    vi.stubGlobal('localStorage', localStorage);
    vi.stubGlobal('caches', cacheStorage);
    vi.stubGlobal('navigator', {
      serviceWorker: {
        controller: worker,
        addEventListener: vi.fn(),
        getRegistration: vi.fn(async () => ({ active: worker })),
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('uses collision-free server and immutable-user partitions', async () => {
    const { offlineAccountScope } = await import('../src/lib/downloads');
    const first = offlineAccountScope(7, 'https://aerie.example/path');
    const same = offlineAccountScope(7, 'https://aerie.example/elsewhere');
    const otherUser = offlineAccountScope(8, 'https://aerie.example');
    const otherServer = offlineAccountScope(7, 'https://other.example');

    expect(first).toEqual(same);
    expect(new Set([
      first.cacheName,
      otherUser.cacheName,
      otherServer.cacheName,
    ]).size).toBe(3);
    expect(new Set([
      first.metadataKey,
      otherUser.metadataKey,
      otherServer.metadataKey,
    ]).size).toBe(3);
  });

  it('deletes ownerless legacy data and never persists bearer tokens', async () => {
    localStorage.setItem('cb_downloads', JSON.stringify([{ id: 'someone-elses-media' }]));
    await (await cacheStorage.open('cloudbox-media')).put(
      'https://aerie.example/api/media/offline/legacy',
      new Response('private'),
    );
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array([1, 2, 3]), {
      status: 200,
      headers: { 'content-type': 'audio/mpeg', 'content-length': '3' },
    })));

    const { downloads, offlineAccountScope } = await import('../src/lib/downloads');
    await downloads.activate(7);
    await downloads.save({
      id: 'track-1',
      url: '/api/media/offline/track-1?token=top-secret&quality=high',
      title: 'Track one',
      artUrl: '/api/media/image/track-1?access_token=also-secret',
      kind: 'music',
    });

    const scope = offlineAccountScope(7);
    const records = localStorage.entries();
    const serialized = records.map(([, value]) => value).join('\n');
    expect(localStorage.getItem('cb_downloads')).toBeNull();
    expect(cacheStorage.values.has('cloudbox-media')).toBe(false);
    expect(serialized).not.toContain('top-secret');
    expect(serialized).not.toContain('also-secret');
    expect(records.map(([key]) => key)).toContain(scope.metadataKey);

    const accountCache = cacheStorage.values.get(scope.cacheName);
    const key = 'https://aerie.example/api/media/offline/track-1?quality=high';
    const cached = await accountCache?.match(key);
    expect(cached).toBeDefined();
    expect(cached?.headers.get('X-Aerie-Offline-Scope')).toBe(scope.key);
    expect([...accountCache!.values.keys()]).toEqual([key]);
  });

  it('hides another account immediately and restores only its own downloads', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => new Response(requestKey(input), {
      status: 200,
      headers: { 'content-type': 'audio/mpeg' },
    })));
    const { downloads } = await import('../src/lib/downloads');

    await downloads.activate(7);
    await downloads.save({ id: 'seven', url: '/api/books/offline/seven', title: 'Seven', kind: 'audiobook' });
    expect(downloads.list().map(item => item.id)).toEqual(['seven']);

    const switching = downloads.activate(8);
    expect(downloads.list()).toEqual([]);
    await switching;
    await downloads.save({ id: 'eight', url: '/api/books/offline/eight', title: 'Eight', kind: 'podcast' });
    expect(downloads.list().map(item => item.id)).toEqual(['eight']);

    await downloads.activate(7);
    expect(downloads.list().map(item => item.id)).toEqual(['seven']);
    await downloads.lock(7);
    expect(downloads.list()).toEqual([]);
    expect(downloads.has('seven')).toBe(false);

    expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'AERIE_OFFLINE_LOCK',
      accountId: 7,
      allClients: true,
    }));
  });

  it('rejects cross-origin and non-media cache keys', async () => {
    const { tokenFreeCacheKey } = await import('../src/lib/downloads');
    expect(() => tokenFreeCacheKey('https://evil.example/api/media/offline/1')).toThrow('offline_url_invalid');
    expect(() => tokenFreeCacheKey('/api/auth/me?token=secret')).toThrow('offline_url_invalid');
  });
});
