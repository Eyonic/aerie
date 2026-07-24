import { describe, expect, it } from 'vitest';
import { parseVideoPlaybackPlan, playbackStatusLabel, playbackVariantForHlsLevel } from '../src/lib/video-playback-plan';

function plan(overrides: Record<string, unknown> = {}) {
  return {
    streamUrl: '/api/media/stream/item-1?quality=auto&source=source-1',
    hls: true,
    mime: 'application/vnd.apple.mpegurl',
    delivery: 'remux',
    adaptive: true,
    quality: 'auto',
    source: { id: 'source-1', name: 'Main', container: 'mkv', width: 1920, height: 1080, bitrate: 8_000_000, videoCodec: 'h264', audioCodec: 'aac', audioChannels: 2 },
    output: { width: 1920, height: 1080, bitrate: 8_192_000, videoCodec: 'h264', audioCodec: 'aac', audioChannels: 2 },
    audio: { selectedStreamIndex: 1, surroundAvailable: true, stereoFallback: false },
    reasons: ['adaptive_delivery'],
    variants: [{ id: '1080p', label: '1080p', width: 1920, height: 1080, videoBitrate: 8_000_000, bitrate: 8_192_000, delivery: 'remux' }],
    qualityOptions: [{ id: 'auto', label: 'Auto', height: null }, { id: '720p', label: '720p', height: 720 }],
    ...overrides,
  };
}

describe('credential-free video playback plans', () => {
  it('accepts and normalizes the bounded server contract', () => {
    const parsed = parseVideoPlaybackPlan(plan());
    expect(parsed).toMatchObject({
      streamUrl: '/api/media/stream/item-1?quality=auto&source=source-1',
      delivery: 'remux', adaptive: true, quality: 'auto',
      source: { id: 'source-1', height: 1080 },
      output: { height: 1080 },
      audio: { selectedStreamIndex: 1, surroundAvailable: true, stereoFallback: false },
    });
    expect(playbackStatusLabel(parsed!)).toBe('Adaptive · Remux · 1080p · 8.2 Mbps');
    expect(playbackStatusLabel(parsed!, parsed!.variants[0])).toBe('Adaptive · Remux · 1080p · 8.2 Mbps');
  });

  it('rejects cross-origin, credential-bearing and malformed stream targets', () => {
    expect(parseVideoPlaybackPlan(plan({ streamUrl: 'https://media.example/video.mp4' }))).toBeNull();
    expect(parseVideoPlaybackPlan(plan({ streamUrl: '/api/media/stream/item?api_key=secret' }))).toBeNull();
    expect(parseVideoPlaybackPlan(plan({ streamUrl: '/api/media/stream/item?token=secret' }))).toBeNull();
    expect(parseVideoPlaybackPlan(plan({ delivery: 'magic' }))).toBeNull();
  });

  it('reports truthful direct-play and transcode status', () => {
    const direct = parseVideoPlaybackPlan(plan({ hls: false, delivery: 'direct_play', adaptive: false, output: { width: 3840, height: 2160, bitrate: 30_000_000, videoCodec: 'hevc', audioCodec: 'eac3', audioChannels: 6 } }));
    expect(playbackStatusLabel(direct!)).toBe('Direct Play · 2160p · 30 Mbps · 5.1 audio');
    const transcode = parseVideoPlaybackPlan(plan({ delivery: 'transcode', adaptive: false, output: { width: 1280, height: 720, bitrate: 6_192_000, videoCodec: 'h264', audioCodec: 'aac', audioChannels: 2 } }));
    expect(playbackStatusLabel(transcode!)).toBe('Transcoding · 720p · 6.2 Mbps');
    const fallback = parseVideoPlaybackPlan(plan({ adaptive: false, audio: { selectedStreamIndex: 1, surroundAvailable: true, stereoFallback: true } }));
    expect(playbackStatusLabel(fallback!)).toContain('Stereo fallback');
  });

  it('matches the live hls.js level after hls.js reorders equal-bitrate renditions', () => {
    const parsed = parseVideoPlaybackPlan(plan({ variants: [
      { id: '480p', label: '480p', width: 854, height: 480, videoBitrate: 2_500_000, bitrate: 2_692_000, delivery: 'transcode' },
      { id: '720p', label: '720p', width: 1280, height: 720, videoBitrate: 6_000_000, bitrate: 6_192_000, delivery: 'transcode' },
      { id: '2160p', label: '2160p', width: 3840, height: 2160, videoBitrate: 8_000_000, bitrate: 8_192_000, delivery: 'transcode' },
      { id: '1440p', label: '1440p', width: 2560, height: 1440, videoBitrate: 8_000_000, bitrate: 8_192_000, delivery: 'transcode' },
      { id: '1080p', label: '1080p', width: 1920, height: 1080, videoBitrate: 8_000_000, bitrate: 8_192_000, delivery: 'transcode' },
    ] }));
    // hls.js exposes these levels sorted by height, making index 2 the 1080p
    // rung even though index 2 in the server plan is 2160p.
    expect(playbackVariantForHlsLevel(parsed!.variants, {
      width: 1920, height: 1080, bitrate: 8_192_000, name: '1080p',
    }, 2)?.id).toBe('1080p');
  });
});
