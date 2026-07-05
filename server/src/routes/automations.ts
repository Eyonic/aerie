import { Router } from 'express';
import { type AuthedRequest } from '../lib/auth.js';
import { db, audit } from '../lib/db.js';

const r = Router();

function map(a: any) {
  return { id: a.id, name: a.name, trigger: a.trigger, action: a.action, enabled: !!a.enabled, lastRun: a.last_run, runCount: a.run_count };
}

r.get('/', (_req, res) => {
  res.json((db.prepare('SELECT * FROM automations ORDER BY name').all() as any[]).map(map));
});

r.post('/:id/toggle', (req: AuthedRequest, res) => {
  const a = db.prepare('SELECT * FROM automations WHERE id=?').get(req.params.id) as any;
  if (!a) return res.status(404).json({ error: 'not_found' });
  db.prepare('UPDATE automations SET enabled=? WHERE id=?').run(a.enabled ? 0 : 1, a.id);
  audit(req.user!.id, req.user!.username, 'automation_toggled', a.id);
  res.json(map(db.prepare('SELECT * FROM automations WHERE id=?').get(a.id)));
});

r.post('/', (req: AuthedRequest, res) => {
  const { name, trigger, action } = req.body || {};
  const id = 'a_' + Math.random().toString(36).slice(2, 9);
  db.prepare('INSERT INTO automations (id,name,trigger,action,enabled,run_count) VALUES (?,?,?,?,1,0)').run(id, name, trigger, action);
  res.json(map(db.prepare('SELECT * FROM automations WHERE id=?').get(id)));
});

// Update name/trigger/action ONLY — never touch run_count/last_run/enabled, so
// editing an automation preserves its run history.
r.patch('/:id', (req: AuthedRequest, res) => {
  const a = db.prepare('SELECT * FROM automations WHERE id=?').get(req.params.id) as any;
  if (!a) return res.status(404).json({ error: 'not_found' });
  const { name, trigger, action } = req.body || {};
  db.prepare('UPDATE automations SET name=COALESCE(?,name), trigger=COALESCE(?,trigger), action=COALESCE(?,action) WHERE id=?')
    .run(name ?? null, trigger ?? null, action ?? null, a.id);
  audit(req.user!.id, req.user!.username, 'automation_updated', a.id);
  res.json(map(db.prepare('SELECT * FROM automations WHERE id=?').get(a.id)));
});

r.delete('/:id', (_req, res) => {
  db.prepare('DELETE FROM automations WHERE id=?').run(_req.params.id);
  res.json({ ok: true });
});

export default r;
