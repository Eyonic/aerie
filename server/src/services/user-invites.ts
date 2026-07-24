import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { db } from '../lib/db.js';
import {
  validateAiMode, validateEmail, validatePassword, validateQuota, validateRole, validateUsername,
} from '../lib/validation.js';

const FEATURE_KEYS = ['files', 'photos', 'videos', 'movies', 'tv', 'music', 'audiobooks', 'requests', 'create', 'ai', 'sync', 'autoRequest'];
const MAX_ACTIVE_INVITES_PER_ADMIN = 100;

function validated<T>(operation: () => T): T {
  try { return operation(); }
  catch (error: any) {
    if (Number(error?.status) >= 400) throw error;
    throw Object.assign(new Error(String(error?.message || 'invalid_invite')), { status: 400 });
  }
}

function inviteHash(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function cleanToken(raw: unknown): string {
  const token = String(raw || '');
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw Object.assign(new Error('invite_not_found'), { status: 404 });
  return token;
}

function cleanFeatures(raw: unknown): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const key of FEATURE_KEYS) if ((raw as any)[key] !== undefined) out[key] = !!(raw as any)[key];
  }
  return out;
}

function cleanDisplayName(raw: unknown): string {
  const value = String(raw || '').replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (value.length > 120) throw Object.assign(new Error('display_name_too_long'), { status: 400 });
  return value;
}

function boundedExpiryHours(raw: unknown): number {
  const value = raw === undefined ? 48 : Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 24 * 30) throw Object.assign(new Error('invite_expiry_invalid'), { status: 400 });
  return value;
}

function parseFeatures(raw: unknown): Record<string, boolean> {
  try { return cleanFeatures(typeof raw === 'string' ? JSON.parse(raw) : raw); }
  catch { return {}; }
}

function status(row: any): 'active' | 'used' | 'revoked' | 'expired' {
  if (row.used_at) return 'used';
  if (row.revoked_at) return 'revoked';
  return Date.parse(row.expires_at) <= Date.now() ? 'expired' : 'active';
}

function summary(row: any) {
  return {
    id: String(row.id),
    displayName: String(row.display_name || ''),
    email: row.email || null,
    role: row.role,
    storageQuotaBytes: row.storage_quota_bytes ?? null,
    aiMode: row.ai_mode,
    features: parseFeatures(row.features),
    createdAt: String(row.created_at),
    expiresAt: String(row.expires_at),
    usedAt: row.used_at || null,
    revokedAt: row.revoked_at || null,
    usedByUsername: row.used_by_username || null,
    status: status(row),
  };
}

export function listInvites(createdByUserId: number) {
  return (db.prepare(`SELECT i.*,u.username used_by_username FROM user_invites i
    LEFT JOIN users u ON u.id=i.used_by_user_id
    WHERE i.created_by_user_id=? ORDER BY i.created_at DESC LIMIT 250`).all(createdByUserId) as any[]).map(summary);
}

export function createInvite(createdByUserId: number, input: any) {
  const active = Number((db.prepare(`SELECT COUNT(*) count FROM user_invites
    WHERE created_by_user_id=? AND used_at IS NULL AND revoked_at IS NULL
      AND datetime(expires_at)>datetime('now')`).get(createdByUserId) as any)?.count || 0);
  if (active >= MAX_ACTIVE_INVITES_PER_ADMIN) throw Object.assign(new Error('active_invite_limit_reached'), { status: 409 });

  const id = `ui_${crypto.randomBytes(18).toString('base64url')}`;
  const token = crypto.randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + boundedExpiryHours(input?.expiresInHours) * 3600_000).toISOString();
  const displayName = cleanDisplayName(input?.displayName);
  const email = validated(() => validateEmail(input?.email));
  const role = validated(() => validateRole(input?.role, 'user'));
  const quota = validated(() => validateQuota(input?.storageQuotaBytes));
  const aiMode = validated(() => validateAiMode(input?.aiMode, 'ask_before_send'));
  const features = cleanFeatures(input?.features);
  db.prepare(`INSERT INTO user_invites
    (id,token_hash,created_by_user_id,display_name,email,role,storage_quota_bytes,ai_mode,features,expires_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`).run(id, inviteHash(token), createdByUserId, displayName, email, role, quota,
      aiMode, JSON.stringify(features), expiresAt);
  const row = db.prepare('SELECT * FROM user_invites WHERE id=?').get(id);
  return { invite: summary(row), token };
}

export function revokeInvite(createdByUserId: number, inviteId: string): boolean {
  if (!/^ui_[A-Za-z0-9_-]{24}$/.test(inviteId)) return false;
  return db.prepare(`UPDATE user_invites SET revoked_at=datetime('now')
    WHERE id=? AND created_by_user_id=? AND used_at IS NULL AND revoked_at IS NULL`).run(inviteId, createdByUserId).changes === 1;
}

function activeInvite(token: unknown): any {
  const row = db.prepare(`SELECT * FROM user_invites WHERE token_hash=? AND used_at IS NULL AND revoked_at IS NULL
    AND datetime(expires_at)>datetime('now')`).get(inviteHash(cleanToken(token))) as any;
  if (!row) throw Object.assign(new Error('invite_not_found'), { status: 404 });
  return row;
}

export function inspectInvite(token: unknown) {
  const row = activeInvite(token);
  return {
    displayName: String(row.display_name || ''),
    email: row.email || null,
    role: row.role,
    expiresAt: String(row.expires_at),
  };
}

export async function acceptInvite(token: unknown, input: any) {
  const rawToken = cleanToken(token);
  const initial = activeInvite(rawToken);
  const username = validated(() => validateUsername(input?.username));
  const displayName = cleanDisplayName(input?.displayName ?? initial.display_name) || username;
  const passwordHash = await bcrypt.hash(validated(() => validatePassword(input?.password)), 12);
  if (db.prepare('SELECT 1 FROM users WHERE username=? COLLATE NOCASE').get(username)) {
    throw Object.assign(new Error('username_taken'), { status: 409 });
  }
  const avatarColor = '#' + crypto.randomBytes(3).toString('hex');
  const create = db.transaction(() => {
    const invite = activeInvite(rawToken);
    const info = db.prepare(`INSERT INTO users
      (username,storage_id,display_name,email,password_hash,role,avatar_color,storage_quota_bytes,ai_mode,features)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run(username, crypto.randomUUID(), displayName, invite.email, passwordHash, invite.role,
        avatarColor, invite.storage_quota_bytes, invite.ai_mode, invite.features);
    const used = db.prepare(`UPDATE user_invites SET used_at=datetime('now'),used_by_user_id=?
      WHERE id=? AND used_at IS NULL AND revoked_at IS NULL AND datetime(expires_at)>datetime('now')`)
      .run(info.lastInsertRowid, invite.id);
    if (used.changes !== 1) throw Object.assign(new Error('invite_not_found'), { status: 404 });
    return { id: Number(info.lastInsertRowid), username, displayName };
  });
  try { return create(); }
  catch (error: any) {
    if (String(error?.code || '').startsWith('SQLITE_CONSTRAINT') && /users\.username|UNIQUE constraint failed: users\.username/i.test(String(error?.message || ''))) {
      throw Object.assign(new Error('username_taken'), { status: 409 });
    }
    throw error;
  }
}

export const userInviteTestApi = {
  cleanToken, cleanFeatures, cleanDisplayName, boundedExpiryHours, inviteHash,
};
