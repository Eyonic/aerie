// Comprehensive recovery bundles. A backup is one portable tar.gz containing
// a WAL-safe SQLite snapshot, user files and durable generated/config data,
// with an internal manifest plus whole-archive and per-file SHA-256 checksums.
import { Router } from 'express';
import { requireAdmin, type AuthedRequest } from '../lib/auth.js';
import { notify } from '../lib/db.js';
import {
  backupPaths,
  backupRetention,
  backupStatuses as serviceBackupStatuses,
  createBackup,
  listBackupHistory,
  stageRestore,
} from '../services/backup.js';
import { sqliteBackupCallbacks } from '../services/sqlite-backup.js';
import { automationEnabled } from '../services/automations.js';
import { localScheduleTime, nextNightlyBackup, serverTimeZone } from '../lib/backup-schedule.js';
import type { BackupConfiguration } from '../lib/model.js';

const r = Router();
r.use(requireAdmin);

export async function backupStatuses() {
  return serviceBackupStatuses();
}

export function backupConfiguration(now = new Date()): BackupConfiguration {
  const enabled = automationEnabled('nightly-recovery-bundle');
  return {
    retention: backupRetention(),
    nightly: {
      enabled,
      localTime: localScheduleTime(),
      timeZone: serverTimeZone(),
      nextRunAt: enabled ? nextNightlyBackup(now).toISOString() : null,
    },
  };
}

function restoreErrorStatus(error: unknown): number | null {
  const message = String((error as any)?.message || error);
  if (message.includes('backup_not_found') || message.includes('ENOENT')) return 404;
  if (message.includes('restore_already') || message.includes('backup_already_running')) return 409;
  if (message.includes('invalid_backup_name')) return 400;
  if (message.includes('integrity') || message.includes('checksum') || message.includes('manifest')
    || message.includes('unsupported')) return 422;
  return null;
}

r.get('/', async (_req, res, next) => {
  try { res.json(await backupStatuses()); } catch (error) { next(error); }
});

r.get('/configuration', (_req, res, next) => {
  try {
    res.setHeader('Cache-Control', 'no-store');
    res.json(backupConfiguration());
  } catch (error) { next(error); }
});

r.get('/history', async (_req, res, next) => {
  try { res.json(await listBackupHistory()); } catch (error) { next(error); }
});

r.post('/run', async (req: AuthedRequest, res, next) => {
  try {
    const paths = backupPaths();
    const result = await createBackup({ paths, ...sqliteBackupCallbacks(paths.dbPath) });
    notify(
      req.user!.id,
      'Backup complete',
      'Verified recovery bundle includes the database, user files and available durable app data.',
      'success',
      '/backups',
    );
    res.json({
      ok: true,
      name: result.name,
      sizeBytes: result.sizeBytes,
      createdAt: result.createdAt,
      sha256: result.sha256,
      components: result.manifest.components,
    });
  } catch (error) {
    const status = restoreErrorStatus(error);
    if (status) return res.status(status).json({ error: String((error as any)?.message || error) });
    next(error);
  }
});

// Never replace the database under the running process. This validates the
// requested artifact and writes a durable handoff marker. The container
// entrypoint applies it in maintenance mode before Node opens SQLite again.
r.post('/restore', async (req: AuthedRequest, res, next) => {
  try {
    const paths = backupPaths();
    const request = await stageRestore(String(req.body?.name || ''), req.user!.id, {
      paths,
      validateDatabase: sqliteBackupCallbacks(paths.dbPath).validateDatabase,
    });
    notify(
      req.user!.id,
      'Restore staged',
      'The verified restore will be applied before SQLite opens on the next container restart.',
      'warning',
      '/backups',
    );
    res.status(202).json({
      ok: true,
      staged: true,
      restored: request.artifact,
      note: 'Restore validated and staged safely. Restart the Aerie container to apply it before the database opens.',
    });
  } catch (error) {
    const status = restoreErrorStatus(error);
    if (status) return res.status(status).json({ error: String((error as any)?.message || error) });
    next(error);
  }
});

export default r;
