import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  canAdvanceQueue, nextQueueIndex, resolveLoudnessNormalization, shouldLoopCurrentTrack, shouldRestartCurrentTrack,
} from '../src/lib/audio-engine';
import { accountScopedStorageKey } from '../src/lib/account-storage';

type MemoryStorage = Storage & { entries: Map<string, string> };

function memoryStorage(): MemoryStorage {
  const entries = new Map<string, string>();
  return {
    entries,
    get length() { return entries.size; },
    clear: () => entries.clear(),
    getItem: key => entries.get(key) ?? null,
    key: index => Array.from(entries.keys())[index] ?? null,
    removeItem: key => { entries.delete(key); },
    setItem: (key, value) => { entries.set(key, String(value)); },
  };
}

const track = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  title: `Track ${id}`,
  streamUrl: `/api/media/stream/${id}`,
  kind: 'music' as const,
  durationSec: 100,
  ...extra,
});

describe('audio player queue and session state', () => {
  let storage: MemoryStorage;

  beforeEach(() => {
    vi.resetModules();
    storage = memoryStorage();
    vi.stubGlobal('localStorage', storage);
    vi.stubGlobal('location', { origin: 'https://aerie.test' });
    vi.stubGlobal('navigator', { platform: 'Test browser', onLine: true });
    vi.doMock('../src/lib/api', () => ({
      api: { devices: { heartbeat: vi.fn(async () => undefined) } },
      setToken: vi.fn(),
      setApiAccountScope: vi.fn(),
    }));
    vi.doMock('../src/lib/downloads', () => ({
      downloads: { activate: vi.fn(async () => undefined), lock: vi.fn(async () => undefined) },
    }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.doUnmock('../src/lib/api');
    vi.doUnmock('../src/lib/downloads');
  });

  it('keeps the selected track inside its queue and resets all timing fields', async () => {
    const { usePlayer } = await import('../src/lib/store');
    usePlayer.getState().setProgress(57, 100);
    usePlayer.getState().playTrack(track('wanted'), [track('other')]);

    expect(usePlayer.getState().queue.map(item => item.id)).toEqual(['wanted', 'other']);
    expect(usePlayer.getState().index).toBe(0);
    expect(usePlayer.getState().current?.id).toBe('wanted');
    expect(usePlayer.getState().currentTime).toBe(0);
    expect(usePlayer.getState().duration).toBe(100);

    usePlayer.getState().setProgress(88, 100);
    usePlayer.getState().playQueue([track('a'), track('b')], 99);
    expect(usePlayer.getState().index).toBe(1);
    expect(usePlayer.getState().current?.id).toBe('b');
    expect(usePlayer.getState().currentTime).toBe(0);
    expect(usePlayer.getState().progress).toBe(0);
  });

  it('uses a shuffle bag without repeats and previous follows playback history', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const { usePlayer } = await import('../src/lib/store');
    usePlayer.getState().playQueue([track('a'), track('b'), track('c')]);
    usePlayer.getState().toggleShuffle();

    const visited = [usePlayer.getState().current?.id];
    usePlayer.getState().next();
    visited.push(usePlayer.getState().current?.id);
    usePlayer.getState().next();
    visited.push(usePlayer.getState().current?.id);
    expect(new Set(visited)).toEqual(new Set(['a', 'b', 'c']));

    const last = usePlayer.getState().current?.id;
    usePlayer.getState().prev();
    expect(usePlayer.getState().current?.id).toBe(visited[1]);
    expect(usePlayer.getState().current?.id).not.toBe(last);

    usePlayer.getState().playQueue([
      { ...track('part-1'), kind: 'audiobook' },
      { ...track('part-2'), kind: 'audiobook' },
    ]);
    usePlayer.getState().next();
    expect(usePlayer.getState().current?.id).toBe('part-2');
    usePlayer.getState().cycleRepeat();
    usePlayer.getState().next();
    expect(usePlayer.getState().current?.id).toBe('part-2');
    expect(usePlayer.getState().playing).toBe(false);
  });

  it('reorders and removes queue entries without losing the current track', async () => {
    const { usePlayer } = await import('../src/lib/store');
    usePlayer.getState().playQueue([track('a'), track('b'), track('c')], 1);
    usePlayer.getState().moveTrack(0, 2);
    expect(usePlayer.getState().queue.map(item => item.id)).toEqual(['b', 'c', 'a']);
    expect(usePlayer.getState().current?.id).toBe('b');
    expect(usePlayer.getState().index).toBe(0);

    usePlayer.getState().removeAt(1);
    expect(usePlayer.getState().queue.map(item => item.id)).toEqual(['b', 'a']);
    expect(usePlayer.getState().current?.id).toBe('b');
    usePlayer.getState().removeAt(0);
    expect(usePlayer.getState().current?.id).toBe('a');
  });

  it('adds next/last and clears upcoming without replacing current playback', async () => {
    const { usePlayer } = await import('../src/lib/store');
    usePlayer.getState().playQueue([track('a'), track('b'), track('c')], 1);
    usePlayer.getState().setProgress(37, 100);
    usePlayer.getState().setPlaying(false);
    const selection = usePlayer.getState().selectionId;

    usePlayer.getState().playNext([track('x'), track('y')]);
    expect(usePlayer.getState().queue.map(item => item.id)).toEqual(['a', 'b', 'x', 'y', 'c']);
    expect(usePlayer.getState().current?.id).toBe('b');
    expect(usePlayer.getState().currentTime).toBe(37);
    expect(usePlayer.getState().playing).toBe(false);
    expect(usePlayer.getState().selectionId).toBe(selection);

    usePlayer.getState().addToQueue(track('z'));
    expect(usePlayer.getState().queue.map(item => item.id)).toEqual(['a', 'b', 'x', 'y', 'c', 'z']);
    usePlayer.getState().clearUpcoming();
    expect(usePlayer.getState().queue.map(item => item.id)).toEqual(['a', 'b']);
    expect(usePlayer.getState().current?.id).toBe('b');
    expect(usePlayer.getState().currentTime).toBe(37);
  });

  it('prioritizes Play next inside shuffle while preserving history', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const { usePlayer } = await import('../src/lib/store');
    usePlayer.getState().playQueue([track('a'), track('b'), track('c'), track('d')]);
    usePlayer.getState().toggleShuffle();
    usePlayer.getState().next();
    const before = usePlayer.getState().current?.id;

    usePlayer.getState().playNext(track('manual'));
    expect(usePlayer.getState().shuffleRemaining[0]).toBe(usePlayer.getState().index + 1);
    usePlayer.getState().next();
    expect(usePlayer.getState().current?.id).toBe('manual');
    usePlayer.getState().prev();
    expect(usePlayer.getState().current?.id).toBe(before);

    usePlayer.getState().clearUpcoming();
    expect(usePlayer.getState().shuffleRemaining).toEqual([]);
    expect(usePlayer.getState().queue.map(item => item.id)).toEqual(['a', before]);
    usePlayer.getState().prev();
    expect(usePlayer.getState().current?.id).toBe('a');
  });

  it('removing the current shuffled track consumes the bag without trapping Previous', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const { usePlayer } = await import('../src/lib/store');
    usePlayer.getState().playQueue([track('a'), track('b'), track('c'), track('d')]);
    usePlayer.getState().toggleShuffle();
    usePlayer.getState().next(); // c
    usePlayer.getState().next(); // d (the last visual queue index)

    usePlayer.getState().removeAt(usePlayer.getState().index);
    expect(usePlayer.getState().current?.id).toBe('b');
    expect(usePlayer.getState().shuffleRemaining).toEqual([]);

    usePlayer.getState().prev();
    expect(usePlayer.getState().current?.id).toBe('c');
  });

  it('restores a token-free queue only for the same server and immutable account', async () => {
    const { activatePlayerSession, deactivatePlayerSession, flushPlayerSession, usePlayer } = await import('../src/lib/store');
    activatePlayerSession(7);
    usePlayer.getState().playTrack(track('private', {
      streamUrl: '/api/media/stream/private?token=do-not-store',
      artUrl: '/api/media/image/private?access_token=also-secret',
    }));
    usePlayer.getState().setProgress(42, 100);
    usePlayer.getState().setVolume(0.4);
    usePlayer.getState().setMuted(true);
    usePlayer.getState().setPlaybackRate(1.5);
    usePlayer.getState().setNormalizationEnabled(true);
    flushPlayerSession();

    const [key, raw] = Array.from(storage.entries.entries())[0];
    expect(key).toContain(encodeURIComponent('https://aerie.test'));
    expect(key).toContain('u7');
    expect(raw).not.toContain('do-not-store');
    expect(raw).not.toContain('also-secret');

    deactivatePlayerSession(false);
    usePlayer.getState().clear();
    (location as any).origin = 'https://different-aerie.test';
    activatePlayerSession(7);
    expect(usePlayer.getState().current).toBeNull();

    deactivatePlayerSession(false);
    (location as any).origin = 'https://aerie.test';
    activatePlayerSession(8);
    expect(usePlayer.getState().current).toBeNull();

    deactivatePlayerSession(false);
    activatePlayerSession(7);
    expect(usePlayer.getState().current?.id).toBe('private');
    expect(usePlayer.getState().current?.streamUrl).toBe('/api/media/stream/private');
    expect(usePlayer.getState().currentTime).toBe(42);
    expect(usePlayer.getState().playing).toBe(false);
    expect(usePlayer.getState().volume).toBe(0.4);
    expect(usePlayer.getState().muted).toBe(true);
    expect(usePlayer.getState().playbackRate).toBe(1.5);
    expect(usePlayer.getState().normalizationEnabled).toBe(true);

    deactivatePlayerSession(true);
    expect(storage.entries.has(key)).toBe(false);
  });

  it('hides the previous account queue synchronously during an auth account switch', async () => {
    const { activatePlayerSession, deactivatePlayerSession, useAuth, usePlayer } = await import('../src/lib/store');
    const user7 = { id: 7, username: 'seven' } as any;
    const user8 = { id: 8, username: 'eight' } as any;
    useAuth.setState({ user: user7, loading: false });
    activatePlayerSession(7);
    usePlayer.getState().playTrack(track('account-seven-private'));

    useAuth.getState().setUser(user8);
    expect(useAuth.getState().user?.id).toBe(8);
    expect(usePlayer.getState().current).toBeNull();
    expect(Array.from(storage.entries.keys()).some(key => key.includes('u7'))).toBe(true);
    expect(Array.from(storage.entries.keys()).some(key => key.includes('u8'))).toBe(false);
    deactivatePlayerSession(true);
  });
});

describe('previous-track threshold', () => {
  it('restarts only after three seconds, otherwise selecting the prior queue entry', () => {
    expect(shouldRestartCurrentTrack(3)).toBe(false);
    expect(shouldRestartCurrentTrack(3.01)).toBe(true);
    expect(shouldRestartCurrentTrack(Number.NaN)).toBe(false);
  });

  it('loops repeat-one only for music and exposes a coherent next action', () => {
    expect(shouldLoopCurrentTrack('music', 'one', 8)).toBe(true);
    expect(shouldLoopCurrentTrack('audiobook', 'one', 8)).toBe(false);
    expect(shouldLoopCurrentTrack('music', 'all', 1)).toBe(true);
    expect(canAdvanceQueue(3, 2, false, 0, 'off')).toBe(false);
    expect(canAdvanceQueue(3, 2, false, 0, 'all')).toBe(true);
    expect(canAdvanceQueue(3, 2, true, 1, 'off')).toBe(true);
    expect(canAdvanceQueue(3, 0, true, 0, 'off')).toBe(false);
  });

  it('predicts only deterministic queue handoffs without consuming shuffle', () => {
    expect(nextQueueIndex(4, 1, false, [], 'off')).toBe(2);
    expect(nextQueueIndex(4, 3, false, [], 'all')).toBe(0);
    expect(nextQueueIndex(4, 1, true, [3, 0], 'off')).toBe(3);
    expect(nextQueueIndex(4, 1, true, [], 'all')).toBeNull();
    expect(nextQueueIndex(1, 0, false, [], 'all')).toBeNull();
  });
});

describe('ReplayGain loudness normalization', () => {
  const tagged = {
    kind: 'music',
    replayGain: { albumDb: -6, trackDb: -2, albumPeak: 0.8, trackPeak: 0.9 },
  };

  it('preserves album dynamics in order and uses track gain in shuffle', () => {
    const album = resolveLoudnessNormalization(tagged, true, false, true);
    const shuffled = resolveLoudnessNormalization(tagged, true, true, true);
    expect(album.source).toBe('album');
    expect(album.appliedDb).toBe(-6);
    expect(album.multiplier).toBeCloseTo(Math.pow(10, -6 / 20));
    expect(shuffled.source).toBe('track');
    expect(shuffled.appliedDb).toBe(-2);
    expect(shuffled.message).toContain('shuffle');
  });

  it('caps boosts with peak metadata and never applies an unprotected boost', () => {
    const protectedBoost = resolveLoudnessNormalization({
      kind: 'music', replayGain: { trackDb: 6, trackPeak: 0.9 },
    }, true, true, true);
    expect(protectedBoost.limited).toBe(true);
    expect(protectedBoost.multiplier).toBeCloseTo(1 / 0.9);
    expect(protectedBoost.message).toContain('clipping protection');

    const missingPeak = resolveLoudnessNormalization({ kind: 'music', replayGain: { trackDb: 6 } }, true, true, true);
    expect(missingPeak.appliedDb).toBe(0);
    expect(missingPeak.multiplier).toBe(1);
    expect(missingPeak.message).toContain('peak metadata is missing');

    const noWebAudio = resolveLoudnessNormalization({ kind: 'music', replayGain: { trackDb: 6, trackPeak: 0.5 } }, true, true, false);
    expect(noWebAudio.appliedDb).toBe(0);
    expect(noWebAudio.message).toContain('browser');
  });

  it('reports unavailable exact metadata instead of estimating loudness', () => {
    const missing = resolveLoudnessNormalization({ kind: 'music' }, true, false, true);
    expect(missing.available).toBe(false);
    expect(missing.multiplier).toBe(1);
    expect(missing.message).toContain('no exact loudness');

    const trackFallback = resolveLoudnessNormalization({ kind: 'music', replayGain: { trackDb: -3 } }, true, false, false);
    expect(trackFallback.source).toBe('track');
    expect(trackFallback.appliedDb).toBe(-3);
    expect(trackFallback.message).toContain('album tag unavailable');
  });
});

describe('private browser-storage partitioning', () => {
  it('includes normalized server origin and immutable account id', () => {
    expect(accountScopedStorageKey('aerie-drive-resume-v2', 17, 'https://cloud.example.test/path'))
      .toBe(`aerie-drive-resume-v2:${encodeURIComponent('https://cloud.example.test')}:u17`);
    expect(() => accountScopedStorageKey('bad namespace', 17, 'https://cloud.example.test')).toThrow();
    expect(() => accountScopedStorageKey('safe', 0, 'https://cloud.example.test')).toThrow();
  });
});
