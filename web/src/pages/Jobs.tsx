import React, { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { Icon } from '../lib/icons';
import { cx, formatRelative } from '../lib/utils';
import { EmptyState, PageHeader, PageLoader } from '../components/ui';

type Job = { id: string; type: string; status: string; prompt?: string; progress: number; error?: string; createdAt: string; finishedAt?: string };

const title = (j: Job) => {
  const action = String(j.prompt || '').split(':')[0];
  if (j.type === 'subtitles') return action === 'translate' ? 'Translate subtitles' : action === 'sync' ? 'Synchronize subtitles' : 'Generate AI subtitles';
  if (j.type === 'dedup') return action === 'remove' ? 'Remove duplicate files' : 'Scan duplicate files';
  if (j.type === 'music') return 'Generate AI music';
  if (j.type === 'image') return 'Generate AI image';
  return j.prompt || j.type;
};

export default function Jobs() {
  const [jobs, setJobs] = useState<Job[] | null>(null);
  const load = () => api.jobs.list().then(r => setJobs(r.items || [])).catch(() => setJobs([]));
  useEffect(() => {
    load();
    const timer = setInterval(load, 2500);
    return () => clearInterval(timer);
  }, []);
  if (jobs === null) return <PageLoader />;
  const active = jobs.filter(j => j.status === 'queued' || j.status === 'running').length;
  return (
    <div className="animate-fade-in">
      <PageHeader title="Jobs" subtitle={active ? `${active} active in the background` : 'Background work and recent results'} icon={<Icon.Bolt size={22} />} />
      {!jobs.length ? <EmptyState icon={<Icon.Bolt size={30} />} title="No background jobs yet" subtitle="AI subtitles, music generation and duplicate scans will appear here." /> : (
        <div className="space-y-3">
          {jobs.map(j => {
            const running = j.status === 'running' || j.status === 'queued';
            const pct = Math.round(Math.max(0, Math.min(1, j.progress || 0)) * 100);
            return <div key={`${j.type}:${j.id}`} className="card p-4 sm:p-5">
              <div className="flex items-start gap-3">
                <div className={cx('w-10 h-10 rounded-xl grid place-items-center shrink-0', j.status === 'error' ? 'bg-accent-red/15 text-accent-red' : j.status === 'done' ? 'bg-accent-green/15 text-accent-green' : 'bg-brand-500/15 text-brand-300')}>
                  {j.status === 'done' ? <Icon.Check size={19} /> : j.status === 'error' ? <Icon.Close size={19} /> : <Icon.Bolt size={19} />}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div><p className="text-sm font-semibold text-white">{title(j)}</p><p className="text-xs muted mt-0.5">{formatRelative(new Date(j.createdAt).toISOString())}</p></div>
                    <span className={cx('chip capitalize', j.status === 'error' ? 'text-accent-red' : j.status === 'done' ? 'text-accent-green' : 'text-brand-300')}>{j.status}</span>
                  </div>
                  {running && <div className="mt-3"><div className="h-2 rounded-full bg-white/[0.07] overflow-hidden"><div className="h-full bg-brand-500 transition-all" style={{ width: `${Math.max(2, pct)}%` }} /></div><p className="text-xs muted mt-1">{j.status === 'queued' ? 'Waiting for a worker…' : `${pct}% complete`}</p></div>}
                  {j.error && <p className="text-xs text-accent-red mt-2">{j.error}</p>}
                </div>
              </div>
            </div>;
          })}
        </div>
      )}
    </div>
  );
}
