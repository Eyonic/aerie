// AI Image Studio — text-to-image, img2img/inpaint, generated gallery.
import { Router } from 'express';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { type AuthedRequest } from '../lib/auth.js';
import { db, audit, notify } from '../lib/db.js';
import { config } from '../config.js';
import * as sd from '../services/images.js';
import { cachedWebp, imageWidth } from '../services/image-cache.js';
import crypto from 'node:crypto';
import * as writes from '../services/storage-write.js';
import { validateVirtualPath } from '../lib/validation.js';
import { saveGeneratedImages } from '../services/generated-media.js';

const r = Router();

r.get('/status', async (_req, res) => {
  const { status } = await import('../services/gpu.js');
  res.json({ available: await sd.available(), gpu: status() });
});

r.get('/gallery', (req: AuthedRequest, res) => {
  const rows = db.prepare('SELECT * FROM generated_images WHERE user_id=? ORDER BY created_at DESC LIMIT 200').all(req.user!.id) as any[];
  res.json(rows.map(g => ({
    id: g.id, prompt: g.prompt, url: `/api/images/file/${g.filename}`, thumbUrl: `/api/images/thumb/${g.filename}?w=640`,
    createdAt: g.created_at, width: g.width, height: g.height, workflow: g.workflow,
  })));
});

r.get('/thumb/:name', async (req: AuthedRequest, res, next) => {
  try {
    const name = path.basename(String(req.params.name));
    if (!db.prepare('SELECT 1 FROM generated_images WHERE filename=? AND user_id=?').get(name, req.user!.id)) {
      return res.status(404).end();
    }
    const full = path.join(config.generatedDir, name);
    const st = await fsp.stat(full);
    const width = imageWidth(req.query.w, 640, 1280);
    const cached = await cachedWebp({
      namespace: 'generated', key: name, source: full,
      sourceMtimeMs: st.mtimeMs, width, quality: 80,
    });
    res.setHeader('Content-Type', 'image/webp');
    res.setHeader('Cache-Control', 'private, max-age=604800, immutable');
    res.setHeader('X-Aerie-Image-Cache', cached.hit ? 'HIT' : 'MISS');
    res.sendFile(cached.file);
  } catch (e: any) {
    if (e?.code === 'ENOENT') return res.status(404).end();
    next(e);
  }
});

r.get('/file/:name', async (req: AuthedRequest, res) => {
  const name = path.basename(String(req.params.name));
  if (!db.prepare('SELECT 1 FROM generated_images WHERE filename=? AND user_id=?').get(name, req.user!.id)) return res.status(404).end();
  const full = path.join(config.generatedDir, name);
  if (!(await fsp.access(full).then(() => true, () => false))) return res.status(404).end();
  res.setHeader('Cache-Control', 'private, max-age=86400');
  res.sendFile(full);
});

r.post('/generate', async (req: AuthedRequest, res, next) => {
  try {
    if (!(await sd.available())) return res.status(503).json({ error: 'image_engine_offline' });
    const { prompt, negativePrompt, width, height, steps, cfgScale, batch } = req.body || {};
    const cleanPrompt = String(prompt || '').trim().slice(0, 4000);
    if (!cleanPrompt) return res.status(400).json({ error: 'prompt_required' });
    const cleanWidth = Math.round(Math.min(2048, Math.max(256, Number(width) || 768)) / 64) * 64;
    const cleanHeight = Math.round(Math.min(2048, Math.max(256, Number(height) || 768)) / 64) * 64;
    const cleanSteps = Math.min(100, Math.max(1, Number(steps) || 24));
    const cleanCfg = Math.min(30, Math.max(0, Number(cfgScale) || 7));
    const cleanBatch = Math.min(4, Math.max(1, Math.floor(Number(batch) || 1)));
    audit(req.user!.id, req.user!.username, 'ai_image_generated', cleanPrompt.slice(0, 200));
    const images = await sd.txt2img({ prompt: cleanPrompt, negativePrompt: String(negativePrompt || '').slice(0, 4000),
      width: cleanWidth, height: cleanHeight, steps: cleanSteps, cfgScale: cleanCfg, batch: cleanBatch });
    const saved = await saveGeneratedImages(req.user!, cleanPrompt, images, cleanWidth, cleanHeight, 'txt2img');
    notify(req.user!.id, 'AI image ready', `Generated ${saved.length} image(s)`, 'success', '/ai-images');
    res.json({ images: saved });
  } catch (e) { next(e); }
});

r.post('/edit', async (req: AuthedRequest, res, next) => {
  try {
    if (!(await sd.available())) return res.status(503).json({ error: 'image_engine_offline' });
    const { initImage, maskImage, prompt, denoising, width, height } = req.body || {};
    const cleanPrompt = String(prompt || '').trim().slice(0, 4000);
    if (!cleanPrompt || typeof initImage !== 'string' || initImage.length > 32 * 1024 * 1024
      || (maskImage && (typeof maskImage !== 'string' || maskImage.length > 32 * 1024 * 1024))) {
      return res.status(400).json({ error: 'invalid_image_edit' });
    }
    const cleanWidth = Math.round(Math.min(2048, Math.max(256, Number(width) || 768)) / 64) * 64;
    const cleanHeight = Math.round(Math.min(2048, Math.max(256, Number(height) || 768)) / 64) * 64;
    audit(req.user!.id, req.user!.username, 'ai_edit_applied', cleanPrompt.slice(0, 200));
    const images = await sd.img2img(initImage, { prompt: cleanPrompt, maskB64: maskImage,
      denoising: Math.min(1, Math.max(0, Number(denoising) || 0.65)), width: cleanWidth, height: cleanHeight });
    const saved = await saveGeneratedImages(req.user!, cleanPrompt, images, cleanWidth, cleanHeight, maskImage ? 'inpaint' : 'img2img');
    res.json({ images: saved });
  } catch (e) { next(e); }
});

r.delete('/:id', async (req: AuthedRequest, res, next) => {
  try {
    const g = db.prepare('SELECT * FROM generated_images WHERE id=? AND user_id=?').get(req.params.id, req.user!.id) as any;
    if (g) {
      await fsp.rm(path.join(config.generatedDir, g.filename), { force: true }).catch(() => {});
      db.prepare('DELETE FROM generated_images WHERE id=?').run(g.id);
    }
    res.json({ ok: true });
  } catch (error) { next(error); }
});

// Save a generated image into the user's Files
r.post('/save-to-files', async (req: AuthedRequest, res, next) => {
  try {
    const { id } = req.body || {};
    const destDir = validateVirtualPath(String(req.body?.destDir || '/AI Images'), { allowRoot: true });
    const g = db.prepare('SELECT * FROM generated_images WHERE id=? AND user_id=?').get(id, req.user!.id) as any;
    if (!g) return res.status(404).json({ error: 'not_found' });
    const src = path.join(config.generatedDir, g.filename);
    const destination = path.posix.join(destDir, g.filename);
    const { resolveAsync } = await import('../services/storage.js');
    const dest = await resolveAsync(req.user!.username, destination);
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    const temp = path.join(path.dirname(dest), `.aerie-image-copy-${crypto.randomUUID()}.tmp`);
    try {
      await fsp.copyFile(src, temp, fs.constants.COPYFILE_EXCL | fs.constants.COPYFILE_FICLONE);
      const result = await writes.commitTempFile({ user: req.user!, virtualPath: destination, tempPath: temp,
        expectedRevision: '*', createVersion: false });
      res.status(201).json({ ok: true, path: destination, revision: result.revision });
    } finally { await fsp.rm(temp, { force: true }).catch(() => {}); }
  } catch (e) { next(e); }
});

export default r;
