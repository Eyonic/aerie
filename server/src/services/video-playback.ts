// Browser video delivery planning.  Jellyfin remains the media engine, while
// Aerie owns the small, credential-free contract exposed to its players.

export type PlaybackQuality = 'auto' | 'original' | '2160p' | '1440p' | '1080p' | '720p' | '480p' | '360p';
export type VideoDelivery = 'direct_play' | 'remux' | 'transcode';

export interface PlaybackCapabilities {
  containers: string[];
  videoCodecs: string[];
  audioCodecs: string[];
  maxAudioChannels: 2 | 6;
  maxWidth?: number;
  maxHeight?: number;
  maxStreamingBitrate?: number;
  allowDirectPlay: boolean;
}

export interface PlaybackRequest {
  quality: PlaybackQuality;
  audioStreamIndex: number | null;
  sourceId: string | null;
  nativeHls: boolean;
  capabilities: PlaybackCapabilities;
}

export interface VideoStreamDescription {
  index: number;
  codec: string;
  width: number | null;
  height: number | null;
  bitrate: number | null;
  bitDepth: number | null;
  profile: string | null;
  level: number | null;
  range: string | null;
  interlaced: boolean;
  anamorphic: boolean;
}

export interface AudioStreamDescription {
  index: number;
  codec: string;
  channels: number | null;
  bitrate: number | null;
  language: string | null;
  title: string;
  default: boolean;
}

export interface VideoMediaSource {
  id: string;
  name: string | null;
  containers: string[];
  bitrate: number | null;
  supportsDirectPlay: boolean;
  supportsDirectStream: boolean;
  supportsTranscoding: boolean;
  defaultAudioStreamIndex: number | null;
  video: VideoStreamDescription;
  audio: AudioStreamDescription[];
}

export interface PlaybackVariant {
  id: string;
  label: string;
  width: number | null;
  height: number | null;
  videoBitrate: number;
  bitrate: number;
  delivery: Exclude<VideoDelivery, 'direct_play'>;
}

export interface PlaybackPlan {
  streamUrl: string;
  hls: boolean;
  mime: string;
  delivery: VideoDelivery;
  adaptive: boolean;
  quality: PlaybackQuality;
  source: {
    id: string;
    name: string | null;
    container: string;
    width: number | null;
    height: number | null;
    bitrate: number | null;
    videoCodec: string;
    audioCodec: string | null;
    audioChannels: number | null;
  };
  output: {
    width: number | null;
    height: number | null;
    bitrate: number | null;
    videoCodec: string;
    audioCodec: string | null;
    audioChannels: number | null;
  };
  audio: {
    selectedStreamIndex: number | null;
    surroundAvailable: boolean;
    stereoFallback: boolean;
  };
  reasons: string[];
  variants: PlaybackVariant[];
  qualityOptions: { id: PlaybackQuality; label: string; height: number | null }[];
}

export interface ChapterMetadata {
  name: string;
  startSec: number;
  endSec?: number;
}

const QUALITY_PRESETS: Record<Exclude<PlaybackQuality, 'auto' | 'original'>, { height: number; videoBitrate: number }> = {
  '2160p': { height: 2160, videoBitrate: 35_000_000 },
  '1440p': { height: 1440, videoBitrate: 20_000_000 },
  '1080p': { height: 1080, videoBitrate: 12_000_000 },
  '720p': { height: 720, videoBitrate: 6_000_000 },
  '480p': { height: 480, videoBitrate: 2_500_000 },
  '360p': { height: 360, videoBitrate: 1_000_000 },
};

const QUALITY_ORDER = Object.entries(QUALITY_PRESETS)
  .map(([id, preset]) => ({ id: id as keyof typeof QUALITY_PRESETS, ...preset }))
  .sort((a, b) => b.height - a.height);
const QUALITY_IDS = new Set<PlaybackQuality>(['auto', 'original', ...Object.keys(QUALITY_PRESETS) as PlaybackQuality[]]);
const CONTAINERS = new Set(['mp4', 'm4v', 'mov', 'webm']);
const VIDEO_CODECS = new Set(['h264', 'hevc', 'vp9', 'av1']);
const AUDIO_CODECS = new Set(['aac', 'mp3', 'opus', 'vorbis', 'flac', 'ac3', 'eac3']);
const SAFE_ID = /^[A-Za-z0-9._:-]{1,256}$/;

function badOptions(): never {
  throw Object.assign(new Error('invalid_playback_options'), { status: 400 });
}

function scalar(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (Array.isArray(value) || typeof value === 'object') badOptions();
  const text = String(value);
  if (text.length > 512) badOptions();
  return text;
}

function integer(value: unknown, min: number, max: number): number | undefined {
  const text = scalar(value);
  if (text === undefined) return undefined;
  if (!/^\d+$/.test(text)) badOptions();
  const number = Number(text);
  if (!Number.isSafeInteger(number) || number < min || number > max) badOptions();
  return number;
}

function list(value: unknown, allowed: Set<string>, fallback: string[]): string[] {
  const text = scalar(value);
  if (text === undefined || text === '') return [...fallback];
  const values = [...new Set(text.toLowerCase().split(',').map(part => normalizeCodec(part.trim())).filter(Boolean))];
  if (!values.length || values.length > 12 || values.some(entry => !allowed.has(entry))) badOptions();
  return values;
}

/** Parse only bounded, enumerated playback options from an Express query. */
export function parsePlaybackRequest(query: Record<string, unknown>): PlaybackRequest {
  const quality = (scalar(query.quality) || 'auto').toLowerCase() as PlaybackQuality;
  if (!QUALITY_IDS.has(quality)) badOptions();
  const audioChannels = integer(query.audioChannels, 2, 6) ?? 2;
  if (audioChannels !== 2 && audioChannels !== 6) badOptions();
  const sourceId = scalar(query.source) || null;
  if (sourceId && !SAFE_ID.test(sourceId)) badOptions();
  const direct = scalar(query.direct);
  const native = scalar(query.native);
  if (direct !== undefined && direct !== '0' && direct !== '1') badOptions();
  if (native !== undefined && native !== '0' && native !== '1') badOptions();
  return {
    quality,
    audioStreamIndex: integer(query.audioStream, 0, 512) ?? null,
    sourceId,
    nativeHls: native === '1',
    capabilities: {
      containers: list(query.containers, CONTAINERS, ['mp4', 'm4v', 'mov']),
      videoCodecs: list(query.videoCodecs, VIDEO_CODECS, ['h264']),
      audioCodecs: list(query.audioCodecs, AUDIO_CODECS, ['aac', 'mp3']),
      maxAudioChannels: audioChannels as 2 | 6,
      maxWidth: integer(query.maxWidth, 320, 7680),
      maxHeight: integer(query.maxHeight, 240, 4320),
      maxStreamingBitrate: integer(query.maxBitrate, 500_000, 120_000_000),
      allowDirectPlay: direct !== '0',
    },
  };
}

function normalizeCodec(value: unknown): string {
  const codec = String(value || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');
  if (codec === 'avc' || codec === 'avc1') return 'h264';
  if (codec === 'h265' || codec === 'hev1' || codec === 'hvc1') return 'hevc';
  if (codec === 'eac3' || codec === 'ec3') return 'eac3';
  return codec;
}

function finiteInteger(value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): number | null {
  const number = Number(value);
  return Number.isFinite(number) && number >= min && number <= max ? Math.round(number) : null;
}

function boundedText(value: unknown, max: number): string | null {
  if (value === undefined || value === null) return null;
  const text = String(value).normalize('NFKC').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  return text ? text.slice(0, max) : null;
}

/** Reduce Jellyfin's large MediaSourceInfo graph to the fields the browser may see. */
export function normalizeVideoSources(raw: unknown): VideoMediaSource[] {
  if (!Array.isArray(raw)) return [];
  const sources: VideoMediaSource[] = [];
  for (const source of raw.slice(0, 16) as any[]) {
    const id = boundedText(source?.Id, 256);
    if (!id || !SAFE_ID.test(id)) continue;
    const streams = Array.isArray(source?.MediaStreams) ? source.MediaStreams.slice(0, 128) : [];
    const videoRaw = streams.find((stream: any) => String(stream?.Type).toLowerCase() === 'video');
    if (!videoRaw) continue;
    const video: VideoStreamDescription = {
      index: finiteInteger(videoRaw.Index, 0, 512) ?? 0,
      codec: normalizeCodec(videoRaw.Codec),
      width: finiteInteger(videoRaw.Width, 1, 16_384),
      height: finiteInteger(videoRaw.Height, 1, 16_384),
      bitrate: finiteInteger(videoRaw.BitRate, 1, 1_000_000_000),
      bitDepth: finiteInteger(videoRaw.BitDepth, 1, 32),
      profile: boundedText(videoRaw.Profile, 80),
      level: finiteInteger(videoRaw.Level, 0, 1000),
      range: boundedText(videoRaw.VideoRangeType || videoRaw.VideoRange, 40),
      interlaced: videoRaw.IsInterlaced === true,
      anamorphic: videoRaw.IsAnamorphic === true,
    };
    const audio = streams.filter((stream: any) => String(stream?.Type).toLowerCase() === 'audio').slice(0, 32)
      .map((stream: any, index: number): AudioStreamDescription => {
        const streamIndex = finiteInteger(stream.Index, 0, 512) ?? index;
        return {
          index: streamIndex,
          codec: normalizeCodec(stream.Codec),
          channels: finiteInteger(stream.Channels, 1, 32),
          bitrate: finiteInteger(stream.BitRate, 1, 10_000_000),
          language: boundedText(stream.Language, 40),
          title: boundedText(stream.DisplayTitle || stream.Title || stream.Language, 160) || `Audio ${streamIndex}`,
          default: stream.IsDefault === true,
        };
      });
    sources.push({
      id,
      name: boundedText(source.Name, 160),
      containers: [...new Set(String(source.Container || '').toLowerCase().split(',')
        .map((entry: string) => entry.trim().replace(/[^a-z0-9]/g, '')).filter(Boolean))].slice(0, 8) as string[],
      bitrate: finiteInteger(source.Bitrate ?? source.BitRate, 1, 1_000_000_000),
      supportsDirectPlay: source.SupportsDirectPlay === true,
      supportsDirectStream: source.SupportsDirectStream === true,
      supportsTranscoding: source.SupportsTranscoding !== false,
      defaultAudioStreamIndex: finiteInteger(source.DefaultAudioStreamIndex, 0, 512),
      video,
      audio,
    });
  }
  return sources;
}

/** Normalize and bound chapter metadata; end times are inferred from the next chapter. */
export function normalizeChapters(raw: unknown, runtimeTicks?: unknown): ChapterMetadata[] {
  if (!Array.isArray(raw)) return [];
  const maxSec = 7 * 24 * 60 * 60;
  const starts = raw.slice(0, 500).map((chapter: any, index) => {
    const ticks = Number(chapter?.StartPositionTicks);
    if (!Number.isFinite(ticks) || ticks < 0) return null;
    const startSec = Math.round(Math.min(maxSec, ticks / 1e7) * 1000) / 1000;
    const normalized = boundedText(chapter?.Name, 160);
    return { name: normalized, startSec };
  }).filter(Boolean) as { name: string | null; startSec: number }[];
  starts.sort((a, b) => a.startSec - b.startSec);
  const unique = starts.filter((chapter, index) => index === 0 || chapter.startSec > starts[index - 1].startSec);
  const runtime = Number(runtimeTicks) / 1e7;
  return unique.map((chapter, index) => {
    const next = unique[index + 1]?.startSec;
    const end = next ?? (Number.isFinite(runtime) && runtime > chapter.startSec ? Math.min(maxSec, runtime) : undefined);
    const named = { name: chapter.name || `Chapter ${index + 1}`, startSec: chapter.startSec };
    return end !== undefined && end > chapter.startSec
      ? { ...named, endSec: Math.round(end * 1000) / 1000 }
      : named;
  });
}

function selectedAudio(source: VideoMediaSource, request: PlaybackRequest): AudioStreamDescription | null {
  if (!source.audio.length) return null;
  if (request.audioStreamIndex !== null) return source.audio.find(stream => stream.index === request.audioStreamIndex) || null;
  if (source.defaultAudioStreamIndex !== null) {
    const byIndex = source.audio.find(stream => stream.index === source.defaultAudioStreamIndex);
    if (byIndex) return byIndex;
  }
  return source.audio.find(stream => stream.default) || source.audio[0];
}

export function playbackAudioBitrate(source: VideoMediaSource, request: PlaybackRequest): number {
  const channels = playbackAudioChannels(source, request) || 2;
  return channels > 2 && request.capabilities.maxAudioChannels > 2 ? 640_000 : 192_000;
}

export function playbackAudioChannels(source: VideoMediaSource, request: PlaybackRequest): number | null {
  const channels = selectedAudio(source, request)?.channels;
  return channels ? Math.min(channels, request.capabilities.maxAudioChannels) : null;
}

function requestedCap(request: PlaybackRequest): { height: number | null; bitrate: number | null } {
  const preset = request.quality === 'auto' || request.quality === 'original' ? null : QUALITY_PRESETS[request.quality];
  const heights = [preset?.height, request.capabilities.maxHeight].filter((value): value is number => !!value);
  const bitrates = [preset?.videoBitrate, request.capabilities.maxStreamingBitrate].filter((value): value is number => !!value);
  return {
    height: heights.length ? Math.min(...heights) : null,
    bitrate: bitrates.length ? Math.min(...bitrates) : null,
  };
}

function sourceFitsCap(source: VideoMediaSource, request: PlaybackRequest): boolean {
  const cap = requestedCap(request);
  const audioBitrate = selectedAudio(source, request)?.bitrate || playbackAudioBitrate(source, request);
  const preset = request.quality === 'auto' || request.quality === 'original' ? null : QUALITY_PRESETS[request.quality];
  return (!cap.height || !source.video.height || source.video.height <= cap.height)
    && (!request.capabilities.maxWidth || !source.video.width || source.video.width <= request.capabilities.maxWidth)
    && (!preset || !source.bitrate || source.bitrate <= preset.videoBitrate + audioBitrate)
    && (!request.capabilities.maxStreamingBitrate || !source.bitrate
      || source.bitrate <= request.capabilities.maxStreamingBitrate);
}

function directVideoSafe(source: VideoMediaSource, request: PlaybackRequest): boolean {
  const video = source.video;
  if (!source.supportsDirectPlay || !request.capabilities.allowDirectPlay || !sourceFitsCap(source, request)) return false;
  if (!source.containers.some(container => request.capabilities.containers.includes(container))) return false;
  if (!request.capabilities.videoCodecs.includes(video.codec) || video.interlaced || video.anamorphic) return false;
  if (video.codec === 'h264' && ((video.bitDepth || 8) > 8 || (video.level || 0) > 52)) return false;
  if (video.codec === 'hevc' && /dolby|dovi/i.test(video.range || '')) return false;
  const audio = selectedAudio(source, request);
  if (!audio || !request.capabilities.audioCodecs.includes(audio.codec)) return false;
  if (audio.channels && audio.channels > request.capabilities.maxAudioChannels) return false;
  const defaultIndex = source.defaultAudioStreamIndex ?? source.audio.find(stream => stream.default)?.index ?? source.audio[0]?.index;
  return request.audioStreamIndex === null || request.audioStreamIndex === defaultIndex;
}

function sourceScore(source: VideoMediaSource, request: PlaybackRequest): number {
  const wanted = request.sourceId === source.id ? 1_000_000_000_000 : 0;
  const viable = source.supportsDirectStream || source.supportsTranscoding ? 10_000_000_000 : 0;
  const capFit = sourceFitsCap(source, request) ? 1_000_000_000 : 0;
  const cap = requestedCap(request);
  const sourceHeight = source.video.height || 0;
  const height = Math.min(sourceHeight, cap.height || 16_384);
  // Preserve quality first; Direct Play breaks ties between equivalent
  // versions instead of silently downgrading a 4K title to a low-res encode.
  const direct = directVideoSafe(source, request) ? 20_000_000 : 0;
  const bitrate = Math.min(source.bitrate || 0, 120_000_000) / 100;
  const resolutionOvershoot = cap.height ? Math.max(0, sourceHeight - cap.height) * 50_000 : 0;
  const bitrateOvershoot = cap.bitrate ? Math.max(0, (source.bitrate || 0) - cap.bitrate) / 10 : 0;
  return wanted + viable + capFit + height * 100_000 + direct + bitrate - resolutionOvershoot - bitrateOvershoot;
}

export function chooseVideoSource(sources: VideoMediaSource[], request: PlaybackRequest): VideoMediaSource {
  if (request.sourceId && !sources.some(source => source.id === request.sourceId)) badOptions();
  const requested = request.sourceId ? sources.filter(source => source.id === request.sourceId) : sources;
  const matchingAudio = request.audioStreamIndex === null ? requested
    : requested.filter(source => source.audio.some(stream => stream.index === request.audioStreamIndex));
  if (request.audioStreamIndex !== null && !matchingAudio.length) badOptions();
  const candidates = matchingAudio.filter(source => source.supportsDirectPlay || source.supportsDirectStream || source.supportsTranscoding);
  const selected = [...candidates].sort((a, b) => sourceScore(b, request) - sourceScore(a, request))[0];
  if (!selected) throw Object.assign(new Error('stream_unavailable'), { status: 503 });
  return selected;
}

function scaledWidth(source: VideoMediaSource, height: number | null): number | null {
  if (!height || !source.video.width || !source.video.height) return source.video.width;
  const width = Math.round((source.video.width * height / source.video.height) / 2) * 2;
  return Math.max(2, width);
}

function hlsDelivery(source: VideoMediaSource, request: PlaybackRequest, height: number | null, videoBitrate: number): 'remux' | 'transcode' {
  const videoCopy = source.supportsDirectStream && source.video.codec === 'h264'
    && !source.video.interlaced && !source.video.anamorphic
    && (!height || !source.video.height || source.video.height <= height)
    && (!source.video.bitrate || source.video.bitrate <= videoBitrate);
  return videoCopy ? 'remux' : 'transcode';
}

function variantFor(source: VideoMediaSource, request: PlaybackRequest, height: number, videoBitrate: number): PlaybackVariant {
  const outputHeight = source.video.height ? Math.min(source.video.height, height) : height;
  const audioBitrate = playbackAudioBitrate(source, request);
  const streamingVideoCap = request.capabilities.maxStreamingBitrate
    ? Math.max(500_000, request.capabilities.maxStreamingBitrate - audioBitrate)
    : videoBitrate;
  const boundedVideoBitrate = Math.max(500_000, Math.min(videoBitrate, streamingVideoCap));
  return {
    id: `${outputHeight}p`, label: `${outputHeight}p`,
    width: scaledWidth(source, outputHeight), height: outputHeight,
    videoBitrate: boundedVideoBitrate,
    bitrate: boundedVideoBitrate + audioBitrate,
    delivery: hlsDelivery(source, request, outputHeight, boundedVideoBitrate),
  };
}

export function playbackVariants(source: VideoMediaSource, request: PlaybackRequest): PlaybackVariant[] {
  const cap = requestedCap(request);
  const sourceHeight = source.video.height || cap.height || 1080;
  const topHeight = Math.min(sourceHeight, cap.height || sourceHeight);
  const sourceVideoBitrate = source.video.bitrate || Math.max(1_000_000, (source.bitrate || 12_192_000) - 192_000);
  if (request.quality !== 'auto') {
    const preset = request.quality === 'original' ? null : QUALITY_PRESETS[request.quality];
    return [variantFor(source, request, topHeight, Math.min(sourceVideoBitrate, preset?.videoBitrate || sourceVideoBitrate))];
  }
  const candidates = QUALITY_ORDER.filter(preset => preset.height < topHeight);
  const rungs = [
    // Auto keeps an original-quality copy-capable top rung. Lower rungs carry
    // the real adaptation; arbitrarily squeezing the top to a preset would turn
    // many ordinary Blu-ray sources into unnecessary full video transcodes.
    { height: topHeight, videoBitrate: sourceVideoBitrate },
    ...candidates.map(({ height, videoBitrate }) => ({ height, videoBitrate })),
  ];
  const unique = rungs.filter((rung, index, all) => all.findIndex(other => other.height === rung.height) === index)
    .slice(0, 5)
    .map(rung => variantFor(source, request, rung.height, rung.videoBitrate));
  return unique.sort((a, b) => a.bitrate - b.bitrate);
}

function qualityOptions(source: VideoMediaSource): PlaybackPlan['qualityOptions'] {
  const height = source.video.height || 0;
  return [
    { id: 'auto', label: 'Auto', height: null },
    { id: 'original', label: height ? `Original (${height}p)` : 'Original', height: height || null },
    ...QUALITY_ORDER.filter(option => !height || option.height < height)
      .map(option => ({ id: option.id, label: option.id, height: option.height })),
  ];
}

function directMime(source: VideoMediaSource): string {
  return source.containers.includes('webm') ? 'video/webm' : 'video/mp4';
}

function planQuery(request: PlaybackRequest, source: VideoMediaSource): URLSearchParams {
  const query = new URLSearchParams({ quality: request.quality, source: source.id, audioChannels: String(request.capabilities.maxAudioChannels) });
  if (request.audioStreamIndex !== null) query.set('audioStream', String(request.audioStreamIndex));
  if (request.nativeHls) query.set('native', '1');
  if (request.capabilities.maxStreamingBitrate) query.set('maxBitrate', String(request.capabilities.maxStreamingBitrate));
  if (request.capabilities.maxHeight) query.set('maxHeight', String(request.capabilities.maxHeight));
  if (request.capabilities.maxWidth) query.set('maxWidth', String(request.capabilities.maxWidth));
  return query;
}

export function buildPlaybackPlan(itemId: string, sources: VideoMediaSource[], request: PlaybackRequest): PlaybackPlan {
  const source = chooseVideoSource(sources, request);
  const audio = selectedAudio(source, request);
  const direct = directVideoSafe(source, request);
  const variants = direct ? [] : playbackVariants(source, request);
  const top = variants[variants.length - 1];
  const outputChannels = playbackAudioChannels(source, request);
  const reasons: string[] = [];
  if (!direct) {
    if (!request.capabilities.allowDirectPlay) reasons.push('direct_play_disabled');
    else if (!source.supportsDirectPlay) reasons.push('source_direct_play_unavailable');
    if (!source.containers.some(container => request.capabilities.containers.includes(container))) reasons.push('container');
    if (!request.capabilities.videoCodecs.includes(source.video.codec)) reasons.push('video_codec');
    if (!request.capabilities.audioCodecs.includes(audio?.codec || '')) reasons.push('audio_codec');
    if ((audio?.channels || 0) > request.capabilities.maxAudioChannels) reasons.push('audio_channels');
    const cap = requestedCap(request);
    if (cap.height && (source.video.height || 0) > cap.height) reasons.push('resolution_limit');
    if (cap.bitrate && (source.bitrate || 0) > cap.bitrate) reasons.push('bitrate_limit');
    if (request.audioStreamIndex !== null) reasons.push('selected_audio');
    if (!reasons.length) reasons.push('adaptive_delivery');
  }
  const query = planQuery(request, source);
  const pathId = encodeURIComponent(itemId);
  return {
    streamUrl: direct
      ? `/api/media/direct/${pathId}?source=${encodeURIComponent(source.id)}`
      : `/api/media/stream/${pathId}?${query}`,
    hls: !direct,
    mime: direct ? directMime(source) : 'application/vnd.apple.mpegurl',
    delivery: direct ? 'direct_play' : top?.delivery || 'transcode',
    adaptive: !direct && request.quality === 'auto' && variants.length > 1,
    quality: request.quality,
    source: {
      id: source.id, name: source.name, container: source.containers[0] || 'unknown',
      width: source.video.width, height: source.video.height, bitrate: source.bitrate,
      videoCodec: source.video.codec, audioCodec: audio?.codec || null, audioChannels: audio?.channels || null,
    },
    output: direct ? {
      width: source.video.width, height: source.video.height, bitrate: source.bitrate,
      videoCodec: source.video.codec, audioCodec: audio?.codec || null, audioChannels: audio?.channels || null,
    } : {
      width: top?.width || null, height: top?.height || null, bitrate: top?.bitrate || null,
      videoCodec: 'h264', audioCodec: audio ? 'aac' : null, audioChannels: outputChannels,
    },
    audio: {
      selectedStreamIndex: audio?.index ?? null,
      surroundAvailable: source.audio.some(stream => (stream.channels || 0) > 2),
      stereoFallback: (audio?.channels || 0) > 2 && request.capabilities.maxAudioChannels === 2,
    },
    reasons: [...new Set(reasons)], variants, qualityOptions: qualityOptions(source),
  };
}

/** DeviceProfile sent to Jellyfin PlaybackInfo so its source flags match the browser. */
export function jellyfinDeviceProfile(request: PlaybackRequest): Record<string, unknown> {
  const caps = request.capabilities;
  const cap = requestedCap(request);
  const profiles: Record<string, unknown>[] = [];
  const mp4 = caps.containers.filter(container => ['mp4', 'm4v', 'mov'].includes(container));
  if (mp4.length) profiles.push({ Container: mp4.join(','), AudioCodec: caps.audioCodecs.join(','), VideoCodec: caps.videoCodecs.join(','), Type: 'Video' });
  if (caps.containers.includes('webm')) profiles.push({ Container: 'webm', AudioCodec: caps.audioCodecs.join(','), VideoCodec: caps.videoCodecs.join(','), Type: 'Video' });
  const videoConditions: Record<string, unknown>[] = [
    { Condition: 'NotEquals', Property: 'IsAnamorphic', Value: 'true', IsRequired: false },
    { Condition: 'NotEquals', Property: 'IsInterlaced', Value: 'true', IsRequired: false },
  ];
  if (caps.maxWidth) videoConditions.push({ Condition: 'LessThanEqual', Property: 'Width', Value: String(caps.maxWidth), IsRequired: true });
  if (cap.height) videoConditions.push({ Condition: 'LessThanEqual', Property: 'Height', Value: String(cap.height), IsRequired: true });
  if (cap.bitrate) videoConditions.push({ Condition: 'LessThanEqual', Property: 'VideoBitrate', Value: String(cap.bitrate), IsRequired: true });
  return {
    Name: 'Aerie Web',
    MaxStreamingBitrate: caps.maxStreamingBitrate || cap.bitrate || 120_000_000,
    MaxStaticBitrate: caps.maxStreamingBitrate || cap.bitrate || 120_000_000,
    DirectPlayProfiles: profiles,
    TranscodingProfiles: [{
      Container: 'ts', Type: 'Video', VideoCodec: 'h264', AudioCodec: 'aac', Protocol: 'hls',
      Context: 'Streaming', MaxAudioChannels: String(caps.maxAudioChannels), MinSegments: 1,
      BreakOnNonKeyFrames: !request.nativeHls,
    }],
    ContainerProfiles: [],
    CodecProfiles: [
      { Type: 'Video', Codec: caps.videoCodecs.join(','), Conditions: videoConditions, ApplyConditions: [] },
      { Type: 'VideoAudio', Codec: caps.audioCodecs.join(','), Conditions: [
        { Condition: 'LessThanEqual', Property: 'AudioChannels', Value: String(caps.maxAudioChannels), IsRequired: true },
      ], ApplyConditions: [] },
    ],
    SubtitleProfiles: [{ Format: 'vtt', Method: 'External' }],
  };
}

export function adaptiveMasterPlaylist(itemId: string, source: VideoMediaSource, request: PlaybackRequest, variants: PlaybackVariant[]): string {
  const id = encodeURIComponent(itemId);
  const lines = ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-INDEPENDENT-SEGMENTS'];
  for (const variant of variants) {
    const query = planQuery(request, source);
    query.set('variant', variant.id.replace(/p$/, ''));
    if (request.nativeHls) query.set('native', '1');
    const resolution = variant.width && variant.height ? `,RESOLUTION=${variant.width}x${variant.height}` : '';
    // Do not guess an AVC level: Jellyfin selects the encoder profile and a
    // false CODECS declaration can make native HLS reject an otherwise valid level.
    lines.push(`#EXT-X-STREAM-INF:BANDWIDTH=${variant.bitrate},AVERAGE-BANDWIDTH=${Math.round(variant.bitrate * 0.9)}${resolution},NAME="${variant.label}"`);
    lines.push(`/api/media/stream/${id}?${query}`);
  }
  return `${lines.join('\n')}\n`;
}

export function variantFromRequest(source: VideoMediaSource, request: PlaybackRequest, rawVariant: unknown): PlaybackVariant {
  const height = integer(rawVariant, 240, 4320);
  if (!height) badOptions();
  const found = playbackVariants(source, request).find(variant => variant.height === height);
  if (!found) badOptions();
  return found;
}
