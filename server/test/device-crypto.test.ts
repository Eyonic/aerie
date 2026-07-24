import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import {
  DeviceInputError,
  newPairingCode,
  normalizeCapabilities,
  normalizePairingCode,
  parseDevicePublicKey,
  signingPayload,
  verifyDeviceProof,
} from '../src/services/device-crypto.js';

test('pairing codes are human-friendly and normalize separators', () => {
  const code = newPairingCode();
  assert.match(code, /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
  assert.equal(normalizePairingCode(code.toLowerCase()), code.replace('-', ''));
  assert.throws(() => normalizePairingCode('IIII-0000'), DeviceInputError);
});

test('capabilities are normalized, deduplicated, and bounded', () => {
  assert.deepEqual(normalizeCapabilities(['Sync', 'media-session', 'sync']), ['media-session', 'sync']);
  assert.throws(() => normalizeCapabilities(['has spaces']), DeviceInputError);
  assert.throws(() => normalizeCapabilities(Array(25).fill('sync')), DeviceInputError);
});

test('Ed25519 proof verifies only the canonical challenge payload', () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const encoded = publicKey.export({ format: 'der', type: 'spki' }).toString('base64url');
  const parsed = parseDevicePublicKey(encoded, 'Ed25519');
  assert.equal(parsed.algorithm, 'Ed25519');
  const payload = signingPayload('authenticate', 'ch_123', 'nonce_123', 'device_12345678901234567890');
  const signature = crypto.sign(null, Buffer.from(payload), privateKey).toString('base64url');
  assert.equal(verifyDeviceProof(encoded, 'Ed25519', payload, signature), true);
  assert.equal(verifyDeviceProof(encoded, 'Ed25519', payload + ':tampered', signature), false);
});

test('ES256 proof accepts P-256 SPKI and rejects another curve', () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const encoded = publicKey.export({ format: 'der', type: 'spki' }).toString('base64url');
  const payload = signingPayload('pair', 'ch_pair', 'nonce_pair', 'device_12345678901234567890');
  const signature = crypto.sign('sha256', Buffer.from(payload), privateKey).toString('base64url');
  assert.equal(verifyDeviceProof(encoded, 'ES256', payload, signature), true);

  const p384 = crypto.generateKeyPairSync('ec', { namedCurve: 'secp384r1' }).publicKey
    .export({ format: 'der', type: 'spki' }).toString('base64url');
  assert.throws(() => parseDevicePublicKey(p384, 'ES256'), /unsupported_ec_curve/);
});
