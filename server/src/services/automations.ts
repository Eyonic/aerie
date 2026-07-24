import { db } from '../lib/db.js';
import {
  BUILT_IN_AUTOMATION_IDS,
  isBuiltInAutomationId,
  type BuiltInAutomationId,
} from '../lib/automation-catalog.js';
import type { Automation } from '../lib/model.js';

function map(row: any): Automation {
  return {
    id: row.id,
    name: row.name,
    trigger: row.trigger,
    action: row.action,
    enabled: !!row.enabled,
    lastRun: row.last_run || undefined,
    runCount: Number(row.run_count || 0),
  };
}

export function listBuiltInAutomations(): Automation[] {
  const rows = db.prepare(
    `SELECT * FROM automations WHERE id IN (${BUILT_IN_AUTOMATION_IDS.map(() => '?').join(',')})`,
  ).all(...BUILT_IN_AUTOMATION_IDS) as any[];
  const byId = new Map(rows.map(row => [row.id, row]));
  return BUILT_IN_AUTOMATION_IDS.flatMap(id => {
    const row = byId.get(id);
    return row ? [map(row)] : [];
  });
}

export function automationEnabled(id: BuiltInAutomationId): boolean {
  const row = db.prepare('SELECT enabled FROM automations WHERE id=?').get(id) as any;
  return !!row?.enabled;
}

export function recordAutomationRun(id: BuiltInAutomationId): void {
  db.prepare("UPDATE automations SET last_run=datetime('now'), run_count=run_count+1 WHERE id=?").run(id);
}

export function toggleBuiltInAutomation(idValue: string): Automation | null {
  if (!isBuiltInAutomationId(idValue)) return null;
  const row = db.prepare('SELECT enabled FROM automations WHERE id=?').get(idValue) as any;
  if (!row) return null;
  db.prepare('UPDATE automations SET enabled=? WHERE id=?').run(row.enabled ? 0 : 1, idValue);
  const updated = db.prepare('SELECT * FROM automations WHERE id=?').get(idValue);
  return updated ? map(updated) : null;
}
