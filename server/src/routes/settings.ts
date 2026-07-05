// Per-user settings (profile, AI mode, preferences).
import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { rowToUser, type AuthedRequest } from '../lib/auth.js';
import { db, audit } from '../lib/db.js';

const r = Router();

r.get('/', (req: AuthedRequest, res) => {
  const row = db.prepare('SELECT settings FROM users WHERE id=?').get(req.user!.id) as any;
  let prefs = {}; try { prefs = JSON.parse(row?.settings || '{}'); } catch { /* */ }
  res.json({ user: req.user, preferences: prefs });
});

r.patch('/profile', (req: AuthedRequest, res) => {
  const { displayName, email, avatarColor, aiMode } = req.body || {};
  const fields: string[] = []; const vals: any[] = [];
  if (displayName !== undefined) { fields.push('display_name=?'); vals.push(displayName); }
  if (email !== undefined) { fields.push('email=?'); vals.push(email); }
  if (avatarColor !== undefined) { fields.push('avatar_color=?'); vals.push(avatarColor); }
  if (aiMode !== undefined) { fields.push('ai_mode=?'); vals.push(aiMode); }
  if (fields.length) db.prepare(`UPDATE users SET ${fields.join(',')} WHERE id=?`).run(...vals, req.user!.id);
  res.json(rowToUser(db.prepare('SELECT * FROM users WHERE id=?').get(req.user!.id)));
});

r.post('/password', (req: AuthedRequest, res) => {
  const { current, next } = req.body || {};
  const row = db.prepare('SELECT password_hash FROM users WHERE id=?').get(req.user!.id) as any;
  if (!bcrypt.compareSync(current || '', row.password_hash)) return res.status(403).json({ error: 'wrong_password' });
  db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(bcrypt.hashSync(next, 10), req.user!.id);
  audit(req.user!.id, req.user!.username, 'password_changed');
  res.json({ ok: true });
});

// ---- Two-factor auth (TOTP / authenticator app) ----
r.get('/2fa', (req: AuthedRequest, res) => {
  const row = db.prepare('SELECT totp_enabled FROM users WHERE id=?').get(req.user!.id) as any;
  res.json({ enabled: !!row?.totp_enabled });
});

r.post('/2fa/setup', async (req: AuthedRequest, res) => {
  const totp = await import('../services/totp.js');
  const secret = totp.generateSecret();
  // store as a pending (not-yet-enabled) secret
  db.prepare('UPDATE users SET totp_secret=?, totp_enabled=0 WHERE id=?').run(secret, req.user!.id);
  res.json({ secret, otpauth: totp.otpauthUri(secret, req.user!.email || req.user!.username) });
});

r.post('/2fa/enable', async (req: AuthedRequest, res) => {
  const { code } = req.body || {};
  const row = db.prepare('SELECT totp_secret FROM users WHERE id=?').get(req.user!.id) as any;
  if (!row?.totp_secret) return res.status(400).json({ error: 'no_pending_secret' });
  const totp = await import('../services/totp.js');
  if (!totp.verify(row.totp_secret, String(code || ''))) return res.status(400).json({ error: 'invalid_code' });
  db.prepare('UPDATE users SET totp_enabled=1 WHERE id=?').run(req.user!.id);
  audit(req.user!.id, req.user!.username, '2fa_enabled');
  res.json({ ok: true, enabled: true });
});

r.post('/2fa/disable', async (req: AuthedRequest, res) => {
  const { password } = req.body || {};
  const row = db.prepare('SELECT password_hash FROM users WHERE id=?').get(req.user!.id) as any;
  if (!bcrypt.compareSync(password || '', row.password_hash)) return res.status(403).json({ error: 'wrong_password' });
  db.prepare('UPDATE users SET totp_enabled=0, totp_secret=NULL WHERE id=?').run(req.user!.id);
  audit(req.user!.id, req.user!.username, '2fa_disabled');
  res.json({ ok: true, enabled: false });
});

r.patch('/preferences', (req: AuthedRequest, res) => {
  const row = db.prepare('SELECT settings FROM users WHERE id=?').get(req.user!.id) as any;
  let prefs: any = {}; try { prefs = JSON.parse(row?.settings || '{}'); } catch { /* */ }
  prefs = { ...prefs, ...(req.body || {}) };
  db.prepare('UPDATE users SET settings=? WHERE id=?').run(JSON.stringify(prefs), req.user!.id);
  res.json({ preferences: prefs });
});

export default r;
