// AI Image Studio — text-to-image, img2img/inpaint, generated gallery.
import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { type AuthedRequest } from '../lib/auth.js';
import { db, audit, notify } from '../lib/db.js';
import { config } from '../config.js';
import * as sd from '../services/images.js';

const r = Router();

r.get('/status', async (_req, res) => {
  const { status } = await import('../services/gpu.js');
  res.json({ available: await sd.available(), gpu: status() });
});

r.get('/gallery', (req: AuthedRequest, res) => {
  const rows = db.prepare('SELECT * FROM generated_images WHERE user_id=? ORDER BY created_at DESC LIMIT 200').all(req.user!.id) as any[];
  res.json(rows.map(g => ({
    id: g.id, prompt: g.prompt, url: `/api/images/file/${g.filename}`, thumbUrl: `/api/images/file/${g.filename}`,
    createdAt: g.created_at, width: g.width, height: g.height, workflow: g.workflow,
  })));
});

r.get('/file/:name', (req, res) => {
  const full = path.join(config.generatedDir, path.basename(req.params.name));
  if (!fs.existsSync(full)) return res.status(404).end();
  res.setHeader('Cache-Control', 'private, max-age=86400');
  res.sendFile(full);
});

function recordImages(userId: number, prompt: string, b64s: string[], w: number, h: number, workflow: string) {
  const out: any[] = [];
  for (const b64 of b64s) {
    const { filename } = sd.saveGenerated(userId, b64);
    const id = 'g_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    db.prepare('INSERT INTO generated_images (id,user_id,prompt,filename,width,height,workflow) VALUES (?,?,?,?,?,?,?)')
      .run(id, userId, prompt, filename, w, h, workflow);
    out.push({ id, prompt, url: `/api/images/file/${filename}`, thumbUrl: `/api/images/file/${filename}`, width: w, height: h, workflow });
  }
  return out;
}

r.post('/generate', async (req: AuthedRequest, res, next) => {
  try {
    if (!(await sd.available())) return res.status(503).json({ error: 'image_engine_offline' });
    const { prompt, negativePrompt, width, height, steps, cfgScale, batch } = req.body || {};
    audit(req.user!.id, req.user!.username, 'ai_image_generated', prompt);
    const images = await sd.txt2img({ prompt, negativePrompt, width, height, steps, cfgScale, batch: batch || 1 });
    const saved = recordImages(req.user!.id, prompt, images, width || 768, height || 768, 'txt2img');
    notify(req.user!.id, 'AI image ready', `Generated ${saved.length} image(s)`, 'success', '/ai-images');
    res.json({ images: saved });
  } catch (e) { next(e); }
});

r.post('/edit', async (req: AuthedRequest, res, next) => {
  try {
    if (!(await sd.available())) return res.status(503).json({ error: 'image_engine_offline' });
    const { initImage, maskImage, prompt, denoising, width, height } = req.body || {};
    audit(req.user!.id, req.user!.username, 'ai_edit_applied', prompt);
    const images = await sd.img2img(initImage, { prompt, maskB64: maskImage, denoising, width, height });
    const saved = recordImages(req.user!.id, prompt, images, width || 768, height || 768, maskImage ? 'inpaint' : 'img2img');
    res.json({ images: saved });
  } catch (e) { next(e); }
});

r.delete('/:id', (req: AuthedRequest, res) => {
  const g = db.prepare('SELECT * FROM generated_images WHERE id=? AND user_id=?').get(req.params.id, req.user!.id) as any;
  if (g) { try { fs.unlinkSync(path.join(config.generatedDir, g.filename)); } catch { /* */ } db.prepare('DELETE FROM generated_images WHERE id=?').run(g.id); }
  res.json({ ok: true });
});

// Save a generated image into the user's Files
r.post('/save-to-files', async (req: AuthedRequest, res, next) => {
  try {
    const { id, destDir } = req.body || {};
    const g = db.prepare('SELECT * FROM generated_images WHERE id=? AND user_id=?').get(id, req.user!.id) as any;
    if (!g) return res.status(404).json({ error: 'not_found' });
    const src = path.join(config.generatedDir, g.filename);
    const { resolve } = await import('../services/storage.js');
    const dest = resolve(req.user!.username, path.posix.join(destDir || '/AI Images', g.filename));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
    res.json({ ok: true, path: path.posix.join(destDir || '/AI Images', g.filename) });
  } catch (e) { next(e); }
});

export default r;
