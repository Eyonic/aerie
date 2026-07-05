// Sharing — create links (public/password/expiring) and user shares.
import { Router } from 'express';
import bcrypt from 'bcryptjs';
import path from 'node:path';
import { authMiddleware, type AuthedRequest } from '../lib/auth.js';
import { db, audit } from '../lib/db.js';
import * as storage from '../services/storage.js';

const r = Router();

function mapShare(s: any) {
  return {
    id: s.id, path: s.path, name: s.name, type: s.type, permission: s.permission,
    allowDownload: !!s.allow_download, hasPassword: !!s.password_hash, expiresAt: s.expires_at,
    url: s.type === 'link' ? `/s/${s.id}` : null, sharedWith: s.shared_with, createdAt: s.created_at,
  };
}

// Public: view a share link (no auth)
r.get('/public/:id', (req, res) => {
  const s = db.prepare('SELECT * FROM shares WHERE id=?').get(req.params.id) as any;
  if (!s) return res.status(404).json({ error: 'not_found' });
  if (s.expires_at && new Date(s.expires_at) < new Date()) return res.status(410).json({ error: 'expired' });
  res.json({ id: s.id, name: s.name, hasPassword: !!s.password_hash, permission: s.permission, allowDownload: !!s.allow_download });
});

r.post('/public/:id/open', (req, res) => {
  const s = db.prepare('SELECT * FROM shares WHERE id=?').get(req.params.id) as any;
  if (!s) return res.status(404).json({ error: 'not_found' });
  if (s.password_hash && !bcrypt.compareSync(req.body?.password || '', s.password_hash))
    return res.status(403).json({ error: 'wrong_password' });
  const owner = db.prepare('SELECT username FROM users WHERE id=?').get(s.user_id) as any;
  try {
    const listing = storage.list(owner.username, s.user_id, s.path.endsWith('/') ? s.path : s.path, {});
    res.json({ ok: true, listing });
  } catch {
    res.json({ ok: true, download: `/api/shares/public/${s.id}/download` });
  }
});

// Public file download for a share link (anonymous). Password via ?password=.
r.get('/public/:id/download', (req, res) => {
  const s = db.prepare('SELECT * FROM shares WHERE id=?').get(req.params.id) as any;
  if (!s) return res.status(404).json({ error: 'not_found' });
  if (s.expires_at && new Date(s.expires_at).getTime() < Date.now()) return res.status(410).json({ error: 'expired' });
  if (s.allow_download === 0) return res.status(403).json({ error: 'download_disabled' });
  if (s.password_hash && !bcrypt.compareSync(String(req.query.password || ''), s.password_hash))
    return res.status(403).json({ error: 'password_required' });
  const owner = db.prepare('SELECT username FROM users WHERE id=?').get(s.user_id) as any;
  try {
    const real = storage.resolve(owner.username, s.path);
    res.download(real, s.name);
  } catch { res.status(404).json({ error: 'not_found' }); }
});

// Authed routes
r.use(authMiddleware);

r.get('/', (req: AuthedRequest, res) => {
  const rows = db.prepare('SELECT * FROM shares WHERE user_id=? ORDER BY created_at DESC').all(req.user!.id) as any[];
  res.json(rows.map(mapShare));
});

r.post('/', (req: AuthedRequest, res) => {
  const { path: p, type, permission, allowDownload, password, expiresAt, sharedWith } = req.body || {};
  const id = 'sh_' + Math.random().toString(36).slice(2, 11);
  db.prepare(`INSERT INTO shares (id,user_id,path,name,type,permission,allow_download,password_hash,shared_with,expires_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
    id, req.user!.id, p, path.posix.basename(p) || p, type || 'link', permission || 'view',
    allowDownload === false ? 0 : 1, password ? bcrypt.hashSync(password, 10) : null,
    sharedWith || null, expiresAt || null);
  audit(req.user!.id, req.user!.username, 'share_created', p);
  const s = db.prepare('SELECT * FROM shares WHERE id=?').get(id);
  res.json(mapShare(s));
});

r.delete('/:id', (req: AuthedRequest, res) => {
  db.prepare('DELETE FROM shares WHERE id=? AND user_id=?').run(req.params.id, req.user!.id);
  res.json({ ok: true });
});

export default r;
