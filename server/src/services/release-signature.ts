import crypto from 'node:crypto';
import path from 'node:path';

export type DesktopReleasePlatform = 'windows' | 'linux' | 'linux-deb';

export type NormalizedSignedRelease = {
  platform: DesktopReleasePlatform;
  filename: string;
  version: string;
  build: number;
  sha256: string;
  sizeBytes: number;
  minServerVersion: string;
  publishedAt: string;
  notes: string;
  signatureAlgorithm: 'Ed25519';
  signatureKeyId: string;
  signature: string;
};

export type DesktopReleaseKey = {
  keyId: string;
  publicKey: crypto.KeyObject;
};

export const PINNED_DESKTOP_RELEASE_KEY = {
  schemaVersion: 1,
  algorithm: 'Ed25519',
  keyId: '0ba7a7805ff75520272e08bd96610c86344c04929ed73f4ee6ef172317df4f4e',
  publicKeySpkiBase64: 'MCowBQYDK2VwAyEAbsa9EPvYAcbM9kndFzpLQiVzPM2Y2AreGP0/uC2KlRE=',
} as const;

const DESKTOP_PLATFORMS = new Set<DesktopReleasePlatform>(['windows', 'linux', 'linux-deb']);
const SHA256 = /^[a-f0-9]{64}$/i;
const VERSION = /^[0-9]+(?:\.[0-9]+){1,3}(?:[-+][0-9A-Za-z.-]+)?$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;

function text(value: unknown, name: string, max: number, empty = false): string {
  if (typeof value !== 'string' || value.length > max || (!empty && !value.length)
      || value.includes('\0') || value.includes('\r')) throw new Error(`invalid_release_${name}`);
  return value;
}

function filename(value: unknown): string {
  const result = text(value, 'filename', 180);
  if (result === '.' || result === '..' || result.trim() !== result || path.basename(result) !== result
      || /[\\/\n\x00-\x1f]/.test(result)) throw new Error('invalid_release_filename');
  return result;
}

function strictBase64(value: unknown, format: 'base64' | 'base64url'): Buffer {
  if (typeof value !== 'string' || !value.length || value.length > 4096
      || !(format === 'base64' ? BASE64 : BASE64URL).test(value)) throw new Error('invalid_release_encoding');
  const bytes = Buffer.from(value, format);
  if (bytes.toString(format) !== value) throw new Error('invalid_release_encoding');
  return bytes;
}

export function loadDesktopReleaseKey(source = PINNED_DESKTOP_RELEASE_KEY): DesktopReleaseKey {
  if (source?.schemaVersion !== 1 || source?.algorithm !== 'Ed25519') {
    throw new Error('invalid_release_public_key');
  }
  const der = strictBase64(source.publicKeySpkiBase64, 'base64');
  const actualKeyId = crypto.createHash('sha256').update(der).digest('hex');
  const declaredKeyId = String(source.keyId || '').toLowerCase();
  if (!SHA256.test(declaredKeyId)
      || !crypto.timingSafeEqual(Buffer.from(actualKeyId, 'hex'), Buffer.from(declaredKeyId, 'hex'))) {
    throw new Error('release_public_key_id_mismatch');
  }
  const publicKey = crypto.createPublicKey({ key: der, format: 'der', type: 'spki' });
  if (publicKey.asymmetricKeyType !== 'ed25519') throw new Error('invalid_release_public_key_type');
  return { keyId: actualKeyId, publicKey };
}

const defaultDesktopReleaseKey = loadDesktopReleaseKey();

export function normalizeDesktopRelease(value: any, expectedPlatform?: DesktopReleasePlatform): Omit<NormalizedSignedRelease,
  'signatureAlgorithm' | 'signatureKeyId' | 'signature'> {
  if (!value || typeof value !== 'object') throw new Error('invalid_release_payload');
  const platform = text(value.platform, 'platform', 20) as DesktopReleasePlatform;
  if (!DESKTOP_PLATFORMS.has(platform) || (expectedPlatform && platform !== expectedPlatform)) {
    throw new Error('invalid_release_platform');
  }
  const version = text(value.version, 'version', 48);
  if (!VERSION.test(version)) throw new Error('invalid_release_version');
  const build = Number(value.build);
  if (!Number.isSafeInteger(build) || build <= 0) throw new Error('invalid_release_build');
  const sha256 = text(value.sha256, 'hash', 64).toLowerCase();
  if (!SHA256.test(sha256)) throw new Error('invalid_release_hash');
  const sizeBytes = Number(value.sizeBytes);
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes <= 0) throw new Error('invalid_release_size');
  const minServerVersion = text(value.minServerVersion, 'minimum_server_version', 48);
  if (!VERSION.test(minServerVersion)) throw new Error('invalid_release_minimum_server_version');
  const publishedAt = text(value.publishedAt, 'published_at', 48);
  if (!ISO_DATE.test(publishedAt) || !Number.isFinite(Date.parse(publishedAt))) {
    throw new Error('invalid_release_published_at');
  }
  const notes = text(value.notes, 'notes', 500, true);
  return {
    platform,
    filename: filename(value.filename),
    version,
    build,
    sha256,
    sizeBytes,
    minServerVersion,
    publishedAt,
    notes,
  };
}

export function canonicalDesktopReleasePayload(value: any): Buffer {
  const release = normalizeDesktopRelease(value);
  return Buffer.from([
    'aerie-release-v1',
    release.platform,
    release.filename,
    release.version,
    String(release.build),
    release.sha256,
    String(release.sizeBytes),
    release.minServerVersion,
    release.publishedAt,
    Buffer.from(release.notes, 'utf8').toString('base64url'),
  ].join('\n'), 'utf8');
}

export function verifyDesktopReleaseSignature(
  value: any,
  expectedPlatform: DesktopReleasePlatform,
  pinnedKey: DesktopReleaseKey = defaultDesktopReleaseKey,
): NormalizedSignedRelease | null {
  try {
    const release = normalizeDesktopRelease(value, expectedPlatform);
    if (value.signatureAlgorithm !== 'Ed25519') return null;
    const keyId = String(value.signatureKeyId || '').toLowerCase();
    if (!SHA256.test(keyId) || !SHA256.test(pinnedKey.keyId)
        || !crypto.timingSafeEqual(Buffer.from(keyId, 'hex'), Buffer.from(pinnedKey.keyId, 'hex'))) return null;
    const signature = strictBase64(value.signature, 'base64url');
    if (signature.length !== 64 || !crypto.verify(null, canonicalDesktopReleasePayload(release), pinnedKey.publicKey, signature)) {
      return null;
    }
    return {
      ...release,
      signatureAlgorithm: 'Ed25519',
      signatureKeyId: keyId,
      signature: value.signature,
    };
  } catch {
    return null;
  }
}
