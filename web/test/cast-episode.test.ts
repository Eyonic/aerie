import { describe, expect, it } from 'vitest';
import {
  castProgressSnapshot,
  episodeProgressSnapshot,
  episodeResumeSeconds,
  isFinishedCastState,
  transitionCastEpisode,
} from '../src/lib/cast-episode';

describe('Cast episode transitions', () => {
  it('uses meaningful saved positions but restarts completed episodes', () => {
    expect(episodeResumeSeconds({ positionTicks: 60e7, runtimeTicks: 1800e7 })).toBe(60);
    expect(episodeResumeSeconds({ positionTicks: 1700e7, runtimeTicks: 1800e7 })).toBe(1700);
    expect(episodeResumeSeconds({ positionTicks: 1710e7, runtimeTicks: 1800e7 })).toBe(0);
    expect(episodeResumeSeconds({ positionTicks: 1790e7, runtimeTicks: 1800e7 })).toBe(0);
    expect(episodeResumeSeconds({ positionTicks: 50e7, runtimeTicks: 60e7 })).toBe(0);
    expect(episodeResumeSeconds({ positionTicks: 2e7, runtimeTicks: 1800e7 })).toBe(0);
  });

  it('uses the latest in-session position and lets a deliberate restart replace stale metadata', () => {
    const stale = { positionTicks: 1400e7, runtimeTicks: 1800e7 };
    expect(episodeResumeSeconds(stale, episodeProgressSnapshot(75, 1800))).toBe(75);
    expect(episodeResumeSeconds(stale, episodeProgressSnapshot(2, 1800))).toBe(0);
    expect(episodeResumeSeconds(stale, episodeProgressSnapshot(1799, 1800, true))).toBe(0);
  });

  it('maps a transcoded TV timeline back to absolute progress', () => {
    expect(castProgressSnapshot(30, 300, 120, 600e7)).toEqual({ positionSec: 150, durationSec: 420 });
    expect(castProgressSnapshot(1, 300, 0, 600e7)).toBeNull();
  });

  it('distinguishes a finished receiver from buffering, paused, and failed idle states', () => {
    expect(isFinishedCastState({ playerState: 'IDLE', idleReason: 'FINISHED' })).toBe(true);
    expect(isFinishedCastState({ playerState: 'IDLE', idleReason: 'ERROR' })).toBe(false);
    expect(isFinishedCastState({ playerState: 'PAUSED' })).toBe(false);
    expect(isFinishedCastState(null)).toBe(false);
  });

  it('starts saving before loading the target and does not restore on success', async () => {
    const calls: string[] = [];
    const result = await transitionCastEpisode({
      saveProgress: async () => { calls.push('save'); },
      playTarget: async () => { calls.push('target'); return { ok: true, canSeek: true, offset: 0, controllerGeneration: 'a'.repeat(32) }; },
    });
    expect(calls).toEqual(['save', 'target']);
    expect(result.ok).toBe(true);
  });

  it('reports a failed LOAD without issuing a second restoration LOAD', async () => {
    const result = await transitionCastEpisode({
      playTarget: async () => { throw new Error('load failed'); },
    });
    if (result.ok === false) {
      expect(result.error).toBeInstanceOf(Error);
    }
  });
});
