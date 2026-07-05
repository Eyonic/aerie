import React, { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { Icon } from '../lib/icons';
import { cx } from '../lib/utils';
import { useAuth, toast } from '../lib/store';
import { PageLoader, EmptyState, PageHeader, Spinner } from '../components/ui';

// ---- server contract (GET /api/integrations) --------------------------------
type Source = 'app' | 'env' | 'none';
interface FieldMeta { value?: string; set: boolean; source: Source }
type Fields = Record<string, FieldMeta>;
interface TestState { running?: boolean; ok?: boolean; detail?: string }

interface FieldSpec {
  key: string;
  label: string;
  secret?: boolean;      // write-only on the server: never echoed back
  placeholder?: string;
  hint?: string;
}

interface CardDef {
  id: string;
  icon: keyof typeof Icon;
  title: string;
  subtitle: string;
  service?: string;      // POST /api/integrations/test/:service
  note?: string;         // helper text shown above the fields
  specs: FieldSpec[];
  advanced?: FieldSpec[];
  wide?: boolean;        // span both grid columns
}

const GROUPS: { title: string; pp?: boolean; cards: CardDef[] }[] = [
  { title: 'Media', cards: [
    { id: 'jellyfin', icon: 'Movie', title: 'Jellyfin', subtitle: 'Movies, TV shows, music and videos.', service: 'jellyfin',
      specs: [
        { key: 'JELLYFIN_URL', label: 'Server URL', placeholder: 'http://192.168.0.10:8096' },
        { key: 'JELLYFIN_API_KEY', label: 'API key', secret: true },
      ] },
    { id: 'abs', icon: 'Book', title: 'Audiobookshelf', subtitle: 'Audiobooks and podcasts.', service: 'abs',
      specs: [
        { key: 'ABS_URL', label: 'Server URL', placeholder: 'http://192.168.0.10:13378' },
        { key: 'ABS_API_KEY', label: 'API key', secret: true },
      ] },
  ] },
  { title: 'Requests', cards: [
    { id: 'jellyseerr', icon: 'Plus', title: 'Jellyseerr', subtitle: 'Movie & TV show requests.', service: 'jellyseerr',
      specs: [
        { key: 'JELLYSEERR_URL', label: 'Server URL', placeholder: 'http://192.168.0.10:5055' },
        { key: 'JELLYSEERR_API_KEY', label: 'API key', secret: true },
      ] },
    { id: 'lidarr', icon: 'Music', title: 'Lidarr', subtitle: 'Music requests.', service: 'lidarr',
      specs: [
        { key: 'LIDARR_URL', label: 'Server URL', placeholder: 'http://192.168.0.10:8686' },
        { key: 'LIDARR_API_KEY', label: 'API key', secret: true },
      ] },
  ] },
  { title: 'Photos', pp: true, cards: [] },
  { title: 'AI', cards: [
    { id: 'deepseek', icon: 'Sparkles', title: 'DeepSeek', subtitle: 'Cloud LLM for chat, agents and document actions.', service: 'deepseek',
      specs: [
        { key: 'DEEPSEEK_URL', label: 'API URL', placeholder: 'https://api.deepseek.com/v1' },
        { key: 'DEEPSEEK_API_KEY', label: 'API key', secret: true, placeholder: 'sk-…' },
        { key: 'DEEPSEEK_MODEL', label: 'Model', placeholder: 'deepseek-chat' },
      ] },
    { id: 'ollama', icon: 'Cpu', title: 'Ollama', subtitle: 'Local LLM on your own hardware.', service: 'ollama',
      specs: [
        { key: 'OLLAMA_URL', label: 'Server URL', placeholder: 'http://192.168.0.10:11434' },
        { key: 'OLLAMA_MODEL', label: 'Model', placeholder: 'llama3.1:8b' },
      ] },
    { id: 'comfyui', icon: 'Image', title: 'ComfyUI images', subtitle: 'AI image generation and editing.', service: 'comfyui',
      specs: [{ key: 'SD_URL', label: 'Server URL', placeholder: 'http://192.168.0.10:8188' }] },
    { id: 'acestep', icon: 'Music', title: 'ACE-Step music', subtitle: 'AI music generation.', service: 'acestep',
      specs: [{ key: 'ACESTEP_URL', label: 'Server URL', placeholder: 'http://192.168.0.10:8001' }] },
    { id: 'whisper', icon: 'Volume', title: 'Whisper voice', subtitle: 'Speech-to-text for dictation and voice commands.', service: 'whisper',
      specs: [{ key: 'WHISPER_URL', label: 'Server URL (Wyoming)', placeholder: 'http://192.168.0.10:10300' }] },
    { id: 'translate', icon: 'Doc', title: 'Translation', subtitle: 'Default target language for AI translations.',
      specs: [{ key: 'TRANSLATE_LANG', label: 'Language', placeholder: 'en', hint: 'ISO code, e.g. en, cs, de.' }] },
  ] },
  { title: 'Server addresses', cards: [
    { id: 'server', icon: 'Wifi', title: 'Server addresses', subtitle: 'How apps and devices reach this server.', wide: true,
      note: 'The mobile/desktop apps learn both addresses from the server and switch automatically when one becomes unreachable.',
      specs: [
        { key: 'PUBLIC_URL', label: 'Public HTTPS address', placeholder: 'https://cloud.example.com' },
        { key: 'LAN_URL', label: 'LAN address', placeholder: 'http://192.168.0.10:8200', hint: 'e.g. http://192.168.0.10:8200' },
      ],
      advanced: [
        { key: 'CAST_SUBNET', label: 'Cast subnet', placeholder: '192.168.0.0/24', hint: 'Subnet scanned for Chromecast devices.' },
        { key: 'SERVER_HOST', label: 'Server host', placeholder: '0.0.0.0', hint: 'Bind address of the server process.' },
      ] },
  ] },
];

// PhotoPrism has a custom editor (dynamic instance list), so it isn't in GROUPS.
const PP_SPECS: FieldSpec[] = [
  { key: 'PP_INSTANCES', label: 'Instances' },
  { key: 'PP_DEFAULT', label: 'Default instance' },
  { key: 'PP_USER', label: 'Username', placeholder: 'admin' },
  { key: 'PP_PASSWORD', label: 'Password', secret: true },
];
const PP_CARD: CardDef = {
  id: 'photoprism', icon: 'Photos', title: 'PhotoPrism', subtitle: 'Photo library — faces, places and albums.',
  service: 'photoprism', specs: PP_SPECS, wide: true,
};

// PP_INSTANCES wire format: "name=url,name2=url2"
function parseInstances(v: string): { name: string; url: string }[] {
  if (!v.trim()) return [];
  return v.split(',').map(p => {
    const i = p.indexOf('=');
    return i === -1 ? { name: p.trim(), url: '' } : { name: p.slice(0, i).trim(), url: p.slice(i + 1).trim() };
  }).filter(r => r.name || r.url);
}
function serializeInstances(rows: { name: string; url: string }[]): string {
  return rows.filter(r => r.name.trim() && r.url.trim()).map(r => `${r.name.trim()}=${r.url.trim()}`).join(',');
}

// Everything the field/card components need, wired up once in the root.
interface Ctx {
  fields: Fields;
  draft: Record<string, string>;
  stage: (key: string, value: string) => void;
  isDirty: (spec: FieldSpec) => boolean;
  clearField: (key: string) => void;
  clearing: string | null;
  saveCard: (id: string, specs: FieldSpec[]) => void;
  saving: string | null;
  runTest: (service: string) => void;
  tests: Record<string, TestState>;
}

function SourceBadge({ meta }: { meta?: FieldMeta }) {
  if (!meta?.set || meta.source === 'none') return null;
  return (
    <span className={cx('text-[10px] px-1.5 py-0.5 rounded-md font-medium whitespace-nowrap',
      meta.source === 'app' ? 'bg-brand-500/10 text-brand-400' : 'bg-white/[0.06] text-slate-400')}>
      {meta.source === 'app' ? 'set in app' : 'from server env'}
    </span>
  );
}

// Reset an app-set value back to the env fallback (PUT empty string).
function ClearBtn({ ctx, k }: { ctx: Ctx; k: string }) {
  return (
    <button
      className="ml-auto text-[11px] text-slate-500 hover:text-accent-red transition-colors inline-flex items-center gap-1"
      onClick={() => ctx.clearField(k)} disabled={ctx.clearing === k}
      title="Remove the in-app value — the server env value (if any) applies again">
      {ctx.clearing === k ? <Spinner size={11} /> : <Icon.Close size={11} />} Clear
    </button>
  );
}

function FieldRow({ ctx, spec }: { ctx: Ctx; spec: FieldSpec }) {
  const meta = ctx.fields[spec.key];
  // Secrets are never echoed back: the input starts empty and a placeholder
  // signals that a value is already saved. Non-secrets prefill from the server.
  const value = ctx.draft[spec.key] ?? (spec.secret ? '' : meta?.value ?? '');
  return (
    <div>
      <div className="flex items-center gap-2 mb-1.5">
        <span className="text-sm font-medium text-slate-300">{spec.label}</span>
        <SourceBadge meta={meta} />
        {meta?.source === 'app' && <ClearBtn ctx={ctx} k={spec.key} />}
      </div>
      <input
        className="input"
        type={spec.secret ? 'password' : 'text'}
        value={value}
        onChange={e => ctx.stage(spec.key, e.target.value)}
        placeholder={spec.secret ? (meta?.set ? '••••••••  (saved)' : spec.placeholder || '') : spec.placeholder}
        autoComplete={spec.secret ? 'new-password' : 'off'}
        spellCheck={false}
      />
      {spec.hint && <p className="text-xs text-slate-500 mt-1.5">{spec.hint}</p>}
    </div>
  );
}

function CardHeader({ def }: { def: CardDef }) {
  const Ic = Icon[def.icon];
  return (
    <div className="px-5 pt-4 pb-3.5 border-b border-white/[0.05] flex items-center gap-3">
      <div className="w-9 h-9 rounded-xl grid place-items-center bg-white/[0.04] text-slate-300 shrink-0">
        <Ic size={18} />
      </div>
      <div className="min-w-0">
        <p className="font-semibold text-white leading-snug">{def.title}</p>
        <p className="text-xs muted truncate">{def.subtitle}</p>
      </div>
    </div>
  );
}

function CardFooter({ ctx, def, allSpecs }: { ctx: Ctx; def: CardDef; allSpecs: FieldSpec[] }) {
  const t = def.service ? ctx.tests[def.service] : undefined;
  const dirty = allSpecs.some(ctx.isDirty);
  return (
    <div className="mt-auto px-5 py-3.5 border-t border-white/[0.05] bg-white/[0.015] flex items-center gap-3">
      {def.service && (
        <button className="btn-secondary !py-1.5 !px-3 text-xs" onClick={() => ctx.runTest(def.service!)}
          disabled={t?.running} title="Check the connection with the values in effect right now (save first to test edits)">
          {t?.running ? <Spinner size={13} /> : <Icon.Bolt size={13} />}<span className="ml-1">Test</span>
        </button>
      )}
      {t && !t.running && t.detail !== undefined && (
        <span className={cx('text-xs flex items-center gap-1 min-w-0', t.ok ? 'text-green-400' : 'text-red-400')}>
          {t.ok ? <Icon.Check size={14} className="shrink-0" /> : <Icon.Close size={14} className="shrink-0" />}
          <span className="truncate" title={t.detail}>{t.detail}</span>
        </span>
      )}
      <div className="flex-1" />
      <button className="btn-primary !py-1.5 !px-3.5 text-xs" onClick={() => ctx.saveCard(def.id, allSpecs)}
        disabled={!dirty || ctx.saving === def.id}>
        {ctx.saving === def.id && <Spinner size={13} />}<span className={ctx.saving === def.id ? 'ml-1' : ''}>Save</span>
      </button>
    </div>
  );
}

function Card({ ctx, def }: { ctx: Ctx; def: CardDef }) {
  const allSpecs = [...def.specs, ...(def.advanced || [])];
  return (
    <div className={cx('card !p-0 overflow-hidden flex flex-col', def.wide && 'md:col-span-2')}>
      <CardHeader def={def} />
      <div className="p-5 space-y-4">
        {def.note && <p className="text-xs text-slate-400 leading-relaxed -mt-1">{def.note}</p>}
        <div className={cx(def.wide ? 'grid sm:grid-cols-2 gap-4' : 'space-y-4')}>
          {def.specs.map(s => <FieldRow key={s.key} ctx={ctx} spec={s} />)}
        </div>
        {def.advanced && (
          <>
            <p className="text-[10px] font-semibold uppercase tracking-widest text-slate-600 pt-1">Advanced</p>
            <div className={cx(def.wide ? 'grid sm:grid-cols-2 gap-4' : 'space-y-4')}>
              {def.advanced.map(s => <FieldRow key={s.key} ctx={ctx} spec={s} />)}
            </div>
          </>
        )}
      </div>
      <CardFooter ctx={ctx} def={def} allSpecs={allSpecs} />
    </div>
  );
}

// PhotoPrism: PP_INSTANCES edited as name+URL rows, serialized on every edit.
function PhotoPrismCard({ ctx }: { ctx: Ctx }) {
  const instMeta = ctx.fields['PP_INSTANCES'];
  const serverInstances = instMeta?.value ?? '';
  const [rows, setRows] = useState<{ name: string; url: string }[]>(() => parseInstances(serverInstances));
  // Re-init from the server after a save/clear reload (the draft key is gone by then).
  useEffect(() => { setRows(parseInstances(serverInstances)); }, [serverInstances]);

  const commit = (next: { name: string; url: string }[]) => {
    setRows(next);
    ctx.stage('PP_INSTANCES', serializeInstances(next));
  };

  const names = rows.map(r => r.name.trim()).filter(Boolean);
  const defMeta = ctx.fields['PP_DEFAULT'];
  const defValue = ctx.draft['PP_DEFAULT'] ?? defMeta?.value ?? '';
  const options = !defValue || names.includes(defValue) ? names : [defValue, ...names];

  return (
    <div className="card !p-0 overflow-hidden flex flex-col md:col-span-2">
      <CardHeader def={PP_CARD} />
      <div className="p-5 space-y-4">
        <div>
          <div className="flex items-center gap-2 mb-1.5">
            <span className="text-sm font-medium text-slate-300">Instances</span>
            <SourceBadge meta={instMeta} />
            {instMeta?.source === 'app' && <ClearBtn ctx={ctx} k="PP_INSTANCES" />}
          </div>
          <div className="space-y-2">
            {rows.map((r, i) => (
              <div key={i} className="flex gap-2">
                <input className="input !w-32 sm:!w-40 shrink-0" placeholder="name" value={r.name}
                  autoComplete="off" spellCheck={false}
                  onChange={e => commit(rows.map((x, j) => j === i ? { ...x, name: e.target.value } : x))} />
                <input className="input flex-1 min-w-0" placeholder="http://192.168.0.10:2342" value={r.url}
                  autoComplete="off" spellCheck={false}
                  onChange={e => commit(rows.map((x, j) => j === i ? { ...x, url: e.target.value } : x))} />
                <button className="icon-btn shrink-0 text-slate-500 hover:text-accent-red" title="Remove instance"
                  onClick={() => commit(rows.filter((_, j) => j !== i))}>
                  <Icon.Trash size={15} />
                </button>
              </div>
            ))}
            <button className="btn-ghost !py-1.5 !px-2.5 text-xs" onClick={() => setRows([...rows, { name: '', url: '' }])}>
              <Icon.Plus size={14} /> Add instance
            </button>
          </div>
          <p className="text-xs text-slate-500 mt-1.5">One PhotoPrism per family member or library. Rows need both a name and a URL to be saved.</p>
        </div>

        <div className="grid sm:grid-cols-3 gap-4">
          <div>
            <div className="flex items-center gap-2 mb-1.5">
              <span className="text-sm font-medium text-slate-300">Default instance</span>
              <SourceBadge meta={defMeta} />
              {defMeta?.source === 'app' && <ClearBtn ctx={ctx} k="PP_DEFAULT" />}
            </div>
            <div className="relative">
              <select className="input appearance-none pr-9 cursor-pointer" value={defValue}
                onChange={e => ctx.stage('PP_DEFAULT', e.target.value)}>
                <option value="" className="bg-ink-900 text-white">Not set</option>
                {options.map(n => <option key={n} value={n} className="bg-ink-900 text-white">{n}</option>)}
              </select>
              <Icon.ChevronDown size={16} className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-500 pointer-events-none" />
            </div>
          </div>
          <FieldRow ctx={ctx} spec={PP_SPECS[2]} />
          <FieldRow ctx={ctx} spec={PP_SPECS[3]} />
        </div>
      </div>
      <CardFooter ctx={ctx} def={PP_CARD} allSpecs={PP_SPECS} />
    </div>
  );
}

export default function Integrations() {
  const { user } = useAuth();
  const isAdmin = !!user && user.role === 'admin';

  const [fields, setFields] = useState<Fields | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState<string | null>(null);
  const [clearing, setClearing] = useState<string | null>(null);
  const [tests, setTests] = useState<Record<string, TestState>>({});

  const load = () => api.integrations.get()
    .then(r => setFields(r.fields))
    .catch((e: any) => { setFields({}); toast('Could not load integrations', 'error', e?.message); });

  useEffect(() => { if (isAdmin) load(); }, [isAdmin]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!isAdmin) {
    return (
      <div className="animate-fade-in">
        <PageHeader title="Integrations" subtitle="Connect your own services" icon={<Icon.Link size={22} />} />
        <div className="mt-10">
          <EmptyState icon={<Icon.Shield size={30} />} title="Admins only"
            subtitle="You don't have permission to manage integrations. Ask an administrator if you need access." />
        </div>
      </div>
    );
  }

  if (!fields) return <PageLoader />;

  const serverVal = (k: string) => fields[k]?.value ?? '';
  const stage = (k: string, v: string) => setDraft(d => ({ ...d, [k]: v }));
  // Secrets are only "dirty" once the user typed something (empty = unchanged;
  // clearing goes through the explicit Clear button). Non-secrets compare
  // against the server value so retyping the same thing isn't a change.
  const isDirty = (spec: FieldSpec) => {
    if (!(spec.key in draft)) return false;
    if (spec.secret) return draft[spec.key].trim() !== '';
    return draft[spec.key].trim() !== serverVal(spec.key);
  };

  async function saveCard(id: string, specs: FieldSpec[]) {
    const changes: Record<string, string> = {};
    for (const s of specs) if (isDirty(s)) changes[s.key] = draft[s.key].trim();
    if (Object.keys(changes).length === 0) return;
    setSaving(id);
    try {
      await api.integrations.save(changes);
      setDraft(d => { const n = { ...d }; Object.keys(changes).forEach(k => delete n[k]); return n; });
      await load();
      toast('Integration saved', 'success', 'Changes take effect immediately.');
    } catch (e: any) {
      const msg = String(e?.message || '');
      const m = msg.match(/^invalid_value:(\w+)$/);
      toast('Save failed', 'error', m
        ? `Invalid value for ${m[1]} — URLs must start with http:// or https://.`
        : (msg || 'Please try again.'));
    } finally { setSaving(null); }
  }

  async function clearField(key: string) {
    setClearing(key);
    try {
      await api.integrations.save({ [key]: '' });
      setDraft(d => { const n = { ...d }; delete n[key]; return n; });
      await load();
      toast('Value cleared', 'success', 'Falls back to the server environment.');
    } catch (e: any) {
      toast('Clear failed', 'error', e?.message);
    } finally { setClearing(null); }
  }

  async function runTest(service: string) {
    setTests(t => ({ ...t, [service]: { running: true } }));
    try {
      const r = await api.integrations.test(service);
      setTests(t => ({ ...t, [service]: { ok: r.ok, detail: r.detail } }));
    } catch (e: any) {
      setTests(t => ({ ...t, [service]: { ok: false, detail: e?.message || 'test failed' } }));
    }
  }

  const ctx: Ctx = { fields, draft, stage, isDirty, clearField, clearing, saveCard, saving, runTest, tests };

  return (
    <div className="animate-fade-in">
      <PageHeader title="Integrations"
        subtitle="Connect your own services — every integration is optional."
        icon={<Icon.Link size={22} />} />

      <div className="glass rounded-2xl px-5 py-4 mb-6 flex items-start gap-3 border border-white/[0.06]">
        <div className="w-9 h-9 rounded-xl grid place-items-center bg-brand-500/15 text-brand-300 shrink-0">
          <Icon.Info size={18} />
        </div>
        <div>
          <p className="text-sm font-medium text-white">Values saved here take effect immediately and override the server environment.</p>
          <p className="text-xs text-slate-400 mt-0.5 leading-relaxed">
            Clearing a field falls back to the env value. Secrets are write-only — once saved they are never shown again.
            Test checks the connection with whatever is in effect right now.
          </p>
        </div>
      </div>

      {GROUPS.map(g => (
        <section key={g.title} className="mb-8">
          <h2 className="section-title mb-3">{g.title}</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {g.pp && <PhotoPrismCard ctx={ctx} />}
            {g.cards.map(def => <Card key={def.id} ctx={ctx} def={def} />)}
          </div>
        </section>
      ))}
    </div>
  );
}
