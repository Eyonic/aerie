import { describe, expect, it } from 'vitest';
import {
  AUTOPLAY_INACTIVITY_MS,
  activeVideoChapterIndex,
  audioTrackDisplayLabel,
  autoplayNeedsInteraction,
  loadVideoPlaybackPreferences,
  matcherForTrack,
  parseVideoPlaybackPreferences,
  sanitizeVideoChapters,
  saveVideoPlaybackPreferences,
  selectPreferredAudioTrack,
  selectPreferredSubtitleTrack,
  videoPlaybackPreferencesKey,
} from '../src/lib/video-preferences';

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

describe('account-scoped video playback preferences', () => {
  it('validates and bounds every remotely stored field', () => {
    expect(parseVideoPlaybackPreferences({
      version: 999,
      audioLanguage: 'ENG_us',
      subtitleLanguage: 'NLD',
      subtitleMode: 'always',
      subtitleOffsetMs: 999_999,
      subtitleAppearance: { sizePct: 2, background: 'rainbow', opacity: -1, edge: 'outline', contrast: 'high' },
      autoplayNextEpisode: 'yes',
      quality: '8k',
      audioOutput: 'headphones',
      manualAudio: { language: 'JPN', label: '<Japanese Commentary>', forced: 1 },
      manualSubtitle: { language: {}, label: [] },
    })).toEqual({
      version: 1,
      audioLanguage: 'en-us',
      subtitleLanguage: 'nl',
      subtitleMode: 'always',
      subtitleOffsetMs: 10_000,
      subtitleAppearance: { sizePct: 75, background: 'black', opacity: 0.2, edge: 'outline', contrast: 'high' },
      autoplayNextEpisode: false,
      quality: 'auto',
      audioOutput: 'auto',
      manualAudio: { language: 'ja', label: 'japanese commentary', forced: false },
      manualSubtitle: null,
    });
  });

  it('keeps the fallback cache isolated by immutable account and server', () => {
    const storage = memoryStorage();
    saveVideoPlaybackPreferences(7, { subtitleMode: 'always', autoplayNextEpisode: true }, storage, 'https://aerie.test/path');

    expect(loadVideoPlaybackPreferences(7, storage, 'https://aerie.test')).toMatchObject({ subtitleMode: 'always', autoplayNextEpisode: true });
    expect(loadVideoPlaybackPreferences(8, storage, 'https://aerie.test')).toMatchObject({ subtitleMode: 'foreign-only', autoplayNextEpisode: false });
    expect(loadVideoPlaybackPreferences(7, storage, 'https://other.test')).toMatchObject({ subtitleMode: 'foreign-only', autoplayNextEpisode: false });
    expect(videoPlaybackPreferencesKey(7, 'https://aerie.test/path')).toContain('u7');
  });
});

describe('episode-to-episode track matching', () => {
  it('labels channel layouts from bounded stream metadata without guessing', () => {
    expect(audioTrackDisplayLabel({ name: 'English AAC', channels: 6 }, 0)).toBe('English AAC · 5.1');
    expect(audioTrackDisplayLabel({ name: 'Dutch', channels: 2 }, 1)).toBe('Dutch · Stereo');
    expect(audioTrackDisplayLabel({ name: 'Director 5.1', channels: 6 }, 2)).toBe('Director 5.1');
    expect(audioTrackDisplayLabel({ name: 'Unknown', channels: null }, 3)).toBe('Unknown');
  });

  it('preserves a manually selected audio variant by language and label instead of unstable stream index', () => {
    const selected = { index: 9, lang: 'eng', name: 'English Commentary' };
    const preferences = parseVideoPlaybackPreferences({
      audioLanguage: 'en',
      manualAudio: matcherForTrack(selected),
    });
    const nextEpisodeTracks = [
      { index: 2, lang: 'eng', name: 'English Stereo', default: true },
      { index: 14, lang: 'eng', name: 'English Commentary' },
      { index: 3, lang: 'jpn', name: 'Japanese' },
    ];

    expect(selectPreferredAudioTrack(nextEpisodeTracks, preferences)?.index).toBe(14);
  });

  it('honors off, foreign-only and always subtitle modes', () => {
    const tracks = [
      { index: 1, lang: 'eng', name: 'English full', default: true },
      { index: 2, lang: 'eng', name: 'English forced', forced: true },
      { index: 3, lang: 'nld', name: 'Dutch full' },
    ];
    expect(selectPreferredSubtitleTrack(tracks, parseVideoPlaybackPreferences({ subtitleMode: 'off' }))).toBeNull();
    expect(selectPreferredSubtitleTrack(tracks, parseVideoPlaybackPreferences({ subtitleMode: 'foreign-only', subtitleLanguage: 'en' }))?.index).toBe(2);
    expect(selectPreferredSubtitleTrack(tracks, parseVideoPlaybackPreferences({ subtitleMode: 'always', subtitleLanguage: 'nl' }))?.index).toBe(3);
  });

  it('preserves the matching manual subtitle variant on the next episode', () => {
    const preferences = parseVideoPlaybackPreferences({
      subtitleMode: 'always',
      subtitleLanguage: 'en',
      manualSubtitle: matcherForTrack({ lang: 'eng', name: 'English SDH' }),
    });
    const nextEpisodeTracks = [
      { index: 4, lang: 'eng', name: 'English' },
      { index: 8, lang: 'eng', name: 'English SDH' },
    ];
    expect(selectPreferredSubtitleTrack(nextEpisodeTracks, preferences)?.index).toBe(8);
  });
});

describe('video chapters and autoplay guard', () => {
  it('sorts, bounds and derives ordinary chapter ranges', () => {
    const chapters = sanitizeVideoChapters([
      { name: 'Finale', startSec: 120 },
      { title: 'Opening', start: 0 },
      { name: 'Middle', startSec: 60 },
      { name: 'Duplicate', startSec: 60 },
      { name: '', startSec: 30 },
      { name: 'Invalid', startSec: -4 },
    ], 180);
    expect(chapters).toEqual([
      { name: 'Opening', startSec: 0, endSec: 60 },
      { name: 'Middle', startSec: 60, endSec: 120 },
      { name: 'Finale', startSec: 120, endSec: 180 },
    ]);
    expect(activeVideoChapterIndex(chapters, 0)).toBe(0);
    expect(activeVideoChapterIndex(chapters, 119.9)).toBe(1);
    expect(activeVideoChapterIndex(chapters, 120)).toBe(2);
  });

  it('requires interaction after two hours instead of continuing an endless binge', () => {
    const now = 10 * AUTOPLAY_INACTIVITY_MS;
    expect(autoplayNeedsInteraction(now - AUTOPLAY_INACTIVITY_MS + 1, now)).toBe(false);
    expect(autoplayNeedsInteraction(now - AUTOPLAY_INACTIVITY_MS, now)).toBe(true);
  });
});
