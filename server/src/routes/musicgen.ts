// AI Music Studio — generate music with ACE-Step. Async job model.
import { Router } from 'express';
import { type AuthedRequest } from '../lib/auth.js';
import * as mg from '../services/musicgen.js';
import {
  deleteMusicTrack,
  enqueueMusicJob,
  listMusicTracks,
  musicAudioPath,
} from '../services/music-jobs.js';

const r = Router();

r.get('/status', async (_req, res) => {
  const { status } = await import('../services/gpu.js');
  res.json({ ...(await mg.available()), gpu: status() });
});

r.get('/tracks', (req: AuthedRequest, res) => {
  res.json(listMusicTracks(req.user!.id));
});

r.get('/audio/:filename', async (req: AuthedRequest, res) => {
  const p = await musicAudioPath(req.user!.id, req.params.filename);
  if (!p) return res.status(404).end();
  res.setHeader('Content-Type', 'audio/mpeg');
  res.setHeader('Accept-Ranges', 'bytes');
  res.sendFile(p);
});

r.post('/generate', async (req: AuthedRequest, res, next) => {
  try {
    res.json(enqueueMusicJob(req.user!, req.body || {}));
  } catch (e) { next(e); }
});

r.delete('/:id', async (req: AuthedRequest, res, next) => {
  try { res.json(await deleteMusicTrack(req.user!.id, req.params.id)); }
  catch (error) { next(error); }
});

export default r;
