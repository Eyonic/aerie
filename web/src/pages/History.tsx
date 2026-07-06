import React, { useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api';
import { Icon } from '../lib/icons';
import { cx } from '../lib/utils';
import { PageLoader } from '../components/ui';
import type { HistoryEntry, HistoryStats } from '../lib/model';

type Filter = 'all' | 'video' | 'music' | 'audiobook' | 'podcast';

const filters: { key: Filter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'video', label: 'Movies & TV' },
  { key: 'music', label: 'Music' },
  { key: 'audiobook', label: 'Audiobooks' },
  { key: 'podcast', label: 'Podcasts' },
];

function fmtHours(sec: number) {
  const min = Math.max(0, Math.round((sec || 0) / 60));
  if (min < 60) return `${min}m`;
  return `${Math.floor(min / 60)}h ${String(min % 60).padStart(2, '0')}m`;
}

function dayKey(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function dayLabel(day: string) {
  const today = dayKey();
  const y = new Date(); y.setDate(y.getDate() - 1);
  if (day === today) return 'Today';
  if (day === dayKey(y)) return 'Yesterday';
  const d = new Date(`${day}T00:00:00`);
  const wk = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getDay()];
  const mo = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getMonth()];
  return `${wk} ${d.getDate()} ${mo}`;
}

function kindLabel(k: string) {
  return k === 'episode' ? 'TV' : k === 'audiobook' ? 'BOOK' : k.toUpperCase();
}

function KindIcon({ kind, size = 18 }: { kind: string; size?: number }) {
  if (kind === 'music') return <Icon.Music size={size} />;
  if (kind === 'audiobook') return <Icon.Book size={size} />;
  if (kind === 'podcast') return <Icon.Podcast size={size} />;
  if (kind === 'episode') return <Icon.TV size={size} />;
  return <Icon.Movie size={size} />;
}

function Thumb({ e }: { e: HistoryEntry }) {
  const square = e.kind === 'music' || e.kind === 'audiobook' || e.kind === 'podcast';
  const cls = square ? 'w-12 h-12' : 'w-12 h-16';
  return (
    <div className={cx(cls, 'rounded-lg bg-white/5 overflow-hidden shrink-0 grid place-items-center text-slate-500')}>
      {e.imageUrl ? <img src={api.url(e.imageUrl)} loading="lazy" className="w-full h-full object-cover" /> : <KindIcon kind={e.kind} />}
    </div>
  );
}

export default function History() {
  const [entries, setEntries] = useState<HistoryEntry[]>([]);
  const [stats, setStats] = useState<HistoryStats | null>(null);
  const [filter, setFilter] = useState<Filter>('all');
  const [ready, setReady] = useState(false);

  useEffect(() => {
    Promise.all([
      api.history.list().catch(() => ({ entries: [] })),
      api.history.stats().catch(() => ({ watchSec: 0, musicSec: 0, bookSec: 0, weekSec: 0, topItems: [] })),
    ]).then(([list, st]) => { setEntries(list.entries || []); setStats(st); setReady(true); });
  }, []);

  const filtered = useMemo(() => entries.filter(e => {
    if (filter === 'all') return true;
    if (filter === 'video') return e.kind === 'movie' || e.kind === 'episode' || e.kind === 'video';
    return e.kind === filter;
  }), [entries, filter]);

  const groups = useMemo(() => {
    const out: { day: string; rows: HistoryEntry[] }[] = [];
    for (const e of filtered) {
      let g = out[out.length - 1];
      if (!g || g.day !== e.day) { g = { day: e.day, rows: [] }; out.push(g); }
      g.rows.push(e);
    }
    return out;
  }, [filtered]);

  if (!ready || !stats) return <PageLoader />;

  return (
    <div className="animate-fade-in">
      <div className="mb-6">
        <h1 className="text-2xl sm:text-3xl font-bold text-white tracking-tight">History</h1>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4 mb-6">
        {[
          ['Watched', stats.watchSec, 'video'],
          ['Music', stats.musicSec, 'songs'],
          ['Audiobooks', stats.bookSec, 'books'],
          ['This week', stats.weekSec, 'total'],
        ].map(([label, sec, caption]) => (
          <div key={label as string} className="bg-white/5 border border-white/10 rounded-2xl p-4">
            <p className="text-xl sm:text-2xl font-bold text-white tabular-nums">{fmtHours(sec as number)}</p>
            <p className="text-xs text-slate-400 mt-1">{caption as string}</p>
            <p className="text-sm font-medium text-white mt-3">{label as string}</p>
          </div>
        ))}
      </div>

      <div className="flex gap-2 overflow-x-auto pb-1 mb-2">
        {filters.map(f => (
          <button key={f.key} type="button" onClick={() => setFilter(f.key)}
            className={cx('px-3 py-1.5 rounded-full text-sm whitespace-nowrap transition-colors',
              filter === f.key ? 'bg-white/10 text-white' : 'text-slate-400 hover:text-white hover:bg-white/5')}>
            {f.label}
          </button>
        ))}
      </div>

      {groups.length === 0 ? (
        <div className="min-h-[260px] grid place-items-center text-slate-500 text-sm">Play something and it will show up here.</div>
      ) : groups.map(g => (
        <section key={g.day}>
          <h2 className="text-sm font-medium text-slate-400 mt-6 mb-2">{dayLabel(g.day)}</h2>
          <div className="bg-white/5 border border-white/10 rounded-2xl overflow-hidden">
            {g.rows.map(e => {
              const pct = e.durationSec > 0 ? Math.max(0, Math.min(100, (e.positionSec / e.durationSec) * 100)) : 0;
              return (
                <div key={`${e.kind}:${e.itemId}:${e.day}`} className="flex items-center gap-3 p-3 border-b border-white/10 last:border-b-0">
                  <Thumb e={e} />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-white truncate">{e.title}</p>
                    <p className="text-sm text-slate-400 truncate">{e.subtitle || ''}</p>
                  </div>
                  <div className="w-20 sm:w-28 shrink-0 text-right">
                    <p className="text-sm text-white tabular-nums">{fmtHours(e.seconds)}</p>
                    {e.durationSec > 0 && (
                      <div className="h-1 bg-white/10 rounded mt-1 overflow-hidden">
                        <div className="h-full bg-indigo-500 rounded" style={{ width: `${pct}%` }} />
                      </div>
                    )}
                    <p className="text-[10px] font-semibold tracking-wide text-slate-500 mt-1">{kindLabel(e.kind)}</p>
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}
