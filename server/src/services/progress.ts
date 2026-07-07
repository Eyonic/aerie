import { db } from '../lib/db.js';

export type ProgressMedia = 'video' | 'audio';

export interface ProgressRow {
  userId: number;
  itemId: string;
  media: ProgressMedia;
  positionTicks: number;
  durationTicks: number;
  played: boolean;
  seriesId?: string;
  updatedAt: string;
}

const MIN_TICKS = 5 * 1e7;

function mapRow(row: any): ProgressRow {
  return {
    userId: row.user_id,
    itemId: row.item_id,
    media: row.media,
    positionTicks: row.position_ticks || 0,
    durationTicks: row.duration_ticks || 0,
    played: !!row.played,
    seriesId: row.series_id || undefined,
    updatedAt: row.updated_at,
  };
}

export function get(userId: number, itemId: string): ProgressRow | null {
  const row = db.prepare('SELECT * FROM playback_progress WHERE user_id=? AND item_id=?').get(userId, itemId) as any;
  return row ? mapRow(row) : null;
}

export function report(userId: number, itemId: string, media: ProgressMedia, positionTicks: number, durationTicks = 0, seriesId?: string) {
  if (!itemId) return;
  const pos = Math.max(0, Math.round(positionTicks || 0));
  const dur = Math.max(0, Math.round(durationTicks || 0));
  const existing = get(userId, itemId);
  if (pos < MIN_TICKS && !existing) return;
  const played = dur > 0 && pos >= dur * 0.95 ? 1 : 0;
  db.prepare(`
    INSERT INTO playback_progress (user_id, item_id, media, position_ticks, duration_ticks, played, series_id, updated_at)
    VALUES (?,?,?,?,?,?,?,datetime('now'))
    ON CONFLICT(user_id, item_id) DO UPDATE SET
      media=excluded.media,
      position_ticks=excluded.position_ticks,
      duration_ticks=CASE WHEN excluded.duration_ticks > 0 THEN excluded.duration_ticks ELSE playback_progress.duration_ticks END,
      played=excluded.played,
      series_id=COALESCE(excluded.series_id, playback_progress.series_id),
      updated_at=datetime('now')
  `).run(userId, itemId, media, pos, dur, played, seriesId || null);
}

export function setPlayed(userId: number, itemId: string, media: ProgressMedia, played: boolean, durationTicks = 0) {
  if (!itemId) return;
  const dur = Math.max(0, Math.round(durationTicks || 0));
  const current = get(userId, itemId);
  const pos = played ? (dur || current?.durationTicks || current?.positionTicks || 0) : 0;
  db.prepare(`
    INSERT INTO playback_progress (user_id, item_id, media, position_ticks, duration_ticks, played, series_id, updated_at)
    VALUES (?,?,?,?,?,?,?,datetime('now'))
    ON CONFLICT(user_id, item_id) DO UPDATE SET
      media=excluded.media,
      position_ticks=excluded.position_ticks,
      duration_ticks=CASE WHEN excluded.duration_ticks > 0 THEN excluded.duration_ticks ELSE playback_progress.duration_ticks END,
      played=excluded.played,
      updated_at=datetime('now')
  `).run(userId, itemId, media, pos, dur, played ? 1 : 0, current?.seriesId || null);
}

export function resume(userId: number, media: ProgressMedia, limit = 20): ProgressRow[] {
  const rows = db.prepare(`
    SELECT * FROM playback_progress
    WHERE user_id=? AND media=? AND played=0 AND position_ticks > ?
      AND (duration_ticks=0 OR position_ticks < duration_ticks * 0.95)
    ORDER BY updated_at DESC
    LIMIT ?
  `).all(userId, media, MIN_TICKS, limit) as any[];
  return rows.map(mapRow);
}

export function mapFor(userId: number, itemIds: string[]): Map<string, Pick<ProgressRow, 'positionTicks' | 'durationTicks' | 'played'>> {
  const ids = Array.from(new Set(itemIds.filter(Boolean)));
  const out = new Map<string, Pick<ProgressRow, 'positionTicks' | 'durationTicks' | 'played'>>();
  if (!ids.length) return out;
  const placeholders = ids.map(() => '?').join(',');
  const rows = db.prepare(`
    SELECT item_id, position_ticks, duration_ticks, played
    FROM playback_progress
    WHERE user_id=? AND item_id IN (${placeholders})
  `).all(userId, ...ids) as any[];
  for (const row of rows) out.set(row.item_id, {
    positionTicks: row.position_ticks || 0,
    durationTicks: row.duration_ticks || 0,
    played: !!row.played,
  });
  return out;
}

export function seriesProgress(userId: number): { seriesId: string; updatedAt: string }[] {
  return db.prepare(`
    SELECT series_id seriesId, MAX(updated_at) updatedAt
    FROM playback_progress
    WHERE user_id=? AND media='video' AND series_id IS NOT NULL
    GROUP BY series_id
    ORDER BY updatedAt DESC
  `).all(userId) as any[];
}
