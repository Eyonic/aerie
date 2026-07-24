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

describe('authentication private-state lifecycle', () => {
  const activate = vi.fn(async () => undefined);
  const lock = vi.fn(async () => undefined);
  const setToken = vi.fn();
  const setApiAccountScope = vi.fn();
  const invalidateApiAccountScope = vi.fn();
  const acknowledgeApiAuthMarker = vi.fn();
  const configureApiCookieSessionSync = vi.fn();
  const api = {
    me: vi.fn(),
    login: vi.fn(),
    logout: vi.fn(async () => undefined),
    devices: { heartbeat: vi.fn(async () => undefined) },
  };

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
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
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.doUnmock('../src/lib/api');
    vi.doUnmock('../src/lib/downloads');
  });

  it('binds the immutable account id and clears a previous player on account switch', async () => {
    api.login.mockResolvedValue({ token: 'new-token', user: member(8) });
    const { useAuth, usePlayer } = await import('../src/lib/store');
    useAuth.setState({ user: member(7), loading: false });
    usePlayer.getState().playTrack({
      id: 'private-track',
      title: 'Private track',
      streamUrl: '/api/media/stream/private-track',
      kind: 'music',
    });

    await expect(useAuth.getState().login('member-8', 'password')).resolves.toBe('ok');
    expect(setToken).toHaveBeenCalledWith('new-token');
    expect(setApiAccountScope).toHaveBeenCalledWith(8);
    expect(activate).toHaveBeenCalledWith(8);
    expect(useAuth.getState().user?.id).toBe(8);
    expect(usePlayer.getState().current).toBeNull();

    usePlayer.getState().playTrack({
      id: 'another-private-track',
      title: 'Another private track',
      streamUrl: '/api/media/stream/another-private-track',
      kind: 'music',
    });
    useAuth.getState().setUser(member(9));
    expect(activate).toHaveBeenLastCalledWith(9);
    expect(usePlayer.getState().current).toBeNull();
  });

  it('locks downloads and clears auth/player state without waiting for remote logout', async () => {
    let finishRemoteLogout!: () => void;
    api.logout.mockReturnValueOnce(new Promise<void>(resolve => { finishRemoteLogout = resolve; }));
    const { useAuth, usePlayer } = await import('../src/lib/store');
    useAuth.setState({ user: member(7), loading: false });
    usePlayer.getState().playTrack({
      id: 'private-track',
      title: 'Private track',
      streamUrl: '/api/media/stream/private-track',
      kind: 'music',
    });

    const pending = useAuth.getState().logout();
    expect(lock).toHaveBeenCalledWith(7);
    expect(setToken).toHaveBeenCalledWith(null);
    expect(invalidateApiAccountScope).toHaveBeenCalledOnce();
    expect(useAuth.getState().user).toBeNull();
    expect(usePlayer.getState().current).toBeNull();

    finishRemoteLogout();
    await pending;
  });
});
