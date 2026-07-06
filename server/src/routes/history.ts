import { Router } from 'express';
import { db } from '../lib/db.js';

const r = Router();
const KINDS = new Set(['movie', 'episode', 'video', 'music', 'audiobook', 'podcast']);

function cleanImageUrl(u?: string | null) {
  if (!u) return null;
  try {
    const url = new URL(u, 'http://aerie.local');
    url.searchParams.delete('token');
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return null;
  }
}

const rowFields = `
  kind, item_id itemId, day, title, subtitle, image_url imageUrl, seconds,
  position_sec positionSec, duration_sec durationSec, last_ts lastTs
`;

r.post('/beat', (req: any, res) => {
  const { kind, itemId, title, subtitle, imageUrl, positionSec, durationSec } = req.body || {};
  if (!KINDS.has(kind)) return res.status(400).json({ error: 'invalid_kind' });
  if (!itemId || !title) return res.status(400).json({ error: 'missing_fields' });

  const now = new Date();
  const nowIso = now.toISOString();
  const day = nowIso.slice(0, 10);
  const userId = req.user!.id;
  const row = db.prepare('SELECT last_ts lastTs FROM play_history WHERE user_id=? AND kind=? AND item_id=? AND day=?')
    .get(userId, kind, String(itemId), day) as any;

  const pos = Number.isFinite(Number(positionSec)) ? Number(positionSec) : 0;
  const dur = Number.isFinite(Number(durationSec)) ? Number(durationSec) : 0;
  const img = cleanImageUrl(imageUrl);
  if (row) {
    const last = Date.parse(String(row.lastTs));
    const gap = Number.isFinite(last) ? Math.max(0, (now.getTime() - last) / 1000) : 20;
    const credit = gap > 120 ? 20 : Math.min(Math.max(gap, 0), 60);
    db.prepare(`UPDATE play_history
      SET seconds=seconds+?, position_sec=?, duration_sec=?, last_ts=?, title=?, subtitle=?, image_url=?
      WHERE user_id=? AND kind=? AND item_id=? AND day=?`)
      .run(Math.round(credit), pos, dur, nowIso, String(title), subtitle ?? null, img, userId, kind, String(itemId), day);
  } else {
    db.prepare(`INSERT INTO play_history
      (user_id, kind, item_id, day, title, subtitle, image_url, seconds, position_sec, duration_sec, first_ts, last_ts)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(userId, kind, String(itemId), day, String(title), subtitle ?? null, img, 20, pos, dur, nowIso, nowIso);
  }
  res.json({ ok: true });
});

r.get('/', (req: any, res) => {
  const kind = req.query.kind as string | undefined;
  const limit = Math.max(1, Math.min(1000, Number(req.query.limit) || 300));
  let rows: any[];
  if (!kind) {
    rows = db.prepare(`SELECT ${rowFields} FROM play_history WHERE user_id=? ORDER BY last_ts DESC LIMIT ?`).all(req.user!.id, limit) as any[];
  } else if (kind === 'video') {
    rows = db.prepare(`SELECT ${rowFields} FROM play_history WHERE user_id=? AND kind IN ('movie','episode','video') ORDER BY last_ts DESC LIMIT ?`).all(req.user!.id, limit) as any[];
  } else if (KINDS.has(kind)) {
    rows = db.prepare(`SELECT ${rowFields} FROM play_history WHERE user_id=? AND kind=? ORDER BY last_ts DESC LIMIT ?`).all(req.user!.id, kind, limit) as any[];
  } else {
    return res.status(400).json({ error: 'invalid_kind' });
  }
  res.json({ entries: rows });
});

r.get('/stats', (req: any, res) => {
  const sums = db.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN kind IN ('movie','episode','video') THEN seconds ELSE 0 END), 0) watchSec,
      COALESCE(SUM(CASE WHEN kind='music' THEN seconds ELSE 0 END), 0) musicSec,
      COALESCE(SUM(CASE WHEN kind IN ('audiobook','podcast') THEN seconds ELSE 0 END), 0) bookSec,
      COALESCE(SUM(CASE WHEN day >= date('now','-6 days') THEN seconds ELSE 0 END), 0) weekSec
    FROM play_history WHERE user_id=?`).get(req.user!.id) as any;
  const topItems = db.prepare(`
    WITH totals AS (
      SELECT kind, item_id, SUM(seconds) totalSec, MAX(last_ts) lastTs
      FROM play_history
      WHERE user_id=?
      GROUP BY kind, item_id
    )
    SELECT t.kind, t.item_id itemId, p.title, p.subtitle, p.image_url imageUrl, t.totalSec, t.lastTs
    FROM totals t
    JOIN play_history p ON p.user_id=? AND p.kind=t.kind AND p.item_id=t.item_id AND p.last_ts=t.lastTs
    ORDER BY t.totalSec DESC
    LIMIT 10`).all(req.user!.id, req.user!.id) as any[];
  res.json({ watchSec: sums.watchSec, musicSec: sums.musicSec, bookSec: sums.bookSec, weekSec: sums.weekSec, topItems });
});

export default r;
