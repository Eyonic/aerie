// Admin — users, quotas, settings. Admin-protected.
import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { requireAdmin, rowToUser, type AuthedRequest } from '../lib/auth.js';
import { db, audit, getSetting, setSetting } from '../lib/db.js';
import crypto from 'node:crypto';
import { invalidateStorageIdentity } from '../services/storage.js';
import { revokeCastSessionsForUser, revokeStreamTokensForUser } from '../services/cast.js';
import {
  normalizeAllowedFileTypes, validateAiMode, validateEmail, validateMaxUploadMb,
  validatePassword, validateQuota, validateRole, validateUsername,
} from '../lib/validation.js';
import { createInvite, listInvites, revokeInvite } from '../services/user-invites.js';

const r = Router();
r.use(requireAdmin);

function cleanFeatures(raw: any) {
  const out: Record<string, boolean> = {};
  const keys = ['files', 'photos', 'videos', 'movies', 'tv', 'music', 'audiobooks', 'requests', 'create', 'ai', 'sync', 'autoRequest'];
  if (raw && typeof raw === 'object') for (const key of keys) if (raw[key] !== undefined) out[key] = !!raw[key];
  return out;
}

function parseFeatures(raw: any) {
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw || '{}') : raw;
    return cleanFeatures(parsed);
  } catch {
    return {};
  }
}

r.get('/users', (_req, res) => {
  const rows = db.prepare('SELECT * FROM users ORDER BY id').all() as any[];
  res.json(rows.map(rowToUser));
});

r.get('/invites', (req: AuthedRequest, res, next) => {
  try { res.json({ items: listInvites(req.user!.id) }); }
  catch (error) { next(error); }
});

r.post('/invites', (req: AuthedRequest, res, next) => {
  try {
    const result = createInvite(req.user!.id, req.body || {});
    audit(req.user!.id, req.user!.username, 'admin_invite_created', result.invite.id, req.ip, {
      role: result.invite.role, expiresAt: result.invite.expiresAt,
    });
    res.status(201).json(result);
  } catch (error) { next(error); }
});

r.delete('/invites/:id', (req: AuthedRequest, res, next) => {
  try {
    const id = String(req.params.id);
    if (!revokeInvite(req.user!.id, id)) return res.status(404).json({ error: 'invite_not_found' });
    audit(req.user!.id, req.user!.username, 'admin_invite_revoked', id, req.ip);
    res.json({ ok: true });
  } catch (error) { next(error); }
});

r.post('/users', async (req: AuthedRequest, res) => {
  const { username, displayName, email, password, role, storageQuotaBytes, aiMode, features } = req.body || {};
  try {
    const cleanUsername = validateUsername(username);
    const cleanPassword = validatePassword(password);
    const cleanRole = validateRole(role);
    const cleanAiMode = validateAiMode(aiMode);
    const cleanQuota = validateQuota(storageQuotaBytes);
    const cleanEmail = validateEmail(email);
    const cleanDisplayName = String(displayName || cleanUsername).trim().slice(0, 120) || cleanUsername;
    if (db.prepare('SELECT 1 FROM users WHERE username=? COLLATE NOCASE').get(cleanUsername)) throw new Error('username_taken');
    const passwordHash = await bcrypt.hash(cleanPassword, 12);
    const info = db.prepare(`INSERT INTO users (username,storage_id,display_name,email,password_hash,role,avatar_color,storage_quota_bytes,ai_mode,features)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
      cleanUsername, crypto.randomUUID(), cleanDisplayName, cleanEmail, passwordHash,
      cleanRole, '#' + Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, '0'),
      cleanQuota, cleanAiMode, JSON.stringify(cleanFeatures(features)));
    invalidateStorageIdentity(cleanUsername);
    audit(req.user!.id, req.user!.username, 'admin_user_created', cleanUsername);
    const u = db.prepare('SELECT * FROM users WHERE id=?').get(info.lastInsertRowid);
    res.status(201).json(rowToUser(u));
  } catch (e: any) { res.status(400).json({ error: e.message }); }
});

r.patch('/users/:id', async (req: AuthedRequest, res) => {
  const id = String(req.params.id);
  const target = db.prepare('SELECT * FROM users WHERE id=?').get(id) as any;
  if (!target) return res.status(404).json({ error: 'not_found' });
  const { displayName, email, role, storageQuotaBytes, aiMode, password, features } = req.body || {};
  const fields: string[] = []; const vals: any[] = [];
  try {
    if (displayName !== undefined) {
      const clean = String(displayName).trim().slice(0, 120);
      if (!clean) throw new Error('display_name_required');
      fields.push('display_name=?'); vals.push(clean);
    }
    if (email !== undefined) { fields.push('email=?'); vals.push(validateEmail(email)); }
    if (role !== undefined) {
      const nextRole = validateRole(role);
      if (Number(id) === req.user!.id && nextRole !== 'admin') throw new Error('cannot_demote_self');
      const admins = (db.prepare("SELECT COUNT(*) count FROM users WHERE role='admin' AND disabled_at IS NULL").get() as any).count;
      if (target.role === 'admin' && !target.disabled_at && nextRole !== 'admin' && admins <= 1) throw new Error('last_admin_required');
      fields.push('role=?'); vals.push(nextRole);
    }
    if (storageQuotaBytes !== undefined) { fields.push('storage_quota_bytes=?'); vals.push(validateQuota(storageQuotaBytes)); }
    if (aiMode !== undefined) { fields.push('ai_mode=?'); vals.push(validateAiMode(aiMode)); }
    if (password !== undefined && password !== '') {
      fields.push('password_hash=?'); vals.push(await bcrypt.hash(validatePassword(password), 12));
      db.prepare("UPDATE auth_sessions SET revoked_at=datetime('now') WHERE user_id=?").run(id);
    }
  } catch (e: any) { return res.status(400).json({ error: e.message }); }
  if (features !== undefined) {
    const current = db.prepare('SELECT features FROM users WHERE id=?').get(id) as any;
    fields.push('features=?'); vals.push(JSON.stringify({ ...parseFeatures(current?.features), ...cleanFeatures(features) }));
  }
  if (fields.length) { db.prepare(`UPDATE users SET ${fields.join(',')} WHERE id=?`).run(...vals, id); }
  audit(req.user!.id, req.user!.username, 'admin_user_updated', id);
  res.json(rowToUser(db.prepare('SELECT * FROM users WHERE id=?').get(id)));
});

r.delete('/users/:id', (req: AuthedRequest, res, next) => {
  const id = String(req.params.id);
  if (Number(id) === req.user!.id) return res.status(400).json({ error: 'cannot_deactivate_self' });
  try {
    const target = db.prepare('SELECT role,username,disabled_at FROM users WHERE id=?').get(id) as any;
    if (!target) return res.status(404).json({ error: 'not_found' });
    if (target.disabled_at) return res.status(409).json({ error: 'already_deactivated' });
    if (target.role === 'admin') {
      const admins = (db.prepare("SELECT COUNT(*) count FROM users WHERE role='admin' AND disabled_at IS NULL").get() as any).count;
      if (admins <= 1) return res.status(400).json({ error: 'last_admin_required' });
    }
    db.transaction(() => {
      db.prepare("UPDATE users SET disabled_at=datetime('now') WHERE id=? AND disabled_at IS NULL").run(id);
      db.prepare("UPDATE auth_sessions SET revoked_at=datetime('now') WHERE user_id=? AND revoked_at IS NULL").run(id);
      db.prepare("UPDATE jobs SET status='error',error='account_deactivated',finished_at=datetime('now') WHERE user_id=? AND status IN ('queued','running')").run(id);
      db.prepare("UPDATE generated_music SET status='error',error='account_deactivated' WHERE user_id=? AND status IN ('queued','running')").run(id);
      const hasTimeMachineTasks = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='time_machine_tasks'").get();
      if (hasTimeMachineTasks) db.prepare(`UPDATE time_machine_tasks SET status='failed',error='account_deactivated',finished_at=datetime('now')
        WHERE user_id=? AND status IN ('queued','running')`).run(id);
      db.prepare('DELETE FROM storage_reservations WHERE user_id=?').run(id);
      db.prepare('DELETE FROM upload_sessions WHERE user_id=?').run(id);
    })();
    revokeStreamTokensForUser(Number(id));
    revokeCastSessionsForUser(Number(id));
    audit(req.user!.id, req.user!.username, 'admin_user_deactivated', id);
    res.json({ ok: true, disabledAt: (db.prepare('SELECT disabled_at FROM users WHERE id=?').get(id) as any).disabled_at });
  } catch (error) { next(error); }
});

r.post('/users/:id/restore', (req: AuthedRequest, res) => {
  const id = String(req.params.id);
  const target = db.prepare('SELECT * FROM users WHERE id=?').get(id) as any;
  if (!target) return res.status(404).json({ error: 'not_found' });
  if (!target.disabled_at) return res.status(409).json({ error: 'already_active' });
  db.prepare('UPDATE users SET disabled_at=NULL WHERE id=?').run(id);
  audit(req.user!.id, req.user!.username, 'admin_user_restored', id);
  res.json(rowToUser(db.prepare('SELECT * FROM users WHERE id=?').get(id)));
});

r.get('/settings', (_req, res) => {
  res.json({
    publicSharingEnabled: getSetting('public_sharing', 'true') === 'true',
    externalAiEnabled: getSetting('external_ai', 'false') === 'true',
    maxUploadMb: Number(getSetting('max_upload_mb', '20480')),
    allowedFileTypes: getSetting('allowed_file_types', '*'),
    faceRecognition: false,
    faceRecognitionAvailable: false,
    locationIndexing: getSetting('location_indexing', 'false') === 'true',
  });
});

r.post('/settings', (req: AuthedRequest, res) => {
  const s = req.body || {};
  try {
    // Face recognition is not implemented. Reject the request before changing
    // any other setting so a legacy client cannot receive an error after a
    // partial save.
    if (s.faceRecognition === true) return res.status(409).json({ error: 'face_recognition_not_available' });
    if (s.publicSharingEnabled !== undefined) setSetting('public_sharing', String(!!s.publicSharingEnabled));
    if (s.externalAiEnabled !== undefined) setSetting('external_ai', String(!!s.externalAiEnabled));
    if (s.maxUploadMb !== undefined) setSetting('max_upload_mb', String(validateMaxUploadMb(s.maxUploadMb)));
    if (s.allowedFileTypes !== undefined) setSetting('allowed_file_types', normalizeAllowedFileTypes(s.allowedFileTypes));
    if (s.faceRecognition !== undefined) setSetting('face_recognition', 'false');
    if (s.locationIndexing !== undefined) {
      const on = !!s.locationIndexing;
      setSetting('location_indexing', String(on));
      if (!on) db.prepare('UPDATE photo_index SET lat=NULL,lon=NULL').run();
    }
    audit(req.user!.id, req.user!.username, 'admin_setting_changed', JSON.stringify(Object.keys(s)));
    res.json({ ok: true });
  } catch (e: any) { res.status(400).json({ error: e.message }); }
});

export default r;
