import React, { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { Icon } from '../lib/icons';
import { toast } from '../lib/store';
import { Badge, EmptyState, Modal, PageHeader, PageLoader, Spinner } from '../components/ui';
import type { MediaItem } from '../lib/model';

export default function LibraryTools() {
  const [scan, setScan] = useState<any>(null);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<MediaItem[]>([]);
  const [searching, setSearching] = useState(false);
  const [selected, setSelected] = useState<MediaItem | null>(null);
  const [meta, setMeta] = useState<any>(null);
  const [segments, setSegments] = useState<any[]>([]);
  const [saving, setSaving] = useState(false);
  const loadScan = () => api.media.scanStatus().then(setScan).catch(() => setScan({ configured: false, libraries: [] }));
  useEffect(() => { loadScan(); const t = setInterval(loadScan, 5000); return () => clearInterval(t); }, []);
  const search = async () => { if (!query.trim()) return; setSearching(true); try { setResults(await api.media.search(query)); } finally { setSearching(false); } };
  const open = async (item: MediaItem) => {
    setSelected(item); setMeta(null);
    try { const [m, s] = await Promise.all([api.media.metadata(item.id), api.media.segments(item.id)]); setMeta(m); setSegments(s.segments || []); } catch { setMeta(false); }
  };
  const segmentValue = (kind: string, field: 'startSec' | 'endSec') => segments.find(s => s.kind === kind)?.[field] ?? '';
  const setSegment = (kind: string, field: 'startSec' | 'endSec', value: string) => {
    const next = segments.filter(s => s.kind !== kind); const old = segments.find(s => s.kind === kind) || { kind, startSec: 0, endSec: 0, source: 'manual' };
    next.push({ ...old, [field]: value === '' ? '' : Number(value) }); setSegments(next);
  };
  const save = async () => {
    if (!selected || !meta) return; setSaving(true);
    try {
      await Promise.all([api.media.saveMetadata(selected.id, meta), api.media.saveSegments(selected.id, segments.filter(s => Number(s.endSec) > Number(s.startSec)))]);
      toast('Metadata saved', 'success', meta.name); setSelected(null);
    } catch (e: any) { toast('Save failed', 'error', e?.message); } finally { setSaving(false); }
  };
  const startScan = async () => { await api.media.startScan(); toast('Library scan started', 'success'); setTimeout(loadScan, 800); };

  if (!scan) return <PageLoader />;
  return <div className="animate-fade-in space-y-6">
    <PageHeader title="Library tools" subtitle="Scan status, metadata editing, artwork refresh and skip markers." icon={<Icon.Settings size={22} />} />
    <div className="card p-5">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div><div className="flex items-center gap-2"><h2 className="section-title">Media library scan</h2><Badge color={scan.running ? 'brand' : scan.configured ? 'green' : 'red'}>{scan.running ? 'Running' : scan.configured ? 'Ready' : 'Unavailable'}</Badge></div>
          <p className="text-xs muted mt-1">{scan.libraries?.length || 0} libraries · {scan.lastResult?.end ? `last completed ${new Date(scan.lastResult.end).toLocaleString()}` : 'no completed scan reported'}</p></div>
        <button className="btn-primary" disabled={!scan.configured || scan.running} onClick={startScan}>{scan.running ? <Spinner size={15} /> : <Icon.Refresh size={15} />} {scan.running ? `${Math.round(scan.progress || 0)}%` : 'Scan all libraries'}</button>
      </div>
      {scan.running && <div className="h-2 bg-white/[0.06] rounded-full mt-4 overflow-hidden"><div className="h-full bg-brand-500 transition-all" style={{ width: `${scan.progress || 2}%` }} /></div>}
      <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-2 mt-4">{(scan.libraries || []).map((l: any) => <div key={l.name} className="rounded-xl border border-white/[0.05] p-3"><p className="text-sm text-white">{l.name}</p><p className="text-xs muted capitalize">{l.type} · {l.paths?.length || 0} paths</p></div>)}</div>
    </div>
    <div className="card p-5">
      <h2 className="section-title">Metadata editor</h2><p className="text-xs muted mt-1 mb-4">Find a movie, show, episode, song or personal video and correct its details.</p>
      <form className="flex gap-2" onSubmit={e => { e.preventDefault(); search(); }}><input className="input" value={query} onChange={e => setQuery(e.target.value)} placeholder="Search the media library…" /><button className="btn-secondary" disabled={searching}>{searching ? <Spinner size={15} /> : <Icon.Search size={15} />} Search</button></form>
      {!!results.length && <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-2 mt-4">{results.map(item => <button key={item.id} onClick={() => open(item)} className="rounded-xl bg-white/[0.03] hover:bg-white/[0.06] p-3 flex items-center gap-3 text-left">
        {item.posterUrl ? <img src={item.posterUrl} className="w-11 h-14 rounded object-cover" /> : <div className="w-11 h-14 rounded bg-white/[0.05] grid place-items-center"><Icon.Movie size={18} /></div>}<div className="min-w-0"><p className="text-sm text-white truncate">{item.name}</p><p className="text-xs muted">{item.type}{item.year ? ` · ${item.year}` : ''}</p></div>
      </button>)}</div>}
      {!results.length && query && !searching && <EmptyState icon={<Icon.Search size={25} />} title="Search the library" subtitle="Results will appear here." />}
    </div>
    <Modal open={!!selected} onClose={() => setSelected(null)} title={selected ? `Edit ${selected.name}` : 'Edit metadata'} size="lg" footer={<><button className="btn-ghost" onClick={() => setSelected(null)}>Cancel</button><button className="btn-secondary" onClick={async () => { if (selected) { await api.media.refreshMetadata(selected.id); toast('Refresh queued', 'success'); } }}><Icon.Refresh size={15} /> Refresh from providers</button><button className="btn-primary" disabled={saving} onClick={save}>{saving && <Spinner size={15} />} Save</button></>}>
      {meta === null ? <PageLoader /> : meta === false ? <EmptyState icon={<Icon.Warning size={26} />} title="Could not load metadata" /> : <div className="space-y-4">
        <div className="grid sm:grid-cols-2 gap-3"><label className="text-sm text-slate-300">Title<input className="input mt-1" value={meta.name} onChange={e => setMeta({ ...meta, name: e.target.value })} /></label><label className="text-sm text-slate-300">Sort title<input className="input mt-1" value={meta.sortName} onChange={e => setMeta({ ...meta, sortName: e.target.value })} /></label></div>
        <label className="block text-sm text-slate-300">Overview<textarea className="input mt-1 min-h-28" value={meta.overview} onChange={e => setMeta({ ...meta, overview: e.target.value })} /></label>
        <div className="grid sm:grid-cols-3 gap-3"><label className="text-sm text-slate-300">Year<input type="number" className="input mt-1" value={meta.year || ''} onChange={e => setMeta({ ...meta, year: e.target.value })} /></label><label className="text-sm text-slate-300">Rating<input type="number" min="0" max="10" step="0.1" className="input mt-1" value={meta.communityRating || ''} onChange={e => setMeta({ ...meta, communityRating: e.target.value })} /></label><label className="text-sm text-slate-300">Age rating<input className="input mt-1" value={meta.officialRating || ''} onChange={e => setMeta({ ...meta, officialRating: e.target.value })} /></label></div>
        <label className="block text-sm text-slate-300">Genres<input className="input mt-1" value={(meta.genres || []).join(', ')} onChange={e => setMeta({ ...meta, genres: e.target.value.split(',').map((x: string) => x.trim()).filter(Boolean) })} /></label>
        {['intro', 'credits'].map(kind => <div key={kind}><p className="text-sm font-medium text-slate-200 capitalize">Skip {kind}</p><div className="grid grid-cols-2 gap-3 mt-1"><label className="text-xs muted">Start (seconds)<input type="number" min="0" step="0.1" className="input mt-1" value={segmentValue(kind, 'startSec')} onChange={e => setSegment(kind, 'startSec', e.target.value)} /></label><label className="text-xs muted">End (seconds)<input type="number" min="0" step="0.1" className="input mt-1" value={segmentValue(kind, 'endSec')} onChange={e => setSegment(kind, 'endSec', e.target.value)} /></label></div></div>)}
        <p className="text-[11px] text-slate-600 truncate">Source: {meta.path}</p>
      </div>}
    </Modal>
  </div>;
}
