import React, { useEffect, useMemo, useState } from 'react';
import { Icon } from '../lib/icons';
import { toast } from '../lib/store';
import { cx, formatBytes, formatRelative } from '../lib/utils';
import {
  timeMachineApi,
  type TimeMachineDiff,
  type TimeMachineEntry,
  type TimeMachineRetention,
  type TimeMachineSnapshot,
  type TimeMachineTask,
} from '../lib/time-machine-api';
import { Badge, ConfirmModal, EmptyState, Modal, PageHeader, PageLoader, Spinner } from '../components/ui';

type RestoreMode = 'skip' | 'rename' | 'overwrite';

const parentPath = (value: string) => value === '/' ? '/' : value.slice(0, value.lastIndexOf('/')) || '/';
const nameOf = (value: string) => value === '/' ? 'All files' : value.slice(value.lastIndexOf('/') + 1);
const errorMessage = (error: any, fallback: string) => String(error?.message || error || fallback).replace(/_/g, ' ');

function ChangeBadge({ change }: { change?: string }) {
  if (!change) return null;
  const details: Record<string, { label: string; color: 'green' | 'red' | 'amber' | 'cyan' }> = {
    added: { label: 'Added since', color: 'green' },
    removed: { label: 'Missing now', color: 'red' },
    modified: { label: 'Changed', color: 'amber' },
    'type-changed': { label: 'Type changed', color: 'cyan' },
  };
  const item = details[change];
  return item ? <Badge color={item.color}>{item.label}</Badge> : null;
}

function EntryIcon({ entry }: { entry: TimeMachineEntry }) {
  return (
    <div className={cx('w-9 h-9 rounded-xl grid place-items-center shrink-0',
      entry.type === 'directory' ? 'bg-brand-500/15 text-brand-300' : 'bg-white/[0.05] text-slate-400')}>
      {entry.type === 'directory' ? <Icon.Folder size={18} /> : entry.type === 'symlink' ? <Icon.Link size={17} /> : <Icon.Doc size={17} />}
    </div>
  );
}

function SnapshotList({ snapshots, selected, onSelect }: {
  snapshots: TimeMachineSnapshot[];
  selected: string | null;
  onSelect: (snapshot: TimeMachineSnapshot) => void;
}) {
  return (
    <aside className="card overflow-hidden lg:sticky lg:top-4 lg:self-start">
      <div className="px-4 py-3 border-b border-white/[0.06]">
        <p className="text-xs uppercase tracking-wider text-slate-500 font-semibold">Timeline</p>
      </div>
      <div className="max-h-[32vh] lg:max-h-[65vh] overflow-y-auto p-2">
        {snapshots.map((snapshot, index) => (
          <button key={snapshot.id} onClick={() => onSelect(snapshot)}
            className={cx('w-full text-left rounded-xl px-3 py-3 transition-colors border',
              selected === snapshot.id ? 'bg-brand-500/12 border-brand-500/25' : 'border-transparent hover:bg-white/[0.035]')}>
            <div className="flex items-start gap-2.5">
              <span className={cx('mt-1.5 w-2 h-2 rounded-full shrink-0', selected === snapshot.id ? 'bg-brand-400' : 'bg-slate-600')} />
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium text-white truncate">
                  {snapshot.label || (index === 0 ? 'Latest snapshot' : new Date(snapshot.createdAt).toLocaleString())}
                </span>
                <span className="block text-xs text-slate-500 mt-0.5">{formatRelative(snapshot.createdAt)} · {snapshot.fileCount} files</span>
                {snapshot.warningCount > 0 && <span className="block text-[11px] text-accent-amber mt-1">{snapshot.warningCount} skipped item{snapshot.warningCount === 1 ? '' : 's'}</span>}
              </span>
            </div>
          </button>
        ))}
      </div>
    </aside>
  );
}

function RetentionEditor({ open, policy, policyError, onRetryPolicy, onClose, onSaved, onPruned }: {
  open: boolean;
  policy: TimeMachineRetention | null;
  policyError: string | null;
  onRetryPolicy: () => Promise<unknown>;
  onClose: () => void;
  onSaved: (policy: TimeMachineRetention) => void;
  onPruned: () => Promise<void>;
}) {
  const [draft, setDraft] = useState<TimeMachineRetention | null>(policy);
  const [saving, setSaving] = useState(false);
  const [pruning, setPruning] = useState(false);
  const [retryingPolicy, setRetryingPolicy] = useState(false);
  const [confirmPrune, setConfirmPrune] = useState(false);
  const [actionError, setActionError] = useState<{ message: string; retry: 'save' | 'apply' | 'refresh' } | null>(null);
  useEffect(() => {
    if (!open) return;
    setDraft(policy);
    setActionError(null);
    setConfirmPrune(false);
  }, [open, policy]);

  const retryPolicy = async () => {
    setRetryingPolicy(true);
    try { await onRetryPolicy(); }
    finally { setRetryingPolicy(false); }
  };

  if (!draft) return (
    <Modal open={open} onClose={onClose} title="Automatic snapshots and retention" size="sm">
      {policyError ? (
        <div role="alert" className="rounded-xl border border-accent-red/25 bg-accent-red/[0.07] p-4">
          <p className="text-sm font-medium text-white">Retention settings could not be loaded</p>
          <p className="text-xs text-slate-400 mt-1">{policyError}</p>
          <button className="btn-secondary mt-3" disabled={retryingPolicy} onClick={() => void retryPolicy()}>
            {retryingPolicy ? <Spinner size={15} /> : <Icon.Refresh size={15} />} Retry
          </button>
        </div>
      ) : <div className="grid place-items-center py-10"><Spinner /></div>}
    </Modal>
  );
  const number = (key: keyof TimeMachineRetention, value: string) => setDraft({ ...draft, [key]: Math.max(0, Number(value) || 0) });
  const field = (label: string, key: keyof TimeMachineRetention, suffix: string) => (
    <label className="block">
      <span className="text-xs text-slate-400">{label}</span>
      <span className="mt-1 flex items-center rounded-xl bg-white/[0.035] border border-white/[0.08] overflow-hidden">
        <input className="input border-0 rounded-none bg-transparent flex-1" type="number" min="0"
          value={String(draft[key] ?? '')} onChange={event => number(key, event.target.value)} />
        <span className="text-xs text-slate-500 px-3">{suffix}</span>
      </span>
    </label>
  );
  const save = async () => {
    setSaving(true); setActionError(null);
    try {
      const saved = await timeMachineApi.saveRetention(draft);
      setDraft(saved); onSaved(saved); toast('Retention saved', 'success'); onClose();
    } catch (error: any) {
      setActionError({ message: `The policy was not saved: ${errorMessage(error, 'Please try again.')}`, retry: 'save' });
    }
    finally { setSaving(false); }
  };
  const applyNow = async () => {
    setPruning(true); setActionError(null);
    let stage: 'save' | 'apply' = 'save';
    try {
      const saved = await timeMachineApi.saveRetention(draft);
      setDraft(saved); onSaved(saved);
      stage = 'apply';
      const result = await timeMachineApi.prune();
      toast('Retention applied', 'success', `${result.removedSnapshots} snapshots and ${formatBytes(result.removedBytes)} of unreferenced data removed.`);
      try { await onPruned(); }
      catch (error: any) {
        setActionError({ message: `Retention was applied, but the timeline could not refresh: ${errorMessage(error, 'Please retry the refresh.')}`, retry: 'refresh' });
      }
    } catch (error: any) {
      setActionError({
        message: stage === 'save'
          ? `Nothing was pruned because the policy could not be saved: ${errorMessage(error, 'Please try again.')}`
          : `The policy was saved, but old snapshots could not be pruned: ${errorMessage(error, 'Please try again.')}`,
        retry: 'apply',
      });
    }
    finally { setPruning(false); }
  };
  const retryAction = async () => {
    if (!actionError) return;
    if (actionError.retry === 'save') return save();
    if (actionError.retry === 'apply') return applyNow();
    setPruning(true); setActionError(null);
    try { await onPruned(); }
    catch (error: any) {
      setActionError({ message: `The timeline still could not refresh: ${errorMessage(error, 'Please try again.')}`, retry: 'refresh' });
    } finally { setPruning(false); }
  };
  const busy = saving || pruning;
  const close = () => { if (!busy) onClose(); };
  return (
    <>
    <Modal open={open} onClose={close} dismissible={!busy} title="Automatic snapshots and retention" size="lg" footer={<>
      <button className="btn-secondary mr-auto" disabled={busy} onClick={() => setConfirmPrune(true)}>{pruning ? <Spinner size={15} /> : <Icon.Trash size={15} />} Apply now</button>
      <button className="btn-ghost" disabled={busy} onClick={close}>Cancel</button>
      <button className="btn-primary" disabled={busy} onClick={() => void save()}>{saving && <Spinner size={15} />} Save policy</button>
    </>}>
      <div className="flex items-center justify-between rounded-xl bg-white/[0.025] border border-white/[0.06] p-4 mb-5">
        <div><p className="text-sm font-medium text-white">Automatic snapshots</p><p className="text-xs muted mt-0.5">Runs even when no browser is open.</p></div>
        <button type="button" role="switch" aria-checked={draft.enabled} aria-label="Automatic snapshots"
          onClick={() => setDraft({ ...draft, enabled: !draft.enabled })}
          className={cx('w-11 h-6 rounded-full relative transition-colors', draft.enabled ? 'bg-brand-500' : 'bg-white/[0.12]')}>
          <span className={cx('absolute top-0.5 w-5 h-5 rounded-full bg-white shadow transition-all', draft.enabled ? 'left-[22px]' : 'left-0.5')} />
        </button>
      </div>
      <div className="grid sm:grid-cols-2 gap-4">
        {field('Take a snapshot every', 'intervalHours', 'hours')}
        {field('Keep every snapshot for', 'hourlyHours', 'hours')}
        {field('Keep one snapshot per day for', 'dailyDays', 'days')}
        {field('Keep one snapshot per week for', 'weeklyWeeks', 'weeks')}
        {field('Keep one snapshot per month for', 'monthlyMonths', 'months')}
        {field('Always retain at least', 'minimumSnapshots', 'snapshots')}
      </div>
      <label className="block mt-4">
        <span className="text-xs text-slate-400">Optional logical storage ceiling</span>
        <span className="mt-1 flex items-center rounded-xl bg-white/[0.035] border border-white/[0.08] overflow-hidden">
          <input className="input border-0 rounded-none bg-transparent flex-1" type="number" min="0" placeholder="Unlimited"
            value={draft.maximumBytes === null ? '' : String(Math.round(draft.maximumBytes / 1024 / 1024 / 1024))}
            onChange={event => setDraft({ ...draft, maximumBytes: event.target.value ? Number(event.target.value) * 1024 ** 3 : null })} />
          <span className="text-xs text-slate-500 px-3">GB</span>
        </span>
      </label>
      {actionError && (
        <div role="alert" className="mt-4 rounded-xl border border-accent-red/25 bg-accent-red/[0.07] p-3 flex items-start gap-3">
          <Icon.Warning size={16} className="text-accent-red shrink-0 mt-0.5" />
          <div className="min-w-0 flex-1"><p className="text-sm text-slate-200">{actionError.message}</p></div>
          <button className="btn-secondary !py-1.5" disabled={busy} onClick={() => void retryAction()}><Icon.Refresh size={14} /> Retry</button>
        </div>
      )}
      <p className="text-xs text-slate-500 mt-4 leading-relaxed">Snapshots reuse identical content, so the physical disk cost is usually lower than the logical size. The minimum snapshot count is never pruned by the storage ceiling.</p>
    </Modal>
    <ConfirmModal open={confirmPrune} onClose={() => setConfirmPrune(false)} title="Apply retention policy now?" danger
      confirmLabel="Save policy and prune"
      message="Aerie will first save the values currently shown, then permanently delete snapshots outside that policy and remove content no remaining snapshot uses. This cannot be undone."
      onConfirm={() => { void applyNow(); }} />
    </>
  );
}

export default function TimeMachine() {
  const [snapshots, setSnapshots] = useState<TimeMachineSnapshot[] | null>(null);
  const [initialLoading, setInitialLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [retentionError, setRetentionError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [currentPath, setCurrentPath] = useState('/');
  const [tree, setTree] = useState<{ entry: TimeMachineEntry; entries: TimeMachineEntry[]; warnings: string[] } | null>(null);
  const [diff, setDiff] = useState<TimeMachineDiff | null>(null);
  const [loadingTree, setLoadingTree] = useState(false);
  const [treeError, setTreeError] = useState<string | null>(null);
  const [treeRetry, setTreeRetry] = useState(0);
  const [creating, setCreating] = useState(false);
  const [snapshotTask, setSnapshotTask] = useState<TimeMachineTask | null>(null);
  const [snapshotError, setSnapshotError] = useState<string | null>(null);
  const [pollError, setPollError] = useState<string | null>(null);
  const [pollRetry, setPollRetry] = useState(0);
  const [createOpen, setCreateOpen] = useState(false);
  const [label, setLabel] = useState('');
  const [restoreEntry, setRestoreEntry] = useState<TimeMachineEntry | null>(null);
  const [restoreMode, setRestoreMode] = useState<RestoreMode>('rename');
  const [destination, setDestination] = useState('');
  const [restoring, setRestoring] = useState(false);
  const [deleteSnapshot, setDeleteSnapshot] = useState<TimeMachineSnapshot | null>(null);
  const [retention, setRetention] = useState<TimeMachineRetention | null>(null);
  const [retentionOpen, setRetentionOpen] = useState(false);

  const loadSnapshots = async (prefer?: string) => {
    const result = await timeMachineApi.snapshots();
    setSnapshots(result.snapshots);
    const next = prefer && result.snapshots.some(item => item.id === prefer) ? prefer
      : selectedId && result.snapshots.some(item => item.id === selectedId) ? selectedId : result.snapshots[0]?.id || null;
    setSelectedId(next);
  };

  const loadRetention = async () => {
    setRetentionError(null);
    try {
      setRetention(await timeMachineApi.retention());
      return true;
    } catch (error: any) {
      setRetentionError(errorMessage(error, 'Retention settings are unavailable.'));
      return false;
    }
  };

  const loadInitial = async () => {
    setInitialLoading(true); setLoadError(null);
    const [snapshotResult, taskResult] = await Promise.allSettled([
      loadSnapshots(),
      timeMachineApi.latestTask().then(({ task }) => {
        if (task && (task.status === 'queued' || task.status === 'running')) {
          setSnapshotTask(task); setCreating(true);
        } else {
          setSnapshotTask(null); setCreating(false);
          if (task?.status === 'failed') setSnapshotError(task.error || 'The most recent snapshot failed.');
        }
      }),
      loadRetention(),
    ]);
    const errors: string[] = [];
    if (snapshotResult.status === 'rejected') errors.push(`Timeline: ${errorMessage(snapshotResult.reason, 'could not load')}`);
    if (taskResult.status === 'rejected') errors.push(`Snapshot status: ${errorMessage(taskResult.reason, 'could not load')}`);
    setLoadError(errors.length ? errors.join(' · ') : null);
    setInitialLoading(false);
  };

  useEffect(() => {
    void loadInitial();
  }, []);

  useEffect(() => {
    const taskId = snapshotTask?.id;
    if (!taskId || (snapshotTask?.status !== 'queued' && snapshotTask?.status !== 'running')) return;
    let active = true;
    let timer: number | undefined;
    let delay = 1000;
    let stopped = false;
    const poll = async () => {
      try {
        const { task } = await timeMachineApi.task(taskId);
        if (!active) return;
        setPollError(null);
        delay = 1000;
        if (task.status === 'completed') {
          stopped = true;
          setCreating(false);
          try {
            await loadSnapshots(task.snapshotId || undefined);
            if (active) {
              setCurrentPath('/'); setSnapshotTask(null); setSnapshotError(null);
              toast('Snapshot complete', 'success', `${task.processedFiles} files are protected.`);
            }
          } catch (error: any) {
            if (active) {
              setSnapshotTask(null);
              setLoadError(`The snapshot completed, but the timeline could not refresh: ${errorMessage(error, 'Please retry.')}`);
            }
          }
        } else if (task.status === 'failed') {
          stopped = true;
          setCreating(false); setSnapshotTask(null);
          setSnapshotError(task.error || 'The background capture did not complete.');
        } else setSnapshotTask(task);
      } catch (error: any) {
        if (active) {
          setPollError(errorMessage(error, 'Could not read snapshot progress.'));
          delay = Math.min(delay * 2, 15_000);
        }
      } finally {
        if (active && !stopped) timer = window.setTimeout(poll, delay);
      }
    };
    void poll();
    return () => { active = false; if (timer !== undefined) window.clearTimeout(timer); };
  }, [snapshotTask?.id, pollRetry]);

  useEffect(() => {
    if (!selectedId) { setTree(null); setDiff(null); setTreeError(null); return; }
    let active = true;
    setLoadingTree(true);
    setTreeError(null);
    setTree(null);
    setDiff(null);
    Promise.all([timeMachineApi.tree(selectedId, currentPath), timeMachineApi.diff(selectedId, currentPath)])
      .then(([nextTree, nextDiff]) => { if (active) { setTree(nextTree); setDiff(nextDiff); } })
      .catch((error: any) => { if (active) { setTree(null); setDiff(null); setTreeError(errorMessage(error, 'Could not open this snapshot.')); } })
      .finally(() => { if (active) setLoadingTree(false); });
    return () => { active = false; };
  }, [selectedId, currentPath, treeRetry]);

  const selectedSnapshot = snapshots?.find(item => item.id === selectedId) || null;
  const changeByPath = useMemo(() => new Map((diff?.changes || []).map(change => [change.path, change.change])), [diff]);
  const breadcrumbs = useMemo(() => {
    const values = [{ name: 'All files', path: '/' }];
    let running = '';
    for (const part of currentPath.split('/').filter(Boolean)) { running += `/${part}`; values.push({ name: part, path: running }); }
    return values;
  }, [currentPath]);

  const create = async () => {
    setCreating(true); setSnapshotError(null); setPollError(null);
    try {
      const result = await timeMachineApi.create(label.trim() || undefined);
      setSnapshotTask(result.task);
      setCreateOpen(false); setLabel('');
      toast('Snapshot started', 'info', 'You can leave this page; capture continues on the server.');
    } catch (error: any) {
      setCreating(false);
      setSnapshotError(errorMessage(error, 'The snapshot could not be started.'));
    }
  };

  const openRestore = (entry: TimeMachineEntry) => {
    setRestoreEntry(entry); setRestoreMode('rename'); setDestination(entry.path === '/' ? '' : entry.path);
  };

  const restore = async () => {
    if (!selectedId || !restoreEntry) return;
    setRestoring(true);
    try {
      const result = await timeMachineApi.restore(selectedId, {
        path: restoreEntry.path,
        destinationPath: destination.trim() || undefined,
        mode: restoreMode,
      });
      toast('Restore complete', 'success', `${result.destinationPath}${result.skipped ? ` · ${result.skipped} conflicts skipped` : ''}`);
      if (result.sync?.reconciled === false) {
        toast('Sync update deferred', 'warning', 'The files were restored safely. Connected devices will reconcile on their next sync.');
      }
      setRestoreEntry(null);
      const nextDiff = await timeMachineApi.diff(selectedId, currentPath);
      setDiff(nextDiff);
    } catch (error: any) { toast('Restore failed', 'error', error?.message); }
    finally { setRestoring(false); }
  };

  if (snapshots === null && initialLoading) return <PageLoader />;
  if (snapshots === null) return (
    <div className="animate-fade-in">
      <PageHeader title="Time Machine" subtitle="Browse your cloud as it was, compare changes, and restore safely." icon={<Icon.Clock size={22} />} />
      <div className="card">
        <EmptyState icon={<Icon.Warning size={30} />} title="Time Machine could not be loaded" subtitle={loadError || 'The snapshot service is unavailable.'}
          action={<button className="btn-primary" disabled={initialLoading} onClick={() => void loadInitial()}>
            {initialLoading ? <Spinner size={15} /> : <Icon.Refresh size={15} />} Retry
          </button>} />
      </div>
    </div>
  );
  return (
    <div className="animate-fade-in">
      <PageHeader title="Time Machine" subtitle="Browse your cloud as it was, compare changes, and restore safely." icon={<Icon.Clock size={22} />}
        actions={<>
          <button className="btn-secondary" onClick={() => setRetentionOpen(true)}><Icon.Settings size={15} /> Retention</button>
          <button className="btn-primary" disabled={creating} onClick={() => setCreateOpen(true)}>{creating ? <Spinner size={15} /> : <Icon.Plus size={15} />} {creating ? 'Snapshot running' : 'Snapshot now'}</button>
        </>} />

      {loadError && (
        <div role="alert" className="rounded-xl border border-accent-red/25 bg-accent-red/[0.07] px-4 py-3 mb-4 flex items-start gap-3">
          <Icon.Warning size={17} className="text-accent-red shrink-0 mt-0.5" />
          <div className="min-w-0 flex-1"><p className="text-sm font-medium text-white">Some Time Machine data could not be loaded</p><p className="text-xs text-slate-400 mt-0.5">{loadError}</p></div>
          <button className="btn-secondary !py-1.5" disabled={initialLoading} onClick={() => void loadInitial()}>{initialLoading ? <Spinner size={14} /> : <Icon.Refresh size={14} />} Retry</button>
        </div>
      )}

      {retentionError && (
        <div role="alert" className="rounded-xl border border-accent-amber/25 bg-accent-amber/[0.07] px-4 py-3 mb-4 flex items-start gap-3">
          <Icon.Warning size={17} className="text-accent-amber shrink-0 mt-0.5" />
          <div className="min-w-0 flex-1"><p className="text-sm font-medium text-white">Retention settings are unavailable</p><p className="text-xs text-slate-400 mt-0.5">{retentionError}</p></div>
          <button className="btn-secondary !py-1.5" onClick={() => void loadRetention()}><Icon.Refresh size={14} /> Retry</button>
        </div>
      )}

      {snapshotError && (
        <div role="alert" className="rounded-xl border border-accent-red/25 bg-accent-red/[0.07] px-4 py-3 mb-4 flex items-start gap-3">
          <Icon.Warning size={17} className="text-accent-red shrink-0 mt-0.5" />
          <div className="min-w-0 flex-1"><p className="text-sm font-medium text-white">Snapshot failed</p><p className="text-xs text-slate-400 mt-0.5">{snapshotError}</p></div>
          <button className="btn-secondary !py-1.5" onClick={() => { setSnapshotError(null); setCreateOpen(true); }}><Icon.Refresh size={14} /> Try again</button>
        </div>
      )}

      {pollError && snapshotTask && (
        <div role="status" className="rounded-xl border border-accent-amber/25 bg-accent-amber/[0.07] px-4 py-3 mb-4 flex items-start gap-3">
          <Icon.Warning size={17} className="text-accent-amber shrink-0 mt-0.5" />
          <div className="min-w-0 flex-1"><p className="text-sm font-medium text-white">Waiting to reconnect to snapshot progress</p><p className="text-xs text-slate-400 mt-0.5">{pollError} Automatic retries slow down after each failure.</p></div>
          <button className="btn-secondary !py-1.5" onClick={() => { setPollError(null); setPollRetry(value => value + 1); }}><Icon.Refresh size={14} /> Retry now</button>
        </div>
      )}

      {snapshotTask && (snapshotTask.status === 'queued' || snapshotTask.status === 'running') && (
        <div className="glass rounded-2xl px-4 py-3 mb-4 border border-brand-500/25 bg-brand-500/[0.06] flex items-center gap-3">
          <Spinner size={18} className="text-brand-300 shrink-0" />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-white">{snapshotTask.status === 'queued' ? 'Snapshot queued' : `Protecting ${snapshotTask.processedFiles} files · ${formatBytes(snapshotTask.processedBytes)}`}</p>
            <p className="text-xs text-slate-500 truncate mt-0.5">{snapshotTask.currentPath || 'Preparing content store…'}</p>
          </div>
          <span className="text-xs text-slate-500">Safe to leave</span>
        </div>
      )}

      {!snapshots.length ? (
        <div className="card">
          <EmptyState icon={<Icon.Clock size={30} />} title="No snapshots yet"
            subtitle="Create the first immutable snapshot. Later snapshots will reuse unchanged content instead of copying it again."
            action={<button className="btn-primary" disabled={creating} onClick={() => setCreateOpen(true)}>{creating ? 'Snapshot running…' : 'Create first snapshot'}</button>} />
        </div>
      ) : (
        <div className="grid lg:grid-cols-[18rem_minmax(0,1fr)] gap-4">
          <SnapshotList snapshots={snapshots} selected={selectedId} onSelect={snapshot => { setSelectedId(snapshot.id); setCurrentPath('/'); }} />
          <main className="min-w-0 space-y-4">
            {selectedSnapshot && (
              <section className="card p-4 sm:p-5">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <p className="text-lg font-semibold text-white">{selectedSnapshot.label || new Date(selectedSnapshot.createdAt).toLocaleString()}</p>
                    <p className="text-xs muted mt-1">{new Date(selectedSnapshot.createdAt).toLocaleString()} · {selectedSnapshot.fileCount} files · {formatBytes(selectedSnapshot.totalBytes)}</p>
                  </div>
                  <div className="flex gap-2">
                    <button className="btn-secondary" disabled={!tree || loadingTree} onClick={() => tree && openRestore(tree.entry)}><Icon.Refresh size={15} /> Restore this folder</button>
                    <button className="icon-btn text-slate-400 hover:text-accent-red" title="Delete snapshot" onClick={() => setDeleteSnapshot(selectedSnapshot)}><Icon.Trash size={16} /></button>
                  </div>
                </div>
                {diff && (
                  <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 mt-4">
                    {[
                      ['Added since', diff.summary.added, 'text-accent-green'],
                      ['Missing now', diff.summary.removed, 'text-accent-red'],
                      ['Modified', diff.summary.modified, 'text-accent-amber'],
                      ['Type changed', diff.summary.typeChanged, 'text-accent-cyan'],
                      ['Unchanged', diff.summary.unchanged, 'text-slate-300'],
                    ].map(([title, value, color]) => <div key={String(title)} className="rounded-xl bg-white/[0.025] border border-white/[0.05] px-3 py-2">
                      <p className={cx('text-lg font-semibold', String(color))}>{value}</p><p className="text-[11px] text-slate-500">{title}</p>
                    </div>)}
                  </div>
                )}
              </section>
            )}

            <section className="card overflow-hidden min-h-[24rem]">
              <div className="px-4 py-3 border-b border-white/[0.06] flex flex-wrap items-center gap-1 text-sm">
                {breadcrumbs.map((crumb, index) => <React.Fragment key={crumb.path}>
                  {index > 0 && <Icon.ChevronRight size={14} className="text-slate-600" />}
                  <button className={cx('px-2 py-1 rounded-lg hover:bg-white/[0.05]', index === breadcrumbs.length - 1 ? 'text-white' : 'text-slate-400')}
                    onClick={() => setCurrentPath(crumb.path)}>{crumb.name}</button>
                </React.Fragment>)}
              </div>
              {loadingTree ? <div className="h-64 grid place-items-center text-brand-400"><Spinner size={28} /></div> : treeError ? (
                <EmptyState icon={<Icon.Warning size={28} />} title="This snapshot could not be opened" subtitle={treeError}
                  action={<button className="btn-secondary" onClick={() => setTreeRetry(value => value + 1)}><Icon.Refresh size={15} /> Retry</button>} />
              ) : !tree ? null : (
                <div>
                  {currentPath !== '/' && <button onClick={() => setCurrentPath(parentPath(currentPath))}
                    className="w-full flex items-center gap-3 px-4 py-3 border-b border-white/[0.045] hover:bg-white/[0.025] text-left">
                    <div className="w-9 h-9 rounded-xl grid place-items-center bg-white/[0.04] text-slate-400"><Icon.ChevronLeft size={17} /></div>
                    <span className="text-sm text-slate-300">Back to {nameOf(parentPath(currentPath))}</span>
                  </button>}
                  {!tree.entries.length ? <EmptyState icon={<Icon.Folder size={28} />} title="This folder was empty" subtitle="There were no items here when the snapshot was taken." />
                    : tree.entries.map(entry => (
                      <div key={entry.path} className="flex items-center gap-3 px-4 py-3 border-b border-white/[0.045] last:border-0 hover:bg-white/[0.025]">
                        <button className="flex items-center gap-3 min-w-0 flex-1 text-left" onClick={() => entry.type === 'directory' ? setCurrentPath(entry.path) : openRestore(entry)}>
                          <EntryIcon entry={entry} />
                          <span className="min-w-0 flex-1">
                            <span className="block text-sm text-white truncate">{nameOf(entry.path)}</span>
                            <span className="block text-xs text-slate-500 mt-0.5">{entry.type === 'directory' ? 'Folder' : entry.type === 'symlink' ? `Link to ${entry.linkTarget}` : formatBytes(entry.size)}</span>
                          </span>
                        </button>
                        <ChangeBadge change={changeByPath.get(entry.path)} />
                        <button className="btn-ghost text-xs" onClick={() => openRestore(entry)}><Icon.Refresh size={14} /> Restore</button>
                      </div>
                    ))}
                  {tree.warnings.length > 0 && <div className="m-4 rounded-xl border border-accent-amber/20 bg-accent-amber/[0.06] p-3">
                    <p className="text-xs font-medium text-accent-amber">{tree.warnings.length} item{tree.warnings.length === 1 ? '' : 's'} could not be captured</p>
                    <p className="text-[11px] text-slate-500 mt-1 truncate" title={tree.warnings.join('\n')}>{tree.warnings[0]}</p>
                  </div>}
                </div>
              )}
            </section>
          </main>
        </div>
      )}

      <Modal open={createOpen} onClose={() => !creating && setCreateOpen(false)} title="Create an immutable snapshot" size="sm" footer={<>
        <button className="btn-ghost" disabled={creating} onClick={() => setCreateOpen(false)}>Cancel</button>
        <button className="btn-primary" disabled={creating} onClick={create}>{creating ? <Spinner size={15} /> : <Icon.Clock size={15} />} {creating ? 'Protecting files…' : 'Create snapshot'}</button>
      </>}>
        <label className="block text-sm text-slate-300">Label <span className="text-slate-600">(optional)</span>
          <input className="input w-full mt-2" maxLength={120} autoFocus placeholder="Before laptop migration" value={label} onChange={event => setLabel(event.target.value)} />
        </label>
        <p className="text-xs muted mt-3 leading-relaxed">Every file is hashed and verified. Unchanged content is stored once across snapshots, without weakening account isolation.</p>
      </Modal>

      <Modal open={!!restoreEntry} onClose={() => !restoring && setRestoreEntry(null)} title={restoreEntry ? `Restore ${nameOf(restoreEntry.path)}` : 'Restore'} size="md" footer={<>
        <button className="btn-ghost" disabled={restoring} onClick={() => setRestoreEntry(null)}>Cancel</button>
        <button className={restoreMode === 'overwrite' ? 'btn-danger' : 'btn-primary'} disabled={restoring} onClick={restore}>{restoring && <Spinner size={15} />} Restore</button>
      </>}>
        <label className="block text-sm text-slate-300">Restore to
          <input className="input w-full mt-2 font-mono text-sm" placeholder="Choose a new folder for a full restore" value={destination} onChange={event => setDestination(event.target.value)} />
        </label>
        <div className="grid gap-2 mt-4">
          {([
            ['rename', 'Keep both', 'If the destination exists, restore alongside it with a dated name.'],
            ['skip', 'Skip conflicts', 'Restore missing items and leave every existing item untouched.'],
            ['overwrite', 'Replace destination', 'Stage and verify the complete restore, then atomically replace the destination.'],
          ] as [RestoreMode, string, string][]).map(([mode, title, subtitle]) => (
            <button key={mode} onClick={() => setRestoreMode(mode)} className={cx('rounded-xl border p-3 text-left transition-colors',
              restoreMode === mode ? 'border-brand-500/35 bg-brand-500/10' : 'border-white/[0.07] hover:bg-white/[0.025]')}>
              <span className="flex items-start gap-3"><span className={cx('mt-1 w-3.5 h-3.5 rounded-full border grid place-items-center', restoreMode === mode ? 'border-brand-400' : 'border-slate-600')}>
                {restoreMode === mode && <span className="w-1.5 h-1.5 rounded-full bg-brand-400" />}
              </span><span><span className="block text-sm text-white">{title}</span><span className="block text-xs muted mt-0.5">{subtitle}</span></span></span>
            </button>
          ))}
        </div>
        {restoreMode === 'overwrite' && <p className="text-xs text-accent-amber mt-3"><Icon.Warning size={13} className="inline mr-1" />The current destination is replaced only after the recovered copy passes integrity verification.</p>}
      </Modal>

      <ConfirmModal open={!!deleteSnapshot} onClose={() => setDeleteSnapshot(null)} title="Delete this snapshot?" danger confirmLabel="Delete snapshot"
        message="Content still used by another snapshot is retained. Unreferenced content is removed after the manifest is deleted."
        onConfirm={async () => {
          if (!deleteSnapshot) return;
          try { await timeMachineApi.remove(deleteSnapshot.id); setSelectedId(null); setCurrentPath('/'); await loadSnapshots(); toast('Snapshot deleted', 'success'); }
          catch (error: any) { toast('Could not delete snapshot', 'error', error?.message); }
          finally { setDeleteSnapshot(null); }
        }} />
      <RetentionEditor open={retentionOpen} policy={retention} policyError={retentionError} onRetryPolicy={loadRetention}
        onClose={() => setRetentionOpen(false)} onSaved={setRetention}
        onPruned={() => loadSnapshots()} />
    </div>
  );
}
