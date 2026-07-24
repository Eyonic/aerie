import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../lib/api';
import { Icon } from '../lib/icons';
import type {
  AccountShare, AccountSharePermission, DocVersion, FileEntry, FileKind, FileListing, Share,
} from '../lib/model';
import { copyText, cx, formatBytes, formatDate, formatRelative } from '../lib/utils';
import { toast, usePlayer } from '../lib/store';
import { Badge, ConfirmModal, EmptyState, Modal, Spinner } from './ui';

const TEXT_KINDS: FileKind[] = ['text', 'markdown', 'code'];

// Shared paths can be much longer than the bounded player-session schema and
// may contain private folder names. Keep the persistent player identity short
// and opaque while still making it deterministic for a given share + path.
function sharedAudioTrackId(shareId: string, path: string): string {
  let hash = 0x811c9dc5;
  const value = `${shareId}\0${path}`;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return `account-share:${shareId}:${value.length.toString(36)}:${(hash >>> 0).toString(36)}`;
}

function kindFromName(name: string, folder = false): FileKind {
  if (folder) return 'folder';
  const extension = name.split('.').pop()?.toLowerCase() || '';
  if (['txt', 'log'].includes(extension)) return 'text';
  if (['md', 'markdown'].includes(extension)) return 'markdown';
  if (['js', 'ts', 'tsx', 'jsx', 'py', 'json', 'html', 'css', 'sh'].includes(extension)) return 'code';
  if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg', 'avif'].includes(extension)) return 'image';
  if (['mp4', 'mkv', 'mov', 'avi', 'webm', 'm4v'].includes(extension)) return 'video';
  if (['mp3', 'flac', 'wav', 'm4a', 'aac', 'ogg', 'opus'].includes(extension)) return 'audio';
  if (extension === 'pdf') return 'pdf';
  if (['csv', 'tsv'].includes(extension)) return 'csv';
  if (['cbxsheet', 'xls', 'xlsx', 'ods'].includes(extension)) return 'spreadsheet';
  if (['cbxdoc', 'doc', 'docx', 'rtf', 'odt'].includes(extension)) return 'document';
  if (['zip', 'tar', 'gz', '7z', 'rar'].includes(extension)) return 'archive';
  return 'other';
}

function kindIcon(kind: FileKind, size = 18) {
  if (kind === 'folder') return <Icon.Folder size={size} />;
  if (kind === 'image') return <Icon.Image size={size} />;
  if (kind === 'video') return <Icon.Video size={size} />;
  if (kind === 'audio') return <Icon.Music size={size} />;
  if (kind === 'spreadsheet' || kind === 'csv') return <Icon.Sheet size={size} />;
  return <Icon.Doc size={size} />;
}

function downloadShared(shareId: string, relativePath: string) {
  const anchor = document.createElement('a');
  anchor.href = api.accountShares.rawUrl(shareId, relativePath, true);
  anchor.download = '';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}

function SharedPreview({ share, entry, onClose, onChanged }: {
  share: AccountShare;
  entry: FileEntry;
  onClose: () => void;
  onChanged: () => void;
}) {
  const playTrack = usePlayer(state => state.playTrack);
  const editable = share.permission === 'editor';
  const textFile = TEXT_KINDS.includes(entry.kind);
  const [text, setText] = useState('');
  const [revision, setRevision] = useState<string>();
  const [versions, setVersions] = useState<DocVersion[]>([]);
  const [loading, setLoading] = useState(textFile);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(textFile);
    try {
      const [content, history] = await Promise.all([
        textFile ? api.accountShares.content(share.id, entry.path) : Promise.resolve(null),
        api.accountShares.versions(share.id, entry.path),
      ]);
      if (content) { setText(content.content); setRevision(content.revision); }
      setVersions(history);
    } catch (error: any) {
      toast('Could not open shared file', 'error', error?.message || 'The file may no longer be available.');
    } finally { setLoading(false); }
  }, [entry.path, share.id, textFile]);

  useEffect(() => { void load(); }, [load]);

  const save = async () => {
    setSaving(true);
    try {
      const result = await api.accountShares.saveContent(share.id, entry.path, text, revision);
      setRevision(result.revision);
      setVersions(await api.accountShares.versions(share.id, entry.path));
      onChanged();
      toast('Shared file saved', 'success');
    } catch (error: any) {
      toast(error?.message === 'revision_conflict' ? 'Someone else changed this file' : 'Could not save shared file',
        'error', error?.message === 'revision_conflict' ? 'Close and reopen it before applying your edit again.' : error?.message);
    } finally { setSaving(false); }
  };

  const restore = async (version: DocVersion) => {
    try {
      const result = await api.accountShares.restoreVersion(share.id, entry.path, version.id, revision);
      setRevision(result.revision);
      await load();
      onChanged();
      toast('Version restored', 'success');
    } catch (error: any) { toast('Could not restore version', 'error', error?.message); }
  };

  const raw = api.accountShares.rawUrl(share.id, entry.path);
  let preview: React.ReactNode;
  if (loading) preview = <div className="grid place-items-center py-16 text-brand-400"><Spinner size={28} /></div>;
  else if (textFile) preview = editable
    ? <textarea value={text} onChange={event => setText(event.target.value)} aria-label={`Contents of ${entry.name}`}
        className="form-input min-h-[18rem] font-mono text-sm resize-y" spellCheck={false} />
    : <pre className="rounded-xl bg-ink-950 border border-white/[0.06] p-4 text-sm text-slate-200 font-mono whitespace-pre-wrap max-h-[55vh] overflow-auto">{text}</pre>;
  else if (entry.kind === 'image') preview = <div className="grid place-items-center rounded-xl bg-ink-950 overflow-hidden"><img src={raw} alt={entry.name} className="max-h-[60vh] object-contain" /></div>;
  else if (entry.kind === 'video') preview = <video src={raw} controls className="w-full max-h-[60vh] rounded-xl bg-black" />;
  else if (entry.kind === 'audio') preview = <div className="rounded-xl bg-ink-950 p-8 grid place-items-center text-center">
    <span className="text-brand-300 mb-3">{kindIcon('audio', 38)}</span>
    <p className="text-sm text-slate-300 mb-4">Use Aerie’s persistent player so this shared audio keeps playing while you browse.</p>
    <button className="btn-primary" onClick={() => {
      playTrack({
        id: sharedAudioTrackId(share.id, entry.path),
        title: entry.name,
        subtitle: share.owner?.displayName ? `Shared by ${share.owner.displayName}` : share.name,
        streamUrl: raw,
        kind: 'music',
      });
      onClose();
    }}><Icon.Play size={16} /> Play audio</button>
  </div>;
  else if (entry.kind === 'pdf') preview = <iframe src={raw} title={entry.name} className="w-full h-[60vh] rounded-xl bg-white" />;
  else preview = <div className="grid place-items-center text-center rounded-xl bg-ink-950 py-14">
    <span className="text-brand-300 mb-3">{kindIcon(entry.kind, 36)}</span>
    <p className="text-white">No inline preview is available.</p>
    <p className="text-sm muted mt-1">Download the file to open it on this device.</p>
  </div>;

  return <Modal open onClose={onClose} title={entry.name} size="xl" footer={<>
    <button className="btn-secondary" onClick={() => downloadShared(share.id, entry.path)}><Icon.Download size={15} /> Download</button>
    {editable && textFile && <button className="btn-primary" onClick={save} disabled={saving}>
      {saving ? <Spinner size={15} /> : <Icon.Check size={15} />} Save
    </button>}
  </>}>
    <div className="flex items-center gap-2 text-xs mb-4">
      <Badge color="slate">{entry.kind}</Badge><span className="muted">{formatBytes(entry.size)}</span>
      <Badge color={editable ? 'green' : 'cyan'}>{share.permission}</Badge>
    </div>
    {preview}
    {versions.length > 0 && <div className="mt-5 border-t border-white/[0.06] pt-4">
      <h3 className="section-title mb-2">Version history</h3>
      <div className="rounded-xl border border-white/[0.06] divide-y divide-white/[0.04] max-h-48 overflow-y-auto">
        {versions.slice(0, 20).map(version => <div key={version.id} className="flex items-center gap-3 px-3 py-2.5">
          <Icon.Clock size={14} className="text-slate-500 shrink-0" />
          <div className="min-w-0 flex-1"><p className="text-xs text-slate-200">{version.author}</p>
            <p className="text-[11px] muted">{formatDate(version.createdAt)} · {formatBytes(version.sizeBytes)}</p></div>
          {editable && <button className="btn-secondary !py-1 !px-2 text-xs" onClick={() => restore(version)}>Restore</button>}
        </div>)}
      </div>
    </div>}
  </Modal>;
}

function SharedBrowser({ share, onBack, onLeave, onUpdated }: {
  share: AccountShare;
  onBack: () => void;
  onLeave: (share: AccountShare) => void;
  onUpdated: () => void;
}) {
  const editable = share.permission === 'editor';
  const [path, setPath] = useState('');
  const [listing, setListing] = useState<FileListing | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [preview, setPreview] = useState<FileEntry | null>(null);
  const [rename, setRename] = useState<FileEntry | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [deleting, setDeleting] = useState<FileEntry | null>(null);
  const [creating, setCreating] = useState<'folder' | 'file' | null>(null);
  const [newName, setNewName] = useState('');
  const [uploadPct, setUploadPct] = useState<number | null>(null);
  const uploadRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    if (!share.isFolder) return;
    setLoading(true); setError(null);
    try { setListing(await api.accountShares.list(share.id, path)); }
    catch (loadError: any) { setError(loadError?.message || 'shared_space_unavailable'); }
    finally { setLoading(false); }
  }, [path, share.id, share.isFolder]);
  useEffect(() => { void load(); }, [load]);

  const rootFile: FileEntry | null = !share.isFolder ? {
    id: share.id, name: share.name, path: '', parent: '', kind: kindFromName(share.name),
    mime: 'application/octet-stream', size: share.sizeBytes || 0, modifiedAt: share.updatedAt,
    createdAt: share.createdAt, isFolder: false, starred: false,
  } : null;
  useEffect(() => { if (rootFile) setPreview(rootFile); }, [share.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const entries = useMemo(() => {
    const source = listing?.entries || [];
    const needle = query.trim().toLowerCase();
    return needle ? source.filter(entry => entry.name.toLowerCase().includes(needle)) : source;
  }, [listing, query]);

  const changed = async () => { await load(); onUpdated(); };
  const createItem = async () => {
    const name = newName.trim();
    if (!name || !creating) return;
    try {
      if (creating === 'folder') await api.accountShares.mkdir(share.id, path, name);
      else await api.accountShares.createFile(share.id, path, name);
      setCreating(null); setNewName(''); await changed();
      toast(creating === 'folder' ? 'Shared folder created' : 'Shared file created', 'success');
    } catch (createError: any) { toast('Could not create item', 'error', createError?.message); }
  };
  const renameItem = async () => {
    if (!rename || !renameValue.trim()) return;
    try {
      await api.accountShares.rename(share.id, rename.path, renameValue.trim());
      setRename(null); await changed(); toast('Shared item renamed', 'success');
    } catch (renameError: any) { toast('Could not rename item', 'error', renameError?.message); }
  };
  const deleteItem = async () => {
    if (!deleting) return;
    try {
      await api.accountShares.remove(share.id, [deleting.path]);
      setDeleting(null); await changed(); toast('Moved to the owner’s Trash', 'success');
    } catch (deleteError: any) { toast('Could not delete item', 'error', deleteError?.message); }
  };
  const upload = async (files: FileList | null) => {
    if (!files?.length) return;
    setUploadPct(0);
    try {
      await api.accountShares.upload(share.id, path, Array.from(files), undefined, setUploadPct);
      await changed(); toast('Shared upload complete', 'success');
    } catch (uploadError: any) { toast('Shared upload failed', 'error', uploadError?.message); }
    finally { setUploadPct(null); if (uploadRef.current) uploadRef.current.value = ''; }
  };

  return <div className="space-y-4">
    <div className="flex items-center gap-3 flex-wrap">
      <button className="icon-btn" onClick={onBack} aria-label="Back to Shared"><Icon.ChevronLeft size={18} /></button>
      <div className="min-w-0 flex-1">
        <h2 className="text-lg font-semibold text-white truncate">{share.name}</h2>
        <p className="text-xs muted">Shared by {share.owner?.displayName || 'a household member'} · {share.permission}</p>
      </div>
      <Badge color={editable ? 'green' : 'cyan'}>{editable ? 'Can edit' : 'View only'}</Badge>
      <button className="btn-secondary !py-1.5" onClick={() => onLeave(share)}>Leave share</button>
    </div>

    {share.isFolder && <>
      <div className="flex items-center gap-2 flex-wrap">
        <div className="relative flex-1 min-w-[12rem]"><Icon.Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
          <input className="form-input !pl-9" value={query} onChange={event => setQuery(event.target.value)} placeholder="Find in this shared folder" aria-label="Find in shared folder" /></div>
        {editable && <>
          <input ref={uploadRef} type="file" multiple className="hidden" onChange={event => void upload(event.target.files)} />
          <button className="btn-secondary" onClick={() => uploadRef.current?.click()} disabled={uploadPct !== null}><Icon.Upload size={15} /> Upload</button>
          <button className="btn-secondary" onClick={() => { setCreating('folder'); setNewName(''); }}><Icon.Folder size={15} /> New folder</button>
          <button className="btn-primary" onClick={() => { setCreating('file'); setNewName(''); }}><Icon.Plus size={15} /> New file</button>
        </>}
      </div>
      {uploadPct !== null && <div role="status" className="rounded-xl border border-brand-500/20 bg-brand-500/10 px-3 py-2 text-xs text-brand-200">Uploading… {uploadPct}%</div>}
      <div className="flex items-center gap-1 flex-wrap text-sm">
        {(listing?.breadcrumbs || [{ name: share.name, path: '' }]).map((breadcrumb, index) => <React.Fragment key={breadcrumb.path || 'root'}>
          {index > 0 && <Icon.ChevronRight size={13} className="text-slate-600" />}
          <button className={cx('px-1.5 py-1 rounded hover:bg-white/[0.05]', breadcrumb.path === path ? 'text-white' : 'text-slate-400')}
            onClick={() => setPath(breadcrumb.path)}>{breadcrumb.name}</button>
        </React.Fragment>)}
      </div>

      {loading ? <div className="grid place-items-center py-16 text-brand-400"><Spinner size={28} /></div>
        : error ? <EmptyState icon={<Icon.Warning size={28} />} title="Shared space unavailable" subtitle="The owner may have moved, removed, or revoked it." action={<button className="btn-secondary" onClick={() => void load()}><Icon.Refresh size={14} /> Try again</button>} />
        : entries.length === 0 ? <EmptyState icon={<Icon.Folder size={28} />} title={query ? 'No matching items' : 'This folder is empty'} subtitle={query ? 'Try a different filename.' : editable ? 'Upload or create something here.' : undefined} />
        : <div className="card !p-0 overflow-hidden divide-y divide-white/[0.04]">
          {entries.map(entry => <div key={entry.id} className="group flex items-center gap-3 px-3 sm:px-4 py-3 hover:bg-white/[0.03]">
            {entry.kind === 'image' ? <img src={api.accountShares.thumbUrl(share.id, entry.path)} alt="" className="w-9 h-9 rounded-lg object-cover bg-ink-950" />
              : <span className="w-9 h-9 rounded-lg bg-brand-500/10 text-brand-300 grid place-items-center shrink-0">{kindIcon(entry.kind)}</span>}
            <button className="min-w-0 flex-1 text-left" onClick={() => entry.isFolder ? setPath(entry.path) : setPreview(entry)}>
              <span className="block text-sm text-white truncate">{entry.name}</span>
              <span className="block text-xs muted">{entry.isFolder ? `${entry.itemCount || 0} items` : formatBytes(entry.size)} · {formatRelative(entry.modifiedAt)}</span>
            </button>
            {!entry.isFolder && <button className="icon-btn" onClick={() => downloadShared(share.id, entry.path)} aria-label={`Download ${entry.name}`}><Icon.Download size={15} /></button>}
            {editable && <>
              <button className="icon-btn" onClick={() => { setRename(entry); setRenameValue(entry.name); }} aria-label={`Rename ${entry.name}`}><Icon.Edit size={15} /></button>
              <button className="icon-btn text-accent-red hover:bg-accent-red/10" onClick={() => setDeleting(entry)} aria-label={`Delete ${entry.name}`}><Icon.Trash size={15} /></button>
            </>}
          </div>)}
        </div>}
    </>}

    {preview && <SharedPreview share={share} entry={preview} onClose={() => { setPreview(null); if (!share.isFolder) onBack(); }} onChanged={() => void changed()} />}
    <Modal open={!!creating} onClose={() => setCreating(null)} title={creating === 'folder' ? 'New shared folder' : 'New shared file'} size="sm" footer={<>
      <button className="btn-secondary" onClick={() => setCreating(null)}>Cancel</button><button className="btn-primary" onClick={() => void createItem()} disabled={!newName.trim()}>Create</button>
    </>}><label className="section-title block mb-2" htmlFor="shared-new-name">Name</label><input id="shared-new-name" data-modal-initial-focus className="form-input" value={newName} onChange={event => setNewName(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') void createItem(); }} /></Modal>
    <Modal open={!!rename} onClose={() => setRename(null)} title={`Rename ${rename?.name || 'item'}`} size="sm" footer={<>
      <button className="btn-secondary" onClick={() => setRename(null)}>Cancel</button><button className="btn-primary" onClick={() => void renameItem()} disabled={!renameValue.trim()}>Rename</button>
    </>}><label className="section-title block mb-2" htmlFor="shared-rename">New name</label><input id="shared-rename" data-modal-initial-focus className="form-input" value={renameValue} onChange={event => setRenameValue(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') void renameItem(); }} /></Modal>
    <ConfirmModal open={!!deleting} onClose={() => setDeleting(null)} onConfirm={() => void deleteItem()} danger confirmLabel="Move to Trash"
      title={`Delete ${deleting?.name || 'item'}?`} message="The item moves to the owner’s Trash, where the owner can recover it." />
  </div>;
}

export function SharedSpaces({ publicShares, refreshKey = 0, onRevokePublic, onOpenOwned }: {
  publicShares: Share[];
  refreshKey?: number;
  onRevokePublic: (id: string) => Promise<void> | void;
  onOpenOwned: (path: string) => void;
}) {
  const [received, setReceived] = useState<AccountShare[]>([]);
  const [owned, setOwned] = useState<AccountShare[]>([]);
  const [active, setActive] = useState<AccountShare | null>(null);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [leaving, setLeaving] = useState<AccountShare | null>(null);
  const [revoking, setRevoking] = useState<AccountShare | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [incoming, outgoing] = await Promise.all([api.accountShares.received(), api.accountShares.owned()]);
      setReceived(incoming); setOwned(outgoing);
      if (active) setActive(incoming.find(item => item.id === active.id) || null);
    } catch (error: any) { toast('Could not load household shares', 'error', error?.message); }
    finally { setLoading(false); }
  }, [active?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { void refresh(); }, [refreshKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const visible = <T extends AccountShare | Share>(items: T[]) => {
    const needle = query.trim().toLowerCase();
    if (!needle) return items;
    return items.filter(item => `${item.name} ${'owner' in item ? item.owner?.displayName || '' : ''} ${'recipient' in item ? item.recipient?.displayName || '' : ''}`.toLowerCase().includes(needle));
  };
  const revoke = async () => {
    if (!revoking) return;
    try {
      await api.accountShares.revoke(revoking.id);
      setRevoking(null);
      await refresh();
      toast('Household access revoked', 'success');
    }
    catch (error: any) { toast('Could not revoke access', 'error', error?.message); }
  };
  const changePermission = async (share: AccountShare, permission: AccountSharePermission) => {
    try { await api.accountShares.setPermission(share.id, permission); await refresh(); toast('Access updated', 'success'); }
    catch (error: any) { toast('Could not update access', 'error', error?.message); }
  };
  const leave = async () => {
    if (!leaving) return;
    try { await api.accountShares.leave(leaving.id); if (active?.id === leaving.id) setActive(null); setLeaving(null); await refresh(); toast('Shared space removed', 'success'); }
    catch (error: any) { toast('Could not leave shared space', 'error', error?.message); }
  };
  const copyPublic = async (share: Share) => {
    const ok = await copyText(`${window.location.origin}/s/${share.id}`);
    toast(ok ? 'Link copied' : 'Copy failed', ok ? 'success' : 'error');
  };

  if (active) return <>
    <SharedBrowser share={active} onBack={() => setActive(null)} onLeave={setLeaving} onUpdated={() => void refresh()} />
    <ConfirmModal open={!!leaving} onClose={() => setLeaving(null)} onConfirm={() => void leave()} danger confirmLabel="Leave share"
      title={`Leave ${leaving?.name || 'shared space'}?`} message="It will disappear from Shared with me. The owner’s files are not deleted." />
  </>;
  if (loading) return <div className="grid place-items-center py-20 text-brand-400"><Spinner size={30} /></div>;
  const incoming = visible(received), outgoing = visible(owned), links = visible(publicShares);
  const nothing = received.length + owned.length + publicShares.length === 0;
  if (nothing) return <EmptyState icon={<Icon.Share size={28} />} title="Nothing shared yet" subtitle="Share a file with a household member or create a protected public link." />;

  return <div className="space-y-6">
    <div className="relative max-w-xl"><Icon.Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
      <input className="form-input !pl-9" value={query} onChange={event => setQuery(event.target.value)} placeholder="Find people, files, and shared spaces" aria-label="Search shares" /></div>

    <section aria-labelledby="shared-with-me-heading">
      <div className="flex items-center justify-between mb-2"><h3 id="shared-with-me-heading" className="section-title">Shared with me</h3><span className="text-xs muted">{received.length}</span></div>
      {incoming.length === 0 ? <div className="rounded-xl border border-white/[0.06] p-4 text-sm muted">{query ? 'No matching incoming shares.' : 'No household member has shared anything with you yet.'}</div>
        : <div className="grid sm:grid-cols-2 xl:grid-cols-3 gap-3">{incoming.map(share => <div key={share.id} className="card !p-4 flex flex-col">
          <div className="flex items-start gap-3"><span className="w-10 h-10 rounded-xl bg-brand-500/15 text-brand-300 grid place-items-center shrink-0">{share.isFolder ? <Icon.Folder size={19} /> : <Icon.Doc size={19} />}</span>
            <div className="min-w-0 flex-1"><p className="text-sm font-medium text-white truncate">{share.name}</p><p className="text-xs muted truncate">from {share.owner?.displayName}</p></div>
            <Badge color={share.permission === 'editor' ? 'green' : 'cyan'}>{share.permission}</Badge></div>
          <div className="mt-4 flex items-center gap-2"><button className="btn-primary !py-1.5 flex-1" disabled={!share.available} onClick={() => setActive(share)}>{share.isFolder ? 'Open' : 'View'}</button>
            <button className="icon-btn" onClick={() => setLeaving(share)} aria-label={`Leave ${share.name}`}><Icon.Close size={15} /></button></div>
          {!share.available && <p className="text-xs text-accent-amber mt-2">Currently unavailable</p>}
        </div>)}</div>}
    </section>

    <section aria-labelledby="shared-by-me-heading">
      <div className="flex items-center justify-between mb-2"><h3 id="shared-by-me-heading" className="section-title">Shared by me</h3><span className="text-xs muted">{owned.length}</span></div>
      {outgoing.length === 0 ? <div className="rounded-xl border border-white/[0.06] p-4 text-sm muted">{query ? 'No matching household grants.' : 'Use Share on a file or folder to give a household member access.'}</div>
        : <div className="card !p-0 overflow-hidden divide-y divide-white/[0.04]">{outgoing.map(share => <div key={share.id} className="flex items-center gap-3 px-3 sm:px-4 py-3">
          <span className="w-9 h-9 rounded-lg grid place-items-center text-white shrink-0" style={{ background: share.recipient?.avatarColor || '#475569' }}>{share.recipient?.displayName?.slice(0, 1).toUpperCase()}</span>
          <button className="min-w-0 flex-1 text-left" onClick={() => share.rootPath && onOpenOwned(share.rootPath)}><span className="block text-sm text-white truncate">{share.name}</span><span className="block text-xs muted truncate">{share.recipient?.displayName} · {share.rootPath}</span></button>
          <select className="form-select !w-auto !py-1.5 text-xs" value={share.permission} onChange={event => void changePermission(share, event.target.value as AccountSharePermission)} aria-label={`Access for ${share.recipient?.displayName}`}>
            <option value="viewer">Viewer</option><option value="editor">Editor</option>
          </select>
          <button className="icon-btn text-accent-red hover:bg-accent-red/10" onClick={() => setRevoking(share)} aria-label={`Revoke access for ${share.recipient?.displayName}`}><Icon.Trash size={15} /></button>
        </div>)}</div>}
    </section>

    <section aria-labelledby="public-links-heading">
      <div className="flex items-center justify-between mb-2"><h3 id="public-links-heading" className="section-title">Public links</h3><span className="text-xs muted">{publicShares.length}</span></div>
      {links.length === 0 ? <div className="rounded-xl border border-white/[0.06] p-4 text-sm muted">{query ? 'No matching public links.' : 'No public links are active.'}</div>
        : <div className="card !p-0 overflow-hidden divide-y divide-white/[0.04]">{links.map(share => <div key={share.id} className="flex items-center gap-3 px-3 sm:px-4 py-3">
          <span className="w-9 h-9 rounded-lg bg-white/[0.05] text-slate-300 grid place-items-center"><Icon.Link size={16} /></span>
          <button className="min-w-0 flex-1 text-left" onClick={() => onOpenOwned(share.path)}><span className="block text-sm text-white truncate">{share.name}</span><span className="block text-xs muted truncate">{share.path}</span></button>
          {share.hasPassword && <Badge color="amber">Password</Badge>}
          <button className="icon-btn" onClick={() => void copyPublic(share)} aria-label={`Copy link for ${share.name}`}><Icon.Copy size={15} /></button>
          <button className="icon-btn text-accent-red hover:bg-accent-red/10" onClick={() => void onRevokePublic(share.id)} aria-label={`Revoke link for ${share.name}`}><Icon.Trash size={15} /></button>
        </div>)}</div>}
    </section>

    <ConfirmModal open={!!leaving} onClose={() => setLeaving(null)} onConfirm={() => void leave()} danger confirmLabel="Leave share"
      title={`Leave ${leaving?.name || 'shared space'}?`} message="It will disappear from Shared with me. The owner’s files are not deleted." />
    <ConfirmModal open={!!revoking} onClose={() => setRevoking(null)} onConfirm={() => void revoke()} danger confirmLabel="Revoke access"
      title={`Revoke access to ${revoking?.name || 'this shared space'}?`}
      message={`${revoking?.recipient?.displayName || 'This household member'} will lose access immediately. Your files are not deleted.`} />
  </div>;
}
