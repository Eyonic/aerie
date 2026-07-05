import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../lib/store';
import { Icon } from '../lib/icons';
import { Spinner } from '../components/ui';

export default function Login() {
  const { login, user } = useAuth();
  const nav = useNavigate();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [need2fa, setNeed2fa] = useState(false);
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(false);

  React.useEffect(() => { if (user) nav('/'); }, [user]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr(''); setLoading(true);
    try {
      const r = await login(username.trim(), password, need2fa ? code.trim() : undefined);
      if (r === 'needs2fa') { setNeed2fa(true); setErr(''); }
      else nav('/');
    } catch { setErr(need2fa ? 'Invalid authentication code.' : 'Invalid username or password.'); }
    finally { setLoading(false); }
  };

  return (
    <div className="min-h-full grid lg:grid-cols-2">
      {/* Left: brand panel */}
      <div className="hidden lg:flex relative overflow-hidden bg-gradient-to-br from-brand-700 via-brand-600 to-ink-900 p-12 flex-col justify-between">
        <div className="absolute -top-40 -right-40 w-[500px] h-[500px] rounded-full bg-brand-400/20 blur-3xl" />
        <div className="absolute -bottom-40 -left-20 w-[400px] h-[400px] rounded-full bg-accent-pink/20 blur-3xl" />
        <div className="relative flex items-center gap-3">
          <div className="w-11 h-11 rounded-2xl bg-black/40 border border-white/20 backdrop-blur grid place-items-center"><Icon.Logo size={26} className="text-white" /></div>
          <span className="text-2xl font-bold text-white tracking-tight">Aerie</span>
        </div>
        <div className="relative">
          <h1 className="text-4xl font-bold text-white leading-tight tracking-tight">Your entire private cloud,<br />in one place.</h1>
          <p className="text-white/70 mt-4 text-lg max-w-md">Files, photos, movies, music, audiobooks, documents and AI — all inside one private app on your own server.</p>
          <div className="flex flex-wrap gap-2 mt-8">
            {['Files', 'Photos', 'Movies', 'Music', 'Audiobooks', 'AI Studio', 'Documents'].map(t => (
              <span key={t} className="px-3 py-1.5 rounded-full bg-white/10 text-white/90 text-sm backdrop-blur">{t}</span>
            ))}
          </div>
        </div>
        <p className="relative text-white/40 text-sm">Your server · private &amp; secure</p>
      </div>

      {/* Right: form */}
      <div className="flex items-center justify-center p-6 min-h-screen lg:min-h-full">
        <form onSubmit={submit} className="w-full max-w-sm animate-fade-in">
          <div className="lg:hidden flex items-center gap-3 mb-8 justify-center">
            <div className="w-11 h-11 rounded-2xl bg-ink-950 border border-white/10 grid place-items-center"><Icon.Logo size={24} className="text-white" /></div>
            <span className="text-2xl font-bold text-white">Aerie</span>
          </div>
          <h2 className="text-2xl font-bold text-white">Welcome back</h2>
          <p className="muted text-sm mt-1 mb-7">Sign in to your private cloud.</p>

          <label className="block text-sm font-medium text-slate-300 mb-1.5">Username</label>
          <input className="input mb-4" value={username} onChange={e => setUsername(e.target.value)} placeholder="username" autoFocus autoComplete="username" />

          <label className="block text-sm font-medium text-slate-300 mb-1.5">Password</label>
          <input className="input" type="password" value={password} onChange={e => setPassword(e.target.value)} placeholder="••••••••" autoComplete="current-password" disabled={need2fa} />

          {need2fa && (
            <div className="mt-4 animate-fade-in">
              <label className="block text-sm font-medium text-slate-300 mb-1.5">Authentication code</label>
              <input className="input tracking-[0.4em] text-center text-lg" value={code} onChange={e => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                placeholder="000000" inputMode="numeric" autoComplete="one-time-code" autoFocus maxLength={6} />
              <p className="text-xs text-slate-500 mt-1.5">Enter the 6-digit code from your authenticator app.</p>
            </div>
          )}

          {err && <p className="text-accent-red text-sm mt-3">{err}</p>}

          <button type="submit" disabled={loading} className="btn-primary w-full mt-6 py-2.5">
            {loading ? <Spinner size={18} /> : need2fa ? <>Verify <Icon.ChevronRight size={18} /></> : <>Sign in <Icon.ChevronRight size={18} /></>}
          </button>
          <p className="text-center text-xs text-slate-600 mt-6">Protected by Aerie · all data stays on your server</p>
        </form>
      </div>
    </div>
  );
}
