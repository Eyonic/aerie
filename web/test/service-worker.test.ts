import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { afterEach, describe, expect, it, vi } from 'vitest';

function testScope(accountId: number, origin: string) {
  const originHex = Array.from(new TextEncoder().encode(origin), byte => byte.toString(16).padStart(2, '0')).join('');
  return { key: `${origin}#${accountId}`, cacheName: `aerie-media-v2-${originHex}-u${accountId}`, serverOrigin: origin };
}

function testCacheKey(input: string): string {
  const url = new URL(input);
  url.searchParams.delete('token');
  url.searchParams.delete('access_token');
  url.searchParams.sort();
  return url.toString();
}

function keyOf(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

class WorkerCache {
  readonly values = new Map<string, Response>();

  async addAll() { /* shell installation is outside these fetch tests */ }
  async match(input: RequestInfo | URL) { return this.values.get(keyOf(input))?.clone(); }
  async put(input: RequestInfo | URL, response: Response) { this.values.set(keyOf(input), response.clone()); }
  async delete(input: RequestInfo | URL) { return this.values.delete(keyOf(input)); }
}

class WorkerCaches {
  readonly values = new Map<string, WorkerCache>();

  async open(name: string) {
    let cache = this.values.get(name);
    if (!cache) { cache = new WorkerCache(); this.values.set(name, cache); }
    return cache;
  }

  async delete(name: string) { return this.values.delete(name); }
  async keys() { return [...this.values.keys()]; }
  async match(input: RequestInfo | URL) {
    for (const cache of this.values.values()) {
      const response = await cache.match(input);
      if (response) return response;
    }
    return undefined;
  }
}

function workerHarness() {
  const listeners = new Map<string, (event: any) => void>();
  const caches = new WorkerCaches();
  const network = vi.fn(async () => new Response('network'));
  const workerSelf = {
    location: { origin: 'https://aerie.example' },
    clients: { claim: vi.fn(async () => undefined) },
    skipWaiting: vi.fn(async () => undefined),
    addEventListener: (type: string, listener: (event: any) => void) => listeners.set(type, listener),
  };
  const source = readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8');
  runInNewContext(source, {
    self: workerSelf,
    caches,
    fetch: network,
    URL,
    TextEncoder,
    Response,
    Request,
    Headers,
    Blob,
    Map,
    Set,
    Promise,
    Number,
    Array,
  });

  return {
    caches,
    network,
    message(clientId: string, data: Record<string, unknown>) {
      listeners.get('message')!({ source: { id: clientId }, data });
    },
    async fetch(clientId: string, request: Request): Promise<Response> {
      let result: Promise<Response> | undefined;
      listeners.get('fetch')!({
        clientId,
        request,
        respondWith: (response: Promise<Response> | Response) => { result = Promise.resolve(response); },
        waitUntil: vi.fn(),
      });
      if (!result) throw new Error('worker_did_not_respond');
      return result;
    },
  };
}

describe('offline service-worker authorization', () => {
  afterEach(() => vi.restoreAllMocks());

  it('serves a protected cache only to the bound client and account', async () => {
    const harness = workerHarness();
    const scope = testScope(7, 'https://aerie.example');
    const url = 'https://aerie.example/api/media/offline/track?token=secret&quality=high';
    const key = testCacheKey(url);
    const cache = await harness.caches.open(scope.cacheName);
    await cache.put(key, new Response('private-media', {
      headers: { 'X-Aerie-Offline-Scope': scope.key, 'Content-Type': 'audio/mpeg' },
    }));

    expect(await (await harness.fetch('unbound', new Request(url))).text()).toBe('network');
    harness.message('member-seven', {
      type: 'AERIE_OFFLINE_ACTIVATE',
      accountId: 7,
      serverOrigin: 'https://aerie.example',
    });
    expect(await (await harness.fetch('member-seven', new Request(url))).text()).toBe('private-media');
    expect(await (await harness.fetch('another-tab', new Request(url))).text()).toBe('network');

    harness.message('member-seven', {
      type: 'AERIE_OFFLINE_ACTIVATE',
      accountId: 8,
      serverOrigin: 'https://aerie.example',
    });
    expect(await (await harness.fetch('member-seven', new Request(url))).text()).toBe('network');
    expect(harness.network).toHaveBeenCalledTimes(3);
  });

  it('rejects mislabeled entries, locks immediately, and supports byte ranges', async () => {
    const harness = workerHarness();
    const scope = testScope(7, 'https://aerie.example');
    const url = 'https://aerie.example/api/books/stream/book-1?token=secret';
    const key = testCacheKey(url);
    const cache = await harness.caches.open(scope.cacheName);
    harness.message('member-seven', {
      type: 'AERIE_OFFLINE_ACTIVATE',
      accountId: 7,
      serverOrigin: 'https://aerie.example',
    });

    await cache.put(key, new Response('wrong-owner', { headers: { 'X-Aerie-Offline-Scope': 'https://aerie.example#8' } }));
    expect(await (await harness.fetch('member-seven', new Request(url))).text()).toBe('network');
    expect(await cache.match(key)).toBeUndefined();

    await cache.put(key, new Response('abcdef', {
      headers: { 'X-Aerie-Offline-Scope': scope.key, 'Content-Type': 'audio/mpeg' },
    }));
    const ranged = await harness.fetch('member-seven', new Request(url, { headers: { Range: 'bytes=1-3' } }));
    expect(ranged.status).toBe(206);
    expect(ranged.headers.get('Content-Range')).toBe('bytes 1-3/6');
    expect(await ranged.text()).toBe('bcd');

    harness.message('member-seven', { type: 'AERIE_OFFLINE_LOCK' });
    expect(await (await harness.fetch('member-seven', new Request(url))).text()).toBe('network');
  });
});
