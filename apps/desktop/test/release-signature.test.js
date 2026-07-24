const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {
  canonicalReleasePayload,
  loadPinnedReleaseKey,
  verifyReleaseSignature,
} = require('../release-signature');

function signingFixture() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const der = publicKey.export({ type: 'spki', format: 'der' });
  const keyId = crypto.createHash('sha256').update(der).digest('hex');
  const pinned = loadPinnedReleaseKey({
    schemaVersion: 1,
    algorithm: 'Ed25519',
    keyId,
    publicKeySpkiBase64: der.toString('base64'),
  });
  const sign = release => ({
    ...release,
    signatureAlgorithm: 'Ed25519',
    signatureKeyId: keyId,
    signature: crypto.sign(null, canonicalReleasePayload(release), privateKey).toString('base64url'),
  });
  return { pinned, sign };
}

const RELEASE = {
  platform: 'linux',
  filename: 'Aerie-1.8.0.AppImage',
  version: '1.8.0',
  build: 9,
  sha256: 'ab'.repeat(32),
  sizeBytes: 456789,
  minServerVersion: '1.7.0',
  publishedAt: '2026-07-23T20:15:30.123Z',
  notes: 'Signed updates, with café safety.',
};

test('release canonical bytes bind every security- and user-visible field', () => {
  assert.equal(canonicalReleasePayload(RELEASE).toString('utf8'), [
    'aerie-release-v1',
    'linux',
    'Aerie-1.8.0.AppImage',
    '1.8.0',
    '9',
    'ab'.repeat(32),
    '456789',
    '1.7.0',
    '2026-07-23T20:15:30.123Z',
    Buffer.from('Signed updates, with café safety.', 'utf8').toString('base64url'),
  ].join('\n'));
});

test('valid Ed25519 release is accepted and every bound-field mutation is rejected', () => {
  const { pinned, sign } = signingFixture();
  const signed = sign(RELEASE);
  assert.deepEqual(verifyReleaseSignature(signed, pinned), signed);

  const mutations = {
    platform: 'windows',
    filename: 'Other.AppImage',
    version: '1.8.1',
    build: 10,
    sha256: 'cd'.repeat(32),
    sizeBytes: RELEASE.sizeBytes + 1,
    minServerVersion: '1.7.1',
    publishedAt: '2026-07-23T20:15:31.123Z',
    notes: 'Changed notes',
  };
  for (const [field, value] of Object.entries(mutations)) {
    assert.throws(() => verifyReleaseSignature({ ...signed, [field]: value }, pinned),
      /release_signature_invalid/, field);
  }
});

test('wrong keys, malformed encodings, and unsafe release names fail closed', () => {
  const first = signingFixture();
  const second = signingFixture();
  const signed = first.sign(RELEASE);
  assert.throws(() => verifyReleaseSignature(signed, second.pinned), /release_signature_key_mismatch/);
  assert.throws(() => verifyReleaseSignature({ ...signed, signature: `${signed.signature}=` }, first.pinned),
    /invalid_release_signature/);
  assert.throws(() => canonicalReleasePayload({ ...RELEASE, filename: '../Aerie.AppImage' }),
    /invalid_release_filename/);
});
