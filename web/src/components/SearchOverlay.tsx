// ⌘K command palette — search everything (files, media, photos, books) AND run
// quick actions (new doc/sheet, generate image, ask the assistant, jump to any
// page). Full keyboard navigation across actions + results.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { useUi, toast } from '../lib/store';
import { Icon } from '../lib/icons';
import { Spinner } from './ui';
import { debounce } from '../lib/utils';
import type { SearchResponse } from '../lib/model';

type Item = { id: string; label: string; subtitle?: string; thumbUrl?: string; icon?: React.ReactNode; hint?: string; run: () => void };

const PAGES: { label: string; to: string; icon: React.ReactNode; keys: string }[] = [
  { label: 'Dashboard', to: '/', icon: <Icon.Dashboard size={18} />, keys: 'home dashboard' },
  { label: 'Files', to: '/files', icon: <Icon.Files size={18} />, keys: 'files documents storage' },
  { label: 'Photos', to: '/photos', icon: <Icon.Photos size={18} />, keys: 'photos pictures images gallery' },
  { label: 'Movies', to: '/movies', icon: <Icon.Movie size={18} />, keys: 'movies films' },
  { label: 'TV Shows', to: '/tv', icon: <Icon.TV size={18} />, keys: 'tv shows series' },
  { label: 'Music', to: '/music', icon: <Icon.Music size={18} />, keys: 'music songs albums' },
  { label: 'Audiobooks', to: '/audiobooks', icon: <Icon.Book size={18} />, keys: 'audiobooks books' },
  { label: 'Podcasts', to: '/podcasts', icon: <Icon.Podcast size={18} />, keys: 'podcasts' },
  { label: 'Request Movies & TV', to: '/requests', icon: <Icon.Plus size={18} />, keys: 'request jellyseerr' },
  { label: 'Documents', to: '/documents', icon: <Icon.Doc size={18} />, keys: 'documents docs writing' },
  { label: 'Spreadsheets', to: '/spreadsheets', icon: <Icon.Sheet size={18} />, keys: 'spreadsheets sheets excel' },
  { label: 'Image Editor', to: '/image-editor', icon: <Icon.Edit size={18} />, keys: 'image editor photoshop edit' },
  { label: 'AI Image Studio', to: '/ai-images', icon: <Icon.Sparkles size={18} />, keys: 'ai image generate art' },
  { label: 'AI Music Studio', to: '/music-studio', icon: <Icon.Music size={18} />, keys: 'ai music generate' },
  { label: 'AI Assistant', to: '/assistant', icon: <Icon.Robot size={18} />, keys: 'assistant chat ai help' },
  { label: 'Automations', to: '/automations', icon: <Icon.Bolt size={18} />, keys: 'automations rules' },
  { label: 'Backups', to: '/backups', icon: <Icon.Backup size={18} />, keys: 'backups restore' },
  { label: 'Monitoring', to: '/monitoring', icon: <Icon.Monitor size={18} />, keys: 'monitoring health status' },
  { label: 'Settings', to: '/settings', icon: <Icon.Settings size={18} />, keys: 'settings account 2fa security' },
  { label: 'Get the Apps', to: '/get-apps', icon: <Icon.Download size={18} />, keys: 'apps download install' },
];

export function SearchOverlay() {
  const { searchOpen, setSearchOpen } = useUi();
  const [q, setQ] = useState('');
  const [res, setRes] = useState<SearchResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [sel, setSel] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const nav = useNavigate();

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') { e.preventDefault(); setSearchOpen(!searchOpen); }
      if (e.key === 'Escape') setSearchOpen(false);
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [setSearchOpen, searchOpen]);

  useEffect(() => { if (searchOpen) setTimeout(() => inputRef.current?.focus(), 50); else { setQ(''); setRes(null); setSel(0); } }, [searchOpen]);

  const run = useRef(debounce(async (query: string) => {
    if (!query.trim()) { setRes(null); setLoading(false); return; }
    try { setRes(await api.search(query)); } catch { setRes(null); } finally { setLoading(false); }
  }, 260)).current;

  useEffect(() => { setSel(0); if (q.trim()) { setLoading(true); run(q); } else { setRes(null); } }, [q]);

  const close = () => setSearchOpen(false);
  const go = (link: string) => { close(); nav(link); };

  async function newFile(dir: string, name: string, content: string, route: string) {
    close();
    try { const r = await api.files.create(dir, name, content); nav(`${route}?path=${encodeURIComponent(r.path)}`); }
    catch (e: any) { toast('Could not create', 'error', e?.message); }
  }

  // Build the flat, ordered item list: quick actions first, then search results.
  const items: { section: string; items: Item[] }[] = useMemo(() => {
    const query = q.trim();
    const ql = query.toLowerCase();
    const sections: { section: string; items: Item[] }[] = [];

    // Actions (contextual to the query)
    const actions: Item[] = [];
    if (query) {
      actions.push({ id: 'a-assist', label: `Ask the assistant: “${query}”`, icon: <Icon.Robot size={18} />, hint: 'AI', run: () => { close(); nav(`/assistant?q=${encodeURIComponent(query)}`); } });
      actions.push({ id: 'a-img', label: `Generate an image: “${query}”`, icon: <Icon.Sparkles size={18} />, hint: 'AI', run: () => { close(); nav(`/ai-images?prompt=${encodeURIComponent(query)}`); } });
    }
    actions.push({ id: 'a-doc', label: 'New document', icon: <Icon.Doc size={18} />, hint: 'Create', run: () => newFile('/Documents', `Untitled ${new Date().toISOString().slice(0, 16).replace('T', ' ')}.cbxdoc`, '<h1>Untitled</h1><p></p>', '/documents') });
    actions.push({ id: 'a-sheet', label: 'New spreadsheet', icon: <Icon.Sheet size={18} />, hint: 'Create', run: () => newFile('/Spreadsheets', `Untitled ${new Date().toISOString().slice(0, 16).replace('T', ' ')}.cbxsheet`, JSON.stringify({ sheets: [{ name: 'Sheet 1', grid: [['', '', ''], ['', '', '']], formats: {} }], active: 0 }), '/spreadsheets') });
    const filteredActions = query ? actions.filter(a => a.id.startsWith('a-assist') || a.id.startsWith('a-img') || a.label.toLowerCase().includes(ql)) : actions.slice(2);
    if (filteredActions.length) sections.push({ section: 'Actions', items: filteredActions });

    // Page jumps
    const pages = PAGES.filter(p => !query || p.label.toLowerCase().includes(ql) || p.keys.includes(ql))
      .slice(0, query ? 5 : 6)
      .map<Item>(p => ({ id: `p-${p.to}`, label: p.label, subtitle: 'Go to page', icon: p.icon, run: () => go(p.to) }));
    if (pages.length) sections.push({ section: 'Jump to', items: pages });

    // Search results
    if (res) {
      for (const g of res.groups) {
        const its = g.results.map<Item>(r => ({ id: `r-${r.id}`, label: r.title, subtitle: r.subtitle, thumbUrl: r.thumbUrl, run: () => go(r.link) }));
        if (its.length) sections.push({ section: g.label, items: its });
      }
    }
    return sections;
  }, [q, res]);

  const flat = useMemo(() => items.flatMap(s => s.items), [items]);

  useEffect(() => {
    const el = listRef.current?.querySelector(`[data-idx="${sel}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [sel]);

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setSel(s => Math.min(s + 1, flat.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setSel(s => Math.max(s - 1, 0)); }
    else if (e.key === 'Enter') { e.preventDefault(); flat[sel]?.run(); }
  };

  if (!searchOpen) return null;
  let idx = -1;

  return (
    <div className="fixed inset-0 z-[150] bg-black/60 backdrop-blur-sm p-4 pt-[10vh] animate-fade-in" onClick={close}>
      <div className="max-w-2xl mx-auto glass-strong rounded-2xl shadow-float overflow-hidden animate-scale-in" onClick={e => e.stopPropagation()}>
        <div className="flex items-center gap-3 px-4 border-b border-white/[0.06]">
          <Icon.Search size={20} className="text-slate-400" />
          <input ref={inputRef} value={q} onChange={e => setQ(e.target.value)} onKeyDown={onKey}
            placeholder="Search or run a command…"
            className="flex-1 bg-transparent py-4 outline-none text-white placeholder:text-slate-500" />
          {loading && <Spinner size={18} className="text-brand-400" />}
          <kbd className="text-[10px] text-slate-500 border border-white/10 rounded px-1.5 py-0.5 hidden sm:block">ESC</kbd>
        </div>
        <div ref={listRef} className="max-h-[60vh] overflow-y-auto p-2">
          {flat.length === 0 && q.trim() && !loading && <p className="text-center text-sm muted py-10">No results for “{q}”.</p>}
          {items.map(sec => (
            <div key={sec.section} className="mb-1.5">
              <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-500 px-3 py-1.5">{sec.section}</p>
              {sec.items.map(it => {
                idx++; const cur = idx;
                return (
                  <button key={it.id} data-idx={cur} onMouseEnter={() => setSel(cur)} onClick={it.run}
                    className={`w-full flex items-center gap-3 px-3 py-2 rounded-xl text-left transition-colors ${cur === sel ? 'bg-brand-600/25' : 'hover:bg-white/[0.06]'}`}>
                    <div className="w-9 h-9 rounded-lg bg-ink-700 overflow-hidden shrink-0 grid place-items-center text-slate-400">
                      {it.thumbUrl ? <img src={it.thumbUrl} className="w-full h-full object-cover" /> : (it.icon || <Icon.Files size={18} />)}
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="text-sm text-white truncate">{it.label}</p>
                      {it.subtitle && <p className="text-xs muted truncate">{it.subtitle}</p>}
                    </div>
                    {it.hint && <span className="chip text-[10px] shrink-0">{it.hint}</span>}
                    {cur === sel && <Icon.ChevronRight size={15} className="text-slate-500 shrink-0" />}
                  </button>
                );
              })}
            </div>
          ))}
          {!q.trim() && <p className="text-center text-[11px] text-slate-600 py-3">↑↓ to navigate · ↵ to select · ⌘K to toggle</p>}
        </div>
      </div>
    </div>
  );
}
