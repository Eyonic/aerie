import React, { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import QRCode from 'qrcode';
import { api, setToken } from '../lib/api';
import { hasNativeDeviceIdentity, nativeIdentity, pairCurrentNativeDevice, type NativeIdentity } from '../lib/native-device';
import { toast, useAuth } from '../lib/store';
import { Icon } from '../lib/icons';
import { Badge, Modal, PageHeader, PageLoader } from '../components/ui';

function CapabilityCard({ enabled, to, icon, title, description }: {
  enabled: boolean;
  to: string;
  icon: React.ReactNode;
  title: string;
  description: string;
}) {
  if (enabled) return (
    <Link to={to} className="card p-4 hover:border-brand-500/30 transition">
      {icon}<p className="font-semibold text-white mt-3">{title}</p><p className="text-xs muted mt-1">{description}</p>
    </Link>
  );
  return (
    <div className="card p-4 opacity-60" aria-disabled="true">
      {icon}<div className="flex items-center gap-2 mt-3"><p className="font-semibold text-slate-300">{title}</p><Badge color="slate">Not enabled</Badge></div>
      <p className="text-xs muted mt-1">Ask an administrator to enable this feature for your account.</p>
    </div>
  );
}

export default function DeviceHub() {
  const { user } = useAuth();
  const filesEnabled = user?.features?.files !== false;
  const syncEnabled = user?.features?.sync !== false;
  const [loading, setLoading] = useState(true);
  const [online, setOnline] = useState<{ currentDeviceId: string; devices: any[] }>({ currentDeviceId: '', devices: [] });
  const [trusted, setTrusted] = useState<any[]>([]);
  const [identity, setIdentity] = useState<NativeIdentity | null>(null);
  const [drive, setDrive] = useState<{ items: any[]; mountUrl: string; username: string } | null>(null);
  const [pairing, setPairing] = useState<any>(null);
  const [pairQr, setPairQr] = useState('');
  const [pairOpen, setPairOpen] = useState(false);
  const [newCredential, setNewCredential] = useState<any>(null);
  const [drivePasswordCopied, setDrivePasswordCopied] = useState(false);
  const [busy, setBusy] = useState('');
  const acknowledgedCredentialId = useRef<string | null>(null);

  const load = async () => {
    const [fabric, trust, credentials, native] = await Promise.all([
      api.deviceFabric.devices().catch(() => ({ currentDeviceId: '', devices: [] })),
      api.deviceTrust.list().catch(() => []),
      filesEnabled ? api.drive.credentials().catch(() => null) : Promise.resolve(null),
      nativeIdentity().catch(() => null),
    ]);
    setOnline(fabric); setTrusted(trust); setDrive(credentials); setIdentity(native); setLoading(false);
  };
  useEffect(() => { load(); const timer = setInterval(load, 30_000); return () => clearInterval(timer); }, [filesEnabled]);

  useEffect(() => {
    const id = String(newCredential?.id || '');
    if (!id) return;
    let pageHiding = false;
    const revokeOnPageHide = () => {
      if (acknowledgedCredentialId.current === id) return;
      pageHiding = true;
      api.drive.revokeCredentialOnUnload(id);
    };
    const clearAfterHistoryRestore = (event: PageTransitionEvent) => {
      if (!event.persisted || !pageHiding) return;
      setNewCredential(current => String(current?.id || '') === id ? null : current);
      toast('Unsaved app password revoked', 'warning', 'Create a new app password when you are ready to save it.');
    };
    window.addEventListener('pagehide', revokeOnPageHide);
    window.addEventListener('pageshow', clearAfterHistoryRestore);
    return () => {
      window.removeEventListener('pagehide', revokeOnPageHide);
      window.removeEventListener('pageshow', clearAfterHistoryRestore);
      if (!pageHiding && acknowledgedCredentialId.current !== id) {
        void api.drive.revokeCredential(id).catch(() => undefined);
      }
    };
  }, [newCredential?.id]);

  useEffect(() => {
    if (!pairing?.qrPayload) { setPairQr(''); return; }
    QRCode.toDataURL(pairing.qrPayload, { width: 220, margin: 1, errorCorrectionLevel: 'M' }).then(setPairQr).catch(() => {});
    const timer = setInterval(async () => {
      try {
        const status = await api.deviceTrust.pairing(pairing.id);
        setPairing((old: any) => ({ ...old, ...status }));
        if (status.status === 'completed') { clearInterval(timer); toast('Device paired', 'success'); load(); }
      } catch { /* expires visibly */ }
    }, 2000);
    return () => clearInterval(timer);
  }, [pairing?.id]);

  const trustThisDevice = async () => {
    if (!identity) return;
    setBusy('self-pair');
    try {
      const created = await api.deviceTrust.createPairing({
        name: identity.name || (identity.type === 'android' ? 'Aerie Android' : 'Aerie Desktop'),
        type: identity.type || 'native',
        capabilities: (identity.capabilities || ['sync', 'handoff', 'secure-storage'])
          .filter(capability => syncEnabled || capability !== 'sync'),
      });
      const session = await pairCurrentNativeDevice(created.code, identity.name);
      setToken(session.token);
      toast('This device is now trusted', 'success');
      await load();
    } catch (error: any) { toast('Pairing failed', 'error', error?.message); }
    finally { setBusy(''); }
  };

  const pairAnother = async () => {
    setBusy('pair');
    try {
      const created = await api.deviceTrust.createPairing({
        name: 'New Aerie device', type: 'native', capabilities: syncEnabled ? ['sync', 'handoff', 'secure-storage'] : ['handoff', 'secure-storage'],
      });
      setPairing(created); setPairOpen(true);
    } catch (error: any) { toast('Could not start pairing', 'error', error?.message); }
    finally { setBusy(''); }
  };

  const createDrivePassword = async () => {
    if (!filesEnabled) return;
    setBusy('drive');
    try {
      const result = await api.drive.createCredential(`Aerie Drive ${new Date().toLocaleDateString()}`);
      acknowledgedCredentialId.current = null;
      setDrivePasswordCopied(false);
      setNewCredential(result);
      await load();
    } catch (error: any) { toast('Could not create Drive password', 'error', error?.message); }
    finally { setBusy(''); }
  };

  const closePairing = () => {
    const open = pairing;
    setPairOpen(false);
    setPairing(null);
    if (open?.id && open?.status !== 'completed') api.deviceTrust.cancelPairing(open.id).catch(() => {});
  };

  const copy = (value: string, label = 'Copied') => navigator.clipboard.writeText(value)
    .then(() => { toast(label, 'success'); return true; })
    .catch(() => { toast('Copy failed', 'error'); return false; });

  const acknowledgeDrivePassword = () => {
    const id = String(newCredential?.id || '');
    if (!id) return;
    acknowledgedCredentialId.current = id;
    setNewCredential(null);
    setDrivePasswordCopied(false);
  };

  if (loading) return <PageLoader />;
  const currentTrusted = !!identity?.deviceId && trusted.some(device => device.id === identity.deviceId && !device.revokedAt);
  const driveMountUrl = drive?.mountUrl ? new URL(drive.mountUrl, location.origin).toString().replace(/\/$/, '') : '';

  return (
    <div className="animate-fade-in">
      <PageHeader title="Devices & Continuity" subtitle="One trusted fabric for sync, native files, handoff and LAN transfers"
        icon={<Icon.Device size={22} />} actions={<button className="btn-primary" onClick={pairAnother} disabled={!!busy}><Icon.Plus size={16} /> Pair a device</button>} />

      <div className="grid sm:grid-cols-3 gap-3 mb-6">
        <CapabilityCard enabled={syncEnabled} to="/sync" icon={<Icon.Refresh className="text-brand-300" />}
          title="Sync Fabric" description="Journaled two-way folders and conflict history" />
        <CapabilityCard enabled={filesEnabled} to="/time-machine" icon={<Icon.Clock className="text-accent-cyan" />}
          title="Cloud Time Machine" description="Browse and restore immutable snapshots" />
        <div className="card p-4"><Icon.Wifi className="text-accent-green" /><p className="font-semibold text-white mt-3">Aerie Mesh</p><p className="text-xs muted mt-1">{online.devices.some(d => d.meshEndpoints?.length) ? 'LAN peers are available for direct transfer' : 'Waiting for a trusted LAN peer'}</p></div>
      </div>

      {hasNativeDeviceIdentity() && !currentTrusted && (
        <div className="card p-4 mb-6 flex items-center gap-4 border-brand-500/25">
          <div className="w-11 h-11 rounded-xl bg-brand-500/15 text-brand-300 grid place-items-center"><Icon.Shield size={22} /></div>
          <div className="min-w-0 flex-1"><p className="font-semibold text-white">Trust this native app</p><p className="text-sm muted">Bind it to an OS-keystore key for Continuity, Mesh and renewable background access.</p></div>
          <button className="btn-primary" onClick={trustThisDevice} disabled={busy === 'self-pair'}>{busy === 'self-pair' ? 'Pairing…' : 'Trust this device'}</button>
        </div>
      )}

      <section className="card p-5 mb-6">
        <div className="flex items-center justify-between mb-4"><div><h2 className="font-semibold text-white">Online now</h2><p className="text-xs muted">Activities can move between these devices immediately.</p></div><Badge color="green">{online.devices.length} online</Badge></div>
        <div className="divide-y divide-white/[0.06]">
          {online.devices.map(device => (
            <div key={device.id} className="py-3 flex items-center gap-3">
              <div className="w-9 h-9 rounded-lg bg-white/[0.05] grid place-items-center text-slate-300">{device.type === 'android' ? <Icon.Phone size={18} /> : <Icon.Desktop size={18} />}</div>
              <div className="min-w-0 flex-1"><p className="text-sm font-medium text-white">{device.name} {device.id === online.currentDeviceId && <span className="text-xs text-brand-300">(this device)</span>}</p><p className="text-xs muted truncate">{device.activity?.title || device.activity?.path || 'Aerie is open'}</p></div>
              {device.trusted && <Badge color="green">Trusted</Badge>}{device.meshEndpoints?.length > 0 && <Badge color="cyan">Mesh</Badge>}
            </div>
          ))}
          {!online.devices.length && <p className="text-sm muted py-6 text-center">No device presence yet.</p>}
        </div>
      </section>

      <section className="card p-5 mb-6">
        <div className="flex items-center justify-between mb-4"><div><h2 className="font-semibold text-white">Trusted devices</h2><p className="text-xs muted">Cryptographic identities can be revoked without changing your password.</p></div></div>
        <div className="divide-y divide-white/[0.06]">
          {trusted.map(device => <div key={device.id} className="py-3 flex items-center gap-3"><Icon.Shield size={18} className="text-accent-green" /><div className="flex-1 min-w-0"><p className="text-sm text-white">{device.name}</p><p className="text-[11px] font-mono muted truncate">{device.fingerprint}</p></div><button className="btn-secondary !py-1.5" onClick={() => api.deviceTrust.revoke(device.id).then(load)}>Revoke</button></div>)}
          {!trusted.length && <p className="text-sm muted py-6 text-center">No cryptographically paired devices yet.</p>}
        </div>
      </section>

      {filesEnabled ? <section className="card p-5">
        <div className="flex flex-wrap items-start justify-between gap-3 mb-4"><div><h2 className="font-semibold text-white">Aerie Drive</h2><p className="text-xs muted">Mount your private files in Windows, macOS or Linux using WebDAV.</p></div><button className="btn-primary" onClick={createDrivePassword} disabled={busy === 'drive'}>Create app password</button></div>
        {drive && <div className="grid sm:grid-cols-2 gap-3 bg-ink-900/50 rounded-xl p-4 mb-4"><div><p className="text-[11px] uppercase tracking-wide muted">Server</p><button className="text-sm text-brand-300 break-all text-left" onClick={() => copy(driveMountUrl)}>{driveMountUrl}</button></div><div><p className="text-[11px] uppercase tracking-wide muted">Username</p><button className="text-sm text-white" onClick={() => copy(drive.username)}>{drive.username}</button></div></div>}
        <div className="divide-y divide-white/[0.06]">{drive?.items.map(item => <div key={item.id} className="py-3 flex items-center gap-3"><Icon.Cloud size={17} /><div className="flex-1"><p className="text-sm text-white">{item.name}</p><p className="text-xs muted">Last used {item.lastUsedAt ? new Date(item.lastUsedAt).toLocaleString() : 'never'}</p></div><button className="btn-secondary !py-1.5" onClick={() => api.drive.revokeCredential(item.id).then(load)}>Revoke</button></div>)}</div>
      </section> : <section className="card p-5 opacity-60" aria-disabled="true">
        <div className="flex items-center gap-2"><h2 className="font-semibold text-slate-300">Aerie Drive</h2><Badge color="slate">Not enabled</Badge></div>
        <p className="text-xs muted mt-1">Aerie Drive requires Files access. Ask an administrator to enable it for your account.</p>
      </section>}

      <Modal open={pairOpen} onClose={closePairing} title="Pair another device" size="sm">
        <div className="text-center">{pairQr && <img src={pairQr} alt="Aerie device pairing QR code" className="w-52 h-52 bg-white p-2 rounded-xl mx-auto" />}<p className="text-2xl font-mono tracking-widest text-white mt-4">{pairing?.code}</p><p className="text-sm muted mt-2">Scan with Aerie or enter this code on the other device. It expires in five minutes.</p><Badge color={pairing?.status === 'completed' ? 'green' : 'amber'}>{pairing?.status || 'waiting'}</Badge></div>
      </Modal>

      <Modal open={!!newCredential} onClose={() => {}} dismissible={false} title="Aerie Drive app password" size="sm"
        footer={<button className="btn-primary" onClick={acknowledgeDrivePassword}>I saved this password</button>}>
        <p className="text-sm text-accent-amber mb-3">This password is shown once. Save it in your operating system's credential manager before continuing. If this page is abandoned first, Aerie revokes the credential.</p>
        <button className="w-full text-left bg-ink-950 rounded-xl p-3 font-mono text-sm text-white break-all" onClick={() => copy(newCredential?.password || '', 'Password copied')}>{newCredential?.password}</button>
        <button className="btn-secondary w-full mt-3" onClick={() => copy(newCredential?.password || '', 'Password copied').then(setDrivePasswordCopied)}>
          {drivePasswordCopied ? <><Icon.Check size={15} /> Copied</> : <><Icon.Copy size={15} /> Copy password</>}
        </button>
      </Modal>
    </div>
  );
}
