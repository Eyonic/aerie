import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { accountScopedStorageKey } from '../src/lib/account-storage';
import { loadVideoVolume, saveVideoVolume } from '../src/lib/video-volume';

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() { return values.size; },
    clear: () => values.clear(),
    getItem: key => values.get(key) ?? null,
    key: index => Array.from(values.keys())[index] ?? null,
    removeItem: key => { values.delete(key); },
    setItem: (key, value) => { values.set(key, String(value)); },
  };
}

describe('account-scoped video volume', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', memoryStorage());
    vi.stubGlobal('location', { origin: 'https://aerie.test' });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('restores volume only for the same account and clamps writes', () => {
    saveVideoVolume(7, { volume: 0.35, muted: true });
    expect(loadVideoVolume(7)).toEqual({ volume: 0.35, muted: true });
    expect(loadVideoVolume(8)).toEqual({ volume: 1, muted: false });

    saveVideoVolume(7, { volume: 4, muted: false });
    expect(loadVideoVolume(7)).toEqual({ volume: 1, muted: false });
  });

  it('falls back safely for malformed or unavailable state', () => {
    localStorage.setItem(accountScopedStorageKey('aerie-video-volume-v1', 7), '{bad json');
    expect(loadVideoVolume(null)).toEqual({ volume: 1, muted: false });
    expect(loadVideoVolume(7)).toEqual({ volume: 1, muted: false });
  });
});
