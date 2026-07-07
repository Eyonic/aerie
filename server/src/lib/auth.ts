// JWT auth: login, middleware, and user serialization.
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import type { Request, Response, NextFunction } from 'express';
import { config } from '../config.js';
import { db, audit } from './db.js';
import * as totp from '../services/totp.js';
import type { User } from './model.js';

export interface AuthedRequest extends Request {
  user?: User;
}

function parseFeatures(raw: any): User['features'] {
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw || '{}') : raw;
    if (!parsed || typeof parsed !== 'object') return {};
    return typeof parsed.audiobooks === 'boolean' ? { audiobooks: parsed.audiobooks } : {};
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

export function login(username: string, password: string, ip?: string, code?: string):
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
  const token = jwt.sign({ id: user.id, username: user.username, role: user.role }, config.jwtSecret, { expiresIn: '30d' });
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
    req.user = rowToUser(row);
    next();
  } catch {
    return res.status(401).json({ error: 'invalid_token' });
  }
}

export function requireAdmin(req: AuthedRequest, res: Response, next: NextFunction) {
  if (req.user?.role !== 'admin') return res.status(403).json({ error: 'forbidden' });
  next();
}
