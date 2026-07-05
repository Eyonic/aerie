import { Router } from 'express';
import jwt from 'jsonwebtoken';
import { login, authMiddleware, findUserById, type AuthedRequest } from '../lib/auth.js';
import { db } from '../lib/db.js';
import { config } from '../config.js';

const r = Router();

r.post('/login', (req, res) => {
  const { username, password, code } = req.body || {};
  const ip = (req.headers['x-forwarded-for'] as string)?.split(',')[0] || req.ip;
  const result = login(String(username || ''), String(password || ''), ip, code ? String(code) : undefined);
  if (!result) return res.status(401).json({ error: 'invalid_credentials' });
  if ('needs2fa' in result) return res.status(200).json({ needs2fa: true });
  res.cookie('cb_token', result.token, { httpOnly: true, sameSite: 'lax', maxAge: 30 * 864e5 });
  res.json(result);
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
    const payload = jwt.verify(token, config.jwtSecret) as any;
    if (!findUserById(payload.id)) return res.status(401).json({ error: 'unauthorized' });
    res.cookie('cb_token', token, { httpOnly: true, sameSite: 'lax', maxAge: 30 * 864e5 });
    res.json({ ok: true });
  } catch {
    res.status(401).json({ error: 'invalid_token' });
  }
});

r.post('/logout', (_req, res) => {
  res.clearCookie('cb_token');
  res.json({ ok: true });
});

r.get('/me', authMiddleware, (req: AuthedRequest, res) => {
  res.json({ user: req.user });
});

r.get('/users', authMiddleware, (_req, res) => {
  // public-ish directory for share targets (no secrets)
  const rows = db.prepare('SELECT id, username, display_name, avatar_color, avatar_version FROM users').all() as any[];
  res.json(rows.map(u => ({ id: u.id, username: u.username, displayName: u.display_name, avatarColor: u.avatar_color,
    avatarUrl: u.avatar_version ? `/api/settings/avatar/${u.id}?v=${u.avatar_version}` : null })));
});

export default r;
