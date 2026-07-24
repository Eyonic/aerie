import { db } from '../lib/db.js';

/** Keep the last complete content generation available while recording that a
 * newer filesystem state exists. The timestamp advances past an in-flight scan
 * start, preventing a racing write from being mistaken for indexed content. */
export function markContentSearchStale(userId: number): void {
  if (!Number.isSafeInteger(userId) || userId < 1) return;
  const row = db.prepare(`SELECT last_started_ms,last_completed_ms,invalidated_at_ms
    FROM content_search_state WHERE user_id=?`).get(userId) as any;
  const invalidatedAt = Math.max(Date.now(), Number(row?.last_started_ms || 0) + 1,
    Number(row?.last_completed_ms || 0) + 1, Number(row?.invalidated_at_ms || 0) + 1);
  db.prepare(`INSERT INTO content_search_state (user_id,invalidated_at_ms,status)
    VALUES (?,?,'idle') ON CONFLICT(user_id) DO UPDATE SET
      invalidated_at_ms=excluded.invalidated_at_ms,
      status=CASE WHEN content_search_state.status='scanning' THEN 'scanning' ELSE 'idle' END`)
    .run(userId, invalidatedAt);
}
