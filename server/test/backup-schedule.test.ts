import assert from 'node:assert/strict';
import test from 'node:test';

import {
  backupScheduleHour,
  latestNightlyBackup,
  localScheduleTime,
  nextNightlyBackup,
  serverLocalDay,
  serverTimeZone,
} from '../src/lib/backup-schedule.js';

test('validates and formats the configured nightly backup hour', () => {
  assert.equal(backupScheduleHour(undefined), 3);
  assert.equal(backupScheduleHour('0'), 0);
  assert.equal(backupScheduleHour('23'), 23);
  assert.equal(backupScheduleHour('-1'), 3);
  assert.equal(backupScheduleHour('24'), 3);
  assert.equal(backupScheduleHour('3.5'), 3);
  assert.equal(backupScheduleHour('nope'), 3);
  assert.equal(localScheduleTime(7), '07:00');
});

test('computes the next occurrence using server-local calendar fields', () => {
  const before = new Date(2026, 6, 22, 2, 30, 0, 0);
  const sameDay = nextNightlyBackup(before, 3);
  assert.equal(sameDay.getFullYear(), 2026);
  assert.equal(sameDay.getMonth(), 6);
  assert.equal(sameDay.getDate(), 22);
  assert.equal(sameDay.getHours(), 3);
  assert.equal(sameDay.getMinutes(), 0);

  const after = new Date(2026, 6, 22, 3, 0, 0, 0);
  const nextDay = nextNightlyBackup(after, 3);
  assert.equal(serverLocalDay(nextDay), '2026-07-23');
  assert.equal(nextDay.getHours(), 3);
  assert.ok(serverTimeZone().length > 0);
});

test('computes only the most recent missed occurrence for bounded catch-up', () => {
  const before = new Date(2026, 6, 22, 2, 30, 0, 0);
  const previousDay = latestNightlyBackup(before, 3);
  assert.equal(serverLocalDay(previousDay), '2026-07-21');
  assert.equal(previousDay.getHours(), 3);

  const exact = new Date(2026, 6, 22, 3, 0, 0, 0);
  assert.equal(latestNightlyBackup(exact, 3).getTime(), exact.getTime());

  const after = new Date(2026, 6, 22, 17, 45, 0, 0);
  const sameDay = latestNightlyBackup(after, 3);
  assert.equal(serverLocalDay(sameDay), '2026-07-22');
  assert.equal(sameDay.getHours(), 3);
});
