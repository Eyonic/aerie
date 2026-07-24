// Per-user settings (profile, AI mode, preferences).
import { Router } from 'express';
import bcrypt from 'bcryptjs';
import fs from 'node:fs';
import path from 'node:path';
import multer from 'multer';
import sharp from 'sharp';
import { rowToUser, type AuthedRequest } from '../lib/auth.js';
import { db, audit } from '../lib/db.js';
import { config } from '../config.js';
import crypto from 'node:crypto';
import { validateAiMode, validateEmail, validatePassword } from '../lib/validation.js';
import { seal, unseal } from '../services/secrets.js';
import {
  translationCapabilities, translationPreferencesFromSettings, validateTranslationPreferences,
} from '../services/translation-preferences.js';

const r = Router();

const avatarsDir = path.join(config.dataDir, 'avatars');
const avatarFile = (id: number) => path.join(avatarsDir, `${id}.webp`);
const avatarUpload = multer({ dest: path.join(config.dataDir, 'tmp'), limits: { fileSize: 12 * 1024 * 1024 } });

r.get('/', (req: AuthedRequest, res) => {
  const row = db.prepare('SELECT settings FROM users WHERE id=?').get(req.user!.id) as any;
  let prefs: any = {}; try { prefs = JSON.parse(row?.settings || '{}'); } catch { /* */ }
  prefs.translation = translationPreferencesFromSettings(prefs);
  res.json({ user: req.user, preferences: prefs, translationCapabilities: translationCapabilities(req.user!) });
});

r.patch('/profile', (req: AuthedRequest, res) => {
  const { displayName, email, avatarColor, aiMode } = req.body || {};
  const fields: string[] = []; const vals: any[] = [];
  let selectedAiMode: string | undefined;
  try {
    if (displayName !== undefined) {
      const clean = String(displayName).trim().slice(0, 120);
      if (!clean) throw new Error('display_name_required');
      fields.push('display_name=?'); vals.push(clean);
    }
    if (email !== undefined) { fields.push('email=?'); vals.push(validateEmail(email)); }
    if (avatarColor !== undefined) {
      const color = String(avatarColor);
      if (!/^#[0-9a-f]{6}$/i.test(color)) throw new Error('avatar_color_invalid');
      fields.push('avatar_color=?'); vals.push(color.toLowerCase());
    }
    if (aiMode !== undefined) {
      selectedAiMode = validateAiMode(aiMode);
      fields.push('ai_mode=?'); vals.push(selectedAiMode);
    }
  } catch (error: any) { return res.status(400).json({ error: error?.message || 'invalid_profile' }); }
  if (fields.length) db.prepare(`UPDATE users SET ${fields.join(',')} WHERE id=?`).run(...vals, req.user!.id);
  if (selectedAiMode === 'local_only' || selectedAiMode === 'disabled') {
    const row = db.prepare('SELECT settings FROM users WHERE id=?').get(req.user!.id) as any;
    let preferences: any = {}; try { preferences = JSON.parse(row?.settings || '{}'); } catch { /* */ }
    if (translationPreferencesFromSettings(preferences).provider === 'external') {
      preferences.translation = { ...translationPreferencesFromSettings(preferences), provider: 'local' };
      db.prepare('UPDATE users SET settings=? WHERE id=?').run(JSON.stringify(preferences), req.user!.id);
    }
  }
  res.json(rowToUser(db.prepare('SELECT * FROM users WHERE id=?').get(req.user!.id)));
});

// Upload a profile picture: re-encoded through sharp (256×256 webp, centre-cropped)
// which also strips EXIF and neutralizes anything that isn't a real image.
r.post('/avatar', avatarUpload.single('file'), async (req: AuthedRequest, res) => {
  const f = (req as any).file;
  if (!f) return res.status(400).json({ error: 'no_file' });
  const destination = avatarFile(req.user!.id);
  const temporary = `${destination}.${crypto.randomUUID()}.tmp`;
  try {
    await fs.promises.mkdir(avatarsDir, { recursive: true, mode: 0o700 });
    await sharp(f.path, { limitInputPixels: 40_000_000, failOn: 'error' })
      .rotate().resize(256, 256, { fit: 'cover' }).webp({ quality: 88 }).toFile(temporary);
    await fs.promises.rename(temporary, destination);
    const version = Date.now();
    db.prepare('UPDATE users SET avatar_version=? WHERE id=?').run(version, req.user!.id);
    audit(req.user!.id, req.user!.username, 'avatar_updated');
    res.json(rowToUser(db.prepare('SELECT * FROM users WHERE id=?').get(req.user!.id)));
  } catch {
    res.status(400).json({ error: 'invalid_image' });
  } finally {
    fs.promises.unlink(f.path).catch(() => {});
    fs.promises.rm(temporary, { force: true }).catch(() => {});
  }
});

r.delete('/avatar', async (req: AuthedRequest, res, next) => {
  try {
    await fs.promises.rm(avatarFile(req.user!.id), { force: true });
    db.prepare('UPDATE users SET avatar_version=0 WHERE id=?').run(req.user!.id);
    res.json(rowToUser(db.prepare('SELECT * FROM users WHERE id=?').get(req.user!.id)));
  } catch (error) { next(error); }
});

// Serve any user's avatar (authed context: topbar, admin list, shares). The ?v=
// stamp in the URL makes it safely long-cacheable.
r.get('/avatar/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).end();
  const file = avatarFile(id);
  if (!(await fs.promises.access(file).then(() => true, () => false))) return res.status(404).end();
  res.setHeader('Content-Type', 'image/webp');
  res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
  fs.createReadStream(file).pipe(res);
});

r.post('/password', async (req: AuthedRequest, res, nextHandler) => {
  try {
    const { current, next } = req.body || {};
    const row = db.prepare('SELECT password_hash FROM users WHERE id=?').get(req.user!.id) as any;
    if (!(await bcrypt.compare(current || '', row.password_hash))) return res.status(403).json({ error: 'wrong_password' });
    let clean: string;
    try { clean = validatePassword(next); } catch (error: any) { return res.status(400).json({ error: error.message }); }
    if (await bcrypt.compare(clean, row.password_hash)) return res.status(400).json({ error: 'password_unchanged' });
    db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(await bcrypt.hash(clean, 12), req.user!.id);
    db.prepare("UPDATE auth_sessions SET revoked_at=datetime('now') WHERE user_id=? AND id<>?")
      .run(req.user!.id, req.sessionId || '');
    audit(req.user!.id, req.user!.username, 'password_changed');
    res.json({ ok: true });
  } catch (error) { nextHandler(error); }
});

// ---- Two-factor auth (TOTP / authenticator app) ----
r.get('/2fa', (req: AuthedRequest, res) => {
  const row = db.prepare('SELECT totp_enabled,totp_recovery_codes FROM users WHERE id=?').get(req.user!.id) as any;
  let recoveryCodesRemaining = 0;
  try { recoveryCodesRemaining = JSON.parse(row?.totp_recovery_codes || '[]').length; } catch { /* */ }
  res.json({ enabled: !!row?.totp_enabled, recoveryCodesRemaining });
});

r.post('/2fa/setup', async (req: AuthedRequest, res) => {
  const account = db.prepare('SELECT password_hash FROM users WHERE id=?').get(req.user!.id) as any;
  if (!(await bcrypt.compare(String(req.body?.password || ''), account.password_hash))) {
    return res.status(403).json({ error: 'wrong_password' });
  }
  const totp = await import('../services/totp.js');
  const secret = totp.generateSecret();
  // A separate pending field prevents setup from disabling/replacing an
  // already-active factor before the new secret has been verified.
  db.prepare('UPDATE users SET totp_pending_secret=? WHERE id=?')
    .run(seal(secret, `totp-pending:${req.user!.id}`), req.user!.id);
  res.json({ secret, otpauth: totp.otpauthUri(secret, req.user!.email || req.user!.username) });
});

r.post('/2fa/enable', async (req: AuthedRequest, res) => {
  const { code } = req.body || {};
  const row = db.prepare('SELECT totp_pending_secret FROM users WHERE id=?').get(req.user!.id) as any;
  if (!row?.totp_pending_secret) return res.status(400).json({ error: 'no_pending_secret' });
  const totp = await import('../services/totp.js');
  let secret: string;
  try { secret = unseal(row.totp_pending_secret, `totp-pending:${req.user!.id}`); }
  catch { return res.status(400).json({ error: 'pending_secret_unavailable' }); }
  if (!totp.verify(secret, String(code || ''))) return res.status(400).json({ error: 'invalid_code' });
  const recoveryCodes = Array.from({ length: 10 }, () => {
    const value = crypto.randomBytes(9).toString('base64url').toUpperCase();
    return `${value.slice(0, 4)}-${value.slice(4, 8)}-${value.slice(8, 12)}`;
  });
  const hashes = recoveryCodes.map(value => crypto.createHash('sha256').update(value.replace(/-/g, '')).digest('hex'));
  db.prepare(`UPDATE users SET totp_secret=?,totp_pending_secret=NULL,totp_enabled=1,totp_recovery_codes=? WHERE id=?`)
    .run(seal(secret, `totp:${req.user!.id}`), JSON.stringify(hashes), req.user!.id);
  audit(req.user!.id, req.user!.username, '2fa_enabled');
  res.json({ ok: true, enabled: true, recoveryCodes });
});

r.post('/2fa/disable', async (req: AuthedRequest, res) => {
  const { password } = req.body || {};
  const row = db.prepare('SELECT password_hash FROM users WHERE id=?').get(req.user!.id) as any;
  if (!(await bcrypt.compare(password || '', row.password_hash))) return res.status(403).json({ error: 'wrong_password' });
  db.prepare("UPDATE users SET totp_enabled=0,totp_secret=NULL,totp_pending_secret=NULL,totp_recovery_codes='[]' WHERE id=?").run(req.user!.id);
  audit(req.user!.id, req.user!.username, '2fa_disabled');
  res.json({ ok: true, enabled: false });
});

r.patch('/preferences', (req: AuthedRequest, res) => {
  const row = db.prepare('SELECT settings FROM users WHERE id=?').get(req.user!.id) as any;
  let prefs: any = {}; try { prefs = JSON.parse(row?.settings || '{}'); } catch { /* */ }
  if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) return res.status(400).json({ error: 'invalid_preferences' });
  const patch = { ...req.body };
  if (patch.translation !== undefined) {
    let translation;
    try { translation = validateTranslationPreferences(patch.translation); }
    catch (error: any) { return res.status(error?.status || 400).json({ error: error?.message || 'translation_preferences_invalid' }); }
    if (translation.provider === 'external' && !translationCapabilities(req.user!).externalAllowed) {
      return res.status(409).json({ error: 'external_translation_provider_unavailable' });
    }
    patch.translation = translation;
  }
  prefs = { ...prefs, ...patch };
  const encoded = JSON.stringify(prefs);
  if (Buffer.byteLength(encoded) > 64 * 1024) return res.status(413).json({ error: 'preferences_too_large' });
  db.prepare('UPDATE users SET settings=? WHERE id=?').run(encoded, req.user!.id);
  if (patch.translation !== undefined) audit(req.user!.id, req.user!.username, 'translation_preferences_updated', undefined, req.ip, {
    provider: patch.translation.provider, languages: patch.translation.languages,
  });
  res.json({ preferences: prefs });
});

export default r;
