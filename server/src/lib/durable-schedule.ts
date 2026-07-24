/**
 * Small SQLite-backed scheduler primitive. A due timestamp survives restarts,
 * while an expiring owner lease makes claiming a task atomic across processes.
 */

export const durableScheduleSchema = `
CREATE TABLE IF NOT EXISTS scheduled_tasks (
  task_key TEXT PRIMARY KEY,
  schedule_key TEXT NOT NULL,
  due_at_ms INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'idle',
  lease_owner TEXT,
  lease_until_ms INTEGER,
  last_started_at_ms INTEGER,
  last_completed_at_ms INTEGER,
  last_error TEXT,
  updated_at_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_due
  ON scheduled_tasks(due_at_ms, lease_until_ms);
`;

interface StatementLike {
  run(...params: any[]): { changes: number };
  get(...params: any[]): any;
}

export interface ScheduleDatabase {
  prepare(sql: string): StatementLike;
}

export interface ScheduledTaskState {
  taskKey: string;
  scheduleKey: string;
  dueAtMs: number;
  status: string;
  leaseOwner: string | null;
  leaseUntilMs: number | null;
  lastStartedAtMs: number | null;
  lastCompletedAtMs: number | null;
  lastError: string | null;
  updatedAtMs: number;
}

function mapState(row: any): ScheduledTaskState | null {
  if (!row) return null;
  return {
    taskKey: String(row.task_key),
    scheduleKey: String(row.schedule_key),
    dueAtMs: Number(row.due_at_ms),
    status: String(row.status),
    leaseOwner: row.lease_owner == null ? null : String(row.lease_owner),
    leaseUntilMs: row.lease_until_ms == null ? null : Number(row.lease_until_ms),
    lastStartedAtMs: row.last_started_at_ms == null ? null : Number(row.last_started_at_ms),
    lastCompletedAtMs: row.last_completed_at_ms == null ? null : Number(row.last_completed_at_ms),
    lastError: row.last_error == null ? null : String(row.last_error),
    updatedAtMs: Number(row.updated_at_ms),
  };
}

export function createDurableScheduleStore(database: ScheduleDatabase) {
  const getStatement = database.prepare('SELECT * FROM scheduled_tasks WHERE task_key=?');
  const insertStatement = database.prepare(`
    INSERT OR IGNORE INTO scheduled_tasks
      (task_key,schedule_key,due_at_ms,status,updated_at_ms)
    VALUES (?,?,?,'idle',?)
  `);
  const reconcileScheduleStatement = database.prepare(`
    UPDATE scheduled_tasks
    SET schedule_key=?,
        due_at_ms=CASE
          WHEN due_at_ms>? AND (lease_until_ms IS NULL OR lease_until_ms<=?) THEN ?
          ELSE due_at_ms
        END,
        updated_at_ms=?
    WHERE task_key=? AND schedule_key<>?
  `);
  const claimStatement = database.prepare(`
    UPDATE scheduled_tasks
    SET status='running', lease_owner=?, lease_until_ms=?,
        last_started_at_ms=?, last_error=NULL, updated_at_ms=?
    WHERE task_key=? AND due_at_ms<=?
      AND (lease_owner IS NULL OR lease_until_ms IS NULL OR lease_until_ms<=?)
  `);
  const renewStatement = database.prepare(`
    UPDATE scheduled_tasks
    SET lease_until_ms=?, updated_at_ms=?
    WHERE task_key=? AND status='running' AND lease_owner=?
  `);
  const completeStatement = database.prepare(`
    UPDATE scheduled_tasks
    SET status='idle', due_at_ms=?, lease_owner=NULL, lease_until_ms=NULL,
        last_completed_at_ms=?, last_error=NULL, updated_at_ms=?
    WHERE task_key=? AND status='running' AND lease_owner=?
  `);
  const failStatement = database.prepare(`
    UPDATE scheduled_tasks
    SET status='retry', due_at_ms=?, lease_owner=NULL, lease_until_ms=NULL,
        last_error=?, updated_at_ms=?
    WHERE task_key=? AND status='running' AND lease_owner=?
  `);

  function get(taskKey: string): ScheduledTaskState | null {
    return mapState(getStatement.get(taskKey));
  }

  return {
    get,

    ensure(
      taskKey: string,
      scheduleKey: string,
      initialDueAtMs: number,
      nowMs: number,
      changedScheduleDueAtMs = initialDueAtMs,
    ): ScheduledTaskState {
      insertStatement.run(taskKey, scheduleKey, initialDueAtMs, nowMs);
      // If an operator changes the hour/timezone, adopt it immediately unless
      // a due or running invocation already needs to be resolved first.
      reconcileScheduleStatement.run(
        scheduleKey, nowMs, nowMs, changedScheduleDueAtMs, nowMs, taskKey, scheduleKey,
      );
      const state = get(taskKey);
      if (!state) throw new Error('scheduled_task_state_missing');
      return state;
    },

    claim(taskKey: string, owner: string, nowMs: number, leaseMs: number): ScheduledTaskState | null {
      const result = claimStatement.run(
        owner, nowMs + leaseMs, nowMs, nowMs, taskKey, nowMs, nowMs,
      );
      return result.changes === 1 ? get(taskKey) : null;
    },

    renew(taskKey: string, owner: string, nowMs: number, leaseMs: number): boolean {
      return renewStatement.run(nowMs + leaseMs, nowMs, taskKey, owner).changes === 1;
    },

    complete(taskKey: string, owner: string, completedAtMs: number, nextDueAtMs: number): boolean {
      return completeStatement.run(
        nextDueAtMs, completedAtMs, completedAtMs, taskKey, owner,
      ).changes === 1;
    },

    fail(taskKey: string, owner: string, failedAtMs: number, retryAtMs: number, error: string): boolean {
      return failStatement.run(
        retryAtMs, error.slice(0, 500), failedAtMs, taskKey, owner,
      ).changes === 1;
    },
  };
}
