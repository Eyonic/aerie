import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { Icon } from '../lib/icons';
import { cx, formatBytes, formatRelative } from '../lib/utils';
import { toast, useAuth } from '../lib/store';
import { normalizeInternalRoute } from '../lib/internal-route';
import { EmptyState, PageHeader, PageLoader } from '../components/ui';
import type { Notification } from '../lib/model';

type Job = { id: string; type: string; status: string; prompt?: string; progress: number; error?: string; createdAt: string; finishedAt?: string };
type Conflict = { id: string; base: string; relPath: string; deviceSize?: number; serverSize?: number; updatedAt?: string };

const jobTitle = (job: Job) => {
  const action = String(job.prompt || '').split(':')[0];
  if (job.type === 'subtitles') return action === 'translate' ? 'Translate subtitles' : action === 'sync' ? 'Synchronize subtitles' : 'Generate AI subtitles';
  if (job.type === 'dedup') return action === 'remove' ? 'Remove duplicate files' : 'Scan duplicate files';
  if (job.type === 'music') return 'Generate AI music';
  if (job.type === 'image') return 'Generate AI image';
  return job.prompt || job.type;
};

const jobLink = (job: Job) => job.type === 'dedup' ? '/sync'
  : job.type === 'music' ? '/music-studio'
    : job.type === 'image' ? '/ai-images'
      : '/jobs';

function ToneIcon({ tone }: { tone: 'error' | 'warning' | 'success' | 'info' }) {
  return <div className={cx('grid h-10 w-10 shrink-0 place-items-center rounded-xl',
    tone === 'error' ? 'bg-accent-red/15 text-accent-red'
      : tone === 'warning' ? 'bg-accent-amber/15 text-accent-amber'
        : tone === 'success' ? 'bg-accent-green/15 text-accent-green' : 'bg-brand-500/15 text-brand-300')}>
    {tone === 'error' ? <Icon.Close size={18} /> : tone === 'warning' ? <Icon.Warning size={18} /> : tone === 'success' ? <Icon.Check size={18} /> : <Icon.Bell size={18} />}
  </div>;
}

export default function Jobs() {
  const navigate = useNavigate();
  const user = useAuth(state => state.user);
  const [jobs, setJobs] = useState<Job[] | null>(null);
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [conflicts, setConflicts] = useState<Conflict[]>([]);

  const load = async () => {
    const [jobResult, notificationResult, conflictResult] = await Promise.allSettled([
      api.jobs.list(), api.notifications.list(), user?.features?.sync === false ? Promise.resolve({ items: [] }) : api.sync.conflicts(),
    ]);
    setJobs(jobResult.status === 'fulfilled' ? jobResult.value.items || [] : []);
    if (notificationResult.status === 'fulfilled') setNotifications(notificationResult.value || []);
    if (conflictResult.status === 'fulfilled') setConflicts(conflictResult.value.items || []);
  };

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 5000);
    return () => clearInterval(timer);
  }, [user?.features?.sync]);

  const attentionNotifications = useMemo(() => notifications.filter(note => !note.read && (note.level === 'error' || note.level === 'warning')), [notifications]);
  const activeJobs = useMemo(() => (jobs || []).filter(job => job.status === 'queued' || job.status === 'running'), [jobs]);
  const failedJobs = useMemo(() => (jobs || []).filter(job => job.status === 'error'), [jobs]);
  const recentJobs = useMemo(() => (jobs || []).filter(job => job.status === 'done').slice(0, 12), [jobs]);
  const attentionCount = conflicts.length + failedJobs.length + attentionNotifications.length;

  const openNotification = async (note: Notification) => {
    try { await api.notifications.read(note.id); } catch { /* navigation remains useful */ }
    setNotifications(old => old.map(item => item.id === note.id ? { ...item, read: true } : item));
    const destination = normalizeInternalRoute(note.link);
    if (destination) navigate(destination);
  };

  const resolveConflict = async (conflict: Conflict, action: 'device' | 'server' | 'dismiss') => {
    try {
      await api.sync.resolveConflict(conflict.id, action);
      setConflicts(old => old.filter(item => item.id !== conflict.id));
      toast('Conflict resolved', 'success', action === 'device' ? 'The device copy will be used.' : action === 'server' ? 'The server copy was kept.' : 'The conflict was dismissed.');
    } catch (error: any) { toast('Could not resolve conflict', 'error', error?.message); }
  };

  if (jobs === null) return <PageLoader />;

  return <div className="animate-fade-in">
    <PageHeader title="Action Centre" subtitle={attentionCount ? `${attentionCount} item${attentionCount === 1 ? '' : 's'} need attention` : 'Everything requiring a decision, retry or follow-up'} icon={<Icon.Bell size={22} />}
      actions={notifications.some(note => !note.read) ? <button className="btn-secondary" onClick={async () => { await api.notifications.read(); setNotifications(old => old.map(note => ({ ...note, read: true }))); }}>Mark all read</button> : undefined} />

    {!attentionCount && !activeJobs.length && !notifications.length && !recentJobs.length ? <EmptyState icon={<Icon.Check size={30} />} title="Nothing needs your attention" subtitle="Sync conflicts, failed work and important system messages will appear here." /> : <div className="space-y-7">
      {(attentionCount > 0) && <section>
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-slate-400">Needs attention</h2>
        <div className="space-y-3">
          {conflicts.map(conflict => <div key={`conflict:${conflict.id}`} className="card p-4">
            <div className="flex items-start gap-3"><ToneIcon tone="warning" /><div className="min-w-0 flex-1"><p className="truncate text-sm font-semibold text-white">Choose which copy to keep</p><p className="mt-0.5 truncate text-xs muted">{conflict.relPath} · device {formatBytes(conflict.deviceSize || 0)} · server {formatBytes(conflict.serverSize || 0)}</p>
              <div className="mt-3 flex flex-wrap gap-2"><button className="btn-secondary !py-1.5" onClick={() => void resolveConflict(conflict, 'device')}>Keep device</button><button className="btn-secondary !py-1.5" onClick={() => void resolveConflict(conflict, 'server')}>Keep server</button><button className="btn-ghost !py-1.5" onClick={() => navigate('/sync')}>Inspect</button><button className="btn-ghost !py-1.5" onClick={() => void resolveConflict(conflict, 'dismiss')}>Dismiss</button></div>
            </div></div>
          </div>)}
          {failedJobs.map(job => <button key={`failed:${job.type}:${job.id}`} onClick={() => navigate(jobLink(job))} className="card flex w-full items-start gap-3 p-4 text-left hover:border-accent-red/30"><ToneIcon tone="error" /><span className="min-w-0 flex-1"><span className="block text-sm font-semibold text-white">{jobTitle(job)} failed</span><span className="mt-0.5 block break-words text-xs text-accent-red">{job.error || 'Open the originating tool to try again.'}</span></span><Icon.ChevronRight size={17} className="mt-2 shrink-0 text-slate-500" /></button>)}
          {attentionNotifications.map(note => <button key={`note:${note.id}`} onClick={() => void openNotification(note)} className="card flex w-full items-start gap-3 p-4 text-left hover:border-white/15"><ToneIcon tone={note.level === 'error' ? 'error' : 'warning'} /><span className="min-w-0 flex-1"><span className="block text-sm font-semibold text-white">{note.title}</span><span className="mt-0.5 block text-xs muted">{note.body}</span></span>{normalizeInternalRoute(note.link) && <Icon.ChevronRight size={17} className="mt-2 shrink-0 text-slate-500" />}</button>)}
        </div>
      </section>}

      {activeJobs.length > 0 && <section><h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-slate-400">In progress</h2><div className="space-y-3">{activeJobs.map(job => {
        const pct = Math.round(Math.max(0, Math.min(1, job.progress || 0)) * 100);
        return <div key={`active:${job.type}:${job.id}`} className="card p-4"><div className="flex items-center gap-3"><ToneIcon tone="info" /><div className="min-w-0 flex-1"><div className="flex justify-between gap-2"><p className="truncate text-sm font-semibold text-white">{jobTitle(job)}</p><span className="text-xs text-brand-300">{job.status === 'queued' ? 'Queued' : `${pct}%`}</span></div><div className="mt-2 h-2 overflow-hidden rounded-full bg-white/[0.07]"><div className="h-full bg-brand-500 transition-all" style={{ width: `${Math.max(2, pct)}%` }} /></div></div></div></div>;
      })}</div></section>}

      {(notifications.length > 0 || recentJobs.length > 0) && <section><h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-slate-400">Recent</h2><div className="divide-y divide-white/[0.05] overflow-hidden rounded-2xl border border-white/[0.07] bg-white/[0.02]">
        {notifications.filter(note => !attentionNotifications.some(item => item.id === note.id)).slice(0, 15).map(note => <button key={note.id} onClick={() => void openNotification(note)} className="flex w-full items-center gap-3 p-3 text-left hover:bg-white/[0.035]"><span className={cx('h-2 w-2 shrink-0 rounded-full', note.read ? 'bg-slate-700' : note.level === 'success' ? 'bg-accent-green' : 'bg-brand-400')} /><span className="min-w-0 flex-1"><span className="block truncate text-sm text-slate-200">{note.title}</span><span className="block truncate text-xs muted">{note.body}</span></span><span className="shrink-0 text-[11px] text-slate-600">{formatRelative(note.ts)}</span></button>)}
        {recentJobs.map(job => <div key={`done:${job.type}:${job.id}`} className="flex items-center gap-3 p-3"><Icon.Check size={15} className="shrink-0 text-accent-green" /><span className="min-w-0 flex-1 truncate text-sm text-slate-300">{jobTitle(job)}</span><span className="shrink-0 text-[11px] text-slate-600">{formatRelative(job.finishedAt || job.createdAt)}</span></div>)}
      </div></section>}
    </div>}
  </div>;
}
