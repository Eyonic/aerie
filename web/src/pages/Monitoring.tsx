import React, { useState, useEffect, useRef } from 'react';
import { api } from '../lib/api';
import { Icon } from '../lib/icons';
import { cx } from '../lib/utils';
import { toast, useAuth } from '../lib/store';
import { PageLoader, EmptyState, PageHeader, Badge } from '../components/ui';
import type { SystemHealth, ServiceStatus } from '../lib/model';

// ---- helpers ----
function thresholdColor(pct: number): string {
  if (pct >= 85) return '#ef4444';
  if (pct >= 60) return '#f59e0b';
  return '#10b981';
}

// VRAM allocation is normal even at rest — an idle ComfyUI happily parks the model
// in a chunk of VRAM. So don't run it through the load thresholds (which would flash
// "Critical" red at 55%): show it in a neutral/info hue and only warn red when it's
// genuinely near-full (>90%).
function vramColor(pct: number): string {
  return pct >= 90 ? '#ef4444' : '#818cf8';
}

function formatUptime(sec: number): string {
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const parts: string[] = [];
  if (d) parts.push(`${d}d`);
  if (h || d) parts.push(`${h}h`);
  parts.push(`${m}m`);
  return parts.join(' ');
}

// ---- circular gauge ----
function Gauge({ value, label, sublabel, size = 132, color: colorProp }: { value: number; label: string; sublabel?: string; size?: number; color?: string }) {
  const pct = Math.max(0, Math.min(100, value));
  const stroke = 10;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const dash = (pct / 100) * c;
  const color = colorProp || thresholdColor(pct);
  return (
    <div className="relative grid place-items-center" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth={stroke} />
        <circle
          cx={size / 2} cy={size / 2} r={r} fill="none" stroke={color} strokeWidth={stroke}
          strokeLinecap="round" strokeDasharray={`${dash} ${c}`}
          style={{ transition: 'stroke-dasharray 0.7s cubic-bezier(0.4,0,0.2,1), stroke 0.4s ease', filter: `drop-shadow(0 0 6px ${color}66)` }}
        />
      </svg>
      <div className="absolute inset-0 grid place-items-center text-center">
        <div>
          <p className="text-2xl font-bold text-white tracking-tight tabular-nums">{Math.round(pct)}<span className="text-sm text-slate-400 font-medium">%</span></p>
          <p className="text-[11px] uppercase tracking-wide muted mt-0.5">{label}</p>
          {sublabel && <p className="text-[10px] text-slate-500 mt-0.5">{sublabel}</p>}
        </div>
      </div>
    </div>
  );
}

// ---- bar stat card ----
function BarStat({ icon, label, value, sub, pct, color }: { icon: React.ReactNode; label: string; value: string; sub?: string; pct: number; color?: string }) {
  const barColor = color || thresholdColor(pct);
  return (
    <div className="card p-5">
      <div className="flex items-start justify-between mb-3">
        <div className="w-10 h-10 rounded-xl grid place-items-center" style={{ background: `${barColor}22`, color: barColor }}>{icon}</div>
        <span className="text-xs muted tabular-nums">{Math.round(pct)}%</span>
      </div>
      <p className="text-xl font-bold text-white tracking-tight">{value}</p>
      <p className="text-sm muted">{label}</p>
      <div className="mt-3 h-2 rounded-full bg-white/[0.06] overflow-hidden">
        <div className="h-full rounded-full" style={{ width: `${Math.max(2, Math.min(100, pct))}%`, background: barColor, transition: 'width 0.7s cubic-bezier(0.4,0,0.2,1), background 0.4s ease', boxShadow: `0 0 8px ${barColor}66` }} />
      </div>
      {sub && <p className="text-xs text-slate-500 mt-2 truncate">{sub}</p>}
    </div>
  );
}

export default function Monitoring() {
  const { user } = useAuth();
  const [health, setHealth] = useState<SystemHealth | null>(null);
  const [services, setServices] = useState<ServiceStatus[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null);
  const [error, setError] = useState(false);
  const [paused, setPaused] = useState(false);
  const [transcoding, setTranscoding] = useState<any>(null);
  const [alerts, setAlerts] = useState<any>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const mounted = useRef(true);

  const load = async (initial = false) => {
    try {
      const [h, s, t, a] = await Promise.all([
        api.monitoring.health(), api.monitoring.services(), api.monitoring.transcoding().catch(() => null),
        user?.role === 'admin' ? api.monitoring.alerts().catch(() => null) : Promise.resolve(null),
      ]);
      if (!mounted.current) return;
      setHealth(h);
      setServices(s || []);
      setTranscoding(t);
      setAlerts(a);
      setLastUpdate(new Date());
      setError(false);
    } catch (e) {
      if (!mounted.current) return;
      setError(true);
      if (initial) toast('Monitoring unavailable', 'error', 'Could not reach the monitoring backend.');
    } finally {
      if (mounted.current && initial) setLoading(false);
    }
  };

  useEffect(() => {
    mounted.current = true;
    load(true);
    return () => {
      mounted.current = false;
      if (timer.current) clearInterval(timer.current);
    };
  }, []);

  useEffect(() => {
    if (timer.current) { clearInterval(timer.current); timer.current = null; }
    if (!paused) timer.current = setInterval(() => load(false), 5000);
    return () => { if (timer.current) { clearInterval(timer.current); timer.current = null; } };
  }, [paused]);

  if (loading) return <PageLoader />;

  const onlineCount = services?.filter(s => s.online).length ?? 0;
  const totalServices = services?.length ?? 0;

  const memPct = health && health.memTotalGb ? (health.memUsedGb / health.memTotalGb) * 100 : 0;
  const storagePct = health && health.storageTotalTb ? (health.storageUsedTb / health.storageTotalTb) * 100 : 0;
  const vramPct = health && health.gpuMemTotalMb ? ((health.gpuMemUsedMb || 0) / health.gpuMemTotalMb) * 100 : 0;
  const vramUsedGb = (health?.gpuMemUsedMb || 0) / 1024;
  const vramTotalGb = (health?.gpuMemTotalMb || 0) / 1024;
  // ComfyUI exposes VRAM but not utilization, so gpuUtilPct is usually undefined.
  // Only render a util gauge when it's a real number (a genuine idle 0 from the gpu.json
  // cron is valid); when it's missing, VRAM used/total is the primary GPU metric instead.
  const gpuHasUtil = health != null && health.gpuUtilPct != null && Number.isFinite(health.gpuUtilPct);
  // Real core count from the API if it exposes one; never assume 8. Only color load when we know the max.
  const cpuCores = health ? Number((health as any).cpuCores ?? (health as any).cpuCount ?? (health as any).cores ?? 0) || 0 : 0;
  const load1 = health?.loadAvg?.[0] ?? 0;
  const loadColor = cpuCores > 0 ? thresholdColor(Math.min(100, (load1 / cpuCores) * 100)) : undefined;

  return (
    <div className="animate-fade-in">
      <PageHeader
        title="Monitoring"
        subtitle="Live server and service health across your private cloud."
        icon={<Icon.Monitor size={22} />}
        actions={
          <div className="flex items-center gap-2 sm:gap-3">
            <div className="flex items-center gap-2 chip">
              <span className={cx('w-2 h-2 rounded-full', error ? 'bg-accent-red' : paused ? 'bg-slate-500' : 'bg-accent-green')} style={paused ? undefined : { animation: 'pulse 2s infinite' }} />
              <span className="text-xs muted">{error ? 'Reconnecting…' : paused ? 'Paused' : 'Live'}</span>
              {lastUpdate && !error && <span className="text-xs text-slate-500 tabular-nums">{lastUpdate.toLocaleTimeString()}</span>}
            </div>
            <button className="icon-btn" onClick={() => setPaused(p => !p)} title={paused ? 'Resume auto-refresh' : 'Pause auto-refresh'}>
              {paused ? <Icon.Play size={17} /> : <Icon.Pause size={17} />}
            </button>
            <button className="icon-btn" onClick={() => load(false)} title="Refresh now"><Icon.Refresh size={17} /></button>
          </div>
        }
      />

      {!health && !services?.length ? (
        <EmptyState icon={<Icon.Monitor size={28} />} title="No monitoring data" subtitle="The monitoring backend is not configured yet." />
      ) : (
        <div className="space-y-6">
          {/* ---- Circular gauges row ---- */}
          {health && (
            <div className="card p-6">
              <div className="flex items-center justify-between mb-5 flex-wrap gap-3">
                <h2 className="section-title">System vitals</h2>
                <div className="flex items-center gap-3 text-xs">
                  <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full" style={{ background: '#10b981' }} /><span className="muted">Nominal</span></span>
                  <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full" style={{ background: '#f59e0b' }} /><span className="muted">Elevated</span></span>
                  <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full" style={{ background: '#ef4444' }} /><span className="muted">Critical</span></span>
                </div>
              </div>
              <div className="flex flex-wrap items-center justify-around gap-6">
                <Gauge value={health.cpuPct} label="CPU" sublabel={`${(health.loadAvg?.[0] ?? 0).toFixed(2)} load`} />
                <Gauge value={memPct} label="Memory" sublabel={`${health.memUsedGb.toFixed(1)}/${health.memTotalGb.toFixed(0)} GB`} />
                {health.gpuName && (gpuHasUtil
                  ? <Gauge value={health.gpuUtilPct as number} label="GPU" sublabel={`${vramUsedGb.toFixed(1)}/${vramTotalGb.toFixed(0)} GB VRAM`} />
                  : <Gauge value={vramPct} color={vramColor(vramPct)} label="GPU VRAM" sublabel={`${vramUsedGb.toFixed(1)}/${vramTotalGb.toFixed(0)} GB`} />
                )}
                <Gauge value={storagePct} label="Storage" sublabel={`${health.storageUsedTb.toFixed(2)}/${health.storageTotalTb.toFixed(1)} TB`} />
              </div>
            </div>
          )}

          {/* ---- Detail stat cards ---- */}
          {health && (
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
              <BarStat icon={<Icon.Cpu size={20} />} label="CPU usage" value={`${Math.round(health.cpuPct)}%`}
                sub={`Load ${(health.loadAvg || []).map(l => l.toFixed(2)).join(' · ') || '—'}`} pct={health.cpuPct} />
              <BarStat icon={<Icon.Bolt size={20} />} label="Memory" value={`${health.memUsedGb.toFixed(1)} GB`}
                sub={`of ${health.memTotalGb.toFixed(0)} GB total`} pct={memPct} />
              {health.gpuName && (gpuHasUtil ? (
                <BarStat icon={<Icon.Sparkles size={20} />} label={health.gpuName} value={`${Math.round(health.gpuUtilPct as number)}%`}
                  sub={`VRAM ${vramUsedGb.toFixed(1)} / ${vramTotalGb.toFixed(0)} GB`} pct={health.gpuUtilPct as number} />
              ) : (
                <BarStat icon={<Icon.Sparkles size={20} />} label={health.gpuName} value={`${vramUsedGb.toFixed(1)} GB`}
                  sub={`VRAM · ${vramTotalGb.toFixed(0)} GB total`} pct={vramPct} color={vramColor(vramPct)} />
              ))}
              <BarStat icon={<Icon.Cloud size={20} />} label="Storage" value={`${health.storageUsedTb.toFixed(2)} TB`}
                sub={`of ${health.storageTotalTb.toFixed(1)} TB total`} pct={storagePct} />
            </div>
          )}

          {/* ---- secondary row: VRAM (if gpu) + uptime + load + services ---- */}
          {health && (
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
              {health.gpuName && gpuHasUtil && (
                <BarStat icon={<Icon.Image size={20} />} label="VRAM" value={`${vramUsedGb.toFixed(1)} GB`}
                  sub={`of ${vramTotalGb.toFixed(0)} GB`} pct={vramPct} color={vramColor(vramPct)} />
              )}
              <div className="card p-5">
                <div className="w-10 h-10 rounded-xl grid place-items-center mb-3" style={{ background: '#6366f122', color: '#818cf8' }}><Icon.Clock size={20} /></div>
                <p className="text-xl font-bold text-white tracking-tight tabular-nums">{formatUptime(health.uptimeSec)}</p>
                <p className="text-sm muted">Uptime</p>
                <p className="text-xs text-slate-500 mt-2">Since last restart</p>
              </div>
              <div className="card p-5">
                <div className="w-10 h-10 rounded-xl grid place-items-center mb-3" style={{ background: '#06b6d422', color: '#22d3ee' }}><Icon.Cpu size={20} /></div>
                <div className="flex items-end gap-2">
                  {(health.loadAvg?.length ? health.loadAvg : [0, 0, 0]).slice(0, 3).map((l, i) => (
                    <div key={i} className="flex-1 text-center">
                      <p className="text-lg font-bold tabular-nums" style={i === 0 && loadColor ? { color: loadColor } : { color: '#fff' }}>{l.toFixed(2)}</p>
                      <p className="text-[10px] muted">{['1m', '5m', '15m'][i]}</p>
                    </div>
                  ))}
                </div>
                <p className="text-sm muted mt-1">Load average{cpuCores > 0 ? ` · ${cpuCores} cores` : ''}</p>
              </div>
              <div className="card p-5">
                <div className="w-10 h-10 rounded-xl grid place-items-center mb-3" style={{ background: onlineCount === totalServices ? '#10b98122' : '#f59e0b22', color: onlineCount === totalServices ? '#34d399' : '#fbbf24' }}><Icon.Wifi size={20} /></div>
                <p className="text-xl font-bold text-white tracking-tight tabular-nums">{onlineCount}<span className="text-slate-500">/{totalServices}</span></p>
                <p className="text-sm muted">Services online</p>
                <p className="text-xs text-slate-500 mt-2">{totalServices > 0 && onlineCount === totalServices ? 'All systems operational' : `${totalServices - onlineCount} degraded`}</p>
              </div>
            </div>
          )}

          {/* ---- Services grid ---- */}
          {transcoding?.configured && <div className="card p-5">
            <div className="flex items-center justify-between gap-4 flex-wrap">
              <div className="flex items-center gap-3">
                <div className="w-11 h-11 rounded-xl bg-brand-500/15 text-brand-300 grid place-items-center"><Icon.Video size={20} /></div>
                <div><h2 className="section-title">Video transcoding</h2><p className="text-xs muted">Jellyfin {transcoding.serverVersion || ''}</p></div>
              </div>
              <div className="flex gap-2">
                <Badge color={transcoding.hardwareAcceleration && transcoding.hardwareAcceleration !== 'none' ? 'green' : 'amber'}>
                  {transcoding.hardwareAcceleration && transcoding.hardwareAcceleration !== 'none' ? `${transcoding.hardwareAcceleration} hardware` : 'Software encoding'}
                </Badge>
                <Badge color={transcoding.transcoding ? 'brand' : 'slate'}>{transcoding.transcoding || 0} transcoding</Badge>
                <Badge color="slate">{transcoding.directPlaying || 0} direct</Badge>
              </div>
            </div>
            {!!transcoding.active?.length && <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-2 mt-4">
              {transcoding.active.map((s: any) => <div key={s.id} className="rounded-xl bg-white/[0.03] border border-white/[0.05] p-3">
                <p className="text-sm text-white truncate">{s.title}</p><p className="text-xs muted truncate">{s.device} · {s.method}</p>
                {(s.videoCodec || s.hardwareAcceleration) && <p className="text-[11px] text-slate-500 mt-1">{[s.videoCodec, s.hardwareAcceleration].filter(Boolean).join(' · ')}</p>}
              </div>)}
            </div>}
          </div>}

          {alerts && <div className="card p-5">
            <div className="flex items-center justify-between gap-3 flex-wrap mb-4">
              <div><h2 className="section-title">Service alerts</h2><p className="text-xs muted mt-1">Notifications use two failed checks to avoid false alarms.</p></div>
              <label className="flex items-center gap-2 text-sm text-slate-300"><input type="checkbox" checked={alerts.settings.enabled}
                onChange={async e => { const settings = { ...alerts.settings, enabled: e.target.checked }; setAlerts({ ...alerts, settings }); await api.monitoring.saveAlerts(settings); }} /> Enabled</label>
            </div>
            <div className="grid grid-cols-3 gap-3 mb-4">
              {([['storagePct', 'Storage'], ['cpuPct', 'CPU'], ['memoryPct', 'Memory']] as const).map(([key, label]) => <label key={key} className="text-xs muted">{label} threshold
                <div className="flex items-center mt-1"><input className="input !py-1.5" type="number" min={50} max={100} value={alerts.settings[key]}
                  onChange={e => setAlerts({ ...alerts, settings: { ...alerts.settings, [key]: Number(e.target.value) } })}
                  onBlur={() => api.monitoring.saveAlerts(alerts.settings).catch(() => {})} /><span className="-ml-7">%</span></div>
              </label>)}
            </div>
            <div className="space-y-2 max-h-44 overflow-y-auto">
              {(alerts.events || []).slice(0, 10).map((e: any) => <div key={e.id} className="flex items-center gap-3 text-xs border-t border-white/[0.04] pt-2">
                <span className={cx('w-2 h-2 rounded-full shrink-0', e.level === 'error' ? 'bg-accent-red' : e.level === 'success' ? 'bg-accent-green' : 'bg-accent-amber')} />
                <span className="text-slate-300">{e.title}</span><span className="muted truncate flex-1">{e.body}</span><span className="text-slate-600">{new Date(`${e.created_at}Z`).toLocaleString()}</span>
              </div>)}
              {!alerts.events?.length && <p className="text-xs muted">No alert events yet.</p>}
            </div>
          </div>}

          <div className="card !p-0 overflow-hidden">
            <div className="flex items-center justify-between px-5 py-4 border-b border-white/[0.05]">
              <div className="flex items-center gap-3">
                <h2 className="section-title">Services</h2>
                <Badge color={totalServices > 0 && onlineCount === totalServices ? 'green' : onlineCount === 0 ? 'red' : 'amber'}>
                  {onlineCount}/{totalServices} online
                </Badge>
              </div>
            </div>
            {!services || services.length === 0 ? (
              <EmptyState icon={<Icon.Wifi size={28} />} title="No services tracked" subtitle="Connected services will appear here once configured." />
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-px bg-white/[0.04]">
                {services.map(s => (
                  <div key={s.key} className="bg-ink-900 p-4 flex items-center gap-3 hover:bg-white/[0.02] transition-colors">
                    <div className="relative shrink-0 grid place-items-center w-10 h-10">
                      {s.online && <span className="absolute w-3 h-3 rounded-full bg-accent-green/40" style={{ animation: 'ping 2s cubic-bezier(0,0,0.2,1) infinite' }} />}
                      <span className={cx('relative w-3 h-3 rounded-full', s.online ? 'bg-accent-green' : 'bg-accent-red')} style={s.online ? { animation: 'pulse 2s infinite' } : undefined} />
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium text-white truncate">{s.name}</p>
                      <p className="text-xs muted truncate">{s.detail || (s.online ? 'Operational' : 'Unreachable')}</p>
                    </div>
                    <div className="text-right shrink-0">
                      {!s.online ? (
                        <span className="text-xs font-semibold text-accent-red">Offline</span>
                      ) : typeof s.latencyMs === 'number' && s.latencyMs > 0 ? (
                        <>
                          <p className={cx('text-sm font-semibold tabular-nums', s.latencyMs > 300 ? 'text-accent-amber' : 'text-accent-green')}>
                            {Math.round(s.latencyMs)}ms
                          </p>
                          <p className="text-[10px] muted">latency</p>
                        </>
                      ) : (
                        // No meaningfully-measured latency (e.g. Whisper's raw TCP probe rounding to 0)
                        // — show status instead of a misleading "0ms".
                        <span className="text-xs font-semibold text-accent-green">Online</span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <p className="text-center text-xs text-slate-600">{paused ? 'Auto-refresh paused' : 'Auto-refreshing every 5 seconds'}{lastUpdate && ` · updated ${lastUpdate.toLocaleTimeString()}`}</p>
        </div>
      )}
    </div>
  );
}
