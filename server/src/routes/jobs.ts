import { Router } from 'express';
import { type AuthedRequest } from '../lib/auth.js';
import { db } from '../lib/db.js';

const r = Router();

function parsed(value: string | null) {
  if (!value) return undefined;
  try { return JSON.parse(value); } catch { return undefined; }
}

r.get('/', (req: AuthedRequest, res) => {
  const limit = Math.min(200, Math.max(10, Number(req.query.limit) || 100));
  const rows = db.prepare(`SELECT id,type,status,prompt,progress,result_urls resultUrls,error,
    created_at createdAt,finished_at finishedAt FROM jobs WHERE user_id=?
    ORDER BY CASE status WHEN 'running' THEN 0 WHEN 'queued' THEN 1 ELSE 2 END,created_at DESC LIMIT ?`)
    .all(req.user!.id, limit) as any[];
  const music = db.prepare(`SELECT id,'music' type,status,prompt,
    CASE WHEN status='done' THEN 1 ELSE 0 END progress,NULL resultUrls,error,
    created_at createdAt,NULL finishedAt FROM generated_music WHERE user_id=? ORDER BY created_at DESC LIMIT 30`)
    .all(req.user!.id) as any[];
  const items = [...rows, ...music]
    .sort((a, b) => ((a.status === 'running' ? 0 : a.status === 'queued' ? 1 : 2) - (b.status === 'running' ? 0 : b.status === 'queued' ? 1 : 2)) || String(b.createdAt).localeCompare(String(a.createdAt)))
    .slice(0, limit)
    .map(j => ({ ...j, progress: Number(j.progress || 0), result: parsed(j.resultUrls), resultUrls: undefined }));
  res.json({ items, active: items.filter(j => j.status === 'queued' || j.status === 'running').length });
});

export default r;
