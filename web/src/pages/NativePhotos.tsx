import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../lib/api';
import { Icon } from '../lib/icons';
import { cx, formatBytes, formatDate } from '../lib/utils';
import { toast } from '../lib/store';
import { ConfirmModal, EmptyState, PageLoader, Spinner } from '../components/ui';
import type { NativePhoto } from '../lib/model';

const PAGE = 200;
const ACCEPT = 'image/jpeg,image/png,image/webp,image/gif,image/heic,image/avif,image/bmp,image/tiff';

function fileName(p: string) {
  return p.split('/').pop() || p;
}

function monthLabel(iso: string | null): string {
  if (!iso) return 'Undated';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'Undated';
  return d.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
}

function monthKey(iso: string | null): string {
  if (!iso) return 'undated';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'undated';
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function groupByMonth(items: NativePhoto[]) {
  const map = new Map<string, { key: string; label: string; items: NativePhoto[] }>();
  for (const item of items) {
    const key = monthKey(item.takenAt);
    let g = map.get(key);
    if (!g) { g = { key, label: monthLabel(item.takenAt), items: [] }; map.set(key, g); }
    g.items.push(item);
  }
  return Array.from(map.values());
}

function download(path: string) {
  const a = document.createElement('a');
  a.href = api.photos.native.fileUrl(path);
  a.download = fileName(path);
  document.body.appendChild(a);
  a.click();
  a.remove();
}

async function downloadMany(paths: string[]) {
  for (const p of paths) {
    download(p);
    await new Promise(r => setTimeout(r, 300));
  }
}

function useLongPress(onLong: () => void, ms = 420) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fired = useRef(false);
  const clear = () => { if (timer.current) { clearTimeout(timer.current); timer.current = null; } };
  return {
    fired,
    handlers: {
      onTouchStart: () => { fired.current = false; clear(); timer.current = setTimeout(() => { fired.current = true; onLong(); }, ms); },
      onTouchMove: clear,
      onTouchEnd: clear,
      onTouchCancel: clear,
    },
  };
}

function Tile({ item, selected, selecting, onOpen, onToggle }: {
  item: NativePhoto; selected: boolean; selecting: boolean; onOpen: () => void; onToggle: () => void;
}) {
  const [failed, setFailed] = useState(false);
  const lp = useLongPress(onToggle);
  return (
    <button
      {...lp.handlers}
      onClick={() => { if (lp.fired.current) return; selecting ? onToggle() : onOpen(); }}
      className={cx('group relative aspect-square overflow-hidden rounded-sm bg-white/[0.04] focus:outline-none focus:ring-2 focus:ring-brand-500', selected && 'ring-2 ring-brand-500')}
    >
      {failed ? (
        <div className="grid h-full w-full place-items-center text-slate-500"><Icon.Image size={24} /></div>
      ) : (
        <img
          src={api.photos.native.thumbUrl(item.path)}
          loading="lazy"
          alt={fileName(item.path)}
          onError={() => setFailed(true)}
          className={cx('h-full w-full object-cover transition duration-300', !selecting && 'group-hover:scale-105', selected && 'scale-90 rounded-sm')}
        />
      )}
      <span
        onClick={e => { e.stopPropagation(); onToggle(); }}
        className={cx(
          'absolute left-1.5 top-1.5 grid h-6 w-6 place-items-center rounded-full border-2 transition',
          'opacity-100 sm:opacity-0 sm:group-hover:opacity-100',
          selected ? 'border-brand-400 bg-brand-500 text-white' : 'border-white/80 bg-black/35 text-transparent',
          selecting && 'opacity-100'
        )}
        title={selected ? 'Deselect' : 'Select'}
      >
        <Icon.Check size={14} />
      </span>
    </button>
  );
}

function Lightbox({ items, index, onClose, onNav, onDelete }: {
  items: NativePhoto[]; index: number; onClose: () => void; onNav: (d: number) => void; onDelete: (p: NativePhoto) => void;
}) {
  const [info, setInfo] = useState(false);
  const item = items[index];
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (e.key === 'ArrowLeft') onNav(-1);
      if (e.key === 'ArrowRight') onNav(1);
      if (e.key.toLowerCase() === 'i') setInfo(v => !v);
    };
    window.addEventListener('keydown', h);
    document.body.style.overflow = 'hidden';
    return () => { window.removeEventListener('keydown', h); document.body.style.overflow = ''; };
  }, [onClose, onNav]);
  if (!item) return null;
  return (
    <div className="fixed inset-0 z-[120] flex bg-black/90 animate-fade-in">
      <div className="relative flex min-w-0 flex-1 flex-col">
        <div className="absolute inset-x-0 top-0 z-20 flex items-center justify-between gap-2 bg-gradient-to-b from-black/70 to-transparent px-3 py-2">
          <button className="icon-btn h-11 w-11 text-white hover:bg-white/10" onClick={onClose} title="Close"><Icon.Close size={22} /></button>
          <div className="min-w-0 flex-1 text-center">
            <p className="truncate text-sm font-medium text-white">{fileName(item.path)}</p>
            <p className="text-xs text-slate-400">{formatDate(item.takenAt)}</p>
          </div>
          <div className="flex items-center gap-1">
            <button className={cx('icon-btn h-11 w-11 hover:bg-white/10', info ? 'text-brand-400' : 'text-white')} onClick={() => setInfo(v => !v)} title="Info"><Icon.Info size={19} /></button>
            <button className="icon-btn h-11 w-11 text-white hover:bg-white/10" onClick={() => download(item.path)} title="Download"><Icon.Download size={19} /></button>
            <button className="icon-btn h-11 w-11 text-white hover:bg-accent-red/20 hover:text-accent-red" onClick={() => onDelete(item)} title="Delete"><Icon.Trash size={19} /></button>
          </div>
        </div>
        <div className="flex flex-1 items-center justify-center overflow-hidden p-3" onClick={onClose}>
          <img
            src={api.photos.native.fileUrl(item.path)}
            alt={fileName(item.path)}
            onClick={e => e.stopPropagation()}
            className="max-h-full max-w-full rounded-lg object-contain shadow-float animate-scale-in"
          />
        </div>
        {index > 0 && <button className="absolute left-3 top-1/2 grid h-12 w-12 -translate-y-1/2 place-items-center rounded-full bg-black/40 text-white hover:bg-black/70" onClick={() => onNav(-1)} title="Previous"><Icon.ChevronLeft size={25} /></button>}
        {index < items.length - 1 && <button className="absolute right-3 top-1/2 grid h-12 w-12 -translate-y-1/2 place-items-center rounded-full bg-black/40 text-white hover:bg-black/70" onClick={() => onNav(1)} title="Next"><Icon.ChevronRight size={25} /></button>}
      </div>
      {info && (
        <aside className="absolute inset-x-0 bottom-0 max-h-[70vh] overflow-y-auto rounded-t-2xl border-t border-white/10 bg-ink-950/95 p-5 backdrop-blur-xl md:static md:w-80 md:rounded-none md:border-l md:border-t-0">
          <h3 className="mb-4 font-semibold text-white">Details</h3>
          <dl className="space-y-4 text-sm">
            <Meta label="Filename" value={fileName(item.path)} />
            <Meta label="Date" value={formatDate(item.takenAt)} />
            <Meta label="Camera" value={item.camera || '-'} />
            <Meta label="Dimensions" value={item.width && item.height ? `${item.width} x ${item.height}` : '-'} />
            <Meta label="Size" value={formatBytes(item.size)} />
          </dl>
          {(item.lat != null && item.lon != null) && (
            <a className="btn-secondary mt-5 w-full justify-center" href={`https://www.openstreetmap.org/?mlat=${item.lat}&mlon=${item.lon}#map=16/${item.lat}/${item.lon}`} target="_blank" rel="noreferrer">
              <Icon.Cloud size={16} /> View location
            </a>
          )}
        </aside>
      )}
    </div>
  );
}

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs uppercase text-slate-500">{label}</dt>
      <dd className="mt-0.5 break-words text-slate-200">{value}</dd>
    </div>
  );
}

export default function NativePhotos() {
  const [items, setItems] = useState<NativePhoto[]>([]);
  const [count, setCount] = useState(0);
  const [cursor, setCursor] = useState<string | null>(null);
  const [init, setInit] = useState(false);
  const [loading, setLoading] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [uploading, setUploading] = useState<{ done: number; total: number; pct: number } | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [lightbox, setLightbox] = useState<number | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string[] | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const sentinel = useRef<HTMLDivElement | null>(null);

  const selecting = selected.size > 0;

  const loadPage = useCallback(async (reset = false) => {
    if (loading) return;
    setLoading(true);
    try {
      const res = await api.photos.native.timeline(reset ? undefined : cursor || undefined, PAGE);
      setItems(prev => reset ? res.items : [...prev, ...res.items]);
      setCursor(res.nextCursor);
    } catch (e: any) {
      toast('Failed to load photos', 'error', e?.message);
    } finally {
      setLoading(false);
      setInit(true);
    }
  }, [cursor, loading]);

  const refresh = useCallback(async () => {
    setCursor(null);
    const status = await api.photos.native.status();
    setCount(status.count);
    await loadPage(true);
  }, [loadPage]);

  const runScan = useCallback(async () => {
    setScanning(true);
    try {
      const res = await api.photos.native.scan();
      setCount(res.count);
      setCursor(null);
      const page = await api.photos.native.timeline(undefined, PAGE);
      setItems(page.items);
      setCursor(page.nextCursor);
      setInit(true);
    } catch (e: any) {
      toast('Scan failed', 'error', e?.message);
    } finally {
      setScanning(false);
    }
  }, []);

  useEffect(() => {
    let alive = true;
    api.photos.native.status()
      .then(async s => {
        if (!alive) return;
        setCount(s.count);
        if (s.count === 0 && !s.lastScan) await runScan();
        else await loadPage(true);
      })
      .catch(() => setInit(true));
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!sentinel.current || !cursor || loading) return;
    const el = sentinel.current;
    const io = new IntersectionObserver(entries => {
      if (entries[0].isIntersecting && cursor && !loading) loadPage(false);
    }, { rootMargin: '700px' });
    io.observe(el);
    return () => io.disconnect();
  }, [cursor, loading, loadPage]);

  const groups = useMemo(() => groupByMonth(items), [items]);
  const selectedItems = items.filter(i => selected.has(i.path));

  const doUpload = async (files: File[]) => {
    const imgs = files.filter(f => /\.(jpe?g|png|webp|gif|heic|avif|bmp|tiff)$/i.test(f.name));
    if (!imgs.length) return;
    setUploading({ done: 0, total: imgs.length, pct: 0 });
    try {
      const created: NativePhoto[] = [];
      for (let i = 0; i < imgs.length; i++) {
        const res = await api.photos.native.upload([imgs[i]], (_done, _total, pct) => setUploading({ done: i, total: imgs.length, pct }));
        created.push(...res.items);
        setUploading({ done: i + 1, total: imgs.length, pct: 100 });
      }
      setItems(prev => [...created, ...prev].sort((a, b) => String(b.takenAt).localeCompare(String(a.takenAt))));
      setCount(c => c + created.length);
      toast('Upload complete', 'success', `${created.length} photo${created.length === 1 ? '' : 's'} added.`);
    } catch (e: any) {
      toast('Upload failed', 'error', e?.message);
    } finally {
      setUploading(null);
    }
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const files = e.dataTransfer.files ? Array.from(e.dataTransfer.files) : [];
    doUpload(files);
  };

  const removePaths = async (paths: string[]) => {
    if (!paths.length) return;
    try {
      await api.photos.native.remove(paths);
      setItems(prev => prev.filter(i => !paths.includes(i.path)));
      setCount(c => Math.max(0, c - paths.length));
      setSelected(new Set());
      setLightbox(null);
      toast('Moved to trash', 'success');
    } catch (e: any) {
      toast('Delete failed', 'error', e?.message);
    }
  };

  const toggle = (p: string) => setSelected(prev => {
    const next = new Set(prev);
    next.has(p) ? next.delete(p) : next.add(p);
    return next;
  });

  if (!init) return <PageLoader />;

  return (
    <div className="animate-fade-in">
      <input ref={fileInput} type="file" accept={ACCEPT} multiple className="hidden" onChange={e => { doUpload(e.target.files ? Array.from(e.target.files) : []); e.target.value = ''; }} />
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-white">Photos</h1>
          <p className="text-sm text-slate-400">{count.toLocaleString()} photo{count === 1 ? '' : 's'}</p>
        </div>
        <div className="flex items-center gap-2">
          {uploading && <span className="text-sm text-slate-400">{uploading.done} / {uploading.total} · {uploading.pct}%</span>}
          <button className="btn-primary" onClick={() => fileInput.current?.click()}><Icon.Upload size={16} /> Upload</button>
          <button className="icon-btn" onClick={runScan} disabled={scanning} title="Rescan">
            {scanning ? <Spinner size={16} /> : <Icon.Refresh size={17} />}
          </button>
        </div>
      </div>

      {selecting && (
        <div className="sticky top-2 z-30 mb-4 flex items-center gap-2 rounded-2xl border border-white/10 bg-ink-950/95 p-2 backdrop-blur-xl shadow-float">
          <span className="px-2 text-sm font-medium text-white">{selected.size} selected</span>
          <button className="btn-ghost !py-1.5" onClick={() => downloadMany(selectedItems.map(i => i.path))}><Icon.Download size={15} /> Download</button>
          <button className="btn-danger !py-1.5" onClick={() => setConfirmDelete(selectedItems.map(i => i.path))}><Icon.Trash size={15} /> Delete</button>
          <button className="btn-ghost !py-1.5 ml-auto" onClick={() => setSelected(new Set())}>Cancel</button>
        </div>
      )}

      <div
        onDragOver={e => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
        className={cx('relative min-h-[22rem] rounded-2xl transition-all', dragOver && 'ring-2 ring-brand-500/60 ring-offset-2 ring-offset-ink-950 bg-brand-500/[0.04]')}
      >
        {dragOver && (
          <div className="absolute inset-0 z-20 grid place-items-center rounded-2xl bg-ink-950/70 backdrop-blur-sm pointer-events-none">
            <div className="text-center">
              <Icon.Upload size={38} className="mx-auto mb-2 text-brand-400" />
              <p className="font-semibold text-white">Drop photos here</p>
            </div>
          </div>
        )}

        {items.length === 0 ? (
          <EmptyState
            icon={<Icon.Photos size={30} />}
            title="Drop photos here or tap Upload"
            action={<button className="btn-primary" onClick={() => fileInput.current?.click()}><Icon.Upload size={16} /> Upload</button>}
          />
        ) : (
          <div className="space-y-7">
            {groups.map(g => (
              <section key={g.key} id={`native-month-${g.key}`}>
                <div className="sticky top-0 z-10 mb-2 bg-ink-950/85 py-2 backdrop-blur">
                  <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-300">{g.label}</h2>
                </div>
                <div className="grid grid-cols-3 gap-1 sm:grid-cols-4 lg:grid-cols-6">
                  {g.items.map(item => {
                    const globalIndex = items.findIndex(i => i.path === item.path);
                    return (
                      <Tile
                        key={item.path}
                        item={item}
                        selected={selected.has(item.path)}
                        selecting={selecting}
                        onOpen={() => setLightbox(globalIndex)}
                        onToggle={() => toggle(item.path)}
                      />
                    );
                  })}
                </div>
              </section>
            ))}
            <div ref={sentinel} className="h-12" />
            {loading && <div className="flex justify-center py-6"><Spinner /></div>}
          </div>
        )}
      </div>

      <ConfirmModal
        open={!!confirmDelete}
        onClose={() => setConfirmDelete(null)}
        onConfirm={() => confirmDelete && removePaths(confirmDelete)}
        title={`Delete ${confirmDelete?.length || 0} photo${confirmDelete?.length === 1 ? '' : 's'}`}
        message="Deleted photos are moved to Files trash."
        confirmLabel="Delete"
        danger
      />

      {lightbox != null && (
        <Lightbox
          items={items}
          index={lightbox}
          onClose={() => setLightbox(null)}
          onNav={d => setLightbox(i => i == null ? i : Math.min(Math.max(i + d, 0), items.length - 1))}
          onDelete={p => setConfirmDelete([p.path])}
        />
      )}
    </div>
  );
}
