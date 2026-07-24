import React, { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { Icon } from '../lib/icons';
import { toast } from '../lib/store';
import { EmptyState, Modal, PageHeader, PageLoader } from '../components/ui';
import { PosterCard, VideoPlayer } from '../components/media';
import type { MediaItem } from '../lib/model';

type Collection = { id: string; name: string; builtin: boolean; rule: any };

export default function Collections() {
  const [collections, setCollections] = useState<Collection[] | null>(null);
  const [selected, setSelected] = useState<Collection | null>(null);
  const [items, setItems] = useState<MediaItem[] | null>(null);
  const [playing, setPlaying] = useState<MediaItem | null>(null);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ name: '', types: 'Movie,Series', genre: '', minRating: '', year: '', sort: 'SortName' });

  const load = () => api.media.collections().then(r => setCollections(r.items)).catch(() => setCollections([]));
  useEffect(() => { void load(); }, []);
  const open = async (c: Collection) => { setSelected(c); setItems(null); try { setItems((await api.media.collectionItems(c.id)).items); } catch { setItems([]); } };
  const create = async () => {
    if (!form.name.trim()) return;
    try {
      await api.media.createCollection({ name: form.name, rule: { types: form.types, genre: form.genre || undefined, minRating: form.minRating || undefined, year: form.year || undefined, sort: form.sort } });
      setCreating(false); setForm({ name: '', types: 'Movie,Series', genre: '', minRating: '', year: '', sort: 'SortName' }); load(); toast('Collection created', 'success');
    } catch (e: any) { toast('Could not create collection', 'error', e?.message); }
  };
  const remove = async (c: Collection) => { if (c.builtin) return; await api.media.removeCollection(c.id); setSelected(null); load(); };

  if (!collections) return <PageLoader />;
  return <div className="animate-fade-in">
    <PageHeader title="Smart collections" subtitle="Dynamic shelves that update automatically as your libraries change." icon={<Icon.Star size={22} />}
      actions={<button className="btn-primary" onClick={() => setCreating(true)}><Icon.Plus size={16} /> New collection</button>} />
    {!collections.length ? <EmptyState icon={<Icon.Star size={28} />} title="No collections" subtitle="Create a smart shelf for your favourite genre, year or rating." /> :
      <div className="grid sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
        {collections.map(c => <button key={c.id} onClick={() => open(c)} className="card card-hover p-5 text-left min-h-36 flex flex-col">
          <div className="w-10 h-10 rounded-xl bg-brand-500/15 text-brand-300 grid place-items-center mb-4"><Icon.Star size={19} /></div>
          <p className="font-semibold text-white">{c.name}</p><p className="text-xs muted mt-1">{c.builtin ? 'Built-in smart shelf' : [c.rule?.genre, c.rule?.year, c.rule?.types].filter(Boolean).join(' · ')}</p>
          <span className="text-xs text-brand-400 mt-auto pt-4">Open collection →</span>
        </button>)}
      </div>}

    <Modal open={!!selected} onClose={() => { setSelected(null); setItems(null); }} title={selected?.name || 'Collection'} size="xl"
      footer={selected && !selected.builtin ? <button className="btn-ghost !text-accent-red" onClick={() => remove(selected)}>Delete collection</button> : undefined}>
      {items === null ? <PageLoader /> : !items.length ? <EmptyState icon={<Icon.Movie size={26} />} title="Nothing matches yet" subtitle="This collection updates automatically when matching media is added." /> :
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-5 gap-4 max-h-[65vh] overflow-y-auto pr-1">
          {items.map(item => <PosterCard key={item.id} item={item} aspect={item.type === 'MusicAlbum' ? 'square' : 'portrait'} onClick={() => {
            if (item.type === 'Movie' || item.type === 'Episode' || item.type === 'Video') setPlaying(item);
          }} />)}
        </div>}
    </Modal>

    <Modal open={creating} onClose={() => setCreating(false)} title="New smart collection" size="md" footer={<><button className="btn-ghost" onClick={() => setCreating(false)}>Cancel</button><button className="btn-primary" onClick={create}>Create</button></>}>
      <div className="space-y-4">
        <label className="block text-sm text-slate-300">Name<input autoFocus className="input mt-1" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} placeholder="Sunday thrillers" /></label>
        <label className="block text-sm text-slate-300">Media<select className="input mt-1" value={form.types} onChange={e => setForm({ ...form, types: e.target.value })}><option value="Movie,Series">Movies & TV</option><option value="Movie">Movies</option><option value="Series">TV shows</option><option value="MusicAlbum">Music albums</option><option value="Audio">Songs</option></select></label>
        <div className="grid grid-cols-2 gap-3"><label className="text-sm text-slate-300">Genre<input className="input mt-1" value={form.genre} onChange={e => setForm({ ...form, genre: e.target.value })} placeholder="Comedy" /></label><label className="text-sm text-slate-300">Year<input type="number" className="input mt-1" value={form.year} onChange={e => setForm({ ...form, year: e.target.value })} /></label></div>
        <label className="block text-sm text-slate-300">Minimum rating<input type="number" min="0" max="10" step="0.1" className="input mt-1" value={form.minRating} onChange={e => setForm({ ...form, minRating: e.target.value })} /></label>
      </div>
    </Modal>
    {playing && <VideoPlayer item={playing} onClose={() => setPlaying(null)} onEpisodeSelect={setPlaying} />}
  </div>;
}
