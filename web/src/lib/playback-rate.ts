export const VIDEO_PLAYBACK_RATES = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2] as const;

export function playbackRateLabel(rate: number): string {
  return `${Number(rate.toFixed(2))}×`;
}

export function stepPlaybackRate(current: number, direction: -1 | 1): number {
  const epsilon = 0.001;
  if (direction > 0) return VIDEO_PLAYBACK_RATES.find(rate => rate > current + epsilon) ?? VIDEO_PLAYBACK_RATES[VIDEO_PLAYBACK_RATES.length - 1];
  return [...VIDEO_PLAYBACK_RATES].reverse().find(rate => rate < current - epsilon) ?? VIDEO_PLAYBACK_RATES[0];
}

export function applyPlaybackRate(media: Pick<HTMLMediaElement, 'defaultPlaybackRate' | 'playbackRate'>, rate: number): boolean {
  if (!VIDEO_PLAYBACK_RATES.includes(rate as typeof VIDEO_PLAYBACK_RATES[number])) return false;
  // Resource loads reset playbackRate to defaultPlaybackRate in some engines.
  // Updating both keeps a chosen speed through an episode/source transition.
  media.defaultPlaybackRate = rate;
  media.playbackRate = rate;
  return true;
}
