import { describe, expect, it, vi } from 'vitest';
import {
  AUTH_SYNC_STORAGE_KEY,
  createAuthSync,
  readAuthSyncMarker,
} from '../src/lib/auth-sync';

type Listener = (event: any) => void;

function sharedWindows(withBroadcast: boolean) {
  const values = new Map<string, string>();
  const windows: any[] = [];

  class FakeBroadcastChannel {
    static instances = new Set<FakeBroadcastChannel>();
    onmessage: ((event: { data: unknown }) => void) | null = null;
    constructor(readonly name: string) { FakeBroadcastChannel.instances.add(this); }
    postMessage(data: unknown) {
      for (const channel of FakeBroadcastChannel.instances) {
        if (channel !== this && channel.name === this.name) channel.onmessage?.({ data });
      }
    }
    close() { FakeBroadcastChannel.instances.delete(this); }
  }

  const makeWindow = () => {
    const listeners = new Map<string, Set<Listener>>();
    const target: any = {
      ...(withBroadcast ? { BroadcastChannel: FakeBroadcastChannel } : {}),
      addEventListener(type: string, listener: Listener) {
        const set = listeners.get(type) || new Set<Listener>();
        set.add(listener); listeners.set(type, set);
      },
      removeEventListener(type: string, listener: Listener) { listeners.get(type)?.delete(listener); },
      localStorage: {
        getItem(key: string) { return values.get(key) ?? null; },
        setItem(key: string, value: string) {
          values.set(key, value);
          for (const other of windows) {
            if (other === target) continue;
            for (const listener of other._listeners.get('storage') || []) {
              listener({ key, newValue: value });
            }
          }
        },
      },
      _listeners: listeners,
    };
    windows.push(target);
    return target;
  };

  return { makeWindow, values };
}

describe('cross-tab authentication synchronization', () => {
  it('delivers one deduplicated peer event over BroadcastChannel plus storage', () => {
    const shared = sharedWindows(true);
    const firstWindow = shared.makeWindow();
    const secondWindow = shared.makeWindow();
    const firstEvents: any[] = [];
    const secondEvents: any[] = [];
    const first = createAuthSync(event => firstEvents.push(event), {
      window: firstWindow, sender: 'tab-a', randomId: () => 'login-marker', now: () => 100,
    });
    const second = createAuthSync(event => secondEvents.push(event), {
      window: secondWindow, sender: 'tab-b', randomId: () => 'unused', now: () => 100,
    });

    const event = first.publish('login');
    expect(firstEvents).toEqual([]);
    expect(secondEvents).toEqual([event]);
    expect(readAuthSyncMarker(secondWindow.localStorage)).toBe('login-marker');
    expect(shared.values.has(AUTH_SYNC_STORAGE_KEY)).toBe(true);

    first.close(); second.close();
  });

  it('uses storage events when BroadcastChannel is unavailable', () => {
    const shared = sharedWindows(false);
    const firstWindow = shared.makeWindow();
    const secondWindow = shared.makeWindow();
    const received = vi.fn();
    const first = createAuthSync(() => {}, {
      window: firstWindow, sender: 'tab-a', randomId: () => 'logout-marker', now: () => 200,
    });
    const second = createAuthSync(received, { window: secondWindow, sender: 'tab-b' });

    expect(first.enabled).toBe(true);
    first.publish('logout');
    expect(received).toHaveBeenCalledOnce();
    expect(received.mock.calls[0][0]).toMatchObject({ marker: 'logout-marker', reason: 'logout' });

    first.close(); second.close();
  });

  it('does not couple native desktop or Android bearer-token sessions', () => {
    const writes = vi.fn();
    const nativeWindow: any = {
      aerieSync: { setAuth: vi.fn() },
      localStorage: { getItem: () => null, setItem: writes },
      addEventListener: vi.fn(), removeEventListener: vi.fn(),
    };
    const sync = createAuthSync(vi.fn(), { window: nativeWindow });
    expect(sync.enabled).toBe(false);
    expect(sync.publish('login')).toBeNull();
    expect(writes).not.toHaveBeenCalled();
  });
});
