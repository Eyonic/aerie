export type PlaybackQuality = 'auto' | 'original' | '2160p' | '1440p' | '1080p' | '720p' | '480p' | '360p';
export type VideoDelivery = 'direct_play' | 'remux' | 'transcode';

export type PlaybackVariant = {
  id: string;
  label: string;
  width: number | null;
  height: number | null;
  videoBitrate: number;
  bitrate: number;
  delivery: Exclude<VideoDelivery, 'direct_play'>;
};

export type VideoPlaybackPlan = {
  streamUrl: string;
  hls: boolean;
  mime: string;
  delivery: VideoDelivery;
  adaptive: boolean;
  quality: PlaybackQuality;
  source: {
    id: string; name: string | null; container: string;
    width: number | null; height: number | null; bitrate: number | null;
    videoCodec: string; audioCodec: string | null; audioChannels: number | null;
  };
  output: {
    width: number | null; height: number | null; bitrate: number | null;
    videoCodec: string; audioCodec: string | null; audioChannels: number | null;
  };
  audio: { selectedStreamIndex: number | null; surroundAvailable: boolean; stereoFallback: boolean };
  reasons: string[];
  variants: PlaybackVariant[];
  qualityOptions: { id: PlaybackQuality; label: string; height: number | null }[];
};

export const PLAYBACK_QUALITY_IDS: PlaybackQuality[] = ['auto', 'original', '2160p', '1440p', '1080p', '720p', '480p', '360p'];
const QUALITY_SET = new Set(PLAYBACK_QUALITY_IDS);
const DELIVERY_SET = new Set<VideoDelivery>(['direct_play', 'remux', 'transcode']);

function finite(value: unknown, max = 1_000_000_000): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= max ? value : null;
}

function boundedText(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const text = value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  return text ? text.slice(0, max) : null;
}

function safeStreamUrl(value: unknown): string | null {
  if (typeof value !== 'string' || !value.startsWith('/api/media/') || value.length > 2048 || value.includes('\\')) return null;
  try {
    const parsed = new URL(value, 'https://aerie.invalid');
    if (parsed.origin !== 'https://aerie.invalid' || !parsed.pathname.startsWith('/api/media/')) return null;
    const forbidden = ['api_key', 'apikey', 'access_token', 'token', 'x-emby-token'];
    for (const key of forbidden) if (parsed.searchParams.has(key)) return null;
    return value;
  } catch { return null; }
}

function dimensions(value: unknown) {
  const raw = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  return {
    width: finite(raw.width, 16_384), height: finite(raw.height, 16_384), bitrate: finite(raw.bitrate),
    videoCodec: boundedText(raw.videoCodec, 40) || 'unknown',
    audioCodec: boundedText(raw.audioCodec, 40),
    audioChannels: finite(raw.audioChannels, 32),
  };
}

/** Treat the server plan as data, not authority to navigate to an arbitrary URL. */
export function parseVideoPlaybackPlan(value: unknown): VideoPlaybackPlan | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, any>;
  const streamUrl = safeStreamUrl(raw.streamUrl);
  const quality = QUALITY_SET.has(raw.quality) ? raw.quality as PlaybackQuality : null;
  const delivery = DELIVERY_SET.has(raw.delivery) ? raw.delivery as VideoDelivery : null;
  if (!streamUrl || !quality || !delivery || typeof raw.hls !== 'boolean' || typeof raw.adaptive !== 'boolean') return null;
  const sourceRaw = raw.source && typeof raw.source === 'object' && !Array.isArray(raw.source) ? raw.source : {};
  const output = dimensions(raw.output);
  const sourceDimensions = dimensions(sourceRaw);
  const sourceId = boundedText(sourceRaw.id, 256);
  if (!sourceId) return null;
  const qualityOptions = (Array.isArray(raw.qualityOptions) ? raw.qualityOptions : []).slice(0, PLAYBACK_QUALITY_IDS.length)
    .filter((option: any) => option && QUALITY_SET.has(option.id) && boundedText(option.label, 80))
    .map((option: any) => ({ id: option.id as PlaybackQuality, label: boundedText(option.label, 80)!, height: finite(option.height, 4320) }));
  if (!qualityOptions.some(option => option.id === 'auto')) qualityOptions.unshift({ id: 'auto', label: 'Auto', height: null });
  if (!qualityOptions.some(option => option.id === quality)) {
    qualityOptions.push({ id: quality, label: quality === 'original' ? 'Original' : quality, height: null });
  }
  const variants = (Array.isArray(raw.variants) ? raw.variants : []).slice(0, 10).flatMap((variant: any): PlaybackVariant[] => {
    const variantDelivery = variant?.delivery === 'remux' || variant?.delivery === 'transcode' ? variant.delivery : null;
    const id = boundedText(variant?.id, 40), label = boundedText(variant?.label, 80);
    const bitrate = finite(variant?.bitrate), videoBitrate = finite(variant?.videoBitrate);
    if (!variantDelivery || !id || !label || bitrate == null || videoBitrate == null) return [];
    return [{ id, label, delivery: variantDelivery, bitrate, videoBitrate,
      width: finite(variant.width, 16_384), height: finite(variant.height, 16_384) }];
  });
  const audioRaw = raw.audio && typeof raw.audio === 'object' && !Array.isArray(raw.audio) ? raw.audio : {};
  return {
    streamUrl, hls: raw.hls, mime: boundedText(raw.mime, 120) || (raw.hls ? 'application/vnd.apple.mpegurl' : 'video/mp4'),
    delivery, adaptive: raw.adaptive, quality,
    source: {
      id: sourceId, name: boundedText(sourceRaw.name, 160), container: boundedText(sourceRaw.container, 40) || 'unknown',
      ...sourceDimensions,
    },
    output,
    audio: {
      selectedStreamIndex: finite(audioRaw.selectedStreamIndex, 512),
      surroundAvailable: audioRaw.surroundAvailable === true,
      stereoFallback: audioRaw.stereoFallback === true,
    },
    reasons: (Array.isArray(raw.reasons) ? raw.reasons : []).slice(0, 20).map((reason: unknown) => boundedText(reason, 80)).filter(Boolean) as string[],
    variants, qualityOptions,
  };
}

/**
 * hls.js sorts parsed levels by resolution before exposing their numeric index,
 * while the server's plan is ordered by bitrate. Match the live level by its
 * manifest metadata first so the status UI never reports a different rung.
 */
export function playbackVariantForHlsLevel(
  variants: PlaybackVariant[],
  level: { width?: unknown; height?: unknown; bitrate?: unknown; name?: unknown } | null | undefined,
  fallbackIndex: number,
): PlaybackVariant | null {
  if (!variants.length) return null;
  const width = finite(level?.width, 16_384);
  const height = finite(level?.height, 16_384);
  const bitrate = finite(level?.bitrate);
  if (height != null && height > 0) {
    const sameHeight = variants.filter(variant => variant.height === height);
    if (sameHeight.length) {
      if (width != null && width > 0) {
        const exactSize = sameHeight.find(variant => variant.width === width);
        if (exactSize) return exactSize;
      }
      if (bitrate != null && bitrate > 0) {
        const exactBitrate = sameHeight.find(variant => variant.bitrate === bitrate);
        if (exactBitrate) return exactBitrate;
      }
      return sameHeight[0];
    }
  }
  const name = boundedText(level?.name, 80)?.toLowerCase();
  if (name) {
    const named = variants.find(variant => variant.id.toLowerCase() === name || variant.label.toLowerCase() === name);
    if (named) return named;
  }
  if (bitrate != null && bitrate > 0) {
    const exactBitrate = variants.find(variant => variant.bitrate === bitrate);
    if (exactBitrate) return exactBitrate;
  }
  return Number.isInteger(fallbackIndex) && fallbackIndex >= 0 ? variants[fallbackIndex] || null : null;
}

export function playbackStatusLabel(plan: VideoPlaybackPlan, activeVariant?: PlaybackVariant | null): string {
  const delivery = activeVariant?.delivery || plan.delivery;
  const method = delivery === 'direct_play' ? 'Direct Play' : delivery === 'remux' ? 'Remux' : 'Transcoding';
  const height = activeVariant?.height ?? plan.output.height ?? plan.source.height;
  const bitrate = activeVariant?.bitrate ?? plan.output.bitrate ?? plan.source.bitrate;
  const bitrateLabel = bitrate ? `${bitrate >= 10_000_000 ? Math.round(bitrate / 1_000_000) : (bitrate / 1_000_000).toFixed(1)} Mbps` : '';
  const audioLabel = plan.audio.stereoFallback ? 'Stereo fallback'
    : (plan.output.audioChannels || 0) >= 6 ? '5.1 audio' : '';
  return [plan.adaptive ? 'Adaptive' : '', method, height ? `${Math.round(height)}p` : '', bitrateLabel, audioLabel].filter(Boolean).join(' · ');
}
