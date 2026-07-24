import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
// @ts-ignore - leaflet ships no bundled types in this project
import L from 'leaflet';
// @ts-ignore - side-effect plugin, augments L with markerClusterGroup
import 'leaflet.markercluster';
import 'leaflet/dist/leaflet.css';
import 'leaflet.markercluster/dist/MarkerCluster.css';
import 'leaflet.markercluster/dist/MarkerCluster.Default.css';
import { api } from '../lib/api';
import { Icon } from '../lib/icons';
import { cx, formatBytes, formatDate } from '../lib/utils';
import { toast, useAuth } from '../lib/store';
import { Badge, ConfirmModal, EmptyState, Modal, PageLoader, Spinner } from '../components/ui';
import type { NativePhoto, PhotoAlbum, PhotoAlbumShare, SharedPhotoAlbum } from '../lib/model';

type GeoPoint = { path: string; lat: number; lon: number; takenAt: string | null };

// Coarse location cell (~50m) so a marker opens everything taken nearby.
function cellKey(p: { lat: number; lon: number }) {
  return `${p.lat.toFixed(3)},${p.lon.toFixed(3)}`;
}

// A geo point carries no dimensions/camera; fill the rest so the lightbox is happy.
function geoToPhoto(p: GeoPoint): NativePhoto {
  return { path: p.path, takenAt: p.takenAt, width: null, height: null, size: 0, camera: null, lat: p.lat, lon: p.lon, favorite: false };
}

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

function download(path: string, urlFor: (photoPath: string) => string = api.photos.native.fileUrl) {
  const a = document.createElement('a');
  a.href = urlFor(path);
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

function Tile({ item, selected, selecting, onOpen, onToggle, readOnly = false, thumbUrl = api.photos.native.thumbUrl }: {
  item: NativePhoto; selected: boolean; selecting: boolean; onOpen: () => void; onToggle: () => void;
  readOnly?: boolean; thumbUrl?: (photoPath: string) => string;
}) {
  const [failed, setFailed] = useState(false);
  const lp = useLongPress(onToggle);
  return (
    <button
      {...(readOnly ? {} : lp.handlers)}
      onClick={() => { if (!readOnly && lp.fired.current) return; !readOnly && selecting ? onToggle() : onOpen(); }}
      className={cx('group relative aspect-square overflow-hidden rounded-sm bg-white/[0.04] focus:outline-none focus:ring-2 focus:ring-brand-500', selected && 'ring-2 ring-brand-500')}
    >
      {failed ? (
        <div className="grid h-full w-full place-items-center text-slate-500"><Icon.Image size={24} /></div>
      ) : (
        <img
          src={thumbUrl(item.path)}
          loading="lazy"
          alt={fileName(item.path)}
          onError={() => setFailed(true)}
          className={cx('h-full w-full object-cover transition duration-300', !selecting && 'group-hover:scale-105', selected && 'scale-90 rounded-sm')}
        />
      )}
      {!readOnly && <span
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
      </span>}
      {item.favorite && !selected && <span className="absolute right-1.5 top-1.5 text-pink-400 drop-shadow"><Icon.Heart size={18} filled /></span>}
    </button>
  );
}

function Lightbox({ items, index, onClose, onNav, onDelete, onFavorite, fileUrl = api.photos.native.fileUrl }: {
  items: NativePhoto[]; index: number; onClose: () => void; onNav: (d: number) => void;
  onDelete?: (p: NativePhoto) => void; onFavorite?: (p: NativePhoto) => void;
  fileUrl?: (photoPath: string) => string;
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
            {onFavorite && <button className={cx('icon-btn h-11 w-11 hover:bg-white/10', item.favorite ? 'text-pink-400' : 'text-white')} onClick={() => onFavorite(item)} title={item.favorite ? 'Remove from favourites' : 'Add to favourites'}><Icon.Heart size={19} filled={item.favorite} /></button>}
            <button className={cx('icon-btn h-11 w-11 hover:bg-white/10', info ? 'text-brand-400' : 'text-white')} onClick={() => setInfo(v => !v)} title="Info"><Icon.Info size={19} /></button>
            <button className="icon-btn h-11 w-11 text-white hover:bg-white/10" onClick={() => download(item.path, fileUrl)} title="Download"><Icon.Download size={19} /></button>
            {onDelete && <button className="icon-btn h-11 w-11 text-white hover:bg-accent-red/20 hover:text-accent-red" onClick={() => onDelete(item)} title="Delete"><Icon.Trash size={19} /></button>}
          </div>
        </div>
        <div className="flex flex-1 items-center justify-center overflow-hidden p-3" onClick={onClose}>
          <img
            src={fileUrl(item.path)}
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

// ---- Places map ---------------------------------------------------------
function PlacesMap({ onOpen }: { onOpen: (list: NativePhoto[], index: number) => void }) {
  const [points, setPoints] = useState<GeoPoint[] | null>(null);
  const [failed, setFailed] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<any>(null);
  const onOpenRef = useRef(onOpen);
  onOpenRef.current = onOpen;

  useEffect(() => {
    let alive = true;
    api.photos.native.geo()
      .then(pts => { if (alive) setPoints(Array.isArray(pts) ? pts : []); })
      .catch((e: any) => { if (alive) { setFailed(true); setPoints([]); toast('Failed to load photo map', 'error', e?.message); } });
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    if (!points || points.length === 0 || !containerRef.current) return;
    if (mapRef.current) { mapRef.current.remove(); mapRef.current = null; }

    const map = L.map(containerRef.current, { zoomControl: true, scrollWheelZoom: true, worldCopyJump: true });
    mapRef.current = map;

    // Tiles proxied through our own server so OSM never sees the viewer's IP.
    L.tileLayer('/tiles/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; OpenStreetMap contributors' }).addTo(map);

    const groups = new Map<string, GeoPoint[]>();
    for (const p of points) {
      const k = cellKey(p);
      const g = groups.get(k);
      if (g) g.push(p); else groups.set(k, [p]);
    }

    const cluster = (L as any).markerClusterGroup({ showCoverageOnHover: false, maxClusterRadius: 55, spiderfyOnMaxZoom: true, chunkedLoading: true });
    const bounds = L.latLngBounds([]);
    for (const p of points) {
      const src = api.photos.native.thumbUrl(p.path);
      const icon = L.divIcon({
        className: 'cb-geo-marker',
        html:
          `<div style="width:44px;height:44px;border-radius:12px;overflow:hidden;` +
          `border:2px solid rgba(255,255,255,.9);box-shadow:0 4px 14px rgba(0,0,0,.55);background:#12121c;">` +
          `<img src="${src}" loading="lazy" alt="" style="width:100%;height:100%;object-fit:cover;display:block;" /></div>`,
        iconSize: [48, 48], iconAnchor: [24, 24],
      });
      const marker = L.marker([p.lat, p.lon], { icon });
      marker.on('click', () => {
        const grp = groups.get(cellKey(p)) || [p];
        const idx = Math.max(0, grp.findIndex(q => q.path === p.path));
        onOpenRef.current(grp.map(geoToPhoto), idx);
      });
      cluster.addLayer(marker);
      bounds.extend([p.lat, p.lon]);
    }
    map.addLayer(cluster);
    if (bounds.isValid()) map.fitBounds(bounds, { padding: [48, 48], maxZoom: 14 });
    else map.setView([20, 0], 2);

    const t = setTimeout(() => mapRef.current && mapRef.current.invalidateSize(), 120);
    const onResize = () => mapRef.current && mapRef.current.invalidateSize();
    window.addEventListener('resize', onResize);
    return () => { clearTimeout(t); window.removeEventListener('resize', onResize); map.remove(); mapRef.current = null; };
  }, [points]);

  if (points === null) return <div className="flex justify-center py-16"><Spinner size={26} /></div>;
  if (points.length === 0) {
    return (
      <EmptyState
        icon={<Icon.Cloud size={30} />}
        title={failed ? 'Couldn’t load the map' : 'No places yet'}
        subtitle={failed ? 'The map is unavailable right now. Try again later.' : 'Photos that carry GPS location data will appear on a map here.'}
      />
    );
  }
  const cells = new Set(points.map(cellKey)).size;
  return (
    <div className="relative isolate w-full overflow-hidden rounded-2xl border border-white/10 bg-ink-900 shadow-card animate-fade-in">
      <div className="pointer-events-none absolute left-3 top-3 z-[500] flex items-center gap-2 rounded-full border border-white/10 bg-ink-950/80 px-3 py-1.5 text-xs font-medium text-slate-200 backdrop-blur-md">
        <Icon.Cloud size={14} className="text-brand-400" />
        {points.length.toLocaleString()} photos · {cells.toLocaleString()} place{cells === 1 ? '' : 's'}
      </div>
      <div ref={containerRef} className="h-[70vh] min-h-[420px] w-full [&_.leaflet-container]:bg-ink-900" style={{ touchAction: 'none' }} />
    </div>
  );
}

export default function NativePhotos() {
  const location = useLocation();
  const linkedShareId = useMemo(() => new URLSearchParams(location.search).get('shared'), [location.search]);
  const openedLinkedShare = useRef<string | null>(null);
  const currentUser = useAuth(state => state.user);
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
  const [mapLb, setMapLb] = useState<{ items: NativePhoto[]; index: number } | null>(null);
  const [tab, setTab] = useState<'timeline' | 'favorites' | 'albums' | 'places'>(() =>
    new URLSearchParams(location.search).get('tab') === 'albums' ? 'albums' : 'timeline');
  const [albums, setAlbums] = useState<PhotoAlbum[]>([]);
  const [sharedAlbums, setSharedAlbums] = useState<SharedPhotoAlbum[]>([]);
  const [activeAlbum, setActiveAlbum] = useState<PhotoAlbum | null>(null);
  const [activeSharedAlbum, setActiveSharedAlbum] = useState<SharedPhotoAlbum | null>(null);
  const [albumItems, setAlbumItems] = useState<NativePhoto[]>([]);
  const [favoriteItems, setFavoriteItems] = useState<NativePhoto[]>([]);
  const [collectionLoading, setCollectionLoading] = useState(false);
  const [createAlbumOpen, setCreateAlbumOpen] = useState(false);
  const [albumName, setAlbumName] = useState('');
  const [albumDescription, setAlbumDescription] = useState('');
  const [addToAlbumOpen, setAddToAlbumOpen] = useState(false);
  const [editAlbumOpen, setEditAlbumOpen] = useState(false);
  const [editAlbumName, setEditAlbumName] = useState('');
  const [editAlbumDescription, setEditAlbumDescription] = useState('');
  const [deleteAlbumOpen, setDeleteAlbumOpen] = useState(false);
  const [shareAlbumOpen, setShareAlbumOpen] = useState(false);
  const [albumShares, setAlbumShares] = useState<PhotoAlbumShare[]>([]);
  const [sharePeople, setSharePeople] = useState<{ id: number; username: string; displayName: string; avatarColor: string }[]>([]);
  const [shareRecipientId, setShareRecipientId] = useState<number | null>(null);
  const [sharingLoading, setSharingLoading] = useState(false);
  const [sharingSaving, setSharingSaving] = useState(false);
  const [albumShareToRevoke, setAlbumShareToRevoke] = useState<PhotoAlbumShare | null>(null);
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

  const loadAlbums = useCallback(async () => {
    try {
      const [owned, shared] = await Promise.all([
        api.photos.native.albums(), api.photos.native.sharedAlbums(),
      ]);
      setAlbums(owned.items || []);
      setSharedAlbums(shared.items || []);
    }
    catch (e: any) { toast('Could not load albums', 'error', e?.message); }
  }, []);

  const openAlbum = useCallback(async (album: PhotoAlbum) => {
    setCollectionLoading(true);
    setSelected(new Set());
    try {
      setAlbumItems((await api.photos.native.albumItems(album.id)).items || []);
      setActiveAlbum(album);
      setActiveSharedAlbum(null);
    } catch (e: any) { toast('Could not open album', 'error', e?.message); }
    finally { setCollectionLoading(false); }
  }, []);

  const openSharedAlbum = useCallback(async (album: SharedPhotoAlbum) => {
    setCollectionLoading(true);
    setSelected(new Set());
    try {
      setAlbumItems((await api.photos.native.sharedAlbumItems(album.shareId)).items || []);
      setActiveSharedAlbum(album);
      setActiveAlbum(null);
    } catch (e: any) { toast('Could not open shared album', 'error', e?.message); }
    finally { setCollectionLoading(false); }
  }, []);

  useEffect(() => {
    if (new URLSearchParams(location.search).get('tab') === 'albums') setTab('albums');
    if (!linkedShareId || openedLinkedShare.current === linkedShareId) return;
    const album = sharedAlbums.find(item => item.shareId === linkedShareId);
    if (!album) return;
    openedLinkedShare.current = linkedShareId;
    void openSharedAlbum(album);
  }, [linkedShareId, location.search, openSharedAlbum, sharedAlbums]);

  const openAlbumSharing = async () => {
    if (!activeAlbum) return;
    setShareAlbumOpen(true);
    setSharingLoading(true);
    try {
      const [sharesResult, peopleResult] = await Promise.all([
        api.photos.native.albumShares(activeAlbum.id), api.users(),
      ]);
      const shares = sharesResult.items || [];
      const alreadyShared = new Set(shares.map(share => share.recipient.id));
      const available = peopleResult.filter(person => person.id !== currentUser?.id && !alreadyShared.has(person.id));
      setAlbumShares(shares);
      setSharePeople(available);
      setShareRecipientId(available[0]?.id ?? null);
    } catch (e: any) {
      toast('Could not load album sharing', 'error', e?.message);
      setShareAlbumOpen(false);
    } finally { setSharingLoading(false); }
  };

  const shareActiveAlbum = async () => {
    if (!activeAlbum || !shareRecipientId) return;
    setSharingSaving(true);
    try {
      const share = await api.photos.native.shareAlbum(activeAlbum.id, shareRecipientId);
      setAlbumShares(old => [share, ...old]);
      const remaining = sharePeople.filter(person => person.id !== shareRecipientId);
      setSharePeople(remaining);
      setShareRecipientId(remaining[0]?.id ?? null);
      toast('Album shared privately', 'success', `${share.recipient.displayName} can view it from Photos.`);
    } catch (e: any) {
      toast('Could not share album', 'error', e?.message === 'album_already_shared_with_recipient'
        ? 'This album is already shared with that person.' : e?.message);
    } finally { setSharingSaving(false); }
  };

  const revokeActiveAlbumShare = async () => {
    if (!activeAlbum || !albumShareToRevoke) return;
    const revoked = albumShareToRevoke;
    try {
      await api.photos.native.revokeAlbumShare(activeAlbum.id, revoked.id);
      setAlbumShares(old => old.filter(share => share.id !== revoked.id));
      if (revoked.recipient.active) {
        const person = { id: revoked.recipient.id, username: revoked.recipient.username,
          displayName: revoked.recipient.displayName, avatarColor: revoked.recipient.avatarColor };
        setSharePeople(old => [...old, person].sort((a, b) => a.displayName.localeCompare(b.displayName)));
        setShareRecipientId(value => value ?? person.id);
      }
      setAlbumShareToRevoke(null);
      toast('Album access revoked', 'success');
    } catch (e: any) { toast('Could not revoke album access', 'error', e?.message); }
  };

  const createAlbum = async () => {
    if (!albumName.trim()) return;
    try {
      let album = await api.photos.native.createAlbum({ name: albumName.trim(), description: albumDescription.trim() });
      const paths = selectedItems.map(item => item.path);
      if (paths.length) {
        const added = await api.photos.native.addAlbumItems(album.id, paths);
        album = { ...album, itemCount: added.added, coverPath: paths[0] || null };
      }
      setAlbums(prev => [album, ...prev]);
      setAlbumName(''); setAlbumDescription(''); setCreateAlbumOpen(false);
      if (paths.length) { setSelected(new Set()); setAddToAlbumOpen(false); }
      toast('Album created', 'success', paths.length ? `${paths.length} selected photo${paths.length === 1 ? '' : 's'} added to ${album.name}.` : album.name);
    } catch (e: any) { toast('Could not create album', 'error', e?.message); }
  };

  const applyFavorite = (paths: string[], favorite: boolean) => {
    const picked = new Set(paths);
    const update = (list: NativePhoto[]) => list.map(item => picked.has(item.path) ? { ...item, favorite } : item);
    setItems(update);
    setAlbumItems(update);
    setFavoriteItems(old => favorite
      ? update([...old, ...visibleItems.filter(item => picked.has(item.path) && !old.some(existing => existing.path === item.path))])
      : old.filter(item => !picked.has(item.path)));
    setMapLb(old => old ? { ...old, items: update(old.items) } : old);
  };

  const favoritePhoto = async (photo: NativePhoto) => {
    try {
      await api.photos.native.favorite(photo.path, !photo.favorite);
      applyFavorite([photo.path], !photo.favorite);
    } catch (e: any) { toast('Could not update favourites', 'error', e?.message); }
  };

  const saveAlbum = async () => {
    if (!activeAlbum || !editAlbumName.trim()) return;
    try {
      const updated = await api.photos.native.updateAlbum(activeAlbum.id, { name: editAlbumName.trim(), description: editAlbumDescription.trim() });
      setActiveAlbum(updated);
      setAlbums(old => old.map(album => album.id === updated.id ? updated : album));
      setEditAlbumOpen(false);
      toast('Album updated', 'success');
    } catch (e: any) { toast('Could not update album', 'error', e?.message); }
  };

  const setAlbumCover = async () => {
    if (!activeAlbum || selectedItems.length !== 1) return;
    try {
      const updated = await api.photos.native.updateAlbum(activeAlbum.id, { coverPath: selectedItems[0].path });
      setActiveAlbum(updated);
      setAlbums(old => old.map(album => album.id === updated.id ? updated : album));
      setSelected(new Set());
      toast('Album cover updated', 'success');
    } catch (e: any) { toast('Could not set album cover', 'error', e?.message); }
  };

  const favoriteSelection = async (favorite: boolean) => {
    const paths = selectedItems.map(item => item.path);
    if (!paths.length) return;
    try {
      await Promise.all(paths.map(photoPath => api.photos.native.favorite(photoPath, favorite)));
      applyFavorite(paths, favorite);
      setSelected(new Set());
      toast(favorite ? 'Added to favourites' : 'Removed from favourites', 'success');
    } catch (e: any) { toast('Could not update favourites', 'error', e?.message); }
  };

  const addSelectionToAlbum = async (album: PhotoAlbum) => {
    const paths = selectedItems.map(item => item.path);
    if (!paths.length) return;
    try {
      const result = await api.photos.native.addAlbumItems(album.id, paths);
      await loadAlbums();
      if (activeAlbum?.id === album.id) await openAlbum({ ...album, itemCount: album.itemCount + result.added });
      setSelected(new Set()); setAddToAlbumOpen(false);
      toast('Added to album', 'success', `${result.added} photo${result.added === 1 ? '' : 's'} added to ${album.name}.`);
    } catch (e: any) { toast('Could not add to album', 'error', e?.message); }
  };

  const removeSelectionFromAlbum = async () => {
    if (!activeAlbum || !selectedItems.length) return;
    try {
      await api.photos.native.removeAlbumItems(activeAlbum.id, selectedItems.map(item => item.path));
      const removed = new Set(selectedItems.map(item => item.path));
      setAlbumItems(old => old.filter(item => !removed.has(item.path)));
      setSelected(new Set());
      await loadAlbums();
      toast('Removed from album', 'success', 'The original photos were kept.');
    } catch (e: any) { toast('Could not update album', 'error', e?.message); }
  };

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

  useEffect(() => { void loadAlbums(); }, [loadAlbums]);

  useEffect(() => {
    if (tab !== 'favorites') return;
    let active = true;
    setCollectionLoading(true);
    api.photos.native.favorites().then(result => { if (active) setFavoriteItems(result.items || []); })
      .catch((e: any) => { if (active) toast('Could not load favourites', 'error', e?.message); })
      .finally(() => { if (active) setCollectionLoading(false); });
    return () => { active = false; };
  }, [tab]);

  useEffect(() => {
    if (!sentinel.current || !cursor || loading) return;
    const el = sentinel.current;
    const io = new IntersectionObserver(entries => {
      if (entries[0].isIntersecting && cursor && !loading) loadPage(false);
    }, { rootMargin: '700px' });
    io.observe(el);
    return () => io.disconnect();
  }, [cursor, loading, loadPage]);

  const viewingAlbum = activeAlbum || activeSharedAlbum;
  const visibleItems = tab === 'favorites' ? favoriteItems : tab === 'albums' && viewingAlbum ? albumItems : items;
  const groups = useMemo(() => groupByMonth(visibleItems), [visibleItems]);
  const selectedItems = visibleItems.filter(i => selected.has(i.path));

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
      setAlbumItems(prev => prev.filter(i => !paths.includes(i.path)));
      setFavoriteItems(prev => prev.filter(i => !paths.includes(i.path)));
      setCount(c => Math.max(0, c - paths.length));
      setSelected(new Set());
      setLightbox(null);
      void loadAlbums();
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

      <div className="mb-5 flex flex-wrap gap-1.5">
        {([
          { key: 'timeline', label: 'Timeline', icon: <Icon.Photos size={15} /> },
          { key: 'favorites', label: 'Favourites', icon: <Icon.Heart size={15} /> },
          { key: 'albums', label: 'Albums', icon: <Icon.Folder size={15} /> },
          { key: 'places', label: 'Places', icon: <Icon.Cloud size={15} /> },
        ] as const).map(t => (
          <button
            key={t.key}
            onClick={() => { setTab(t.key); setSelected(new Set()); setLightbox(null); if (t.key !== 'albums') { setActiveAlbum(null); setActiveSharedAlbum(null); } }}
            className={cx('flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-sm font-medium transition',
              tab === t.key ? 'bg-white/10 text-white' : 'text-slate-400 hover:text-white')}
          >
            {t.icon}{t.label}
          </button>
        ))}
      </div>

      {tab === 'places' && <PlacesMap onOpen={(list, index) => setMapLb({ items: list, index })} />}

      {tab === 'albums' && !viewingAlbum && (
        <div className="animate-fade-in">
          <div className="mb-4 flex items-center justify-between gap-3">
            <div><h2 className="text-lg font-semibold text-white">Your albums</h2><p className="text-sm muted">Curate photos without moving or duplicating the originals.</p></div>
            <button className="btn-primary" onClick={() => setCreateAlbumOpen(true)}><Icon.Plus size={15} /> New album</button>
          </div>
          {collectionLoading ? <div className="grid place-items-center py-16"><Spinner /></div> : albums.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-white/[0.08] p-6 text-center">
              <Icon.Folder size={28} className="mx-auto text-slate-600" />
              <p className="mt-2 text-sm font-medium text-white">No albums of your own yet</p>
              <p className="mt-1 text-xs muted">Create one for a trip, event, or favourite collection.</p>
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
              {albums.map(album => (
                <button key={album.id} onClick={() => void openAlbum(album)} className="card overflow-hidden text-left transition hover:border-brand-500/30">
                  <div className="aspect-square bg-white/[0.035]">
                    {album.coverPath ? <img src={api.photos.native.thumbUrl(album.coverPath)} alt="" className="h-full w-full object-cover" loading="lazy" />
                      : <div className="grid h-full place-items-center text-slate-600"><Icon.Photos size={36} /></div>}
                  </div>
                  <div className="p-3"><p className="truncate text-sm font-semibold text-white">{album.name}</p><p className="mt-0.5 text-xs muted">{album.itemCount} photo{album.itemCount === 1 ? '' : 's'}</p></div>
                </button>
              ))}
            </div>
          )}

          <section className="mt-8" aria-labelledby="shared-photo-albums-heading">
            <div className="mb-4 flex items-end justify-between gap-3">
              <div><h2 id="shared-photo-albums-heading" className="text-lg font-semibold text-white">Shared with you</h2><p className="text-sm muted">Private, view-only albums from household members.</p></div>
              <span className="text-xs muted">{sharedAlbums.length}</span>
            </div>
            {sharedAlbums.length === 0 ? (
              <div className="rounded-2xl border border-white/[0.06] p-5 text-sm muted">No household member has shared a photo album with you.</div>
            ) : (
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
                {sharedAlbums.map(album => (
                  <button key={album.shareId} onClick={() => void openSharedAlbum(album)} className="card overflow-hidden text-left transition hover:border-brand-500/30">
                    <div className="relative aspect-square bg-white/[0.035]">
                      {album.coverPath ? <img src={api.photos.native.sharedThumbUrl(album.shareId, album.coverPath)} alt="" className="h-full w-full object-cover" loading="lazy" />
                        : <div className="grid h-full place-items-center text-slate-600"><Icon.Photos size={36} /></div>}
                      <span className="absolute right-2 top-2 rounded-full border border-white/10 bg-ink-950/85 px-2 py-1 text-[10px] font-medium text-brand-200 backdrop-blur"><Icon.Eye size={11} className="mr-1 inline" /> View only</span>
                    </div>
                    <div className="p-3"><p className="truncate text-sm font-semibold text-white">{album.name}</p><p className="mt-0.5 truncate text-xs muted">{album.itemCount} photo{album.itemCount === 1 ? '' : 's'} · {album.owner.displayName}</p></div>
                  </button>
                ))}
              </div>
            )}
          </section>
        </div>
      )}

      {tab === 'albums' && viewingAlbum && (
        <div className="mb-4 flex flex-wrap items-center gap-3 rounded-2xl border border-white/[0.07] bg-white/[0.025] p-4">
          <button className="icon-btn" onClick={() => { setActiveAlbum(null); setActiveSharedAlbum(null); setAlbumItems([]); setSelected(new Set()); }} title="Back to albums"><Icon.ChevronLeft size={18} /></button>
          <div className="min-w-0 flex-1"><h2 className="truncate text-lg font-semibold text-white">{viewingAlbum.name}</h2>{viewingAlbum.description && <p className="truncate text-sm muted">{viewingAlbum.description}</p>}{activeSharedAlbum && <p className="truncate text-xs text-brand-300">Shared by {activeSharedAlbum.owner.displayName}</p>}</div>
          {activeSharedAlbum ? <Badge color="cyan"><Icon.Eye size={12} /> View only</Badge> : <>
            <button className="btn-secondary" onClick={() => void openAlbumSharing()}><Icon.Share size={15} /> Share</button>
            <button className="btn-secondary" onClick={() => { setEditAlbumName(activeAlbum!.name); setEditAlbumDescription(activeAlbum!.description); setEditAlbumOpen(true); }}><Icon.Edit size={15} /> Edit</button>
            <button className="btn-secondary" onClick={() => setDeleteAlbumOpen(true)}><Icon.Trash size={15} /> Delete album</button>
          </>}
        </div>
      )}

      {tab !== 'places' && !activeSharedAlbum && (tab !== 'albums' || !!activeAlbum) && selecting && (
        <div className="sticky top-2 z-30 mb-4 flex items-center gap-2 rounded-2xl border border-white/10 bg-ink-950/95 p-2 backdrop-blur-xl shadow-float">
          <span className="px-2 text-sm font-medium text-white">{selected.size} selected</span>
          <button className="btn-ghost !py-1.5" onClick={() => void favoriteSelection(!selectedItems.every(item => item.favorite))}><Icon.Heart size={15} filled={selectedItems.every(item => item.favorite)} /> {selectedItems.every(item => item.favorite) ? 'Unfavourite' : 'Favourite'}</button>
          <button className="btn-ghost !py-1.5" onClick={() => setAddToAlbumOpen(true)}><Icon.Plus size={15} /> Add to album</button>
          {activeAlbum && selectedItems.length === 1 && <button className="btn-ghost !py-1.5" onClick={() => void setAlbumCover()}><Icon.Image size={15} /> Set cover</button>}
          {activeAlbum && <button className="btn-ghost !py-1.5" onClick={() => void removeSelectionFromAlbum()}>Remove from album</button>}
          <button className="btn-ghost !py-1.5" onClick={() => downloadMany(selectedItems.map(i => i.path))}><Icon.Download size={15} /> Download</button>
          <button className="btn-danger !py-1.5" onClick={() => setConfirmDelete(selectedItems.map(i => i.path))}><Icon.Trash size={15} /> Delete</button>
          <button className="btn-ghost !py-1.5 ml-auto" onClick={() => setSelected(new Set())}>Cancel</button>
        </div>
      )}

      {tab !== 'places' && (tab !== 'albums' || !!viewingAlbum) && (
      <div
        onDragOver={activeSharedAlbum ? undefined : e => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={activeSharedAlbum ? undefined : () => setDragOver(false)}
        onDrop={activeSharedAlbum ? undefined : onDrop}
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

        {collectionLoading ? <div className="grid place-items-center py-16"><Spinner /></div> : visibleItems.length === 0 ? (
          <EmptyState
            icon={tab === 'favorites' ? <Icon.Heart size={30} /> : <Icon.Photos size={30} />}
            title={tab === 'favorites' ? 'No favourite photos yet' : viewingAlbum ? 'This album is empty' : 'Drop photos here or tap Upload'}
            subtitle={tab === 'favorites' ? 'Select photos in the timeline and mark them as favourites.' : activeSharedAlbum ? 'The owner has not added any photos yet.' : activeAlbum ? 'Select photos from the timeline and add them to this album.' : undefined}
            action={tab === 'timeline' ? <button className="btn-primary" onClick={() => fileInput.current?.click()}><Icon.Upload size={16} /> Upload</button> : undefined}
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
                    const globalIndex = visibleItems.findIndex(i => i.path === item.path);
                    return (
                      <Tile
                        key={item.path}
                        item={item}
                        selected={selected.has(item.path)}
                        selecting={selecting}
                        onOpen={() => setLightbox(globalIndex)}
                        onToggle={() => toggle(item.path)}
                        readOnly={!!activeSharedAlbum}
                        thumbUrl={activeSharedAlbum ? photoPath => api.photos.native.sharedThumbUrl(activeSharedAlbum.shareId, photoPath) : api.photos.native.thumbUrl}
                      />
                    );
                  })}
                </div>
              </section>
            ))}
            {tab === 'timeline' && <div ref={sentinel} className="h-12" />}
            {tab === 'timeline' && loading && <div className="flex justify-center py-6"><Spinner /></div>}
          </div>
        )}
      </div>
      )}

      <ConfirmModal
        open={!!confirmDelete}
        onClose={() => setConfirmDelete(null)}
        onConfirm={() => confirmDelete && removePaths(confirmDelete)}
        title={`Delete ${confirmDelete?.length || 0} photo${confirmDelete?.length === 1 ? '' : 's'}`}
        message="Deleted photos are moved to Files trash."
        confirmLabel="Delete"
        danger
      />

      <Modal open={createAlbumOpen} onClose={() => setCreateAlbumOpen(false)} title="Create photo album" size="sm">
        <div className="space-y-4">
          <label className="block text-sm text-slate-300">Name<input className="input mt-1" autoFocus maxLength={100} value={albumName} onChange={event => setAlbumName(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') void createAlbum(); }} placeholder="Summer trip" /></label>
          <label className="block text-sm text-slate-300">Description <span className="muted">(optional)</span><textarea className="input mt-1 min-h-20 resize-y" maxLength={1000} value={albumDescription} onChange={event => setAlbumDescription(event.target.value)} /></label>
          <div className="flex justify-end gap-2"><button className="btn-ghost" onClick={() => setCreateAlbumOpen(false)}>Cancel</button><button className="btn-primary" disabled={!albumName.trim()} onClick={() => void createAlbum()}>Create album</button></div>
        </div>
      </Modal>

      <Modal open={addToAlbumOpen} onClose={() => setAddToAlbumOpen(false)} title={`Add ${selected.size} photo${selected.size === 1 ? '' : 's'} to album`} size="sm">
        <div className="space-y-2">
          {albums.length ? albums.map(album => <button key={album.id} className="w-full rounded-xl border border-white/[0.06] p-3 text-left transition hover:bg-white/[0.04]" onClick={() => void addSelectionToAlbum(album)}><span className="block text-sm font-medium text-white">{album.name}</span><span className="text-xs muted">{album.itemCount} photo{album.itemCount === 1 ? '' : 's'}</span></button>)
            : <EmptyState icon={<Icon.Folder size={26} />} title="No albums yet" action={<button className="btn-primary" onClick={() => { setAddToAlbumOpen(false); setCreateAlbumOpen(true); }}>Create album</button>} />}
        </div>
      </Modal>

      <Modal open={editAlbumOpen} onClose={() => setEditAlbumOpen(false)} title="Edit photo album" size="sm">
        <div className="space-y-4">
          <label className="block text-sm text-slate-300">Name<input className="input mt-1" autoFocus maxLength={100} value={editAlbumName} onChange={event => setEditAlbumName(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') void saveAlbum(); }} /></label>
          <label className="block text-sm text-slate-300">Description <span className="muted">(optional)</span><textarea className="input mt-1 min-h-20 resize-y" maxLength={1000} value={editAlbumDescription} onChange={event => setEditAlbumDescription(event.target.value)} /></label>
          <div className="flex justify-end gap-2"><button className="btn-ghost" onClick={() => setEditAlbumOpen(false)}>Cancel</button><button className="btn-primary" disabled={!editAlbumName.trim()} onClick={() => void saveAlbum()}>Save changes</button></div>
        </div>
      </Modal>

      <Modal open={shareAlbumOpen} onClose={() => { if (!sharingSaving) setShareAlbumOpen(false); }} title={`Share “${activeAlbum?.name || 'album'}”`} size="sm">
        {sharingLoading ? <div className="grid place-items-center py-12"><Spinner /></div> : <div className="space-y-5">
          <div className="rounded-xl border border-brand-500/20 bg-brand-500/10 p-3 text-sm text-slate-200">
            <div className="flex items-center gap-2 font-medium text-white"><Icon.Shield size={16} className="text-brand-300" /> Private and view-only</div>
            <p className="mt-1 text-xs text-slate-300">Only the household accounts you choose can open this album. They cannot add, remove, edit, or favourite its photos.</p>
          </div>

          <section aria-labelledby="album-access-heading">
            <h3 id="album-access-heading" className="mb-2 text-sm font-medium text-white">People with access</h3>
            {albumShares.length === 0 ? <p className="rounded-xl border border-white/[0.06] p-3 text-sm muted">Only you can view this album right now.</p> : <div className="space-y-2">
              {albumShares.map(share => <div key={share.id} className="flex items-center gap-3 rounded-xl border border-white/[0.06] p-3">
                <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full text-sm font-semibold text-white" style={{ backgroundColor: share.recipient.avatarColor }}>{share.recipient.displayName.slice(0, 1).toUpperCase()}</span>
                <div className="min-w-0 flex-1"><p className="truncate text-sm font-medium text-white">{share.recipient.displayName}</p><p className="truncate text-xs muted">@{share.recipient.username}{share.recipient.active ? ' · View only' : ' · Account inactive'}</p></div>
                <button className="btn-ghost !px-2 !py-1.5 text-accent-red" onClick={() => setAlbumShareToRevoke(share)} aria-label={`Remove ${share.recipient.displayName}'s album access`}>Remove</button>
              </div>)}
            </div>}
          </section>

          <section aria-labelledby="share-album-person-heading">
            <h3 id="share-album-person-heading" className="mb-2 text-sm font-medium text-white">Share with another person</h3>
            {sharePeople.length ? <div className="flex flex-col gap-2 sm:flex-row">
              <select className="form-select min-w-0 flex-1" value={shareRecipientId || ''} onChange={event => setShareRecipientId(Number(event.target.value))} aria-label="Household member">
                {sharePeople.map(person => <option key={person.id} value={person.id}>{person.displayName} (@{person.username})</option>)}
              </select>
              <button className="btn-primary shrink-0" disabled={!shareRecipientId || sharingSaving} onClick={() => void shareActiveAlbum()}>{sharingSaving ? <Spinner size={15} /> : <Icon.Share size={15} />} Share</button>
            </div> : <p className="rounded-xl border border-white/[0.06] p-3 text-sm muted">No other active household account is available to add.</p>}
          </section>
        </div>}
      </Modal>

      <ConfirmModal open={!!albumShareToRevoke} onClose={() => setAlbumShareToRevoke(null)} onConfirm={() => void revokeActiveAlbumShare()}
        title="Remove album access?" message={`${albumShareToRevoke?.recipient.displayName || 'This person'} will lose access immediately. Your album and photos stay unchanged.`}
        confirmLabel="Remove access" danger />

      <ConfirmModal open={deleteAlbumOpen} onClose={() => setDeleteAlbumOpen(false)} onConfirm={async () => {
        if (!activeAlbum) return;
        try {
          await api.photos.native.removeAlbum(activeAlbum.id);
          setAlbums(old => old.filter(album => album.id !== activeAlbum.id));
          setActiveAlbum(null); setAlbumItems([]); setSelected(new Set()); setDeleteAlbumOpen(false);
          toast('Album deleted', 'success', 'The original photos were kept.');
        } catch (e: any) { toast('Could not delete album', 'error', e?.message); }
      }} title="Delete album" message={`Delete “${activeAlbum?.name || ''}”? The photos themselves will remain in your library.`} confirmLabel="Delete album" danger />

      {lightbox != null && (
        <Lightbox
          items={visibleItems}
          index={lightbox}
          onClose={() => setLightbox(null)}
          onNav={d => setLightbox(i => i == null ? i : Math.min(Math.max(i + d, 0), visibleItems.length - 1))}
          onDelete={activeSharedAlbum ? undefined : p => setConfirmDelete([p.path])}
          onFavorite={activeSharedAlbum ? undefined : p => void favoritePhoto(p)}
          fileUrl={activeSharedAlbum ? photoPath => api.photos.native.sharedFileUrl(activeSharedAlbum.shareId, photoPath) : api.photos.native.fileUrl}
        />
      )}

      {mapLb && (
        <Lightbox
          items={mapLb.items}
          index={mapLb.index}
          onClose={() => setMapLb(null)}
          onNav={d => setMapLb(m => m ? { ...m, index: Math.min(Math.max(m.index + d, 0), m.items.length - 1) } : m)}
          onDelete={p => setConfirmDelete([p.path])}
          onFavorite={p => void favoritePhoto(p)}
        />
      )}
    </div>
  );
}
