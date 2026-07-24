// JWT auth: login, middleware, and user serialization.
import jwt from 'jsonwebtoken';
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import type { Request, Response, NextFunction } from 'express';
import { config } from '../config.js';
import { db, audit } from './db.js';
import * as totp from '../services/totp.js';
import type { User } from './model.js';
import { isSealed, seal, unseal } from '../services/secrets.js';

export interface AuthedRequest extends Request {
  user?: User;
  sessionId?: string;
  authMethod?: 'bearer' | 'cookie';
}

export type FeatureKey = Exclude<keyof NonNullable<User['features']>, 'autoRequest'>;
const FEATURE_KEYS: FeatureKey[] = ['files', 'photos', 'videos', 'movies', 'tv', 'music', 'audiobooks', 'requests', 'create', 'ai', 'sync'];
// Missing accounts still perform the same expensive password check, making
// username discovery through response timing materially harder. This one hash
// is created only at process startup, never in a request path.
const MISSING_ACCOUNT_HASH = bcrypt.hashSync(crypto.randomBytes(32).toString('hex'), 12);

function parseFeatures(raw: any): User['features'] {
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw || '{}') : raw;
    if (!parsed || typeof parsed !== 'object') return {};
    const out: User['features'] = {};
    for (const key of FEATURE_KEYS) if (typeof parsed[key] === 'boolean') out[key] = parsed[key];
    if (typeof parsed.autoRequest === 'boolean') out.autoRequest = parsed.autoRequest;
    return out;
  } catch {
    return {};
  }
}

export function rowToUser(r: any): User {
  return {
    id: r.id,
    username: r.username,
    displayName: r.display_name,
    email: r.email,
    role: r.role,
    avatarColor: r.avatar_color,
    avatarUrl: r.avatar_version ? `/api/settings/avatar/${r.id}?v=${r.avatar_version}` : null,
    storageQuotaBytes: r.storage_quota_bytes,
    aiMode: r.ai_mode,
    features: parseFeatures(r.features),
    disabledAt: r.disabled_at || null,
    createdAt: r.created_at,
  };
}

export function findUser(username: string): any {
  return db.prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE AND disabled_at IS NULL').get(username);
}
export function findUserById(id: number): any {
  return db.prepare('SELECT * FROM users WHERE id = ? AND disabled_at IS NULL').get(id);
}

export function verifyAccountToken(token: string): any {
  try { return jwt.verify(token, config.jwtSecret, { audience: 'aerie-account' }) as any; }
  catch (error: any) {
    // One release-cycle migration path for account JWTs issued before the
    // audience claim existed. Tokens with a different explicit audience are
    // never accepted through this fallback.
    const payload = jwt.verify(token, config.jwtSecret) as any;
    if (payload?.aud && payload.aud !== 'aerie-account') throw error;
    return payload;
  }
}

export async function login(username: string, password: string, ip?: string, code?: string,
  device?: { name?: string; type?: string; userAgent?: string }):
  Promise<{ token: string; user: User; expiresAt: string; ttlMs: number } | { needs2fa: true } | null> {
  const row = findUser(username);
  const passwordOk = await bcrypt.compare(password, row?.password_hash || MISSING_ACCOUNT_HASH);
  if (!row || !passwordOk) {
    audit(row?.id ?? null, username, 'login_failure', undefined, ip);
    return null;
  }
  // Second factor (authenticator app), only if the user enabled it.
  if (row.totp_enabled && row.totp_secret) {
    if (!code) return { needs2fa: true };
    let secret: string;
    try {
      secret = unseal(row.totp_secret, `totp:${row.id}`);
      if (!isSealed(row.totp_secret)) db.prepare('UPDATE users SET totp_secret=? WHERE id=?').run(seal(secret, `totp:${row.id}`), row.id);
    } catch {
      audit(row.id, username, 'login_2fa_secret_error', undefined, ip);
      return null;
    }
    let verified = totp.verify(secret, code);
    if (!verified) {
      const normalized = String(code).toUpperCase().replace(/[^A-Z0-9]/g, '');
      const hash = crypto.createHash('sha256').update(normalized).digest('hex');
      let recovery: string[] = [];
      try { recovery = JSON.parse(row.totp_recovery_codes || '[]'); } catch { /* invalid legacy value */ }
      const index = recovery.indexOf(hash);
      if (index >= 0) {
        recovery.splice(index, 1);
        db.prepare('UPDATE users SET totp_recovery_codes=? WHERE id=?').run(JSON.stringify(recovery), row.id);
        audit(row.id, username, 'login_2fa_recovery_used', undefined, ip, { remaining: recovery.length });
        verified = true;
      }
    }
    if (!verified) { audit(row.id, username, 'login_2fa_failure', undefined, ip); return null; }
  }
  const user = rowToUser(row);
  const sid = crypto.randomUUID();
  const native = ['android', 'ios', 'desktop', 'native'].includes(String(device?.type || '').toLowerCase());
  const ttlMs = (native ? 30 : 7) * 864e5;
  const expires = new Date(Date.now() + ttlMs).toISOString();
  db.prepare(`INSERT INTO auth_sessions (id,user_id,device_name,device_type,ip,user_agent,expires_at)
    VALUES (?,?,?,?,?,?,?)`).run(sid, user.id, String(device?.name || 'Web browser').slice(0, 100),
      String(device?.type || 'web').slice(0, 30), ip || null, String(device?.userAgent || '').slice(0, 500), expires);
  const token = jwt.sign({ id: user.id, username: user.username, role: user.role, sid }, config.jwtSecret,
    { expiresIn: native ? '30d' : '7d', audience: 'aerie-account' });
  audit(user.id, user.username, 'login_success', undefined, ip);
  return { token, user, expiresAt: expires, ttlMs };
}

export function authMiddleware(req: AuthedRequest, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  const bearer = header?.startsWith('Bearer ') ? header.slice(7) : null;
  const cookie = req.cookies?.cb_token as string | undefined;
  const token = bearer || cookie;
  if (!token) return res.status(401).json({ error: 'unauthorized' });
  try {
    const payload = verifyAccountToken(token);
    const row = findUserById(payload.id);
    if (!row) return res.status(401).json({ error: 'unauthorized' });
    if (!payload.sid) {
      // Adopt pre-upgrade JWTs into the session table using a one-way token
      // fingerprint. They become visible and revocable without signing everyone
      // out during the deployment.
      const legacyId = `legacy_${crypto.createHash('sha256').update(token).digest('hex').slice(0, 32)}`;
      const old = db.prepare('SELECT revoked_at FROM auth_sessions WHERE id=?').get(legacyId) as any;
      if (!old) db.prepare(`INSERT INTO auth_sessions (id,user_id,device_name,device_type,ip,user_agent,expires_at)
        VALUES (?,?,?,?,?,?,?)`).run(legacyId, payload.id, 'Existing browser session', 'web', req.ip || null,
          String(req.get('user-agent') || '').slice(0, 500), new Date((payload.exp || Math.floor(Date.now() / 1000) + 86400) * 1000).toISOString());
      else if (old.revoked_at) return res.status(401).json({ error: 'session_revoked' });
      payload.sid = legacyId;
    }
    if (payload.sid) {
      const session = db.prepare(`SELECT id,last_seen FROM auth_sessions
        WHERE id=? AND user_id=? AND revoked_at IS NULL AND datetime(expires_at)>datetime('now')`).get(payload.sid, payload.id) as any;
      if (!session) return res.status(401).json({ error: 'session_revoked' });
      req.sessionId = payload.sid;
      if (Date.now() - new Date(session.last_seen).getTime() > 5 * 60_000) {
        db.prepare("UPDATE auth_sessions SET last_seen=datetime('now') WHERE id=?").run(payload.sid);
      }
    }
    req.user = rowToUser(row);
    req.authMethod = bearer ? 'bearer' : 'cookie';
    next();
  } catch {
    return res.status(401).json({ error: 'invalid_token' });
  }
}

export function csrfProtection(req: AuthedRequest, res: Response, next: NextFunction) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method) || req.authMethod !== 'cookie') return next();
  const origin = req.get('origin');
  if (!origin) return res.status(403).json({ error: 'csrf_origin_required' });
  let normalized: string;
  try { normalized = new URL(origin).origin; } catch { return res.status(403).json({ error: 'csrf_origin_invalid' }); }
  const expected = `${req.protocol}://${req.get('host')}`;
  const allowed = new Set<string>([expected]);
  for (const value of [config.publicUrl, config.lanUrl]) {
    try { if (value) allowed.add(new URL(value).origin); } catch { /* invalid config is not an allowed origin */ }
  }
  if (!allowed.has(normalized)) return res.status(403).json({ error: 'csrf_origin_denied' });
  next();
}

export function featureEnabled(user: User | undefined, key: FeatureKey) {
  return user?.features?.[key] !== false;
}

export function requireFeature(key: FeatureKey) {
  return (req: AuthedRequest, res: Response, next: NextFunction) => {
    if (!featureEnabled(req.user, key)) return res.status(403).json({ error: 'feature_disabled', feature: key });
    next();
  };
}

export function requireAdmin(req: AuthedRequest, res: Response, next: NextFunction) {
  if (req.user?.role !== 'admin') return res.status(403).json({ error: 'forbidden' });
  next();
}
