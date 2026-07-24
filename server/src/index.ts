// Aerie API server. Serves the built web app + all /api routes.
import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import compression from 'compression';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { privateCanary } from './runtime-mode.js';
import { authMiddleware, csrfProtection, requireFeature } from './lib/auth.js';
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
import autorequestRouter from './routes/autorequest.js';
import musicGenRouter from './routes/musicgen.js';
import castRouter, { castStreamRouter } from './routes/cast.js';
import tilesRouter from './routes/tiles.js';
import historyRouter from './routes/history.js';
import subtitlesRouter from './routes/subtitles.js';
import syncRouter from './routes/sync.js';
import dedupRouter from './routes/dedup.js';
import jobsRouter from './routes/jobs.js';
import carRouter, { carArtworkRouter } from './routes/car.js';
import driveRouter, { webdavRouter } from './routes/drive.js';
import deviceTrustRouter, { publicDevicePairingRouter } from './routes/device-trust.js';
import deviceFabricRouter, { closeDeviceFabricStreams } from './routes/device-fabric.js';
import timeMachineRouter from './routes/time-machine.js';
import capabilitiesRouter from './routes/capabilities.js';
import { reconcilePolicyState, requireAiPolicy } from './services/policy.js';
import { reconcileInterruptedStorageOperations } from './services/storage-write.js';
import { recoverMusicJobs } from './services/music-jobs.js';
import { db } from './lib/db.js';
import { AERIE_VERSION } from './version.js';
import { closeAllStreams as closeNotificationStreams } from './services/events.js';
import { beginHttpDrain } from './services/http-shutdown.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', config.trustProxy);
app.use((req, res, next) => {
  const requestId = crypto.randomUUID();
  (req as any).requestId = requestId;
  res.setHeader('X-Request-ID', requestId);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(self), microphone=(self), geolocation=(self), payment=()');
  res.setHeader('Content-Security-Policy', "default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; font-src 'self' data:; connect-src 'self' ws: wss:; worker-src 'self' blob:; manifest-src 'self'");
  if (req.secure) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  next();
});
app.use(cors({
  credentials: true,
  origin(origin, callback) {
    if (!origin) return callback(null, true);
    const allowed = new Set(config.corsOrigins);
    for (const value of [config.publicUrl, config.lanUrl]) {
      try { if (value) allowed.add(new URL(value).origin); } catch { /* ignore invalid configured URL */ }
    }
    callback(null, allowed.has(origin));
  },
}));
app.use(cookieParser());
// WebDAV PUT bodies are arbitrary file bytes (including application/json and
// application/x-www-form-urlencoded files). Mount Drive before Express body
// parsers so no content type can be consumed or rewritten before it streams to
// the atomic upload path.
app.use('/dav', webdavRouter);        // self-authenticated mountable Aerie Drive
app.use(compression({ threshold: 1024 }));
// Authenticate before parsing the two intentionally large JSON payloads. All
// other endpoints use a small global ceiling so an anonymous request cannot
// make the process allocate tens of megabytes before authorization runs.
app.use('/api/files/content', authMiddleware, csrfProtection, requireFeature('files'), express.json({ limit: '35mb' }));
app.use('/api/shares/account/:id/content', authMiddleware, csrfProtection, requireFeature('files'), express.json({ limit: '35mb' }));
app.use('/api/images/edit', authMiddleware, csrfProtection, requireFeature('ai'), requireAiPolicy, express.json({ limit: '66mb' }));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '256kb' }));

// Public
// NOTE: `compat: 'CloudBox'` is the legacy Android captive-portal marker —
// old installed apps probe /api/health for the literal string "CloudBox" and
// it must NEVER be removed (and it must stay within the first 256 bytes of
// the response — the probe only reads that much). publicUrl/lanUrl are the
// operator-configured addresses: the web UI uses publicUrl for HTTPS hints,
// and the native apps merge both into their failover origin list.
app.get('/api/health', (_req, res) => {
  try {
    db.prepare('SELECT 1').get();
    res.setHeader('Cache-Control', 'no-store');
    res.json({
      ok: true, name: 'Aerie', compat: 'CloudBox', version: AERIE_VERSION,
      privateCanary,
      publicUrl: config.publicUrl, lanUrl: config.lanUrl,
    });
  } catch {
    res.status(503).json({ ok: false, name: 'Aerie', compat: 'CloudBox', error: 'database_unavailable' });
  }
});
app.use('/api/auth', authRouter);
app.use('/api/shares', sharesRouter); // has both public (link view) + authed subroutes
app.use('/api/apps', appsRouter);     // public downloads catalog
app.use('/api/cast-stream', castStreamRouter); // token-authed media proxy for cast TVs
app.use('/api/device-pairing', publicDevicePairingRouter); // short-lived native pairing ceremony
app.use('/api/car-artwork', carArtworkRouter); // short-lived, exact-resource Android Auto artwork capabilities
app.use('/tiles', authMiddleware, tilesRouter); // authenticated map-tile proxy

// Native app installers — public static (a browser download can't send auth headers).
fs.mkdirSync(config.downloadsDir, { recursive: true });
app.use('/downloads', express.static(config.downloadsDir));

// Everything below requires auth
app.use('/api', authMiddleware);
app.use('/api', csrfProtection);
app.use('/api/dashboard', dashboardRouter);
app.use('/api/capabilities', capabilitiesRouter);
app.use('/api/files', requireFeature('files'), filesRouter);
app.use('/api/photos', requireFeature('photos'), photosRouter);
app.use('/api/media', mediaRouter);
app.use('/api/books', booksRouter);
app.use('/api/docs', requireFeature('create'), docsRouter);
app.use('/api/sheets', requireFeature('create'), sheetsRouter);
app.use('/api/ai', requireFeature('ai'), requireAiPolicy, aiRouter);
app.use('/api/images', requireFeature('ai'), requireAiPolicy, imagesRouter);
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
app.use('/api/requests', requireFeature('requests'), requestsRouter);
app.use('/api/autorequest', requireFeature('requests'), autorequestRouter);
app.use('/api/music-gen', requireFeature('ai'), requireAiPolicy, musicGenRouter);
app.use('/api/cast', castRouter);
app.use('/api/history', historyRouter);
app.use('/api/subtitles', requireFeature('ai'), requireAiPolicy, subtitlesRouter);
app.use('/api/sync', requireFeature('sync'), syncRouter);
app.use('/api/dedup', requireFeature('sync'), dedupRouter);
app.use('/api/jobs', jobsRouter);
app.use('/api/car', carRouter);
app.use('/api/drive', requireFeature('files'), driveRouter);
app.use('/api/device-trust', deviceTrustRouter);
app.use('/api/device-fabric', deviceFabricRouter);
app.use('/api/time-machine', requireFeature('files'), timeMachineRouter);

// Serve built web app (SPA)
const webDist = path.resolve(__dirname, '../../web/dist');
if (fs.existsSync(webDist)) {
  // Vite filenames under /assets are content-hashed, so they can be cached
  // permanently.  HTML must always revalidate so a deploy is picked up at once.
  app.use('/assets', express.static(path.join(webDist, 'assets'), { maxAge: '1y', immutable: true }));
  app.use(express.static(webDist, {
    maxAge: '7d',
    setHeaders: (res, file) => {
      if (path.basename(file) === 'index.html') res.setHeader('Cache-Control', 'no-cache');
    },
  }));
  app.get('/{*splat}', (req, res, next) => {
    if (req.path.startsWith('/api/')) return next();
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(path.join(webDist, 'index.html'));
  });
}

// Error handler
app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
  if (res.headersSent) return next(err);
  const hasExplicitStatus = Number(err?.status) >= 400 && Number(err?.status) <= 599;
  const status = hasExplicitStatus ? Number(err.status) : 500;
  const requestId = String((req as any).requestId || crypto.randomUUID());
  if (status >= 500) console.error(`[error ${requestId}]`, err);
  const candidate = String(err?.message || 'server_error');
  const safeCode = /^[a-z][a-z0-9_]{1,100}$/i.test(candidate);
  const fallback = status >= 500 ? 'server_error'
    : status === 400 ? 'bad_request'
      : status === 401 ? 'unauthorized'
        : status === 403 ? 'forbidden'
          : status === 404 ? 'not_found'
            : status === 413 ? 'request_too_large'
              : 'request_failed';
  const body: Record<string, unknown> = {
    // Only errors that deliberately carry an HTTP status may expose their
    // machine-readable code. Parser, filesystem, database and programmer
    // errors can otherwise echo request contents or infrastructure details.
    error: hasExplicitStatus && safeCode ? candidate : fallback,
    ...(status >= 500 ? { requestId } : {}),
  };
  for (const key of ['currentRevision', 'maxBytes', 'usedBytes', 'reservedBytes', 'requestedBytes', 'quotaBytes', 'availableBytes']) {
    if (err[key] !== undefined) body[key] = err[key];
  }
  res.status(status).json(body);
});

async function start() {
  reconcilePolicyState();
  if (!privateCanary) {
    await reconcileInterruptedStorageOperations();
    recoverMusicJobs();
  }
  let schedulerModule: Promise<typeof import('./services/scheduler.js')> | undefined;
  let shutdownStarted = false;
  const server = app.listen(config.port, () => {
    console.log(`Aerie API listening on :${config.port}`);
    console.log(`  data:  ${config.dataDir}`);
    console.log(`  files: ${config.filesRoot}`);
    console.log(`  media: ${config.mediaRoot}`);
    if (!privateCanary) {
      schedulerModule = import('./services/scheduler.js');
      schedulerModule
        .then(s => { if (!shutdownStarted) s.startScheduler(); })
        .catch(error => console.error('[scheduler]', error));
    } else {
      console.log('private canary mode: background work and filesystem recovery disabled');
    }
  });
  const shutdown = async (signal: string) => {
    if (shutdownStarted) return;
    shutdownStarted = true;
    console.log(`[shutdown] ${signal}; draining HTTP connections`);
    // Docker grants the process 30 seconds. Keep a small margin so our own
    // diagnostics and exit status are authoritative instead of SIGKILL.
    const forcedExit = setTimeout(() => {
      console.error('[shutdown] graceful drain timed out');
      process.exit(1);
    }, 28_000);
    forcedExit.unref();

    const { closedStreams, drained: httpDrain } = beginHttpDrain(
      server,
      [closeNotificationStreams, closeDeviceFabricStreams],
      error => console.error('[shutdown http]', error),
    );
    if (closedStreams) console.log(`[shutdown] closed ${closedStreams} live event stream(s)`);
    const schedulerDrain = schedulerModule
      ? schedulerModule.then(s => s.stopScheduler())
      : Promise.resolve();
    const results = await Promise.allSettled([httpDrain, schedulerDrain]);
    for (const result of results) {
      if (result.status === 'rejected') console.error('[shutdown]', result.reason);
    }
    clearTimeout(forcedExit);
    process.exit(0);
  };
  process.once('SIGTERM', () => { void shutdown('SIGTERM'); });
  process.once('SIGINT', () => { void shutdown('SIGINT'); });
}

start().catch(error => {
  console.error('[startup]', error);
  process.exitCode = 1;
});
