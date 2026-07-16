import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { type AuthedRequest } from '../lib/auth.js';
import { db } from '../lib/db.js';
import { config } from '../config.js';
import * as subs from '../services/subtitles.js';

const r = Router();

function jobJson(row: any) {
  let subtitleId: string | undefined;
  try { subtitleId = JSON.parse(row.result_urls || '[]')?.[0]; } catch { /* */ }
  const kind = String(row.prompt || '').split(':', 1)[0];
  const action = kind === 'translate' ? 'Translating' : kind === 'sync' ? 'Syncing' : 'Generating';
  return {
    id: row.id,
    action,
    status: row.status,
    progress: Number(row.progress || 0),
    error: row.error || undefined,
    subtitleId,
  };
}

r.get('/item/:itemId', (req, res) => {
  res.json({ subtitles: subs.list(req.params.itemId) });
});

r.post('/generate', (req: AuthedRequest, res) => {
  const { itemId } = req.body || {};
  if (!itemId) return res.status(400).json({ error: 'itemId_required' });
  res.json({ jobId: subs.generateSubtitles(String(itemId), req.user!.id) });
});

r.post('/translate', (req: AuthedRequest, res) => {
  const { itemId, source, lang } = req.body || {};
  if (!itemId || !source) return res.status(400).json({ error: 'itemId_source_required' });
  res.json({ jobId: subs.translateSubtitles(String(itemId), source, lang ? String(lang) : undefined, req.user!.id) });
});

r.post('/sync', (req: AuthedRequest, res) => {
  const { itemId, source } = req.body || {};
  if (!itemId || !source) return res.status(400).json({ error: 'itemId_source_required' });
  res.json({ jobId: subs.syncSubtitles(String(itemId), source, req.user!.id) });
});

r.post('/cleanup', async (req: AuthedRequest, res, next) => {
  try {
    const { itemId, source } = req.body || {};
    if (!itemId || !source) return res.status(400).json({ error: 'itemId_source_required' });
    res.json({ subtitle: await subs.cleanSubtitles(String(itemId), source, req.user!.id) });
  } catch (e) { next(e); }
});

r.get('/job/:id', (req: AuthedRequest, res) => {
  const row = db.prepare('SELECT * FROM jobs WHERE id=? AND user_id=? AND type=?').get(req.params.id, req.user!.id, 'subtitles') as any;
  if (!row) return res.status(404).json({ error: 'not_found' });
  res.json(jobJson(row));
});

// Let the player recover a long-running job after it is closed/reopened or the
// page is refreshed. Subtitle generation can take a while for a full movie.
r.get('/active/:itemId', (req: AuthedRequest, res) => {
  const itemId = String(req.params.itemId);
  const row = db.prepare(`
    SELECT * FROM jobs
    WHERE user_id=? AND type='subtitles' AND status IN ('queued','running')
      AND (prompt=? OR prompt LIKE ? OR prompt=?)
    ORDER BY created_at DESC LIMIT 1
  `).get(req.user!.id, `generate:${itemId}`, `translate:${itemId}:%`, `sync:${itemId}`) as any;
  res.json({ job: row ? jobJson(row) : null });
});

r.get('/file/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM subtitles WHERE id=?').get(req.params.id) as any;
  if (!row) return res.status(404).end();
  const file = path.join(config.subtitlesDir, path.basename(row.filename));
  if (!fs.existsSync(file)) return res.status(404).end();
  res.setHeader('Content-Type', 'text/vtt; charset=utf-8');
  res.setHeader('Cache-Control', 'private, max-age=86400');
  res.sendFile(file);
});

r.delete('/:id', (req: AuthedRequest, res) => {
  const row = db.prepare('SELECT * FROM subtitles WHERE id=?').get(req.params.id) as any;
  if (!row) return res.json({ ok: true });
  if (row.created_by !== req.user!.id && req.user!.role !== 'admin') return res.status(403).json({ error: 'forbidden' });
  try { fs.unlinkSync(path.join(config.subtitlesDir, path.basename(row.filename))); } catch { /* */ }
  db.prepare('DELETE FROM subtitles WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

export default r;
