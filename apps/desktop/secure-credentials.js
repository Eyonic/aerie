// Native credentials for Aerie Desktop. Private keys and short-lived access
// tokens are encrypted with Electron safeStorage (Keychain/DPAPI/libsecret).
// Each server origin gets a different keypair, preventing cross-server device
// correlation. If no OS-backed encryption is available, credentials remain in
// memory for the current run and the existing password-login flow still works.
const { app, safeStorage } = require('electron');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { normalizeOrigin } = require('./server-url');
const { readBoundedJson } = require('./bounded-json');

const STATE_VERSION = 1;
const PROOF_RE = /^aerie-device-proof:v1:(pair|authenticate):[A-Za-z0-9_-]{3,100}:[A-Za-z0-9_-]{16,100}:device_[A-Za-z0-9_-]{20,64}$/;

function createNativeCredentialStore(options = {}) {
  const storage = options.safeStorage || safeStorage;
  const statePath = options.statePath || path.join(app.getPath('userData'), 'native-credentials.json');
  const memory = new Map();

  function selectedBackend() {
    try {
      return typeof storage.getSelectedStorageBackend === 'function'
        ? storage.getSelectedStorageBackend() : 'os';
    } catch { return 'os'; }
  }

  function encryptionAvailable() {
    try {
      // Electron's Linux "basic_text" fallback uses a hard-coded password. It
      // obfuscates rather than protects credentials, so prefer memory-only mode.
      return !!storage.isEncryptionAvailable() && selectedBackend() !== 'basic_text';
    } catch { return false; }
  }

  function securityInfo() {
    const backend = selectedBackend();
    const available = encryptionAvailable();
    return { encryptionAvailable: available, backend, persistent: available };
  }

  function loadState() {
    try {
      const parsed = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      if (parsed && parsed.version === STATE_VERSION && parsed.profiles && typeof parsed.profiles === 'object') return parsed;
    } catch { /* first run or invalid legacy file */ }
    return { version: STATE_VERSION, profiles: {} };
  }

  function saveState(state) {
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    const tmp = `${statePath}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
    try { fs.chmodSync(tmp, 0o600); } catch { /* Windows ACLs are handled by userData */ }
    fs.renameSync(tmp, statePath);
  }

  function encrypt(value) {
    if (!encryptionAvailable()) throw new Error('secure_storage_unavailable');
    return storage.encryptString(value).toString('base64');
  }

  function decrypt(value) {
    if (!encryptionAvailable() || typeof value !== 'string') return null;
    try { return storage.decryptString(Buffer.from(value, 'base64')); } catch { return null; }
  }

  function createIdentity() {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const publicKeyDer = publicKey.export({ format: 'der', type: 'spki' });
    return {
      algorithm: 'Ed25519',
      publicKey: publicKeyDer.toString('base64url'),
      fingerprint: crypto.createHash('sha256').update(publicKeyDer).digest('base64url'),
      privateKey: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
    };
  }

  function getOrCreateIdentity(serverOrigin) {
    const origin = normalizeOrigin(serverOrigin);
    const state = loadState();
    let profile = state.profiles[origin];
    let privatePem = profile && decrypt(profile.privateKey);
    if (!privatePem) {
      const ephemeral = memory.get(origin);
      if (ephemeral) return { ...ephemeral.public, persistent: false, deviceId: ephemeral.deviceId || null };
      const generated = createIdentity();
      if (encryptionAvailable()) {
        profile = {
          algorithm: generated.algorithm,
          publicKey: generated.publicKey,
          fingerprint: generated.fingerprint,
          privateKey: encrypt(generated.privateKey),
          deviceId: null,
          createdAt: new Date().toISOString(),
        };
        state.profiles[origin] = profile;
        saveState(state);
        privatePem = generated.privateKey;
      } else {
        const pub = { algorithm: generated.algorithm, publicKey: generated.publicKey, fingerprint: generated.fingerprint };
        memory.set(origin, { public: pub, privateKey: generated.privateKey, deviceId: null,
          accessToken: null, authSuspended: false });
        return { ...pub, persistent: false, deviceId: null };
      }
    }
    return {
      algorithm: profile.algorithm,
      publicKey: profile.publicKey,
      fingerprint: profile.fingerprint,
      deviceId: profile.deviceId || null,
      persistent: true,
    };
  }

  function sign(serverOrigin, payload) {
    const origin = normalizeOrigin(serverOrigin);
    const value = String(payload || '');
    if (value.length > 512 || !PROOF_RE.test(value)) throw new Error('invalid_device_challenge');
    getOrCreateIdentity(origin);
    const state = loadState();
    const profile = state.profiles[origin];
    const privatePem = profile ? decrypt(profile.privateKey) : memory.get(origin)?.privateKey;
    if (!privatePem) throw new Error('device_identity_unavailable');
    return crypto.sign(null, Buffer.from(value, 'utf8'), crypto.createPrivateKey(privatePem)).toString('base64url');
  }

  function registerDevice(serverOrigin, deviceId) {
    const origin = normalizeOrigin(serverOrigin);
    const id = String(deviceId || '');
    if (!/^device_[A-Za-z0-9_-]{20,64}$/.test(id)) throw new Error('invalid_device_id');
    getOrCreateIdentity(origin);
    const state = loadState();
    if (state.profiles[origin]) {
      state.profiles[origin].deviceId = id;
      state.profiles[origin].registeredAt = new Date().toISOString();
      saveState(state);
    } else {
      const item = memory.get(origin);
      if (item) item.deviceId = id;
    }
    return true;
  }

  function storeAccessToken(serverOrigin, token, expiresAt) {
    const origin = normalizeOrigin(serverOrigin);
    const value = String(token || '');
    if (!value) return clearAccessToken(origin);
    if (value.length > 8192) throw new Error('invalid_access_token');
    const expiry = new Date(String(expiresAt || ''));
    if (!Number.isFinite(expiry.getTime())) throw new Error('invalid_token_expiry');
    if (encryptionAvailable()) {
      getOrCreateIdentity(origin);
      const state = loadState();
      state.profiles[origin].accessToken = encrypt(value);
      state.profiles[origin].accessTokenExpiresAt = expiry.toISOString();
      state.profiles[origin].authSuspended = false;
      saveState(state);
      return { persistent: true };
    }
    getOrCreateIdentity(origin);
    const item = memory.get(origin);
    if (item) {
      item.accessToken = { value, expiresAt: expiry.toISOString() };
      item.authSuspended = false;
    }
    return { persistent: false };
  }

  function loadAccessToken(serverOrigin) {
    const origin = normalizeOrigin(serverOrigin);
    const state = loadState();
    const profile = state.profiles[origin];
    if (profile?.authSuspended) return null;
    if (profile?.accessToken && new Date(profile.accessTokenExpiresAt || 0).getTime() > Date.now()) {
      const token = decrypt(profile.accessToken);
      if (token) return { token, expiresAt: profile.accessTokenExpiresAt };
    }
    const memoryProfile = memory.get(origin);
    if (memoryProfile?.authSuspended) return null;
    const item = memoryProfile?.accessToken;
    return item && new Date(item.expiresAt).getTime() > Date.now() ? { token: item.value, expiresAt: item.expiresAt } : null;
  }

  function clearAccessToken(serverOrigin) {
    const origin = normalizeOrigin(serverOrigin);
    const state = loadState();
    if (state.profiles[origin]) {
      delete state.profiles[origin].accessToken;
      delete state.profiles[origin].accessTokenExpiresAt;
      state.profiles[origin].authSuspended = true;
      saveState(state);
    }
    const item = memory.get(origin);
    if (item) { item.accessToken = null; item.authSuspended = true; }
    return true;
  }

  // One-time migration hook for the sync engine. Call this before sync.js reads
  // sync.json, then provide loadAccessToken() to the engine as its credential
  // provider. It deliberately does nothing when OS encryption is unavailable.
  function migrateLegacyToken(serverOrigin, legacyPath) {
    if (!encryptionAvailable()) return { migrated: false, reason: 'secure_storage_unavailable' };
    let legacy;
    try { legacy = JSON.parse(fs.readFileSync(legacyPath, 'utf8')); }
    catch { return { migrated: false, reason: 'not_found' }; }
    if (!legacy || typeof legacy.token !== 'string' || !legacy.token) return { migrated: false, reason: 'no_token' };
    let expiry = Date.now() + 15 * 60_000;
    try {
      const payload = JSON.parse(Buffer.from(legacy.token.split('.')[1], 'base64url').toString('utf8'));
      if (Number.isFinite(payload.exp) && payload.exp * 1000 > Date.now()) expiry = payload.exp * 1000;
    } catch { /* opaque legacy credential gets the conservative window */ }
    storeAccessToken(serverOrigin, legacy.token, new Date(expiry).toISOString());
    delete legacy.token;
    const tmp = `${legacyPath}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(legacy, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, legacyPath);
    return { migrated: true };
  }

  async function post(serverOrigin, pathname, body) {
    const origin = normalizeOrigin(serverOrigin);
    const response = await fetch(origin + pathname, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
    });
    let result = null;
    try { result = await readBoundedJson(response, { maxBytes: 64 * 1024, idleMs: 5000 }); } catch { /* mapped below */ }
    if (!response.ok) throw new Error(result?.error || `device_pairing_http_${response.status}`);
    if (!result || typeof result !== 'object') throw new Error('invalid_device_pairing_response');
    return result;
  }

  function acceptSession(origin, result) {
    if (typeof result.token !== 'string' || result.token.length < 20 || result.token.length > 8192) {
      throw new Error('invalid_device_session');
    }
    const expiry = new Date(result.expiresAt || 0);
    if (!Number.isFinite(expiry.getTime()) || expiry.getTime() <= Date.now()) throw new Error('invalid_device_session');
    storeAccessToken(origin, result.token, expiry.toISOString());
    return { token: result.token, expiresAt: expiry.toISOString(), user: result.user, device: result.device };
  }

  async function pairWithCode(serverOrigin, code, metadata = {}) {
    const origin = normalizeOrigin(serverOrigin);
    const identity = getOrCreateIdentity(origin);
    const name = String(metadata.name || require('node:os').hostname() || 'Aerie Desktop').slice(0, 100);
    const claimed = await post(origin, '/api/device-pairing/claim', {
      code: String(code || ''),
      name,
      type: 'desktop',
      capabilities: ['sync', 'handoff', 'secure-storage'],
      publicKey: identity.publicKey,
      algorithm: identity.algorithm,
    });
    const signature = sign(origin, claimed.signingPayload);
    const completed = await post(origin, '/api/device-pairing/complete', {
      pairingId: claimed.pairingId,
      deviceId: claimed.deviceId,
      challengeId: claimed.challengeId,
      signature,
    });
    registerDevice(origin, claimed.deviceId);
    return acceptSession(origin, completed);
  }

  async function authenticate(serverOrigin) {
    const origin = normalizeOrigin(serverOrigin);
    if (loadState().profiles[origin]?.authSuspended || memory.get(origin)?.authSuspended) {
      throw new Error('device_auth_suspended');
    }
    const identity = getOrCreateIdentity(origin);
    if (!identity.deviceId) throw new Error('device_not_paired');
    const challenge = await post(origin, '/api/device-pairing/challenge', { deviceId: identity.deviceId });
    const signature = sign(origin, challenge.signingPayload);
    const result = await post(origin, '/api/device-pairing/authenticate', {
      deviceId: identity.deviceId,
      challengeId: challenge.challengeId,
      signature,
    });
    return acceptSession(origin, result);
  }

  return {
    securityInfo,
    getOrCreateIdentity,
    sign,
    registerDevice,
    storeAccessToken,
    loadAccessToken,
    clearAccessToken,
    migrateLegacyToken,
    pairWithCode,
    authenticate,
  };
}

module.exports = { createNativeCredentialStore, normalizeOrigin };
