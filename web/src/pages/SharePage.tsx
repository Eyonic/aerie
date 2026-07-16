// Public share view — renders a file shared via a link, with no login required.
// The backend exposes GET /api/shares/public/:id (optionally password-gated).
import React, { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api } from '../lib/api';
import { Icon } from '../lib/icons';
import { Spinner } from '../components/ui';
import { formatBytes } from '../lib/utils';

export default function SharePage() {
  const { id } = useParams();
  const [state, setState] = useState<'loading' | 'password' | 'ready' | 'error'>('loading');
  const [info, setInfo] = useState<any>(null);
  const [password, setPassword] = useState('');
  const [err, setErr] = useState('');

  const load = async () => {
    try {
      const data = await api.shares.public(id!);
      setInfo(data);
      setState(data.hasPassword ? 'password' : 'ready');
    } catch { setState('error'); }
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [id]);

  const unlock = async () => {
    setErr('');
    try {
      await api.shares.open(id!, password);   // validates the password (403 if wrong)
      setState('ready');
    } catch (e: any) { setErr('Wrong password.'); }
  };

  const dl = info ? api.shares.publicDownloadUrl(id!, password) : '#';
  const isImg = info && /\.(png|jpe?g|gif|webp|avif|svg)$/i.test(info.name || '');
  const isVid = info && /\.(mp4|webm|mov|mkv)$/i.test(info.name || '');
  const isAudio = info && /\.(mp3|m4a|wav|flac|ogg)$/i.test(info.name || '');

  return (
    <div className="min-h-full grid place-items-center p-4 bg-ink-950">
      <div className="w-full max-w-2xl">
        <div className="flex items-center gap-2.5 mb-6 justify-center">
          <div className="w-9 h-9 rounded-xl bg-ink-900 border border-white/10 overflow-hidden grid place-items-center"><img src="/logo.svg?v=2" alt="Aerie" className="w-full h-full object-contain" /></div>
          <span className="font-bold text-white text-lg">Aerie</span>
        </div>

        {state === 'loading' && <div className="grid place-items-center py-20"><Spinner size={32} /></div>}

        {state === 'error' && (
          <div className="card p-8 text-center">
            <Icon.Warning size={32} className="text-accent-amber mx-auto mb-3" />
            <p className="text-white font-semibold">This link is unavailable</p>
            <p className="muted text-sm mt-1">It may have expired or been removed.</p>
          </div>
        )}

        {state === 'password' && (
          <form onSubmit={e => { e.preventDefault(); unlock(); }} className="card p-8 max-w-sm mx-auto">
            <Icon.Shield size={28} className="text-brand-400 mx-auto mb-3" />
            <p className="text-white font-semibold text-center">Password required</p>
            <p className="muted text-sm text-center mt-1 mb-4">This shared file is protected.</p>
            <input type="password" className="input w-full" value={password} onChange={e => setPassword(e.target.value)} placeholder="Enter password" autoFocus />
            {err && <p className="text-accent-red text-sm mt-2">{err}</p>}
            <button type="submit" className="btn-primary w-full mt-4">Unlock</button>
          </form>
        )}

        {state === 'ready' && info && (
          <div className="card p-6 animate-fade-in">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-12 h-12 rounded-xl bg-ink-800 grid place-items-center text-brand-300 shrink-0"><Icon.Files size={22} /></div>
              <div className="min-w-0">
                <p className="text-white font-semibold truncate">{info.name}</p>
                <p className="muted text-xs">{info.sizeBytes ? formatBytes(info.sizeBytes) : 'Shared file'}</p>
              </div>
              <a href={dl} className="btn-primary ml-auto shrink-0" download><Icon.Download size={16} /> Download</a>
            </div>
            <div className="rounded-xl overflow-hidden bg-ink-900 border border-white/[0.06] grid place-items-center min-h-[200px]">
              {isImg ? <img src={dl} className="max-w-full max-h-[70vh] object-contain" /> :
               isVid ? <video src={dl} controls className="max-w-full max-h-[70vh]" /> :
               isAudio ? <audio src={dl} controls className="w-full m-6" /> :
               <div className="py-16 text-center"><Icon.Files size={40} className="text-slate-600 mx-auto mb-2" /><p className="muted text-sm">Preview not available — download to open.</p></div>}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
