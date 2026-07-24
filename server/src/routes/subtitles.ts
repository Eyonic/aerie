import { Router } from 'express';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { type AuthedRequest } from '../lib/auth.js';
import { audit, db } from '../lib/db.js';
import { config } from '../config.js';
import * as subs from '../services/subtitles.js';
import {
  assertTranslationProviderAllowed, configuredTranslationTarget, getTranslationPreferences,
} from '../services/translation-preferences.js';

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

function jobItemId(row: any): string | null {
  try {
    const itemId = JSON.parse(String(row.payload || '{}'))?.itemId;
    if (itemId) return String(itemId);
  } catch { /* fall through to legacy prompt */ }
  const match = /^(?:generate|translate|sync):([^:]+)/.exec(String(row.prompt || ''));
  return match?.[1] || null;
}

r.get('/item/:itemId', async (req: AuthedRequest, res, next) => {
  try {
    const itemId = String(req.params.itemId);
    await subs.authorizeSubtitleItem(req.user!.id, itemId);
    res.json({ subtitles: subs.list(itemId, req.user!.id) });
  } catch (error) { next(error); }
});

r.post('/generate', async (req: AuthedRequest, res, next) => {
  try {
    const { itemId } = req.body || {};
    if (!itemId) return res.status(400).json({ error: 'itemId_required' });
    await subs.authorizeSubtitleItem(req.user!.id, String(itemId));
    res.json({ jobId: subs.generateSubtitles(String(itemId), req.user!.id) });
  } catch (error) { next(error); }
});

r.post('/translate', async (req: AuthedRequest, res, next) => {
  try {
    const { itemId, source, lang } = req.body || {};
    if (!itemId || !source) return res.status(400).json({ error: 'itemId_source_required' });
    await subs.authorizeSubtitleItem(req.user!.id, String(itemId));
    const preferences = getTranslationPreferences(req.user!.id);
    const targetLanguage = configuredTranslationTarget(req.user!.id, lang || preferences.languages[0]);
    const provider = assertTranslationProviderAllowed(req.user!.id, preferences.provider);
    const jobId = subs.translateSubtitles(String(itemId), source, targetLanguage, req.user!.id, provider);
    audit(req.user!.id, req.user!.username, 'subtitle_translation_queued', String(itemId), req.ip, {
      targetLanguage, provider,
    });
    res.json({ jobId, targetLanguage, provider });
  } catch (error) { next(error); }
});

r.post('/sync', async (req: AuthedRequest, res, next) => {
  try {
    const { itemId, source } = req.body || {};
    if (!itemId || !source) return res.status(400).json({ error: 'itemId_source_required' });
    await subs.authorizeSubtitleItem(req.user!.id, String(itemId));
    res.json({ jobId: subs.syncSubtitles(String(itemId), source, req.user!.id) });
  } catch (error) { next(error); }
});

r.post('/cleanup', async (req: AuthedRequest, res, next) => {
  try {
    const { itemId, source } = req.body || {};
    if (!itemId || !source) return res.status(400).json({ error: 'itemId_source_required' });
    await subs.authorizeSubtitleItem(req.user!.id, String(itemId));
    res.json({ subtitle: await subs.cleanSubtitles(String(itemId), source, req.user!.id) });
  } catch (e) { next(e); }
});

r.get('/job/:id', async (req: AuthedRequest, res, next) => {
  try {
    const row = db.prepare('SELECT * FROM jobs WHERE id=? AND user_id=? AND type=?').get(req.params.id, req.user!.id, 'subtitles') as any;
    if (!row) return res.status(404).json({ error: 'not_found' });
    const itemId = jobItemId(row);
    if (!itemId) throw Object.assign(new Error('subtitle_item_unknown'), { status: 409 });
    await subs.authorizeSubtitleItem(req.user!.id, itemId);
    res.json(jobJson(row));
  } catch (error) { next(error); }
});

// Let the player recover a long-running job after it is closed/reopened or the
// page is refreshed. Subtitle generation can take a while for a full movie.
r.get('/active/:itemId', async (req: AuthedRequest, res, next) => {
  try {
    const itemId = String(req.params.itemId);
    await subs.authorizeSubtitleItem(req.user!.id, itemId);
    const row = db.prepare(`
      SELECT * FROM jobs
      WHERE user_id=? AND type='subtitles' AND status IN ('queued','running')
        AND (prompt=? OR prompt LIKE ? OR prompt=?)
      ORDER BY created_at DESC LIMIT 1
    `).get(req.user!.id, `generate:${itemId}`, `translate:${itemId}:%`, `sync:${itemId}`) as any;
    res.json({ job: row ? jobJson(row) : null });
  } catch (error) { next(error); }
});

r.get('/file/:id', async (req: AuthedRequest, res, next) => {
  try {
    const row = db.prepare('SELECT * FROM subtitles WHERE id=? AND created_by=?').get(req.params.id, req.user!.id) as any;
    if (!row) return res.status(404).end();
    await subs.authorizeSubtitleItem(req.user!.id, String(row.item_id));
    const file = path.join(config.subtitlesDir, path.basename(row.filename));
    try { await fsp.access(file); } catch { return res.status(404).end(); }
    res.setHeader('Content-Type', 'text/vtt; charset=utf-8');
    res.setHeader('Cache-Control', 'private, max-age=86400');
    res.sendFile(file, (error: any) => { if (error) next(error); });
  } catch (error) { next(error); }
});

r.delete('/:id', async (req: AuthedRequest, res, next) => {
  try {
    const row = db.prepare('SELECT * FROM subtitles WHERE id=?').get(req.params.id) as any;
    if (!row) return res.json({ ok: true });
    if (row.created_by !== req.user!.id && req.user!.role !== 'admin') return res.status(403).json({ error: 'forbidden' });
    await subs.authorizeSubtitleItem(req.user!.id, String(row.item_id));
    await fsp.rm(path.join(config.subtitlesDir, path.basename(row.filename)), { force: true });
    db.prepare('DELETE FROM subtitles WHERE id=?').run(req.params.id);
    res.json({ ok: true });
  } catch (error) { next(error); }
});

export default r;
