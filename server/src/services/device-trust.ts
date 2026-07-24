import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { db, audit } from '../lib/db.js';
import { findUserById, rowToUser } from '../lib/auth.js';
import {
  DeviceInputError,
  newPairingCode,
  normalizeCapabilities,
  normalizeDeviceName,
  normalizeDeviceType,
  normalizePairingCode,
  parseDevicePublicKey,
  signingPayload,
  verifyDeviceProof,
} from './device-crypto.js';

const PAIRING_LIFETIME_MS = 5 * 60_000;
const CHALLENGE_LIFETIME_MS = 90_000;
const DEVICE_SESSION_LIFETIME_MS = 15 * 60_000;

export class DeviceTrustError extends Error {
  constructor(public code: string, public status = 400) {
    super(code);
    this.name = 'DeviceTrustError';
  }
}

function expiresIn(ms: number) { return new Date(Date.now() + ms).toISOString(); }
function randomId(prefix: string) { return `${prefix}_${crypto.randomBytes(18).toString('base64url')}`; }
function pairingDigest(code: string) {
  return crypto.createHmac('sha256', config.jwtSecret).update(`device-pairing:v1:${normalizePairingCode(code)}`).digest('hex');
}
function safeJsonArray(raw: unknown): string[] {
  try { return normalizeCapabilities(JSON.parse(String(raw || '[]'))); }
  catch { return []; }
}
function cleanupExpired() {
  db.prepare("DELETE FROM device_challenges WHERE datetime(expires_at)<=datetime('now') OR consumed_at IS NOT NULL AND datetime(consumed_at)<datetime('now','-1 day')").run();
  db.prepare("DELETE FROM device_pairings WHERE datetime(expires_at)<datetime('now','-1 day') OR completed_at IS NOT NULL AND datetime(completed_at)<datetime('now','-7 days')").run();
  db.prepare("DELETE FROM auth_sessions WHERE id IN (SELECT session_id FROM device_session_links) AND datetime(expires_at)<datetime('now','-1 day')").run();
}

function createChallenge(deviceId: string, purpose: 'pair' | 'authenticate', pairingId?: string) {
  const id = randomId('ch');
  const nonce = crypto.randomBytes(32).toString('base64url');
  const expiresAt = expiresIn(CHALLENGE_LIFETIME_MS);
  db.prepare(`INSERT INTO device_challenges (id,device_id,pairing_id,purpose,nonce,expires_at)
    VALUES (?,?,?,?,?,?)`).run(id, deviceId, pairingId || null, purpose, nonce, expiresAt);
  return { challengeId: id, challenge: nonce, signingPayload: signingPayload(purpose, id, nonce, deviceId), expiresAt };
}

function issueDeviceSession(device: any, ip?: string, userAgent?: string) {
  const userRow = findUserById(device.user_id);
  if (!userRow) throw new DeviceTrustError('user_not_found', 404);
  const sessionId = randomId('devs');
  const expiresAt = expiresIn(DEVICE_SESSION_LIFETIME_MS);
  db.transaction(() => {
    db.prepare(`INSERT INTO auth_sessions (id,user_id,device_name,device_type,ip,user_agent,expires_at)
      VALUES (?,?,?,?,?,?,?)`).run(sessionId, device.user_id, device.name, device.type, ip || null,
        String(userAgent || '').slice(0, 500), expiresAt);
    db.prepare('INSERT INTO device_session_links (session_id,device_id) VALUES (?,?)').run(sessionId, device.id);
  })();
  const token = jwt.sign({ id: device.user_id, username: userRow.username, role: userRow.role, sid: sessionId,
    did: device.id, auth: 'device-proof-v1' }, config.jwtSecret, { expiresIn: '15m', audience: 'aerie-account' });
  return { token, expiresAt, user: rowToUser(userRow) };
}

export function createPairing(userId: number, sessionId: string | undefined, input: any) {
  cleanupExpired();
  const requestedName = normalizeDeviceName(input?.name);
  const requestedType = normalizeDeviceType(input?.type);
  const capabilities = normalizeCapabilities(input?.capabilities);
  let code = '';
  let digest = '';
  for (let i = 0; i < 5; i++) {
    code = newPairingCode();
    digest = pairingDigest(code);
    if (!db.prepare('SELECT 1 FROM device_pairings WHERE code_digest=?').get(digest)) break;
  }
  if (!code || db.prepare('SELECT 1 FROM device_pairings WHERE code_digest=?').get(digest)) {
    throw new DeviceTrustError('pairing_code_unavailable', 503);
  }
  const id = randomId('pair');
  const expiresAt = expiresIn(PAIRING_LIFETIME_MS);
  db.prepare(`INSERT INTO device_pairings
    (id,user_id,code_digest,requested_name,requested_type,requested_capabilities,paired_by_session_id,expires_at)
    VALUES (?,?,?,?,?,?,?,?)`).run(id, userId, digest, requestedName, requestedType,
      JSON.stringify(capabilities), sessionId || null, expiresAt);
  return { id, code, expiresAt, name: requestedName, type: requestedType, capabilities };
}

export function getPairing(userId: number, pairingId: string) {
  const row = db.prepare('SELECT * FROM device_pairings WHERE id=? AND user_id=?').get(pairingId, userId) as any;
  if (!row) throw new DeviceTrustError('pairing_not_found', 404);
  const status = row.cancelled_at ? 'cancelled' : row.completed_at ? 'completed'
    : new Date(row.expires_at).getTime() <= Date.now() ? 'expired' : row.claimed_at ? 'claimed' : 'waiting';
  return { id: row.id, status, expiresAt: row.expires_at, deviceId: row.device_id || undefined,
    deviceName: row.device_name || undefined, deviceType: row.device_type || undefined };
}

export function cancelPairing(userId: number, pairingId: string) {
  const info = db.prepare("UPDATE device_pairings SET cancelled_at=datetime('now') WHERE id=? AND user_id=? AND completed_at IS NULL AND cancelled_at IS NULL")
    .run(pairingId, userId);
  if (!info.changes) throw new DeviceTrustError('pairing_not_found_or_closed', 404);
  db.prepare("UPDATE device_challenges SET consumed_at=datetime('now') WHERE pairing_id=? AND consumed_at IS NULL").run(pairingId);
}

export function claimPairing(input: any) {
  cleanupExpired();
  const code = normalizePairingCode(input?.code);
  const pairing = db.prepare(`SELECT p.* FROM device_pairings p JOIN users u ON u.id=p.user_id
    WHERE p.code_digest=? AND u.disabled_at IS NULL`).get(pairingDigest(code)) as any;
  if (!pairing) throw new DeviceTrustError('invalid_or_expired_pairing', 404);
  if (pairing.cancelled_at || pairing.completed_at || new Date(pairing.expires_at).getTime() <= Date.now()) {
    throw new DeviceTrustError('invalid_or_expired_pairing', 410);
  }
  if (pairing.attempt_count >= 5) throw new DeviceTrustError('pairing_locked', 429);

  let key;
  try { key = parseDevicePublicKey(input?.publicKey, input?.algorithm); }
  catch (error) {
    db.prepare('UPDATE device_pairings SET attempt_count=attempt_count+1 WHERE id=?').run(pairing.id);
    throw error;
  }
  const name = normalizeDeviceName(input?.name, pairing.requested_name);
  const type = normalizeDeviceType(input?.type || pairing.requested_type);
  const suppliedCapabilities = input?.capabilities == null ? safeJsonArray(pairing.requested_capabilities)
    : normalizeCapabilities(input.capabilities);

  const duplicate = db.prepare(`SELECT id FROM trusted_devices
    WHERE user_id=? AND public_key_fingerprint=? AND revoked_at IS NULL`).get(pairing.user_id, key.fingerprint) as any;
  if (duplicate) throw new DeviceTrustError('device_already_paired', 409);

  let deviceId = pairing.device_id as string | null;
  if (deviceId) {
    if (pairing.public_key_fingerprint !== key.fingerprint) throw new DeviceTrustError('pairing_already_claimed', 409);
  } else {
    deviceId = randomId('device');
    db.prepare(`UPDATE device_pairings SET device_id=?,device_name=?,device_type=?,public_key=?,
      public_key_fingerprint=?,key_algorithm=?,capabilities=?,claimed_at=datetime('now') WHERE id=? AND claimed_at IS NULL`)
      .run(deviceId, name, type, key.publicKey, key.fingerprint, key.algorithm, JSON.stringify(suppliedCapabilities), pairing.id);
  }
  db.prepare("UPDATE device_challenges SET consumed_at=datetime('now') WHERE pairing_id=? AND purpose='pair' AND consumed_at IS NULL").run(pairing.id);
  return { pairingId: pairing.id, deviceId, ...createChallenge(deviceId!, 'pair', pairing.id) };
}

function requireLiveChallenge(challengeId: unknown, deviceId: unknown, purpose: 'pair' | 'authenticate') {
  const challenge = db.prepare(`SELECT * FROM device_challenges WHERE id=? AND device_id=? AND purpose=?
    AND consumed_at IS NULL AND datetime(expires_at)>datetime('now')`).get(String(challengeId || ''), String(deviceId || ''), purpose) as any;
  if (!challenge) throw new DeviceTrustError('invalid_or_expired_challenge', 401);
  return challenge;
}

export function completePairing(input: any, ip?: string, userAgent?: string) {
  const deviceId = String(input?.deviceId || '');
  const pairingId = String(input?.pairingId || '');
  const challenge = requireLiveChallenge(input?.challengeId, deviceId, 'pair');
  const pairing = db.prepare(`SELECT p.* FROM device_pairings p JOIN users u ON u.id=p.user_id
    WHERE p.id=? AND p.device_id=? AND p.claimed_at IS NOT NULL AND u.disabled_at IS NULL
    AND p.completed_at IS NULL AND p.cancelled_at IS NULL AND datetime(p.expires_at)>datetime('now')`).get(pairingId, deviceId) as any;
  if (!pairing || challenge.pairing_id !== pairingId) throw new DeviceTrustError('invalid_or_expired_pairing', 410);
  const payload = signingPayload('pair', challenge.id, challenge.nonce, deviceId);
  if (!verifyDeviceProof(pairing.public_key, pairing.key_algorithm, payload, input?.signature)) {
    db.prepare('UPDATE device_pairings SET attempt_count=attempt_count+1 WHERE id=?').run(pairingId);
    throw new DeviceTrustError('invalid_device_proof', 401);
  }

  try {
    db.transaction(() => {
      const consumed = db.prepare("UPDATE device_challenges SET consumed_at=datetime('now') WHERE id=? AND consumed_at IS NULL")
        .run(challenge.id);
      if (!consumed.changes) throw new DeviceTrustError('challenge_already_used', 409);
      db.prepare(`INSERT INTO trusted_devices
        (id,user_id,name,type,public_key,public_key_fingerprint,key_algorithm,capabilities,paired_by_session_id)
        VALUES (?,?,?,?,?,?,?,?,?)`).run(deviceId, pairing.user_id, pairing.device_name, pairing.device_type,
          pairing.public_key, pairing.public_key_fingerprint, pairing.key_algorithm, pairing.capabilities || '[]',
          pairing.paired_by_session_id || null);
      db.prepare("UPDATE device_pairings SET completed_at=datetime('now') WHERE id=? AND completed_at IS NULL").run(pairingId);
    })();
  } catch (error) {
    if (error instanceof DeviceTrustError) throw error;
    throw new DeviceTrustError('device_already_paired', 409);
  }
  const device = db.prepare('SELECT * FROM trusted_devices WHERE id=?').get(deviceId) as any;
  audit(device.user_id, findUserById(device.user_id)?.username || 'unknown', 'device_paired', device.id, ip,
    { type: device.type, fingerprint: device.public_key_fingerprint });
  return { device: mapDevice(device), ...issueDeviceSession(device, ip, userAgent) };
}

export function createAuthenticationChallenge(deviceId: unknown) {
  cleanupExpired();
  const id = String(deviceId || '');
  if (!/^device_[A-Za-z0-9_-]{20,64}$/.test(id)) throw new DeviceTrustError('device_not_found', 404);
  const device = db.prepare(`SELECT td.id FROM trusted_devices td JOIN users u ON u.id=td.user_id
    WHERE td.id=? AND td.revoked_at IS NULL AND u.disabled_at IS NULL`).get(id) as any;
  if (!device) throw new DeviceTrustError('device_not_found', 404);
  const recent = (db.prepare(`SELECT COUNT(*) count FROM device_challenges WHERE device_id=? AND purpose='authenticate'
    AND datetime(created_at)>datetime('now','-1 minute')`).get(id) as any).count as number;
  if (recent >= 10) throw new DeviceTrustError('too_many_challenges', 429);
  return { deviceId: id, ...createChallenge(id, 'authenticate') };
}

export function authenticateDevice(input: any, ip?: string, userAgent?: string) {
  const deviceId = String(input?.deviceId || '');
  const challenge = requireLiveChallenge(input?.challengeId, deviceId, 'authenticate');
  const device = db.prepare(`SELECT td.* FROM trusted_devices td JOIN users u ON u.id=td.user_id
    WHERE td.id=? AND td.revoked_at IS NULL AND u.disabled_at IS NULL`).get(deviceId) as any;
  if (!device) throw new DeviceTrustError('device_revoked', 401);
  const payload = signingPayload('authenticate', challenge.id, challenge.nonce, deviceId);
  if (!verifyDeviceProof(device.public_key, device.key_algorithm, payload, input?.signature)) {
    throw new DeviceTrustError('invalid_device_proof', 401);
  }
  const consumed = db.prepare("UPDATE device_challenges SET consumed_at=datetime('now') WHERE id=? AND consumed_at IS NULL").run(challenge.id);
  if (!consumed.changes) throw new DeviceTrustError('challenge_already_used', 409);
  db.prepare("UPDATE trusted_devices SET last_seen=datetime('now') WHERE id=?").run(deviceId);
  const updated = db.prepare('SELECT * FROM trusted_devices WHERE id=?').get(deviceId) as any;
  return { device: mapDevice(updated), ...issueDeviceSession(updated, ip, userAgent) };
}

function mapDevice(row: any, currentSessionId?: string) {
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    algorithm: row.key_algorithm,
    fingerprint: row.public_key_fingerprint,
    capabilities: safeJsonArray(row.capabilities),
    createdAt: row.created_at,
    lastSeen: row.last_seen,
    revokedAt: row.revoked_at || null,
    current: !!currentSessionId && !!db.prepare('SELECT 1 FROM device_session_links WHERE session_id=? AND device_id=?')
      .get(currentSessionId, row.id),
  };
}

export function listDevices(userId: number, currentSessionId?: string, includeRevoked = false) {
  const rows = db.prepare(`SELECT * FROM trusted_devices WHERE user_id=? ${includeRevoked ? '' : 'AND revoked_at IS NULL'}
    ORDER BY revoked_at IS NOT NULL, last_seen DESC`).all(userId) as any[];
  return rows.map(row => mapDevice(row, currentSessionId));
}

export function revokeDevice(userId: number, deviceId: string, username: string, ip?: string) {
  const row = db.prepare('SELECT id FROM trusted_devices WHERE id=? AND user_id=? AND revoked_at IS NULL').get(deviceId, userId);
  if (!row) throw new DeviceTrustError('device_not_found', 404);
  db.transaction(() => {
    db.prepare("UPDATE trusted_devices SET revoked_at=datetime('now') WHERE id=? AND user_id=? AND revoked_at IS NULL").run(deviceId, userId);
    db.prepare(`UPDATE auth_sessions SET revoked_at=datetime('now') WHERE id IN
      (SELECT session_id FROM device_session_links WHERE device_id=?) AND revoked_at IS NULL`).run(deviceId);
    db.prepare("UPDATE device_challenges SET consumed_at=datetime('now') WHERE device_id=? AND consumed_at IS NULL").run(deviceId);
  })();
  audit(userId, username, 'trusted_device_revoked', deviceId, ip);
}

export { DeviceInputError };
