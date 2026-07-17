import { Router } from 'express';
import { serviceStatuses, systemHealth } from '../services/monitoring.js';
import { transcodingStatus } from '../services/jellyfin.js';
import { db, getSetting, setSetting, audit } from '../lib/db.js';
import { requireAdmin, type AuthedRequest } from '../lib/auth.js';

const r = Router();
r.get('/health', async (_req, res, next) => { try { res.json(await systemHealth()); } catch (e) { next(e); } });
r.get('/services', async (_req, res, next) => { try { res.json(await serviceStatuses()); } catch (e) { next(e); } });
r.get('/transcoding', async (_req, res, next) => { try { res.json(await transcodingStatus()); } catch (e) { next(e); } });
r.get('/alerts', requireAdmin, (_req, res) => {
  const events = db.prepare('SELECT * FROM alert_events ORDER BY created_at DESC LIMIT 100').all();
  res.json({
    settings: {
      enabled: getSetting('service_alerts', 'true') === 'true',
      storagePct: Number(getSetting('storage_alert_pct', '90')),
      cpuPct: Number(getSetting('cpu_alert_pct', '95')),
      memoryPct: Number(getSetting('memory_alert_pct', '95')),
    }, events,
  });
});
r.post('/alerts/settings', requireAdmin, (req: AuthedRequest, res) => {
  const s = req.body || {};
  if (s.enabled !== undefined) setSetting('service_alerts', String(!!s.enabled));
  for (const [bodyKey, settingKey] of [['storagePct', 'storage_alert_pct'], ['cpuPct', 'cpu_alert_pct'], ['memoryPct', 'memory_alert_pct']] as const) {
    if (s[bodyKey] !== undefined) setSetting(settingKey, String(Math.max(50, Math.min(100, Number(s[bodyKey]) || 90))));
  }
  audit(req.user!.id, req.user!.username, 'alert_settings_changed');
  res.json({ ok: true });
});
r.get('/', async (_req, res, next) => {
  try {
    const [health, services] = await Promise.all([systemHealth(), serviceStatuses()]);
    res.json({ health, services });
  } catch (e) { next(e); }
});
export default r;
