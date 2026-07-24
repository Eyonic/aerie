import { Router } from 'express';
import type { AuthedRequest } from '../lib/auth.js';
import { audit, notify } from '../lib/db.js';
import {
  browseSnapshot,
  deleteSnapshot,
  diffSnapshot,
  getLatestSnapshotTask,
  getRetentionPolicy,
  getSnapshotTask,
  listSnapshots,
  normalizeVirtual,
  pruneSnapshots,
  queueSnapshot,
  restoreSnapshot,
  assertTimeMachineUserActive,
  updateRetentionPolicy,
  type RestoreMode,
} from '../services/time-machine.js';

const router = Router();

function user(req: AuthedRequest) {
  if (!req.user) throw Object.assign(new Error('unauthorized'), { status: 401 });
  return req.user;
}

function integer(value: unknown, fallback: number, max: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.min(max, Math.floor(parsed))) : fallback;
}

function param(value: string | string[]): string {
  return Array.isArray(value) ? value[0] : value;
}

router.get('/snapshots', (req: AuthedRequest, res, next) => {
  try { res.json({ snapshots: listSnapshots(user(req).id) }); }
  catch (error) { next(error); }
});

router.post('/snapshots', (req: AuthedRequest, res, next) => {
  try {
    const current = user(req);
    const label = typeof req.body?.label === 'string' ? req.body.label : undefined;
    const task = queueSnapshot(current.id, current.username, label);
    audit(current.id, current.username, 'time_machine_snapshot_queued', task.id, req.ip);
    res.status(202).json({ task });
  } catch (error) { next(error); }
});

router.get('/tasks/latest', (req: AuthedRequest, res, next) => {
  try { res.json({ task: getLatestSnapshotTask(user(req).id) }); }
  catch (error) { next(error); }
});

router.get('/tasks/:id', (req: AuthedRequest, res, next) => {
  try { res.json({ task: getSnapshotTask(user(req).id, param(req.params.id)) }); }
  catch (error) { next(error); }
});

router.get('/snapshots/:id/tree', async (req: AuthedRequest, res, next) => {
  try {
    const current = user(req);
    res.json(await browseSnapshot(current.id, param(req.params.id), req.query.path));
  } catch (error) { next(error); }
});

router.get('/snapshots/:id/diff', async (req: AuthedRequest, res, next) => {
  try {
    const current = user(req);
    const against = typeof req.query.against === 'string' && req.query.against ? req.query.against : 'current';
    res.json(await diffSnapshot(current.id, current.username, param(req.params.id), against, req.query.path,
      integer(req.query.offset, 0, 1_000_000), integer(req.query.limit, 500, 1000)));
  } catch (error) { next(error); }
});

router.post('/snapshots/:id/restore', async (req: AuthedRequest, res, next) => {
  try {
    const current = user(req);
    const sourcePath = normalizeVirtual(req.body?.path);
    const mode = String(req.body?.mode || 'rename') as RestoreMode;
    const snapshotId = param(req.params.id);
    const restored = await restoreSnapshot(current.id, current.username, snapshotId, sourcePath,
      req.body?.destinationPath, mode);
    assertTimeMachineUserActive(current.id);
    audit(current.id, current.username, 'time_machine_restore', `${snapshotId}:${sourcePath} -> ${restored.destinationPath}`, req.ip);
    assertTimeMachineUserActive(current.id);
    notify(current.id, 'Time Machine restore complete', restored.destinationPath, 'success', '/files');
    res.json(restored);
  } catch (error) { next(error); }
});

router.delete('/snapshots/:id', async (req: AuthedRequest, res, next) => {
  try {
    const current = user(req);
    const snapshotId = param(req.params.id);
    const result = await deleteSnapshot(current.id, snapshotId);
    audit(current.id, current.username, 'time_machine_delete_snapshot', snapshotId, req.ip);
    res.json(result);
  } catch (error) { next(error); }
});

router.get('/retention', (req: AuthedRequest, res, next) => {
  try { res.json(getRetentionPolicy(user(req).id)); }
  catch (error) { next(error); }
});

router.put('/retention', (req: AuthedRequest, res, next) => {
  try {
    const current = user(req);
    const policy = updateRetentionPolicy(current.id, req.body || {});
    audit(current.id, current.username, 'time_machine_retention_updated', JSON.stringify(policy), req.ip);
    res.json(policy);
  } catch (error) { next(error); }
});

router.post('/retention/prune', async (req: AuthedRequest, res, next) => {
  try {
    const current = user(req);
    const result = await pruneSnapshots(current.id);
    audit(current.id, current.username, 'time_machine_prune', `${result.removedSnapshots} snapshots`, req.ip);
    res.json(result);
  } catch (error) { next(error); }
});

export default router;
