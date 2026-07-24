import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../lib/api';
import { Icon } from '../lib/icons';
import { cx, formatBytes, formatRelative, formatDate, copyText } from '../lib/utils';
import { useAuth, usePlayer, toast, useToasts } from '../lib/store';
import { Spinner, PageLoader, EmptyState, PageHeader, Modal, Menu, ProgressBar, Badge, ConfirmModal } from '../components/ui';
import { SharedSpaces } from '../components/SharedSpaces';
import type { AccountSharePermission, FileEntry, FileListing, StorageUsage, FileKind, Share } from '../lib/model';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type Tab = 'files' | 'recent' | 'starred' | 'shared' | 'trash';

const TABS: { key: Tab; label: string; icon: React.ReactNode }[] = [
  { key: 'files', label: 'My Files', icon: <Icon.Folder size={17} /> },
  { key: 'recent', label: 'Recent', icon: <Icon.Clock size={17} /> },
  { key: 'starred', label: 'Starred', icon: <Icon.Star size={17} /> },
  { key: 'shared', label: 'Shared', icon: <Icon.Share size={17} /> },
  { key: 'trash', label: 'Trash', icon: <Icon.Trash size={17} /> },
];

function kindIcon(kind: FileKind, size = 20) {
  switch (kind) {
    case 'folder': return <Icon.Folder size={size} />;
    case 'image': return <Icon.Image size={size} />;
    case 'video': return <Icon.Video size={size} />;
    case 'audio': return <Icon.Music size={size} />;
    case 'spreadsheet': case 'csv': return <Icon.Sheet size={size} />;
    case 'document': case 'markdown': case 'text': case 'pdf': return <Icon.Doc size={size} />;
    case 'code': return <Icon.Doc size={size} />;
    case 'archive': return <Icon.Files size={size} />;
    default: return <Icon.Files size={size} />;
  }
}

// Tint used for the icon tile per kind, keeps the grid colourful but cohesive.
function kindColor(kind: FileKind): string {
  switch (kind) {
    case 'folder': return '#6366f1';
    case 'image': return '#ec4899';
    case 'video': return '#f43f5e';
    case 'audio': return '#a855f7';
    case 'spreadsheet': case 'csv': return '#10b981';
    case 'document': case 'markdown': case 'text': return '#22d3ee';
    case 'pdf': return '#ef4444';
    case 'code': return '#f59e0b';
    case 'archive': return '#94a3b8';
    default: return '#64748b';
  }
}

const IMG_EXT = /\.(png|jpe?g|gif|webp|bmp|svg|avif)$/i;
const TEXT_KINDS: FileKind[] = ['text', 'markdown', 'code'];

function isThumbable(e: FileEntry) {
  return e.kind === 'image' || e.kind === 'video';
}

function triggerDownload(path: string) {
  const a = document.createElement('a');
  a.href = api.files.rawUrl(path, true);
  a.download = '';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

// Long-press → enter/toggle selection on touch devices. Suppresses the tap that
// follows so a long-press never also opens the item.
function useLongPress(onLong: () => void, ms = 420) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fired = useRef(false);
  const clear = () => { if (timer.current) { clearTimeout(timer.current); timer.current = null; } };
  return {
    fired,
    handlers: {
      onTouchStart: () => { fired.current = false; clear(); timer.current = setTimeout(() => { fired.current = true; onLong(); try { (navigator as any).vibrate?.(15); } catch {} }, ms); },
      onTouchMove: clear,
      onTouchEnd: clear,
      onTouchCancel: clear,
    },
  };
}

// ---------------------------------------------------------------------------
// Folder picker (used for Move / Copy)
// ---------------------------------------------------------------------------

function FolderPicker({ open, title, onClose, onPick, actionLabel }:
  { open: boolean; title: string; onClose: () => void; onPick: (dir: string) => void; actionLabel: string }) {
  const [path, setPath] = useState('/');
  const [listing, setListing] = useState<FileListing | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    api.files.list(path, 'name', 'asc')
      .then(setListing)
      .catch(() => setListing(null))
      .finally(() => setLoading(false));
  }, [path, open]);

  useEffect(() => { if (open) setPath('/'); }, [open]);

  const folders = (listing?.entries || []).filter(e => e.isFolder);

  return (
    <Modal open={open} onClose={onClose} title={title} size="md"
      footer={<>
        <button className="btn-secondary" onClick={onClose}>Cancel</button>
        <button className="btn-primary" onClick={() => onPick(path)}>{actionLabel} here</button>
      </>}>
      <div className="flex items-center gap-1 flex-wrap text-sm mb-3">
        {(listing?.breadcrumbs || [{ name: 'Home', path: '/' }]).map((b, i) => (
          <React.Fragment key={b.path}>
            {i > 0 && <Icon.ChevronRight size={13} className="text-slate-600" />}
            <button className={cx('px-1.5 py-0.5 rounded hover:bg-white/[0.06]', b.path === path ? 'text-white font-medium' : 'text-slate-400')}
              onClick={() => setPath(b.path)}>{i === 0 ? 'Home' : b.name}</button>
          </React.Fragment>
        ))}
      </div>
      <div className="rounded-xl border border-white/[0.06] bg-ink-900/60 max-h-72 overflow-y-auto min-h-[8rem]">
        {loading ? (
          <div className="grid place-items-center py-10 text-brand-400"><Spinner /></div>
        ) : folders.length === 0 ? (
          <div className="grid place-items-center py-10 text-center text-sm muted">No subfolders here</div>
        ) : folders.map(f => (
          <button key={f.path} onClick={() => setPath(f.path)}
            className="w-full flex items-center gap-2.5 px-3.5 py-2.5 text-left hover:bg-white/[0.05] transition-colors border-b border-white/[0.03] last:border-0">
            <Icon.Folder size={17} className="text-brand-400 shrink-0" />
            <span className="text-sm text-slate-200 truncate flex-1">{f.name}</span>
            <Icon.ChevronRight size={15} className="text-slate-600" />
          </button>
        ))}
      </div>
      <p className="text-xs muted mt-3">Destination: <span className="text-slate-300 font-mono">{path}</span></p>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Preview modal
// ---------------------------------------------------------------------------

function PreviewModal({ entry, onClose }: { entry: FileEntry; onClose: () => void }) {
  const nav = useNavigate();
  const player = usePlayer();
  const [text, setText] = useState<string | null>(null);
  const [loadingText, setLoadingText] = useState(false);
  const wantsText = TEXT_KINDS.includes(entry.kind);

  useEffect(() => {
    if (!wantsText) return;
    setLoadingText(true);
    api.files.content(entry.path)
      .then(r => setText(r.content))
      .catch(() => setText(null))
      .finally(() => setLoadingText(false));
  }, [entry.path, wantsText]);

  const raw = api.files.rawUrl(entry.path);

  const body = (() => {
    if (entry.kind === 'image' || IMG_EXT.test(entry.name)) {
      return <div className="grid place-items-center bg-ink-950 rounded-xl overflow-hidden">
        <img src={raw} className="max-h-[65vh] w-auto object-contain" alt={entry.name} />
      </div>;
    }
    if (entry.kind === 'video') {
      return <video src={raw} controls autoPlay className="w-full max-h-[65vh] rounded-xl bg-black" />;
    }
    if (entry.kind === 'audio') {
      return <div className="py-10 px-6 grid place-items-center bg-ink-900/60 rounded-xl">
        <div className="w-20 h-20 rounded-2xl bg-accent-purple/15 grid place-items-center text-accent-purple mb-5"><Icon.Music size={34} /></div>
        <p className="text-sm text-slate-300 text-center mb-4">Play this file in Aerie’s persistent player so it keeps playing while you browse.</p>
        <button className="btn-primary" onClick={() => {
          player.playTrack({ id: entry.id, title: entry.name, subtitle: entry.parent, streamUrl: raw, kind: 'music' });
          onClose();
        }}><Icon.Play size={16} /> Play audio</button>
      </div>;
    }
    if (entry.kind === 'pdf') {
      return <iframe src={raw} title={entry.name} className="w-full h-[65vh] rounded-xl bg-white" />;
    }
    if (wantsText) {
      if (loadingText) return <div className="grid place-items-center py-16 text-brand-400"><Spinner /></div>;
      return <pre className="text-[13px] leading-relaxed text-slate-200 bg-ink-950 rounded-xl p-4 max-h-[65vh] overflow-auto whitespace-pre-wrap font-mono border border-white/[0.05]">{text ?? 'Unable to load file contents.'}</pre>;
    }
    // Fallback download card
    return (
      <div className="grid place-items-center text-center py-12 px-6 bg-ink-900/60 rounded-xl">
        <div className="w-16 h-16 rounded-2xl grid place-items-center mb-4" style={{ background: `${kindColor(entry.kind)}22`, color: kindColor(entry.kind) }}>{kindIcon(entry.kind, 30)}</div>
        <p className="text-white font-medium">{entry.name}</p>
        <p className="muted text-sm mt-1">{formatBytes(entry.size)} · No inline preview available</p>
        <button className="btn-primary mt-5" onClick={() => triggerDownload(entry.path)}><Icon.Download size={16} /> Download</button>
      </div>
    );
  })();

  const openActions: React.ReactNode = (() => {
    if (entry.kind === 'document' || entry.kind === 'markdown' || entry.kind === 'text') {
      return <button className="btn-secondary" onClick={() => nav(`/documents?path=${encodeURIComponent(entry.path)}`)}><Icon.Edit size={15} /> <span className="hidden sm:inline">Open in editor</span></button>;
    }
    if (entry.kind === 'spreadsheet' || entry.kind === 'csv') {
      return <button className="btn-secondary" onClick={() => nav(`/spreadsheets?path=${encodeURIComponent(entry.path)}`)}><Icon.Edit size={15} /> <span className="hidden sm:inline">Open in editor</span></button>;
    }
    if (entry.kind === 'image') {
      return <>
        <button className="btn-secondary" onClick={() => nav(`/image-editor?path=${encodeURIComponent(entry.path)}`)}><Icon.Crop size={15} /> <span className="hidden sm:inline">Image Editor</span></button>
        <button className="btn-secondary" onClick={() => nav('/ai-images')}><Icon.Sparkles size={15} /> <span className="hidden sm:inline">AI Studio</span></button>
      </>;
    }
    if (entry.kind === 'audio') {
      return <button className="btn-secondary" onClick={() => {
        player.playTrack({ id: entry.id, title: entry.name, subtitle: entry.parent, streamUrl: raw, kind: 'music' });
        onClose();
      }}><Icon.Play size={15} /> <span className="hidden sm:inline">Play in player</span></button>;
    }
    return null;
  })();

  return (
    <Modal open onClose={onClose} title={entry.name} size="xl"
      footer={<>
        {openActions}
        <button className="btn-secondary" onClick={() => triggerDownload(entry.path)}><Icon.Download size={15} /> <span className="hidden sm:inline">Download</span></button>
        <button className="btn-primary" onClick={onClose}>Done</button>
      </>}>
      <div className="flex items-center gap-3 mb-4 text-xs">
        <Badge color="slate">{entry.kind}</Badge>
        <span className="muted">{formatBytes(entry.size)}</span>
        <span className="text-slate-600">·</span>
        <span className="muted">Modified {formatRelative(entry.modifiedAt)}</span>
      </div>
      {body}
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Share modal
// ---------------------------------------------------------------------------

const EXPIRY_OPTS: { label: string; days: number }[] = [
  { label: 'Never', days: 0 },
  { label: '1 day', days: 1 },
  { label: '7 days', days: 7 },
  { label: '30 days', days: 30 },
];

function ShareModal({ entry, onClose, onChanged }: { entry: FileEntry; onClose: () => void; onChanged: () => void }) {
  const currentUser = useAuth(state => state.user);
  const [mode, setMode] = useState<'household' | 'link'>('household');
  const [people, setPeople] = useState<{ id: number; username: string; displayName: string; avatarColor: string }[]>([]);
  const [recipientId, setRecipientId] = useState<number | null>(null);
  const [permission, setPermission] = useState<AccountSharePermission>('viewer');
  const [accountCreating, setAccountCreating] = useState(false);
  const [accountSharedWith, setAccountSharedWith] = useState<string | null>(null);
  const [allowDownload, setAllowDownload] = useState(true);
  const [usePassword, setUsePassword] = useState(false);
  const [password, setPassword] = useState('');
  const [expiryDays, setExpiryDays] = useState(0);
  const [creating, setCreating] = useState(false);
  const [share, setShare] = useState<Share | null>(null);

  // Always show the full absolute public URL now that /s/:id share pages work,
  // even if the backend returns a relative path.
  const publicUrl = share ? `${window.location.origin}/s/${share.id}` : '';

  useEffect(() => {
    let active = true;
    api.users().then(users => {
      if (!active) return;
      const available = users.filter(user => user.id !== currentUser?.id);
      setPeople(available);
      setRecipientId(value => value ?? available[0]?.id ?? null);
    }).catch(() => { if (active) setPeople([]); });
    return () => { active = false; };
  }, [currentUser?.id]);

  const createAccountShare = async () => {
    if (!recipientId) return;
    setAccountCreating(true);
    try {
      const grant = await api.accountShares.create(entry.path, recipientId, permission);
      setAccountSharedWith(grant.recipient?.displayName || people.find(person => person.id === recipientId)?.displayName || 'Household member');
      onChanged();
      toast('Shared with household member', 'success', permission === 'editor' ? 'They can now view and edit this shared space.' : 'They can now view this shared space.');
    } catch (error: any) {
      toast('Could not share with this person', 'error', error?.message === 'already_shared_with_recipient'
        ? 'This item is already shared with that household member.' : error?.message);
    } finally { setAccountCreating(false); }
  };

  const create = async () => {
    setCreating(true);
    try {
      const expiresAt = expiryDays ? new Date(Date.now() + expiryDays * 86400000).toISOString() : null;
      const s = await api.shares.create({
        path: entry.path, name: entry.name, type: 'link', permission: 'view', allowDownload,
        password: usePassword && password.trim() ? password.trim() : undefined,
        expiresAt,
      });
      setShare(s);
      onChanged();
      toast('Share link created', 'success');
    } catch {
      toast('Could not create share link', 'error', 'The sharing backend may not be configured.');
    } finally {
      setCreating(false);
    }
  };

  const copyLink = async () => {
    if (!publicUrl) return;
    const ok = await copyText(publicUrl);
    toast(ok ? 'Link copied' : 'Copy failed', ok ? 'success' : 'error');
  };

  return (
    <Modal open onClose={onClose} title={`Share “${entry.name}”`} size="md"
      footer={mode === 'household'
        ? accountSharedWith
          ? <button className="btn-primary" onClick={onClose}>Done</button>
          : <><button className="btn-secondary" onClick={onClose}>Cancel</button>
              <button className="btn-primary" onClick={createAccountShare} disabled={accountCreating || !recipientId}>
                {accountCreating ? <Spinner size={16} /> : <Icon.Share size={15} />} Share privately
              </button></>
        : share
          ? <button className="btn-primary" onClick={onClose}>Done</button>
          : <><button className="btn-secondary" onClick={onClose}>Cancel</button>
              <button className="btn-primary" onClick={create} disabled={creating}>{creating ? <Spinner size={16} /> : <Icon.Link size={15} />} Create link</button></>}>
      <div className="flex rounded-xl bg-ink-950 p-1 mb-4" role="tablist" aria-label="Sharing method">
        <button role="tab" aria-selected={mode === 'household'} onClick={() => setMode('household')}
          className={cx('flex-1 rounded-lg px-3 py-2 text-sm transition-colors', mode === 'household' ? 'bg-brand-500/20 text-brand-200' : 'text-slate-400 hover:text-white')}>Household member</button>
        <button role="tab" aria-selected={mode === 'link'} onClick={() => setMode('link')}
          className={cx('flex-1 rounded-lg px-3 py-2 text-sm transition-colors', mode === 'link' ? 'bg-brand-500/20 text-brand-200' : 'text-slate-400 hover:text-white')}>Public link</button>
      </div>

      {mode === 'household' ? accountSharedWith ? (
        <div className="animate-fade-in rounded-xl border border-accent-green/20 bg-accent-green/10 p-4">
          <div className="flex items-center gap-2 text-accent-green"><Icon.Check size={18} /><p className="font-medium">Shared with {accountSharedWith}</p></div>
          <p className="text-sm text-slate-300 mt-2">Access is private to their Aerie account and can be changed or revoked from Shared.</p>
        </div>
      ) : (
        <div className="space-y-4">
          {people.length ? <>
            <div><label className="section-title block mb-2" htmlFor="share-recipient">Person</label>
              <select id="share-recipient" className="form-select" value={recipientId || ''} onChange={event => setRecipientId(Number(event.target.value))}>
                {people.map(person => <option key={person.id} value={person.id}>{person.displayName} (@{person.username})</option>)}
              </select></div>
            <div><span className="section-title block mb-2">Access</span><div className="grid grid-cols-2 gap-2">
              <button onClick={() => setPermission('viewer')} aria-pressed={permission === 'viewer'} className={cx('rounded-xl border p-3 text-left', permission === 'viewer' ? 'border-brand-500/50 bg-brand-500/10' : 'border-white/[0.07] bg-ink-900/60')}>
                <span className="text-sm text-white block">Viewer</span><span className="text-xs muted">Open and download</span></button>
              <button onClick={() => setPermission('editor')} aria-pressed={permission === 'editor'} className={cx('rounded-xl border p-3 text-left', permission === 'editor' ? 'border-brand-500/50 bg-brand-500/10' : 'border-white/[0.07] bg-ink-900/60')}>
                <span className="text-sm text-white block">Editor</span><span className="text-xs muted">Add and change items</span></button>
            </div></div>
            <div className="rounded-xl border border-white/[0.06] bg-ink-900/60 px-3 py-2.5 text-xs text-slate-300">
              Access inherits through every item inside this {entry.isFolder ? 'folder' : 'file'}. Changes use your storage quota, versions, and recoverable Trash.
            </div>
          </> : <div className="rounded-xl border border-white/[0.06] p-4 text-sm muted">There are no other active household accounts to share with.</div>}
        </div>
      ) : share ? (
        <div className="animate-fade-in">
          <p className="text-sm muted mb-2">Anyone with this link can access “{share.name}”.</p>
          <div className="flex items-center gap-2 rounded-xl border border-white/[0.08] bg-ink-950 p-2">
            <Icon.Link size={16} className="text-brand-400 ml-1 shrink-0" />
            <input readOnly value={publicUrl} onFocus={e => e.target.select()}
              className="flex-1 bg-transparent text-sm text-slate-200 outline-none font-mono truncate min-w-0" />
            <button className="btn-secondary !py-1.5 !px-3 shrink-0" onClick={copyLink}><Icon.Copy size={14} /> Copy</button>
          </div>
          <div className="flex items-center gap-2 mt-4 flex-wrap text-xs">
            <Badge color="cyan">{share.permission}</Badge>
            {share.allowDownload ? <Badge color="slate">Download allowed</Badge> : <Badge color="amber">No download</Badge>}
            {share.hasPassword && <Badge color="amber"><Icon.Shield size={11} /> Password</Badge>}
            {share.expiresAt && <Badge color="slate"><Icon.Clock size={11} /> Expires {formatDate(share.expiresAt)}</Badge>}
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          <div className="rounded-xl border border-white/[0.06] bg-ink-900/60 px-3 py-2.5 text-sm text-slate-300">
            Public links remain anonymous and read-only. Use Household member for private viewer or editor access.
          </div>

          <div>
            <label className="section-title block mb-2">Link expires</label>
            <div className="flex gap-2 flex-wrap">
              {EXPIRY_OPTS.map(o => (
                <button key={o.days} onClick={() => setExpiryDays(o.days)}
                  className={cx('chip', expiryDays === o.days && '!bg-brand-500/20 !text-brand-200 !border-brand-500/40')}>{o.label}</button>
              ))}
            </div>
          </div>

          <label className="flex items-center gap-3 cursor-pointer">
            <input type="checkbox" checked={allowDownload} onChange={e => setAllowDownload(e.target.checked)}
              className="w-4 h-4 rounded accent-brand-500" />
            <span className="text-sm text-slate-300">Allow downloads</span>
          </label>

          <div>
            <label className="flex items-center gap-3 cursor-pointer">
              <input type="checkbox" checked={usePassword} onChange={e => setUsePassword(e.target.checked)}
                className="w-4 h-4 rounded accent-brand-500" />
              <span className="text-sm text-slate-300">Password protect</span>
            </label>
            {usePassword && (
              <div className="mt-2.5 relative animate-fade-in">
                <Icon.Shield size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
                <input type="text" value={password} onChange={e => setPassword(e.target.value)} autoFocus
                  placeholder="Set a password" className="input w-full !pl-9" />
              </div>
            )}
          </div>
        </div>
      )}
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Version history modal
// ---------------------------------------------------------------------------

function VersionsModal({ entry, onClose, onRestored }: { entry: FileEntry; onClose: () => void; onRestored: () => void }) {
  const [versions, setVersions] = useState<any[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setVersions(null);
    setLoadError(false);
    api.files.versions(entry.path)
      .then(items => { if (alive) setVersions(items); })
      .catch(() => { if (alive) setLoadError(true); });
    return () => { alive = false; };
  }, [entry.path]);

  const restore = async (id: string) => {
    setBusy(id);
    try {
      // Resolve the revision immediately before the write. This works for
      // binary and large files without trying to open them in the text API.
      const current = await api.files.revision(entry.path);
      await api.files.restoreVersion(entry.path, id, current.revision);
      toast('Version restored', 'success');
      onRestored();
      onClose();
    } catch (error: any) {
      toast(error?.message === 'revision_conflict' ? 'File changed before restore' : 'Restore failed', 'error',
        error?.message === 'revision_conflict'
          ? 'Nothing was overwritten. Refresh version history and try again.'
          : error?.message);
    } finally { setBusy(null); }
  };

  return (
    <Modal open onClose={onClose} title={`Version history — ${entry.name}`} size="md">
      {loadError ? (
        <EmptyState icon={<Icon.Warning size={26} />} title="Couldn't load version history"
          subtitle="Check your connection and try opening version history again." />
      ) : versions === null ? (
        <div className="grid place-items-center py-10 text-brand-400"><Spinner /></div>
      ) : versions.length === 0 ? (
        <EmptyState icon={<Icon.Clock size={26} />} title="No previous versions" subtitle="Versions appear here once this file is edited." />
      ) : (
        <div className="divide-y divide-white/[0.05]">
          {versions.map((v, i) => (
            <div key={v.id || i} className="flex items-center gap-3 py-3">
              <div className="w-9 h-9 rounded-lg bg-white/[0.05] grid place-items-center text-slate-400 shrink-0"><Icon.Clock size={16} /></div>
              <div className="min-w-0 flex-1">
                <p className="text-sm text-white truncate">{v.author || 'Edit'}</p>
                <p className="text-xs muted">{formatDate(v.createdAt)} · {formatBytes(v.sizeBytes || 0)}</p>
              </div>
              <button className="btn-secondary !py-1.5" disabled={busy !== null} onClick={() => restore(v.id)}>
                {busy === v.id ? <Spinner size={14} /> : <Icon.Refresh size={14} />} Restore
              </button>
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

interface UploadItem {
  id: string;
  name: string;
  size: number;
  pct: number;
  status: 'queued' | 'uploading' | 'done' | 'error' | 'cancelled';
  file: File;
  relativePath: string;
  targetPath: string;
  controller: AbortController;
  error?: string;
}

function uploadErrorMessage(error: unknown): string {
  if (error instanceof DOMException && error.name === 'AbortError') return 'Cancelled — you can retry this upload.';
  const raw = error instanceof Error ? error.message : String(error || 'Upload failed');
  if (/network|failed to fetch|upload_failed/i.test(raw)) return 'Connection lost. Retry to continue the upload.';
  return raw.length > 140 ? `${raw.slice(0, 137)}…` : raw;
}

// Recursively walk dropped DataTransferItem entries (files + folders) into a
// flat list of files with their relative paths, so folder drops keep structure.
function collectDropEntries(roots: any[]): Promise<{ files: File[]; rel: string[] }> {
  const files: File[] = [];
  const rel: string[] = [];
  const walk = (entry: any, prefix: string): Promise<void> => new Promise(resolve => {
    if (!entry) return resolve();
    if (entry.isFile) {
      entry.file((f: File) => { files.push(f); rel.push(prefix + entry.name); resolve(); }, () => resolve());
    } else if (entry.isDirectory) {
      const reader = entry.createReader();
      const batch = () => reader.readEntries(async (es: any[]) => {
        if (!es.length) return resolve();
        for (const e of es) await walk(e, prefix + entry.name + '/');
        batch();
      }, () => resolve());
      batch();
    } else resolve();
  });
  return (async () => {
    for (const r of roots) await walk(r, '');
    return { files, rel };
  })();
}

let _uidSeq = 0;
const uid = () => `u${Date.now().toString(36)}_${_uidSeq++}`;

export default function Files() {
  const nav = useNavigate();
  const player = usePlayer();
  const [params, setParams] = useSearchParams();
  const tab = (params.get('tab') as Tab) || 'files';
  const path = params.get('path') || '/';

  const [listing, setListing] = useState<FileListing | null>(null);
  const [flatEntries, setFlatEntries] = useState<FileEntry[]>([]); // recent / starred
  const [shares, setShares] = useState<Share[]>([]);
  const [shareGeneration, setShareGeneration] = useState(0);
  const [trash, setTrash] = useState<any[]>([]);
  const [usage, setUsage] = useState<StorageUsage | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadedKey, setLoadedKey] = useState<string | null>(null);

  const [view, setView] = useState<'grid' | 'list'>(() => (localStorage.getItem('cb_files_view') as any) || 'grid');
  const [sort, setSort] = useState<'name' | 'size' | 'modified'>('name');
  const [dir, setDir] = useState<'asc' | 'desc'>('asc');
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [dragOver, setDragOver] = useState(false);
  const [uploads, setUploads] = useState<UploadItem[]>([]);
  const [uploadPanelOpen, setUploadPanelOpen] = useState(true);

  // modals
  const [newFolder, setNewFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const [rename, setRename] = useState<FileEntry | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [preview, setPreview] = useState<FileEntry | null>(null);
  const [shareEntry, setShareEntry] = useState<FileEntry | null>(null);
  const [versionsEntry, setVersionsEntry] = useState<FileEntry | null>(null);
  const [confirmDel, setConfirmDel] = useState<{ paths: string[]; label: string } | null>(null);
  const [purgeTrashConfirm, setPurgeTrashConfirm] = useState<{ id: string; name: string } | null>(null);
  const [emptyTrashConfirm, setEmptyTrashConfirm] = useState(false);
  const [picker, setPicker] = useState<{ mode: 'move' | 'copy'; paths: string[] } | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);
  const loadSequenceRef = useRef(0);
  const uploadsRef = useRef<UploadItem[]>([]);

  // The backend also pushes a per-file "upload" notification over SSE, which the
  // global bell surfaces as its own toast — duplicating our single client-side
  // upload summary. While an upload is in flight (and briefly after) we swallow
  // those server upload toasts on the Files page, keeping only our own summary.
  const uploadSuppress = useRef<{ active: boolean; myId: string | null }>({ active: false, myId: null });
  useEffect(() => {
    const unsub = useToasts.subscribe((s) => {
      if (!uploadSuppress.current.active) return;
      const stray = s.toasts.filter(t => t.id !== uploadSuppress.current.myId && /upload/i.test(t.title));
      if (stray.length) {
        const dismiss = useToasts.getState().dismiss;
        stray.forEach(t => dismiss(t.id));
      }
    });
    return unsub;
  }, []);

  useEffect(() => { localStorage.setItem('cb_files_view', view); }, [view]);

  useEffect(() => { uploadsRef.current = uploads; }, [uploads]);

  // Successful rows can clear themselves, but failures remain until the user
  // retries or explicitly clears them. A transient toast is not a recovery UI.
  useEffect(() => {
    if (uploads.length === 0) return;
    if (uploads.some(u => u.status === 'uploading' || u.status === 'queued')) return;
    if (!uploads.some(u => u.status === 'done')) return;
    const t = setTimeout(() => setUploads(prev => prev.filter(u => u.status !== 'done')), 5000);
    return () => clearTimeout(t);
  }, [uploads]);
  useEffect(() => {
    if (!uploads.some(u => u.status === 'uploading' || u.status === 'queued')) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [uploads]);
  useEffect(() => { setSelected(new Set()); setQuery(''); }, [tab, path]);

  // ---- data loading --------------------------------------------------------
  const requestKey = `${tab}:${tab === 'files' ? `${path}:${sort}:${dir}` : ''}`;
  const activeRequestKeyRef = useRef(requestKey);
  activeRequestKeyRef.current = requestKey;
  const load = useCallback(async () => {
    // An action that started on a previous folder/tab can finish after
    // navigation. Its captured refresh must not supersede the new view.
    if (requestKey !== activeRequestKeyRef.current) return;
    const sequence = ++loadSequenceRef.current;
    const isCurrent = () => sequence === loadSequenceRef.current && requestKey === activeRequestKeyRef.current;
    setLoading(true);
    setLoadError(null);
    try {
      if (tab === 'files') {
        const next = await api.files.list(path, sort, dir);
        if (!isCurrent()) return;
        setListing(next);
      } else if (tab === 'recent') {
        const next = await api.files.recent(48);
        if (!isCurrent()) return;
        setFlatEntries(next);
      } else if (tab === 'starred') {
        const next = await api.files.starred();
        if (!isCurrent()) return;
        setFlatEntries(next);
      } else if (tab === 'shared') {
        const next = await api.shares.list();
        if (!isCurrent()) return;
        setShares(next);
      } else if (tab === 'trash') {
        const next = await api.files.trash();
        if (!isCurrent()) return;
        setTrash(next);
      }
      if (isCurrent()) setLoadedKey(requestKey);
    } catch (error: any) {
      if (!isCurrent()) return;
      setLoadError(error?.message || 'The storage backend may be offline.');
      toast('Could not load files', 'error', 'The storage backend may be offline.');
    } finally {
      if (isCurrent()) setLoading(false);
    }
  }, [tab, path, sort, dir, requestKey]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => { api.files.usage().then(setUsage).catch(() => setUsage(null)); }, []);

  // ---- navigation ----------------------------------------------------------
  const go = (nextTab: Tab, nextPath?: string) => {
    const p: Record<string, string> = { tab: nextTab };
    if (nextTab === 'files') p.path = nextPath ?? '/';
    setParams(p);
  };
  const openFolder = (p: string) => setParams({ tab: 'files', path: p });

  // ---- entries for current list-based tabs --------------------------------
  const rawEntries: FileEntry[] = tab === 'files' ? (listing?.entries || []) : (tab === 'recent' || tab === 'starred') ? flatEntries : [];
  const hasCurrentData = loadedKey === requestKey;
  const entries = useMemo(() => {
    let e = rawEntries;
    if (query.trim()) {
      const q = query.toLowerCase();
      e = e.filter(x => x.name.toLowerCase().includes(q));
    }
    if (tab !== 'files') {
      // client sort for flat views (newest first)
      e = [...e].sort((a, b) => new Date(b.modifiedAt).getTime() - new Date(a.modifiedAt).getTime());
    }
    return e;
  }, [rawEntries, query, tab]);

  // ---- selection -----------------------------------------------------------
  const toggleSelect = (p: string) => setSelected(s => {
    const n = new Set(s);
    n.has(p) ? n.delete(p) : n.add(p);
    return n;
  });
  const clearSelection = () => setSelected(new Set());
  const selectedEntries = entries.filter(e => selected.has(e.path));
  const allSelected = entries.length > 0 && selected.size >= entries.length;
  const toggleSelectAll = () => setSelected(allSelected ? new Set() : new Set(entries.map(e => e.path)));

  // Esc clears an active selection.
  useEffect(() => {
    if (selected.size === 0) return;
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') clearSelection(); };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [selected.size]);

  // ---- actions -------------------------------------------------------------
  const runUploadItem = async (item: UploadItem): Promise<boolean> => {
    if (item.controller.signal.aborted) {
      setUploads(prev => prev.map(u => u.id === item.id
        ? { ...u, status: 'cancelled', error: 'Cancelled — you can retry this upload.' }
        : u));
      return false;
    }
    setUploads(prev => prev.map(u => u.id === item.id ? { ...u, status: 'uploading', error: undefined } : u));
    try {
      await api.files.upload(item.targetPath, [item.file], [item.relativePath],
        pct => setUploads(prev => prev.map(u => u.id === item.id ? { ...u, pct } : u)),
        item.controller.signal);
      setUploads(prev => prev.map(u => u.id === item.id ? { ...u, pct: 100, status: 'done', error: undefined } : u));
      return true;
    } catch (error) {
      const cancelled = item.controller.signal.aborted || (error instanceof DOMException && error.name === 'AbortError');
      setUploads(prev => prev.map(u => u.id === item.id ? {
        ...u,
        status: cancelled ? 'cancelled' : 'error',
        error: uploadErrorMessage(error),
      } : u));
      return false;
    }
  };

  const doUpload = async (files: File[], relativePaths?: string[]) => {
    if (!files.length) return;
    const targetPath = path;
    if (tab !== 'files') { go('files', path); }
    const items: UploadItem[] = files.map((file, i) => {
      const relativePath = relativePaths?.[i] || (file as any).webkitRelativePath || file.name;
      return {
        id: uid(), name: relativePath, size: file.size, pct: 0, status: 'queued',
        file, relativePath, targetPath, controller: new AbortController(),
      };
    });
    setUploads(prev => [...prev, ...items]);
    setUploadPanelOpen(true);
    uploadSuppress.current = { active: true, myId: null };
    let ok = 0, failed = 0;
    // Upload one at a time so each file reports its own progress and huge files
    // don't stall the whole batch behind a single request.
    for (const item of items) {
      if (await runUploadItem(item)) ok++;
      else failed++;
    }
    // Fire our single summary toast, capturing its id so the suppressor above
    // never dismisses our own — only the redundant server upload notifications.
    const before = new Set(useToasts.getState().toasts.map(t => t.id));
    uploadSuppress.current.active = false;
    if (failed === 0) toast('Upload complete', 'success', `${ok} item${ok > 1 ? 's' : ''} added.`);
    else if (ok === 0) toast('Upload failed', 'error', `${failed} item${failed > 1 ? 's' : ''} could not be uploaded.`);
    else toast('Upload finished with errors', 'warning', `${ok} uploaded, ${failed} failed.`);
    const mine = useToasts.getState().toasts.find(t => !before.has(t.id));
    uploadSuppress.current.myId = mine ? mine.id : null;
    uploadSuppress.current.active = true;
    // Keep swallowing late-arriving server upload notifications, then stand down.
    setTimeout(() => { uploadSuppress.current.active = false; }, 6000);
    await load();
    api.files.usage().then(setUsage).catch(() => {});
  };

  const retryUpload = async (id: string) => {
    const previous = uploadsRef.current.find(u => u.id === id);
    if (!previous || (previous.status !== 'error' && previous.status !== 'cancelled')) return;
    const retry: UploadItem = { ...previous, controller: new AbortController(), pct: 0, status: 'queued', error: undefined };
    setUploads(items => items.map(item => item.id === id ? retry : item));
    setUploadPanelOpen(true);
    const ok = await runUploadItem(retry);
    toast(ok ? 'Upload complete' : 'Upload failed', ok ? 'success' : 'error',
      ok ? `${retry.name} was uploaded.` : 'The item remains here so you can retry again.');
    await load();
    api.files.usage().then(setUsage).catch(() => {});
  };

  const cancelUpload = (id: string) => {
    const item = uploadsRef.current.find(upload => upload.id === id);
    if (!item || (item.status !== 'queued' && item.status !== 'uploading')) return;
    item.controller.abort();
    setUploads(items => items.map(upload => upload.id === id
      ? { ...upload, status: 'cancelled', error: 'Cancelled — you can retry this upload.' }
      : upload));
  };

  const clearFinishedUploads = () => setUploads(prev => prev.filter(u => u.status === 'uploading' || u.status === 'queued'));

  const onFileInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files: File[] = e.target.files ? Array.from(e.target.files) : [];
    const rel = files.map((f: any) => f.webkitRelativePath || f.name);
    doUpload(files, rel);
    e.target.value = '';
  };

  const onDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    if (tab !== 'files') return;
    const dt = e.dataTransfer;
    // Prefer entry traversal so dropped folders keep their structure.
    if (dt.items && dt.items.length && (dt.items[0] as any).webkitGetAsEntry) {
      const roots: any[] = [];
      for (let i = 0; i < dt.items.length; i++) {
        const en = (dt.items[i] as any).webkitGetAsEntry?.();
        if (en) roots.push(en);
      }
      if (roots.length) {
        const { files, rel } = await collectDropEntries(roots);
        // If nothing had folder structure, rel === names which is harmless.
        if (files.length) doUpload(files, rel);
        return;
      }
    }
    const files: File[] = dt.files ? Array.from(dt.files) : [];
    if (files.length) doUpload(files);
  };

  const createFolder = async () => {
    const name = newFolderName.trim();
    if (!name) return;
    try {
      await api.files.mkdir(path, name);
      toast('Folder created', 'success');
      setNewFolder(false);
      setNewFolderName('');
      await load();
    } catch {
      toast('Could not create folder', 'error');
    }
  };

  const doRename = async () => {
    if (!rename) return;
    const nv = renameValue.trim();
    if (!nv || nv === rename.name) { setRename(null); return; }
    try {
      await api.files.rename(rename.path, nv);
      toast('Renamed', 'success');
      setRename(null);
      await load();
    } catch {
      toast('Rename failed', 'error');
    }
  };

  const doStar = async (e: FileEntry) => {
    try {
      await api.files.star(e.path, !e.starred);
      toast(e.starred ? 'Removed star' : 'Starred', 'success');
      await load();
    } catch {
      toast('Action failed', 'error');
    }
  };

  const doDelete = async (paths: string[]) => {
    try {
      await api.files.delete(paths);
      toast(`Moved ${paths.length} item${paths.length > 1 ? 's' : ''} to Trash`, 'success');
      clearSelection();
      await load();
      api.files.usage().then(setUsage).catch(() => {});
    } catch {
      toast('Delete failed', 'error');
    }
  };

  const doMoveCopy = async (dest: string) => {
    if (!picker) return;
    const { mode, paths } = picker;
    try {
      if (mode === 'move') await api.files.move(paths, dest);
      else await api.files.copy(paths, dest);
      toast(mode === 'move' ? 'Moved' : 'Copied', 'success');
      setPicker(null);
      clearSelection();
      await load();
    } catch {
      toast(`${mode === 'move' ? 'Move' : 'Copy'} failed`, 'error');
    }
  };

  const bulkDownload = (paths: string[]) => {
    paths.forEach((p, i) => setTimeout(() => triggerDownload(p), i * 200));
  };

  // trash actions
  const restoreTrash = async (id: string) => {
    try { await api.files.restore(id); toast('Restored', 'success'); await load(); }
    catch { toast('Restore failed', 'error'); }
  };
  const purgeTrash = async (id?: string) => {
    try { await api.files.purge(id); toast(id ? 'Deleted forever' : 'Trash emptied', 'success'); await load(); }
    catch { toast('Delete failed', 'error'); }
  };
  const removeShare = async (id: string) => {
    try { await api.shares.remove(id); toast('Share revoked', 'success'); await load(); }
    catch { toast('Failed to revoke', 'error'); }
  };

  const onEntryClick = (e: FileEntry) => {
    if (selected.size > 0) { toggleSelect(e.path); return; }
    if (e.isFolder) openFolder(e.path);
    else setPreview(e);
  };

  // per-entry context menu items
  const menuItems = (e: FileEntry) => [
    { label: e.isFolder ? 'Open' : 'Preview', icon: e.isFolder ? <Icon.Folder size={15} /> : <Icon.Eye size={15} />, onClick: () => onEntryClick(e) },
    ...(!e.isFolder ? [{ label: 'Download', icon: <Icon.Download size={15} />, onClick: () => triggerDownload(e.path) }] : []),
    { label: 'Rename', icon: <Icon.Edit size={15} />, onClick: () => { setRename(e); setRenameValue(e.name); } },
    { label: e.starred ? 'Unstar' : 'Star', icon: <Icon.Star size={15} filled={e.starred} />, onClick: () => doStar(e) },
    { label: 'Move to…', icon: <Icon.Folder size={15} />, onClick: () => setPicker({ mode: 'move', paths: [e.path] }) },
    { label: 'Copy to…', icon: <Icon.Copy size={15} />, onClick: () => setPicker({ mode: 'copy', paths: [e.path] }) },
    { label: 'Share', icon: <Icon.Share size={15} />, onClick: () => setShareEntry(e) },
    ...(!e.isFolder ? [{ label: 'Version history', icon: <Icon.Clock size={15} />, onClick: () => setVersionsEntry(e) }] : []),
    { label: 'Delete', icon: <Icon.Trash size={15} />, onClick: () => setConfirmDel({ paths: [e.path], label: e.name }), danger: true },
  ];

  // ---- toolbar -------------------------------------------------------------
  const sortLabel = { name: 'Name', size: 'Size', modified: 'Modified' }[sort];

  const headerActions = (
    <div className="flex items-center gap-2">
      <button className="btn-secondary" onClick={() => setNewFolder(true)}><Icon.Plus size={16} /> <span className="hidden sm:inline">New Folder</span></button>
      <Menu trigger={<button className="btn-primary"><Icon.Upload size={16} /> <span className="hidden sm:inline">Upload</span></button>}
        items={[
          { label: 'Upload files', icon: <Icon.Upload size={15} />, onClick: () => fileInputRef.current?.click() },
          { label: 'Upload folder', icon: <Icon.Folder size={15} />, onClick: () => folderInputRef.current?.click() },
        ]} />
    </div>
  );

  // ---------------------------------------------------------------------------
  return (
    <div className="animate-fade-in">
      <PageHeader title="Files" subtitle="Your private cloud storage" icon={<Icon.Files size={22} />} actions={headerActions} />

      {/* hidden inputs */}
      <input ref={fileInputRef} type="file" multiple hidden onChange={onFileInput} />
      <input ref={folderInputRef} type="file" hidden onChange={onFileInput}
        // @ts-ignore - non-standard directory upload attributes
        webkitdirectory="" directory="" />

      {/* Segmented tabs */}
      <div className="flex items-center gap-1.5 overflow-x-auto pb-1 mb-5">
        {TABS.map(t => (
          <button key={t.key} onClick={() => go(t.key)}
            className={cx('flex items-center gap-2 px-3.5 py-2 rounded-xl text-sm font-medium whitespace-nowrap transition-colors',
              tab === t.key ? 'bg-brand-500/20 text-brand-200 border border-brand-500/30' : 'text-slate-400 hover:text-white hover:bg-white/[0.05] border border-transparent')}>
            {t.icon} {t.label}
          </button>
        ))}
      </div>

      <div className="grid lg:grid-cols-[1fr_20rem] gap-6 items-start">
        {/* MAIN COLUMN ------------------------------------------------------ */}
        <div className="min-w-0">
          {/* Toolbar row: breadcrumbs + controls */}
          <div className="flex items-center justify-between gap-3 mb-4 flex-wrap">
            <div className="flex items-center gap-1 flex-wrap min-w-0">
              {tab === 'files' ? (
                (listing?.breadcrumbs || [{ name: 'Home', path: '/' }]).map((b, i, arr) => (
                  <React.Fragment key={b.path}>
                    {i > 0 && <Icon.ChevronRight size={14} className="text-slate-600 shrink-0" />}
                    <button onClick={() => openFolder(b.path)}
                      className={cx('px-1.5 py-1 rounded-lg text-sm truncate max-w-[10rem] hover:bg-white/[0.06] transition-colors',
                        i === arr.length - 1 ? 'text-white font-semibold' : 'text-slate-400')}>
                      {i === 0 ? 'Home' : b.name}
                    </button>
                  </React.Fragment>
                ))
              ) : (
                <h2 className="text-lg font-semibold text-white">{TABS.find(t => t.key === tab)?.label}</h2>
              )}
            </div>

            <div className="flex items-center gap-2">
              {/* search within */}
              {(tab === 'files' || tab === 'recent' || tab === 'starred') && (
                <div className="relative">
                  <Icon.Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
                  <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Filter…"
                    className="input !py-1.5 !pl-9 !pr-3 w-32 sm:w-44 text-sm" />
                </div>
              )}
              {tab === 'files' && (
                <Menu trigger={<button className="btn-secondary !py-2"><Icon.Filter size={15} /> <span className="hidden sm:inline">{sortLabel}</span></button>}
                  items={[
                    { label: 'Name', icon: <Icon.Doc size={15} />, onClick: () => setSort('name') },
                    { label: 'Size', icon: <Icon.Cloud size={15} />, onClick: () => setSort('size') },
                    { label: 'Modified', icon: <Icon.Clock size={15} />, onClick: () => setSort('modified') },
                    { label: dir === 'asc' ? 'Descending' : 'Ascending', icon: <Icon.ChevronDown size={15} />, onClick: () => setDir(d => d === 'asc' ? 'desc' : 'asc'), divider: true },
                  ]} />
              )}
              {/* view toggle */}
              {tab !== 'shared' && tab !== 'trash' && (
                <div className="flex items-center rounded-xl bg-white/[0.05] border border-white/[0.06] p-0.5">
                  <button onClick={() => setView('grid')} className={cx('icon-btn !w-8 !h-8', view === 'grid' && 'bg-brand-500/25 text-brand-200')}><Icon.Grid size={16} /></button>
                  <button onClick={() => setView('list')} className={cx('icon-btn !w-8 !h-8', view === 'list' && 'bg-brand-500/25 text-brand-200')}><Icon.List size={16} /></button>
                </div>
              )}
            </div>
          </div>

          {/* Selection bar */}
          {selected.size > 0 && (
            <div className="glass-strong rounded-xl p-2 mb-4 flex items-center gap-1.5 sm:gap-2 animate-scale-in shadow-float sticky top-2 z-20">
              <button className="icon-btn shrink-0" onClick={clearSelection} title="Clear selection"><Icon.Close size={16} /></button>
              <span className="text-sm font-medium text-white px-0.5 whitespace-nowrap">{selected.size}<span className="hidden sm:inline"> selected</span></span>
              {(tab === 'files' || tab === 'recent' || tab === 'starred') && (
                <button className="btn-ghost !py-1.5 !px-2 shrink-0" onClick={toggleSelectAll} title={allSelected ? 'Deselect all' : 'Select all'}>
                  <Icon.Check size={15} /> <span className="hidden md:inline">{allSelected ? 'None' : 'All'}</span>
                </button>
              )}
              <div className="flex-1 min-w-0" />
              <div className="flex items-center gap-1.5 sm:gap-2 overflow-x-auto">
                <button className="btn-ghost !py-1.5 !px-2 shrink-0" onClick={() => bulkDownload(selectedEntries.filter(e => !e.isFolder).map(e => e.path))} title="Download"><Icon.Download size={15} /> <span className="hidden sm:inline">Download</span></button>
                <button className="btn-ghost !py-1.5 !px-2 shrink-0" onClick={() => setPicker({ mode: 'move', paths: [...selected] })} title="Move"><Icon.Folder size={15} /> <span className="hidden sm:inline">Move</span></button>
                <button className="btn-ghost !py-1.5 !px-2 shrink-0" onClick={() => setPicker({ mode: 'copy', paths: [...selected] })} title="Copy"><Icon.Copy size={15} /> <span className="hidden sm:inline">Copy</span></button>
                {selected.size === 1 && <button className="btn-ghost !py-1.5 !px-2 shrink-0" onClick={() => selectedEntries[0] && setShareEntry(selectedEntries[0])} title="Share"><Icon.Share size={15} /> <span className="hidden sm:inline">Share</span></button>}
                <button className="btn-danger !py-1.5 !px-2 shrink-0" onClick={() => setConfirmDel({ paths: [...selected], label: `${selected.size} item${selected.size > 1 ? 's' : ''}` })} title="Delete"><Icon.Trash size={15} /> <span className="hidden sm:inline">Delete</span></button>
              </div>
            </div>
          )}

          {/* CONTENT AREA (drop target) */}
          <div
            onDragOver={e => { if (tab === 'files') { e.preventDefault(); setDragOver(true); } }}
            onDragLeave={() => setDragOver(false)}
            onDrop={onDrop}
            className={cx('relative rounded-2xl transition-all min-h-[16rem]',
              dragOver && 'ring-2 ring-brand-500/60 ring-offset-2 ring-offset-ink-950 bg-brand-500/[0.04]')}>

            {loadError && (
              <div role="alert" className="mb-3 rounded-xl border border-accent-red/25 bg-accent-red/10 px-4 py-3 flex flex-wrap items-center gap-3">
                <Icon.Warning size={17} className="text-accent-red shrink-0" />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-white">Couldn't refresh this view</p>
                  <p className="text-xs text-slate-400 truncate">{loadError}</p>
                </div>
                <button className="btn-secondary !py-1.5" onClick={() => void load()}><Icon.Refresh size={14} /> Retry</button>
              </div>
            )}

            {dragOver && (
              <div className="absolute inset-0 z-20 grid place-items-center rounded-2xl bg-ink-950/70 backdrop-blur-sm pointer-events-none">
                <div className="text-center">
                  <Icon.Upload size={38} className="text-brand-400 mx-auto mb-2" />
                  <p className="text-white font-semibold">Drop to upload</p>
                  <p className="muted text-sm">to {path}</p>
                </div>
              </div>
            )}

            {loading && !hasCurrentData ? (
              <PageLoader />
            ) : loadError && !hasCurrentData ? null : tab === 'trash' ? (
              <TrashView items={trash} onRestore={restoreTrash}
                onPurge={item => setPurgeTrashConfirm({ id: String(item.id), name: String(item.name || 'this item') })}
                onEmpty={() => setEmptyTrashConfirm(true)} />
            ) : tab === 'shared' ? (
              <SharedSpaces publicShares={shares} refreshKey={shareGeneration}
                onRevokePublic={removeShare} onOpenOwned={p => openFolder(p)} />
            ) : entries.length === 0 ? (
              <EmptyState
                icon={tab === 'starred' ? <Icon.Star size={28} /> : tab === 'recent' ? <Icon.Clock size={28} /> : <Icon.Folder size={28} />}
                title={query ? 'No matches' : tab === 'starred' ? 'No starred files' : tab === 'recent' ? 'Nothing recent' : 'This folder is empty'}
                subtitle={query ? 'Try a different search term.' : tab === 'files' ? 'Drag files here or use the Upload button to get started.' : 'Files you star or open will show up here.'}
                action={tab === 'files' && !query ? <button className="btn-primary" onClick={() => fileInputRef.current?.click()}><Icon.Upload size={16} /> Upload files</button> : undefined}
              />
            ) : view === 'grid' ? (
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-5 gap-3">
                {entries.map(e => (
                  <FileGridCard key={e.id} entry={e} selected={selected.has(e.path)}
                    anySelected={selected.size > 0}
                    onOpen={() => onEntryClick(e)} onToggle={() => toggleSelect(e.path)}
                    onLongPress={() => toggleSelect(e.path)}
                    menu={menuItems(e)} />
                ))}
              </div>
            ) : (
              <div className="card !p-0 overflow-hidden">
                <div className="hidden sm:flex items-center gap-3 px-4 py-2.5 border-b border-white/[0.06] text-xs font-medium text-slate-500 uppercase tracking-wide">
                  <div className="w-5" />
                  <div className="w-8" />
                  <div className="flex-1">Name</div>
                  <div className="w-24 text-right">Size</div>
                  <div className="w-28 text-right">Modified</div>
                  <div className="w-9" />
                </div>
                <div className="divide-y divide-white/[0.04]">
                  {entries.map(e => (
                    <FileListRow key={e.id} entry={e} selected={selected.has(e.path)}
                      anySelected={selected.size > 0}
                      onOpen={() => onEntryClick(e)} onToggle={() => toggleSelect(e.path)}
                      onLongPress={() => toggleSelect(e.path)}
                      menu={menuItems(e)} />
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>

        {/* SIDE COLUMN — storage --------------------------------------------- */}
        <div className="space-y-5 hidden lg:block sticky top-4">
          <StorageCard usage={usage} />
        </div>
      </div>

      {/* Mobile storage card */}
      <div className="lg:hidden mt-6"><StorageCard usage={usage} /></div>

      {/* Mobile / tablet upload FAB */}
      {tab === 'files' && (
        <button aria-label="Upload files" onClick={() => fileInputRef.current?.click()}
          className="lg:hidden fixed right-5 z-30 w-14 h-14 rounded-full bg-brand-500 hover:bg-brand-600 text-white grid place-items-center shadow-glow shadow-float active:scale-95 transition-transform"
          // Sit above the mobile bottom tab bar (and the mini player when present) so
          // taps on the "AI" tab underneath never hit the FAB.
          style={{ bottom: player.current ? '10rem' : '5.5rem' }}>
          <Icon.Upload size={24} />
        </button>
      )}

      {/* Persistent upload progress panel */}
      <UploadPanel uploads={uploads} open={uploadPanelOpen} setOpen={setUploadPanelOpen}
        onClear={clearFinishedUploads} onRetry={id => void retryUpload(id)} onCancel={cancelUpload}
        // Anchor bottom-LEFT on desktop so it doesn't overlap the bottom-right toasts
        // or the right-hand Storage sidebar; full-width above the tab bar on mobile.
        positionClass={cx('left-4 right-4 sm:right-auto sm:left-5 sm:w-[22rem]',
          player.current ? 'bottom-[9.75rem] lg:!bottom-[6rem]' : 'bottom-[5.5rem] lg:!bottom-6')} />

      {/* ---- Modals ---- */}
      <Modal open={newFolder} onClose={() => setNewFolder(false)} title="New folder" size="sm"
        footer={<>
          <button className="btn-secondary" onClick={() => setNewFolder(false)}>Cancel</button>
          <button className="btn-primary" onClick={createFolder}>Create</button>
        </>}>
        <input autoFocus value={newFolderName} onChange={e => setNewFolderName(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && createFolder()}
          placeholder="Folder name" className="input w-full" />
      </Modal>

      <Modal open={!!rename} onClose={() => setRename(null)} title="Rename" size="sm"
        footer={<>
          <button className="btn-secondary" onClick={() => setRename(null)}>Cancel</button>
          <button className="btn-primary" onClick={doRename}>Rename</button>
        </>}>
        <input autoFocus value={renameValue} onChange={e => setRenameValue(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && doRename()} className="input w-full" />
      </Modal>

      {preview && <PreviewModal entry={preview} onClose={() => setPreview(null)} />}
      {shareEntry && <ShareModal entry={shareEntry} onClose={() => setShareEntry(null)}
        onChanged={() => { setShareGeneration(value => value + 1); if (tab === 'shared') void load(); }} />}
      {versionsEntry && <VersionsModal entry={versionsEntry} onClose={() => setVersionsEntry(null)} onRestored={load} />}

      <FolderPicker open={!!picker} title={picker?.mode === 'move' ? 'Move to folder' : 'Copy to folder'}
        actionLabel={picker?.mode === 'move' ? 'Move' : 'Copy'}
        onClose={() => setPicker(null)} onPick={doMoveCopy} />

      <ConfirmModal open={!!confirmDel} onClose={() => setConfirmDel(null)}
        onConfirm={() => confirmDel && doDelete(confirmDel.paths)}
        title="Move to Trash?" message={`“${confirmDel?.label}” will be moved to Trash. You can restore it later.`}
        confirmLabel="Move to Trash" danger />

      <ConfirmModal open={emptyTrashConfirm} onClose={() => setEmptyTrashConfirm(false)}
        onConfirm={() => purgeTrash()}
        title="Empty Trash?" message="All items in Trash will be permanently deleted. This cannot be undone."
        confirmLabel="Empty Trash" danger />

      <ConfirmModal open={!!purgeTrashConfirm} onClose={() => setPurgeTrashConfirm(null)}
        onConfirm={() => purgeTrashConfirm && purgeTrash(purgeTrashConfirm.id)}
        title="Delete this item forever?"
        message={`“${purgeTrashConfirm?.name}” will be permanently deleted and cannot be restored.`}
        confirmLabel="Delete forever" danger />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Persistent upload panel
// ---------------------------------------------------------------------------

function UploadPanel({ uploads, open, setOpen, onClear, onRetry, onCancel, positionClass }:
  { uploads: UploadItem[]; open: boolean; setOpen: (f: (o: boolean) => boolean) => void; onClear: () => void; onRetry: (id: string) => void; onCancel: (id: string) => void; positionClass: string }) {
  if (uploads.length === 0) return null;
  const active = uploads.filter(u => u.status === 'uploading' || u.status === 'queued').length;
  const done = uploads.filter(u => u.status === 'done').length;
  const errs = uploads.filter(u => u.status === 'error' || u.status === 'cancelled').length;
  const allDone = active === 0;
  const overall = Math.round(uploads.reduce((a, u) => a + (u.status === 'done' ? 100 : u.pct), 0) / uploads.length);

  return (
    <div className={cx('fixed z-40 animate-scale-in', positionClass)}>
      <div className="glass-strong rounded-2xl shadow-float overflow-hidden border border-white/[0.08]">
        <div className="flex items-center gap-2.5 px-4 py-3">
          {active > 0 ? <Spinner size={16} className="text-brand-400" />
            : errs > 0 ? <Icon.Warning size={16} className="text-accent-red" />
            : <Icon.Check size={16} className="text-accent-green" />}
          <button onClick={() => setOpen(o => !o)} className="flex-1 min-w-0 text-left">
            <p className="text-sm font-medium text-white truncate">
              {active > 0 ? `Uploading ${active} item${active > 1 ? 's' : ''}… ${overall}%`
                : errs > 0 ? `${done} done · ${errs} failed`
                : `${done} upload${done > 1 ? 's' : ''} complete`}
            </p>
          </button>
          {allDone && (
            <button className="icon-btn !w-7 !h-7" title="Clear" onClick={onClear}><Icon.Close size={15} /></button>
          )}
          <button className="icon-btn !w-7 !h-7" title={open ? 'Collapse' : 'Expand'} onClick={() => setOpen(o => !o)}>
            <Icon.ChevronDown size={16} className={cx('transition-transform', !open && 'rotate-180')} />
          </button>
        </div>
        {active > 0 && !open && <div className="px-4 pb-3 -mt-1"><ProgressBar value={overall} /></div>}
        {open && (
          <div className="max-h-64 overflow-y-auto border-t border-white/[0.06] divide-y divide-white/[0.04]">
            {uploads.map(u => (
              <div key={u.id} className="flex items-center gap-2.5 px-4 py-2.5">
                <span className={cx('w-7 h-7 rounded-lg grid place-items-center shrink-0',
                  u.status === 'done' ? 'bg-accent-green/15 text-accent-green'
                    : u.status === 'error' || u.status === 'cancelled' ? 'bg-accent-red/15 text-accent-red'
                    : 'bg-white/[0.06] text-slate-400')}>
                  {u.status === 'done' ? <Icon.Check size={14} /> : u.status === 'error' || u.status === 'cancelled' ? <Icon.Warning size={14} /> : <Icon.Upload size={13} />}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-xs text-slate-200 truncate">{u.name}</p>
                  {u.status === 'uploading'
                    ? <ProgressBar value={u.pct} className="mt-1.5" />
                    : <p className={cx('text-[11px]', u.error ? 'text-accent-red' : 'muted')}>{u.error || (u.status === 'queued' ? 'Queued' : formatBytes(u.size))}</p>}
                </div>
                {u.status === 'uploading' && <span className="text-[11px] muted tabular-nums w-9 text-right">{u.pct}%</span>}
                {(u.status === 'queued' || u.status === 'uploading') && (
                  <button className="icon-btn !w-7 !h-7" title="Cancel upload" aria-label={`Cancel upload of ${u.name}`} onClick={() => onCancel(u.id)}><Icon.Close size={14} /></button>
                )}
                {(u.status === 'error' || u.status === 'cancelled') && (
                  <button className="btn-secondary !py-1 !px-2 text-xs" onClick={() => onRetry(u.id)}><Icon.Refresh size={13} /> Retry</button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Grid card
// ---------------------------------------------------------------------------

function FileGridCard({ entry, selected, anySelected, onOpen, onToggle, onLongPress, menu }:
  { entry: FileEntry; selected: boolean; anySelected: boolean; onOpen: () => void; onToggle: () => void; onLongPress: () => void; menu: any[] }) {
  const [imgOk, setImgOk] = useState(true);
  const showThumb = isThumbable(entry) && imgOk;
  const lp = useLongPress(onLongPress);
  const activate = () => {
    if (lp.fired.current) { lp.fired.current = false; return; }
    onOpen();
  };
  const activationLabel = anySelected
    ? `${selected ? 'Deselect' : 'Select'} ${entry.name}`
    : `${entry.isFolder ? 'Open folder' : 'Open file'} ${entry.name}`;
  return (
    <div
      onContextMenu={e => { e.preventDefault(); onToggle(); }}
      className={cx('group relative card card-hover cursor-pointer !p-0 overflow-hidden select-none focus-within:!border-brand-500/50',
        selected && '!border-brand-500/60 ring-1 ring-brand-500/40')}>
      {/* checkbox */}
      <button type="button" aria-label={`${selected ? 'Deselect' : 'Select'} ${entry.name}`} aria-pressed={selected}
        onContextMenu={e => e.stopPropagation()} onClick={e => { e.stopPropagation(); onToggle(); }}
        className={cx('absolute top-2 left-2 z-10 w-6 h-6 rounded-md grid place-items-center transition-all',
          selected ? 'bg-brand-500 text-white' : 'bg-black/40 text-white/70 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus:opacity-100',
          anySelected && 'opacity-100')}>
        {selected ? <Icon.Check size={14} /> : <span className="w-3 h-3 rounded-[3px] border border-white/70" />}
      </button>
      {/* kebab */}
      <div className="absolute top-2 right-2 z-10 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-within:opacity-100 transition-opacity"
        onContextMenu={e => e.stopPropagation()} onClick={e => e.stopPropagation()}>
        <Menu trigger={<button type="button" aria-label={`Actions for ${entry.name}`} aria-haspopup="menu"
          className="w-7 h-7 rounded-lg bg-black/40 grid place-items-center text-white/80 hover:text-white"><Icon.More size={16} /></button>} items={menu} />
      </div>

      <button type="button" aria-label={activationLabel} aria-pressed={anySelected ? selected : undefined} onClick={activate} {...lp.handlers}
        className="block w-full text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-400/80">
        {/* thumbnail / icon */}
        <span className="relative aspect-[4/3] grid place-items-center overflow-hidden bg-ink-900">
          {showThumb ? (
            <>
              <img src={api.files.thumbUrl(entry.path)} loading="lazy" onError={() => setImgOk(false)}
                className="w-full h-full object-cover" alt="" />
              {entry.kind === 'video' && (
                <span className="absolute inset-0 grid place-items-center pointer-events-none">
                  <span className="w-9 h-9 rounded-full bg-black/50 backdrop-blur-sm grid place-items-center text-white">
                    <Icon.Play size={16} />
                  </span>
                </span>
              )}
            </>
          ) : (
            <span className="w-14 h-14 rounded-2xl grid place-items-center" style={{ background: `${kindColor(entry.kind)}22`, color: kindColor(entry.kind) }}>
              {kindIcon(entry.kind, 26)}
            </span>
          )}
        </span>
        {/* label */}
        <span className="block px-3 py-2.5 border-t border-white/[0.05]">
          <span className="flex items-center gap-1.5">
            <span className="shrink-0" style={{ color: kindColor(entry.kind) }}>{kindIcon(entry.kind, 14)}</span>
            <span className="text-sm text-white truncate flex-1">{entry.name}</span>
            {entry.starred && <Icon.Star size={13} filled className="text-accent-amber shrink-0" />}
          </span>
          <span className="block text-xs muted mt-0.5">{entry.isFolder ? `${entry.itemCount ?? 0} items` : formatBytes(entry.size)}</span>
        </span>
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// List row
// ---------------------------------------------------------------------------

function FileListRow({ entry, selected, anySelected, onOpen, onToggle, onLongPress, menu }:
  { entry: FileEntry; selected: boolean; anySelected: boolean; onOpen: () => void; onToggle: () => void; onLongPress: () => void; menu: any[] }) {
  const lp = useLongPress(onLongPress);
  const [imgOk, setImgOk] = useState(true);
  const showThumb = isThumbable(entry) && imgOk;
  const activate = () => {
    if (lp.fired.current) { lp.fired.current = false; return; }
    onOpen();
  };
  const activationLabel = anySelected
    ? `${selected ? 'Deselect' : 'Select'} ${entry.name}`
    : `${entry.isFolder ? 'Open folder' : 'Open file'} ${entry.name}`;
  return (
    <div onContextMenu={e => { e.preventDefault(); onToggle(); }}
      className={cx('group flex items-center gap-3 px-4 py-2.5 cursor-pointer transition-colors hover:bg-white/[0.03] focus-within:bg-white/[0.03] select-none', selected && 'bg-brand-500/10')}>
      <button type="button" aria-label={`${selected ? 'Deselect' : 'Select'} ${entry.name}`} aria-pressed={selected}
        onContextMenu={e => e.stopPropagation()} onClick={e => { e.stopPropagation(); onToggle(); }}
        className={cx('w-5 h-5 rounded-md grid place-items-center shrink-0 transition-all',
          selected ? 'bg-brand-500 text-white' : cx('border border-white/15 text-transparent group-hover:opacity-100 group-focus-within:opacity-100 focus:opacity-100', anySelected ? 'opacity-100 !border-white/40' : 'opacity-0'))}>
        <Icon.Check size={13} />
      </button>
      <button type="button" aria-label={activationLabel} aria-pressed={anySelected ? selected : undefined} onClick={activate} {...lp.handlers}
        className="flex items-center gap-3 flex-1 min-w-0 text-left rounded-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-400/80">
        {showThumb ? (
          <span className="relative w-8 h-8 rounded-lg overflow-hidden shrink-0 bg-ink-900 grid place-items-center">
            <img src={api.files.thumbUrl(entry.path)} loading="lazy" onError={() => setImgOk(false)}
              className="w-full h-full object-cover" alt="" />
            {entry.kind === 'video' && (
              <span className="absolute inset-0 grid place-items-center pointer-events-none">
                <span className="w-4 h-4 rounded-full bg-black/55 grid place-items-center text-white"><Icon.Play size={9} /></span>
              </span>
            )}
          </span>
        ) : (
          <span className="w-8 h-8 rounded-lg grid place-items-center shrink-0" style={{ background: `${kindColor(entry.kind)}1f`, color: kindColor(entry.kind) }}>
            {kindIcon(entry.kind, 17)}
          </span>
        )}
        <span className="min-w-0 flex-1 flex items-center gap-2">
          <span className="text-sm text-white truncate">{entry.name}</span>
          {entry.starred && <Icon.Star size={13} filled className="text-accent-amber shrink-0" />}
        </span>
        <span className="w-24 text-right text-xs muted hidden sm:block tabular-nums">{entry.isFolder ? `${entry.itemCount ?? 0} items` : formatBytes(entry.size)}</span>
        <span className="w-28 text-right text-xs text-slate-500 hidden sm:block">{formatRelative(entry.modifiedAt)}</span>
      </button>
      <div onContextMenu={e => e.stopPropagation()} onClick={e => e.stopPropagation()} className="w-9 grid place-items-center">
        <Menu trigger={<button type="button" aria-label={`Actions for ${entry.name}`} aria-haspopup="menu"
          className="icon-btn !w-8 !h-8 opacity-60 group-hover:opacity-100 group-focus-within:opacity-100"><Icon.More size={16} /></button>} items={menu} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Trash view
// ---------------------------------------------------------------------------

function TrashView({ items, onRestore, onPurge, onEmpty }:
  { items: any[]; onRestore: (id: string) => void; onPurge: (item: any) => void; onEmpty: () => void }) {
  if (items.length === 0) {
    return <EmptyState icon={<Icon.Trash size={28} />} title="Trash is empty" subtitle="Deleted files land here and can be restored." />;
  }
  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <p className="text-sm muted">{items.length} item{items.length > 1 ? 's' : ''} in Trash</p>
        <button className="btn-danger !py-1.5" onClick={onEmpty}><Icon.Trash size={15} /> Empty Trash</button>
      </div>
      <div className="card !p-0 overflow-hidden divide-y divide-white/[0.04]">
        {items.map((it, i) => {
          const kind: FileKind = it.kind || (it.isFolder ? 'folder' : 'other');
          return (
            <div key={it.id || i} className="flex items-center gap-3 px-4 py-3 hover:bg-white/[0.03] transition-colors">
              <span className="w-9 h-9 rounded-lg grid place-items-center shrink-0" style={{ background: `${kindColor(kind)}1f`, color: kindColor(kind) }}>{kindIcon(kind, 17)}</span>
              <div className="min-w-0 flex-1">
                <p className="text-sm text-white truncate">{it.name}</p>
                <p className="text-xs muted truncate">{it.originalPath || it.parent || it.path || ''} {it.deletedAt && `· deleted ${formatRelative(it.deletedAt)}`}</p>
              </div>
              {it.size != null && <span className="text-xs muted hidden sm:block">{formatBytes(it.size)}</span>}
              <button className="btn-secondary !py-1.5" onClick={() => onRestore(it.id)}><Icon.Refresh size={14} /> Restore</button>
              <button className="icon-btn text-accent-red hover:bg-accent-red/10" aria-label={`Permanently delete ${it.name}`}
                onClick={() => onPurge(it)}><Icon.Trash size={16} /></button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Storage card
// ---------------------------------------------------------------------------

const KIND_META: Record<string, { label: string; color: string }> = {
  image: { label: 'Photos', color: '#ec4899' },
  video: { label: 'Videos', color: '#f43f5e' },
  audio: { label: 'Audio', color: '#a855f7' },
  document: { label: 'Documents', color: '#22d3ee' },
  spreadsheet: { label: 'Sheets', color: '#10b981' },
  pdf: { label: 'PDFs', color: '#ef4444' },
  archive: { label: 'Archives', color: '#94a3b8' },
  other: { label: 'Other', color: '#64748b' },
};

function StorageCard({ usage }: { usage: StorageUsage | null }) {
  if (!usage) {
    return (
      <div className="card p-5">
        <div className="flex items-center gap-2 mb-3"><Icon.Cloud size={18} className="text-slate-500" /><h3 className="font-semibold text-white">Storage</h3></div>
        <div className="grid place-items-center py-6 text-slate-600"><Spinner size={20} /></div>
      </div>
    );
  }
  const pct = usage.quotaBytes ? (usage.usedBytes / usage.quotaBytes) * 100 : Math.min(92, (usage.usedBytes / 1e12) * 20);
  const kinds = Object.entries(usage.byKind).sort((a, b) => b[1].bytes - a[1].bytes);
  const total = usage.usedBytes || 1;
  return (
    <div className="card p-5">
      <div className="flex items-center justify-between mb-4">
        <h3 className="font-semibold text-white">Storage</h3>
        <Icon.Cloud size={18} className="text-slate-500" />
      </div>
      <div className="flex items-end justify-between mb-1">
        <p className="text-2xl font-bold text-white tracking-tight">{formatBytes(usage.usedBytes)}</p>
        <p className="text-xs muted mb-1">of {usage.quotaBytes ? formatBytes(usage.quotaBytes) : 'unlimited'}</p>
      </div>
      {/* segmented bar */}
      <div className="h-2.5 rounded-full bg-white/[0.06] overflow-hidden flex mt-2">
        {kinds.map(([k, v]) => (
          <div key={k} style={{ width: `${(v.bytes / total) * pct}%`, background: (KIND_META[k]?.color || '#64748b') }} className="h-full first:rounded-l-full transition-all" title={`${k}: ${formatBytes(v.bytes)}`} />
        ))}
      </div>
      <p className="text-xs muted mt-2">{usage.fileCount.toLocaleString()} files · {pct.toFixed(0)}% used</p>

      <div className="mt-4 space-y-2.5">
        {kinds.slice(0, 6).map(([k, v]) => {
          const meta = KIND_META[k] || { label: k, color: '#64748b' };
          return (
            <div key={k} className="flex items-center gap-2.5 text-sm">
              <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: meta.color }} />
              <span className="capitalize text-slate-300 flex-1 truncate">{meta.label}</span>
              <span className="text-slate-500 text-xs">{v.count.toLocaleString()}</span>
              <span className="text-slate-400 text-xs w-16 text-right tabular-nums">{formatBytes(v.bytes)}</span>
            </div>
          );
        })}
        {kinds.length === 0 && <p className="text-sm muted">No files yet.</p>}
      </div>
    </div>
  );
}
