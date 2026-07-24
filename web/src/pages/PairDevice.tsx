import React, { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { pairCurrentNativeDevice, hasNativeDeviceIdentity } from '../lib/native-device';
import { setToken } from '../lib/api';
import { Icon } from '../lib/icons';
import { useAuth } from '../lib/store';

export default function PairDevice() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const [code, setCode] = useState((params.get('code') || params.get('pairing') || '').toUpperCase());
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const available = hasNativeDeviceIdentity();

  const pair = async () => {
    setBusy(true); setError('');
    try {
      const session = await pairCurrentNativeDevice(code);
      setToken(session.token);
      if (session.user) useAuth.getState().setUser(session.user);
      navigate('/devices', { replace: true });
    } catch (e: any) { setError(e?.message || 'Pairing failed'); }
    finally { setBusy(false); }
  };

  useEffect(() => { if (available && code.replace(/[^A-Z0-9]/g, '').length === 8) pair(); }, []);

  return (
    <div className="min-h-full grid place-items-center bg-ink-950 p-5">
      <div className="card w-full max-w-md p-6 text-center">
        <div className="w-14 h-14 rounded-2xl bg-brand-500/15 text-brand-300 grid place-items-center mx-auto"><Icon.Shield size={28} /></div>
        <h1 className="text-xl font-bold text-white mt-4">Pair this device</h1>
        <p className="text-sm muted mt-1">Aerie will bind this installation to a key held by your operating system.</p>
        {!available ? <div className="mt-5 rounded-xl bg-accent-amber/10 text-amber-200 p-3 text-sm">Open this link in the Aerie Android or desktop app. Ordinary browsers cannot hold an Aerie device identity.</div> : <>
          <label htmlFor="pairing-code" className="block text-sm font-medium text-slate-300 text-left mt-5 mb-1.5">Pairing code</label>
          <input id="pairing-code" name="pairing-code" value={code} onChange={e => setCode(e.target.value.toUpperCase())} placeholder="ABCD-EFGH"
            className="input text-center text-xl font-mono tracking-widest" autoCapitalize="characters" autoCorrect="off" autoComplete="one-time-code" />
          {error && <p role="alert" className="text-sm text-accent-red mt-3">{error}</p>}
          <button className="btn-primary w-full mt-4" onClick={pair} disabled={busy || code.replace(/[^A-Z0-9]/g, '').length !== 8}>{busy ? 'Pairing…' : 'Pair securely'}</button>
        </>}
      </div>
    </div>
  );
}
