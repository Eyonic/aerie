import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { mock } from 'node:test';
import { DatabaseSync } from 'node:sqlite';

const sandbox = await fsp.mkdtemp(path.join(os.tmpdir(), 'aerie-device-trust-'));
process.env.DATA_DIR = path.join(sandbox, 'data');
process.env.FILES_ROOT = path.join(sandbox, 'files');
process.env.JWT_SECRET = 'device-trust-integration-secret';

const sqlite = new DatabaseSync(path.join(sandbox, 'device-trust.db'));
sqlite.exec(`
  PRAGMA foreign_keys=ON;
  CREATE TABLE users (
    id INTEGER PRIMARY KEY,
    username TEXT NOT NULL,
    display_name TEXT NOT NULL,
    email TEXT,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL,
    avatar_color TEXT NOT NULL,
    avatar_version INTEGER NOT NULL DEFAULT 0,
    storage_quota_bytes INTEGER,
    ai_mode TEXT NOT NULL,
    disabled_at TEXT,
    features TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE auth_sessions (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    device_name TEXT NOT NULL,
    device_type TEXT NOT NULL,
    ip TEXT,
    user_agent TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_seen TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at TEXT NOT NULL,
    revoked_at TEXT
  );
  CREATE TABLE audit (action TEXT, target TEXT);
  INSERT INTO users (id,username,display_name,password_hash,role,avatar_color,ai_mode)
    VALUES (1,'admin','Admin','unused','admin','#6366f1','local_only');
`);

const testDb = {
  exec: (sql: string) => sqlite.exec(sql),
  prepare: (sql: string) => sqlite.prepare(sql),
  transaction: (operation: (...args: any[]) => any) => (...args: any[]) => {
    sqlite.exec('BEGIN IMMEDIATE');
    try { const result = operation(...args); sqlite.exec('COMMIT'); return result; }
    catch (error) { sqlite.exec('ROLLBACK'); throw error; }
  },
};
const { AERIE_MIGRATIONS } = await import('../src/lib/migrations.js');
AERIE_MIGRATIONS[6].up(testDb);
mock.module(new URL('../src/lib/db.js', import.meta.url).href, {
  namedExports: { db: testDb, audit: () => undefined },
});
const trust = await import('../src/services/device-trust.js');

test.after(async () => {
  sqlite.close();
  mock.reset();
  await fsp.rm(sandbox, { recursive: true, force: true });
});

test('pairs, proves possession, rotates a session, and revokes a trusted device', () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const encoded = publicKey.export({ format: 'der', type: 'spki' }).toString('base64url');

  const pairing = trust.createPairing(1, undefined, {
    name: 'Test desktop', type: 'desktop', capabilities: ['sync', 'secure-storage'],
  });
  assert.match(pairing.code, /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);

  const claim = trust.claimPairing({
    code: pairing.code,
    name: 'Test desktop',
    type: 'desktop',
    capabilities: ['sync', 'secure-storage'],
    publicKey: encoded,
    algorithm: 'Ed25519',
  });
  const firstSignature = crypto.sign(null, Buffer.from(claim.signingPayload), privateKey).toString('base64url');
  const completed = trust.completePairing({ ...claim, signature: firstSignature }, '127.0.0.1', 'test');
  assert.equal(completed.device.id, claim.deviceId);
  assert.equal(completed.device.fingerprint.length, 43);
  assert.equal(typeof completed.token, 'string');
  assert.deepEqual(trust.listDevices(1).map(device => device.id), [claim.deviceId]);

  const challenge = trust.createAuthenticationChallenge(claim.deviceId);
  const signature = crypto.sign(null, Buffer.from(challenge.signingPayload), privateKey).toString('base64url');
  const authenticated = trust.authenticateDevice({ ...challenge, signature }, '127.0.0.1', 'test');
  assert.equal(authenticated.device.id, claim.deviceId);
  assert.notEqual(authenticated.token, completed.token);

  trust.revokeDevice(1, claim.deviceId, 'admin', '127.0.0.1');
  assert.deepEqual(trust.listDevices(1), []);
  assert.throws(() => trust.createAuthenticationChallenge(claim.deviceId), /device_not_found/);
});

test('rejects replayed proofs and a second key claiming the same code', () => {
  const first = crypto.generateKeyPairSync('ed25519');
  const second = crypto.generateKeyPairSync('ed25519');
  const publicKey = first.publicKey.export({ format: 'der', type: 'spki' }).toString('base64url');
  const pairing = trust.createPairing(1, undefined, { name: 'Phone', type: 'android', capabilities: ['sync'] });
  const claim = trust.claimPairing({ code: pairing.code, publicKey, algorithm: 'Ed25519' });

  assert.throws(() => trust.claimPairing({
    code: pairing.code,
    publicKey: second.publicKey.export({ format: 'der', type: 'spki' }).toString('base64url'),
    algorithm: 'Ed25519',
  }), /pairing_already_claimed/);

  const signature = crypto.sign(null, Buffer.from(claim.signingPayload), first.privateKey).toString('base64url');
  trust.completePairing({ ...claim, signature });
  assert.throws(() => trust.completePairing({ ...claim, signature }), /invalid_or_expired_challenge/);
});
