import { Router } from 'express';
import { rowToUser, type AuthedRequest } from '../lib/auth.js';
import { db } from '../lib/db.js';
import * as autorequest from '../services/autorequest.js';

const r = Router();

function parseFeatures(raw: any) {
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw || '{}') : raw;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

r.get('/suggestions', async (req: AuthedRequest, res, next) => {
  try { res.json(await autorequest.suggest(req.user!.id)); }
  catch (e) { next(e); }
});

r.post('/run', async (req: AuthedRequest, res, next) => {
  try { res.json(await autorequest.runFor(req.user!.id, { manual: true })); }
  catch (e) { next(e); }
});

r.get('/status', (req: AuthedRequest, res) => {
  const recent = db.prepare(`
    SELECT target title, ts, meta
    FROM audit
    WHERE user_id=? AND action='auto_requested'
    ORDER BY ts DESC
    LIMIT 5
  `).all(req.user!.id) as any[];
  res.json({
    enabled: req.user!.features?.autoRequest !== false,
    thisWeek: autorequest.countThisWeek(req.user!.id),
    cap: 3,
    recent: recent.map(row => {
      let meta = {};
      try { meta = JSON.parse(row.meta || '{}'); } catch { /* */ }
      return { title: row.title, ts: row.ts, meta };
    }),
  });
});

r.post('/enabled', (req: AuthedRequest, res) => {
  const enabled = !!req.body?.enabled;
  const row = db.prepare('SELECT features FROM users WHERE id=?').get(req.user!.id) as any;
  const features = { ...parseFeatures(row?.features), autoRequest: enabled };
  db.prepare('UPDATE users SET features=? WHERE id=?').run(JSON.stringify(features), req.user!.id);
  req.user = rowToUser(db.prepare('SELECT * FROM users WHERE id=?').get(req.user!.id));
  res.json({ enabled });
});

export default r;
