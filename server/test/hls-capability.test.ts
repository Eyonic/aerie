import assert from 'node:assert/strict';
import test from 'node:test';
import {
  credentialFreeHlsTarget,
  HlsCapabilityStore,
  rewriteHlsPlaylist,
  withJellyfinHlsAuth,
} from '../src/services/hls-capability.js';

const base = 'http://jellyfin.local:8096/jellyfin';
const itemId = 'episode-1';
const apiKey = 'jellyfin-super-secret';
const master = `${base}/Videos/${itemId}/master.m3u8?MediaSourceId=${itemId}&PlaySessionId=abc&api_key=${apiKey}`;

test('HLS playlists expose only opaque signed capabilities and upstream auth stays server-side', () => {
  const capabilities = new HlsCapabilityStore('test-signing-secret');
  const playlist = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=5000000\nmain.m3u8?MediaSourceId=episode-1&PlaySessionId=abc&api_key=jellyfin-super-secret';
  const rewritten = rewriteHlsPlaylist(playlist, master, base, itemId, 7, capabilities);
  assert.equal(rewritten.includes(apiKey), false);
  assert.equal(rewritten.includes('jellyfin.local'), false);
  const proxyLine = rewritten.split('\n').find(line => line.startsWith('/api/media/hls/'))!;
  const token = new URL(proxyLine, 'http://aerie.local').searchParams.get('p')!;
  assert.equal(Buffer.from(token.split('.')[0], 'base64url').toString('utf8').includes('http'), false);
  assert.equal(Buffer.from(token.split('.')[0], 'base64url').toString('utf8').includes('api_key'), false);

  const clean = capabilities.resolve(token, 7, itemId);
  assert.equal(clean.pathname, `/jellyfin/Videos/${itemId}/main.m3u8`);
  assert.equal(clean.searchParams.has('api_key'), false);
  assert.equal(withJellyfinHlsAuth(clean, apiKey).searchParams.get('api_key'), apiKey);
});

test('HLS capabilities reject tampering, expiry, and cross-account or cross-item reuse', () => {
  let now = 1_000;
  const capabilities = new HlsCapabilityStore('test-signing-secret', 500, () => now);
  const target = credentialFreeHlsTarget(master, base, itemId);
  const token = capabilities.mint(7, itemId, target);
  const tampered = token.slice(0, -1) + (token.endsWith('a') ? 'b' : 'a');
  assert.throws(() => capabilities.resolve(tampered, 7, itemId), /hls_capability_invalid/);
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const last = alphabet.indexOf(token.at(-1)!);
  const nonCanonicalAlias = token.slice(0, -1) + alphabet[last + 1];
  assert.deepEqual(
    Buffer.from(nonCanonicalAlias.split('.')[1], 'base64url'),
    Buffer.from(token.split('.')[1], 'base64url'),
  );
  assert.throws(() => capabilities.resolve(nonCanonicalAlias, 7, itemId), /hls_capability_invalid/);
  assert.throws(() => capabilities.resolve(token, 8, itemId), /hls_capability_scope_mismatch/);
  assert.throws(() => capabilities.resolve(token, 7, 'episode-2'), /hls_capability_scope_mismatch/);
  now += 501;
  assert.throws(() => capabilities.resolve(token, 7, itemId), /hls_capability_expired/);
});

test('HLS targets are restricted to the exact item playlist and segment paths', () => {
  const segment = credentialFreeHlsTarget(
    `${base}/Videos/${itemId}/hls1/main/42.ts?MediaSourceId=${itemId}&actualSegmentLengthTicks=60000000&runtimeTicks=900000000&api_key=${apiKey}`,
    base,
    itemId,
  );
  assert.equal(segment.pathname, `/jellyfin/Videos/${itemId}/hls1/main/42.ts`);
  assert.equal(segment.searchParams.has('api_key'), false);
  for (const denied of [
    `${base}/Users?api_key=${apiKey}`,
    `${base}/Videos/episode-2/main.m3u8?api_key=${apiKey}`,
    `${base}/Videos/${itemId}/stream.mp4?api_key=${apiKey}`,
    `${base}/Videos/${itemId}/main.m3u8?redirect=http://evil.test`,
    `http://evil.test/Videos/${itemId}/main.m3u8?api_key=${apiKey}`,
  ]) assert.throws(() => credentialFreeHlsTarget(denied, base, itemId), /hls_target_denied|upstream_target_denied/);
});

test('alternate Jellyfin versions stay scoped to the validated media source', () => {
  const sourceId = 'episode-1-4k-version';
  const target = credentialFreeHlsTarget(
    `${base}/Videos/${itemId}/main.m3u8?MediaSourceId=${sourceId}&MaxHeight=2160&MaxWidth=3840&allowVideoStreamCopy=True&api_key=${apiKey}`,
    base,
    itemId,
    sourceId,
  );
  assert.equal(target.searchParams.get('MediaSourceId'), sourceId);
  assert.equal(target.searchParams.has('api_key'), false);
  assert.throws(() => credentialFreeHlsTarget(target, base, itemId, 'other-version'), /hls_target_denied/);
});
