import { Router } from 'express';
import { login, authMiddleware, csrfProtection, findUserById, verifyAccountToken, type AuthedRequest } from '../lib/auth.js';
import { audit, db } from '../lib/db.js';
import { acceptInvite, inspectInvite } from '../services/user-invites.js';
import { config } from '../config.js';

const r = Router();
const loginAttempts = new Map<string, { failures: number; blockedUntil: number; lastAt: number }>();
const ipLoginAttempts = new Map<string, { failures: number; blockedUntil: number; lastAt: number }>();
const MAX_ATTEMPT_KEYS = 10_000;

function clientIp(req: any): string { return String(req.ip || req.socket?.remoteAddress || 'unknown').slice(0, 100); }
function attemptKey(req: any, username: unknown): string {
  return `${clientIp(req)}:${String(username || '').trim().toLowerCase().slice(0, 80)}`;
}
function loginBlock(attempts: typeof loginAttempts, key: string): number {
  const entry = attempts.get(key);
  if (!entry) return 0;
  if (Date.now() - entry.lastAt > 24 * 3600_000) { attempts.delete(key); return 0; }
  return Math.max(0, entry.blockedUntil - Date.now());
}
function trimAttempts(attempts: typeof loginAttempts) {
  const cutoff = Date.now() - 24 * 3600_000;
  for (const [key, value] of attempts) if (value.lastAt < cutoff) attempts.delete(key);
  while (attempts.size > MAX_ATTEMPT_KEYS) {
    let oldestKey: string | undefined;
    let oldestAt = Infinity;
    for (const [key, value] of attempts) {
      if (value.lastAt < oldestAt) { oldestAt = value.lastAt; oldestKey = key; }
    }
    if (oldestKey === undefined) break;
    attempts.delete(oldestKey);
  }
}
function recordFailure(attempts: typeof loginAttempts, key: string, threshold: number) {
  const previous = attempts.get(key);
  const failures = (previous?.failures || 0) + 1;
  const delay = failures < threshold ? 0 : Math.min(15 * 60_000, 2 ** Math.min(12, failures - threshold) * 2_000);
  attempts.set(key, { failures, blockedUntil: Date.now() + delay, lastAt: Date.now() });
  if (attempts.size > MAX_ATTEMPT_KEYS) trimAttempts(attempts);
}
function recordLoginFailure(accountKey: string, ipKey: string) {
  // The account key slows targeted guessing; the IP key also stops an attacker
  // spraying one guess across an unbounded number of usernames.
  recordFailure(loginAttempts, accountKey, 5);
  recordFailure(ipLoginAttempts, ipKey, 25);
}
function recordLoginSuccess(accountKey: string, ipKey: string) {
  loginAttempts.delete(accountKey);
  const ipEntry = ipLoginAttempts.get(ipKey);
  if (!ipEntry) return;
  const failures = Math.max(0, ipEntry.failures - 2);
  if (!failures) ipLoginAttempts.delete(ipKey);
  else ipLoginAttempts.set(ipKey, { failures, blockedUntil: 0, lastAt: Date.now() });
}
function secureRequest(req: any): boolean {
  // Express only accepts X-Forwarded-Proto when TRUST_PROXY is explicitly
  // configured. Reading the raw header here would let any direct client spoof
  // the cookie security decision.
  return !!req.secure;
}
function cookieOptions(req: any, maxAge?: number) {
  return { httpOnly: true, secure: secureRequest(req), sameSite: 'lax' as const, path: '/', ...(maxAge ? { maxAge } : {}) };
}

function sameOriginPublicWrite(req: any, res: any, next: any) {
  const origin = req.get('origin');
  if (!origin) return next();
  let normalized: string;
  try { normalized = new URL(origin).origin; }
  catch { return res.status(403).json({ error: 'csrf_origin_invalid' }); }
  const allowed = new Set([`${req.protocol}://${req.get('host')}`]);
  for (const value of [config.publicUrl, config.lanUrl]) {
    try { if (value) allowed.add(new URL(value).origin); } catch { /* invalid configuration grants nothing */ }
  }
  if (!allowed.has(normalized)) return res.status(403).json({ error: 'csrf_origin_denied' });
  next();
}

function requireJsonPublicWrite(req: any, res: any, next: any) {
  // A browser can submit application/x-www-form-urlencoded or multipart forms
  // cross-origin without a CORS preflight. Login accepts JSON only so a hostile
  // page cannot replace a victim's Aerie cookie with the attacker's session.
  if (!req.is?.('application/json')) {
    return res.status(415).json({ error: 'content_type_must_be_json' });
  }
  next();
}

r.get('/invite/:token', (req, res, next) => {
  try {
    res.setHeader('Cache-Control', 'no-store');
    res.json(inspectInvite(req.params.token));
  } catch (error) { next(error); }
});

r.post('/invite/:token/accept', sameOriginPublicWrite, async (req, res, next) => {
  try {
    const created = await acceptInvite(req.params.token, req.body || {});
    audit(created.id, created.username, 'household_invite_accepted', undefined, clientIp(req));
    res.status(201).json(created);
  } catch (error) { next(error); }
});

r.post('/login', sameOriginPublicWrite, requireJsonPublicWrite, async (req, res, next) => {
  try {
  const { username, password, code, deviceName, deviceType } = req.body || {};
  const key = attemptKey(req, username);
  const ip = clientIp(req);
  const wait = Math.max(loginBlock(loginAttempts, key), loginBlock(ipLoginAttempts, ip));
  if (wait > 0) {
    res.setHeader('Retry-After', String(Math.ceil(wait / 1000)));
    return res.status(429).json({ error: 'login_rate_limited', retryAfterSeconds: Math.ceil(wait / 1000) });
  }
  const result = await login(String(username || ''), String(password || ''), ip, code ? String(code) : undefined, {
    name: String(deviceName || 'Web browser'), type: String(deviceType || 'web'), userAgent: req.get('user-agent') || '',
  });
  if (!result) { recordLoginFailure(key, ip); return res.status(401).json({ error: 'invalid_credentials' }); }
  if ('needs2fa' in result) return res.status(200).json({ needs2fa: true });
  recordLoginSuccess(key, ip);
  res.cookie('cb_token', result.token, cookieOptions(req, result.ttlMs));
  res.setHeader('Cache-Control', 'no-store');
  res.json(result);
  } catch (error) { next(error); }
});

// Re-establish the httpOnly session cookie on this origin. The native app hops
// between the cloud and LAN origins carrying only the JWT; plain <img> requests
// (movie/series posters) authenticate by cookie, which login only set on the
// origin the user originally logged in on.
// Bearer header ONLY — accepting the token from the body/query would let a
// cross-site auto-submitted form fixate an attacker's session cookie (a
// custom header forces a CORS preflight, which blocks that vector).
r.post('/cookie', (req, res) => {
  const header = req.headers.authorization;
  const token = header?.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token) return res.status(401).json({ error: 'unauthorized' });
  try {
    const payload = verifyAccountToken(token);
    if (!findUserById(payload.id)) return res.status(401).json({ error: 'unauthorized' });
    if (payload.sid && !db.prepare(`SELECT 1 FROM auth_sessions WHERE id=? AND user_id=? AND revoked_at IS NULL
      AND datetime(expires_at)>datetime('now')`).get(payload.sid, payload.id)) return res.status(401).json({ error: 'session_revoked' });
    const remaining = payload.exp ? Math.max(60_000, payload.exp * 1000 - Date.now()) : 24 * 3600_000;
    res.cookie('cb_token', token, cookieOptions(req, remaining));
    res.json({ ok: true });
  } catch {
    res.status(401).json({ error: 'invalid_token' });
  }
});

r.post('/logout', authMiddleware, csrfProtection, (req: AuthedRequest, res) => {
  if (req.sessionId) db.prepare("UPDATE auth_sessions SET revoked_at=datetime('now') WHERE id=?").run(req.sessionId);
  res.clearCookie('cb_token', cookieOptions(req));
  res.json({ ok: true });
});

r.get('/me', authMiddleware, (req: AuthedRequest, res) => {
  res.json({ user: req.user });
});

r.get('/users', authMiddleware, (_req, res) => {
  // public-ish directory for share targets (no secrets)
  const rows = db.prepare(`SELECT id, username, display_name, avatar_color, avatar_version FROM users
    WHERE disabled_at IS NULL ORDER BY display_name COLLATE NOCASE,username COLLATE NOCASE`).all() as any[];
  res.json(rows.map(u => ({ id: u.id, username: u.username, displayName: u.display_name, avatarColor: u.avatar_color,
    avatarUrl: u.avatar_version ? `/api/settings/avatar/${u.id}?v=${u.avatar_version}` : null })));
});

export default r;
