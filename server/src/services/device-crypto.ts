import crypto from 'node:crypto';

export type DeviceKeyAlgorithm = 'Ed25519' | 'ES256';

const PAIRING_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CAPABILITY_RE = /^[a-z0-9][a-z0-9._:-]{0,63}$/;

export class DeviceInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DeviceInputError';
  }
}
function decodeBase64Url(value: string, field: string, maxBytes: number): Buffer {
  if (!value || !/^[A-Za-z0-9_-]+$/.test(value)) throw new DeviceInputError(`invalid_${field}`);
  let out: Buffer;
  try { out = Buffer.from(value, 'base64url'); }
  catch { throw new DeviceInputError(`invalid_${field}`); }
  if (!out.length || out.length > maxBytes || out.toString('base64url') !== value) {
    throw new DeviceInputError(`invalid_${field}`);
  }
  return out;
}

export function normalizePairingCode(value: unknown): string {
  const code = String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (code.length !== 8 || [...code].some(c => !PAIRING_ALPHABET.includes(c))) {
    throw new DeviceInputError('invalid_pairing_code');
  }
  return code;
}

export function newPairingCode(): string {
  let value = '';
  for (let i = 0; i < 8; i++) value += PAIRING_ALPHABET[crypto.randomInt(PAIRING_ALPHABET.length)];
  return `${value.slice(0, 4)}-${value.slice(4)}`;
}

export function normalizeDeviceName(value: unknown, fallback = 'New device'): string {
  const name = String(value || fallback).replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (!name || name.length > 100) throw new DeviceInputError('invalid_device_name');
  return name;
}

export function normalizeDeviceType(value: unknown): string {
  const type = String(value || 'native').trim().toLowerCase();
  if (!/^[a-z][a-z0-9_-]{0,29}$/.test(type)) throw new DeviceInputError('invalid_device_type');
  return type;
}

export function normalizeCapabilities(value: unknown): string[] {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > 24) throw new DeviceInputError('invalid_capabilities');
  const unique = new Set<string>();
  for (const raw of value) {
    const capability = String(raw).trim().toLowerCase();
    if (!CAPABILITY_RE.test(capability)) throw new DeviceInputError('invalid_capabilities');
    unique.add(capability);
  }
  return [...unique].sort();
}

export function parseDevicePublicKey(publicKey: unknown, algorithm: unknown): {
  publicKey: string;
  algorithm: DeviceKeyAlgorithm;
  fingerprint: string;
  keyObject: crypto.KeyObject;
} {
  const alg = String(algorithm || '') as DeviceKeyAlgorithm;
  if (alg !== 'Ed25519' && alg !== 'ES256') throw new DeviceInputError('unsupported_key_algorithm');
  const encoded = String(publicKey || '');
  const der = decodeBase64Url(encoded, 'public_key', 256);
  let keyObject: crypto.KeyObject;
  try { keyObject = crypto.createPublicKey({ key: der, format: 'der', type: 'spki' }); }
  catch { throw new DeviceInputError('invalid_public_key'); }

  if (alg === 'Ed25519' && keyObject.asymmetricKeyType !== 'ed25519') {
    throw new DeviceInputError('public_key_algorithm_mismatch');
  }
  if (alg === 'ES256') {
    if (keyObject.asymmetricKeyType !== 'ec') throw new DeviceInputError('public_key_algorithm_mismatch');
    const details = keyObject.asymmetricKeyDetails as { namedCurve?: string } | undefined;
    if (!details || !['prime256v1', 'P-256'].includes(details.namedCurve || '')) {
      throw new DeviceInputError('unsupported_ec_curve');
    }
  }

  return {
    publicKey: encoded,
    algorithm: alg,
    fingerprint: crypto.createHash('sha256').update(der).digest('base64url'),
    keyObject,
  };
}

export function signingPayload(purpose: 'pair' | 'authenticate', challengeId: string,
  nonce: string, deviceId: string): string {
  return `aerie-device-proof:v1:${purpose}:${challengeId}:${nonce}:${deviceId}`;
}

export function verifyDeviceProof(publicKey: unknown, algorithm: unknown, payload: string, signature: unknown): boolean {
  const parsed = parseDevicePublicKey(publicKey, algorithm);
  const sig = decodeBase64Url(String(signature || ''), 'signature', 160);
  try {
    return crypto.verify(parsed.algorithm === 'Ed25519' ? null : 'sha256', Buffer.from(payload, 'utf8'), parsed.keyObject, sig);
  } catch {
    return false;
  }
}
