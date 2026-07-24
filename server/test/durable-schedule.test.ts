import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import {
  createDurableScheduleStore,
  durableScheduleSchema,
} from '../src/lib/durable-schedule.js';

function database() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(durableScheduleSchema);
  return sqlite;
}

test('persists a due cursor and grants only one live lease across scheduler instances', () => {
  const sqlite = database();
  try {
    const firstProcess = createDurableScheduleStore(sqlite);
    const secondProcess = createDurableScheduleStore(sqlite);
    firstProcess.ensure('backup', 'UTC@03:00', 1_000, 2_000);

    assert.equal(firstProcess.claim('backup', 'process-a', 2_000, 500)?.leaseOwner, 'process-a');
    assert.equal(secondProcess.claim('backup', 'process-b', 2_100, 500), null);

    // Reconstructing the store models a process restart: state remains in
    // SQLite and the previous owner's unexpired lease still blocks overlap.
    const restarted = createDurableScheduleStore(sqlite);
    assert.equal(restarted.get('backup')?.status, 'running');
    assert.equal(restarted.claim('backup', 'process-b', 2_499, 500), null);
    assert.equal(restarted.claim('backup', 'process-b', 2_500, 500)?.leaseOwner, 'process-b');
    assert.equal(firstProcess.complete('backup', 'process-a', 2_600, 9_000), false);
    assert.equal(restarted.complete('backup', 'process-b', 2_600, 9_000), true);

    assert.deepEqual(restarted.get('backup'), {
      taskKey: 'backup', scheduleKey: 'UTC@03:00', dueAtMs: 9_000,
      status: 'idle', leaseOwner: null, leaseUntilMs: null,
      lastStartedAtMs: 2_500, lastCompletedAtMs: 2_600,
      lastError: null, updatedAtMs: 2_600,
    });
  } finally {
    sqlite.close();
  }
});

test('retries failures without losing the durable due task', () => {
  const sqlite = database();
  try {
    const store = createDurableScheduleStore(sqlite);
    store.ensure('backup', 'UTC@03:00', 1_000, 2_000);
    assert.ok(store.claim('backup', 'process-a', 2_000, 500));
    assert.equal(store.fail('backup', 'process-a', 2_100, 3_000, 'disk busy'), true);
    assert.equal(store.claim('backup', 'process-b', 2_999, 500), null);
    assert.ok(store.claim('backup', 'process-b', 3_000, 500));
    assert.equal(store.get('backup')?.lastError, null);
  } finally {
    sqlite.close();
  }
});

test('a changed schedule preserves overdue work but replaces a future cursor', () => {
  const sqlite = database();
  try {
    const store = createDurableScheduleStore(sqlite);
    store.ensure('backup', 'UTC@03:00', 8_000, 2_000);
    const changed = store.ensure('backup', 'UTC@05:00', 1_500, 2_000, 9_000);
    assert.equal(changed.scheduleKey, 'UTC@05:00');
    assert.equal(changed.dueAtMs, 9_000);

    store.ensure('overdue', 'UTC@03:00', 1_500, 2_000);
    const overdue = store.ensure('overdue', 'Europe/Amsterdam@05:00', 1_000, 3_000, 9_000);
    assert.equal(overdue.dueAtMs, 1_500);
  } finally {
    sqlite.close();
  }
});
