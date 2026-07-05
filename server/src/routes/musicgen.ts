// AI Music Studio — generate music with ACE-Step. Async job model.
import { Router } from 'express';
import fs from 'node:fs';
import { type AuthedRequest } from '../lib/auth.js';
import { db, audit, notify } from '../lib/db.js';
import * as mg from '../services/musicgen.js';

const r = Router();

r.get('/status', async (_req, res) => {
  const { status } = await import('../services/gpu.js');
  res.json({ ...(await mg.available()), gpu: status() });
});

function mapRow(m: any) {
  return { id: m.id, prompt: m.prompt, lyrics: m.lyrics, status: m.status,
    url: m.filename ? `/api/music-gen/audio/${m.filename}` : null,
    durationSec: m.duration_sec, error: m.error, createdAt: m.created_at };
}

r.get('/tracks', (req: AuthedRequest, res) => {
  const rows = db.prepare('SELECT * FROM generated_music WHERE user_id=? ORDER BY created_at DESC LIMIT 100').all(req.user!.id) as any[];
  res.json(rows.map(mapRow));
});

r.get('/audio/:filename', (req, res) => {
  const p = mg.storedPath(req.params.filename);
  if (!fs.existsSync(p)) return res.status(404).end();
  res.setHeader('Content-Type', 'audio/mpeg');
  res.setHeader('Accept-Ranges', 'bytes');
  res.sendFile(p);
});

r.post('/generate', async (req: AuthedRequest, res, next) => {
  try {
    const { prompt, lyrics, durationSec, steps, guidance } = req.body || {};
    if (!prompt || !String(prompt).trim()) return res.status(400).json({ error: 'prompt_required' });
    const id = 'm_' + Math.random().toString(36).slice(2, 10);
    db.prepare('INSERT INTO generated_music (id,user_id,prompt,lyrics,duration_sec,status) VALUES (?,?,?,?,?,?)')
      .run(id, req.user!.id, prompt, lyrics || null, durationSec || 30, 'running');
    audit(req.user!.id, req.user!.username, 'music_generated', prompt);
    // run async; the UI polls /tracks
    (async () => {
      try {
        const { audioPath } = await mg.generate({ prompt, lyrics, durationSec, steps, guidance });
        const filename = await mg.fetchAndStore(req.user!.id, audioPath);
        db.prepare("UPDATE generated_music SET status='done', filename=? WHERE id=?").run(filename, id);
        notify(req.user!.id, 'Music ready', `"${String(prompt).slice(0, 40)}" finished`, 'success', '/music-studio');
      } catch (e: any) {
        db.prepare("UPDATE generated_music SET status='error', error=? WHERE id=?").run(String(e.message).slice(0, 300), id);
      }
    })();
    res.json({ id, status: 'running' });
  } catch (e) { next(e); }
});

r.delete('/:id', (req: AuthedRequest, res) => {
  const m = db.prepare('SELECT * FROM generated_music WHERE id=? AND user_id=?').get(req.params.id, req.user!.id) as any;
  if (m?.filename) { try { fs.unlinkSync(mg.storedPath(m.filename)); } catch { /* */ } }
  db.prepare('DELETE FROM generated_music WHERE id=? AND user_id=?').run(req.params.id, req.user!.id);
  res.json({ ok: true });
});

export default r;
