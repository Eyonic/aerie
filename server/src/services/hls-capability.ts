import crypto from 'node:crypto';
import { mediaTarget } from './media-proxy.js';

const PLAYLIST_QUERY = new Set([
  'AllowAudioStreamCopy', 'AllowVideoStreamCopy', 'AudioBitrate', 'AudioChannels',
  'AudioCodec', 'AudioStreamIndex', 'BreakOnNonKeyFrames', 'EnableAutoStreamCopy',
  'MaxAudioChannels', 'MaxHeight', 'MaxStreamingBitrate', 'MaxWidth', 'MediaSourceId',
  'MinSegments', 'PlaySessionId', 'SegmentContainer', 'TranscodingMaxAudioChannels',
  'VideoBitrate', 'VideoCodec', 'VideoStreamIndex',
  // Jellyfin currently preserves the controller's lower-camel query spelling
  // in some generated child playlists and PascalCase in others.
  'allowAudioStreamCopy', 'allowVideoStreamCopy', 'enableAutoStreamCopy',
  'maxAudioChannels', 'maxHeight', 'maxWidth',
]);
const SEGMENT_QUERY = new Set([...PLAYLIST_QUERY, 'actualSegmentLengthTicks', 'runtimeTicks']);

function denied(code = 'hls_target_denied'): never {
  throw Object.assign(new Error(code), { status: 403 });
}

function relativeSegments(target: URL, configuredBase: string): string[] {
  const base = mediaTarget(configuredBase, configuredBase);
  const root = base.pathname.replace(/\/+$/, '') || '/';
  const relative = root === '/' ? target.pathname : target.pathname.slice(root.length);
  if (!relative.startsWith('/') || relative.includes('//')) denied();
  try { return relative.split('/').slice(1).map(segment => decodeURIComponent(segment)); }
  catch { return denied(); }
}

/** Validate and remove every credential before a target can be placed behind a
 * browser-facing capability. This is intentionally not a general Jellyfin proxy. */
export function credentialFreeHlsTarget(value: string | URL, configuredBase: string, itemId: string,
  mediaSourceId = itemId): URL {
  if (!itemId || itemId.length > 256 || /[\u0000-\u001f/\\]/.test(itemId)) denied();
  if (!mediaSourceId || mediaSourceId.length > 256 || /[\u0000-\u001f/\\]/.test(mediaSourceId)) denied();
  const target = mediaTarget(value, configuredBase);
  const parts = relativeSegments(target, configuredBase);
  const playlist = parts.length === 3
    && parts[0] === 'Videos' && parts[1] === itemId
    && (parts[2] === 'master.m3u8' || parts[2] === 'main.m3u8');
  const segment = parts.length === 5
    && parts[0] === 'Videos' && parts[1] === itemId
    && parts[2] === 'hls1' && parts[3] === 'main' && /^\d+\.ts$/.test(parts[4]);
  if (!playlist && !segment) denied();

  const allowed = segment ? SEGMENT_QUERY : PLAYLIST_QUERY;
  for (const name of [...target.searchParams.keys()]) {
    if (name.toLowerCase() === 'api_key') {
      target.searchParams.delete(name);
      continue;
    }
    if (!allowed.has(name)) denied();
  }
  const mediaSourceIds = target.searchParams.getAll('MediaSourceId');
  if (mediaSourceIds.some(id => id !== mediaSourceId)) denied();
  return target;
}

export function withJellyfinHlsAuth(target: URL, apiKey: string): URL {
  if (!apiKey) denied('hls_upstream_auth_unavailable');
  const authenticated = new URL(target);
  authenticated.searchParams.set('api_key', apiKey);
  return authenticated;
}

type Grant = {
  nonce: string;
  signature: string;
  userId: number;
  itemId: string;
  target: string;
  expiresAt: number;
};

export class HlsCapabilityStore {
  private grants = new Map<string, Grant>();
  private issued = 0;

  constructor(
    private readonly secret: string,
    private readonly ttlMs = 12 * 60 * 60_000,
    private readonly now: () => number = Date.now,
  ) {
    if (!secret || ttlMs <= 0) throw new Error('invalid_hls_capability_config');
  }

  private signature(grant: Omit<Grant, 'signature'>): string {
    return crypto.createHmac('sha256', this.secret)
      .update(`aerie-hls-v1\0${grant.nonce}\0${grant.userId}\0${grant.itemId}\0${grant.expiresAt}\0${grant.target}`)
      .digest('base64url');
  }

  private prune(): void {
    const now = this.now();
    for (const [nonce, grant] of this.grants) if (grant.expiresAt <= now) this.grants.delete(nonce);
    if (this.grants.size < 100_000) return;
    const oldest = [...this.grants.values()].sort((a, b) => a.expiresAt - b.expiresAt).slice(0, this.grants.size - 99_999);
    for (const grant of oldest) this.grants.delete(grant.nonce);
  }

  mint(userId: number, itemId: string, target: URL): string {
    if (!Number.isSafeInteger(userId) || userId <= 0) denied('hls_capability_scope_invalid');
    if ((++this.issued & 0xff) === 0 || this.grants.size >= 100_000) this.prune();
    const unsigned = {
      nonce: crypto.randomBytes(24).toString('base64url'),
      userId,
      itemId,
      target: target.toString(),
      expiresAt: this.now() + this.ttlMs,
    };
    const grant: Grant = { ...unsigned, signature: this.signature(unsigned) };
    this.grants.set(grant.nonce, grant);
    return `${grant.nonce}.${grant.signature}`;
  }

  resolve(token: string, userId: number, itemId: string): URL {
    const parts = typeof token === 'string' ? token.split('.') : [];
    // randomBytes(24) and a SHA-256 HMAC have one canonical base64url spelling:
    // 32 and 43 characters respectively. Reject alternate trailing-bit
    // spellings even when a permissive decoder would produce the same bytes.
    if (parts.length !== 2 || parts[0].length !== 32 || parts[1].length !== 43
        || !/^[A-Za-z0-9_-]+$/.test(parts[0]) || !/^[A-Za-z0-9_-]+$/.test(parts[1])) {
      denied('hls_capability_invalid');
    }
    const grant = this.grants.get(parts[0]);
    if (!grant) denied('hls_capability_invalid');
    if (grant.expiresAt <= this.now()) {
      this.grants.delete(grant.nonce);
      denied('hls_capability_expired');
    }
    const supplied = Buffer.from(parts[1], 'base64url');
    if (supplied.toString('base64url') !== parts[1]) denied('hls_capability_invalid');
    const expected = Buffer.from(this.signature({
      nonce: grant.nonce,
      userId: grant.userId,
      itemId: grant.itemId,
      target: grant.target,
      expiresAt: grant.expiresAt,
    }), 'base64url');
    if (supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) denied('hls_capability_invalid');
    if (grant.userId !== userId || grant.itemId !== itemId) denied('hls_capability_scope_mismatch');
    return new URL(grant.target);
  }
}

export function rewriteHlsPlaylist(
  text: string,
  baseAbsUrl: string,
  configuredBase: string,
  itemId: string,
  userId: number,
  capabilities: HlsCapabilityStore,
  mediaSourceId = itemId,
): string {
  const proxied = (value: string) => {
    const target = credentialFreeHlsTarget(new URL(value, baseAbsUrl), configuredBase, itemId, mediaSourceId);
    const capability = capabilities.mint(userId, itemId, target);
    return `/api/media/hls/${encodeURIComponent(itemId)}?p=${encodeURIComponent(capability)}`;
  };
  return text.split('\n').map(line => {
    const trimmed = line.trim();
    if (!trimmed) return line;
    if (trimmed.startsWith('#')) {
      return trimmed.includes('URI="')
        ? line.replace(/URI="([^"]+)"/g, (_match, value) => `URI="${proxied(value)}"`)
        : line;
    }
    return proxied(trimmed);
  }).join('\n');
}
