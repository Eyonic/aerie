// In-app integration setup (admin only) — lets the operator configure every
// backend service (Jellyfin, Jellyseerr, Lidarr, ABS, PhotoPrism, AI engines,
// server addresses) from the UI instead of env vars. Values persist in the
// settings table and take effect IMMEDIATELY (config resolves overrides on
// every read). Env vars remain the fallback, so env-managed installs (e.g.
// the Unraid gen-env flow) keep working with nothing saved here.
import { Router } from 'express';
import { requireAdmin, type AuthedRequest } from '../lib/auth.js';
import { getSetting, setSetting, audit } from '../lib/db.js';
import { setOverride, hasOverride } from '../lib/overrides.js';
import { config, cfgVal } from '../config.js';
import net from 'node:net';

const r = Router();
r.use(requireAdmin);

const SETTING_PREFIX = 'integration.';

// Everything the page may manage. `secret: true` = write-only (never echoed
// back; GET only reports whether a value exists).
const FIELDS: { key: string; secret?: boolean }[] = [
  { key: 'JELLYFIN_URL' }, { key: 'JELLYFIN_API_KEY', secret: true },
  { key: 'ABS_URL' }, { key: 'ABS_API_KEY', secret: true },
  { key: 'JELLYSEERR_URL' }, { key: 'JELLYSEERR_API_KEY', secret: true },
  { key: 'LIDARR_URL' }, { key: 'LIDARR_API_KEY', secret: true },
  { key: 'PP_INSTANCES' }, { key: 'PP_DEFAULT' }, { key: 'PP_USER' }, { key: 'PP_PASSWORD', secret: true },
  { key: 'OLLAMA_URL' }, { key: 'OLLAMA_MODEL' },
  { key: 'DEEPSEEK_URL' }, { key: 'DEEPSEEK_API_KEY', secret: true }, { key: 'DEEPSEEK_MODEL' },
  { key: 'SD_URL' }, { key: 'ACESTEP_URL' }, { key: 'WHISPER_URL' },
  { key: 'PUBLIC_URL' }, { key: 'LAN_URL' }, { key: 'TRANSLATE_LANG' },
  { key: 'CAST_SUBNET' }, { key: 'SERVER_HOST' },
];
const FIELD_MAP = new Map(FIELDS.map(f => [f.key, f]));

// Only http(s) URLs (or empty) for *_URL fields — a saved value lands in
// server-side fetches, so keep junk and exotic schemes out.
function validValue(key: string, value: string): boolean {
  if (value === '') return true;
  if (value.length > 500) return false;
  if (/_URL$/.test(key)) {
    try { const u = new URL(value); return u.protocol === 'http:' || u.protocol === 'https:'; }
    catch { return false; }
  }
  if (key === 'PP_INSTANCES') {
    return value.split(',').every(p => {
      const [name, url] = p.split('=').map(s => s?.trim());
      if (!name || !url) return false;
      try { return ['http:', 'https:'].includes(new URL(url).protocol); } catch { return false; }
    });
  }
  return !/[\r\n]/.test(value);
}

// Current values: non-secret fields echo their effective value + where it came
// from; secrets only report presence.
r.get('/', (_req, res) => {
  const out: Record<string, { value?: string; set: boolean; source: 'app' | 'env' | 'none' }> = {};
  for (const f of FIELDS) {
    const effective = cfgVal(f.key);
    const source = hasOverride(f.key) ? 'app' : (process.env[f.key] ? 'env' : 'none');
    out[f.key] = f.secret
      ? { set: !!effective, source: effective ? source : 'none' }
      : { value: effective, set: !!effective, source: effective ? source : 'none' };
  }
  res.json({ fields: out });
});

// Save: empty string clears the app override (falls back to env).
r.put('/', (req: AuthedRequest, res) => {
  const body = req.body || {};
  const applied: string[] = [];
  for (const [key, raw] of Object.entries(body)) {
    if (!FIELD_MAP.has(key)) return res.status(400).json({ error: `unknown_field:${key}` });
    const value = String(raw ?? '').trim();
    if (!validValue(key, value)) return res.status(400).json({ error: `invalid_value:${key}` });
  }
  for (const [key, raw] of Object.entries(body)) {
    const value = String(raw ?? '').trim();
    setSetting(SETTING_PREFIX + key, value);
    setOverride(key, value);
    applied.push(key);
  }
  // Never log values — some are secrets.
  audit(req.user!.id, req.user!.username, 'integrations_updated', applied.join(','));
  res.json({ ok: true, applied });
});

// Connection tests — server-side probes so the browser never needs LAN access
// or API keys. Uses the EFFECTIVE config (override > env), i.e. "test what
// would actually be used right now".
const TESTS: Record<string, () => Promise<{ ok: boolean; detail: string }>> = {
  jellyfin: () => probeJson(`${config.jellyfin.url}/System/Info?api_key=${encodeURIComponent(config.jellyfin.apiKey)}`,
    d => `Jellyfin ${d.Version || ''} — "${d.ServerName || 'ok'}"`),
  abs: () => probeJson(`${config.audiobookshelf.url}/api/libraries`,
    d => `${(d.libraries || []).length} libraries`, { Authorization: `Bearer ${config.audiobookshelf.apiKey}` }),
  jellyseerr: () => probeJson(`${config.jellyseerr.url}/api/v1/status`,
    d => `Jellyseerr ${d.version || 'ok'}`, { 'X-Api-Key': config.jellyseerr.apiKey }),
  lidarr: () => probeJson(`${config.lidarr.url}/api/v1/system/status`,
    d => `Lidarr ${d.version || 'ok'}`, { 'X-Api-Key': config.lidarr.apiKey }),
  photoprism: () => probeJson(`${config.photoprism.users[config.photoprism.defaultUser] || ''}/api/v1/status`,
    () => `instance "${config.photoprism.defaultUser}" reachable`),
  ollama: () => probeJson(`${config.ollama.url}/api/tags`,
    d => `${(d.models || []).length} models available`),
  deepseek: () => probeJson(`${config.deepseek.url}/models`,
    d => `${(d.data || []).length} models`, { Authorization: `Bearer ${config.deepseek.apiKey}` }),
  comfyui: () => probeJson(`${config.sd.url}/system_stats`,
    d => `ComfyUI up (${d.devices?.[0]?.name || 'gpu'})`),
  acestep: () => probeJson(`${config.acestep.url}/health`, () => 'ACE-Step up'),
  whisper: () => tcpProbe(config.whisper.url, 10300, 'Whisper (Wyoming) port open'),
};

async function probeJson(url: string, describe: (d: any) => string, headers: Record<string, string> = {}) {
  if (!/^https?:\/\//.test(url)) return { ok: false, detail: 'not configured' };
  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(6000) });
    if (!res.ok) return { ok: false, detail: `HTTP ${res.status}` };
    const data = await res.json().catch(() => ({}));
    return { ok: true, detail: describe(data) };
  } catch (e: any) {
    return { ok: false, detail: String(e?.cause?.code || e?.message || 'unreachable').slice(0, 120) };
  }
}

function tcpProbe(url: string, defaultPort: number, okMsg: string): Promise<{ ok: boolean; detail: string }> {
  return new Promise(resolve => {
    let host = '', port = defaultPort;
    try { const u = new URL(url); host = u.hostname; port = Number(u.port) || defaultPort; }
    catch { return resolve({ ok: false, detail: 'not configured' }); }
    const sock = net.connect({ host, port, timeout: 4000 });
    sock.on('connect', () => { sock.destroy(); resolve({ ok: true, detail: okMsg }); });
    sock.on('error', e => resolve({ ok: false, detail: String((e as any).code || 'unreachable') }));
    sock.on('timeout', () => { sock.destroy(); resolve({ ok: false, detail: 'timeout' }); });
  });
}

r.post('/test/:service', async (req, res) => {
  const t = TESTS[req.params.service];
  if (!t) return res.status(400).json({ error: 'unknown_service' });
  res.json(await t());
});

export default r;

// Called once at startup (from index.ts, after the DB is open) to re-apply
// saved settings into the override store.
export function loadIntegrationOverrides() {
  for (const f of FIELDS) {
    const v = getSetting(SETTING_PREFIX + f.key, '');
    if (v) setOverride(f.key, v);
  }
}
