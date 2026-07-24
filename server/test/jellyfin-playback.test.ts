import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

type Call = { url: string; options: any };
const calls: Call[] = [];

class TestOutboundError extends Error {
  constructor(readonly code: string, readonly upstreamStatus?: number) { super(code); }
}

function response(body: any, status = 200) {
  return { url: 'http://redacted.invalid/', status, statusText: '', headers: new Headers(), body };
}

const mediaSource = {
  Id: 'version-1', Name: 'Main version', Container: 'mp4', Path: '/private/media/movie.mp4',
  SupportsDirectPlay: true, SupportsDirectStream: true, SupportsTranscoding: true,
  Bitrate: 8_192_000, DefaultAudioStreamIndex: 1,
  MediaStreams: [
    { Type: 'Video', Index: 0, Codec: 'h264', Width: 1920, Height: 1080, BitRate: 8_000_000, BitDepth: 8 },
    { Type: 'Audio', Index: 1, Codec: 'aac', Channels: 6, BitRate: 640_000, IsDefault: true },
  ],
};

const outboundJson = async (value: string | URL, options: any = {}) => {
  const url = String(value);
  calls.push({ url, options });
  if (/\/Users\/?(?:\?|$)/.test(url)) return response([{ Id: 'jf-user' }]);
  if (url.includes('/Items/movie-1/PlaybackInfo')) return response({ MediaSources: [mediaSource] });
  if (url.includes('/Users/jf-user/Items/movie-1')) {
    if (new URL(url).searchParams.get('Fields')?.includes('Chapters')) return response({
      RunTimeTicks: 30 * 1e7,
      Chapters: [
        { Name: 'Opening', StartPositionTicks: 0 },
        { Name: 'Second act', StartPositionTicks: 10 * 1e7 },
      ],
    });
    return response({ MediaSources: [mediaSource, {
      ...mediaSource, Id: 'version-2', Name: 'Alternate', MediaStreams: [
        mediaSource.MediaStreams[0],
        { Type: 'Audio', Index: 3, Codec: 'aac', Channels: 2, BitRate: 192_000, IsDefault: true },
      ],
    }] });
  }
  return response({});
};

mock.module(new URL('../src/config.js', import.meta.url).href, {
  namedExports: { config: { jellyfin: { url: 'http://jellyfin.invalid:8096', apiKey: 'server-only-key' } } },
});
mock.module(new URL('../src/services/outbound-http.js', import.meta.url).href, {
  namedExports: {
    OutboundHttpError: TestOutboundError,
    outboundJson,
    outboundVoid: async () => response(undefined, 204),
  },
});

const playback = await import('../src/services/video-playback.js');
const jellyfin = await import('../src/services/jellyfin.js');

test('normalization metadata passes through only bounded Jellyfin gains', () => {
  assert.deepEqual(jellyfin.normalizationMetadata({ NormalizationGain: -7.8, AlbumNormalizationGain: -5.25 }), {
    trackDb: -7.8,
    albumDb: -5.25,
  });
  assert.deepEqual(jellyfin.normalizationMetadata({ NormalizationGain: -8.6 }), { trackDb: -8.6 });
  assert.equal(jellyfin.normalizationMetadata({ NormalizationGain: Number.NaN, AlbumNormalizationGain: 99 }), undefined);
  assert.equal(jellyfin.normalizationMetadata({ NormalizationGain: '-7.8' }), undefined);
});

test('PlaybackInfo receives the bounded browser profile while returned sources contain no upstream secrets', async () => {
  const request = playback.parsePlaybackRequest({
    quality: '1080p', audioChannels: '6', maxBitrate: '20000000',
    containers: 'mp4,webm', videoCodecs: 'h264,vp9', audioCodecs: 'aac,opus',
  });
  const sources = await jellyfin.videoPlaybackSources('movie-1', request);
  assert.equal(sources.length, 1);
  assert.equal(sources[0].id, 'version-1');
  assert.equal(sources[0].audio[0].channels, 6);
  assert.equal(JSON.stringify(sources).includes('/private/media'), false);
  assert.equal(JSON.stringify(sources).includes('server-only-key'), false);

  const call = calls.find(entry => entry.url.includes('/Items/movie-1/PlaybackInfo') && entry.options.method === 'POST')!;
  assert.ok(call);
  assert.equal(new URL(call.url).searchParams.has('api_key'), false);
  assert.equal(call.options.headers['X-Emby-Token'], 'server-only-key');
  assert.equal(call.options.timeoutMs, 15_000);
  assert.equal(call.options.maxBytes, 8 * 1024 * 1024);
  const body = JSON.parse(call.options.body);
  assert.equal(body.MaxAudioChannels, 6);
  assert.equal(body.MaxStreamingBitrate, 20_000_000);
  assert.equal(body.DeviceProfile.TranscodingProfiles[0].MaxAudioChannels, '6');
  assert.equal(JSON.stringify(body).includes('server-only-key'), false);
});

test('chapter fetch uses Jellyfin Chapters and exposes normalized inferred ranges', async () => {
  const chapters = await jellyfin.chapters('movie-1');
  assert.deepEqual(chapters, [
    { name: 'Opening', startSec: 0, endSec: 10 },
    { name: 'Second act', startSec: 10, endSec: 30 },
  ]);
  const call = calls.find(entry => entry.url.includes('/Users/jf-user/Items/movie-1'))!;
  assert.equal(new URL(call.url).searchParams.get('Fields'), 'Chapters,RunTimeTicks');
});

test('audio track metadata includes bounded channel and bitrate status', async () => {
  const streams = await jellyfin.mediaStreams('movie-1');
  assert.deepEqual(streams.audio[0], {
    index: 1, name: 'Audio 1', lang: undefined, codec: 'aac',
    channels: 6, bitrate: 640_000, default: true,
  });
  const alternate = await jellyfin.mediaStreams('movie-1', 'version-2');
  assert.equal(alternate.audio[0].index, 3);
  assert.equal(alternate.audio[0].channels, 2);
  await assert.rejects(jellyfin.mediaStreams('movie-1', 'not-a-source'), /invalid_media_source/);
});

test.after(() => mock.reset());
