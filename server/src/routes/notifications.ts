import { Router } from 'express';
import { type AuthedRequest } from '../lib/auth.js';
import { db } from '../lib/db.js';
import { subscribe } from '../services/events.js';

const r = Router();

// Live notification stream (Server-Sent Events). Auth via ?token= (EventSource
// can't set headers). Pushes {type:'notification',...} as jobs complete.
r.get('/stream', (req: AuthedRequest, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();
  res.write(`data: ${JSON.stringify({ type: 'hello' })}\n\n`);
  const unsub = subscribe(req.user!.id, res);
  const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* */ } }, 25000);
  req.on('close', () => { clearInterval(ping); unsub(); });
});

r.get('/', (req: AuthedRequest, res) => {
  const rows = db.prepare('SELECT * FROM notifications WHERE user_id=? ORDER BY ts DESC LIMIT 50').all(req.user!.id) as any[];
  res.json(rows.map(n => ({ id: n.id, ts: n.ts, title: n.title, body: n.body, level: n.level, read: !!n.read, link: n.link })));
});

r.post('/read', (req: AuthedRequest, res) => {
  const { id } = req.body || {};
  if (id) db.prepare('UPDATE notifications SET read=1 WHERE id=? AND user_id=?').run(id, req.user!.id);
  else db.prepare('UPDATE notifications SET read=1 WHERE user_id=?').run(req.user!.id);
  res.json({ ok: true });
});

export default r;
