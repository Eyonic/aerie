import { Router } from 'express';
import { serviceStatuses, systemHealth } from '../services/monitoring.js';

const r = Router();
r.get('/health', async (_req, res, next) => { try { res.json(await systemHealth()); } catch (e) { next(e); } });
r.get('/services', async (_req, res, next) => { try { res.json(await serviceStatuses()); } catch (e) { next(e); } });
r.get('/', async (_req, res, next) => {
  try {
    const [health, services] = await Promise.all([systemHealth(), serviceStatuses()]);
    res.json({ health, services });
  } catch (e) { next(e); }
});
export default r;
