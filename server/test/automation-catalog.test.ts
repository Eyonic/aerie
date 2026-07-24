import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import {
  BUILT_IN_AUTOMATIONS,
  reconcileAutomationCatalog,
} from '../src/lib/automation-catalog.js';

function databaseFixture() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(`CREATE TABLE automations (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    trigger TEXT NOT NULL,
    action TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    last_run TEXT,
    run_count INTEGER NOT NULL DEFAULT 0
  )`);
  return {
    sqlite,
    database: {
      prepare: (sql: string) => sqlite.prepare(sql),
      transaction: (operation: (...args: any[]) => any) => (...args: any[]) => {
        sqlite.exec('BEGIN IMMEDIATE');
        try {
          const result = operation(...args);
          sqlite.exec('COMMIT');
          return result;
        } catch (error) {
          sqlite.exec('ROLLBACK');
          throw error;
        }
      },
    },
  };
}

test('replaces fabricated and non-executable rules with the built-in executor catalog', () => {
  const { sqlite, database } = databaseFixture();
  try {
    const insert = sqlite.prepare(`INSERT INTO automations
      (id,name,trigger,action,enabled,last_run,run_count) VALUES (?,?,?,?,?,?,?)`);
    insert.run('a1', 'Nightly phone backup', 'Every night', 'Upload photos', 1, null, 214);
    insert.run('a2', 'Generate thumbnails', 'On upload', 'Create thumbnails', 1, null, 5821);
    insert.run('custom-rule', 'Decorative custom rule', 'On anything', 'Do nothing', 1, '2025-01-01', 42);

    reconcileAutomationCatalog(database);

    const rows = sqlite.prepare('SELECT * FROM automations ORDER BY id').all() as any[];
    assert.deepEqual(
      rows.map(row => row.id),
      BUILT_IN_AUTOMATIONS.map(item => item.id).sort(),
    );
    assert.ok(rows.every(row => row.enabled === 1));
    assert.ok(rows.every(row => row.last_run === null));
    assert.ok(rows.every(row => row.run_count === 0));
  } finally {
    sqlite.close();
  }
});

test('catalog reconciliation preserves genuine built-in state and run history', () => {
  const { sqlite, database } = databaseFixture();
  try {
    reconcileAutomationCatalog(database);
    sqlite.prepare(`UPDATE automations
      SET name='stale label', trigger='stale schedule', action='stale action',
          enabled=0, last_run='2026-07-21 03:00:00', run_count=17
      WHERE id='nightly-recovery-bundle'`).run();

    reconcileAutomationCatalog(database);

    const row = sqlite.prepare(
      "SELECT * FROM automations WHERE id='nightly-recovery-bundle'",
    ).get() as any;
    const canonical = BUILT_IN_AUTOMATIONS.find(item => item.id === 'nightly-recovery-bundle')!;
    assert.equal(row.name, canonical.name);
    assert.equal(row.trigger, canonical.trigger);
    assert.equal(row.action, canonical.action);
    assert.equal(row.enabled, 0);
    assert.equal(row.last_run, '2026-07-21 03:00:00');
    assert.equal(row.run_count, 17);
  } finally {
    sqlite.close();
  }
});
