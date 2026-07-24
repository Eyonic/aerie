// Shared, deterministic release-signature format. Build tooling imports this
// exact canonicalizer, and desktop clients verify the resulting bytes against
// the public key bundled inside the application.
const crypto = require('node:crypto');
const fs = require('node:fs');

const PLATFORMS = new Set(['windows', 'linux', 'linux-deb', 'android']);
const SHA256 = /^[a-f0-9]{64}$/i;
const VERSION = /^[0-9]+(?:\.[0-9]+){1,3}(?:[-+][0-9A-Za-z.-]+)?$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;

function text(value, name, max, { empty = false } = {}) {
  if (typeof value !== 'string' || value.length > max || (!empty && !value.length)
      || value.includes('\0') || value.includes('\r')) throw new Error(`invalid_release_${name}`);
  return value;
}

function safeFilename(value) {
  const filename = text(value, 'filename', 180);
  if (filename === '.' || filename === '..' || filename.trim() !== filename
      || /[\\/\n\x00-\x1f]/.test(filename)) throw new Error('invalid_release_filename');
  return filename;
}

function normalizeReleasePayload(value) {
  if (!value || typeof value !== 'object') throw new Error('invalid_release_payload');
  const platform = text(value.platform, 'platform', 20);
  if (!PLATFORMS.has(platform)) throw new Error('invalid_release_platform');
  const filename = safeFilename(value.filename);
  const version = text(value.version, 'version', 48);
  if (!VERSION.test(version)) throw new Error('invalid_release_version');
  const build = value.build == null ? null : Number(value.build);
  if (build !== null && (!Number.isSafeInteger(build) || build < 0)) throw new Error('invalid_release_build');
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
  const notes = text(value.notes, 'notes', 500, { empty: true });
  return { platform, filename, version, build, sha256, sizeBytes, minServerVersion, publishedAt, notes };
}

function canonicalReleasePayload(value) {
  const release = normalizeReleasePayload(value);
  return Buffer.from([
    'aerie-release-v1',
    release.platform,
    release.filename,
    release.version,
    release.build == null ? '' : String(release.build),
    release.sha256,
    String(release.sizeBytes),
    release.minServerVersion,
    release.publishedAt,
    Buffer.from(release.notes, 'utf8').toString('base64url'),
  ].join('\n'), 'utf8');
}

function safeEqualHex(left, right) {
  if (!SHA256.test(String(left || '')) || !SHA256.test(String(right || ''))) return false;
  return crypto.timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}

function decodeBase64(value, format) {
  if (typeof value !== 'string' || !value.length || value.length > 4096) throw new Error(`invalid_${format}`);
  const valid = format === 'release_public_key' ? BASE64.test(value) : BASE64URL.test(value);
  if (!valid) throw new Error(`invalid_${format}`);
  const bytes = Buffer.from(value, format === 'release_public_key' ? 'base64' : 'base64url');
  const encoded = bytes.toString(format === 'release_public_key' ? 'base64' : 'base64url');
  if (encoded !== value) throw new Error(`invalid_${format}`);
  return bytes;
}

function loadPinnedReleaseKey(source) {
  const parsed = typeof source === 'string' ? JSON.parse(fs.readFileSync(source, 'utf8')) : source;
  if (!parsed || parsed.schemaVersion !== 1 || parsed.algorithm !== 'Ed25519') {
    throw new Error('invalid_release_public_key');
  }
  const declaredKeyId = String(parsed.keyId || '').toLowerCase();
  const der = decodeBase64(parsed.publicKeySpkiBase64, 'release_public_key');
  const actualKeyId = crypto.createHash('sha256').update(der).digest('hex');
  if (!safeEqualHex(declaredKeyId, actualKeyId)) throw new Error('release_public_key_id_mismatch');
  let publicKey;
  try { publicKey = crypto.createPublicKey({ key: der, format: 'der', type: 'spki' }); }
  catch (error) { throw new Error('invalid_release_public_key', { cause: error }); }
  if (publicKey.asymmetricKeyType !== 'ed25519') throw new Error('invalid_release_public_key_type');
  return { keyId: actualKeyId, publicKey };
}

function verifyReleaseSignature(value, pinnedKey) {
  const release = normalizeReleasePayload(value);
  if (value.signatureAlgorithm !== 'Ed25519') throw new Error('unsupported_release_signature');
  const keyId = String(value.signatureKeyId || '').toLowerCase();
  if (!safeEqualHex(keyId, pinnedKey?.keyId)) throw new Error('release_signature_key_mismatch');
  const signature = decodeBase64(value.signature, 'release_signature');
  if (signature.length !== 64) throw new Error('invalid_release_signature');
  if (!crypto.verify(null, canonicalReleasePayload(release), pinnedKey.publicKey, signature)) {
    throw new Error('release_signature_invalid');
  }
  return { ...release, signatureAlgorithm: 'Ed25519', signatureKeyId: keyId, signature: value.signature };
}

module.exports = {
  canonicalReleasePayload,
  loadPinnedReleaseKey,
  normalizeReleasePayload,
  safeFilename,
  verifyReleaseSignature,
};
