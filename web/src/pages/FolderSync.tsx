import React, { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { Icon } from '../lib/icons';
import { cx, formatBytes, formatRelative } from '../lib/utils';
import { toast } from '../lib/store';
import { EmptyState, PageHeader, ConfirmModal, Modal, Spinner } from '../components/ui';

type DesktopSyncFolder = { id: string; label: string; localPath: string; mode: 'up' | 'two'; enabled: boolean; lastSync?: string | null; lastError?: string };
type DesktopSyncStatus = { id: string; state?: string; pending?: number; uploaded?: number; downloaded?: number; conflicts?: number; lastSync?: string | null; lastError?: string };
type ServerSyncBase = { base: string; files: number; bytes: number; lastChange: number };

function parseNativeJson<T>(raw: string | undefined, fallback: T): T {
  try { return raw ? JSON.parse(raw) : fallback; } catch { return fallback; }
}

function Section({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <div className="card overflow-hidden animate-fade-in">
      <div className="px-6 pt-5 pb-4 border-b border-white/[0.05]">
        <h2 className="text-base font-semibold text-white">{title}</h2>
        {subtitle && <p className="text-sm muted mt-0.5">{subtitle}</p>}
      </div>
      <div className="p-6">{children}</div>
    </div>
  );
}

function Toggle({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  return (
    <button role="switch" aria-checked={on} onClick={() => onChange(!on)}
      className={cx('w-11 h-6 rounded-full relative transition-colors shrink-0', on ? 'bg-brand-500' : 'bg-white/[0.12]')}>
      <span className={cx('absolute top-0.5 w-5 h-5 rounded-full bg-white shadow transition-all', on ? 'left-[22px]' : 'left-0.5')} />
    </button>
  );
}

function SyncStatusText({ folder, status }: { folder: DesktopSyncFolder; status: DesktopSyncStatus | undefined }) {
  const state = status?.state || (folder.enabled ? 'idle' : 'off');
  if (!folder.enabled) return <span className="text-slate-500 flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-slate-600" /> Off</span>;
  if (state === 'uploading') return <span className="text-brand-300 flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-brand-400 animate-pulse" /> Uploading {status?.pending || 0}...</span>;
  if (state === 'downloading') return <span className="text-brand-300 flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-brand-400 animate-pulse" /> Downloading {status?.pending || 0}...</span>;
  if (state === 'scanning') return <span className="text-brand-300 flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-brand-400 animate-pulse" /> Scanning...</span>;
  if (state === 'error' || folder.lastError || status?.lastError) return <span title={status?.lastError || folder.lastError || ''} className="text-accent-red flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-accent-red" /> Error</span>;
  const ts = status?.lastSync || folder.lastSync;
  return <span className="text-accent-green flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-accent-green" /> Synced{ts ? ` · ${formatRelative(ts)}` : ''}</span>;
}

function DesktopSyncSection() {
  const [folders, setFolders] = useState<DesktopSyncFolder[]>([]);
  const [statuses, setStatuses] = useState<DesktopSyncStatus[]>([]);
  const [bases, setBases] = useState<ServerSyncBase[]>([]);
  const [mirrorOpen, setMirrorOpen] = useState(false);
  const [removeFor, setRemoveFor] = useState<DesktopSyncFolder | null>(null);

  const bridge = window.aerieSync;
  const load = async () => {
    if (!bridge) return;
    try { setFolders(await bridge.list()); setStatuses(await bridge.status()); } catch { /* desktop bridge unavailable */ }
  };
  useEffect(() => {
    if (!bridge) return;
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [bridge]);
  if (!bridge) return null;
  const byId = new Map(statuses.map(s => [s.id, s]));

  const openMirror = async () => {
    setMirrorOpen(true);
    try { setBases((await api.sync.bases()).bases || []); }
    catch (e: any) { toast('Could not load server folders', 'error', e?.message); setBases([]); }
  };

  return (
    <Section title="Folder sync — this computer" subtitle="These folders sync with Aerie automatically. Deletes are never synced.">
      <div className="space-y-2">
        {folders.length === 0 ? (
          <EmptyState icon={<Icon.Folder size={28} />} title="No synced folders" subtitle="Choose a local folder to back up or mirror a folder already on the server." />
        ) : folders.map(f => (
          <div key={f.id} className="flex items-center gap-3 rounded-xl bg-white/[0.025] border border-white/[0.05] p-3">
            <div className="w-10 h-10 rounded-lg bg-brand-500/15 text-brand-300 grid place-items-center shrink-0"><Icon.Folder size={19} /></div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 min-w-0">
                <p className="text-sm font-medium text-white truncate">{f.label}</p>
                <span className={cx('rounded-full px-2 py-0.5 text-[10px] uppercase tracking-wide shrink-0', f.mode === 'two' ? 'bg-brand-500/20 text-brand-200' : 'bg-slate-500/15 text-slate-300')}>{f.mode === 'two' ? 'Two-way' : 'Backup'}</span>
              </div>
              <p className="text-xs text-slate-500 truncate">{f.localPath}</p>
            </div>
            <div className="hidden sm:block text-xs min-w-[9rem]"><SyncStatusText folder={f} status={byId.get(f.id)} /></div>
            <Toggle on={f.enabled} onChange={v => bridge.toggle(f.id, v).then(setFolders)} />
            <button className="icon-btn text-slate-400 hover:text-accent-red hover:bg-accent-red/10" title="Remove" onClick={() => setRemoveFor(f)}><Icon.Trash size={16} /></button>
          </div>
        ))}
      </div>
      <div className="flex flex-wrap gap-2 mt-5">
        <button className="btn-primary" onClick={() => bridge.add().then(setFolders)}><Icon.Plus size={15} /> Add folder</button>
        <button className="btn-secondary" onClick={openMirror}><Icon.Download size={15} /> Mirror a server folder...</button>
        <button className="btn-secondary" onClick={() => bridge.syncNow()}><Icon.Refresh size={15} /> Sync now</button>
      </div>
      <Modal open={mirrorOpen} onClose={() => setMirrorOpen(false)} title="Mirror a server folder" size="md">
        <div className="space-y-2">
          {bases.length === 0 ? <p className="text-sm muted">No server sync folders found.</p> : bases.map(b => (
            <button key={b.base} className="w-full flex items-center gap-3 rounded-xl p-3 hover:bg-white/[0.04] text-left" onClick={async () => { await bridge.addFromServer(b.base); setMirrorOpen(false); await load(); }}>
              <Icon.Folder size={18} className="text-brand-300 shrink-0" />
              <span className="min-w-0 flex-1">
                <span className="block text-sm text-white truncate">{b.base.replace(/^Sync\//, '')}</span>
                <span className="block text-xs muted">{b.files} files</span>
              </span>
            </button>
          ))}
        </div>
      </Modal>
      <ConfirmModal open={!!removeFor} onClose={() => setRemoveFor(null)} onConfirm={async () => { if (removeFor) setFolders(await bridge.remove(removeFor.id)); setRemoveFor(null); }}
        title="Remove synced folder" message="Server copy is kept. Local files are not deleted." confirmLabel="Remove" danger />
    </Section>
  );
}

function PhoneSyncSection() {
  const native = window.CloudBoxNative;
  const [folders, setFolders] = useState<any[]>([]);
  const [status, setStatus] = useState<any>({});
  const hasSync = !!native?.syncList;
  const progress = status?.progress;
  const progressText = progress && typeof progress.done === 'number' && typeof progress.total === 'number'
    ? `Uploading ${progress.done} of ${progress.total}${progress.folder ? ` — ${progress.folder}` : ''}`
    : '';
  const load = () => {
    if (!hasSync) return;
    setFolders(parseNativeJson(native?.syncList?.(), { folders: [] }).folders || []);
    setStatus(parseNativeJson(native?.syncStatus?.(), { running: false, folders: [] }));
  };
  useEffect(() => {
    if (!hasSync) return;
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [hasSync]);
  if (!hasSync) return null;
  return (
    <Section title="Folder sync — this phone" subtitle="Selected folders upload every night while charging on Wi-Fi. Deletes are never synced.">
      {progressText && (
        <div className="mb-3 text-sm text-brand-300 flex items-center gap-1.5">
          <span className="w-2 h-2 rounded-full bg-brand-400 animate-pulse" /> {progressText}
        </div>
      )}
      <div className="space-y-2">
        {folders.length === 0 ? (
          <EmptyState icon={<Icon.Phone size={28} />} title="No phone folders" subtitle="Add a folder to upload it automatically while charging." />
        ) : folders.map(f => (
          <div key={f.uri} className="flex items-center gap-3 rounded-xl bg-white/[0.025] border border-white/[0.05] p-3">
            <div className="w-10 h-10 rounded-lg bg-brand-500/15 text-brand-300 grid place-items-center shrink-0"><Icon.Folder size={19} /></div>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-white truncate">{f.label}</p>
              <p className={cx('text-xs truncate flex items-center gap-1.5', progress?.folder === f.label ? 'text-brand-300' : 'muted')}>
                {progress?.folder === f.label && <span className="w-2 h-2 rounded-full bg-brand-400 animate-pulse shrink-0" />}
                <span className="truncate">{progress?.folder === f.label ? progressText : (status.running ? 'Syncing now...' : (status.lastResult || 'Waiting for next charge-time run'))}</span>
              </p>
            </div>
            <button className="icon-btn text-slate-400 hover:text-accent-red hover:bg-accent-red/10" title="Remove" onClick={() => { native?.syncRemove?.(f.uri); load(); }}><Icon.Trash size={16} /></button>
          </div>
        ))}
      </div>
      <div className="flex flex-wrap gap-2 mt-5">
        <button className="btn-primary" onClick={() => { native?.syncAdd?.(); setTimeout(load, 1200); setTimeout(load, 3500); }}><Icon.Plus size={15} /> Add folder</button>
        <button className="btn-secondary" onClick={() => { native?.syncNow?.(); setTimeout(load, 1000); }}><Icon.Refresh size={15} /> Sync now</button>
      </div>
      <p className="text-xs text-slate-500 mt-3">First sync starts right away with a progress notification. After that, folders upload automatically overnight while charging on Wi-Fi.</p>
    </Section>
  );
}

function baseDisplayName(base: string): string {
  return base.replace(/^\/?Sync\//, '') || base.replace(/^\//, '') || 'Sync';
}

function filePathForBase(base: string): string {
  return base.startsWith('/') ? base : `/${base}`;
}

function ServerSyncSection() {
  const nav = useNavigate();
  const [bases, setBases] = useState<ServerSyncBase[] | null>(null);

  const load = async () => {
    try { setBases((await api.sync.bases()).bases || []); }
    catch (e: any) { setBases([]); toast('Could not load synced folders', 'error', e?.message); }
  };
  useEffect(() => { load(); }, []);

  return (
    <Section title="Synced on the server" subtitle="Folders already backed up to Aerie.">
      {bases === null ? (
        <div className="grid place-items-center py-8 text-brand-400"><Spinner size={26} /></div>
      ) : bases.length === 0 ? (
        <EmptyState icon={<Icon.Folder size={28} />} title="Nothing synced yet." subtitle="Synced folders will appear here after your devices upload them." />
      ) : (
        <div className="space-y-2">
          {bases.map(b => {
            const path = filePathForBase(b.base);
            const lastChange = b.lastChange ? formatRelative(new Date(b.lastChange).toISOString()) : '—';
            return (
              <div key={b.base} className="flex flex-col sm:flex-row sm:items-center gap-3 rounded-xl bg-white/[0.025] border border-white/[0.05] p-3">
                <div className="w-10 h-10 rounded-lg bg-brand-500/15 text-brand-300 grid place-items-center shrink-0"><Icon.Folder size={19} /></div>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-white truncate">{baseDisplayName(b.base)}</p>
                  <p className="text-xs muted mt-0.5">{b.files} files · {formatBytes(b.bytes)}</p>
                </div>
                <p className="text-xs text-slate-500 sm:w-36 sm:text-right shrink-0">last change {lastChange}</p>
                <button className="btn-ghost shrink-0" onClick={() => nav(`/files?path=${encodeURIComponent(path)}`)}>
                  <Icon.Files size={15} /> Open in Files
                </button>
              </div>
            );
          })}
        </div>
      )}
    </Section>
  );
}

function SetupCard() {
  return (
    <div className="glass rounded-2xl px-5 py-4 border border-brand-500/30 bg-brand-500/[0.06]">
      <div className="flex flex-col sm:flex-row sm:items-center gap-4">
        <div className="w-10 h-10 rounded-xl grid place-items-center bg-brand-500/20 text-brand-300 shrink-0">
          <Icon.Refresh size={20} />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-white">Set it up on your devices</p>
          <div className="mt-2 grid gap-2 text-sm text-slate-300">
            <p className="flex items-center gap-2"><Icon.Desktop size={16} className="text-brand-300 shrink-0" /> Desktop app — back up or two-way mirror any folder</p>
            <p className="flex items-center gap-2"><Icon.Phone size={16} className="text-brand-300 shrink-0" /> Android app — uploads your chosen folders every night while charging</p>
          </div>
        </div>
        <Link to="/get-apps" className="btn-primary shrink-0"><Icon.Download size={15} /> Get the apps</Link>
      </div>
    </div>
  );
}

export default function FolderSync() {
  const hasDesktop = !!window.aerieSync;
  const hasPhone = !!window.CloudBoxNative?.syncList;

  return (
    <div className="animate-fade-in space-y-6">
      <PageHeader
        title="Folder Sync"
        subtitle="Keep folders on your devices automatically backed up to Aerie. Deletes are never synced."
        icon={<Icon.Refresh size={22} />}
      />
      <DesktopSyncSection />
      <PhoneSyncSection />
      {!hasDesktop && !hasPhone && <SetupCard />}
      <ServerSyncSection />
    </div>
  );
}
