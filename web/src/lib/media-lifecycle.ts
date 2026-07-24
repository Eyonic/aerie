type MetadataMedia = Pick<HTMLMediaElement, 'readyState' | 'addEventListener' | 'removeEventListener'>;
type ReloadMedia = Pick<HTMLMediaElement, 'currentTime' | 'paused' | 'readyState'>;

export type StreamReloadIntent = { itemId: string; startAt: number; autoplay: boolean };

const safeStartAt = (value: unknown, fallback = 0) => {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0 ? numeric : fallback;
};

/**
 * Capture the position and play/pause intent before replacing a media source.
 * A timeline from another episode, or one whose metadata is not ready yet,
 * must use the pending episode-specific snapshot instead of transient media
 * values such as currentTime=0 and paused=true.
 */
export function resolveStreamReloadIntent(
  media: ReloadMedia | null | undefined,
  mediaItemId: string | null,
  requestedItemId: string,
  pending: StreamReloadIntent,
  fallbackStartAt = 0,
): StreamReloadIntent {
  const pendingMatches = pending.itemId === requestedItemId;
  const base = {
    itemId: requestedItemId,
    startAt: pendingMatches ? safeStartAt(pending.startAt, safeStartAt(fallbackStartAt)) : safeStartAt(fallbackStartAt),
    autoplay: pendingMatches ? pending.autoplay : true,
  };
  if (media == null || mediaItemId !== requestedItemId || media.readyState < 1) return base;
  return {
    itemId: requestedItemId,
    startAt: safeStartAt(media.currentTime, base.startAt),
    autoplay: !media.paused,
  };
}

/**
 * Run a playback transition only after the media timeline exists. HLS manifests
 * can be ready before HTMLMediaElement metadata, when assigning currentTime is
 * still rejected or silently ignored by some browsers.
 */
export function whenMediaMetadataReady(media: MetadataMedia, callback: () => void): () => void {
  let active = true;
  const ready = () => {
    if (!active) return;
    active = false;
    media.removeEventListener('loadedmetadata', ready);
    callback();
  };
  if (media.readyState >= 1) ready();
  else media.addEventListener('loadedmetadata', ready, { once: true });
  return () => {
    active = false;
    media.removeEventListener('loadedmetadata', ready);
  };
}
