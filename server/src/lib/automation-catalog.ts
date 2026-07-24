// The only automations shown by Aerie are scheduler tasks that have a real
// executor. Stable IDs let upgrades refresh labels/schedules without ever
// resetting genuine enabled state or run history.
import { localScheduleTime } from './backup-schedule.js';

export const BUILT_IN_AUTOMATIONS = [
  {
    id: 'health-alerts',
    name: 'Service and resource health alerts',
    trigger: 'Every 5 minutes',
    action: 'Check services, storage, CPU and memory; notify admins on alert transitions',
    defaultEnabled: true,
  },
  {
    id: 'nightly-recovery-bundle',
    name: 'Nightly recovery bundle',
    trigger: `Nightly at ${localScheduleTime()} server time`,
    action: 'Create and verify a comprehensive recovery bundle, then apply retention',
    defaultEnabled: true,
  },
  {
    id: 'auto-request-sweep',
    name: 'Automatic media-request sweep',
    trigger: 'After startup, then every 6 hours',
    action: 'Evaluate eligible member preferences and submit bounded media requests',
    defaultEnabled: true,
  },
  {
    id: 'time-machine-scheduler',
    name: 'Time Machine snapshot scheduler',
    trigger: 'After startup, then every 30 minutes',
    action: 'Evaluate due per-user snapshots and apply each account retention policy',
    defaultEnabled: true,
  },
] as const;

export type BuiltInAutomationId = typeof BUILT_IN_AUTOMATIONS[number]['id'];

export const BUILT_IN_AUTOMATION_IDS = BUILT_IN_AUTOMATIONS.map(item => item.id) as BuiltInAutomationId[];

export function isBuiltInAutomationId(value: string): value is BuiltInAutomationId {
  return (BUILT_IN_AUTOMATION_IDS as string[]).includes(value);
}

// Existing releases seeded six decorative rules with invented run counts and
// allowed arbitrary rules that had no dispatcher. Remove those rows once, then
// upsert the executable catalog. ON CONFLICT deliberately updates metadata only:
// enabled, last_run and run_count remain genuine across every future restart.
export function reconcileAutomationCatalog(database: any): void {
  const upsert = database.prepare(`INSERT INTO automations
    (id,name,trigger,action,enabled,last_run,run_count) VALUES (?,?,?,?,?,NULL,0)
    ON CONFLICT(id) DO UPDATE SET
      name=excluded.name, trigger=excluded.trigger, action=excluded.action`);
  const removeUnsupported = database.prepare(
    `DELETE FROM automations WHERE id NOT IN (${BUILT_IN_AUTOMATION_IDS.map(() => '?').join(',')})`,
  );
  const operation = database.transaction(() => {
    removeUnsupported.run(...BUILT_IN_AUTOMATION_IDS);
    for (const item of BUILT_IN_AUTOMATIONS) {
      upsert.run(item.id, item.name, item.trigger, item.action, item.defaultEnabled ? 1 : 0);
    }
  });
  operation();
}
