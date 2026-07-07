// Admin — users, quotas, settings. Admin-protected.
import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { requireAdmin, rowToUser, type AuthedRequest } from '../lib/auth.js';
import { db, audit, getSetting, setSetting } from '../lib/db.js';

const r = Router();
r.use(requireAdmin);

function cleanFeatures(raw: any) {
  const out: { audiobooks?: boolean; autoRequest?: boolean } = {};
  if (raw && typeof raw === 'object' && raw.audiobooks !== undefined) out.audiobooks = !!raw.audiobooks;
  if (raw && typeof raw === 'object' && raw.autoRequest !== undefined) out.autoRequest = !!raw.autoRequest;
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

r.post('/users', (req: AuthedRequest, res) => {
  const { username, displayName, email, password, role, storageQuotaBytes, aiMode, features } = req.body || {};
  try {
    const info = db.prepare(`INSERT INTO users (username,display_name,email,password_hash,role,avatar_color,storage_quota_bytes,ai_mode,features)
      VALUES (?,?,?,?,?,?,?,?,?)`).run(
      username, displayName || username, email || null, bcrypt.hashSync(password || 'changeme', 10),
      role || 'user', '#' + Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, '0'),
      storageQuotaBytes || null, aiMode || 'local_only', JSON.stringify(cleanFeatures(features)));
    audit(req.user!.id, req.user!.username, 'admin_user_created', username);
    const u = db.prepare('SELECT * FROM users WHERE id=?').get(info.lastInsertRowid);
    res.json(rowToUser(u));
  } catch (e: any) { res.status(400).json({ error: e.message }); }
});

r.patch('/users/:id', (req: AuthedRequest, res) => {
  const id = String(req.params.id);
  const { displayName, email, role, storageQuotaBytes, aiMode, password, features } = req.body || {};
  const fields: string[] = []; const vals: any[] = [];
  if (displayName !== undefined) { fields.push('display_name=?'); vals.push(displayName); }
  if (email !== undefined) { fields.push('email=?'); vals.push(email); }
  if (role !== undefined) { fields.push('role=?'); vals.push(role); }
  if (storageQuotaBytes !== undefined) { fields.push('storage_quota_bytes=?'); vals.push(storageQuotaBytes); }
  if (aiMode !== undefined) { fields.push('ai_mode=?'); vals.push(aiMode); }
  if (password) { fields.push('password_hash=?'); vals.push(bcrypt.hashSync(password, 10)); }
  if (features !== undefined) {
    const current = db.prepare('SELECT features FROM users WHERE id=?').get(id) as any;
    fields.push('features=?'); vals.push(JSON.stringify({ ...parseFeatures(current?.features), ...cleanFeatures(features) }));
  }
  if (fields.length) { db.prepare(`UPDATE users SET ${fields.join(',')} WHERE id=?`).run(...vals, id); }
  audit(req.user!.id, req.user!.username, 'admin_user_updated', id);
  res.json(rowToUser(db.prepare('SELECT * FROM users WHERE id=?').get(id)));
});

r.delete('/users/:id', (req: AuthedRequest, res) => {
  const id = String(req.params.id);
  if (Number(id) === req.user!.id) return res.status(400).json({ error: 'cannot_delete_self' });
  db.prepare('DELETE FROM users WHERE id=?').run(id);
  audit(req.user!.id, req.user!.username, 'admin_user_deleted', id);
  res.json({ ok: true });
});

r.get('/settings', (_req, res) => {
  res.json({
    publicSharingEnabled: getSetting('public_sharing', 'true') === 'true',
    externalAiEnabled: getSetting('external_ai', 'false') === 'true',
    maxUploadMb: Number(getSetting('max_upload_mb', '20480')),
    allowedFileTypes: getSetting('allowed_file_types', '*'),
    faceRecognition: getSetting('face_recognition', 'false') === 'true',
    locationIndexing: getSetting('location_indexing', 'false') === 'true',
  });
});

r.post('/settings', (req: AuthedRequest, res) => {
  const s = req.body || {};
  if (s.publicSharingEnabled !== undefined) setSetting('public_sharing', String(!!s.publicSharingEnabled));
  if (s.externalAiEnabled !== undefined) setSetting('external_ai', String(!!s.externalAiEnabled));
  if (s.maxUploadMb !== undefined) setSetting('max_upload_mb', String(s.maxUploadMb));
  if (s.allowedFileTypes !== undefined) setSetting('allowed_file_types', String(s.allowedFileTypes));
  if (s.faceRecognition !== undefined) setSetting('face_recognition', String(!!s.faceRecognition));
  if (s.locationIndexing !== undefined) setSetting('location_indexing', String(!!s.locationIndexing));
  audit(req.user!.id, req.user!.username, 'admin_setting_changed', JSON.stringify(Object.keys(s)));
  res.json({ ok: true });
});

export default r;
