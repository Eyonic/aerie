import { Router, type Request } from 'express';
import { type AuthedRequest } from '../lib/auth.js';
import { config } from '../config.js';
import {
  DeviceInputError,
  DeviceTrustError,
  authenticateDevice,
  cancelPairing,
  claimPairing,
  completePairing,
  createAuthenticationChallenge,
  createPairing,
  getPairing,
  listDevices,
  revokeDevice,
} from '../services/device-trust.js';

function clientIp(req: Request) {
  // Express deliberately ignores X-Forwarded-For until the operator enables a
  // trusted proxy. Reading that header directly would make throttling spoofable.
  return String(req.ip || '').slice(0, 100);
}

function handle(error: unknown, res: any) {
  if (error instanceof DeviceTrustError) return res.status(error.status).json({ error: error.code });
  if (error instanceof DeviceInputError) return res.status(400).json({ error: error.message });
  console.error('[device-trust]', error);
  return res.status(500).json({ error: 'device_trust_failed' });
}

// Small process-level guard complements the per-pairing attempt counter. Aerie
// is currently single-process; a reverse-proxy rate limit should still protect
// this public endpoint in larger deployments.
const claimsByIp = new Map<string, { since: number; count: number }>();
function allowPublicAttempt(req: Request) {
  const key = clientIp(req) || 'unknown';
  const now = Date.now();
  const current = claimsByIp.get(key);
  if (!current || now - current.since > 60_000) {
    if (claimsByIp.size > 10_000) {
      for (const [ip, entry] of claimsByIp) if (now - entry.since > 60_000) claimsByIp.delete(ip);
    }
    claimsByIp.set(key, { since: now, count: 1 });
    return true;
  }
  current.count++;
  return current.count <= 20;
}

export const publicDevicePairingRouter = Router();
publicDevicePairingRouter.use((_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
});

publicDevicePairingRouter.post('/claim', (req, res) => {
  if (!allowPublicAttempt(req)) return res.status(429).json({ error: 'too_many_attempts' });
  try { res.json(claimPairing(req.body)); }
  catch (error) { handle(error, res); }
});

publicDevicePairingRouter.post('/complete', (req, res) => {
  if (!allowPublicAttempt(req)) return res.status(429).json({ error: 'too_many_attempts' });
  try { res.json(completePairing(req.body, clientIp(req), req.get('user-agent') || '')); }
  catch (error) { handle(error, res); }
});

publicDevicePairingRouter.post('/challenge', (req, res) => {
  if (!allowPublicAttempt(req)) return res.status(429).json({ error: 'too_many_attempts' });
  try { res.json(createAuthenticationChallenge(req.body?.deviceId)); }
  catch (error) { handle(error, res); }
});

publicDevicePairingRouter.post('/authenticate', (req, res) => {
  if (!allowPublicAttempt(req)) return res.status(429).json({ error: 'too_many_attempts' });
  try { res.json(authenticateDevice(req.body, clientIp(req), req.get('user-agent') || '')); }
  catch (error) { handle(error, res); }
});

// Mount this router after the normal auth middleware.
const deviceTrustRouter = Router();

deviceTrustRouter.post('/pairings', (req: AuthedRequest, res) => {
  try {
    const pairing = createPairing(req.user!.id, req.sessionId, req.body);
    const configured = configOrigin(req);
    const params = new URLSearchParams({ server: configured, pairing: pairing.id, code: pairing.code });
    res.status(201).json({ ...pairing, qrPayload: `aerie://pair?${params.toString()}` });
  } catch (error) { handle(error, res); }
});

deviceTrustRouter.get('/pairings/:id', (req: AuthedRequest, res) => {
  try { res.json(getPairing(req.user!.id, String(req.params.id))); }
  catch (error) { handle(error, res); }
});

deviceTrustRouter.delete('/pairings/:id', (req: AuthedRequest, res) => {
  try { cancelPairing(req.user!.id, String(req.params.id)); res.json({ ok: true }); }
  catch (error) { handle(error, res); }
});

deviceTrustRouter.get('/', (req: AuthedRequest, res) => {
  try { res.json(listDevices(req.user!.id, req.sessionId, req.query.includeRevoked === '1')); }
  catch (error) { handle(error, res); }
});

deviceTrustRouter.delete('/:id', (req: AuthedRequest, res) => {
  try {
    revokeDevice(req.user!.id, String(req.params.id), req.user!.username, clientIp(req));
    res.json({ ok: true });
  } catch (error) { handle(error, res); }
});

function configOrigin(req: Request) {
  const candidate = String(config.publicUrl || `${req.protocol}://${req.get('host') || ''}`).replace(/\/+$/, '');
  try {
    const url = new URL(candidate);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error();
    return url.origin;
  } catch {
    return '';
  }
}

export default deviceTrustRouter;
