import React, { useState, useEffect, useMemo, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import QRCode from 'qrcode';
import { api } from '../lib/api';
import { Icon } from '../lib/icons';
import { cx, formatRelative, initials, copyText } from '../lib/utils';
import { useAuth, toast } from '../lib/store';
import { PageLoader, EmptyState, PageHeader, ConfirmModal, Modal, Spinner, Badge } from '../components/ui';
import type { User, Device, Notification, AiMode } from '../lib/model';

type TabKey = 'profile' | 'security' | 'devices' | 'ai' | 'notifications' | 'preferences';

// Reasonable, forgiving email check (rejects clearly-invalid input, not RFC-exhaustive).
const isValidEmail = (v: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);

const TABS: { key: TabKey; label: string; icon: React.ReactNode; hint: string }[] = [
  { key: 'profile', label: 'Profile', icon: <Icon.Settings size={17} />, hint: 'Name, email & avatar' },
  { key: 'security', label: 'Security', icon: <Icon.Shield size={17} />, hint: 'Password' },
  { key: 'devices', label: 'Devices', icon: <Icon.Device size={17} />, hint: 'Signed-in devices' },
  { key: 'ai', label: 'AI & Privacy', icon: <Icon.Robot size={17} />, hint: 'Data & AI controls' },
  { key: 'notifications', label: 'Notifications', icon: <Icon.Bell size={17} />, hint: 'Alerts & activity' },
  { key: 'preferences', label: 'Preferences', icon: <Icon.Bolt size={17} />, hint: 'Views & appearance' },
];

const AVATAR_COLORS = ['#6366f1', '#ec4899', '#22d3ee', '#f59e0b', '#10b981', '#a855f7', '#ef4444', '#3b82f6', '#8b5cf6', '#14b8a6', '#f97316', '#e11d48'];

function Section({ title, subtitle, children, footer }: { title: string; subtitle?: string; children: React.ReactNode; footer?: React.ReactNode }) {
  return (
    <div className="card overflow-hidden animate-fade-in">
      <div className="px-6 pt-5 pb-4 border-b border-white/[0.05]">
        <h2 className="text-base font-semibold text-white">{title}</h2>
        {subtitle && <p className="text-sm muted mt-0.5">{subtitle}</p>}
      </div>
      <div className="p-6">{children}</div>
      {footer && <div className="px-6 py-4 border-t border-white/[0.05] bg-white/[0.015] flex items-center justify-end gap-3">{footer}</div>}
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="block text-sm font-medium text-slate-300 mb-1.5">{label}</span>
      {children}
      {hint && <span className="block text-xs text-slate-500 mt-1.5">{hint}</span>}
    </label>
  );
}

function Avatar({ name, color, size = 72, src }: { name: string; color: string; size?: number; src?: string | null }) {
  if (src) {
    return <img src={src} alt={name} className="rounded-2xl object-cover shadow-glow shrink-0 bg-ink-800"
      style={{ width: size, height: size }} />;
  }
  return (
    <div className="rounded-2xl grid place-items-center font-bold text-white shadow-glow shrink-0"
      style={{ width: size, height: size, background: `linear-gradient(135deg, ${color}, ${color}bb)`, fontSize: size * 0.36 }}>
      {initials(name || '?')}
    </div>
  );
}

// ---------------- Profile ----------------
function ProfileTab({ user }: { user: User }) {
  const [displayName, setDisplayName] = useState(user.displayName);
  const [email, setEmail] = useState(user.email || '');
  const [color, setColor] = useState(user.avatarColor || '#6366f1');
  const [saving, setSaving] = useState(false);
  const [uploadingPic, setUploadingPic] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const setUser = useAuth.getState().setUser;

  const pickPhoto = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // allow re-picking the same file
    if (!file) return;
    if (!file.type.startsWith('image/')) { toast('Choose an image file', 'warning'); return; }
    if (file.size > 12 * 1024 * 1024) { toast('Image is too large', 'warning', 'Max 12 MB.'); return; }
    setUploadingPic(true);
    try {
      setUser(await api.settings.avatar.upload(file));
      toast('Profile picture updated', 'success');
    } catch (e: any) {
      toast('Could not upload picture', 'error', e?.message === 'invalid_image' ? 'That file is not a valid image.' : e?.message);
    } finally { setUploadingPic(false); }
  };
  const removePhoto = async () => {
    setUploadingPic(true);
    try { setUser(await api.settings.avatar.remove()); toast('Profile picture removed', 'info'); }
    catch (e: any) { toast('Could not remove picture', 'error', e?.message); }
    finally { setUploadingPic(false); }
  };

  const dirty = displayName !== user.displayName || (email || '') !== (user.email || '') || color !== user.avatarColor;
  const emailInvalid = !!email.trim() && !isValidEmail(email.trim());

  const save = async () => {
    if (!displayName.trim()) { toast('Display name is required', 'warning'); return; }
    if (emailInvalid) { toast('Enter a valid email address', 'warning', 'For example: you@example.com'); return; }
    setSaving(true);
    try {
      const updated = await api.settings.profile({ displayName: displayName.trim(), email: email.trim() || null, avatarColor: color });
      setUser(updated);
      toast('Profile updated', 'success');
    } catch (e: any) {
      toast('Could not save profile', 'error', e?.message);
    } finally { setSaving(false); }
  };

  return (
    <Section title="Profile" subtitle="How you appear across Aerie."
      footer={<>
        <button className="btn-ghost" disabled={!dirty || saving} onClick={() => { setDisplayName(user.displayName); setEmail(user.email || ''); setColor(user.avatarColor); }}>Reset</button>
        <button className="btn-primary" disabled={!dirty || saving || emailInvalid} onClick={save}>{saving ? <Spinner size={16} /> : 'Save changes'}</button>
      </>}>
      <div className="flex flex-col sm:flex-row gap-6">
        <div className="flex sm:flex-col items-center gap-4 sm:w-40">
          <div className="relative group shrink-0">
            <Avatar name={displayName} color={color} size={84} src={user.avatarUrl ? api.url(user.avatarUrl) : undefined} />
            <button type="button" onClick={() => fileRef.current?.click()} disabled={uploadingPic}
              aria-label="Change profile picture"
              className="absolute inset-0 rounded-2xl bg-black/55 opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity grid place-items-center text-white">
              {uploadingPic ? <Spinner size={20} /> : <Icon.Upload size={22} />}
            </button>
          </div>
          <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={pickPhoto} />
          <div className="text-center hidden sm:block">
            <p className="text-sm font-medium text-white truncate max-w-[9rem]">{displayName || 'Unnamed'}</p>
            <p className="text-xs muted">@{user.username}</p>
            <div className="flex items-center justify-center gap-2 mt-2">
              <button type="button" className="text-xs text-brand-400 hover:underline disabled:opacity-50" disabled={uploadingPic} onClick={() => fileRef.current?.click()}>
                {user.avatarUrl ? 'Change' : 'Upload photo'}
              </button>
              {user.avatarUrl && <button type="button" className="text-xs text-slate-500 hover:text-accent-red disabled:opacity-50" disabled={uploadingPic} onClick={removePhoto}>Remove</button>}
            </div>
          </div>
        </div>
        <div className="flex-1 space-y-5">
          <Field label="Display name">
            <input className="input" value={displayName} onChange={e => setDisplayName(e.target.value)} placeholder="Your name" maxLength={60} />
          </Field>
          <Field label="Email" hint={emailInvalid ? undefined : 'Used for notifications and account recovery.'}>
            <input className={cx('input', emailInvalid && 'ring-1 ring-accent-red')} type="email" value={email}
              onChange={e => setEmail(e.target.value)} placeholder="you@example.com"
              aria-invalid={emailInvalid} />
            {emailInvalid && <span className="block text-xs text-accent-red mt-1.5 flex items-center gap-1"><Icon.Warning size={12} /> That doesn't look like a valid email address.</span>}
          </Field>
          <Field label="Avatar color" hint="Pick an accent for your avatar and initials.">
            <div className="flex flex-wrap gap-2.5 mt-1">
              {AVATAR_COLORS.map(c => (
                <button key={c} onClick={() => setColor(c)} aria-label={`Select color ${c}`}
                  className={cx('w-8 h-8 rounded-full transition-transform hover:scale-110 grid place-items-center ring-offset-2 ring-offset-ink-900',
                    color === c ? 'ring-2 ring-white scale-110' : 'ring-0')}
                  style={{ background: c }}>
                  {color === c && <Icon.Check size={15} className="text-white drop-shadow" />}
                </button>
              ))}
            </div>
          </Field>
        </div>
      </div>
    </Section>
  );
}

// ---------------- Security ----------------
function SecurityTab() {
  const [cur, setCur] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [saving, setSaving] = useState(false);

  const strength = useMemo(() => {
    let s = 0;
    if (next.length >= 8) s++;
    if (/[A-Z]/.test(next) && /[a-z]/.test(next)) s++;
    if (/\d/.test(next)) s++;
    if (/[^A-Za-z0-9]/.test(next)) s++;
    return s;
  }, [next]);
  const strengthLabel = ['Too short', 'Weak', 'Fair', 'Good', 'Strong'][next ? strength : 0];
  const strengthColor = ['#64748b', '#ef4444', '#f59e0b', '#3b82f6', '#10b981'][next ? strength : 0];

  const save = async () => {
    if (!cur) { toast('Enter your current password', 'warning'); return; }
    if (next.length < 8) { toast('New password must be at least 8 characters', 'warning'); return; }
    if (next !== confirm) { toast('Passwords do not match', 'warning'); return; }
    if (next === cur) { toast('New password must differ from the current one', 'warning'); return; }
    setSaving(true);
    try {
      await api.settings.password(cur, next);
      toast('Password changed', 'success');
      setCur(''); setNext(''); setConfirm('');
    } catch (e: any) {
      // Map raw API error codes to human-friendly messages — never surface the code.
      const friendly: Record<string, string> = {
        wrong_password: 'Your current password is incorrect.',
        weak_password: 'That password is too weak. Try a longer one.',
        unauthorized: 'Your session expired. Please sign in again.',
      };
      toast('Could not change password', 'error', friendly[e?.message] || 'Something went wrong. Please try again.');
    } finally { setSaving(false); }
  };

  return (
    <div className="space-y-6">
      <Section title="Change password" subtitle="Use a strong, unique password you don't reuse elsewhere."
        footer={<button className="btn-primary" disabled={saving || !cur || !next || !confirm} onClick={save}>{saving ? <Spinner size={16} /> : 'Update password'}</button>}>
        <div className="max-w-md space-y-5">
          <Field label="Current password">
            <input className="input" type="password" autoComplete="current-password" value={cur} onChange={e => setCur(e.target.value)} />
          </Field>
          <Field label="New password">
            <input className="input" type="password" autoComplete="new-password" value={next} onChange={e => setNext(e.target.value)} />
            {next && (
              <div className="mt-2">
                <div className="h-1.5 rounded-full bg-white/[0.06] overflow-hidden flex gap-1">
                  {[0, 1, 2, 3].map(i => (
                    <div key={i} className="flex-1 rounded-full transition-colors" style={{ background: i < strength ? strengthColor : 'transparent' }} />
                  ))}
                </div>
                <p className="text-xs mt-1.5" style={{ color: strengthColor }}>{strengthLabel}</p>
              </div>
            )}
          </Field>
          <Field label="Confirm new password" hint="Re-enter the new password to confirm.">
            <input className={cx('input', confirm && confirm !== next && 'ring-1 ring-accent-red')} type="password" autoComplete="new-password" value={confirm} onChange={e => setConfirm(e.target.value)} />
          </Field>
        </div>
      </Section>
      <TwoFactorSection />
    </div>
  );
}

// ---------------- Two-factor authentication ----------------
function TwoFactorSection() {
  const [status, setStatus] = useState<{ enabled: boolean } | null>(null);

  // Enable / setup flow
  const [setupOpen, setSetupOpen] = useState(false);
  const [setupLoading, setSetupLoading] = useState(false);
  const [secret, setSecret] = useState('');
  const [qrDataUrl, setQrDataUrl] = useState('');
  const [code, setCode] = useState('');
  const [codeError, setCodeError] = useState('');
  const [verifying, setVerifying] = useState(false);
  const [copied, setCopied] = useState(false);

  // Disable flow
  const [disableOpen, setDisableOpen] = useState(false);
  const [password, setPassword] = useState('');
  const [disabling, setDisabling] = useState(false);

  const load = async () => {
    try { setStatus(await api.settings.twoFa.status()); }
    catch { setStatus({ enabled: false }); }
  };
  useEffect(() => { load(); }, []);

  const startSetup = async () => {
    setCode(''); setCodeError(''); setSecret(''); setQrDataUrl(''); setCopied(false);
    setSetupOpen(true); setSetupLoading(true);
    try {
      const { secret, otpauth } = await api.settings.twoFa.setup();
      setSecret(secret);
      try { setQrDataUrl(await QRCode.toDataURL(otpauth, { margin: 1, width: 200 })); }
      catch { setQrDataUrl(''); }
    } catch (e: any) {
      toast('Could not start 2FA setup', 'error', e?.message);
      setSetupOpen(false);
    } finally { setSetupLoading(false); }
  };

  const verify = async () => {
    if (code.length !== 6) { setCodeError('Enter the 6-digit code from your app.'); return; }
    setVerifying(true); setCodeError('');
    try {
      await api.settings.twoFa.enable(code);
      toast('Two-factor authentication enabled', 'success', 'Your account is now protected.');
      setSetupOpen(false);
      await load();
    } catch (e: any) {
      if (e?.message === 'invalid_code') setCodeError('That code is incorrect. Check your app and try again.');
      else { setCodeError('Could not verify the code. Try again.'); toast('Could not enable 2FA', 'error', e?.message); }
    } finally { setVerifying(false); }
  };

  const disable = async () => {
    if (!password) { toast('Enter your account password', 'warning'); return; }
    setDisabling(true);
    try {
      await api.settings.twoFa.disable(password);
      toast('Two-factor authentication disabled', 'success');
      setDisableOpen(false); setPassword('');
      await load();
    } catch (e: any) {
      toast('Could not disable 2FA', 'error', e?.message || 'Check your password and try again.');
    } finally { setDisabling(false); }
  };

  const copySecret = async () => {
    if (await copyText(secret)) {
      setCopied(true); setTimeout(() => setCopied(false), 1600);
    } else { toast('Could not copy', 'error', 'Copy the key manually.'); }
  };

  return (
    <Section title="Two-factor authentication" subtitle="Add an extra layer of security using an authenticator app.">
      {status === null ? (
        <div className="grid place-items-center py-4 text-brand-400"><Spinner size={22} /></div>
      ) : (
        <div className="flex flex-col sm:flex-row sm:items-center gap-4">
          <div className={cx('w-11 h-11 rounded-xl grid place-items-center shrink-0', status.enabled ? 'bg-accent-green/15 text-accent-green' : 'bg-white/[0.06] text-slate-400')}>
            <Icon.Shield size={20} />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              <p className="text-sm font-medium text-white">Authenticator app</p>
              {status.enabled
                ? <Badge color="green"><Icon.Check size={11} /> On</Badge>
                : <Badge color="slate">Off</Badge>}
            </div>
            <p className="text-xs muted mt-0.5">
              {status.enabled
                ? 'Sign-in requires a time-based code from your authenticator app.'
                : 'Sign-in currently only requires your password.'}
            </p>
          </div>
          {status.enabled
            ? <button className="btn-danger shrink-0" onClick={() => { setPassword(''); setDisableOpen(true); }}>Disable 2FA</button>
            : <button className="btn-primary shrink-0" onClick={startSetup}>Enable 2FA</button>}
        </div>
      )}

      {/* Enable / setup */}
      <Modal open={setupOpen} onClose={() => !verifying && setSetupOpen(false)} title="Enable two-factor authentication" size="sm"
        footer={<>
          <button className="btn-secondary" disabled={verifying} onClick={() => setSetupOpen(false)}>Cancel</button>
          <button className="btn-primary" disabled={verifying || setupLoading || code.length !== 6} onClick={verify}>{verifying ? <Spinner size={16} /> : 'Verify & enable'}</button>
        </>}>
        {setupLoading ? (
          <div className="grid place-items-center py-10 text-brand-400"><Spinner size={26} /></div>
        ) : (
          <div className="space-y-4">
            <p className="text-sm muted">Scan this code with an authenticator app (Google Authenticator, 1Password, Authy), then enter the 6-digit code to confirm.</p>
            <div className="flex flex-col items-center gap-2">
              {qrDataUrl ? (
                <img src={qrDataUrl} alt="Aerie 2FA QR code" width={200} height={200} className="rounded-xl bg-white p-2 max-w-full" />
              ) : (
                <div className="w-[200px] max-w-full aspect-square rounded-xl bg-white/[0.04] border border-white/[0.06] grid place-items-center text-center px-4">
                  <p className="text-xs muted">QR unavailable — add the key below to your app manually.</p>
                </div>
              )}
              <p className="text-[11px] text-slate-500">Aerie · authenticator</p>
            </div>
            <div>
              <span className="block text-xs font-medium text-slate-400 mb-1.5">Or enter this key manually</span>
              <div className="flex items-center gap-2">
                <code className="flex-1 min-w-0 font-mono text-sm text-slate-200 bg-ink-800 rounded-lg px-3 py-2 break-all select-all">{secret}</code>
                <button className="btn-secondary !px-3 shrink-0" onClick={copySecret} aria-label="Copy secret key">
                  {copied ? <Icon.Check size={15} /> : <Icon.Copy size={15} />}
                </button>
              </div>
            </div>
            <div>
              <span className="block text-xs font-medium text-slate-400 mb-1.5">6-digit verification code</span>
              <input className={cx('input text-center text-2xl font-mono tracking-[0.4em]', codeError && 'ring-1 ring-accent-red')}
                inputMode="numeric" autoComplete="one-time-code" maxLength={6} placeholder="000000"
                value={code}
                onChange={e => { setCode(e.target.value.replace(/\D/g, '').slice(0, 6)); setCodeError(''); }}
                onKeyDown={e => { if (e.key === 'Enter' && code.length === 6) verify(); }} />
              {codeError && <p className="text-xs text-accent-red mt-1.5 flex items-center gap-1"><Icon.Warning size={12} /> {codeError}</p>}
            </div>
          </div>
        )}
      </Modal>

      {/* Disable */}
      <Modal open={disableOpen} onClose={() => !disabling && setDisableOpen(false)} title="Disable two-factor authentication" size="sm"
        footer={<>
          <button className="btn-secondary" disabled={disabling} onClick={() => setDisableOpen(false)}>Cancel</button>
          <button className="btn-danger" disabled={disabling || !password} onClick={disable}>{disabling ? <Spinner size={16} /> : 'Disable 2FA'}</button>
        </>}>
        <div className="space-y-4">
          <p className="text-sm muted">Turning off two-factor authentication makes your account less secure. Enter your account password to confirm.</p>
          <Field label="Account password">
            <input className="input" type="password" autoComplete="current-password" value={password}
              onChange={e => setPassword(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && password) disable(); }} />
          </Field>
        </div>
      </Modal>
    </Section>
  );
}

// ---------------- Devices ----------------
// Pick an icon from the explicit device type OR, when the type is generic
// (heartbeats register every browser as 'web'), from the platform/name string
// so a phone, tablet and laptop don't all show the same glyph.
function deviceKind(d: Pick<Device, 'type' | 'name'>): 'phone' | 'tablet' | 'desktop' | 'web' {
  if (d.type === 'phone' || d.type === 'tablet' || d.type === 'desktop') return d.type;
  const s = `${d.name || ''}`.toLowerCase();
  if (/\b(ipad|tablet|kindle|sm-t|tab\b)/.test(s)) return 'tablet';
  if (/\b(iphone|ipod|android|pixel|galaxy|oneplus|xiaomi|huawei|phone|mobile)/.test(s)) return 'phone';
  if (/\b(mac|macintel|imac|macbook|win32|win64|windows|linux|x11|x86|cros|chromebook|ubuntu|desktop)/.test(s)) return 'desktop';
  return 'web';
}

function DeviceIcon({ device }: { device: Pick<Device, 'type' | 'name'> }) {
  const kind = deviceKind(device);
  if (kind === 'phone') return <Icon.Phone size={20} />;
  if (kind === 'tablet') return <Icon.Device size={20} />;
  if (kind === 'desktop') return <Icon.Desktop size={20} />;
  return <Icon.Monitor size={20} />;
}

function DevicesTab() {
  const [devices, setDevices] = useState<Device[] | null>(null);
  const [error, setError] = useState(false);
  const [revoking, setRevoking] = useState<Device | null>(null);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    setError(false);
    try { setDevices(await api.devices.list()); }
    catch { setDevices([]); setError(true); }
  };
  useEffect(() => { load(); }, []);

  const revoke = async () => {
    if (!revoking) return;
    setBusy(true);
    try {
      await api.devices.revoke(revoking.id);
      setDevices(d => (d || []).filter(x => x.id !== revoking.id));
      toast('Device signed out', 'success', revoking.name);
    } catch (e: any) {
      toast('Could not revoke device', 'error', e?.message);
    } finally { setBusy(false); setRevoking(null); }
  };

  if (devices === null) return <PageLoader />;

  return (
    <Section title="Devices" subtitle="Everything currently signed in to your account.">
      {devices.length === 0 ? (
        <EmptyState icon={<Icon.Device size={28} />} title={error ? 'Devices unavailable' : 'No devices'}
          subtitle={error ? 'Device management is not configured on this server.' : 'Sign in from a phone or desktop to see it here.'} />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {devices.map(d => (
            <div key={d.id} className="card card-hover !rounded-xl p-4 flex items-center gap-4">
              <div className="w-11 h-11 rounded-xl bg-brand-500/15 text-brand-300 grid place-items-center shrink-0">
                <DeviceIcon device={d} />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <p className="text-sm font-medium text-white truncate">{d.name}</p>
                  {d.trusted && <Badge color="green">Trusted</Badge>}
                </div>
                <p className="text-xs muted mt-0.5 flex items-center gap-1.5">
                  <Icon.Clock size={12} /> {formatRelative(d.lastSeen)}
                  {d.backupStatus && <span className="text-slate-600">· backup {d.backupStatus}</span>}
                </p>
              </div>
              <button className="btn-ghost !px-3 !text-accent-red hover:!bg-accent-red/10 shrink-0" onClick={() => setRevoking(d)}>
                <Icon.Logout size={15} />
                <span className="hidden sm:inline">Sign out</span>
              </button>
            </div>
          ))}
        </div>
      )}
      <ConfirmModal open={!!revoking} onClose={() => !busy && setRevoking(null)} onConfirm={revoke} danger
        title="Sign out device" confirmLabel={busy ? 'Revoking…' : 'Sign out'}
        message={`"${revoking?.name}" will be signed out immediately and must re-authenticate to access your cloud.`} />
    </Section>
  );
}

// ---------------- AI & Privacy ----------------
const AI_MODES: { key: AiMode; label: string; desc: string; icon: React.ReactNode; color: string }[] = [
  { key: 'local_only', label: 'Local-only', color: '#10b981', icon: <Icon.Cpu size={18} />, desc: 'AI runs entirely on your own hardware. Your data never leaves the server — private, but limited to installed models.' },
  { key: 'ask_before_send', label: 'Ask before sending', color: '#f59e0b', icon: <Icon.Shield size={18} />, desc: 'Prefer local models, but prompt you for permission before any request is sent to an external provider.' },
  { key: 'external_allowed', label: 'External allowed', color: '#6366f1', icon: <Icon.Cloud size={18} />, desc: 'Automatically use external AI providers when helpful. Best quality, but selected content may leave your server.' },
  { key: 'disabled', label: 'Disabled', color: '#64748b', icon: <Icon.Close size={18} />, desc: 'Turn off all AI features across Aerie. No prompts, suggestions, or generation.' },
];

function AiTab({ user }: { user: User }) {
  const [mode, setMode] = useState<AiMode>(user.aiMode);
  const [saving, setSaving] = useState(false);
  const setUser = useAuth.getState().setUser;

  const pick = async (m: AiMode) => {
    if (m === mode || saving) return;
    const prev = mode;
    setMode(m); setSaving(true);
    try {
      const updated = await api.settings.profile({ aiMode: m });
      setUser(updated);
      toast('AI privacy mode updated', 'success', AI_MODES.find(x => x.key === m)?.label);
    } catch (e: any) {
      setMode(prev);
      toast('Could not update AI mode', 'error', e?.message);
    } finally { setSaving(false); }
  };

  return (
    <Section title="AI & Privacy" subtitle="Control if and how your data is used by AI features.">
      <div className="grid gap-3 sm:grid-cols-2">
        {AI_MODES.map(m => {
          const active = mode === m.key;
          return (
            <button key={m.key} onClick={() => pick(m.key)} disabled={saving}
              className={cx('text-left card !rounded-xl p-4 border transition-all',
                active ? 'border-brand-500 bg-brand-500/[0.06] shadow-glow' : 'border-white/[0.05] card-hover')}>
              <div className="flex items-start gap-3">
                <div className="w-9 h-9 rounded-lg grid place-items-center shrink-0" style={{ background: `${m.color}22`, color: m.color }}>{m.icon}</div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm font-semibold text-white">{m.label}</span>
                    <span className={cx('w-4 h-4 rounded-full border grid place-items-center shrink-0', active ? 'border-brand-400 bg-brand-500' : 'border-slate-600')}>
                      {active && <span className="w-1.5 h-1.5 rounded-full bg-white" />}
                    </span>
                  </div>
                  <p className="text-xs muted mt-1 leading-relaxed">{m.desc}</p>
                </div>
              </div>
            </button>
          );
        })}
      </div>
      <p className="text-xs text-slate-500 mt-4 flex items-center gap-1.5"><Icon.Info size={13} /> Changes apply immediately across all AI features.</p>
    </Section>
  );
}

// ---------------- Notifications ----------------
const LEVEL_STYLE: Record<Notification['level'], { color: string; icon: React.ReactNode }> = {
  info: { color: '#3b82f6', icon: <Icon.Info size={15} /> },
  success: { color: '#10b981', icon: <Icon.Check size={15} /> },
  warning: { color: '#f59e0b', icon: <Icon.Warning size={15} /> },
  error: { color: '#ef4444', icon: <Icon.Warning size={15} /> },
};

function NotificationsTab() {
  const [items, setItems] = useState<Notification[] | null>(null);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    try { setItems(await api.notifications.list()); }
    catch { setItems([]); }
  };
  useEffect(() => { load(); }, []);

  const markAll = async () => {
    setBusy(true);
    try {
      await api.notifications.read();
      setItems(n => (n || []).map(x => ({ ...x, read: true })));
      toast('All notifications marked read', 'success');
    } catch (e: any) {
      toast('Could not update notifications', 'error', e?.message);
    } finally { setBusy(false); }
  };

  if (items === null) return <PageLoader />;
  const unread = items.filter(n => !n.read).length;

  return (
    <Section title="Notifications" subtitle={unread ? `${unread} unread` : 'You are all caught up.'}
      footer={items.length > 0 ? <button className="btn-secondary" disabled={busy || unread === 0} onClick={markAll}>{busy ? <Spinner size={16} /> : <><Icon.Check size={15} /> Mark all read</>}</button> : undefined}>
      {items.length === 0 ? (
        <EmptyState icon={<Icon.Bell size={28} />} title="No notifications" subtitle="Alerts about backups, uploads and activity will appear here." />
      ) : (
        <div className="space-y-2 -my-1">
          {items.map(n => {
            const s = LEVEL_STYLE[n.level];
            return (
              <div key={n.id} className={cx('flex items-start gap-3 rounded-xl p-3.5 transition-colors', n.read ? 'bg-transparent' : 'bg-brand-500/[0.05]')}>
                <div className="w-8 h-8 rounded-lg grid place-items-center shrink-0 mt-0.5" style={{ background: `${s.color}22`, color: s.color }}>{s.icon}</div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <p className={cx('text-sm truncate', n.read ? 'text-slate-300' : 'text-white font-medium')}>{n.title}</p>
                    {!n.read && <span className="w-2 h-2 rounded-full bg-brand-400 shrink-0" />}
                  </div>
                  {n.body && <p className="text-xs muted mt-0.5 leading-relaxed">{n.body}</p>}
                  <p className="text-[11px] text-slate-600 mt-1">{formatRelative(n.ts)}</p>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </Section>
  );
}

// ---------------- Preferences ----------------
// Only controls that produce a real, observable effect live here. Both are applied
// app-wide by toggling classes on <html> (persist across SPA navigation) backed by an
// injected stylesheet, and are cached to localStorage in addition to the server.
interface Prefs {
  reduceMotion: boolean;
  compact: boolean;
}
const DEFAULT_PREFS: Prefs = { reduceMotion: false, compact: false };
const PREFS_LS_KEY = 'cloudbox:prefs'; // legacy storage key — keep (renaming resets saved prefs on installed clients)
const PREFS_STYLE_ID = 'cloudbox-prefs-style';

function ensurePrefStyle() {
  if (typeof document === 'undefined' || document.getElementById(PREFS_STYLE_ID)) return;
  const el = document.createElement('style');
  el.id = PREFS_STYLE_ID;
  el.textContent = [
    'html.cb-reduce-motion *, html.cb-reduce-motion *::before, html.cb-reduce-motion *::after {',
    '  animation-duration: 0.001ms !important; animation-delay: 0ms !important;',
    '  animation-iteration-count: 1 !important; transition-duration: 0.001ms !important;',
    '  transition-delay: 0ms !important; scroll-behavior: auto !important;',
    '}',
    'html.cb-compact { font-size: 14px; }',
  ].join('\n');
  document.head.appendChild(el);
}

function applyAppearance(p: Partial<Prefs>) {
  if (typeof document === 'undefined') return;
  ensurePrefStyle();
  const root = document.documentElement;
  root.classList.toggle('cb-reduce-motion', !!p.reduceMotion);
  root.classList.toggle('cb-compact', !!p.compact);
}

function cacheAppearance(p: Prefs) {
  try { localStorage.setItem(PREFS_LS_KEY, JSON.stringify({ reduceMotion: p.reduceMotion, compact: p.compact })); } catch { /* */ }
}

// Re-apply cached appearance as soon as this chunk loads so the effect survives reloads.
try { applyAppearance(JSON.parse(localStorage.getItem(PREFS_LS_KEY) || '{}')); } catch { /* */ }

function Toggle({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  return (
    <button role="switch" aria-checked={on} onClick={() => onChange(!on)}
      className={cx('w-11 h-6 rounded-full relative transition-colors shrink-0', on ? 'bg-brand-500' : 'bg-white/[0.12]')}>
      <span className={cx('absolute top-0.5 w-5 h-5 rounded-full bg-white shadow transition-all', on ? 'left-[22px]' : 'left-0.5')} />
    </button>
  );
}

function PrefRow({ title, desc, children }: { title: string; desc: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 py-4 border-b border-white/[0.05] last:border-0">
      <div className="min-w-0">
        <p className="text-sm font-medium text-white">{title}</p>
        <p className="text-xs muted mt-0.5">{desc}</p>
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

function PreferencesTab() {
  // `prefs` also carries any preference keys owned by other pages (e.g. Music); we
  // preserve them on save by spreading the loaded object back to the server.
  const [prefs, setPrefs] = useState<Prefs | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api.settings.get()
      .then(r => {
        const merged = { ...DEFAULT_PREFS, ...(r.preferences || {}) };
        applyAppearance(merged); cacheAppearance(merged);
        setPrefs(merged);
      })
      .catch(() => { applyAppearance(DEFAULT_PREFS); setPrefs(DEFAULT_PREFS); });
  }, []);

  // Apply + cache immediately so the change is visible the instant a toggle flips.
  const update = (patch: Partial<Prefs>) => setPrefs(p => {
    if (!p) return p;
    const nextP = { ...p, ...patch };
    applyAppearance(nextP); cacheAppearance(nextP);
    return nextP;
  });

  const save = async () => {
    if (!prefs) return;
    setSaving(true);
    try {
      await api.settings.preferences(prefs);
      toast('Preferences saved', 'success');
    } catch (e: any) {
      toast('Could not save preferences', 'error', e?.message);
    } finally { setSaving(false); }
  };

  if (!prefs) return <PageLoader />;

  return (
    <Section title="Preferences" subtitle="Tune the look and feel of Aerie."
      footer={<button className="btn-primary" disabled={saving} onClick={save}>{saving ? <Spinner size={16} /> : 'Save preferences'}</button>}>
      <div>
        <PrefRow title="Compact density" desc="Tighten spacing and text size across the whole app.">
          <Toggle on={prefs.compact} onChange={v => update({ compact: v })} />
        </PrefRow>
        <PrefRow title="Reduce motion" desc="Minimize animations and transitions everywhere.">
          <Toggle on={prefs.reduceMotion} onChange={v => update({ reduceMotion: v })} />
        </PrefRow>
      </div>
      <div className="mt-5 flex items-start gap-2.5 rounded-xl bg-ink-800/60 p-3.5">
        <Icon.Info size={16} className="text-brand-400 shrink-0 mt-0.5" />
        <p className="text-xs muted leading-relaxed">These apply instantly and are remembered on this device. Aerie uses a premium dark theme throughout for a cohesive, focused experience — a light theme is planned for a future release.</p>
      </div>
    </Section>
  );
}

// ---------------- Page ----------------
export default function Settings() {
  const { user } = useAuth();
  const [params, setParams] = useSearchParams();
  const tabParam = params.get('tab') as TabKey | null;
  const active: TabKey = TABS.some(t => t.key === tabParam) ? (tabParam as TabKey) : 'profile';

  const setTab = (key: TabKey) => {
    const p = new URLSearchParams(params);
    p.set('tab', key);
    setParams(p, { replace: true });
  };

  if (!user) return <PageLoader />;

  return (
    <div className="animate-fade-in">
      <PageHeader title="Settings" subtitle="Manage your account, devices and preferences." icon={<Icon.Settings size={22} />} />

      <div className="grid grid-cols-1 lg:grid-cols-[240px_1fr] gap-6 mt-6">
        {/* Tab list */}
        <nav className="min-w-0 lg:sticky lg:top-4 lg:self-start">
          <div className="hidden lg:block space-y-1">
            {TABS.map(t => (
              <button key={t.key} onClick={() => setTab(t.key)}
                className={cx('w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-left transition-colors',
                  active === t.key ? 'bg-brand-500/15 text-white' : 'text-slate-400 hover:text-slate-200 hover:bg-white/[0.03]')}>
                <span className={cx('shrink-0', active === t.key ? 'text-brand-400' : 'text-slate-500')}>{t.icon}</span>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium">{t.label}</span>
                  <span className="block text-xs text-slate-500 truncate">{t.hint}</span>
                </span>
                {active === t.key && <Icon.ChevronRight size={16} className="text-brand-400 shrink-0" />}
              </button>
            ))}
          </div>
          {/* Mobile chips */}
          <div className="lg:hidden flex gap-2 overflow-x-auto pb-1 -mx-1 px-1 min-w-0">
            {TABS.map(t => (
              <button key={t.key} onClick={() => setTab(t.key)}
                className={cx('chip whitespace-nowrap flex items-center gap-1.5', active === t.key && '!bg-brand-500/20 !text-white ring-1 ring-brand-500/40')}>
                {t.icon}{t.label}
              </button>
            ))}
          </div>
        </nav>

        {/* Panel */}
        <div className="min-w-0">
          {active === 'profile' && <ProfileTab user={user} />}
          {active === 'security' && <SecurityTab />}
          {active === 'devices' && <DevicesTab />}
          {active === 'ai' && <AiTab user={user} />}
          {active === 'notifications' && <NotificationsTab />}
          {active === 'preferences' && <PreferencesTab />}
        </div>
      </div>
    </div>
  );
}
