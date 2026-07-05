import React, { useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api';
import { Icon } from '../lib/icons';
import { cx, formatRelative } from '../lib/utils';
import { toast } from '../lib/store';
import { PageLoader, EmptyState, PageHeader, Modal, Menu, ConfirmModal } from '../components/ui';
import type { Automation } from '../lib/model';

// ---- Common trigger / action presets ---------------------------------------
const TRIGGERS: { value: string; label: string; icon: React.ReactNode; color: string }[] = [
  { value: 'On file upload', label: 'On file upload', icon: <Icon.Upload size={14} />, color: '#6366f1' },
  { value: 'On photo added', label: 'On photo added', icon: <Icon.Photos size={14} />, color: '#ec4899' },
  { value: 'Daily at 2:00 AM', label: 'Daily at 2:00 AM', icon: <Icon.Clock size={14} />, color: '#f59e0b' },
  { value: 'Every hour', label: 'Every hour', icon: <Icon.Refresh size={14} />, color: '#06b6d4' },
  { value: 'On new device login', label: 'On new device login', icon: <Icon.Device size={14} />, color: '#a855f7' },
  { value: 'When storage > 80%', label: 'When storage > 80%', icon: <Icon.Cloud size={14} />, color: '#ef4444' },
  { value: 'On document saved', label: 'On document saved', icon: <Icon.Doc size={14} />, color: '#10b981' },
];

const ACTIONS: { value: string; label: string; icon: React.ReactNode; color: string }[] = [
  { value: 'Back up to cloud', label: 'Back up to cloud', icon: <Icon.Backup size={14} />, color: '#6366f1' },
  { value: 'Generate thumbnails', label: 'Generate thumbnails', icon: <Icon.Image size={14} />, color: '#ec4899' },
  { value: 'Run malware scan', label: 'Run malware scan', icon: <Icon.Shield size={14} />, color: '#10b981' },
  { value: 'Send notification', label: 'Send notification', icon: <Icon.Bell size={14} />, color: '#f59e0b' },
  { value: 'Optimize library', label: 'Optimize library', icon: <Icon.Bolt size={14} />, color: '#a855f7' },
  { value: 'Purge trash', label: 'Purge trash', icon: <Icon.Trash size={14} />, color: '#ef4444' },
  { value: 'Sync media metadata', label: 'Sync media metadata', icon: <Icon.Refresh size={14} />, color: '#06b6d4' },
];

// Keyword → icon/color hints so custom triggers/actions get a meaningful icon
// instead of always falling back to a gray bolt.
const ICON_HINTS: { re: RegExp; icon: (s: number) => React.ReactNode; color: string }[] = [
  { re: /back\s?up/i, icon: s => <Icon.Backup size={s} />, color: '#6366f1' },
  { re: /thumbnail|photo|picture|gallery/i, icon: s => <Icon.Photos size={s} />, color: '#ec4899' },
  { re: /image/i, icon: s => <Icon.Image size={s} />, color: '#ec4899' },
  { re: /video|movie|film/i, icon: s => <Icon.Video size={s} />, color: '#f43f5e' },
  { re: /music|song|audio|podcast/i, icon: s => <Icon.Music size={s} />, color: '#22d3ee' },
  { re: /ocr|pdf|document|\bdoc\b|text|index|transcri/i, icon: s => <Icon.Doc size={s} />, color: '#10b981' },
  { re: /scan|malware|virus|secur|protect|threat|antivirus/i, icon: s => <Icon.Shield size={s} />, color: '#10b981' },
  { re: /notif|alert|email|mail|remind|message|\bsend\b/i, icon: s => <Icon.Bell size={s} />, color: '#f59e0b' },
  { re: /trash|purge|clean|delete|empty|prune/i, icon: s => <Icon.Trash size={s} />, color: '#ef4444' },
  { re: /sync|refresh|update|metadata|reindex/i, icon: s => <Icon.Refresh size={s} />, color: '#06b6d4' },
  { re: /download|export|fetch/i, icon: s => <Icon.Download size={s} />, color: '#818cf8' },
  { re: /upload|import|\badd\b|new/i, icon: s => <Icon.Upload size={s} />, color: '#6366f1' },
  { re: /night|daily|hourly|hour|schedul|minute|week|month|\bam\b|\bpm\b|\btime\b|cron|every/i, icon: s => <Icon.Clock size={s} />, color: '#f59e0b' },
  { re: /device|login|phone|charg|wi-?fi|network/i, icon: s => <Icon.Device size={s} />, color: '#a855f7' },
  { re: /storage|disk|quota|cloud|space/i, icon: s => <Icon.Cloud size={s} />, color: '#ef4444' },
  { re: /optim|library|tidy|organi/i, icon: s => <Icon.Sparkles size={s} />, color: '#a855f7' },
  { re: /share|link/i, icon: s => <Icon.Share size={s} />, color: '#38bdf8' },
  { re: /folder|\bfile/i, icon: s => <Icon.Folder size={s} />, color: '#94a3b8' },
];

function metaFor(list: typeof TRIGGERS, value: string) {
  const found = list.find(x => x.value === value);
  if (found) return found;
  const hint = ICON_HINTS.find(h => h.re.test(value || ''));
  return {
    value,
    label: value,
    icon: hint ? hint.icon(14) : <Icon.Bolt size={14} />,
    color: hint ? hint.color : '#94a3b8',
  };
}

// Force a locale that uses a comma thousands-separator, so counts like 5,821
// don't render as "5.821" (which reads as a decimal) on non-US system locales.
const fmtNum = (n: number) => (n ?? 0).toLocaleString('en-US');

// Reconcile run count + last-run timestamp into a single coherent status so a
// card can never show a run count AND "never run" at the same time.
function lastRunLabel(a: Automation) {
  if (a.lastRun) return formatRelative(a.lastRun);
  if (a.runCount > 0) return 'ran recently';
  return 'never run';
}

// ---- Flow chip -------------------------------------------------------------
function FlowChip({ meta, dim }: { meta: { label: string; icon: React.ReactNode; color: string }; dim?: boolean }) {
  return (
    <div
      className={cx(
        'inline-flex items-center gap-2 px-3 py-1.5 rounded-xl text-sm font-medium border transition-colors',
        dim ? 'opacity-60' : ''
      )}
      style={{ background: `${meta.color}1c`, color: meta.color, borderColor: `${meta.color}33` }}
    >
      <span className="grid place-items-center">{meta.icon}</span>
      <span className="truncate max-w-[9rem]">{meta.label}</span>
    </div>
  );
}

// ---- Toggle switch ---------------------------------------------------------
function Toggle({ on, busy, onClick }: { on: boolean; busy?: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      disabled={busy}
      aria-pressed={on}
      className={cx(
        'relative w-12 h-7 rounded-full transition-colors duration-200 shrink-0 disabled:opacity-60',
        on ? 'bg-brand-500 shadow-glow' : 'bg-ink-700'
      )}
    >
      <span
        className={cx(
          'absolute top-1 left-1 w-5 h-5 rounded-full bg-white shadow-md transition-transform duration-200 grid place-items-center',
          on ? 'translate-x-5' : 'translate-x-0'
        )}
      >
        {busy ? (
          <span className="w-2.5 h-2.5 rounded-full border-2 border-brand-500 border-t-transparent animate-spin" />
        ) : null}
      </span>
    </button>
  );
}

// ---- Automation card -------------------------------------------------------
function AutomationCard({
  a,
  onToggle,
  onDelete,
  onEdit,
  onDetails,
  busy,
}: {
  a: Automation;
  onToggle: () => void;
  onDelete: () => void;
  onEdit: () => void;
  onDetails: () => void;
  busy: boolean;
}) {
  const t = metaFor(TRIGGERS, a.trigger);
  const act = metaFor(ACTIONS, a.action);
  return (
    <div className={cx('card p-5 flex flex-col gap-4', !a.enabled && 'opacity-90')}>
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-3 min-w-0">
          <div
            className="w-10 h-10 rounded-xl grid place-items-center shrink-0"
            style={{ background: a.enabled ? '#6366f122' : '#ffffff0d', color: a.enabled ? '#818cf8' : '#64748b' }}
          >
            <Icon.Bolt size={19} />
          </div>
          <div className="min-w-0">
            <p className="font-semibold text-white truncate">{a.name}</p>
            <span className={cx('text-xs', a.enabled ? 'text-accent-green' : 'text-slate-500')}>
              {a.enabled ? '● Active' : '○ Paused'}
            </span>
          </div>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          <Toggle on={a.enabled} busy={busy} onClick={onToggle} />
          <Menu
            trigger={<button className="icon-btn"><Icon.More size={18} /></button>}
            items={[
              { label: a.enabled ? 'Pause' : 'Enable', icon: a.enabled ? <Icon.Pause size={16} /> : <Icon.Play size={16} />, onClick: onToggle },
              { label: 'Edit', icon: <Icon.Edit size={16} />, onClick: onEdit },
              { label: 'Details', icon: <Icon.Info size={16} />, onClick: onDetails },
              { label: 'Delete', icon: <Icon.Trash size={16} />, onClick: onDelete, danger: true, divider: true },
            ]}
          />
        </div>
      </div>

      {/* Flow visualization */}
      <div className="flex items-center gap-2 flex-wrap rounded-xl bg-ink-900/50 border border-white/[0.05] px-3 py-3">
        <FlowChip meta={t} dim={!a.enabled} />
        <Icon.ChevronRight size={18} className="text-slate-500 shrink-0" />
        <FlowChip meta={act} dim={!a.enabled} />
      </div>

      <div className="flex items-center justify-between text-xs muted pt-0.5">
        <span className="inline-flex items-center gap-1.5">
          <Icon.Refresh size={13} /> {fmtNum(a.runCount)} {a.runCount === 1 ? 'run' : 'runs'}
        </span>
        <span className="inline-flex items-center gap-1.5">
          <Icon.Clock size={13} /> {lastRunLabel(a)}
        </span>
      </div>
    </div>
  );
}

// ---- Group section ---------------------------------------------------------
function Group({ title, count, children }: { title: string; count: number; children: React.ReactNode }) {
  return (
    <div>
      <div className="flex items-center gap-2 mb-3">
        <h2 className="section-title">{title}</h2>
        <span className="text-xs text-slate-500 bg-white/[0.05] rounded-full px-2 py-0.5">{count}</span>
      </div>
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">{children}</div>
    </div>
  );
}

export default function Automations() {
  const [items, setItems] = useState<Automation[] | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [showNew, setShowNew] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [detailItem, setDetailItem] = useState<Automation | null>(null);
  const [confirmDel, setConfirmDel] = useState<Automation | null>(null);

  // New/edit-automation form state
  const [name, setName] = useState('');
  const [trigger, setTrigger] = useState(TRIGGERS[0].value);
  const [action, setAction] = useState(ACTIONS[0].value);
  const [creating, setCreating] = useState(false);

  async function load() {
    try {
      const list = await api.automations.list();
      setItems(list);
    } catch (e: any) {
      setItems([]);
      toast('Failed to load automations', 'error', e?.message);
    }
  }
  useEffect(() => { load(); }, []);

  const { enabled, disabled } = useMemo(() => {
    const list = items || [];
    return {
      enabled: list.filter(a => a.enabled),
      disabled: list.filter(a => !a.enabled),
    };
  }, [items]);

  async function toggle(a: Automation) {
    setBusyId(a.id);
    // optimistic
    setItems(prev => prev?.map(x => (x.id === a.id ? { ...x, enabled: !x.enabled } : x)) || prev);
    try {
      const updated = await api.automations.toggle(a.id);
      setItems(prev => prev?.map(x => (x.id === a.id ? updated : x)) || prev);
    } catch (e: any) {
      // revert
      setItems(prev => prev?.map(x => (x.id === a.id ? { ...x, enabled: a.enabled } : x)) || prev);
      toast('Could not update automation', 'error', e?.message);
    } finally {
      setBusyId(null);
    }
  }

  function openNew() {
    setEditId(null);
    setName(''); setTrigger(TRIGGERS[0].value); setAction(ACTIONS[0].value);
    setShowNew(true);
  }

  function openEdit(a: Automation) {
    setEditId(a.id);
    setName(a.name); setTrigger(a.trigger); setAction(a.action);
    setShowNew(true);
  }

  function closeModal() {
    setShowNew(false);
    setEditId(null);
    setName(''); setTrigger(TRIGGERS[0].value); setAction(ACTIONS[0].value);
  }

  async function save() {
    if (!name.trim()) { toast('Name required', 'warning', 'Give your automation a name.'); return; }
    setCreating(true);
    try {
      if (editId) {
        // Patch the rule in place. The update endpoint preserves run_count +
        // last_run (and the enabled state), so editing never wipes history.
        const updated = await api.automations.update(editId, { name: name.trim(), trigger, action });
        setItems(prev => (prev || []).map(x => (x.id === editId ? updated : x)));
        toast('Automation updated', 'success', name.trim());
      } else {
        const created = await api.automations.create({ name: name.trim(), trigger, action, enabled: true });
        setItems(prev => [created, ...(prev || [])]);
        toast('Automation created', 'success', `${name.trim()} is now active.`);
      }
      closeModal();
    } catch (e: any) {
      toast(editId ? 'Could not update automation' : 'Could not create automation', 'error', e?.message);
    } finally {
      setCreating(false);
    }
  }

  async function remove(a: Automation) {
    try {
      await api.automations.remove(a.id);
      setItems(prev => prev?.filter(x => x.id !== a.id) || prev);
      toast('Automation deleted', 'success', a.name);
    } catch (e: any) {
      toast('Could not delete automation', 'error', e?.message);
    } finally {
      setConfirmDel(null);
    }
  }

  if (!items) return <PageLoader />;

  const triggerMeta = metaFor(TRIGGERS, trigger);
  const actionMeta = metaFor(ACTIONS, action);
  // When editing a rule with a custom (non-preset) trigger/action, surface that
  // value as an option so it isn't silently lost by the <select>.
  const triggerOpts = TRIGGERS.some(t => t.value === trigger) ? TRIGGERS : [{ value: trigger, label: trigger }, ...TRIGGERS];
  const actionOpts = ACTIONS.some(a => a.value === action) ? ACTIONS : [{ value: action, label: action }, ...ACTIONS];
  const totalRuns = items.reduce((s, a) => s + a.runCount, 0);

  return (
    <div className="animate-fade-in">
      <PageHeader
        title="Automations"
        subtitle="Aerie runs these behind the scenes — no clicks required."
        icon={<Icon.Bolt size={22} />}
        actions={
          <button className="btn-primary" onClick={openNew}>
            <Icon.Plus size={17} /> New automation
          </button>
        }
      />

      {/* Explainer / stats banner */}
      <div className="glass rounded-2xl p-5 mb-6 flex flex-wrap items-center gap-x-8 gap-y-4">
        <div className="flex items-center gap-3 max-w-md">
          <div className="w-11 h-11 rounded-xl grid place-items-center bg-brand-500/15 text-brand-400 shrink-0">
            <Icon.Robot size={22} />
          </div>
          <p className="text-sm text-slate-300">
            Automations quietly keep your cloud tidy — backing up, tagging, scanning and cleaning up
            on triggers and schedules you define.
          </p>
        </div>
        <div className="flex items-center gap-6 ml-auto">
          <div>
            <p className="text-2xl font-bold text-white tracking-tight">{items.length}</p>
            <p className="text-xs muted">total</p>
          </div>
          <div>
            <p className="text-2xl font-bold text-accent-green tracking-tight">{enabled.length}</p>
            <p className="text-xs muted">active</p>
          </div>
          <div>
            <p className="text-2xl font-bold text-white tracking-tight">
              {fmtNum(totalRuns)}
            </p>
            <p className="text-xs muted">total runs</p>
          </div>
        </div>
      </div>

      {items.length === 0 ? (
        <EmptyState
          icon={<Icon.Bolt size={30} />}
          title="No automations yet"
          subtitle="Create your first automation to let Aerie work for you."
          action={<button className="btn-primary" onClick={openNew}><Icon.Plus size={17} /> New automation</button>}
        />
      ) : (
        <div className="space-y-8">
          {enabled.length > 0 && (
            <Group title="Active" count={enabled.length}>
              {enabled.map(a => (
                <AutomationCard key={a.id} a={a} busy={busyId === a.id} onToggle={() => toggle(a)} onDelete={() => setConfirmDel(a)} onEdit={() => openEdit(a)} onDetails={() => setDetailItem(a)} />
              ))}
            </Group>
          )}
          {disabled.length > 0 && (
            <Group title="Paused" count={disabled.length}>
              {disabled.map(a => (
                <AutomationCard key={a.id} a={a} busy={busyId === a.id} onToggle={() => toggle(a)} onDelete={() => setConfirmDel(a)} onEdit={() => openEdit(a)} onDetails={() => setDetailItem(a)} />
              ))}
            </Group>
          )}
        </div>
      )}

      {/* New automation modal */}
      <Modal
        open={showNew}
        onClose={closeModal}
        title={editId ? 'Edit automation' : 'New automation'}
        size="md"
        footer={
          <>
            <button className="btn-ghost" onClick={closeModal}>Cancel</button>
            <button className="btn-primary" onClick={save} disabled={creating}>
              {creating ? (editId ? 'Saving…' : 'Creating…') : (editId ? 'Save changes' : 'Create automation')}
            </button>
          </>
        }
      >
        <div className="space-y-5">
          <div>
            <label className="text-sm text-slate-300 mb-1.5 block">Name</label>
            <input
              className="input"
              autoFocus
              placeholder="e.g. Nightly photo backup"
              value={name}
              onChange={e => setName(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') save(); }}
            />
          </div>

          <div>
            <label className="text-sm text-slate-300 mb-1.5 flex items-center gap-2">
              <Icon.Bolt size={14} className="text-slate-500" /> When this happens (trigger)
            </label>
            <select className="input" value={trigger} onChange={e => setTrigger(e.target.value)}>
              {triggerOpts.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
            </select>
          </div>

          <div>
            <label className="text-sm text-slate-300 mb-1.5 flex items-center gap-2">
              <Icon.Play size={14} className="text-slate-500" /> Do this (action)
            </label>
            <select className="input" value={action} onChange={e => setAction(e.target.value)}>
              {actionOpts.map(a => <option key={a.value} value={a.value}>{a.label}</option>)}
            </select>
          </div>

          {/* Live flow preview */}
          <div>
            <p className="text-xs muted mb-2">Preview</p>
            <div className="flex items-center gap-2 flex-wrap rounded-xl bg-ink-900/60 border border-white/[0.05] px-3 py-3">
              <FlowChip meta={triggerMeta} />
              <Icon.ChevronRight size={18} className="text-slate-500" />
              <FlowChip meta={actionMeta} />
            </div>
          </div>
        </div>
      </Modal>

      {/* Details / run history */}
      <Modal
        open={!!detailItem}
        onClose={() => setDetailItem(null)}
        title={detailItem?.name || 'Automation'}
        size="md"
        footer={
          <>
            <button className="btn-ghost" onClick={() => setDetailItem(null)}>Close</button>
            <button
              className="btn-primary"
              onClick={() => { if (detailItem) { const a = detailItem; setDetailItem(null); openEdit(a); } }}
            >
              <Icon.Edit size={16} /> Edit
            </button>
          </>
        }
      >
        {detailItem && (
          <div className="space-y-5">
            <div className="flex items-center gap-2">
              <span
                className={cx(
                  'inline-flex items-center gap-1.5 text-xs font-medium rounded-full px-2.5 py-1',
                  detailItem.enabled ? 'text-accent-green bg-accent-green/10' : 'text-slate-400 bg-white/[0.06]'
                )}
              >
                {detailItem.enabled ? '● Active' : '○ Paused'}
              </span>
            </div>

            <div>
              <p className="text-xs muted mb-2">Flow</p>
              <div className="flex items-center gap-2 flex-wrap rounded-xl bg-ink-900/60 border border-white/[0.05] px-3 py-3">
                <FlowChip meta={metaFor(TRIGGERS, detailItem.trigger)} />
                <Icon.ChevronRight size={18} className="text-slate-500" />
                <FlowChip meta={metaFor(ACTIONS, detailItem.action)} />
              </div>
            </div>

            <div>
              <p className="text-xs muted mb-2">Run history</p>
              <div className="grid grid-cols-2 gap-3">
                <div className="rounded-xl bg-white/[0.04] border border-white/[0.05] px-4 py-3">
                  <p className="text-xl font-bold text-white tracking-tight">{fmtNum(detailItem.runCount)}</p>
                  <p className="text-xs muted">total runs</p>
                </div>
                <div className="rounded-xl bg-white/[0.04] border border-white/[0.05] px-4 py-3">
                  <p className="text-xl font-bold text-white tracking-tight">{lastRunLabel(detailItem)}</p>
                  <p className="text-xs muted">last run</p>
                </div>
              </div>
              {!detailItem.lastRun && detailItem.runCount > 0 && (
                <p className="text-xs muted mt-2 inline-flex items-center gap-1.5">
                  <Icon.Info size={12} /> Exact timestamps aren't recorded for earlier runs.
                </p>
              )}
            </div>
          </div>
        )}
      </Modal>

      <ConfirmModal
        open={!!confirmDel}
        onClose={() => setConfirmDel(null)}
        onConfirm={() => confirmDel && remove(confirmDel)}
        title="Delete automation"
        message={`"${confirmDel?.name}" will stop running and be removed permanently.`}
        confirmLabel="Delete"
        danger
      />
    </div>
  );
}
