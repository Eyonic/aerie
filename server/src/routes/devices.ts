import { Router } from 'express';
import { type AuthedRequest } from '../lib/auth.js';
import { db, audit } from '../lib/db.js';

const r = Router();

function map(d: any) {
  return { id: d.id, name: d.name, type: d.type, lastSeen: d.last_seen, backupStatus: d.backup_status, trusted: !!d.trusted };
}

// Register / heartbeat current device
r.post('/heartbeat', (req: AuthedRequest, res) => {
  const { name, type } = req.body || {};
  const id = 'd_' + Buffer.from(`${req.user!.id}:${name || 'Web'}`).toString('base64url').slice(0, 16);
  const exists = db.prepare('SELECT 1 FROM devices WHERE id=?').get(id);
  if (exists) db.prepare("UPDATE devices SET last_seen=datetime('now') WHERE id=?").run(id);
  else db.prepare('INSERT INTO devices (id,user_id,name,type) VALUES (?,?,?,?)').run(id, req.user!.id, name || 'Web Session', type || 'web');
  res.json(map(db.prepare('SELECT * FROM devices WHERE id=?').get(id)));
});

r.get('/', (req: AuthedRequest, res) => {
  res.json((db.prepare('SELECT * FROM devices WHERE user_id=? ORDER BY last_seen DESC').all(req.user!.id) as any[]).map(map));
});

r.delete('/:id', (req: AuthedRequest, res) => {
  db.prepare('DELETE FROM devices WHERE id=? AND user_id=?').run(req.params.id, req.user!.id);
  audit(req.user!.id, req.user!.username, 'device_revoked', req.params.id);
  res.json({ ok: true });
});

export default r;
