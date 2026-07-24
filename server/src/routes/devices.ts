import { Router } from 'express';
import { type AuthedRequest } from '../lib/auth.js';
import { db, audit } from '../lib/db.js';
import crypto from 'node:crypto';

const r = Router();

function map(d: any) {
  return { id: d.id, name: d.name, type: d.type, lastSeen: d.last_seen, backupStatus: d.backup_status,
    trusted: !!d.trusted, current: !!d.current, ip: d.ip || undefined, createdAt: d.created_at || undefined };
}

// Register / heartbeat current device
r.post('/heartbeat', (req: AuthedRequest, res) => {
  const name = String(req.body?.name || 'Web Session').trim().slice(0, 100);
  const type = String(req.body?.type || 'web').trim().toLowerCase();
  if (!name || !['web', 'desktop', 'android', 'ios', 'tablet', 'tv', 'native'].includes(type)) {
    return res.status(400).json({ error: 'invalid_device' });
  }
  const id = 'd_' + crypto.createHash('sha256').update(`${req.user!.id}:${name}:${type}`).digest('base64url').slice(0, 32);
  const exists = db.prepare('SELECT 1 FROM devices WHERE id=? AND user_id=?').get(id, req.user!.id);
  if (exists) db.prepare("UPDATE devices SET name=?,type=?,last_seen=datetime('now') WHERE id=? AND user_id=?")
    .run(name, type, id, req.user!.id);
  else db.prepare('INSERT INTO devices (id,user_id,name,type) VALUES (?,?,?,?)').run(id, req.user!.id, name, type);
  res.json(map(db.prepare('SELECT * FROM devices WHERE id=? AND user_id=?').get(id, req.user!.id)));
});

r.get('/', (req: AuthedRequest, res) => {
  const sessions = db.prepare(`SELECT id,device_name name,device_type type,last_seen,NULL backup_status,1 trusted,
    ip,created_at,CASE WHEN id=? THEN 1 ELSE 0 END current
    FROM auth_sessions WHERE user_id=? AND revoked_at IS NULL AND datetime(expires_at)>datetime('now') ORDER BY last_seen DESC`)
    .all(req.sessionId || '', req.user!.id) as any[];
  res.json(sessions.map(map));
});

r.delete('/:id', (req: AuthedRequest, res) => {
  const id = String(req.params.id);
  db.prepare("UPDATE auth_sessions SET revoked_at=datetime('now') WHERE id=? AND user_id=?").run(id, req.user!.id);
  db.prepare('DELETE FROM devices WHERE id=? AND user_id=?').run(id, req.user!.id);
  audit(req.user!.id, req.user!.username, 'device_revoked', id);
  res.json({ ok: true });
});

r.post('/revoke-others', (req: AuthedRequest, res) => {
  db.prepare("UPDATE auth_sessions SET revoked_at=datetime('now') WHERE user_id=? AND id<>? AND revoked_at IS NULL")
    .run(req.user!.id, req.sessionId || '');
  audit(req.user!.id, req.user!.username, 'other_sessions_revoked');
  res.json({ ok: true });
});

export default r;
