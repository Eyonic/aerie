import React, { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api } from '../lib/api';
import { Icon } from '../lib/icons';
import { useAuth } from '../lib/store';
import { Spinner } from '../components/ui';

type InviteDetails = { displayName: string; email: string | null; role: 'admin' | 'user'; expiresAt: string };

function friendlyError(error: any): string {
  const code = String(error?.message || '');
  if (code === 'username_taken') return 'That username is already in use. Choose another.';
  if (code === 'username_length') return 'Use a username between 3 and 64 characters.';
  if (code === 'username_invalid') return 'Use letters, numbers, dots, dashes or underscores; start with a letter or number.';
  if (code === 'password_too_short') return 'Use a password of at least 12 characters.';
  if (code === 'invite_not_found') return 'This invitation is invalid, expired, revoked or already used.';
  return 'The account could not be created. Check the details and try again.';
}

export default function Join() {
  const { token = '' } = useParams();
  const navigate = useNavigate();
  const { user, loading: authLoading, logout, login } = useAuth();
  const [invite, setInvite] = useState<InviteDetails | null>(null);
  const [loading, setLoading] = useState(true);
  const [unavailable, setUnavailable] = useState(false);
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let active = true;
    api.invite.inspect(token).then(details => {
      if (!active) return;
      setInvite(details);
      setDisplayName(details.displayName || '');
    }).catch(() => { if (active) setUnavailable(true); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [token]);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError('');
    if (password.length < 12) return setError('Use a password of at least 12 characters.');
    if (password !== confirm) return setError('The passwords do not match.');
    setBusy(true);
    try {
      await api.invite.accept(token, { username: username.trim(), displayName: displayName.trim(), password });
      const result = await login(username.trim(), password);
      if (result !== 'ok') throw new Error('login_failed');
      navigate('/', { replace: true });
    } catch (err: any) { setError(friendlyError(err)); }
    finally { setBusy(false); }
  };

  if (loading || authLoading) return <div className="min-h-full grid place-items-center bg-ink-950"><Spinner size={28} /></div>;
  if (user) return <div className="min-h-full grid place-items-center bg-ink-950 p-5"><div className="card w-full max-w-md p-6 text-center">
    <div className="mx-auto grid h-14 w-14 place-items-center rounded-2xl bg-brand-500/15 text-brand-300"><Icon.Admin size={26} /></div>
    <h1 className="mt-4 text-xl font-bold text-white">You’re already signed in</h1>
    <p className="mt-2 text-sm muted">This invitation creates a different household account. Sign out of {user.displayName} before continuing.</p>
    <button className="btn-primary mt-5 w-full" onClick={() => void logout()}>Sign out and continue</button>
  </div></div>;
  if (unavailable || !invite) return <div className="min-h-full grid place-items-center bg-ink-950 p-5"><div className="card w-full max-w-md p-6 text-center">
    <div className="mx-auto grid h-14 w-14 place-items-center rounded-2xl bg-accent-amber/15 text-accent-amber"><Icon.Warning size={26} /></div>
    <h1 className="mt-4 text-xl font-bold text-white">Invitation unavailable</h1>
    <p className="mt-2 text-sm muted">It may have expired, been revoked, or already been used. Ask your Aerie administrator for a new link.</p>
    <button className="btn-secondary mt-5" onClick={() => navigate('/login')}>Go to sign in</button>
  </div></div>;

  return <div className="min-h-full grid place-items-center bg-ink-950 p-5">
    <form onSubmit={submit} className="card w-full max-w-lg p-6 sm:p-8">
      <div className="flex items-center gap-3">
        <div className="grid h-12 w-12 shrink-0 place-items-center overflow-hidden rounded-2xl border border-white/10 bg-ink-900"><img src="/logo.svg?v=2" alt="Aerie" className="h-full w-full object-contain" /></div>
        <div><p className="text-xs font-semibold uppercase tracking-wider text-brand-300">Private household invitation</p><h1 className="text-2xl font-bold text-white">Create your Aerie account</h1></div>
      </div>
      <p className="mt-4 text-sm muted">Choose your own username and password. This link expires {new Date(invite.expiresAt).toLocaleString()} and can be used only once.</p>
      {invite.role === 'admin' && <div role="note" className="mt-4 rounded-xl border border-accent-amber/25 bg-accent-amber/[0.07] p-3 text-sm text-amber-100"><Icon.Warning size={16} className="mr-2 inline" />This invitation grants administrator access.</div>}
      <div className="mt-6 grid gap-4 sm:grid-cols-2">
        <label className="block text-sm font-medium text-slate-300">Display name<input className="input mt-1.5" value={displayName} onChange={event => setDisplayName(event.target.value)} maxLength={120} autoComplete="name" required /></label>
        <label className="block text-sm font-medium text-slate-300">Username<input className="input mt-1.5" value={username} onChange={event => setUsername(event.target.value)} minLength={3} maxLength={64} pattern="[A-Za-z0-9][A-Za-z0-9._-]*" autoCapitalize="none" autoCorrect="off" autoComplete="username" required /></label>
        <label className="block text-sm font-medium text-slate-300">Password<input className="input mt-1.5" type="password" value={password} onChange={event => setPassword(event.target.value)} minLength={12} maxLength={1024} autoComplete="new-password" required /><span className="mt-1 block text-xs text-slate-500">At least 12 characters; a passphrase works well.</span></label>
        <label className="block text-sm font-medium text-slate-300">Confirm password<input className="input mt-1.5" type="password" value={confirm} onChange={event => setConfirm(event.target.value)} minLength={12} maxLength={1024} autoComplete="new-password" required /></label>
      </div>
      {error && <p role="alert" className="mt-4 text-sm text-accent-red">{error}</p>}
      <button className="btn-primary mt-6 w-full py-2.5" disabled={busy}>{busy ? <Spinner size={17} /> : <><Icon.Check size={17} /> Create account</>}</button>
      <p className="mt-4 text-center text-xs text-slate-600">Your password is sent only to this Aerie server and stored as a secure hash.</p>
    </form>
  </div>;
}
