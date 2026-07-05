import React, { useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api';
import { Icon } from '../lib/icons';
import { toast } from '../lib/store';
import { formatBytes, cx } from '../lib/utils';
import { PageHeader, Badge, Spinner, EmptyState, ConfirmModal } from '../components/ui';
import type { BackupStatus } from '../lib/model';

const RETENTION = 14;
const STALE_MS = 30 * 60 * 60 * 1000; // ~30h: a nightly backup older than this is stale

interface HistoryRow {
  name: string;
  sizeBytes?: number;
  createdAt: string;
  success: boolean;
}

type Pill = { label: string; color: 'green' | 'red' | 'amber'; dot: string };

// Backups are timestamped by the Aerie host, whose wall clock can drift from
// the viewer's browser. Comparing a server timestamp to the browser's Date.now()
// makes a just-created backup read "10m ago" instead of "just now". We pass in a
// measured server↔browser skew (ms) so ages are computed against the server clock,
// and defensively coerce a naive (timezone-less) timestamp to UTC.
function relative(iso: string | null | undefined, skew = 0): string {
  if (!iso) return '—';
  const norm = /[zZ]|[+-]\d{2}:?\d{2}$/.test(iso) ? iso : `${iso}Z`;
  const t = new Date(norm).getTime();
  if (isNaN(t)) return '—';
  const s = Math.round((Date.now() + skew - t) / 1000);
  if (s < 60) return 'just now';
  const m = Math.round(s / 60); if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60); if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24); if (d < 7) return `${d}d ago`;
  return new Date(norm).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

// The nightly job (and the manual "Run backup now") only snapshot the Aerie
// database — that is the single real backup. The other targets are placeholders
// that never actually run, so we must not present them as Healthy.
function isRealBackup(b: BackupStatus): boolean {
  return b.key === 'db' && !!b.lastRun && b.success;
}

function statusOf(b: BackupStatus): Pill {
  if (b.key !== 'db') {
    // Not independently backed up. Off-site is simply not configured.
    if (b.key === 'offsite' || (!b.nextRun && !b.lastRun)) return { label: 'Not configured', color: 'amber', dot: '#f59e0b' };
    // files/config are covered by the nightly DB snapshot, not independently
    // scheduled — don't imply a pending run they'll never make. This keeps the
    // pill/health consistent with the "Next run: Not scheduled" field below.
    return { label: 'Not scheduled', color: 'amber', dot: '#f59e0b' };
  }
  if (!b.lastRun) return { label: 'Pending', color: 'amber', dot: '#f59e0b' };
  if (!b.success) return { label: 'Failed', color: 'red', dot: '#ef4444' };
  const age = Date.now() - new Date(b.lastRun).getTime();
  if (age > STALE_MS) return { label: 'Stale', color: 'amber', dot: '#f59e0b' };
  return { label: 'Healthy', color: 'green', dot: '#10b981' };
}

// Next automatic run: the scheduler fires the nightly database backup at 03:00
// local time. Compute the real upcoming occurrence rather than trusting the
// backend's free-text hint (which isn't a parseable date).
function nextNightlyRun(hour = 3): Date {
  const now = new Date();
  const next = new Date(now);
  next.setHours(hour, 0, 0, 0);
  if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);
  return next;
}

function formatNextRun(d: Date): string {
  const now = new Date();
  const sameDay = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
  return `${sameDay ? 'Today' : 'Tomorrow'} ${time}`;
}

function StatTile({ icon, label, value, sub, color }: { icon: React.ReactNode; label: string; value: string; sub?: string; color: string }) {
  return (
    <div className="card p-4 sm:p-5">
      <div className="w-9 h-9 sm:w-10 sm:h-10 rounded-xl grid place-items-center" style={{ background: `${color}22`, color }}>{icon}</div>
      <p className="text-xl sm:text-2xl font-bold text-white mt-3 tracking-tight truncate" title={value}>{value}</p>
      <p className="text-sm muted">{label}</p>
      {sub && <p className="text-xs text-slate-500 mt-1 truncate">{sub}</p>}
    </div>
  );
}

function StatusCard({ b, skew }: { b: BackupStatus; skew: number }) {
  const st = statusOf(b);
  const real = isRealBackup(b);
  // Only the database is truly captured, so only it shows a last-run time and
  // real size. Only it is on the nightly schedule, so only it has a next run.
  const lastRunLabel = real ? relative(b.lastRun, skew) : 'Never';
  const sizeLabel = real && b.sizeBytes != null ? formatBytes(b.sizeBytes) : '—';
  const nextRunText = b.key === 'db' ? formatNextRun(nextNightlyRun()) : 'Not scheduled';
  const note = b.note || (b.key !== 'db' ? 'Not independently backed up yet — the nightly job snapshots the database.' : undefined);
  return (
    <div className="card card-hover p-5 flex flex-col">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-3 min-w-0">
          <div className="w-10 h-10 rounded-xl grid place-items-center bg-white/[0.04] text-slate-300 shrink-0">
            <Icon.Backup size={20} />
          </div>
          <div className="min-w-0">
            <p className="font-semibold text-white leading-snug break-words">{b.name}</p>
            <p className="text-xs text-slate-500 truncate font-mono">{b.key}</p>
          </div>
        </div>
        <div className="shrink-0">
          <Badge color={st.color}>
            <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
              <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: st.dot }} />
              {st.label}
            </span>
          </Badge>
        </div>
      </div>

      <div className="mt-4 grid grid-cols-2 gap-3">
        <div className="rounded-xl bg-white/[0.02] border border-white/[0.05] px-3 py-2.5">
          <p className="text-[11px] uppercase tracking-wide text-slate-500">Last run</p>
          <p className="text-sm text-slate-200 mt-0.5 truncate">{lastRunLabel}</p>
        </div>
        <div className="rounded-xl bg-white/[0.02] border border-white/[0.05] px-3 py-2.5">
          <p className="text-[11px] uppercase tracking-wide text-slate-500">Size</p>
          <p className="text-sm text-slate-200 mt-0.5 truncate">{sizeLabel}</p>
        </div>
        <div className="rounded-xl bg-white/[0.02] border border-white/[0.05] px-3 py-2.5">
          <p className="text-[11px] uppercase tracking-wide text-slate-500">Next run</p>
          <p className="text-sm text-slate-200 mt-0.5 truncate">{nextRunText}</p>
        </div>
        <div className="rounded-xl bg-white/[0.02] border border-white/[0.05] px-3 py-2.5">
          <p className="text-[11px] uppercase tracking-wide text-slate-500">Health</p>
          <p className={cx('text-sm mt-0.5', st.color === 'green' ? 'text-green-400' : st.color === 'red' ? 'text-red-400' : 'text-amber-400')}>{st.label}</p>
        </div>
      </div>

      {note && <p className="text-xs text-slate-500 mt-3 leading-relaxed">{note}</p>}
    </div>
  );
}

export default function Backups() {
  const [targets, setTargets] = useState<BackupStatus[] | null>(null);
  const [history, setHistory] = useState<HistoryRow[]>([]);
  const [running, setRunning] = useState(false);
  const [confirm, setConfirm] = useState<HistoryRow | null>(null);
  const [restoring, setRestoring] = useState<string | null>(null);
  const [restoreNote, setRestoreNote] = useState<string | null>(null);
  const [serverSkew, setServerSkew] = useState(0); // ms: (server clock) − (browser clock)

  // Measure the server↔browser clock offset from the HTTP Date header so relative
  // times are computed against the same clock the backups were stamped with.
  const syncClock = async () => {
    try {
      const token = localStorage.getItem('cb_token');
      const res = await fetch('/api/backups/history', {
        method: 'HEAD', cache: 'no-store',
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      });
      const h = res.headers.get('date');
      const server = h ? new Date(h).getTime() : NaN;
      if (!isNaN(server)) setServerSkew(server - Date.now());
    } catch { /* best-effort — fall back to the browser clock */ }
  };

  const load = async () => {
    const [list, hist] = await Promise.all([
      api.backups.list().catch(() => [] as BackupStatus[]),
      api.backups.history().catch(() => [] as HistoryRow[]),
    ]);
    setTargets(Array.isArray(list) ? (list as BackupStatus[]) : []);
    setHistory(Array.isArray(hist) ? (hist as HistoryRow[]) : []);
  };

  useEffect(() => { syncClock(); load(); }, []);

  const runNow = async () => {
    setRunning(true);
    try {
      const res: any = await api.backups.run();
      // Anchor the clock skew to the just-created backup so it reads "just now"
      // immediately, regardless of host clock drift.
      const t = res?.createdAt ? new Date(res.createdAt).getTime() : NaN;
      if (!isNaN(t)) setServerSkew(t - Date.now());
      // The server emits a live "Backup complete" notification (SSE → toast in
      // the top bar). Don't fire a second toast here or the user sees a duplicate.
      await load();
    } catch (e: any) {
      const msg = String(e?.message || e || '');
      if (msg.includes('403') || /forbidden/i.test(msg)) {
        toast('Not allowed', 'warning', 'Only administrators can trigger a backup.');
      } else {
        toast('Backup failed', 'error', msg || 'Please try again.');
      }
    } finally {
      setRunning(false);
    }
  };

  const doRestore = async (row: HistoryRow) => {
    setRestoring(row.name);
    try {
      const res = await api.backups.restore(row.name);
      const note = res?.note || 'Restart the Aerie container to load the restored database.';
      setRestoreNote(note);
      toast('Backup restored', 'success', row.name);
      await load();
    } catch (e: any) {
      const msg = String(e?.message || e || '');
      if (msg.includes('403') || /forbidden/i.test(msg)) {
        toast('Not allowed', 'warning', 'Only administrators can restore a backup.');
      } else {
        toast('Restore failed', 'error', msg || 'Please try again.');
      }
    } finally {
      setRestoring(null);
    }
  };

  const summary = useMemo(() => {
    const list = targets || [];
    // Only genuine backups count toward the totals — the other targets never run,
    // and the backend echoes the DB size for the file target which would double-count.
    const real = list.filter(isRealBackup);
    const lastSuccess = real
      .map(b => b.lastRun as string)
      .sort((a, b) => new Date(b).getTime() - new Date(a).getTime())[0];
    const totalSize = real.reduce((s, b) => s + (b.sizeBytes || 0), 0);
    return { lastSuccess, totalSize, count: list.length, realCount: real.length };
  }, [targets]);

  const nextRunLabel = formatNextRun(nextNightlyRun());

  if (!targets) {
    return <div className="grid place-items-center h-full min-h-[50vh] text-brand-400"><Spinner size={34} /></div>;
  }

  return (
    <div className="animate-fade-in">
      <PageHeader
        title="Backups"
        subtitle="Nightly snapshots of your private cloud, kept safe and ready to restore."
        icon={<Icon.Backup size={22} />}
        actions={
          <button className="btn-primary" onClick={runNow} disabled={running} title="Capture a snapshot now">
            {running ? <Spinner size={16} /> : <Icon.Refresh size={16} />}
            <span className="ml-1">{running ? 'Running…' : 'Run backup now'}</span>
          </button>
        }
      />

      {/* Restore info banner */}
      {restoreNote && (
        <div className="glass rounded-2xl px-5 py-4 mb-6 flex items-start gap-3 border border-brand-500/30 bg-brand-500/[0.06]">
          <div className="w-9 h-9 rounded-xl grid place-items-center bg-brand-500/20 text-brand-300 shrink-0">
            <Icon.Info size={18} />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold text-white">Backup restored</p>
            <p className="text-sm text-slate-300 mt-0.5 leading-relaxed">{restoreNote}</p>
          </div>
          <button className="icon-btn shrink-0" onClick={() => setRestoreNote(null)} title="Dismiss">
            <Icon.Close size={16} />
          </button>
        </div>
      )}

      {/* Summary tiles */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4 mb-6">
        <StatTile
          icon={<Icon.Check size={20} />} color="#10b981"
          label="Last successful backup"
          value={summary.lastSuccess ? relative(summary.lastSuccess, serverSkew) : 'None yet'}
        />
        <StatTile
          icon={<Icon.Cloud size={20} />} color="#6366f1"
          label="Latest snapshot"
          value={history.length ? formatBytes(history[0].sizeBytes ?? summary.totalSize) : '—'}
          sub={history.length ? `Latest of ${history.length} snapshot${history.length === 1 ? '' : 's'}` : 'No snapshot yet'}
        />
        <StatTile
          icon={<Icon.Clock size={20} />} color="#06b6d4"
          label="Next scheduled"
          value="03:00 nightly"
          sub={`Next: ${nextRunLabel}`}
        />
        <StatTile
          icon={<Icon.Shield size={20} />} color="#a855f7"
          label="Retention"
          value={`Last ${RETENTION} kept`}
          sub="Older snapshots pruned"
        />
      </div>

      {/* Reassuring banner */}
      <div className="glass rounded-2xl px-5 py-4 mb-6 flex items-start gap-3 border border-amber-500/20">
        <div className="w-9 h-9 rounded-xl grid place-items-center bg-amber-500/15 text-amber-400 shrink-0">
          <Icon.Warning size={18} />
        </div>
        <div>
          <p className="text-sm font-medium text-white">A backup isn't trusted until it's been restored in a test.</p>
          <p className="text-xs text-slate-400 mt-0.5">Periodically restore a recent snapshot to prove your backups actually work before you need them.</p>
        </div>
      </div>

      {/* Status cards */}
      <h2 className="section-title mb-3">Backup status</h2>
      {targets.length === 0 ? (
        <div className="card p-2 mb-8">
          <EmptyState
            icon={<Icon.Backup size={28} />}
            title="No backup targets configured"
            subtitle="Backup destinations will appear here once configured."
          />
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4 mb-8">
          {targets.map(b => <StatusCard key={b.key} b={b} skew={serverSkew} />)}
        </div>
      )}

      {/* History */}
      <div className="flex items-center justify-between mb-3">
        <h2 className="section-title">Backup history</h2>
        <button className="btn-ghost" onClick={load} title="Refresh">
          <Icon.Refresh size={16} />
        </button>
      </div>
      <div className="card !p-0 overflow-hidden">
        {history.length === 0 ? (
          <EmptyState
            icon={<Icon.Clock size={28} />}
            title="No backup runs yet"
            subtitle="Completed snapshots will appear here with their status, size, and a restore action."
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm min-w-[560px]">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wide text-slate-500 border-b border-white/[0.06]">
                  <th className="font-medium px-4 sm:px-5 py-3">Snapshot</th>
                  <th className="font-medium px-4 sm:px-5 py-3">Size</th>
                  <th className="font-medium px-4 sm:px-5 py-3">When</th>
                  <th className="font-medium px-4 sm:px-5 py-3">Status</th>
                  <th className="font-medium px-4 sm:px-5 py-3 text-right">Action</th>
                </tr>
              </thead>
              <tbody>
                {history.map((h, i) => (
                  <tr key={h.name ?? i} className="border-b border-white/[0.04] last:border-0 hover:bg-white/[0.02]">
                    <td className="px-4 sm:px-5 py-3">
                      <div className="flex items-center gap-2.5">
                        <Icon.Backup size={16} className="text-slate-500 shrink-0" />
                        <span className="text-slate-200 font-mono text-xs truncate max-w-[220px]">{h.name}</span>
                      </div>
                    </td>
                    <td className="px-4 sm:px-5 py-3 text-slate-400 whitespace-nowrap">{h.sizeBytes != null ? formatBytes(h.sizeBytes) : '—'}</td>
                    <td className="px-4 sm:px-5 py-3 text-slate-400 whitespace-nowrap">{h.createdAt ? relative(h.createdAt, serverSkew) : '—'}</td>
                    <td className="px-4 sm:px-5 py-3">
                      {h.success
                        ? <Badge color="green">Success</Badge>
                        : <Badge color="red">Failed</Badge>}
                    </td>
                    <td className="px-4 sm:px-5 py-3 text-right">
                      <button
                        className="btn-secondary !py-1.5 !px-3 text-xs whitespace-nowrap"
                        onClick={() => setConfirm(h)}
                        disabled={!h.success || restoring === h.name}
                        title={h.success ? 'Restore this snapshot' : 'Failed snapshots cannot be restored'}
                      >
                        {restoring === h.name ? <Spinner size={14} /> : <Icon.Refresh size={14} />}
                        <span className="ml-1">Restore</span>
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <ConfirmModal
        open={!!confirm}
        onClose={() => setConfirm(null)}
        onConfirm={() => { if (confirm) doRestore(confirm); }}
        title="Restore this backup?"
        message={`This replaces the current database with the snapshot "${confirm?.name}". You'll need to restart the Aerie container afterward to load it. This cannot be undone.`}
        confirmLabel="Restore"
        danger
      />
    </div>
  );
}
