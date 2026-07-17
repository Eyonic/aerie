// JWT auth: login, middleware, and user serialization.
import jwt from 'jsonwebtoken';
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import type { Request, Response, NextFunction } from 'express';
import { config } from '../config.js';
import { db, audit } from './db.js';
import * as totp from '../services/totp.js';
import type { User } from './model.js';

export interface AuthedRequest extends Request {
  user?: User;
  sessionId?: string;
}

export type FeatureKey = Exclude<keyof NonNullable<User['features']>, 'autoRequest'>;
const FEATURE_KEYS: FeatureKey[] = ['files', 'photos', 'videos', 'movies', 'tv', 'music', 'audiobooks', 'requests', 'create', 'ai', 'sync'];

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
    createdAt: r.created_at,
  };
}

export function findUser(username: string): any {
  return db.prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE').get(username);
}
export function findUserById(id: number): any {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id);
}

export function login(username: string, password: string, ip?: string, code?: string,
  device?: { name?: string; type?: string; userAgent?: string }):
  { token: string; user: User } | { needs2fa: true } | null {
  const row = findUser(username);
  if (!row || !bcrypt.compareSync(password, row.password_hash)) {
    audit(row?.id ?? null, username, 'login_failure', undefined, ip);
    return null;
  }
  // Second factor (authenticator app), only if the user enabled it.
  if (row.totp_enabled && row.totp_secret) {
    if (!code) return { needs2fa: true };
    if (!totp.verify(row.totp_secret, code)) { audit(row.id, username, 'login_2fa_failure', undefined, ip); return null; }
  }
  const user = rowToUser(row);
  const sid = crypto.randomUUID();
  const expires = new Date(Date.now() + 30 * 864e5).toISOString();
  db.prepare(`INSERT INTO auth_sessions (id,user_id,device_name,device_type,ip,user_agent,expires_at)
    VALUES (?,?,?,?,?,?,?)`).run(sid, user.id, String(device?.name || 'Web browser').slice(0, 100),
      String(device?.type || 'web').slice(0, 30), ip || null, String(device?.userAgent || '').slice(0, 500), expires);
  const token = jwt.sign({ id: user.id, username: user.username, role: user.role, sid }, config.jwtSecret, { expiresIn: '30d' });
  audit(user.id, user.username, 'login_success', undefined, ip);
  return { token, user };
}

export function authMiddleware(req: AuthedRequest, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  const bearer = header?.startsWith('Bearer ') ? header.slice(7) : null;
  const token = bearer || (req.query.token as string) || (req.cookies?.cb_token as string);
  if (!token) return res.status(401).json({ error: 'unauthorized' });
  try {
    const payload = jwt.verify(token, config.jwtSecret) as any;
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
    next();
  } catch {
    return res.status(401).json({ error: 'invalid_token' });
  }
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
