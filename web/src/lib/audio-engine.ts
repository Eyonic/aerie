// Pages that offer audiobook/podcast chapter controls must address Aerie's
// single persistent playback engine, not whichever preview <audio> happens to
// appear first in the document.
export const AUDIO_ENGINE_SELECTOR = 'audio[data-aerie-player-engine="true"]';

export function getAudioEngine(): HTMLAudioElement | null {
  return typeof document === 'undefined'
    ? null
    : document.querySelector<HTMLAudioElement>(AUDIO_ENGINE_SELECTOR);
}

export function shouldRestartCurrentTrack(positionSec: number): boolean {
  return Number.isFinite(positionSec) && positionSec > 3;
}

export function shouldLoopCurrentTrack(kind: string, repeat: 'off' | 'one' | 'all', queueLength: number): boolean {
  return kind === 'music' && (repeat === 'one' || (repeat === 'all' && queueLength === 1));
}

export function canAdvanceQueue(queueLength: number, index: number, shuffle: boolean, shuffleRemaining: number, repeat: 'off' | 'one' | 'all'): boolean {
  if (queueLength <= 1) return false;
  return shuffle ? shuffleRemaining > 0 || repeat === 'all' : index < queueLength - 1 || repeat === 'all';
}

/**
 * Predict the exact item that PlayerState.next() will select without consuming
 * the shuffle bag. A shuffled repeat-all boundary is deliberately not
 * predicted: next() creates a newly randomized bag there, so guessing would
 * preload the wrong private stream as often as the right one.
 */
export function nextQueueIndex(
  queueLength: number,
  index: number,
  shuffle: boolean,
  shuffleRemaining: readonly number[],
  repeat: 'off' | 'one' | 'all',
): number | null {
  if (queueLength <= 1 || index < 0 || index >= queueLength) return null;
  if (shuffle) {
    const next = shuffleRemaining[0];
    return Number.isInteger(next) && next >= 0 && next < queueLength && next !== index ? next : null;
  }
  if (index + 1 < queueLength) return index + 1;
  return repeat === 'all' ? 0 : null;
}

export interface ReplayGainMetadata {
  trackDb?: number;
  albumDb?: number;
  trackPeak?: number;
  albumPeak?: number;
}

export interface ReplayGainTrack {
  kind: string;
  replayGain?: ReplayGainMetadata;
}

export interface LoudnessNormalization {
  available: boolean;
  enabled: boolean;
  source: 'album' | 'track' | 'none';
  multiplier: number;
  requestedDb?: number;
  appliedDb?: number;
  limited: boolean;
  message: string;
}

function boundedDb(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= -60 && value <= 24 ? value : null;
}

function boundedPeak(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= 16 ? value : null;
}

function dbLabel(value: number): string {
  const rounded = Math.abs(value) < 0.05 ? 0 : Math.round(value * 10) / 10;
  return `${rounded > 0 ? '+' : ''}${rounded.toFixed(1)} dB`;
}

/**
 * Resolve exact library-provided loudness gain without substituting a
 * compressor or a client-side estimate. Ordered playback preserves album dynamics by
 * preferring album gain; shuffle uses per-track gain. If album tags are absent
 * we can truthfully fall back to track gain, but a shuffled track never falls
 * back to album gain because that would not normalize a mixed queue.
 *
 * Positive gain is applied only with peak metadata (and Web Audio support), so
 * the result cannot introduce digital clipping. Attenuation remains safe in a
 * browser that only exposes HTMLMediaElement.volume.
 */
export function resolveLoudnessNormalization(
  track: ReplayGainTrack | null | undefined,
  enabled: boolean,
  shuffled: boolean,
  webAudioSupported: boolean,
): LoudnessNormalization {
  if (!track || track.kind !== 'music') {
    return { available: false, enabled, source: 'none', multiplier: 1, limited: false, message: 'Loudness normalization is only used for music.' };
  }
  const metadata = track.replayGain;
  const trackDb = boundedDb(metadata?.trackDb);
  const albumDb = boundedDb(metadata?.albumDb);
  const preferred = shuffled ? trackDb : albumDb;
  const fallback = !shuffled && preferred == null ? trackDb : null;
  const requestedDb = preferred ?? fallback;
  const source: LoudnessNormalization['source'] = requestedDb == null ? 'none' : preferred != null && !shuffled ? 'album' : 'track';
  if (requestedDb == null) {
    return {
      available: false, enabled, source: 'none', multiplier: 1, limited: false,
      message: shuffled
        ? 'Unavailable for this track: no exact track loudness metadata.'
        : 'Unavailable for this track: no exact loudness metadata.',
    };
  }
  if (!enabled) {
    return { available: true, enabled: false, source, multiplier: 1, requestedDb, appliedDb: 0, limited: false, message: 'Loudness normalization is off.' };
  }

  const preferredPeak = source === 'album' ? boundedPeak(metadata?.albumPeak) : boundedPeak(metadata?.trackPeak);
  const fallbackPeak = preferredPeak ?? boundedPeak(metadata?.trackPeak) ?? boundedPeak(metadata?.albumPeak);
  let appliedDb = requestedDb;
  let limited = false;
  let limitReason = '';

  if (fallbackPeak != null) {
    const clippingCeilingDb = -20 * Math.log10(fallbackPeak);
    if (appliedDb > clippingCeilingDb) {
      appliedDb = clippingCeilingDb;
      limited = true;
      limitReason = 'clipping protection';
    }
  } else if (appliedDb > 0) {
    // An unverified boost is the one operation that could create clipping.
    // Apply no boost, but retain any safe attenuation when gain is negative.
    appliedDb = 0;
    limited = true;
    limitReason = 'peak metadata is missing';
  }
  if (!webAudioSupported && appliedDb > 0) {
    appliedDb = 0;
    limited = true;
    limitReason = 'this browser cannot apply a protected boost';
  }

  const mode = source === 'album'
    ? 'Album gain'
    : shuffled ? 'Track gain (shuffle)' : albumDb == null ? 'Track gain (album tag unavailable)' : 'Track gain';
  const message = `${mode}: ${dbLabel(appliedDb)}${limited ? ` · limited by ${limitReason}` : ''}`;
  return {
    available: true,
    enabled: true,
    source,
    multiplier: Math.pow(10, appliedDb / 20),
    requestedDb,
    appliedDb,
    limited,
    message,
  };
}
