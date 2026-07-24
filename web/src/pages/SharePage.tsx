// Public, read-only capability view. Passwords are exchanged for an HttpOnly
// share session and are never kept in media/download URLs.
import React, { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api } from '../lib/api';
import { Icon } from '../lib/icons';
import { Spinner } from '../components/ui';
import { formatBytes } from '../lib/utils';

type PublicInfo = {
  id: string; name: string; hasPassword: boolean; allowDownload: boolean;
  isFolder: boolean; sizeBytes: number | null; expiresAt?: string | null;
};
type PublicEntry = { name: string; path: string; isFolder: boolean; size: number; modifiedAt: string; kind: string };

export default function SharePage() {
  const { id = '' } = useParams();
  const [state, setState] = useState<'loading' | 'password' | 'ready' | 'error'>('loading');
  const [info, setInfo] = useState<PublicInfo | null>(null);
  const [password, setPassword] = useState('');
  const [err, setErr] = useState('');
  const [folderPath, setFolderPath] = useState('');
  const [entries, setEntries] = useState<PublicEntry[]>([]);
  const [listing, setListing] = useState(false);

  useEffect(() => {
    let active = true;
    api.shares.public(id).then(data => {
      if (!active) return;
      setInfo(data);
      setState(data.hasPassword ? 'password' : 'ready');
    }).catch(() => active && setState('error'));
    return () => { active = false; };
  }, [id]);

  useEffect(() => {
    if (state !== 'ready' || !info?.isFolder) return;
    let active = true;
    setListing(true);
    api.shares.publicList(id, folderPath).then(data => {
      if (active) { setEntries(data.entries); setFolderPath(data.path); }
    }).catch(() => active && setErr('This folder could not be opened.'))
      .finally(() => active && setListing(false));
    return () => { active = false; };
  }, [folderPath, id, info?.isFolder, state]);

  const unlock = async () => {
    setErr('');
    try {
      const opened = await api.shares.open(id, password);
      setInfo(current => ({ ...(current || { id, hasPassword: true }), ...opened } as PublicInfo));
      setPassword('');
      setState('ready');
    } catch (error: any) {
      setErr(error?.status === 429 ? 'Too many attempts. Please wait before trying again.' : 'The password is incorrect.');
    }
  };

  const rootDownload = info ? api.shares.publicDownloadUrl(id) : '#';
  const isImg = info && /\.(png|jpe?g|gif|webp|avif|svg)$/i.test(info.name || '');
  const isVid = info && /\.(mp4|webm|mov|mkv)$/i.test(info.name || '');
  const isAudio = info && /\.(mp3|m4a|wav|flac|ogg)$/i.test(info.name || '');
  const parent = folderPath.includes('/') ? folderPath.slice(0, folderPath.lastIndexOf('/')) : '';

  return (
    <div className="min-h-full grid place-items-center p-4 bg-ink-950">
      <div className="w-full max-w-3xl">
        <div className="flex items-center gap-2.5 mb-6 justify-center">
          <div className="w-9 h-9 rounded-xl bg-ink-900 border border-white/10 overflow-hidden grid place-items-center"><img src="/logo.svg?v=2" alt="Aerie" className="w-full h-full object-contain" /></div>
          <span className="font-bold text-white text-lg">Aerie</span>
        </div>

        {state === 'loading' && <div className="grid place-items-center py-20"><Spinner size={32} /></div>}

        {state === 'error' && (
          <div className="card p-8 text-center">
            <Icon.Warning size={32} className="text-accent-amber mx-auto mb-3" />
            <p className="text-white font-semibold">This link is unavailable</p>
            <p className="muted text-sm mt-1">It may have expired, been revoked, or public sharing may be disabled.</p>
          </div>
        )}

        {state === 'password' && (
          <form onSubmit={event => { event.preventDefault(); void unlock(); }} className="card p-8 max-w-sm mx-auto">
            <Icon.Shield size={28} className="text-brand-400 mx-auto mb-3" />
            <p className="text-white font-semibold text-center">Password required</p>
            <p className="muted text-sm text-center mt-1 mb-4">Unlock this share without placing its password in the URL.</p>
            <label htmlFor="share-password" className="block text-sm font-medium text-slate-300 mb-1.5">Share password</label>
            <input id="share-password" name="password" type="password" className="input w-full" value={password} onChange={event => setPassword(event.target.value)} placeholder="Enter password" autoComplete="current-password" autoFocus />
            {err && <p role="alert" className="text-accent-red text-sm mt-2">{err}</p>}
            <button type="submit" className="btn-primary w-full mt-4">Unlock</button>
          </form>
        )}

        {state === 'ready' && info && (
          <div className="card p-6 animate-fade-in">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-12 h-12 rounded-xl bg-ink-800 grid place-items-center text-brand-300 shrink-0"><Icon.Files size={22} /></div>
              <div className="min-w-0 flex-1">
                <p className="text-white font-semibold truncate">{info.name}</p>
                <p className="muted text-xs">{info.isFolder ? 'Shared folder' : info.sizeBytes != null ? formatBytes(info.sizeBytes) : 'Shared file'}</p>
              </div>
              {!info.isFolder && info.allowDownload && <a href={rootDownload} className="btn-primary ml-auto shrink-0" download><Icon.Download size={16} /> Download</a>}
            </div>

            {err && <p className="text-accent-red text-sm mb-3">{err}</p>}

            {info.isFolder ? (
              <div className="rounded-xl overflow-hidden bg-ink-900 border border-white/[0.06]">
                <div className="px-3 py-2 border-b border-white/[0.06] flex items-center gap-2 text-xs text-slate-400">
                  <button className="btn-ghost !p-1.5" disabled={!folderPath} onClick={() => setFolderPath(parent)} aria-label="Parent folder"><Icon.ChevronLeft size={15} /></button>
                  <span className="truncate">/{folderPath}</span>
                </div>
                {listing ? <div className="grid place-items-center py-16"><Spinner size={24} /></div> : entries.length === 0 ? (
                  <div className="py-16 text-center muted text-sm">This folder is empty.</div>
                ) : entries.map(entry => (
                  <div key={entry.path} className="flex items-center gap-3 px-3 py-3 border-b last:border-0 border-white/[0.04]">
                    <Icon.Files size={17} className="text-brand-300 shrink-0" />
                    {entry.isFolder ? (
                      <button className="text-sm text-white truncate text-left flex-1" onClick={() => setFolderPath(entry.path)}>{entry.name}</button>
                    ) : <span className="text-sm text-white truncate flex-1">{entry.name}</span>}
                    {!entry.isFolder && <span className="muted text-xs">{formatBytes(entry.size)}</span>}
                    {!entry.isFolder && info.allowDownload && <a className="icon-btn" href={api.shares.publicDownloadUrl(id, entry.path)} download={entry.name} aria-label={`Download ${entry.name}`}><Icon.Download size={15} /></a>}
                  </div>
                ))}
              </div>
            ) : info.allowDownload ? (
              <div className="rounded-xl overflow-hidden bg-ink-900 border border-white/[0.06] grid place-items-center min-h-[200px]">
                {isImg ? <img src={rootDownload} alt={info.name} className="max-w-full max-h-[70vh] object-contain" /> :
                 isVid ? <video src={rootDownload} controls className="max-w-full max-h-[70vh]" /> :
                 isAudio ? <audio src={rootDownload} controls className="w-full m-6" /> :
                 <div className="py-16 text-center"><Icon.Files size={40} className="text-slate-600 mx-auto mb-2" /><p className="muted text-sm">Preview not available — download to open.</p></div>}
              </div>
            ) : (
              <div className="rounded-xl bg-ink-900 border border-white/[0.06] py-12 text-center">
                <Icon.Shield size={30} className="text-slate-500 mx-auto mb-2" />
                <p className="text-slate-300 text-sm">The owner disabled file downloads for this link.</p>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
