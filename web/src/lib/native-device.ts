// One browser-side facade over Electron's async IPC bridge and Android's
// synchronous JavascriptInterface. Pairing/authentication always proves
// possession of an OS-keystore private key; the private key is never exposed.

export interface NativeIdentity {
  algorithm: 'Ed25519' | 'ES256';
  publicKey: string;
  fingerprint: string;
  deviceId?: string | null;
  name?: string;
  type?: string;
  capabilities?: string[];
  persistent?: boolean;
}

type DeviceSession = { token: string; expiresAt: string; user?: any; device?: any };

const desktop = () => (window as any).aerieNativeDevice;
const android = () => (window as any).CloudBoxNative;

export function hasNativeDeviceIdentity() {
  return !!desktop()?.identity || !!android()?.deviceIdentity;
}

export async function nativeIdentity(): Promise<NativeIdentity | null> {
  try {
    if (desktop()?.identity) return await desktop().identity();
    if (android()?.deviceIdentity) {
      const value = android().deviceIdentity();
      return typeof value === 'string' ? JSON.parse(value) : value;
    }
  } catch { /* unsupported native build */ }
  return null;
}

async function post(path: string, body: any) {
  const response = await fetch(path, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  let result: any = null;
  try { result = await response.json(); } catch { /* mapped below */ }
  if (!response.ok) throw new Error(result?.error || `device_pairing_${response.status}`);
  return result;
}

async function sign(payload: string) {
  if (desktop()?.sign) return desktop().sign(payload);
  if (android()?.signDeviceChallenge) return android().signDeviceChallenge(payload);
  throw new Error('native_device_unavailable');
}

async function register(id: string) {
  if (desktop()?.register) return desktop().register(id);
  if (android()?.registerTrustedDevice) return android().registerTrustedDevice(id);
  return false;
}

async function accept(result: DeviceSession, deviceId?: string) {
  if (!result?.token || !result?.expiresAt) throw new Error('invalid_device_session');
  if (deviceId) await register(deviceId);
  if (desktop()?.storeToken) await desktop().storeToken(result.token, result.expiresAt);
  // Android persists through setToken -> CloudBoxNative.authToken, keeping one
  // credential path for WebView, background sync and Android Auto.
  return result;
}

export async function pairCurrentNativeDevice(code: string, preferredName?: string): Promise<DeviceSession> {
  if (desktop()?.pair) return desktop().pair(code, preferredName || 'Aerie Desktop');
  const identity = await nativeIdentity();
  if (!identity) throw new Error('native_device_unavailable');
  const claimed = await post('/api/device-pairing/claim', {
    code,
    name: preferredName || identity.name || 'Aerie Android',
    type: identity.type || 'android',
    capabilities: identity.capabilities || ['sync', 'handoff', 'media-session', 'secure-storage'],
    publicKey: identity.publicKey,
    algorithm: identity.algorithm,
  });
  const signature = await sign(claimed.signingPayload);
  const completed = await post('/api/device-pairing/complete', {
    pairingId: claimed.pairingId, deviceId: claimed.deviceId,
    challengeId: claimed.challengeId, signature,
  });
  return accept(completed, claimed.deviceId);
}

let refreshing: Promise<DeviceSession | null> | null = null;
export function refreshNativeAccess(): Promise<DeviceSession | null> {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    try {
      if (desktop()?.authenticate) return await desktop().authenticate();
      const identity = await nativeIdentity();
      if (!identity?.deviceId) return null;
      const challenge = await post('/api/device-pairing/challenge', { deviceId: identity.deviceId });
      const signature = await sign(challenge.signingPayload);
      const result = await post('/api/device-pairing/authenticate', {
        deviceId: identity.deviceId, challengeId: challenge.challengeId, signature,
      });
      return accept(result);
    } catch { return null; }
    finally { refreshing = null; }
  })();
  return refreshing;
}
