// Native app downloads catalog. Reports which installers are available.
import { Router } from 'express';
import { config } from '../config.js';
import { releaseCatalog } from '../services/release-catalog.js';

const r = Router();

r.get('/', async (_req, res, next) => {
  try {
    res.setHeader('Cache-Control', 'public, max-age=60, must-revalidate');
    res.json(await releaseCatalog(config.downloadsDir));
  } catch (error) {
    next(error);
  }
});

export default r;
