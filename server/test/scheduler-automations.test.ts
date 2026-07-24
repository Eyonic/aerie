import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

const enabled = new Set<string>();
const completed: string[] = [];
let serviceChecks = 0;
let systemChecks = 0;
let aiChecks = 0;
let snapshotSweeps = 0;
let recoveryBundles = 0;
let scheduleState: any = null;
let holdRecoveryBundle = false;
let signalRecoveryBundleStarted: (() => void) | null = null;
let rejectRecoveryBundle: ((error: Error) => void) | null = null;
const BACKUP_INTERRUPTED_BY_SHUTDOWN = 'backup_interrupted_by_shutdown';

const fakeScheduleStore = {
  get: () => scheduleState,
  ensure(taskKey: string, scheduleKey: string, dueAtMs: number, nowMs: number) {
    scheduleState ||= {
      taskKey, scheduleKey, dueAtMs, status: 'idle', leaseOwner: null,
      leaseUntilMs: null, lastStartedAtMs: null, lastCompletedAtMs: null,
      lastError: null, updatedAtMs: nowMs,
    };
    return scheduleState;
  },
  claim(_taskKey: string, owner: string, nowMs: number, leaseMs: number) {
    if (!scheduleState || scheduleState.dueAtMs > nowMs
      || (scheduleState.leaseUntilMs != null && scheduleState.leaseUntilMs > nowMs)) return null;
    Object.assign(scheduleState, {
      status: 'running', leaseOwner: owner, leaseUntilMs: nowMs + leaseMs,
      lastStartedAtMs: nowMs, lastError: null, updatedAtMs: nowMs,
    });
    return scheduleState;
  },
  renew(_taskKey: string, owner: string, nowMs: number, leaseMs: number) {
    if (scheduleState?.leaseOwner !== owner) return false;
    scheduleState.leaseUntilMs = nowMs + leaseMs;
    return true;
  },
  complete(_taskKey: string, owner: string, completedAtMs: number, nextDueAtMs: number) {
    if (scheduleState?.leaseOwner !== owner) return false;
    Object.assign(scheduleState, {
      status: 'idle', dueAtMs: nextDueAtMs, leaseOwner: null,
      leaseUntilMs: null, lastCompletedAtMs: completedAtMs, updatedAtMs: completedAtMs,
    });
    return true;
  },
  fail(_taskKey: string, owner: string, failedAtMs: number, retryAtMs: number, error: string) {
    if (scheduleState?.leaseOwner !== owner) return false;
    Object.assign(scheduleState, {
      status: 'retry', dueAtMs: retryAtMs, leaseOwner: null,
      leaseUntilMs: null, lastError: error, updatedAtMs: failedAtMs,
    });
    return true;
  },
};

const fakeDb = {
  prepare(sql: string) {
    if (sql.includes("SELECT id FROM users WHERE role='admin'")) return { all: () => [] };
    if (sql.includes('SELECT id, features FROM users')) return { all: () => [] };
    if (sql.startsWith('INSERT INTO alert_events')) return { run: () => ({ changes: 1 }) };
    throw new Error(`unexpected scheduler SQL: ${sql}`);
  },
};

mock.module(new URL('../src/lib/db.js', import.meta.url).href, {
  namedExports: {
    db: fakeDb,
    notify: () => undefined,
    audit: () => undefined,
    getSetting: (_key: string, fallback = '') => fallback,
  },
});
mock.module(new URL('../src/services/monitoring.js', import.meta.url).href, {
  namedExports: {
    serviceStatuses: async () => {
      serviceChecks += 1;
      return [{ key: 'jellyfin', name: 'Jellyfin', online: true }];
    },
    systemHealth: async () => {
      systemChecks += 1;
      return { storageTotalTb: 1, storageUsedTb: 0.1, memTotalGb: 16, memUsedGb: 2, cpuPct: 3 };
    },
  },
});
mock.module(new URL('../src/services/autorequest.js', import.meta.url).href, {
  namedExports: {
    countThisWeek: () => 0,
    profile: async () => ({ noHistory: false }),
    runFor: async () => undefined,
  },
});
mock.module(new URL('../src/services/jellyseerr.js', import.meta.url).href, {
  namedExports: { configured: () => true },
});
mock.module(new URL('../src/services/lidarr.js', import.meta.url).href, {
  namedExports: { configured: () => false },
});
mock.module(new URL('../src/services/ai.js', import.meta.url).href, {
  namedExports: {
    available: async () => {
      aiChecks += 1;
      return true;
    },
  },
});
mock.module(new URL('../src/services/time-machine.js', import.meta.url).href, {
  namedExports: {
    runDueSnapshots: async () => {
      snapshotSweeps += 1;
    },
  },
});
mock.module(new URL('../src/services/backup.js', import.meta.url).href, {
  namedExports: {
    BACKUP_INTERRUPTED_BY_SHUTDOWN,
    backupPaths: () => ({ dbPath: '/tmp/aerie-scheduler-test.db' }),
    createBackup: async () => {
      recoveryBundles += 1;
      if (holdRecoveryBundle) {
        signalRecoveryBundleStarted?.();
        await new Promise<never>((_resolve, reject) => {
          rejectRecoveryBundle = reject;
        });
      }
      return { name: 'verified.aerie-backup.tar.gz', sha256: 'abc123' };
    },
    abortActiveBackup: (reason: Error) => {
      if (!rejectRecoveryBundle) return false;
      const reject = rejectRecoveryBundle;
      rejectRecoveryBundle = null;
      reject(reason);
      return true;
    },
  },
});
mock.module(new URL('../src/services/sqlite-backup.js', import.meta.url).href, {
  namedExports: { sqliteBackupCallbacks: () => ({}) },
});
mock.module(new URL('../src/services/automations.js', import.meta.url).href, {
  namedExports: {
    automationEnabled: (id: string) => enabled.has(id),
    recordAutomationRun: (id: string) => completed.push(id),
  },
});
mock.module(new URL('../src/lib/durable-schedule.js', import.meta.url).href, {
  namedExports: { createDurableScheduleStore: () => fakeScheduleStore },
});

const { schedulerTestApi, startScheduler, stopScheduler } = await import('../src/services/scheduler.js');

function reset() {
  enabled.clear();
  completed.length = 0;
  serviceChecks = 0;
  systemChecks = 0;
  aiChecks = 0;
  snapshotSweeps = 0;
  recoveryBundles = 0;
  scheduleState = null;
  holdRecoveryBundle = false;
  signalRecoveryBundleStarted = null;
  rejectRecoveryBundle = null;
  schedulerTestApi.reset();
}

test.beforeEach(reset);

test('disabled built-in tasks do not invoke their executors or create run history', async () => {
  await schedulerTestApi.healthCheck();
  await schedulerTestApi.maybeAutoRequest();
  await schedulerTestApi.maybeTimeMachineSnapshots();
  await schedulerTestApi.maybeNightlyBackup(new Date(2026, 6, 22, 3, 0, 0));

  assert.deepEqual(completed, []);
  assert.equal(serviceChecks, 0);
  assert.equal(systemChecks, 0);
  assert.equal(aiChecks, 0);
  assert.equal(snapshotSweeps, 0);
  assert.equal(recoveryBundles, 0);
});

test('enabled built-in tasks record exactly one completion after real executor work', async () => {
  enabled.add('health-alerts');
  enabled.add('auto-request-sweep');
  enabled.add('time-machine-scheduler');
  enabled.add('nightly-recovery-bundle');

  await schedulerTestApi.healthCheck();
  await schedulerTestApi.maybeAutoRequest();
  await schedulerTestApi.maybeTimeMachineSnapshots();
  await schedulerTestApi.maybeNightlyBackup(new Date(2026, 6, 22, 3, 0, 0));

  assert.equal(serviceChecks, 1);
  assert.equal(systemChecks, 1);
  assert.equal(aiChecks, 1);
  assert.equal(snapshotSweeps, 1);
  assert.equal(recoveryBundles, 1);
  assert.deepEqual(completed, [
    'health-alerts',
    'auto-request-sweep',
    'time-machine-scheduler',
    'nightly-recovery-bundle',
  ]);
});

test('the durable claim keeps concurrent backup ticks single-flight', async () => {
  enabled.add('nightly-recovery-bundle');
  const due = new Date(2026, 6, 22, 3, 0, 0);
  await Promise.all([
    schedulerTestApi.maybeNightlyBackup(due),
    schedulerTestApi.maybeNightlyBackup(due),
  ]);
  assert.equal(recoveryBundles, 1);
  assert.deepEqual(completed, ['nightly-recovery-bundle']);
});

test('graceful stop clears scheduler timers and waits for launched work', async () => {
  startScheduler();
  await stopScheduler();
  // Starting again proves stop reset the lifecycle instead of leaving an
  // orphaned interval or a permanently-stopped singleton behind.
  startScheduler();
  await stopScheduler();
});

test('graceful stop aborts a running backup and immediately releases its durable lease', async () => {
  enabled.add('nightly-recovery-bundle');
  holdRecoveryBundle = true;
  const started = new Promise<void>(resolve => { signalRecoveryBundleStarted = resolve; });
  const due = new Date(2026, 6, 22, 3, 0, 0);
  const task = schedulerTestApi.runTrackedNightlyBackup(due);
  assert.ok(task);
  await started;
  assert.equal(scheduleState.status, 'running');
  assert.ok(scheduleState.leaseOwner);
  assert.ok(scheduleState.leaseUntilMs > due.getTime());

  await stopScheduler();
  await task;

  assert.equal(scheduleState.status, 'retry');
  assert.equal(scheduleState.leaseOwner, null);
  assert.equal(scheduleState.leaseUntilMs, null);
  assert.equal(scheduleState.dueAtMs, scheduleState.updatedAtMs, 'restart retry should remain immediately due');
  assert.equal(scheduleState.lastError, BACKUP_INTERRUPTED_BY_SHUTDOWN);
  assert.equal(recoveryBundles, 1, 'the stopping process must not launch a duplicate retry');
  assert.deepEqual(completed, []);
});

test.after(() => mock.reset());
