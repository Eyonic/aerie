import React, { useState, useEffect, useMemo } from 'react';
import QRCode from 'qrcode';
import { api } from '../lib/api';
import { Icon } from '../lib/icons';
import { copyText, cx, formatRelative, initials, colorFor } from '../lib/utils';
import { useAuth, toast } from '../lib/store';
import { PageLoader, EmptyState, PageHeader, Modal, ConfirmModal, Badge, Spinner } from '../components/ui';
import type { User, UserFeatures, AuditEvent, Role, AiMode, HouseholdInvite } from '../lib/model';

type Tab = 'users' | 'settings' | 'audit';

const ROLE_COLOR: Record<Role, 'brand' | 'slate'> = { admin: 'brand', user: 'slate' };
const AI_MODES: { value: AiMode; label: string }[] = [
  { value: 'local_only', label: 'Local provider only' },
  { value: 'ask_before_send', label: 'Ask before send' },
  { value: 'external_allowed', label: 'External allowed' },
  { value: 'disabled', label: 'Disabled' },
];
const AI_LABEL = (m: AiMode) => AI_MODES.find(x => x.value === m)?.label ?? m;

// Storage quotas are entered and stored as decimal GB (bytes = GB * 1e9), so
// display them with the SAME decimal unit — never formatBytes(), which uses
// binary GiB and would turn a saved 25 GB into a mismatched "23.3 GB".
function formatQuota(bytes: number): string {
  const gb = bytes / 1e9;
  if (gb >= 1000) return `${parseFloat((gb / 1000).toFixed(1))} TB`;
  return `${parseFloat(gb.toFixed(gb < 10 && gb % 1 !== 0 ? 1 : 0))} GB`;
}

// ---- shared small form pieces ----------------------------------------------
function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="text-sm font-medium text-slate-200">{label}</span>
      {hint && <span className="block text-xs text-slate-500 mt-0.5 mb-1.5">{hint}</span>}
      <div className={hint ? '' : 'mt-1.5'}>{children}</div>
    </label>
  );
}

function Select({ value, onChange, options }: { value: string; onChange: (v: string) => void; options: { value: string; label: string }[] }) {
  return (
    <div className="relative">
      <select value={value} onChange={e => onChange(e.target.value)}
        className="input appearance-none pr-9 cursor-pointer">
        {options.map(o => <option key={o.value} value={o.value} className="bg-ink-900 text-white">{o.label}</option>)}
      </select>
      <Icon.ChevronDown size={16} className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-500 pointer-events-none" />
    </div>
  );
}

// =============================================================================
// USERS TAB
// =============================================================================
const ACCESS_FEATURES: { key: Exclude<keyof UserFeatures, 'autoRequest'>; label: string; desc: string }[] = [
  { key: 'files', label: 'Files', desc: 'Personal files and folders' },
  { key: 'photos', label: 'Photos', desc: 'Photo library and uploads' },
  { key: 'videos', label: 'Personal videos', desc: 'Personal video library' },
  { key: 'movies', label: 'Movies', desc: 'Movie library and playback' },
  { key: 'tv', label: 'TV shows', desc: 'Series library and playback' },
  { key: 'music', label: 'Music', desc: 'Albums, artists and songs' },
  { key: 'audiobooks', label: 'Audiobooks', desc: 'Audiobooks and podcasts' },
  { key: 'requests', label: 'Media requests', desc: 'Request movies and music' },
  { key: 'create', label: 'Documents', desc: 'Documents and spreadsheets' },
  { key: 'ai', label: 'AI tools', desc: 'Assistant and generation studios' },
  { key: 'sync', label: 'Folder sync', desc: 'Device sync and deduplication' },
];
type AccessKey = typeof ACCESS_FEATURES[number]['key'];
interface UserForm { username: string; displayName: string; email: string; password: string; role: Role; quotaGb: string; aiMode: AiMode; access: Record<AccessKey, boolean>; }
const defaultAccess = () => Object.fromEntries(ACCESS_FEATURES.map(f => [f.key, true])) as Record<AccessKey, boolean>;
const emptyForm = (): UserForm => ({ username: '', displayName: '', email: '', password: '', role: 'user', quotaGb: '', aiMode: 'ask_before_send', access: defaultAccess() });

function UserModal({ open, onClose, editing, onSaved }: { open: boolean; onClose: () => void; editing: User | null; onSaved: () => void }) {
  const [form, setForm] = useState<UserForm>(() => emptyForm());
  const [saving, setSaving] = useState(false);
  const isEdit = !!editing;

  useEffect(() => {
    if (!open) return;
    if (editing) {
      setForm({
        username: editing.username,
        displayName: editing.displayName,
        email: editing.email ?? '',
        password: '',
        role: editing.role,
        quotaGb: editing.storageQuotaBytes == null ? '' : String(Math.round(editing.storageQuotaBytes / 1e9)),
        aiMode: editing.aiMode,
        access: Object.fromEntries(ACCESS_FEATURES.map(f => [f.key, editing.features?.[f.key] !== false])) as Record<AccessKey, boolean>,
      });
    } else setForm(emptyForm());
  }, [open, editing]);

  const set = <K extends keyof UserForm>(k: K, v: UserForm[K]) => setForm(f => ({ ...f, [k]: v }));

  async function save() {
    if (!form.username.trim() || !form.displayName.trim()) { toast('Missing fields', 'warning', 'Username and display name are required.'); return; }
    if (!isEdit && !form.password) { toast('Password required', 'warning', 'Set an initial password for the new user.'); return; }
    setSaving(true);
    try {
      const quotaBytes = form.quotaGb.trim() === '' ? null : Math.round(parseFloat(form.quotaGb) * 1e9);
      const payload: any = {
        username: form.username.trim(),
        displayName: form.displayName.trim(),
        email: form.email.trim() || null,
        role: form.role,
        storageQuotaBytes: quotaBytes,
        aiMode: form.aiMode,
        features: form.access,
      };
      if (form.password) payload.password = form.password;
      if (isEdit) await api.admin.updateUser(editing!.id, payload);
      else await api.admin.createUser(payload);
      toast(isEdit ? 'User updated' : 'User created', 'success', `${form.displayName} is all set.`);
      onSaved();
      onClose();
    } catch (e: any) {
      toast('Save failed', 'error', e?.message || 'Could not save the user.');
    } finally { setSaving(false); }
  }

  return (
    <Modal open={open} onClose={onClose} title={isEdit ? `Edit ${editing?.displayName}` : 'Add user'} size="md"
      footer={
        <>
          <button className="btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn-primary" onClick={save} disabled={saving}>
            {saving && <Spinner size={16} />} {isEdit ? 'Save changes' : 'Create user'}
          </button>
        </>
      }>
      <div className="grid sm:grid-cols-2 gap-4">
        <Field label="Username"><input className="input" value={form.username} disabled={isEdit}
          onChange={e => set('username', e.target.value)} placeholder="jdoe" /></Field>
        <Field label="Display name"><input className="input" value={form.displayName}
          onChange={e => set('displayName', e.target.value)} placeholder="Jane Doe" /></Field>
        <Field label="Email"><input className="input" type="email" value={form.email}
          onChange={e => set('email', e.target.value)} placeholder="jane@home.local" /></Field>
        <Field label={isEdit ? 'New password' : 'Password'} hint={isEdit ? 'Leave blank to keep current' : undefined}>
          <input className="input" type="password" value={form.password}
            onChange={e => set('password', e.target.value)}
            placeholder={isEdit ? '' : 'Set an initial password'} /></Field>
        <Field label="Role">
          <Select value={form.role} onChange={v => set('role', v as Role)}
            options={[{ value: 'user', label: 'User' }, { value: 'admin', label: 'Admin' }]} /></Field>
        <Field label="Storage quota (GB)" hint="Blank = unlimited">
          <input className="input" type="number" min={0} value={form.quotaGb}
            onChange={e => set('quotaGb', e.target.value)} placeholder="Unlimited" /></Field>
        <div className="sm:col-span-2">
          <Field label="AI mode">
            <Select value={form.aiMode} onChange={v => set('aiMode', v as AiMode)} options={AI_MODES} />
          </Field>
        </div>
        <div className="sm:col-span-2">
          <p className="text-sm font-medium text-slate-200 mb-2">Library access</p>
          <div className="grid sm:grid-cols-2 gap-2">
            {ACCESS_FEATURES.map(feature => <div key={feature.key} className="flex items-center justify-between gap-3 rounded-xl border border-white/[0.06] bg-white/[0.02] px-3 py-2.5">
              <div className="min-w-0"><p className="text-sm text-slate-200">{feature.label}</p><p className="text-[11px] text-slate-500 truncate">{feature.desc}</p></div>
              <Toggle label={`${feature.label} access`} on={form.access[feature.key]} onChange={v => set('access', { ...form.access, [feature.key]: v })} />
            </div>)}
          </div>
        </div>
      </div>
    </Modal>
  );
}

interface InviteForm { displayName: string; email: string; role: Role; quotaGb: string; aiMode: AiMode; expiresInHours: string; access: Record<AccessKey, boolean>; }
const emptyInviteForm = (): InviteForm => ({ displayName: '', email: '', role: 'user', quotaGb: '', aiMode: 'ask_before_send', expiresInHours: '48', access: defaultAccess() });

function InviteModal({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: () => void }) {
  const [form, setForm] = useState<InviteForm>(() => emptyInviteForm());
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<{ url: string; qr: string; invite: HouseholdInvite } | null>(null);
  const set = <K extends keyof InviteForm>(key: K, value: InviteForm[K]) => setForm(old => ({ ...old, [key]: value }));

  useEffect(() => {
    if (!open) return;
    setForm(emptyInviteForm());
    setResult(null);
  }, [open]);

  const create = async () => {
    setSaving(true);
    try {
      const quota = form.quotaGb.trim() === '' ? null : Math.round(Number(form.quotaGb) * 1e9);
      const created = await api.admin.createInvite({
        displayName: form.displayName.trim(), email: form.email.trim() || null, role: form.role,
        storageQuotaBytes: quota, aiMode: form.aiMode, features: form.access,
        expiresInHours: Number(form.expiresInHours),
      });
      const url = new URL(`/join/${created.token}`, window.location.origin).toString();
      const qr = await QRCode.toDataURL(url, { width: 220, margin: 1, errorCorrectionLevel: 'M' });
      setResult({ url, qr, invite: created.invite });
      onCreated();
    } catch (error: any) { toast('Could not create invitation', 'error', error?.message); }
    finally { setSaving(false); }
  };

  const close = () => { if (!saving) onClose(); };
  if (result) return <Modal open={open} onClose={close} title="Invitation ready" size="md" dismissible={!saving}>
    <div className="text-center">
      <div className="mx-auto w-fit rounded-2xl bg-white p-3"><img src={result.qr} alt="QR code for the one-time invitation" className="h-[220px] w-[220px]" /></div>
      <p className="mt-4 text-sm text-slate-300">Have {result.invite.displayName || 'the new member'} scan this code, or securely send the link below.</p>
      <div className="mt-3 flex items-center gap-2 rounded-xl border border-white/[0.08] bg-black/20 p-2">
        <input className="min-w-0 flex-1 bg-transparent px-2 text-xs text-slate-300 outline-none" value={result.url} readOnly aria-label="Invitation link" />
        <button className="btn-secondary shrink-0 !py-1.5" onClick={async () => {
          const copied = await copyText(result.url);
          toast(copied ? 'Invitation link copied' : 'Copy failed', copied ? 'success' : 'error');
        }}><Icon.Copy size={14} /> Copy</button>
      </div>
      <div className="mt-4 rounded-xl border border-accent-amber/20 bg-accent-amber/[0.06] p-3 text-left text-xs text-amber-100">The secret link is shown only now. It expires {new Date(result.invite.expiresAt).toLocaleString()} and stops working immediately after one account is created.</div>
      <button className="btn-primary mt-5 w-full" onClick={close}>Done</button>
    </div>
  </Modal>;

  return <Modal open={open} onClose={close} title="Invite a household member" size="lg" dismissible={!saving}
    footer={<><button className="btn-ghost" disabled={saving} onClick={close}>Cancel</button><button className="btn-primary" disabled={saving} onClick={() => void create()}>{saving && <Spinner size={15} />} Create secure invitation</button></>}>
    <p className="mb-5 text-sm muted">They choose their own username and password. Aerie stores only a hash of the one-time invitation secret.</p>
    <div className="grid gap-4 sm:grid-cols-2">
      <Field label="Display name" hint="Optional; they can change it before joining"><input className="input" value={form.displayName} onChange={event => set('displayName', event.target.value)} maxLength={120} placeholder="Jane Doe" /></Field>
      <Field label="Email" hint="Optional label; Aerie does not send email"><input className="input" type="email" value={form.email} onChange={event => set('email', event.target.value)} placeholder="jane@home.local" /></Field>
      <Field label="Role"><Select value={form.role} onChange={value => set('role', value as Role)} options={[{ value: 'user', label: 'User' }, { value: 'admin', label: 'Administrator' }]} /></Field>
      <Field label="Invitation expires"><Select value={form.expiresInHours} onChange={value => set('expiresInHours', value)} options={[{ value: '24', label: 'In 24 hours' }, { value: '48', label: 'In 2 days' }, { value: '168', label: 'In 7 days' }, { value: '720', label: 'In 30 days' }]} /></Field>
      <Field label="Storage quota (GB)" hint="Blank = unlimited"><input className="input" type="number" min={0} value={form.quotaGb} onChange={event => set('quotaGb', event.target.value)} placeholder="Unlimited" /></Field>
      <Field label="AI mode"><Select value={form.aiMode} onChange={value => set('aiMode', value as AiMode)} options={AI_MODES} /></Field>
      <div className="sm:col-span-2">
        <p className="mb-2 text-sm font-medium text-slate-200">Library access</p>
        <div className="grid gap-2 sm:grid-cols-2">{ACCESS_FEATURES.map(feature => <div key={feature.key} className="flex items-center justify-between gap-3 rounded-xl border border-white/[0.06] bg-white/[0.02] px-3 py-2.5"><div className="min-w-0"><p className="text-sm text-slate-200">{feature.label}</p><p className="truncate text-[11px] text-slate-500">{feature.desc}</p></div><Toggle label={`${feature.label} access`} on={form.access[feature.key]} onChange={value => set('access', { ...form.access, [feature.key]: value })} /></div>)}</div>
      </div>
    </div>
  </Modal>;
}

function UserAvatar({ u }: { u: User }) {
  const c = u.avatarColor || colorFor(u.username);
  return (
    <div className="w-9 h-9 rounded-full grid place-items-center text-sm font-semibold text-white shrink-0"
      style={{ background: `linear-gradient(135deg, ${c}, ${c}bb)` }}>
      {initials(u.displayName || u.username)}
    </div>
  );
}

function UsersTab({ me }: { me: User }) {
  const [users, setUsers] = useState<User[] | null>(null);
  const [invites, setInvites] = useState<HouseholdInvite[]>([]);
  const [q, setQ] = useState('');
  const [modalOpen, setModalOpen] = useState(false);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [editing, setEditing] = useState<User | null>(null);
  const [toDeactivate, setToDeactivate] = useState<User | null>(null);
  const [restoring, setRestoring] = useState<number | null>(null);

  async function load() {
    try {
      const [members, pending] = await Promise.all([api.admin.users(), api.admin.invites()]);
      setUsers(members); setInvites(pending.items || []);
    }
    catch { setUsers([]); toast('Could not load users', 'error'); }
  }
  useEffect(() => { load(); }, []);

  const filtered = useMemo(() => {
    if (!users) return [];
    const s = q.trim().toLowerCase();
    if (!s) return users;
    return users.filter(u => [u.displayName, u.username, u.email].filter(Boolean).some(x => x!.toLowerCase().includes(s)));
  }, [users, q]);

  async function doDeactivate() {
    if (!toDeactivate) return;
    try {
      await api.admin.deactivateUser(toDeactivate.id);
      toast('Account deactivated', 'success', `${toDeactivate.displayName} no longer has access. Their data is preserved.`);
      setToDeactivate(null);
      load();
    } catch (e: any) { toast('Deactivation failed', 'error', e?.message); }
  }

  async function restore(user: User) {
    setRestoring(user.id);
    try {
      await api.admin.restoreUser(user.id);
      toast('Account restored', 'success', `${user.displayName} can sign in again.`);
      load();
    } catch (e: any) { toast('Restore failed', 'error', e?.message); }
    finally { setRestoring(null); }
  }

  async function revokeInvite(invite: HouseholdInvite) {
    try {
      await api.admin.revokeInvite(invite.id);
      setInvites(old => old.map(item => item.id === invite.id ? { ...item, status: 'revoked', revokedAt: new Date().toISOString() } : item));
      toast('Invitation revoked', 'success');
    } catch (error: any) { toast('Could not revoke invitation', 'error', error?.message); }
  }

  if (!users) return <PageLoader />;

  return (
    <div className="animate-fade-in">
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="relative min-w-[14rem] flex-1 sm:max-w-sm">
          <Icon.Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
          <input className="input pl-9" placeholder="Search users…" value={q} onChange={e => setQ(e.target.value)} />
        </div>
        <div className="muted text-sm ml-auto hidden sm:block">
          {users.filter(user => !user.disabledAt).length} active
          {users.some(user => user.disabledAt) ? ` · ${users.filter(user => user.disabledAt).length} deactivated` : ''}
        </div>
        <button className="btn-primary" onClick={() => { setEditing(null); setModalOpen(true); }}>
          <Icon.Plus size={16} /> Add user
        </button>
        <button className="btn-secondary" onClick={() => setInviteOpen(true)}><Icon.Link size={16} /> Invite</button>
      </div>

      {invites.some(invite => invite.status === 'active') && <section className="card mb-5 p-4">
        <div className="mb-3"><h2 className="text-sm font-semibold text-white">Pending invitations</h2><p className="text-xs muted">One-time links waiting for a household member.</p></div>
        <div className="space-y-2">{invites.filter(invite => invite.status === 'active').map(invite => <div key={invite.id} className="flex items-center gap-3 rounded-xl border border-white/[0.06] bg-white/[0.02] p-3">
          <div className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-brand-500/12 text-brand-300"><Icon.Link size={16} /></div>
          <div className="min-w-0 flex-1"><p className="truncate text-sm font-medium text-white">{invite.displayName || invite.email || 'Household member'}</p><p className="text-xs muted">{invite.role} · expires {new Date(invite.expiresAt).toLocaleString()}</p></div>
          <button className="btn-ghost !py-1.5 text-accent-red" onClick={() => void revokeInvite(invite)}>Revoke</button>
        </div>)}</div>
      </section>}

      {filtered.length === 0 ? (
        <EmptyState icon={<Icon.Admin size={28} />} title="No users found" subtitle="Try a different search, or add a new account." />
      ) : (
        <>
        {/* Mobile: stacked cards */}
        <div className="md:hidden space-y-3">
          {filtered.map(u => (
            <div key={u.id} className={cx('card p-4', u.disabledAt && 'opacity-70')}>
              <div className="flex items-center gap-3">
                <UserAvatar u={u} />
                <div className="min-w-0 flex-1">
                  <div className="font-medium text-white flex items-center gap-2">
                    <span className="truncate">{u.displayName}</span>
                    {u.id === me.id && <span className="text-[10px] uppercase tracking-wide text-brand-400 bg-brand-500/10 px-1.5 py-0.5 rounded shrink-0">You</span>}
                    {u.disabledAt && <span className="text-[10px] uppercase tracking-wide text-slate-300 bg-slate-500/15 px-1.5 py-0.5 rounded shrink-0">Deactivated</span>}
                  </div>
                  <div className="text-xs text-slate-500 font-mono truncate">@{u.username}{u.email ? ` · ${u.email}` : ''}</div>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <button className="icon-btn" title="Edit" onClick={() => { setEditing(u); setModalOpen(true); }}>
                    <Icon.Edit size={16} />
                  </button>
                  {u.disabledAt ? (
                    <button className="icon-btn text-slate-400 hover:text-accent-green disabled:opacity-30"
                      title="Restore account" disabled={restoring === u.id} onClick={() => restore(u)}>
                      <Icon.Refresh size={16} />
                    </button>
                  ) : (
                    <button className="icon-btn text-slate-400 hover:text-accent-red disabled:opacity-30"
                      title={u.id === me.id ? "You can't deactivate yourself" : 'Deactivate account'} disabled={u.id === me.id}
                      onClick={() => setToDeactivate(u)}>
                      <Icon.Pause size={16} />
                    </button>
                  )}
                </div>
              </div>
              <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
                <Badge color={ROLE_COLOR[u.role]}>{u.role}</Badge>
                <span className="chip">{u.storageQuotaBytes == null ? 'Unlimited' : formatQuota(u.storageQuotaBytes)}</span>
                <span className="chip">AI: {AI_LABEL(u.aiMode)}</span>
              </div>
            </div>
          ))}
        </div>
        {/* Desktop: table */}
        <div className="card !p-0 overflow-hidden hidden md:block">
          <div className="overflow-x-auto">
            <table className="w-full text-sm min-w-[720px]">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wide text-slate-500 border-b border-white/[0.06]">
                  <th className="font-medium px-5 py-3">User</th>
                  <th className="font-medium px-4 py-3">Username</th>
                  <th className="font-medium px-4 py-3">Email</th>
                  <th className="font-medium px-4 py-3">Role</th>
                  <th className="font-medium px-4 py-3">Quota</th>
                  <th className="font-medium px-4 py-3">AI mode</th>
                  <th className="px-4 py-3"></th>
                </tr>
              </thead>
              <tbody>
                {filtered.map(u => (
                  <tr key={u.id} className="border-b border-white/[0.04] last:border-0 hover:bg-white/[0.02] transition-colors">
                    <td className="px-5 py-3">
                      <div className="flex items-center gap-3">
                        <UserAvatar u={u} />
                        <div className="min-w-0">
                          <div className="font-medium text-white flex items-center gap-2">
                            {u.displayName}
                            {u.id === me.id && <span className="text-[10px] uppercase tracking-wide text-brand-400 bg-brand-500/10 px-1.5 py-0.5 rounded">You</span>}
                            {u.disabledAt && <span className="text-[10px] uppercase tracking-wide text-slate-300 bg-slate-500/15 px-1.5 py-0.5 rounded">Deactivated</span>}
                          </div>
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-slate-400 font-mono text-xs">@{u.username}</td>
                    <td className="px-4 py-3 text-slate-400">{u.email || <span className="text-slate-600">—</span>}</td>
                    <td className="px-4 py-3"><Badge color={ROLE_COLOR[u.role]}>{u.role}</Badge></td>
                    <td className="px-4 py-3 text-slate-300">{u.storageQuotaBytes == null ? <span className="text-slate-500">Unlimited</span> : formatQuota(u.storageQuotaBytes)}</td>
                    <td className="px-4 py-3 text-slate-400">{AI_LABEL(u.aiMode)}</td>
                    <td className="px-4 py-3">
                      <div className="flex items-center justify-end gap-1">
                        <button className="icon-btn" title="Edit" onClick={() => { setEditing(u); setModalOpen(true); }}>
                          <Icon.Edit size={16} />
                        </button>
                        {u.disabledAt ? (
                          <button className="icon-btn text-slate-400 hover:text-accent-green disabled:opacity-30"
                            title="Restore account" disabled={restoring === u.id} onClick={() => restore(u)}>
                            <Icon.Refresh size={16} />
                          </button>
                        ) : (
                          <button className="icon-btn text-slate-400 hover:text-accent-red disabled:opacity-30 disabled:hover:text-slate-400"
                            title={u.id === me.id ? "You can't deactivate yourself" : 'Deactivate account'} disabled={u.id === me.id}
                            onClick={() => setToDeactivate(u)}>
                            <Icon.Pause size={16} />
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
        </>
      )}

      <UserModal open={modalOpen} onClose={() => setModalOpen(false)} editing={editing} onSaved={load} />
      <InviteModal open={inviteOpen} onClose={() => setInviteOpen(false)} onCreated={load} />
      <ConfirmModal open={!!toDeactivate} onClose={() => setToDeactivate(null)} onConfirm={doDeactivate} danger
        title="Deactivate account?" confirmLabel="Deactivate account"
        message={`${toDeactivate?.displayName} will be signed out immediately. Public shares and background work will pause, while files, snapshots, settings, and history remain intact for restoration.`} />
    </div>
  );
}

// =============================================================================
// SETTINGS TAB
// =============================================================================
interface SettingsShape {
  publicSharingEnabled: boolean;
  externalAiEnabled: boolean;
  locationIndexing: boolean;
  maxUploadMb: number;
  allowedFileTypes: string;
}
const SETTINGS_DEFAULTS: SettingsShape = {
  publicSharingEnabled: false, externalAiEnabled: false, locationIndexing: false,
  maxUploadMb: 2048, allowedFileTypes: '*',
};

function settingsFromApi(value: any): SettingsShape {
  return {
    publicSharingEnabled: value?.publicSharingEnabled ?? SETTINGS_DEFAULTS.publicSharingEnabled,
    externalAiEnabled: value?.externalAiEnabled ?? SETTINGS_DEFAULTS.externalAiEnabled,
    locationIndexing: value?.locationIndexing ?? SETTINGS_DEFAULTS.locationIndexing,
    maxUploadMb: value?.maxUploadMb ?? SETTINGS_DEFAULTS.maxUploadMb,
    allowedFileTypes: value?.allowedFileTypes ?? SETTINGS_DEFAULTS.allowedFileTypes,
  };
}

const TOGGLES: { key: keyof SettingsShape; icon: keyof typeof Icon; title: string; desc: string }[] = [
  { key: 'publicSharingEnabled', icon: 'Share', title: 'Public sharing links', desc: 'Allow members to create links that unauthenticated visitors can open. Off prevents new public-link access.' },
  { key: 'externalAiEnabled', icon: 'Sparkles', title: 'External AI providers', desc: 'Permit language-AI features to use configured cloud models when a member opts in. Off restricts those requests to the configured local provider endpoint.' },
  { key: 'locationIndexing', icon: 'Cloud', title: 'Location indexing', desc: 'Read GPS metadata to build a map and place albums. Coordinates remain in Aerie and are cleared from the index when this is disabled.' },
];

function Toggle({ label, on, onChange }: { label: string; on: boolean; onChange: (v: boolean) => void }) {
  return (
    <button type="button" onClick={() => onChange(!on)} role="switch" aria-checked={on} aria-label={label}
      className={cx('relative w-11 h-6 rounded-full transition-colors shrink-0', on ? 'bg-brand-500' : 'bg-ink-700')}>
      <span className={cx('absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform', on && 'translate-x-5')} />
    </button>
  );
}

function SettingsTab() {
  const [settings, setSettings] = useState<SettingsShape | null>(null);
  // Last-persisted values — used to send only changed keys (so the audit trail
  // records the precise setting(s) touched, not all six every time).
  const [baseline, setBaseline] = useState<SettingsShape | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api.admin.settings()
      .then((s: any) => { const merged = settingsFromApi(s); setSettings(merged); setBaseline(merged); })
      .catch(() => { const d = { ...SETTINGS_DEFAULTS }; setSettings(d); setBaseline(d); });
  }, []);

  const set = <K extends keyof SettingsShape>(k: K, v: SettingsShape[K]) => setSettings(s => s ? { ...s, [k]: v } : s);

  async function save() {
    if (!settings || !baseline) return;
    if (!Number.isFinite(settings.maxUploadMb) || settings.maxUploadMb < 1) {
      toast('Invalid upload size', 'warning', 'Max upload size must be at least 1 MB.');
      return;
    }
    const changed: Partial<SettingsShape> = {};
    (Object.keys(settings) as (keyof SettingsShape)[]).forEach(k => {
      if (settings[k] !== baseline[k]) (changed as any)[k] = settings[k];
    });
    if (Object.keys(changed).length === 0) {
      toast('Nothing to save', 'info', 'No settings have changed.');
      return;
    }
    setSaving(true);
    try {
      await api.admin.saveSettings(changed);
      setBaseline(settings);
      toast('Settings saved', 'success', 'Your privacy preferences are now in effect.');
    } catch (e: any) { toast('Save failed', 'error', e?.message); }
    finally { setSaving(false); }
  }

  if (!settings) return <PageLoader />;

  return (
    <div className="animate-fade-in max-w-3xl space-y-6">
      <div className="card p-1.5">
        {TOGGLES.map((t, i) => {
          const Ic = Icon[t.icon];
          const on = settings[t.key] as boolean;
          return (
            <div key={t.key} className={cx('flex items-start gap-4 p-4 rounded-xl', i !== TOGGLES.length - 1 && 'border-b border-white/[0.04]')}>
              <div className={cx('w-10 h-10 rounded-xl grid place-items-center shrink-0 transition-colors', on ? 'bg-brand-500/15 text-brand-400' : 'bg-ink-800 text-slate-500')}>
                <Ic size={18} />
              </div>
              <div className="flex-1 min-w-0">
                <div className="font-medium text-white">{t.title}</div>
                <p className="muted text-sm mt-0.5 leading-relaxed">{t.desc}</p>
              </div>
              <Toggle label={t.title} on={on} onChange={v => set(t.key, v)} />
            </div>
          );
        })}
        <div className="flex items-start gap-4 p-4 rounded-xl border-t border-white/[0.04]">
          <div className="w-10 h-10 rounded-xl grid place-items-center shrink-0 bg-ink-800 text-slate-500">
            <Icon.Eye size={18} />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <span className="font-medium text-white">Face recognition</span>
              <Badge color="slate">Unavailable</Badge>
            </div>
            <p className="muted text-sm mt-0.5 leading-relaxed">This release does not include face detection or clustering, so there is no setting that would imply it is active.</p>
          </div>
        </div>
      </div>

      <div className="card p-5 grid sm:grid-cols-2 gap-5">
        <Field label="Max upload size (MB)" hint="Largest single file members may upload.">
          <input className="input" type="number" min={1}
            value={Number.isFinite(settings.maxUploadMb) ? settings.maxUploadMb : ''}
            onChange={e => set('maxUploadMb', parseInt(e.target.value, 10))} />
        </Field>
        <Field label="Allowed file types" hint="Comma-separated extensions, or * for any.">
          <input className="input" value={settings.allowedFileTypes}
            onChange={e => set('allowedFileTypes', e.target.value)} placeholder="*  or  jpg, png, pdf" />
        </Field>
      </div>

      <div className="flex items-center gap-3">
        <button className="btn-primary" onClick={save} disabled={saving}>
          {saving && <Spinner size={16} />} Save settings
        </button>
        <span className="muted text-xs flex items-center gap-1.5"><Icon.Shield size={13} /> Privacy-first defaults minimize external data sharing.</span>
      </div>
    </div>
  );
}

// =============================================================================
// AUDIT LOG TAB
// =============================================================================
function actionMeta(action: string): { icon: keyof typeof Icon; color: string } {
  const a = action.toLowerCase();
  if (a.includes('login') || a.includes('auth')) return { icon: 'Shield', color: '#6366f1' };
  if (a.includes('logout')) return { icon: 'Logout', color: '#64748b' };
  if (a.includes('delete') || a.includes('remove') || a.includes('purge') || a.includes('deactiv')) return { icon: 'Trash', color: '#ef4444' };
  if (a.includes('restore')) return { icon: 'Refresh', color: '#10b981' };
  if (a.includes('create') || a.includes('add') || a.includes('mkdir')) return { icon: 'Plus', color: '#10b981' };
  if (a.includes('upload')) return { icon: 'Upload', color: '#06b6d4' };
  if (a.includes('download')) return { icon: 'Download', color: '#06b6d4' };
  if (a.includes('update') || a.includes('edit') || a.includes('rename') || a.includes('save') || a.includes('settings')) return { icon: 'Edit', color: '#f59e0b' };
  if (a.includes('share')) return { icon: 'Share', color: '#a855f7' };
  if (a.includes('move') || a.includes('copy')) return { icon: 'Files', color: '#94a3b8' };
  return { icon: 'Info', color: '#94a3b8' };
}
const humanize = (s: string) => s.replace(/[._]/g, ' ').replace(/\b\w/g, c => c.toUpperCase());

// The server emits UTC timestamps like "2026-07-04 09:03:18" with no zone
// marker, which the browser would otherwise parse as LOCAL time (off by the
// UTC offset). Normalize to an explicit ISO-8601 UTC string so Date parses it
// correctly and formatRelative / toLocaleString render in the viewer's zone.
function parseUtcTs(ts: string | null | undefined): string {
  if (!ts) return '';
  if (/[zZ]|[+-]\d{2}:?\d{2}$/.test(ts)) return ts; // already carries a zone
  return ts.trim().replace(' ', 'T') + 'Z';
}

// Friendly labels for settings keys logged in admin_setting_changed targets.
const SETTING_LABELS: Record<string, string> = {
  publicSharingEnabled: 'Public sharing',
  externalAiEnabled: 'External AI providers',
  faceRecognition: 'Face recognition',
  locationIndexing: 'Location indexing',
  maxUploadMb: 'Max upload size',
  allowedFileTypes: 'Allowed file types',
};
const settingLabel = (k: string) => SETTING_LABELS[k] || humanize(k.replace(/([a-z0-9])([A-Z])/g, '$1 $2'));

// Render an audit event's Target consistently: resolve numeric user IDs
// (admin_user_updated / _deleted) to usernames, and turn the raw JSON key
// array in admin_setting_changed into a readable list.
function formatTarget(e: AuditEvent, userMap: Record<number, string>): React.ReactNode {
  const t = e.target;
  if (!t) return <span className="text-slate-600">—</span>;
  if (e.action === 'admin_user_updated' || e.action === 'admin_user_deleted'
    || e.action === 'admin_user_deactivated' || e.action === 'admin_user_restored') {
    const id = Number(t);
    if (Number.isInteger(id) && String(id) === t.trim()) {
      return userMap[id] || `User #${id}`;
    }
    return t;
  }
  if (e.action === 'admin_setting_changed') {
    try {
      const keys = JSON.parse(t);
      if (Array.isArray(keys) && keys.length) return keys.map(k => settingLabel(String(k))).join(', ');
    } catch { /* fall through to generic */ }
    // No usable key detail — don't imply every setting changed.
    return 'Settings updated';
  }
  return t;
}

const AUDIT_PAGE = 200;

function AuditTab() {
  const [events, setEvents] = useState<AuditEvent[] | null>(null);
  const [userMap, setUserMap] = useState<Record<number, string>>({});
  const [q, setQ] = useState('');
  const [limit, setLimit] = useState(AUDIT_PAGE);
  const [loadingMore, setLoadingMore] = useState(false);
  // Whether the last fetch returned a full page — i.e. more rows may exist.
  const [hasMore, setHasMore] = useState(false);

  useEffect(() => {
    api.activity(AUDIT_PAGE).then(e => { setEvents(e); setHasMore(e.length >= AUDIT_PAGE); }).catch(() => { setEvents([]); });
    // Used to resolve numeric user-IDs in targets back to usernames.
    api.admin.users()
      .then(us => setUserMap(Object.fromEntries(us.map(u => [u.id, u.username]))))
      .catch(() => {});
  }, []);

  async function loadMore() {
    const next = limit + AUDIT_PAGE;
    setLoadingMore(true);
    try {
      const e = await api.activity(next);
      setEvents(e);
      setLimit(next);
      setHasMore(e.length >= next);
    } catch { toast('Could not load more', 'error'); }
    finally { setLoadingMore(false); }
  }

  const filtered = useMemo(() => {
    if (!events) return [];
    const sorted = [...events].sort((a, b) => +new Date(b.ts) - +new Date(a.ts));
    const s = q.trim().toLowerCase();
    if (!s) return sorted;
    return sorted.filter(e => [e.username, e.action, e.target, e.ip].filter(Boolean).some(x => String(x).toLowerCase().includes(s)));
  }, [events, q]);

  if (!events) return <PageLoader />;

  return (
    <div className="animate-fade-in">
      <div className="flex items-center gap-3 mb-4">
        <div className="relative flex-1 max-w-sm">
          <Icon.Filter size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
          <input className="input pl-9" placeholder="Filter by user, action, target, IP…" value={q} onChange={e => setQ(e.target.value)} />
        </div>
        <div className="muted text-sm ml-auto hidden sm:block">{filtered.length} event{filtered.length !== 1 && 's'}</div>
      </div>

      {events.length === 0 ? (
        <EmptyState icon={<Icon.Clock size={28} />} title="No activity yet" subtitle="Audit events will appear here as members use Aerie." />
      ) : filtered.length === 0 ? (
        <EmptyState icon={<Icon.Search size={28} />} title="No matching events" subtitle="Try a different filter term." />
      ) : (
        <>
        {/* Mobile: stacked cards */}
        <div className="md:hidden space-y-2.5">
          {filtered.map(e => {
            const m = actionMeta(e.action);
            const Ic = Icon[m.icon];
            return (
              <div key={e.id} className="card p-3.5">
                <div className="flex items-start gap-3">
                  <span className="w-8 h-8 rounded-lg grid place-items-center shrink-0 mt-0.5" style={{ background: `${m.color}22`, color: m.color }}>
                    <Ic size={15} />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-medium text-slate-200 truncate">{humanize(e.action)}</span>
                      <span className="text-xs text-slate-500 shrink-0 whitespace-nowrap" title={new Date(parseUtcTs(e.ts)).toLocaleString()}>{formatRelative(parseUtcTs(e.ts))}</span>
                    </div>
                    {e.target && <p className="text-xs text-slate-400 font-mono truncate mt-0.5" title={e.target}>{formatTarget(e, userMap)}</p>}
                    <p className="text-[11px] text-slate-500 font-mono mt-1">{e.username || '—'}{e.ip ? ` · ${e.ip}` : ''}</p>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
        {/* Desktop: table */}
        <div className="card !p-0 overflow-hidden hidden md:block">
          <div className="overflow-x-auto">
            <table className="w-full text-sm min-w-[760px]">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wide text-slate-500 border-b border-white/[0.06]">
                  <th className="font-medium px-5 py-3">Action</th>
                  <th className="font-medium px-4 py-3">User</th>
                  <th className="font-medium px-4 py-3">Target</th>
                  <th className="font-medium px-4 py-3">IP</th>
                  <th className="font-medium px-4 py-3 text-right">When</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map(e => {
                  const m = actionMeta(e.action);
                  const Ic = Icon[m.icon];
                  return (
                    <tr key={e.id} className="border-b border-white/[0.04] last:border-0 hover:bg-white/[0.02] transition-colors">
                      <td className="px-5 py-3">
                        <div className="flex items-center gap-2.5">
                          <span className="w-7 h-7 rounded-lg grid place-items-center shrink-0" style={{ background: `${m.color}22`, color: m.color }}>
                            <Ic size={14} />
                          </span>
                          <span className="font-medium text-slate-200">{humanize(e.action)}</span>
                        </div>
                      </td>
                      <td className="px-4 py-3 text-slate-300 font-mono text-xs">{e.username || '—'}</td>
                      <td className="px-4 py-3 text-slate-400 font-mono text-xs max-w-[280px] truncate" title={e.target}>{formatTarget(e, userMap)}</td>
                      <td className="px-4 py-3 text-slate-500 font-mono text-xs">{e.ip || '—'}</td>
                      <td className="px-4 py-3 text-slate-400 text-right whitespace-nowrap" title={new Date(parseUtcTs(e.ts)).toLocaleString()}>{formatRelative(parseUtcTs(e.ts))}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
        {hasMore && !q && (
          <div className="flex justify-center mt-4">
            <button className="btn-ghost" onClick={loadMore} disabled={loadingMore}>
              {loadingMore && <Spinner size={16} />} Load more
            </button>
          </div>
        )}
        {!hasMore && events.length >= AUDIT_PAGE && (
          <p className="text-center muted text-xs mt-4">End of the audit trail.</p>
        )}
        </>
      )}
    </div>
  );
}

// =============================================================================
// ROOT
// =============================================================================
const TABS: { id: Tab; label: string; icon: keyof typeof Icon }[] = [
  { id: 'users', label: 'Users', icon: 'Admin' },
  { id: 'settings', label: 'Settings', icon: 'Settings' },
  { id: 'audit', label: 'Audit Log', icon: 'Clock' },
];

export default function Admin() {
  const { user } = useAuth();
  const [tab, setTab] = useState<Tab>('users');

  if (!user || user.role !== 'admin') {
    return (
      <div className="animate-fade-in">
        <PageHeader title="Admin" subtitle="Control panel" icon={<Icon.Admin size={22} />} />
        <div className="mt-10">
          <EmptyState icon={<Icon.Shield size={30} />} title="Admins only"
            subtitle="You don't have permission to view the control panel. Ask an administrator if you need access." />
        </div>
      </div>
    );
  }

  return (
    <div className="animate-fade-in">
      <PageHeader title="Control panel" subtitle="Manage members, privacy, and the audit trail for your private cloud."
        icon={<Icon.Admin size={22} />} />

      <div className="flex items-center gap-1 p-1 rounded-xl bg-ink-900/60 border border-white/[0.05] w-fit max-w-full overflow-x-auto mb-6">
        {TABS.map(t => {
          const Ic = Icon[t.icon];
          const active = tab === t.id;
          return (
            <button key={t.id} onClick={() => setTab(t.id)}
              className={cx('flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all shrink-0',
                active ? 'bg-brand-500/15 text-white shadow-glow' : 'text-slate-400 hover:text-slate-200 hover:bg-white/[0.03]')}>
              <Ic size={16} className={active ? 'text-brand-400' : ''} /> {t.label}
            </button>
          );
        })}
      </div>

      {tab === 'users' && <UsersTab me={user} />}
      {/* Settings stays mounted so in-progress edits survive a tab switch
          (they were previously discarded on unmount). */}
      <div className={cx(tab !== 'settings' && 'hidden')}><SettingsTab /></div>
      {tab === 'audit' && <AuditTab />}
    </div>
  );
}
