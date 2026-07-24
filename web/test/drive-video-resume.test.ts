import { describe, expect, it } from 'vitest';
import {
  driveVideoResumeKey,
  loadDriveVideoResume,
  saveDriveVideoResume,
  type DriveVideoResumeMap,
} from '../src/lib/drive-video-resume';
import { applyPlaybackRate, playbackRateLabel, stepPlaybackRate } from '../src/lib/playback-rate';
import { preferredSubtitleIndex } from '../src/lib/media-tracks';

function memoryStorage(): Storage & { entries: Map<string, string> } {
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

describe('Drive video resume privacy', () => {
  it('discards unscoped legacy data without rendering or migrating it', () => {
    const storage = memoryStorage();
    storage.setItem('cbx.videos.resume.v1', JSON.stringify({ 'f:/private/old.mp4': { pos: 10, dur: 20, at: 1 } }));

    expect(loadDriveVideoResume(7, storage, 'https://aerie.test')).toEqual({});
    expect(storage.getItem('cbx.videos.resume.v1')).toBeNull();
    expect(storage.getItem(driveVideoResumeKey(7, 'https://aerie.test'))).toBeNull();
  });

  it('isolates bounded validated histories by immutable account and server', () => {
    const storage = memoryStorage();
    const first: DriveVideoResumeMap = { 'f:/member-seven.mp4': { pos: 42, dur: 100, at: 20 } };
    saveDriveVideoResume(7, first, storage, 'https://aerie.test/path');

    expect(loadDriveVideoResume(8, storage, 'https://aerie.test')).toEqual({});
    expect(loadDriveVideoResume(7, storage, 'https://other.test')).toEqual({});
    expect(loadDriveVideoResume(7, storage, 'https://aerie.test')).toEqual(first);

    storage.setItem(driveVideoResumeKey(9, 'https://aerie.test'), JSON.stringify({
      valid: { pos: 2, dur: 10, at: 5 },
      negative: { pos: -1, dur: 10, at: 5 },
      malformed: { pos: '2', dur: 10, at: 5 },
    }));
    expect(loadDriveVideoResume(9, storage, 'https://aerie.test')).toEqual({ valid: { pos: 2, dur: 10, at: 5 } });
  });
});

describe('video playback choices', () => {
  it('steps through bounded playback rates', () => {
    expect(stepPlaybackRate(1, 1)).toBe(1.25);
    expect(stepPlaybackRate(1, -1)).toBe(0.75);
    expect(stepPlaybackRate(2, 1)).toBe(2);
    expect(stepPlaybackRate(0.5, -1)).toBe(0.5);
    expect(playbackRateLabel(1.25)).toBe('1.25×');
    const media = { playbackRate: 1, defaultPlaybackRate: 1 };
    expect(applyPlaybackRate(media, 1.5)).toBe(true);
    expect(media).toEqual({ playbackRate: 1.5, defaultPlaybackRate: 1.5 });
    expect(applyPlaybackRate(media, 9)).toBe(false);
  });

  it('prefers an explicit forced subtitle, then the server default', () => {
    expect(preferredSubtitleIndex([
      { index: 1, default: true },
      { index: 2, forced: true },
    ])).toBe(2);
    expect(preferredSubtitleIndex([{ index: 'default', default: true }])).toBe('default');
    expect(preferredSubtitleIndex([{ index: 1 }])).toBeNull();
  });
});
