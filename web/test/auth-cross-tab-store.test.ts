import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { User } from '../src/lib/model';

const member = (id: number): User => ({
  id,
  username: `member-${id}`,
  displayName: `Member ${id}`,
  email: null,
  role: 'user',
  avatarColor: '#123456',
  storageQuotaBytes: null,
  aiMode: 'local_only',
  disabledAt: null,
  createdAt: '2026-01-01T00:00:00.000Z',
});

describe('auth store cross-tab lifecycle', () => {
  const activate = vi.fn(async () => undefined);
  const lock = vi.fn(async () => undefined);
  const setToken = vi.fn();
  const setApiAccountScope = vi.fn();
  const invalidateApiAccountScope = vi.fn();
  const acknowledgeApiAuthMarker = vi.fn();
  const configureApiCookieSessionSync = vi.fn();
  const publish = vi.fn(() => null);
  const close = vi.fn();
  const api = {
    me: vi.fn(),
    login: vi.fn(),
    logout: vi.fn(async () => undefined),
    devices: { heartbeat: vi.fn(async () => undefined) },
  };
  let peer!: (event: any) => void;
  let imported: typeof import('../src/lib/store') | null = null;

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    const target = new EventTarget() as any;
    const entries = new Map<string, string>();
    target.localStorage = {
      get length() { return entries.size; },
      clear: () => entries.clear(),
      getItem: (key: string) => entries.get(key) ?? null,
      key: (index: number) => Array.from(entries.keys())[index] ?? null,
      removeItem: (key: string) => { entries.delete(key); },
      setItem: (key: string, value: string) => { entries.set(key, value); },
    };
    vi.stubGlobal('window', target);
    vi.stubGlobal('localStorage', target.localStorage);
    vi.stubGlobal('location', { origin: 'https://aerie.test', pathname: '/' });
    vi.stubGlobal('navigator', { platform: 'Test browser' });
    vi.doMock('../src/lib/api', () => ({
      api,
      setToken,
      setApiAccountScope,
      invalidateApiAccountScope,
      acknowledgeApiAuthMarker,
      configureApiCookieSessionSync,
    }));
    vi.doMock('../src/lib/downloads', () => ({ downloads: { activate, lock } }));
    vi.doMock('../src/lib/auth-sync', () => ({
      createAuthSync: (listener: (event: any) => void) => {
        peer = listener;
        return { enabled: true, publish, close };
      },
    }));
  });

  afterEach(() => {
    imported?.stopAuthSynchronization();
    imported = null;
    vi.unstubAllGlobals();
    vi.doUnmock('../src/lib/api');
    vi.doUnmock('../src/lib/downloads');
    vi.doUnmock('../src/lib/auth-sync');
  });

  it('unmounts private state synchronously, then revalidates the shared cookie account', async () => {
    api.me.mockResolvedValue({ user: member(8) });
    imported = await import('../src/lib/store');
    const { useAuth, usePlayer } = imported;
    useAuth.setState({ user: member(7), loading: false });
    usePlayer.getState().playTrack({
      id: 'private-seven', title: 'Private seven', streamUrl: '/private-seven', kind: 'music',
    });

    peer({ marker: 'tab-b-login', reason: 'login' });
    expect(useAuth.getState()).toMatchObject({ user: null, loading: true });
    expect(usePlayer.getState().current).toBeNull();
    expect(lock).toHaveBeenCalledWith(7);
    expect(setToken).toHaveBeenCalledWith(null);
    expect(invalidateApiAccountScope).toHaveBeenCalledOnce();

    await vi.waitFor(() => expect(useAuth.getState().user?.id).toBe(8));
    expect(useAuth.getState().loading).toBe(false);
    expect(activate).toHaveBeenCalledWith(8);
    expect(setApiAccountScope).toHaveBeenCalledWith(8);
    expect(acknowledgeApiAuthMarker).toHaveBeenCalledWith('tab-b-login');
  });

  it('does not let an older peer revalidation overwrite a newer account event', async () => {
    let finishFirst!: (value: any) => void;
    let finishSecond!: (value: any) => void;
    api.me
      .mockReturnValueOnce(new Promise(resolve => { finishFirst = resolve; }))
      .mockReturnValueOnce(new Promise(resolve => { finishSecond = resolve; }));
    imported = await import('../src/lib/store');
    const { useAuth } = imported;
    useAuth.setState({ user: member(7), loading: false });

    peer({ marker: 'first-change', reason: 'login' });
    peer({ marker: 'second-change', reason: 'login' });
    finishSecond({ user: member(9) });
    await vi.waitFor(() => expect(useAuth.getState().user?.id).toBe(9));

    finishFirst({ user: member(8) });
    await Promise.resolve();
    await Promise.resolve();
    expect(useAuth.getState().user?.id).toBe(9);
  });
});
