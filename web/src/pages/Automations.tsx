import React, { useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api';
import { Icon } from '../lib/icons';
import { cx, formatRelative } from '../lib/utils';
import { toast, useAuth } from '../lib/store';
import { Badge, EmptyState, PageHeader, PageLoader } from '../components/ui';
import type { Automation } from '../lib/model';

const TASK_STYLE: Record<string, {
  icon: React.ReactNode;
  color: string;
  detail: string;
}> = {
  'health-alerts': {
    icon: <Icon.Monitor size={20} />,
    color: '#06b6d4',
    detail: 'Monitoring alert thresholds and the service-alert setting still determine which notifications are emitted.',
  },
  'nightly-recovery-bundle': {
    icon: <Icon.Backup size={20} />,
    color: '#6366f1',
    detail: 'A run counts only after the archive, manifest, checksums and SQLite integrity checks all succeed.',
  },
  'auto-request-sweep': {
    icon: <Icon.Robot size={20} />,
    color: '#a855f7',
    detail: 'Requires a configured request service and AI provider; each member’s Auto Request preference and weekly limit are respected.',
  },
  'time-machine-scheduler': {
    icon: <Icon.Clock size={20} />,
    color: '#10b981',
    detail: 'Only accounts whose Time Machine policy is enabled and due receive a snapshot.',
  },
};

function lastRun(value?: string): string {
  return value ? formatRelative(value) : 'Never completed';
}

function Toggle({ automation, busy, onClick }: {
  automation: Automation;
  busy: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      aria-label={`${automation.enabled ? 'Pause' : 'Enable'} ${automation.name}`}
      aria-pressed={automation.enabled}
      className={cx(
        'relative w-12 h-7 rounded-full transition-colors shrink-0 disabled:opacity-60',
        automation.enabled ? 'bg-brand-500 shadow-glow' : 'bg-ink-700',
      )}
    >
      <span className={cx(
        'absolute top-1 left-1 w-5 h-5 rounded-full bg-white shadow-md transition-transform grid place-items-center',
        automation.enabled && 'translate-x-5',
      )}>
        {busy && <span className="w-2.5 h-2.5 rounded-full border-2 border-brand-500 border-t-transparent animate-spin" />}
      </span>
    </button>
  );
}

function TaskCard({ automation, busy, onToggle }: {
  automation: Automation;
  busy: boolean;
  onToggle: () => void;
}) {
  const style = TASK_STYLE[automation.id] || {
    icon: <Icon.Bolt size={20} />,
    color: '#94a3b8',
    detail: 'This built-in task is executed by the Aerie scheduler.',
  };
  return (
    <article className={cx('card p-5 flex flex-col gap-4', !automation.enabled && 'opacity-80')}>
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-start gap-3 min-w-0">
          <div
            className="w-11 h-11 rounded-xl grid place-items-center shrink-0"
            style={{ color: style.color, background: `${style.color}1f` }}
          >
            {style.icon}
          </div>
          <div className="min-w-0">
            <h2 className="font-semibold text-white leading-snug">{automation.name}</h2>
            <div className="mt-1">
              <Badge color={automation.enabled ? 'green' : 'slate'}>{automation.enabled ? 'Running' : 'Paused'}</Badge>
            </div>
          </div>
        </div>
        <Toggle automation={automation} busy={busy} onClick={onToggle} />
      </div>

      <div className="space-y-2.5">
        <div className="rounded-xl bg-white/[0.025] border border-white/[0.05] px-3.5 py-3">
          <p className="text-[11px] uppercase tracking-wide text-slate-500">Schedule</p>
          <p className="text-sm text-slate-200 mt-1">{automation.trigger}</p>
        </div>
        <div className="rounded-xl bg-white/[0.025] border border-white/[0.05] px-3.5 py-3">
          <p className="text-[11px] uppercase tracking-wide text-slate-500">Real executor</p>
          <p className="text-sm text-slate-200 mt-1 leading-relaxed">{automation.action}</p>
        </div>
      </div>

      <p className="text-xs text-slate-500 leading-relaxed">{style.detail}</p>
      <div className="grid grid-cols-2 gap-3 mt-auto pt-1">
        <div>
          <p className="text-lg font-semibold text-white">{automation.runCount.toLocaleString('en-US')}</p>
          <p className="text-xs text-slate-500">completed runs</p>
        </div>
        <div>
          <p className="text-sm font-medium text-white mt-1 truncate" title={automation.lastRun || undefined}>{lastRun(automation.lastRun)}</p>
          <p className="text-xs text-slate-500 mt-0.5">last completion</p>
        </div>
      </div>
    </article>
  );
}

export default function Automations() {
  const { user } = useAuth();
  const [items, setItems] = useState<Automation[] | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  useEffect(() => {
    if (user?.role !== 'admin') return;
    api.automations.list()
      .then(setItems)
      .catch((error: any) => {
        setItems([]);
        toast('Failed to load system tasks', 'error', error?.message);
      });
  }, [user?.role]);

  const summary = useMemo(() => {
    const rows = items || [];
    return {
      active: rows.filter(item => item.enabled).length,
      runs: rows.reduce((total, item) => total + item.runCount, 0),
    };
  }, [items]);

  async function toggle(automation: Automation) {
    setBusyId(automation.id);
    setItems(current => current?.map(item => item.id === automation.id
      ? { ...item, enabled: !item.enabled }
      : item) || current);
    try {
      const updated = await api.automations.toggle(automation.id);
      setItems(current => current?.map(item => item.id === updated.id ? updated : item) || current);
      toast(updated.enabled ? 'System task enabled' : 'System task paused', 'success', updated.name);
    } catch (error: any) {
      setItems(current => current?.map(item => item.id === automation.id ? automation : item) || current);
      toast('Could not update system task', 'error', error?.message);
    } finally {
      setBusyId(null);
    }
  }

  if (user?.role !== 'admin') {
    return (
      <EmptyState
        icon={<Icon.Shield size={30} />}
        title="Administrator access required"
        subtitle="System-wide scheduler controls are available only to administrators."
      />
    );
  }
  if (!items) return <PageLoader />;

  return (
    <div className="animate-fade-in">
      <PageHeader
        title="System tasks"
        subtitle="Only built-in jobs with real server-side executors appear here."
        icon={<Icon.Bolt size={22} />}
      />

      <div className="glass rounded-2xl px-5 py-4 mb-6 flex flex-wrap items-center gap-5">
        <div className="flex items-start gap-3 max-w-2xl">
          <div className="w-10 h-10 rounded-xl grid place-items-center bg-brand-500/15 text-brand-400 shrink-0">
            <Icon.Info size={19} />
          </div>
          <div>
            <p className="text-sm font-medium text-white">These toggles directly gate scheduler execution.</p>
            <p className="text-xs text-slate-400 mt-1 leading-relaxed">
              Pausing a task prevents its next scheduled evaluation. Run counts and timestamps update only after its real executor completes.
            </p>
          </div>
        </div>
        <div className="flex gap-6 ml-auto">
          <div><p className="text-2xl font-bold text-white">{summary.active}/{items.length}</p><p className="text-xs muted">active tasks</p></div>
          <div><p className="text-2xl font-bold text-white">{summary.runs.toLocaleString('en-US')}</p><p className="text-xs muted">completed runs</p></div>
        </div>
      </div>

      {items.length === 0 ? (
        <EmptyState
          icon={<Icon.Bolt size={30} />}
          title="No executable tasks found"
          subtitle="The built-in scheduler catalog could not be loaded. Check the server logs before relying on background work."
        />
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {items.map(item => (
            <TaskCard
              key={item.id}
              automation={item}
              busy={busyId === item.id}
              onToggle={() => toggle(item)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
