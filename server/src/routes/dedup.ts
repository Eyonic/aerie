import { Router } from 'express';
import { type AuthedRequest } from '../lib/auth.js';
import * as dedup from '../services/dedup.js';

const r = Router();

function u(req: AuthedRequest) { return req.user!; }

r.post('/scan', (req: AuthedRequest, res) => {
  res.json({ jobId: dedup.scan(u(req)) });
});

r.post('/remove', (req: AuthedRequest, res) => {
  res.json({ jobId: dedup.remove(u(req)) });
});

r.get('/job/:id', (req: AuthedRequest, res) => {
  const st = dedup.jobStatus(u(req), String(req.params.id));
  if (!st) return res.status(404).json({ error: 'not_found' });
  res.json(st);
});

r.get('/last', (req: AuthedRequest, res) => {
  res.json(dedup.last(u(req)) || { type: null, status: 'idle', progress: 0, result: null });
});

export default r;
