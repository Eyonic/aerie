import assert from 'node:assert/strict';
import test from 'node:test';
import {
  adaptiveMasterPlaylist,
  buildPlaybackPlan,
  chooseVideoSource,
  jellyfinDeviceProfile,
  normalizeChapters,
  normalizeVideoSources,
  parsePlaybackRequest,
  playbackVariants,
  variantFromRequest,
  type PlaybackRequest,
  type VideoMediaSource,
} from '../src/services/video-playback.js';

function source(overrides: Partial<VideoMediaSource> = {}): VideoMediaSource {
  return {
    id: 'source-1', name: 'Main', containers: ['mp4'], bitrate: 8_192_000,
    supportsDirectPlay: true, supportsDirectStream: true, supportsTranscoding: true,
    defaultAudioStreamIndex: 1,
    video: {
      index: 0, codec: 'h264', width: 1920, height: 1080, bitrate: 8_000_000,
      bitDepth: 8, profile: 'High', level: 41, range: 'SDR', interlaced: false, anamorphic: false,
    },
    audio: [{ index: 1, codec: 'aac', channels: 2, bitrate: 192_000, language: 'eng', title: 'English AAC stereo', default: true }],
    ...overrides,
  };
}

function request(query: Record<string, unknown> = {}): PlaybackRequest {
  return parsePlaybackRequest(query);
}

test('playback query defaults are conservative and all inputs are bounded', () => {
  assert.deepEqual(request().capabilities, {
    containers: ['mp4', 'm4v', 'mov'], videoCodecs: ['h264'], audioCodecs: ['aac', 'mp3'],
    maxAudioChannels: 2, maxWidth: undefined, maxHeight: undefined,
    maxStreamingBitrate: undefined, allowDirectPlay: true,
  });
  const parsed = request({
    quality: '1080p', audioStream: '7', audioChannels: '6', containers: 'webm,mp4',
    videoCodecs: 'vp9,h264', audioCodecs: 'opus,aac', maxWidth: '3840', maxHeight: '2160',
    maxBitrate: '30000000', direct: '0', native: '1', source: 'version:uhd-1',
  });
  assert.equal(parsed.quality, '1080p');
  assert.equal(parsed.audioStreamIndex, 7);
  assert.equal(parsed.capabilities.maxAudioChannels, 6);
  assert.equal(parsed.capabilities.allowDirectPlay, false);
  assert.equal(parsed.nativeHls, true);
  assert.equal(parsed.sourceId, 'version:uhd-1');
  for (const invalid of [
    { quality: '8k' }, { audioStream: '' }, { audioChannels: '4' }, { maxBitrate: '499999' },
    { containers: 'mkv' }, { videoCodecs: 'mpeg2' }, { source: '../other' }, { direct: 'yes' },
    { quality: ['auto', '720p'] },
  ]) assert.throws(() => request(invalid), /invalid_playback_options/);
});

test('Jellyfin media sources are normalized without paths, keys, or unbounded metadata', () => {
  const sources = normalizeVideoSources([{
    Id: 'version-1', Name: ` Main\u0000 ${'x'.repeat(300)}`, Container: 'mp4,MOV', Path: '/private/movie.mkv',
    SupportsDirectPlay: true, SupportsDirectStream: true, SupportsTranscoding: true, Bitrate: 9_000_000,
    DefaultAudioStreamIndex: 2, ApiKey: 'must-not-leak', MediaStreams: [
      { Type: 'Video', Index: 0, Codec: 'avc1', Width: 1920, Height: 1080, BitRate: 8_500_000, BitDepth: 8 },
      { Type: 'Audio', Index: 2, Codec: 'e-ac-3', Channels: 6, Language: 'eng', IsDefault: true },
    ],
  }]);
  assert.equal(sources.length, 1);
  assert.equal(sources[0].video.codec, 'h264');
  assert.equal(sources[0].audio[0].codec, 'eac3');
  assert.deepEqual(sources[0].containers, ['mp4', 'mov']);
  assert.ok((sources[0].name?.length || 0) <= 160);
  assert.equal('Path' in sources[0], false);
  assert.equal(JSON.stringify(sources).includes('must-not-leak'), false);
});

test('a compatible source is reported and delivered as real Direct Play', () => {
  const plan = buildPlaybackPlan('movie-1', [source()], request({ quality: 'original' }));
  assert.equal(plan.delivery, 'direct_play');
  assert.equal(plan.hls, false);
  assert.equal(plan.mime, 'video/mp4');
  assert.equal(plan.adaptive, false);
  assert.equal(plan.streamUrl, '/api/media/direct/movie-1?source=source-1');
  assert.deepEqual(plan.output, {
    width: 1920, height: 1080, bitrate: 8_192_000,
    videoCodec: 'h264', audioCodec: 'aac', audioChannels: 2,
  });
  assert.equal(JSON.stringify(plan).includes('api_key'), false);
});

test('HLS keeps 5.1 when supported and truthfully reports remux versus stereo fallback', () => {
  const surround = source({
    containers: ['mkv'],
    audio: [{ index: 4, codec: 'ac3', channels: 6, bitrate: 640_000, language: 'eng', title: 'English 5.1', default: true }],
    defaultAudioStreamIndex: 4,
  });
  const six = buildPlaybackPlan('movie-1', [surround], request({ audioChannels: '6', audioStream: '4' }));
  assert.equal(six.delivery, 'remux');
  assert.equal(six.hls, true);
  assert.equal(six.output.audioChannels, 6);
  assert.equal(six.audio.surroundAvailable, true);
  assert.equal(six.audio.stereoFallback, false);
  assert.ok(six.reasons.includes('container'));
  assert.ok(six.reasons.includes('audio_codec'));
  assert.ok(six.streamUrl.includes('audioChannels=6'));

  const native = buildPlaybackPlan('movie-1', [surround], request({ audioChannels: '6', native: '1' }));
  assert.equal(new URL(native.streamUrl, 'https://aerie.invalid').searchParams.get('native'), '1');

  const stereo = buildPlaybackPlan('movie-1', [surround], request({ audioStream: '4' }));
  assert.equal(stereo.output.audioChannels, 2);
  assert.equal(stereo.audio.stereoFallback, true);
  assert.ok(stereo.reasons.includes('audio_channels'));
});

test('quality caps and unsupported video codecs produce bounded transcodes', () => {
  const uhd = source({
    id: 'uhd', containers: ['mkv'], bitrate: 60_000_000,
    video: { ...source().video, codec: 'hevc', width: 3840, height: 2160, bitrate: 58_000_000, bitDepth: 10 },
  });
  const plan = buildPlaybackPlan('movie-uhd', [uhd], request({ quality: '720p', maxBitrate: '7000000' }));
  assert.equal(plan.delivery, 'transcode');
  assert.equal(plan.adaptive, false);
  assert.equal(plan.output.height, 720);
  assert.equal(plan.output.width, 1280);
  assert.ok((plan.output.bitrate || 0) <= 7_000_000);
  assert.ok(plan.reasons.includes('video_codec'));
  assert.ok(plan.reasons.includes('resolution_limit'));
  assert.ok(plan.reasons.includes('bitrate_limit'));
  assert.deepEqual(plan.variants.map(variant => variant.height), [720]);
});

test('automatic HLS exposes a real ascending bitrate ladder with mixed processing status', () => {
  const remuxable = source({ containers: ['mkv'] });
  const req = request({ direct: '0', quality: 'auto' });
  const variants = playbackVariants(remuxable, req);
  assert.deepEqual(variants.map(variant => variant.height), [360, 480, 720, 1080]);
  assert.ok(variants.every((variant, index) => index === 0 || variant.bitrate > variants[index - 1].bitrate));
  assert.equal(variants.at(-1)?.delivery, 'remux');
  assert.ok(variants.slice(0, -1).every(variant => variant.delivery === 'transcode'));
  const master = adaptiveMasterPlaylist('movie-1', remuxable, req, variants);
  assert.ok(master.startsWith('#EXTM3U\n'));
  assert.equal((master.match(/#EXT-X-STREAM-INF/g) || []).length, 4);
  assert.ok(master.includes('/api/media/stream/movie-1?'));
  assert.equal(master.includes('api_key'), false);
  assert.equal(master.includes('jellyfin'), false);
  assert.equal(variantFromRequest(remuxable, req, '720').height, 720);
  assert.throws(() => variantFromRequest(remuxable, req, '900'), /invalid_playback_options/);
  const stereoOnSurroundHardware = playbackVariants(remuxable, request({ direct: '0', audioChannels: '6' }));
  assert.equal(stereoOnSurroundHardware.at(-1)?.bitrate, 8_192_000, 'Stereo does not reserve a wasteful 5.1 bitrate');
});

test('the best compatible alternate source is selected without trusting arbitrary source ids', () => {
  const uhdTranscode = source({
    id: 'uhd', containers: ['mkv'], bitrate: 50_000_000,
    video: { ...source().video, codec: 'hevc', width: 3840, height: 2160, bitrate: 49_000_000 },
  });
  const hdDirect = source({ id: 'hd' });
  assert.equal(chooseVideoSource([uhdTranscode, hdDirect], request()).id, 'uhd', 'Auto preserves the best source quality');
  assert.equal(chooseVideoSource([uhdTranscode, hdDirect], request({ maxHeight: '1080' })).id, 'hd', 'Display cap prefers the fitting direct version');
  assert.equal(chooseVideoSource([uhdTranscode, hdDirect], request({ quality: '720p' })).id, 'hd', 'A cap uses the closest efficient source');
  const alternateAudio = source({ id: 'audio-version', audio: [{ ...source().audio[0], index: 7 }] });
  assert.equal(chooseVideoSource([uhdTranscode, alternateAudio], request({ audioStream: '7' })).id, 'audio-version');
  assert.equal(chooseVideoSource([uhdTranscode, hdDirect], request({ source: 'uhd' })).id, 'uhd');
  assert.throws(() => chooseVideoSource([hdDirect], request({ source: 'not-present' })), /invalid_playback_options/);
  assert.throws(() => chooseVideoSource([hdDirect], request({ audioStream: '99' })), /invalid_playback_options/);
  assert.throws(() => chooseVideoSource([source({ supportsDirectPlay: false, supportsDirectStream: false, supportsTranscoding: false })], request()), /stream_unavailable/);
});

test('Jellyfin DeviceProfile mirrors channel, codec and display limits', () => {
  const profile: any = jellyfinDeviceProfile(request({
    audioChannels: '6', containers: 'mp4,webm', videoCodecs: 'h264,vp9', audioCodecs: 'aac,opus',
    maxWidth: '2560', maxHeight: '1440', maxBitrate: '20000000', native: '1',
  }));
  assert.equal(profile.MaxStreamingBitrate, 20_000_000);
  assert.equal(profile.TranscodingProfiles[0].MaxAudioChannels, '6');
  assert.equal(profile.TranscodingProfiles[0].BreakOnNonKeyFrames, false);
  assert.ok(profile.DirectPlayProfiles.some((entry: any) => entry.Container === 'webm'));
  const serialized = JSON.stringify(profile);
  assert.ok(serialized.includes('2560'));
  assert.ok(serialized.includes('1440'));
});

test('chapter metadata is safe, ordered, deduplicated, bounded, and has inferred ends', () => {
  const chapters = normalizeChapters([
    { Name: `  Finale\u0000 ${'z'.repeat(200)} `, StartPositionTicks: 20 * 1e7 },
    { Name: '', StartPositionTicks: 0 },
    { Name: 'Duplicate', StartPositionTicks: 20 * 1e7 },
    { Name: 'Invalid', StartPositionTicks: -1 },
  ], 30 * 1e7);
  assert.equal(chapters.length, 2);
  assert.deepEqual(chapters[0], { name: 'Chapter 1', startSec: 0, endSec: 20 });
  assert.equal(chapters[1].startSec, 20);
  assert.equal(chapters[1].endSec, 30);
  assert.ok(chapters[1].name.length <= 160);
  assert.equal(/[\u0000-\u001f]/.test(chapters[1].name), false);
  assert.deepEqual(normalizeChapters(null), []);
});
