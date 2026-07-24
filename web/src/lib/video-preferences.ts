import { accountScopedStorageKey } from './account-storage';
import { PLAYBACK_QUALITY_IDS, type PlaybackQuality } from './video-playback-plan';

export type SubtitleMode = 'off' | 'foreign-only' | 'always';
export type SubtitleBackground = 'none' | 'black';
export type SubtitleEdge = 'none' | 'shadow' | 'outline';
export type SubtitleContrast = 'normal' | 'high';
export type AudioOutputPreference = 'auto' | 'stereo' | 'surround';

export type MediaTrackLike = {
  index?: number | string | null;
  lang?: unknown;
  language?: unknown;
  name?: unknown;
  label?: unknown;
  default?: unknown;
  forced?: unknown;
};

export type TrackMatcher = {
  language: string;
  label: string;
  forced: boolean;
};

export type SubtitleAppearance = {
  sizePct: number;
  background: SubtitleBackground;
  opacity: number;
  edge: SubtitleEdge;
  contrast: SubtitleContrast;
};

export type VideoPlaybackPreferences = {
  version: 1;
  audioLanguage: string;
  subtitleLanguage: string;
  subtitleMode: SubtitleMode;
  subtitleOffsetMs: number;
  subtitleAppearance: SubtitleAppearance;
  autoplayNextEpisode: boolean;
  quality: PlaybackQuality;
  audioOutput: AudioOutputPreference;
  manualAudio: TrackMatcher | null;
  manualSubtitle: TrackMatcher | null;
};

export type VideoChapter = {
  name: string;
  startSec: number;
  endSec?: number;
};

export const DEFAULT_VIDEO_PLAYBACK_PREFERENCES: VideoPlaybackPreferences = {
  version: 1,
  audioLanguage: '',
  subtitleLanguage: '',
  subtitleMode: 'foreign-only',
  subtitleOffsetMs: 0,
  subtitleAppearance: {
    sizePct: 100,
    background: 'black',
    opacity: 0.6,
    edge: 'shadow',
    contrast: 'normal',
  },
  autoplayNextEpisode: false,
  quality: 'auto',
  audioOutput: 'auto',
  manualAudio: null,
  manualSubtitle: null,
};

const STORAGE_NAMESPACE = 'aerie-video-playback-v1';
const MAX_CHAPTERS = 500;
const MAX_VIDEO_SECONDS = 48 * 60 * 60;
const PLAYBACK_QUALITY_SET = new Set<PlaybackQuality>(PLAYBACK_QUALITY_IDS);
export const AUTOPLAY_INACTIVITY_MS = 2 * 60 * 60 * 1000;

const LANGUAGE_ALIASES: Record<string, string> = {
  ara: 'ar', chi: 'zh', zho: 'zh', cze: 'cs', ces: 'cs', dan: 'da', dut: 'nl', nld: 'nl',
  eng: 'en', fin: 'fi', fre: 'fr', fra: 'fr', ger: 'de', deu: 'de', gre: 'el', ell: 'el',
  heb: 'he', hin: 'hi', ita: 'it', jpn: 'ja', kor: 'ko', nor: 'no', pol: 'pl', por: 'pt',
  rum: 'ro', ron: 'ro', rus: 'ru', spa: 'es', swe: 'sv', tur: 'tr', ukr: 'uk', vie: 'vi',
};

function finiteNumber(value: unknown): number | null {
  const result = typeof value === 'number' ? value : Number.NaN;
  return Number.isFinite(result) ? result : null;
}

function boundedNumber(value: unknown, fallback: number, min: number, max: number, step?: number): number {
  const parsed = finiteNumber(value);
  if (parsed == null) return fallback;
  const bounded = Math.max(min, Math.min(max, parsed));
  return step ? Math.round(bounded / step) * step : bounded;
}

export function normalizeTrackLanguage(value: unknown): string {
  const raw = typeof value === 'string' ? value.trim().toLowerCase().replace(/_/g, '-') : '';
  if (!raw || raw === 'und' || raw === 'unknown') return '';
  const parts = raw.split('-').filter(Boolean);
  const language = LANGUAGE_ALIASES[parts[0]] || parts[0];
  return [language, ...parts.slice(1)].join('-').slice(0, 35);
}

function normalizeTrackLabel(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.toLowerCase()
    .replace(/\b(default|forced)\b/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .slice(0, 120);
}

function cleanMatcher(value: unknown): TrackMatcher | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Partial<TrackMatcher>;
  const language = normalizeTrackLanguage(raw.language);
  const label = normalizeTrackLabel(raw.label);
  if (!language && !label) return null;
  return { language, label, forced: raw.forced === true };
}

export function matcherForTrack(track: MediaTrackLike): TrackMatcher | null {
  const language = normalizeTrackLanguage(track.lang ?? track.language);
  const label = normalizeTrackLabel(track.name ?? track.label);
  if (!language && !label) return null;
  return { language, label, forced: track.forced === true };
}

export function audioTrackDisplayLabel(track: MediaTrackLike & { channels?: unknown }, index: number): string {
  const base = String(track.name || track.label || track.lang || track.language || `Audio ${index + 1}`);
  const channels = Number(track.channels);
  if (!Number.isInteger(channels) || channels < 1 || channels > 32 || /\b(?:mono|stereo|[257]\.1|\d+\s*channels?)\b/i.test(base)) return base;
  const layout = channels === 1 ? 'Mono' : channels === 2 ? 'Stereo' : channels === 6 ? '5.1' : channels === 8 ? '7.1' : `${channels} channels`;
  return `${base} · ${layout}`;
}

function cleanAppearance(value: unknown): SubtitleAppearance {
  const raw = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Partial<SubtitleAppearance> : {};
  return {
    sizePct: boundedNumber(raw.sizePct, DEFAULT_VIDEO_PLAYBACK_PREFERENCES.subtitleAppearance.sizePct, 75, 175, 5),
    background: raw.background === 'none' ? 'none' : 'black',
    opacity: boundedNumber(raw.opacity, DEFAULT_VIDEO_PLAYBACK_PREFERENCES.subtitleAppearance.opacity, 0.2, 1, 0.05),
    edge: raw.edge === 'none' || raw.edge === 'outline' ? raw.edge : 'shadow',
    contrast: raw.contrast === 'high' ? 'high' : 'normal',
  };
}

export function parseVideoPlaybackPreferences(value: unknown): VideoPlaybackPreferences {
  const raw = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Partial<VideoPlaybackPreferences> : {};
  return {
    version: 1,
    audioLanguage: normalizeTrackLanguage(raw.audioLanguage),
    subtitleLanguage: normalizeTrackLanguage(raw.subtitleLanguage),
    subtitleMode: raw.subtitleMode === 'off' || raw.subtitleMode === 'always' ? raw.subtitleMode : 'foreign-only',
    subtitleOffsetMs: boundedNumber(raw.subtitleOffsetMs, 0, -10_000, 10_000, 100),
    subtitleAppearance: cleanAppearance(raw.subtitleAppearance),
    autoplayNextEpisode: raw.autoplayNextEpisode === true,
    quality: PLAYBACK_QUALITY_SET.has(raw.quality as PlaybackQuality) ? raw.quality as PlaybackQuality : 'auto',
    audioOutput: raw.audioOutput === 'stereo' || raw.audioOutput === 'surround' ? raw.audioOutput : 'auto',
    manualAudio: cleanMatcher(raw.manualAudio),
    manualSubtitle: cleanMatcher(raw.manualSubtitle),
  };
}

function browserStorage(): Storage | null {
  try { return typeof localStorage === 'undefined' ? null : localStorage; }
  catch { return null; }
}

export function videoPlaybackPreferencesKey(accountId: number, serverOrigin?: string): string {
  return accountScopedStorageKey(STORAGE_NAMESPACE, accountId, serverOrigin);
}

export function loadVideoPlaybackPreferences(
  accountId: number | null,
  storage: Storage | null = browserStorage(),
  serverOrigin?: string,
): VideoPlaybackPreferences {
  if (!accountId || !Number.isSafeInteger(accountId) || accountId < 1 || !storage) {
    return parseVideoPlaybackPreferences(null);
  }
  try {
    return parseVideoPlaybackPreferences(JSON.parse(storage.getItem(videoPlaybackPreferencesKey(accountId, serverOrigin)) || 'null'));
  } catch {
    return parseVideoPlaybackPreferences(null);
  }
}

export function saveVideoPlaybackPreferences(
  accountId: number | null,
  value: unknown,
  storage: Storage | null = browserStorage(),
  serverOrigin?: string,
): VideoPlaybackPreferences {
  const clean = parseVideoPlaybackPreferences(value);
  if (!accountId || !Number.isSafeInteger(accountId) || accountId < 1 || !storage) return clean;
  try { storage.setItem(videoPlaybackPreferencesKey(accountId, serverOrigin), JSON.stringify(clean)); } catch { /* storage unavailable/quota */ }
  return clean;
}

function trackLanguage(track: MediaTrackLike): string {
  return normalizeTrackLanguage(track.lang ?? track.language);
}

function trackLabel(track: MediaTrackLike): string {
  return normalizeTrackLabel(track.name ?? track.label);
}

function bestMatcherTrack<T extends MediaTrackLike>(tracks: T[], matcher: TrackMatcher | null): T | null {
  if (!matcher) return null;
  let best: { track: T; score: number } | null = null;
  for (const track of tracks) {
    const language = trackLanguage(track);
    const label = trackLabel(track);
    if (matcher.language && language !== matcher.language) continue;
    if (!matcher.language && matcher.label && label !== matcher.label) continue;
    let score = language && language === matcher.language ? 100 : 0;
    if (label && label === matcher.label) score += 30;
    if ((track.forced === true) === matcher.forced) score += 10;
    if (!best || score > best.score) best = { track, score };
  }
  return best?.track || null;
}

function tracksInLanguage<T extends MediaTrackLike>(tracks: T[], language: string): T[] {
  if (!language) return tracks;
  const exact = tracks.filter(track => trackLanguage(track) === language);
  if (exact.length) return exact;
  const base = language.split('-')[0];
  return tracks.filter(track => trackLanguage(track).split('-')[0] === base);
}

export function selectPreferredAudioTrack<T extends MediaTrackLike>(
  tracks: T[], preferences: VideoPlaybackPreferences,
): T | null {
  if (!tracks.length) return null;
  const manual = bestMatcherTrack(tracks, preferences.manualAudio);
  if (manual) return manual;
  const language = tracksInLanguage(tracks, preferences.audioLanguage);
  return language.find(track => track.default === true) || language[0]
    || tracks.find(track => track.default === true) || tracks[0];
}

export function selectPreferredSubtitleTrack<T extends MediaTrackLike>(
  tracks: T[], preferences: VideoPlaybackPreferences,
): T | null {
  if (!tracks.length || preferences.subtitleMode === 'off') return null;
  const modeTracks = preferences.subtitleMode === 'foreign-only'
    ? tracks.filter(track => track.forced === true)
    : tracks;
  if (!modeTracks.length) return null;
  const language = tracksInLanguage(modeTracks, preferences.subtitleLanguage);
  const manual = bestMatcherTrack(language.length ? language : modeTracks, preferences.manualSubtitle);
  if (manual) return manual;
  if (preferences.subtitleMode === 'always') {
    return language.find(track => track.default === true && track.forced !== true)
      || language.find(track => track.forced !== true)
      || language.find(track => track.default === true)
      || language[0]
      || modeTracks.find(track => track.default === true && track.forced !== true)
      || modeTracks.find(track => track.forced !== true)
      || modeTracks[0];
  }
  return language.find(track => track.default === true) || language[0]
    || modeTracks.find(track => track.default === true) || modeTracks[0];
}

export function sanitizeVideoChapters(value: unknown, durationSec = 0): VideoChapter[] {
  const raw = Array.isArray(value) ? value : [];
  const chapters: VideoChapter[] = [];
  for (const entry of raw.slice(0, MAX_CHAPTERS * 2)) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const item = entry as Record<string, unknown>;
    const start = finiteNumber(item.startSec) ?? finiteNumber(item.start);
    if (start == null || start < 0 || start > MAX_VIDEO_SECONDS) continue;
    const nameValue = item.name ?? item.title;
    const name = typeof nameValue === 'string' ? nameValue.trim().replace(/\s+/g, ' ').slice(0, 160) : '';
    if (!name) continue;
    const endValue = finiteNumber(item.endSec) ?? finiteNumber(item.end);
    chapters.push({ name, startSec: Math.round(start * 1000) / 1000,
      ...(endValue != null && endValue > start && endValue <= MAX_VIDEO_SECONDS ? { endSec: Math.round(endValue * 1000) / 1000 } : {}) });
  }
  chapters.sort((a, b) => a.startSec - b.startSec);
  const unique = chapters.filter((chapter, index) => index === 0 || chapter.startSec > chapters[index - 1].startSec + 0.01).slice(0, MAX_CHAPTERS);
  return unique.map((chapter, index) => {
    const nextStart = unique[index + 1]?.startSec;
    const endSec = nextStart ?? chapter.endSec ?? (durationSec > chapter.startSec ? durationSec : undefined);
    return { ...chapter, ...(endSec != null && endSec > chapter.startSec ? { endSec } : {}) };
  });
}

export function activeVideoChapterIndex(chapters: VideoChapter[], currentSec: number): number {
  if (!chapters.length || !Number.isFinite(currentSec)) return -1;
  let current = -1;
  for (let index = 0; index < chapters.length; index++) {
    if (chapters[index].startSec > currentSec + 0.05) break;
    current = index;
  }
  return current;
}

export function autoplayNeedsInteraction(lastInteractionAt: number, now = Date.now()): boolean {
  return !Number.isFinite(lastInteractionAt) || !Number.isFinite(now)
    || now - lastInteractionAt >= AUTOPLAY_INACTIVITY_MS;
}
