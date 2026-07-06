import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
// @ts-ignore - leaflet ships no bundled types in this project
import L from 'leaflet';
// @ts-ignore - side-effect plugin, augments L with markerClusterGroup
import 'leaflet.markercluster';
import 'leaflet/dist/leaflet.css';
import 'leaflet.markercluster/dist/MarkerCluster.css';
import 'leaflet.markercluster/dist/MarkerCluster.Default.css';
import { api } from '../lib/api';
import { Icon } from '../lib/icons';
import { cx, formatDate, debounce } from '../lib/utils';
import { toast } from '../lib/store';
import { PageLoader, EmptyState, PageHeader, Spinner, Badge, ConfirmModal } from '../components/ui';
import type { Photo, PhotoAlbum } from '../lib/model';
import NativePhotos from './NativePhotos';

type Tab = 'timeline' | 'albums' | 'favorites' | 'places' | 'explore' | 'people';

// a scene/object category from api.photos.labels()
type Label = { name: string; slug: string; count: number; thumbUrl?: string };
// a named person from api.photos.people()
type Person = { uid: string; name: string; count: number; thumbUrl?: string };

// a geotagged point from api.photos.geo()
type GeoPoint = {
  id: string; uid: string; lat: number; lng: number;
  thumbUrl: string; previewUrl: string; title: string; takenAt: string; type: string;
};

// convert a geo point into a Photo the shared Lightbox understands
function geoToPhoto(g: GeoPoint): Photo {
  return {
    id: g.id, uid: g.uid, title: g.title, takenAt: g.takenAt,
    thumbUrl: g.thumbUrl, previewUrl: g.previewUrl, downloadUrl: g.previewUrl,
    width: 0, height: 0,
    type: (g.type as Photo['type']) || 'image',
    favorite: false,
    lat: g.lat, lng: g.lng,
  };
}
// coarse location cell (~100m) used to group photos taken at the same place
function cellKey(g: GeoPoint): string {
  return `${g.lat.toFixed(3)},${g.lng.toFixed(3)}`;
}
const PAGE = 120;

// ---- helpers ------------------------------------------------------------
function monthKey(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return 'Undated';
  return `${d.getFullYear()}-${String(d.getMonth()).padStart(2, '0')}`;
}
function monthLabel(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return 'Undated';
  const now = new Date();
  const opts: Intl.DateTimeFormatOptions =
    d.getFullYear() === now.getFullYear() ? { month: 'long' } : { month: 'long', year: 'numeric' };
  return d.toLocaleDateString(undefined, opts);
}
function groupByMonth(photos: Photo[]): { key: string; label: string; items: Photo[] }[] {
  const map = new Map<string, { key: string; label: string; items: Photo[] }>();
  for (const p of photos) {
    const k = monthKey(p.takenAt);
    let g = map.get(k);
    if (!g) { g = { key: k, label: monthLabel(p.takenAt), items: [] }; map.set(k, g); }
    g.items.push(p);
  }
  return Array.from(map.values());
}

// sequentially trigger downloads (avoids the browser blocking rapid clicks)
async function downloadMany(photos: Photo[]) {
  for (const p of photos) {
    const a = document.createElement('a');
    a.href = api.photos.thumbUrl(p.downloadUrl);
    a.download = p.title || 'photo';
    document.body.appendChild(a);
    a.click();
    a.remove();
    // small gap so the browser processes each download
    await new Promise(r => setTimeout(r, 350));
  }
}

// ---- photo tile ---------------------------------------------------------
function Tile({
  photo, onClick, selectMode, selected, onToggleSelect,
}: {
  photo: Photo; onClick: () => void;
  selectMode: boolean; selected: boolean; onToggleSelect: () => void;
}) {
  const [loaded, setLoaded] = useState(false);
  const isVideo = photo.type === 'video' || photo.type === 'live';
  return (
    <button
      onClick={selectMode ? onToggleSelect : onClick}
      className={cx(
        'group relative aspect-square overflow-hidden rounded-lg bg-ink-800 focus:outline-none focus:ring-2 focus:ring-brand-500',
        selected && 'ring-2 ring-brand-500'
      )}
    >
      {!loaded && <div className="absolute inset-0 animate-pulse bg-white/[0.04]" />}
      <img
        src={api.photos.thumbUrl(photo.thumbUrl)}
        loading="lazy"
        alt={photo.title}
        onLoad={() => setLoaded(true)}
        className={cx(
          'h-full w-full object-cover transition duration-500',
          !selectMode && 'group-hover:scale-[1.08]',
          selected && 'scale-90 rounded-lg',
          loaded ? 'opacity-100' : 'opacity-0'
        )}
      />
      <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/40 via-transparent to-transparent opacity-0 transition-opacity group-hover:opacity-100" />

      {/* selection checkbox — visible in select mode, or on hover as a shortcut */}
      {(selectMode || !isVideo) && (
        <span
          onClick={e => { e.stopPropagation(); onToggleSelect(); }}
          className={cx(
            'absolute left-1.5 top-1.5 grid h-6 w-6 place-items-center rounded-full border-2 transition',
            selected
              ? 'border-brand-400 bg-brand-500 text-white'
              : 'border-white/80 bg-black/30 text-transparent',
            selectMode ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
          )}
          title={selected ? 'Deselect' : 'Select'}
        >
          <Icon.Check size={14} />
        </span>
      )}

      {photo.favorite && (
        <div className="pointer-events-none absolute right-1.5 top-1.5 text-white drop-shadow">
          <Icon.Heart size={14} filled className="text-accent-pink" />
        </div>
      )}
      {isVideo && (
        <div className="pointer-events-none absolute inset-0 grid place-items-center">
          <div className="grid h-9 w-9 place-items-center rounded-full bg-black/50 backdrop-blur-sm text-white transition-transform group-hover:scale-110">
            <Icon.Play size={16} />
          </div>
        </div>
      )}
    </button>
  );
}

// ---- dense grid ---------------------------------------------------------
function PhotoGrid({
  photos, onOpen, selectMode, selected, onToggleSelect,
}: {
  photos: Photo[]; onOpen: (globalIndex: number) => void;
  selectMode: boolean; selected: Set<string>; onToggleSelect: (p: Photo) => void;
}) {
  const groups = useMemo(() => groupByMonth(photos), [photos]);
  let cursor = 0;
  return (
    <div className="space-y-8">
      {groups.map(g => {
        const start = cursor;
        cursor += g.items.length;
        return (
          <section key={g.key} id={`ph-month-${g.key}`} className="scroll-mt-24">
            <div className="mb-3 flex items-baseline gap-3">
              <h2 className="text-lg font-semibold tracking-tight text-white">{g.label}</h2>
              <span className="text-xs text-slate-500">{g.items.length}</span>
            </div>
            <div className="grid grid-cols-3 gap-1 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-8">
              {g.items.map((p, i) => (
                <Tile
                  key={p.id}
                  photo={p}
                  onClick={() => onOpen(start + i)}
                  selectMode={selectMode}
                  selected={selected.has(p.id)}
                  onToggleSelect={() => onToggleSelect(p)}
                />
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}

// ---- lightbox -----------------------------------------------------------
function Lightbox({
  photos, index, onClose, onNav, onToggleFav, onEdit,
}: {
  photos: Photo[]; index: number; onClose: () => void;
  onNav: (dir: number) => void; onToggleFav: (p: Photo) => void; onEdit: (p: Photo) => void;
}) {
  const [showInfo, setShowInfo] = useState(false);
  const touchX = useRef<number | null>(null);
  const touchY = useRef<number | null>(null);
  const photo = photos[index];

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      else if (e.key === 'ArrowRight') onNav(1);
      else if (e.key === 'ArrowLeft') onNav(-1);
      else if (e.key.toLowerCase() === 'i') setShowInfo(v => !v);
      else if (e.key.toLowerCase() === 'f') onToggleFav(photos[index]);
    };
    window.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => { window.removeEventListener('keydown', onKey); document.body.style.overflow = ''; };
  }, [onClose, onNav, onToggleFav, index, photos]);

  if (!photo) return null;
  const isVideo = photo.type === 'video' || photo.type === 'live';

  const onTouchStart = (e: React.TouchEvent) => {
    touchX.current = e.touches[0].clientX;
    touchY.current = e.touches[0].clientY;
  };
  const onTouchEnd = (e: React.TouchEvent) => {
    if (touchX.current == null || touchY.current == null) return;
    const dx = e.changedTouches[0].clientX - touchX.current;
    const dy = e.changedTouches[0].clientY - touchY.current;
    if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy)) {
      onNav(dx < 0 ? 1 : -1);
    } else if (dy > 90 && Math.abs(dy) > Math.abs(dx)) {
      onClose();
    }
    touchX.current = touchY.current = null;
  };

  return (
    <div className="fixed inset-0 z-[100] flex animate-fade-in bg-black/95 backdrop-blur-xl">
      {/* main stage */}
      <div className="relative flex min-w-0 flex-1 flex-col">
        {/* top bar — z-30 keeps it above the mobile Info sheet (z-20) so its
            controls stay tappable while the sheet is open */}
        <div className="absolute inset-x-0 top-0 z-30 flex items-center justify-between gap-1 bg-gradient-to-b from-black/70 to-transparent px-2 py-2 sm:px-4 sm:py-3">
          <button onClick={onClose} className="icon-btn h-11 w-11 text-white hover:bg-white/10" title="Close (Esc)">
            <Icon.Close size={22} />
          </button>
          <div className="min-w-0 flex-1 px-1 text-center">
            <p className="truncate text-sm font-medium text-white">{photo.title || 'Photo'}</p>
            <p className="text-xs text-slate-400">{formatDate(photo.takenAt)}</p>
          </div>
          <div className="flex items-center gap-0.5 sm:gap-1">
            {!isVideo && (
              <button
                onClick={() => onEdit(photo)}
                className="icon-btn h-11 w-11 text-white hover:bg-white/10"
                title="Edit in Image Editor"
              >
                <Icon.Edit size={19} />
              </button>
            )}
            <button
              onClick={() => onToggleFav(photo)}
              className={cx('icon-btn h-11 w-11 hover:bg-white/10', photo.favorite ? 'text-accent-pink' : 'text-white')}
              title={photo.favorite ? 'Favorite (view-only)' : 'Favorites are view-only here'}
            >
              <Icon.Heart size={20} filled={photo.favorite} />
            </button>
            <a
              href={api.photos.thumbUrl(photo.downloadUrl)}
              download={photo.title || 'photo'}
              className="icon-btn h-11 w-11 text-white hover:bg-white/10"
              title="Download"
            >
              <Icon.Download size={19} />
            </a>
            <button
              onClick={() => setShowInfo(v => !v)}
              className={cx('icon-btn h-11 w-11 hover:bg-white/10', showInfo ? 'text-brand-400' : 'text-white')}
              title="Info (i)"
            >
              <Icon.Info size={19} />
            </button>
          </div>
        </div>

        {/* image / video */}
        <div
          className="flex flex-1 items-center justify-center overflow-hidden p-2 sm:p-4"
          onClick={onClose}
          onTouchStart={onTouchStart}
          onTouchEnd={onTouchEnd}
        >
          {isVideo ? (
            <video
              key={photo.id}
              src={api.photos.thumbUrl(photo.downloadUrl)}
              poster={api.photos.thumbUrl(photo.previewUrl)}
              controls
              autoPlay
              onClick={e => e.stopPropagation()}
              className="max-h-full max-w-full rounded-lg shadow-float animate-scale-in"
            />
          ) : (
            <img
              key={photo.id}
              src={api.photos.thumbUrl(photo.previewUrl)}
              alt={photo.title}
              onClick={e => e.stopPropagation()}
              className="max-h-full max-w-full rounded-lg object-contain shadow-float animate-scale-in"
            />
          )}
        </div>

        {/* nav arrows — large tap targets */}
        {index > 0 && (
          <button
            onClick={() => onNav(-1)}
            className="absolute left-2 top-1/2 grid h-12 w-12 -translate-y-1/2 place-items-center rounded-full bg-black/40 text-white backdrop-blur transition hover:bg-black/70 sm:left-3 sm:h-11 sm:w-11"
            title="Previous (←)"
          >
            <Icon.ChevronLeft size={24} />
          </button>
        )}
        {index < photos.length - 1 && (
          <button
            onClick={() => onNav(1)}
            className="absolute right-2 top-1/2 grid h-12 w-12 -translate-y-1/2 place-items-center rounded-full bg-black/40 text-white backdrop-blur transition hover:bg-black/70 sm:right-3 sm:h-11 sm:w-11"
            title="Next (→)"
          >
            <Icon.ChevronRight size={24} />
          </button>
        )}

        <div className="pointer-events-none absolute inset-x-0 bottom-2 text-center text-xs text-slate-500">
          {index + 1} / {photos.length}
        </div>
      </div>

      {/* info panel — desktop sidebar */}
      {showInfo && (
        <aside className="hidden w-80 shrink-0 border-l border-white/10 bg-ink-950/80 p-6 backdrop-blur-xl animate-fade-in md:block">
          <InfoBody photo={photo} />
        </aside>
      )}

      {/* info panel — mobile slide-up sheet */}
      {showInfo && (
        <div className="fixed inset-0 z-20 flex flex-col justify-end md:hidden" onClick={() => setShowInfo(false)}>
          <div
            className="max-h-[70vh] overflow-y-auto rounded-t-2xl border-t border-white/10 bg-ink-950/95 p-5 backdrop-blur-xl animate-fade-in"
            onClick={e => e.stopPropagation()}
          >
            <div className="mx-auto mb-4 h-1 w-10 rounded-full bg-white/20" />
            <InfoBody photo={photo} />
          </div>
        </div>
      )}
    </div>
  );
}

function InfoBody({ photo }: { photo: Photo }) {
  return (
    <>
      <h3 className="section-title mb-4">Details</h3>
      <dl className="space-y-4 text-sm">
        <Meta icon={<Icon.Clock size={15} />} label="Taken" value={formatDate(photo.takenAt)} />
        <Meta icon={<Icon.Image size={15} />} label="Dimensions" value={photo.width && photo.height ? `${photo.width} × ${photo.height}` : '—'} />
        <Meta icon={<Icon.Photos size={15} />} label="Camera" value={photo.camera || '—'} />
        <Meta icon={<Icon.Video size={15} />} label="Type" value={photo.type} />
        {(photo.lat != null && photo.lng != null) && (
          <Meta icon={<Icon.Cloud size={15} />} label="Location" value={`${photo.lat.toFixed(4)}, ${photo.lng.toFixed(4)}`} />
        )}
      </dl>
      <div className="mt-6">
        {photo.favorite ? <Badge color="red">Favorite</Badge> : null}
      </div>
    </>
  );
}

function Meta({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="flex items-start gap-3">
      <div className="mt-0.5 text-slate-500">{icon}</div>
      <div className="min-w-0">
        <dt className="text-xs uppercase tracking-wide text-slate-500">{label}</dt>
        <dd className="truncate capitalize text-slate-200">{value}</dd>
      </div>
    </div>
  );
}

// ---- album card ---------------------------------------------------------
function AlbumCard({ album, onOpen }: { album: PhotoAlbum; onOpen: () => void }) {
  return (
    <button onClick={onOpen} className="card card-hover group overflow-hidden !p-0 text-left">
      <div className="relative aspect-square overflow-hidden bg-ink-800">
        {album.coverUrl ? (
          <img
            src={api.photos.thumbUrl(album.coverUrl)}
            loading="lazy"
            className="h-full w-full object-cover transition duration-500 group-hover:scale-105"
          />
        ) : (
          <div className="grid h-full w-full place-items-center text-slate-600"><Icon.Photos size={36} /></div>
        )}
        <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/70 via-black/10 to-transparent" />
        <div className="absolute inset-x-0 bottom-0 p-3">
          <p className="truncate text-sm font-semibold text-white drop-shadow">{album.title}</p>
          <p className="text-xs text-slate-300 drop-shadow">{album.count.toLocaleString()} item{album.count === 1 ? '' : 's'}</p>
        </div>
      </div>
    </button>
  );
}

// ---- explore category card ----------------------------------------------
function CategoryCard({ label, onOpen }: { label: Label; onOpen: () => void }) {
  const [loaded, setLoaded] = useState(false);
  return (
    <button
      onClick={onOpen}
      className="card card-hover group relative overflow-hidden !p-0 text-left focus:outline-none focus:ring-2 focus:ring-brand-500"
    >
      <div className="relative aspect-square overflow-hidden bg-ink-800">
        {label.thumbUrl ? (
          <>
            {!loaded && <div className="absolute inset-0 animate-pulse bg-white/[0.04]" />}
            <img
              src={api.photos.thumbUrl(label.thumbUrl)}
              loading="lazy"
              alt={label.name}
              onLoad={() => setLoaded(true)}
              className={cx(
                'h-full w-full object-cover transition duration-500 group-hover:scale-[1.08]',
                loaded ? 'opacity-100' : 'opacity-0'
              )}
            />
          </>
        ) : (
          <div className="grid h-full w-full place-items-center text-slate-600"><Icon.Sparkles size={30} /></div>
        )}
        <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/80 via-black/20 to-transparent" />
        <div className="absolute inset-x-0 bottom-0 p-3">
          <p className="truncate text-sm font-semibold capitalize text-white drop-shadow">{label.name}</p>
          <p className="text-xs text-slate-300 drop-shadow">{label.count.toLocaleString()}</p>
        </div>
      </div>
    </button>
  );
}

// ---- person avatar card -------------------------------------------------
function PersonCard({ person, onOpen }: { person: Person; onOpen: () => void }) {
  const [loaded, setLoaded] = useState(false);
  return (
    <button
      onClick={onOpen}
      className="group flex w-full flex-col items-center gap-2 rounded-2xl p-2 text-center transition hover:bg-white/[0.04] focus:outline-none focus:ring-2 focus:ring-brand-500"
    >
      <div className="relative aspect-square w-full overflow-hidden rounded-full bg-ink-800 ring-2 ring-white/10 transition group-hover:ring-brand-500/60">
        {person.thumbUrl ? (
          <>
            {!loaded && <div className="absolute inset-0 animate-pulse bg-white/[0.04]" />}
            <img
              src={api.photos.thumbUrl(person.thumbUrl)}
              loading="lazy"
              alt={person.name}
              onLoad={() => setLoaded(true)}
              className={cx(
                'h-full w-full object-cover transition duration-500 group-hover:scale-105',
                loaded ? 'opacity-100' : 'opacity-0'
              )}
            />
          </>
        ) : (
          <div className="grid h-full w-full place-items-center text-slate-600"><Icon.Star size={26} /></div>
        )}
      </div>
      <div className="min-w-0 max-w-full">
        <p className="truncate text-sm font-medium text-white">{person.name}</p>
        <p className="text-xs text-slate-500">{person.count.toLocaleString()}</p>
      </div>
    </button>
  );
}

// ---- jump-to-date rail --------------------------------------------------
function JumpBar({ photos }: { photos: Photo[] }) {
  const groups = useMemo(() => groupByMonth(photos), [photos]);
  if (groups.length < 2) return null;
  const jump = (key: string) => {
    const el = document.getElementById(`ph-month-${key}`);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
  return (
    <div className="mb-4 flex items-center gap-2 overflow-x-auto pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      <Icon.Clock size={15} className="shrink-0 text-slate-500" />
      {groups.map(g => (
        <button
          key={g.key}
          onClick={() => jump(g.key)}
          className="chip shrink-0 whitespace-nowrap !py-1 text-xs hover:!text-brand-300"
        >
          {g.label}
        </button>
      ))}
    </div>
  );
}

// ---- places map ---------------------------------------------------------
function PlacesMap({ onOpen }: { onOpen: (list: Photo[], index: number) => void }) {
  const [points, setPoints] = useState<GeoPoint[] | null>(null);
  const [failed, setFailed] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<any>(null);
  // keep the latest onOpen without re-initialising the map
  const onOpenRef = useRef(onOpen);
  onOpenRef.current = onOpen;

  // load geotagged points once, on mount (tab is only rendered when active)
  useEffect(() => {
    let alive = true;
    api.photos.geo()
      .then((pts: GeoPoint[]) => { if (alive) setPoints(Array.isArray(pts) ? pts : []); })
      .catch((e: any) => { if (alive) { setFailed(true); setPoints([]); toast('Failed to load photo map', 'error', e?.message); } });
    return () => { alive = false; };
  }, []);

  // build the Leaflet map once we have points
  useEffect(() => {
    if (!points || points.length === 0 || !containerRef.current) return;

    // guard against a lingering instance (StrictMode / fast tab toggles)
    if (mapRef.current) { mapRef.current.remove(); mapRef.current = null; }

    const map = L.map(containerRef.current, {
      zoomControl: true,
      attributionControl: true,
      scrollWheelZoom: true,
      worldCopyJump: true,
    });
    mapRef.current = map;

    // Tiles are proxied through our own server (privacy: OSM never sees the
    // user's browser/coordinates; also caches + works behind the private domain).
    L.tileLayer('/tiles/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; OpenStreetMap contributors',
    }).addTo(map);

    // group points by coarse location cell so a marker opens everything nearby
    const groups = new Map<string, GeoPoint[]>();
    for (const p of points) {
      const k = cellKey(p);
      const g = groups.get(k);
      if (g) g.push(p); else groups.set(k, [p]);
    }

    const cluster = (L as any).markerClusterGroup({
      showCoverageOnHover: false,
      maxClusterRadius: 55,
      spiderfyOnMaxZoom: true,
      chunkedLoading: true,
    });

    const bounds = L.latLngBounds([]);
    for (const p of points) {
      const src = api.photos.thumbUrl(p.thumbUrl);
      const icon = L.divIcon({
        className: 'cb-geo-marker',
        html:
          `<div style="width:44px;height:44px;border-radius:12px;overflow:hidden;` +
          `border:2px solid rgba(255,255,255,.9);box-shadow:0 4px 14px rgba(0,0,0,.55);background:#12121c;">` +
          `<img src="${src}" loading="lazy" alt="" style="width:100%;height:100%;object-fit:cover;display:block;" />` +
          `</div>`,
        iconSize: [48, 48],
        iconAnchor: [24, 24],
      });
      const marker = L.marker([p.lat, p.lng], { icon, title: p.title || '' });
      marker.on('click', () => {
        const grp = groups.get(cellKey(p)) || [p];
        const list = grp.map(geoToPhoto);
        const idx = Math.max(0, grp.findIndex(q => q.id === p.id));
        onOpenRef.current(list, idx);
      });
      cluster.addLayer(marker);
      bounds.extend([p.lat, p.lng]);
    }
    map.addLayer(cluster);

    if (bounds.isValid()) map.fitBounds(bounds, { padding: [48, 48], maxZoom: 14 });
    else map.setView([20, 0], 2);

    // ensure correct sizing after the container settles / on resize
    const ric = setTimeout(() => mapRef.current && mapRef.current.invalidateSize(), 120);
    const onResize = () => mapRef.current && mapRef.current.invalidateSize();
    window.addEventListener('resize', onResize);

    return () => {
      clearTimeout(ric);
      window.removeEventListener('resize', onResize);
      map.remove();
      mapRef.current = null;
    };
  }, [points]);

  if (points === null) return <div className="flex justify-center py-16"><Spinner size={26} /></div>;

  if (points.length === 0) {
    return (
      <EmptyState
        icon={<Icon.Cloud size={30} />}
        title={failed ? 'Couldn’t load the map' : 'No places yet'}
        subtitle={failed ? 'The photo location service is unavailable. Try again later.' : 'Photos with location data will appear on a map here.'}
      />
    );
  }

  const cells = new Set(points.map(cellKey)).size;

  return (
    <div className="relative isolate w-full overflow-hidden rounded-2xl border border-white/10 bg-ink-900 shadow-card animate-fade-in">
      {/* premium overlay badge */}
      <div className="pointer-events-none absolute left-3 top-3 z-[500] flex items-center gap-2 rounded-full border border-white/10 bg-ink-950/80 px-3 py-1.5 text-xs font-medium text-slate-200 backdrop-blur-md">
        <Icon.Cloud size={14} className="text-brand-400" />
        {points.length.toLocaleString()} photos · {cells.toLocaleString()} place{cells === 1 ? '' : 's'}
      </div>
      <div
        ref={containerRef}
        className="h-[70vh] min-h-[420px] w-full [&_.leaflet-container]:bg-ink-900"
        style={{ touchAction: 'none' }}
      />
    </div>
  );
}

// ---- main page ----------------------------------------------------------
export default function Photos() {
  const navigate = useNavigate();
  const [tab, setTab] = useState<Tab>('timeline');
  const [configured, setConfigured] = useState<boolean | null>(null);

  // timeline
  const [timeline, setTimeline] = useState<Photo[]>([]);
  const [offset, setOffset] = useState(0);
  const [hasMore, setHasMore] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [timelineInit, setTimelineInit] = useState(false);
  const [query, setQuery] = useState('');
  const activeQuery = useRef('');

  // favorites
  const [favorites, setFavorites] = useState<Photo[] | null>(null);

  // albums
  const [albums, setAlbums] = useState<PhotoAlbum[] | null>(null);
  const [openAlbum, setOpenAlbum] = useState<PhotoAlbum | null>(null);
  const [albumPhotos, setAlbumPhotos] = useState<Photo[] | null>(null);

  // explore (scene/object categories)
  const [labels, setLabels] = useState<Label[] | null>(null);
  const [openLabel, setOpenLabel] = useState<Label | null>(null);
  const [labelPhotos, setLabelPhotos] = useState<Photo[] | null>(null);

  // people (named faces)
  const [people, setPeople] = useState<{ people: Person[]; faceClusters: number } | null>(null);
  const [openPerson, setOpenPerson] = useState<Person | null>(null);
  const [personPhotos, setPersonPhotos] = useState<Photo[] | null>(null);

  // lightbox
  const [lightbox, setLightbox] = useState<{ list: Photo[]; index: number } | null>(null);

  // multi-select
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const sentinelRef = useRef<HTMLDivElement | null>(null);

  // status
  useEffect(() => {
    api.photos.status()
      .then(s => setConfigured(s.configured))
      .catch(() => setConfigured(false));
  }, []);

  // ---- timeline loading ----
  const loadTimeline = useCallback(async (reset: boolean, q: string) => {
    if (loadingMore) return;
    setLoadingMore(true);
    try {
      const off = reset ? 0 : offset;
      const batch = await api.photos.timeline(off, PAGE, q);
      setTimeline(prev => (reset ? batch : [...prev, ...batch]));
      setOffset(off + batch.length);
      // PhotoPrism merges pages and can return fewer than `count` (~101) even when
      // more exist at a higher offset — so keep paging until a page comes back EMPTY,
      // never on a short-but-nonzero page.
      setHasMore(batch.length > 0);
    } catch (e: any) {
      toast('Failed to load photos', 'error', e?.message);
      setHasMore(false);
    } finally {
      setLoadingMore(false);
      setTimelineInit(true);
    }
  }, [offset, loadingMore]);

  // initial timeline load
  useEffect(() => {
    if (configured && !timelineInit) loadTimeline(true, '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [configured]);

  // search (debounced)
  const runSearch = useMemo(() => debounce((q: string) => {
    activeQuery.current = q;
    setTimeline([]);
    setOffset(0);
    setHasMore(true);
    loadTimeline(true, q);
  }, 350), [loadTimeline]);

  const onSearchChange = (v: string) => {
    setQuery(v);
    runSearch(v.trim());
  };

  // infinite scroll
  useEffect(() => {
    if (tab !== 'timeline' || !hasMore || !sentinelRef.current) return;
    const el = sentinelRef.current;
    const io = new IntersectionObserver(entries => {
      if (entries[0].isIntersecting && hasMore && !loadingMore) {
        loadTimeline(false, activeQuery.current);
      }
    }, { rootMargin: '600px' });
    io.observe(el);
    return () => io.disconnect();
  }, [tab, hasMore, loadingMore, loadTimeline]);

  // prefetch albums as soon as the library is known — lets us decide whether
  // the Albums tab is worth showing before the user ever clicks it (silent).
  useEffect(() => {
    if (configured && albums === null) {
      api.photos.albums().then(setAlbums).catch(() => setAlbums([]));
    }
  }, [configured, albums]);

  // if the Albums tab gets hidden (no non-empty albums) while it's active,
  // fall back to the timeline so the user isn't stranded on a vanished tab.
  useEffect(() => {
    if (tab === 'albums' && albums !== null && !albums.some(a => a.count > 0)) {
      setTab('timeline');
      setOpenAlbum(null);
      setAlbumPhotos(null);
    }
  }, [tab, albums]);

  // lazy-load per-tab data
  useEffect(() => {
    if (!configured) return;
    if (tab === 'favorites' && favorites === null) {
      api.photos.favorites().then(setFavorites).catch(e => { toast('Failed to load favorites', 'error', e?.message); setFavorites([]); });
    }
    if (tab === 'albums' && albums === null) {
      api.photos.albums().then(setAlbums).catch(e => { toast('Failed to load albums', 'error', e?.message); setAlbums([]); });
    }
    if (tab === 'explore' && labels === null) {
      api.photos.labels().then(l => setLabels(Array.isArray(l) ? l : [])).catch(e => { toast('Failed to load categories', 'error', e?.message); setLabels([]); });
    }
    if (tab === 'people' && people === null) {
      api.photos.people()
        .then(p => setPeople({ people: Array.isArray(p?.people) ? p.people : [], faceClusters: p?.faceClusters ?? 0 }))
        .catch(e => { toast('Failed to load people', 'error', e?.message); setPeople({ people: [], faceClusters: 0 }); });
    }
  }, [tab, configured, favorites, albums, labels, people]);

  const openLabelView = async (label: Label) => {
    setOpenLabel(label);
    setLabelPhotos(null);
    try {
      setLabelPhotos(await api.photos.label(label.slug));
    } catch (e: any) {
      toast('Failed to open category', 'error', e?.message);
      setLabelPhotos([]);
    }
  };

  const openPersonView = async (person: Person) => {
    setOpenPerson(person);
    setPersonPhotos(null);
    try {
      setPersonPhotos(await api.photos.person(person.uid));
    } catch (e: any) {
      toast('Failed to open person', 'error', e?.message);
      setPersonPhotos([]);
    }
  };

  const openAlbumView = async (album: PhotoAlbum) => {
    setOpenAlbum(album);
    setAlbumPhotos(null);
    try {
      setAlbumPhotos(await api.photos.album(album.uid));
    } catch (e: any) {
      toast('Failed to open album', 'error', e?.message);
      setAlbumPhotos([]);
    }
  };

  // Favoriting is view-only: the heart reflects the REAL PhotoPrism favorite
  // state that the server returns, but there is no write endpoint to persist a
  // change from here — so we surface that honestly instead of faking a success.
  const onFavoriteTap = useCallback((_p: Photo) => {
    toast('Favorites are view-only here — manage them in your photo library', 'info');
  }, []);

  const openLightbox = (list: Photo[], index: number) => setLightbox({ list, index });
  const navLightbox = (dir: number) =>
    setLightbox(lb => {
      if (!lb) return lb;
      const i = Math.min(Math.max(lb.index + dir, 0), lb.list.length - 1);
      return { ...lb, index: i };
    });

  const editPhoto = (p: Photo) => {
    navigate(`/image-editor?src=${encodeURIComponent(api.photos.thumbUrl(p.previewUrl))}`);
  };

  // ---- multi-select helpers ----
  const currentList = (): Photo[] =>
    tab === 'timeline' ? timeline
      : tab === 'favorites' ? (favorites ?? [])
        : tab === 'explore' ? (openLabel ? (labelPhotos ?? []) : [])
          : tab === 'people' ? (openPerson ? (personPhotos ?? []) : [])
            : (openAlbum ? (albumPhotos ?? []) : []);

  const toggleSelect = (p: Photo) => {
    setSelectMode(true);
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(p.id)) next.delete(p.id); else next.add(p.id);
      return next;
    });
  };
  const clearSelection = () => { setSelected(new Set()); setSelectMode(false); };
  const selectAll = () => setSelected(new Set(currentList().map(p => p.id)));

  // multi-download is a series of separate browser downloads (no server-side
  // zip endpoint) — so for >1 we confirm first and spell out exactly what happens.
  const [confirmDl, setConfirmDl] = useState(false);

  const runDownload = async (list: Photo[]) => {
    toast(`Starting ${list.length} download${list.length === 1 ? '' : 's'}…`, 'info');
    await downloadMany(list);
    clearSelection();
  };

  const downloadSelected = async () => {
    const list = currentList().filter(p => selected.has(p.id));
    if (!list.length) return;
    if (list.length > 1) { setConfirmDl(true); return; }
    await runDownload(list);
  };

  // reset selection when switching tabs / sub-views
  useEffect(() => { setSelected(new Set()); setSelectMode(false); }, [tab, openAlbum, openLabel, openPerson]);

  // ---- render ----
  if (configured === null) return <PageLoader />;
  if (!configured) return <NativePhotos />;

  // hide empty albums (PhotoPrism keeps 0-item albums around)
  const visibleAlbums = albums?.filter(a => a.count > 0) ?? null;
  // only surface the Albums tab if there's at least one non-empty album; while
  // the prefetch is still in flight (albums === null) we optimistically keep it.
  const showAlbumsTab = albums === null || (visibleAlbums?.length ?? 0) > 0;

  const tabs: { id: Tab; label: string; icon: React.ReactNode }[] = [
    { id: 'timeline', label: 'Timeline', icon: <Icon.Photos size={16} /> },
    ...(showAlbumsTab ? [{ id: 'albums' as Tab, label: 'Albums', icon: <Icon.Grid size={16} /> }] : []),
    { id: 'explore', label: 'Explore', icon: <Icon.Sparkles size={16} /> },
    { id: 'people', label: 'People', icon: <Icon.Star size={16} /> },
    { id: 'favorites', label: 'Favorites', icon: <Icon.Heart size={16} /> },
    { id: 'places', label: 'Places', icon: <Icon.Cloud size={16} /> },
  ];

  // select mode is available on any grid view (not the category / people index)
  const gridVisible =
    (tab === 'timeline' && timeline.length > 0) ||
    (tab === 'favorites' && (favorites?.length ?? 0) > 0) ||
    (tab === 'albums' && openAlbum && (albumPhotos?.length ?? 0) > 0) ||
    (tab === 'explore' && openLabel && (labelPhotos?.length ?? 0) > 0) ||
    (tab === 'people' && openPerson && (personPhotos?.length ?? 0) > 0);

  return (
    <div className="animate-fade-in">
      <PageHeader
        title="Photos"
        subtitle="Your private, always-synced photo library"
        icon={<Icon.Photos size={22} />}
        actions={
          <div className="relative w-full max-w-xs">
            <Icon.Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
            <input
              value={query}
              onChange={e => onSearchChange(e.target.value)}
              placeholder="Search photos…"
              className="input !pl-9"
            />
            {query && (
              <button
                onClick={() => onSearchChange('')}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-500 hover:text-white"
              >
                <Icon.Close size={15} />
              </button>
            )}
          </div>
        }
      />

      <>
          {/* tabs + select toggle */}
          <div className="mb-6 flex flex-wrap items-center gap-2">
            {tabs.map(t => (
              <button
                key={t.id}
                onClick={() => { setTab(t.id); setOpenAlbum(null); setOpenLabel(null); setOpenPerson(null); }}
                className={cx(
                  'chip flex items-center gap-2',
                  tab === t.id ? '!bg-brand-500/20 !text-brand-300 !border-brand-500/40' : ''
                )}
              >
                {t.icon}{t.label}
              </button>
            ))}
            {gridVisible && (
              <button
                onClick={() => { if (selectMode) clearSelection(); else setSelectMode(true); }}
                className={cx(
                  'chip ml-auto flex items-center gap-2',
                  selectMode ? '!bg-brand-500/20 !text-brand-300 !border-brand-500/40' : ''
                )}
              >
                <Icon.Check size={16} />{selectMode ? 'Cancel' : 'Select'}
              </button>
            )}
          </div>

          {/* TIMELINE */}
          {tab === 'timeline' && (
            <>
              {!timelineInit ? (
                <PageLoader />
              ) : timeline.length === 0 ? (
                <EmptyState
                  icon={<Icon.Search size={28} />}
                  title={activeQuery.current ? 'No matching photos' : 'No photos yet'}
                  subtitle={activeQuery.current ? 'Try a different search term.' : 'Connect phone backup to see photos here.'}
                />
              ) : (
                <>
                  {!selectMode && !activeQuery.current && <JumpBar photos={timeline} />}
                  <PhotoGrid
                    photos={timeline}
                    onOpen={i => openLightbox(timeline, i)}
                    selectMode={selectMode}
                    selected={selected}
                    onToggleSelect={toggleSelect}
                  />
                  <div ref={sentinelRef} className="h-10" />
                  {loadingMore && <div className="flex justify-center py-6"><Spinner /></div>}
                  {!hasMore && timeline.length > 0 && (
                    <p className="py-8 text-center text-xs text-slate-600">You've reached the beginning · {timeline.length} photos</p>
                  )}
                </>
              )}
            </>
          )}

          {/* ALBUMS */}
          {tab === 'albums' && (
            openAlbum ? (
              <>
                <button
                  onClick={() => { setOpenAlbum(null); setAlbumPhotos(null); }}
                  className="btn-ghost mb-5 flex items-center gap-1.5"
                >
                  <Icon.ChevronLeft size={16} /> All albums
                </button>
                <div className="mb-4">
                  <h2 className="text-2xl font-bold tracking-tight text-white">{openAlbum.title}</h2>
                  <p className="muted text-sm">{openAlbum.count.toLocaleString()} items</p>
                </div>
                {albumPhotos === null ? (
                  <div className="flex justify-center py-16"><Spinner size={26} /></div>
                ) : albumPhotos.length === 0 ? (
                  <EmptyState icon={<Icon.Photos size={28} />} title="Empty album" subtitle="No photos in this album yet." />
                ) : (
                  <PhotoGrid
                    photos={albumPhotos}
                    onOpen={i => openLightbox(albumPhotos, i)}
                    selectMode={selectMode}
                    selected={selected}
                    onToggleSelect={toggleSelect}
                  />
                )}
              </>
            ) : visibleAlbums === null ? (
              <div className="flex justify-center py-16"><Spinner size={26} /></div>
            ) : visibleAlbums.length === 0 ? (
              <EmptyState icon={<Icon.Grid size={28} />} title="No albums" subtitle="Albums you create will appear here." />
            ) : (
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 sm:gap-4 lg:grid-cols-4 xl:grid-cols-5">
                {visibleAlbums.map(a => <AlbumCard key={a.uid} album={a} onOpen={() => openAlbumView(a)} />)}
              </div>
            )
          )}

          {/* EXPLORE — search by what's in the photo */}
          {tab === 'explore' && (
            openLabel ? (
              <>
                <button
                  onClick={() => { setOpenLabel(null); setLabelPhotos(null); }}
                  className="btn-ghost mb-5 flex items-center gap-1.5"
                >
                  <Icon.ChevronLeft size={16} /> All categories
                </button>
                <div className="mb-4 flex items-center gap-2">
                  <Icon.Sparkles size={20} className="text-brand-400" />
                  <h2 className="text-2xl font-bold capitalize tracking-tight text-white">{openLabel.name}</h2>
                  {/* the estimated index count overstates what actually opens (~2x);
                      once loaded, show the real number of openable photos */}
                  <span className="text-sm text-slate-500">
                    {(labelPhotos ? labelPhotos.length : openLabel.count).toLocaleString()}
                  </span>
                </div>
                {labelPhotos === null ? (
                  <div className="flex justify-center py-16"><Spinner size={26} /></div>
                ) : labelPhotos.length === 0 ? (
                  <EmptyState icon={<Icon.Sparkles size={28} />} title="Nothing here" subtitle="No photos found in this category." />
                ) : (
                  <PhotoGrid
                    photos={labelPhotos}
                    onOpen={i => openLightbox(labelPhotos, i)}
                    selectMode={selectMode}
                    selected={selected}
                    onToggleSelect={toggleSelect}
                  />
                )}
              </>
            ) : labels === null ? (
              <div className="flex justify-center py-16"><Spinner size={26} /></div>
            ) : labels.length === 0 ? (
              <EmptyState icon={<Icon.Sparkles size={28} />} title="No categories yet" subtitle="As your library is analysed, objects and scenes will appear here." />
            ) : (
              <>
                <p className="muted mb-4 flex items-center gap-2 text-sm">
                  <Icon.Search size={15} className="shrink-0 text-brand-400" />
                  Browse your photos by what’s in them — {labels.length} categories detected.
                </p>
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 sm:gap-4 lg:grid-cols-5 xl:grid-cols-6">
                  {labels.map(l => <CategoryCard key={l.slug} label={l} onOpen={() => openLabelView(l)} />)}
                </div>
              </>
            )
          )}

          {/* PEOPLE — named faces */}
          {tab === 'people' && (
            openPerson ? (
              <>
                <button
                  onClick={() => { setOpenPerson(null); setPersonPhotos(null); }}
                  className="btn-ghost mb-5 flex items-center gap-1.5"
                >
                  <Icon.ChevronLeft size={16} /> All people
                </button>
                <div className="mb-4 flex items-center gap-2">
                  <Icon.Star size={20} className="text-brand-400" />
                  <h2 className="text-2xl font-bold tracking-tight text-white">{openPerson.name}</h2>
                  <span className="text-sm text-slate-500">{openPerson.count.toLocaleString()}</span>
                </div>
                {personPhotos === null ? (
                  <div className="flex justify-center py-16"><Spinner size={26} /></div>
                ) : personPhotos.length === 0 ? (
                  <EmptyState icon={<Icon.Star size={28} />} title="No photos" subtitle="No photos found for this person." />
                ) : (
                  <PhotoGrid
                    photos={personPhotos}
                    onOpen={i => openLightbox(personPhotos, i)}
                    selectMode={selectMode}
                    selected={selected}
                    onToggleSelect={toggleSelect}
                  />
                )}
              </>
            ) : people === null ? (
              <div className="flex justify-center py-16"><Spinner size={26} /></div>
            ) : people.people.length > 0 ? (
              <div className="grid grid-cols-3 gap-3 sm:grid-cols-4 sm:gap-4 md:grid-cols-6 lg:grid-cols-8">
                {people.people.map(p => <PersonCard key={p.uid} person={p} onOpen={() => openPersonView(p)} />)}
              </div>
            ) : people.faceClusters > 0 ? (
              <EmptyState
                icon={<Icon.Star size={28} />}
                title={`${people.faceClusters.toLocaleString()} face group${people.faceClusters === 1 ? '' : 's'} detected`}
                subtitle="Name people in your photo library to see them grouped here."
              />
            ) : (
              <EmptyState
                icon={<Icon.Star size={28} />}
                title="No people yet"
                subtitle="Once faces are detected in your library, the people you name will appear here."
              />
            )
          )}

          {/* PLACES */}
          {tab === 'places' && (
            <PlacesMap onOpen={(list, index) => openLightbox(list, index)} />
          )}

          {/* FAVORITES */}
          {tab === 'favorites' && (
            favorites === null ? (
              <div className="flex justify-center py-16"><Spinner size={26} /></div>
            ) : favorites.length === 0 ? (
              <EmptyState
                icon={<Icon.Heart size={28} />}
                title="No favorites yet"
                subtitle="Tap the heart on any photo to keep it here."
              />
            ) : (
              <PhotoGrid
                photos={favorites}
                onOpen={i => openLightbox(favorites, i)}
                selectMode={selectMode}
                selected={selected}
                onToggleSelect={toggleSelect}
              />
            )
          )}
      </>

      {/* bulk action bar */}
      {selectMode && (
        <div className="fixed inset-x-0 bottom-[calc(3.75rem+env(safe-area-inset-bottom))] z-50 border-t border-white/10 bg-ink-950/95 px-3 py-3 backdrop-blur-xl animate-fade-in sm:px-6 lg:bottom-0">
          <div className="mx-auto flex max-w-5xl items-center gap-2">
            <button onClick={clearSelection} className="icon-btn h-10 w-10 text-slate-300 hover:bg-white/10" title="Clear">
              <Icon.Close size={20} />
            </button>
            <span className="text-sm font-medium text-white">
              {selected.size} selected
            </span>
            <button onClick={selectAll} className="btn-ghost !py-1.5 text-xs">Select all</button>
            <div className="ml-auto flex items-center gap-2">
              <button
                onClick={downloadSelected}
                disabled={selected.size === 0}
                className="btn-primary flex items-center gap-2 disabled:opacity-40"
              >
                <Icon.Download size={16} /> <span className="hidden sm:inline">Download</span>
              </button>
            </div>
          </div>
        </div>
      )}

      <ConfirmModal
        open={confirmDl}
        onClose={() => setConfirmDl(false)}
        onConfirm={() => runDownload(currentList().filter(p => selected.has(p.id)))}
        title={`Download ${selected.size} photos`}
        message={`This starts ${selected.size} separate downloads — one file per photo. Your browser may ask you to allow multiple downloads the first time.`}
        confirmLabel={`Download ${selected.size} files`}
      />

      {lightbox && (
        <Lightbox
          photos={lightbox.list}
          index={lightbox.index}
          onClose={() => setLightbox(null)}
          onNav={navLightbox}
          onToggleFav={onFavoriteTap}
          onEdit={p => { setLightbox(null); editPhoto(p); }}
        />
      )}
    </div>
  );
}
