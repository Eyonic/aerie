// Aerie API server. Serves the built web app + all /api routes.
import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { authMiddleware } from './lib/auth.js';
import './lib/db.js'; // init + seed

import authRouter from './routes/auth.js';
import dashboardRouter from './routes/dashboard.js';
import filesRouter from './routes/files.js';
import photosRouter from './routes/photos.js';
import mediaRouter from './routes/media.js';
import booksRouter from './routes/books.js';
import docsRouter from './routes/docs.js';
import sheetsRouter from './routes/sheets.js';
import aiRouter from './routes/ai.js';
import imagesRouter from './routes/images.js';
import searchRouter from './routes/search.js';
import sharesRouter from './routes/shares.js';
import adminRouter from './routes/admin.js';
import monitoringRouter from './routes/monitoring.js';
import backupsRouter from './routes/backups.js';
import activityRouter from './routes/activity.js';
import automationsRouter from './routes/automations.js';
import devicesRouter from './routes/devices.js';
import notificationsRouter from './routes/notifications.js';
import settingsRouter from './routes/settings.js';
import integrationsRouter, { loadIntegrationOverrides } from './routes/integrations.js';
import appsRouter from './routes/apps.js';
import requestsRouter from './routes/requests.js';
import musicGenRouter from './routes/musicgen.js';
import castRouter, { castStreamRouter } from './routes/cast.js';
import historyRouter from './routes/history.js';
import subtitlesRouter from './routes/subtitles.js';
import syncRouter from './routes/sync.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(cors());
app.use(cookieParser());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Public
// NOTE: `compat: 'CloudBox'` is the legacy Android captive-portal marker —
// old installed apps probe /api/health for the literal string "CloudBox" and
// it must NEVER be removed (and it must stay within the first 256 bytes of
// the response — the probe only reads that much). publicUrl/lanUrl are the
// operator-configured addresses: the web UI uses publicUrl for HTTPS hints,
// and the native apps merge both into their failover origin list.
app.get('/api/health', (_req, res) => res.json({
  ok: true, name: 'Aerie', compat: 'CloudBox', version: '1.0.0',
  publicUrl: config.publicUrl, lanUrl: config.lanUrl, translateLang: config.translateLang,
}));
app.use('/api/auth', authRouter);
app.use('/api/shares', sharesRouter); // has both public (link view) + authed subroutes
app.use('/api/apps', appsRouter);     // public downloads catalog
app.use('/api/cast-stream', castStreamRouter); // token-authed media proxy for cast TVs

// Native app installers — public static (a browser download can't send auth headers).
fs.mkdirSync(config.downloadsDir, { recursive: true });
app.use('/downloads', express.static(config.downloadsDir));

// Everything below requires auth
app.use('/api', authMiddleware);
app.use('/api/dashboard', dashboardRouter);
app.use('/api/files', filesRouter);
app.use('/api/photos', photosRouter);
app.use('/api/media', mediaRouter);
app.use('/api/books', booksRouter);
app.use('/api/docs', docsRouter);
app.use('/api/sheets', sheetsRouter);
app.use('/api/ai', aiRouter);
app.use('/api/images', imagesRouter);
app.use('/api/search', searchRouter);
app.use('/api/admin', adminRouter);
app.use('/api/monitoring', monitoringRouter);
app.use('/api/backups', backupsRouter);
app.use('/api/activity', activityRouter);
app.use('/api/automations', automationsRouter);
app.use('/api/devices', devicesRouter);
app.use('/api/notifications', notificationsRouter);
app.use('/api/settings', settingsRouter);
app.use('/api/integrations', integrationsRouter);
// Re-apply integration settings saved from the UI (override > env from here on).
loadIntegrationOverrides();
app.use('/api/requests', requestsRouter);
app.use('/api/music-gen', musicGenRouter);
app.use('/api/cast', castRouter);
app.use('/api/history', historyRouter);
app.use('/api/subtitles', subtitlesRouter);
app.use('/api/sync', syncRouter);

// Serve built web app (SPA)
const webDist = path.resolve(__dirname, '../../web/dist');
if (fs.existsSync(webDist)) {
  app.use(express.static(webDist));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api/')) return next();
    res.sendFile(path.join(webDist, 'index.html'));
  });
}

// Error handler
app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const status = err.status || 500;
  if (status >= 500) console.error('[error]', err);
  res.status(status).json({ error: err.message || 'server_error' });
});

app.listen(config.port, () => {
  console.log(`Aerie API listening on :${config.port}`);
  console.log(`  data:  ${config.dataDir}`);
  console.log(`  files: ${config.filesRoot}`);
  console.log(`  media: ${config.mediaRoot}`);
  import('./services/scheduler.js').then(s => s.startScheduler()).catch(() => {});
});
