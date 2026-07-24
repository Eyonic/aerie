import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

function memoryStorage(): Storage {
  const entries = new Map<string, string>();
  return {
    get length() { return entries.size; },
    clear: () => entries.clear(),
    getItem: key => entries.get(key) ?? null,
    key: index => Array.from(entries.keys())[index] ?? null,
    removeItem: key => { entries.delete(key); },
    setItem: (key, value) => { entries.set(key, String(value)); },
  };
}

function jsonResponse(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('API account-generation boundary', () => {
  const refreshNativeAccess = vi.fn();

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    const storage = memoryStorage();
    const target = new EventTarget() as any;
    target.localStorage = storage;
    target.aerieSync = undefined;
    target.CloudBoxNative = undefined;
    target.aerieNativeDevice = undefined;
    vi.stubGlobal('window', target);
    vi.stubGlobal('localStorage', storage);
    vi.stubGlobal('location', { pathname: '/', href: '/', origin: 'https://aerie.test' });
    vi.stubGlobal('navigator', { userAgent: 'Test browser', platform: 'Test browser' });
    vi.doMock('../src/lib/native-device', () => ({ refreshNativeAccess }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.doUnmock('../src/lib/native-device');
  });

  it('rejects a response whose body finishes after the account generation changed', async () => {
    let finishJson!: (value: any) => void;
    const json = vi.fn(() => new Promise(resolve => { finishJson = resolve; }));
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: new Headers({ 'content-type': 'application/json' }),
      json,
      text: vi.fn(),
    })));
    const { api, invalidateApiAccountScope, setApiAccountScope } = await import('../src/lib/api');
    setApiAccountScope(7);
    const pending = api.dashboard();
    await vi.waitFor(() => expect(json).toHaveBeenCalledOnce());

    invalidateApiAccountScope();
    finishJson({ continueWatching: [], recentFiles: [] });
    await expect(pending).rejects.toMatchObject({ name: 'AbortError', message: 'account_session_changed' });
  });

  it('detects a peer cookie marker synchronously before its queued tab event', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const {
      api, configureApiCookieSessionSync, setApiAccountScope,
    } = await import('../src/lib/api');
    setApiAccountScope(7);
    configureApiCookieSessionSync(true);
    localStorage.setItem('aerie.auth-session.v1', JSON.stringify({
      version: 1,
      kind: 'session-changed',
      sender: 'tab-b',
      marker: 'new-cookie-generation',
      at: Date.now(),
      reason: 'login',
    }));
    const peerEvent = vi.fn();
    window.addEventListener('aerie:peer-auth-marker', peerEvent);

    await expect(api.dashboard()).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(peerEvent).toHaveBeenCalledOnce();
  });

  it('stops AI streaming before a stale chunk reaches the UI callback', async () => {
    let stream!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({ start(controller) { stream = controller; } });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { status: 200 })));
    const { api, invalidateApiAccountScope, setApiAccountScope } = await import('../src/lib/api');
    setApiAccountScope(7);
    const chunks: string[] = [];
    const pending = api.ai.chat([{ role: 'user', content: 'private' }], undefined, chunk => chunks.push(chunk));
    stream.enqueue(new TextEncoder().encode('first'));
    await vi.waitFor(() => expect(chunks).toEqual(['first']));

    invalidateApiAccountScope();
    stream.enqueue(new TextEncoder().encode('stale'));
    stream.close();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(chunks).toEqual(['first']);
  });

  it('aborts direct file, photo, and account-share XHR uploads on an account change', async () => {
    class FakeXhr {
      static instances: FakeXhr[] = [];
      upload: any = {};
      status = 200;
      responseText = '{}';
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      onabort: (() => void) | null = null;
      aborted = false;
      constructor() { FakeXhr.instances.push(this); }
      open() {}
      setRequestHeader() {}
      send() {}
      abort() { this.aborted = true; this.onabort?.(); }
    }
    vi.stubGlobal('XMLHttpRequest', FakeXhr as any);
    const { api, invalidateApiAccountScope, setApiAccountScope } = await import('../src/lib/api');
    setApiAccountScope(7);
    const file = new File(['private'], 'private.txt');
    const drive = api.files.upload('/', [file]);
    const photo = api.photos.native.upload([file]);
    const share = api.accountShares.upload('share-1', '/', [file]);

    invalidateApiAccountScope();
    expect(FakeXhr.instances.map(xhr => xhr.aborted)).toEqual([true, true, true]);
    await expect(drive).rejects.toMatchObject({ name: 'AbortError' });
    await expect(photo).rejects.toMatchObject({ name: 'AbortError' });
    await expect(share).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('rejects a resumable chunk response that crosses an account change', async () => {
    let finishChunk!: (response: Response) => void;
    const fetchMock = vi.fn((url: string, options?: RequestInit) => {
      if (String(url).endsWith('/upload-resumable/init')) {
        return Promise.resolve(jsonResponse({ uploadId: 'upload-1', offset: 0 }));
      }
      if (options?.method === 'PATCH') {
        return new Promise<Response>(resolve => { finishChunk = resolve; });
      }
      return Promise.resolve(jsonResponse({ saved: ['/private.bin'] }));
    });
    vi.stubGlobal('fetch', fetchMock);
    const { api, invalidateApiAccountScope, setApiAccountScope } = await import('../src/lib/api');
    setApiAccountScope(7);
    const file = new File([new Uint8Array(8 * 1024 * 1024)], 'private.bin');
    const pending = api.files.upload('/', [file]);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    invalidateApiAccountScope();
    finishChunk(jsonResponse({ offset: file.size }));
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('keeps native bearer renewal and bridge persistence intact', async () => {
    const setAuth = vi.fn();
    (window as any).aerieSync = { setAuth };
    refreshNativeAccess.mockResolvedValue({ token: 'renewed-native-token', expiresAt: '2026-08-01T00:00:00Z' });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ error: 'unauthorized' }, 401))
      .mockResolvedValueOnce(jsonResponse({ continueWatching: [] }));
    vi.stubGlobal('fetch', fetchMock);
    const { api, setApiAccountScope, setToken } = await import('../src/lib/api');
    setApiAccountScope(7);
    setToken('expired-native-token');

    await expect(api.dashboard()).resolves.toMatchObject({ continueWatching: [] });
    expect(refreshNativeAccess).toHaveBeenCalledOnce();
    expect(setAuth).toHaveBeenLastCalledWith('renewed-native-token');
    expect(fetchMock.mock.calls[1][1].headers.Authorization).toBe('Bearer renewed-native-token');
  });
});
