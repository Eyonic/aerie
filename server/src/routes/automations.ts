import { Router } from 'express';
import { requireAdmin, type AuthedRequest } from '../lib/auth.js';
import { audit } from '../lib/db.js';
import { listBuiltInAutomations, toggleBuiltInAutomation } from '../services/automations.js';

const r = Router();

// These controls change server-wide background work, so discovery and mutation
// are both administrator-only. Arbitrary rule CRUD is intentionally absent:
// every returned row maps to a concrete scheduler executor.
r.use(requireAdmin);

r.get('/', (_req, res) => {
  res.json(listBuiltInAutomations());
});

r.post('/:id/toggle', (req: AuthedRequest, res) => {
  const updated = toggleBuiltInAutomation(String(req.params.id));
  if (!updated) return res.status(404).json({ error: 'automation_not_found' });
  audit(req.user!.id, req.user!.username, 'automation_toggled', updated.id, req.ip, { enabled: updated.enabled });
  res.json(updated);
});

export default r;
