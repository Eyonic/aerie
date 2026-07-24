// Audit log viewer. Admins see all; users see their own actions.
import { Router } from 'express';
import { type AuthedRequest } from '../lib/auth.js';
import { db } from '../lib/db.js';

const r = Router();

r.get('/', (req: AuthedRequest, res) => {
  const limit = Math.max(1, Math.min(Number(req.query.limit) || 100, 500));
  const rows = req.user!.role === 'admin'
    ? db.prepare('SELECT * FROM audit ORDER BY id DESC LIMIT ?').all(limit) as any[]
    : db.prepare('SELECT * FROM audit WHERE user_id=? ORDER BY id DESC LIMIT ?').all(req.user!.id, limit) as any[];
  res.json(rows.map(a => ({
    id: a.id, ts: a.ts, userId: a.user_id, username: a.username, action: a.action,
    target: a.target, ip: a.ip, meta: (() => { try { return a.meta ? JSON.parse(a.meta) : undefined; } catch { return undefined; } })(),
  })));
});

export default r;
