import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { Icon } from '../lib/icons';
import { cx, formatRelative } from '../lib/utils';
import { toast } from '../lib/store';
import { PageHeader, EmptyState, Spinner, Badge, Modal, ProgressBar } from '../components/ui';
import { MusicResult, MusicRequest } from '../lib/model';

// ---- Types (loose, matches jellyseerr service shapes) ----
type Result = {
  id: number;
  tmdbId: number;
  mediaType: 'movie' | 'tv';
  title: string;
  overview?: string;
  year?: string;
  posterUrl?: string;
  backdropUrl?: string;
  rating?: number;
  status?: number; // jellyseerr media status: 1 unknown,2 pending,3 processing,4 partial,5 available
};

type MyRequest = {
  id: number;
  status: number; // 1 pending approval, 2 approved, 3 declined
  mediaType: string;
  title: string;
  tmdbId?: number;
  posterUrl?: string;
  mediaStatus?: number;
  requestedBy?: string;
  createdAt?: string;
};

type ForYou = {
  movies: (Result & { why?: string })[];
  tv: (Result & { why?: string })[];
  artists: (MusicResult & { why?: string })[];
  reason?: string;
};

// ---- Media status → availability helpers ----
type Avail = { kind: 'request' | 'requested' | 'processing' | 'partial' | 'available'; label: string; color: 'green' | 'amber' | 'cyan' | 'slate' };

function availFor(status?: number): Avail {
  switch (status) {
    case 5: return { kind: 'available', label: 'In library', color: 'green' };
    case 4: return { kind: 'partial', label: 'Partial', color: 'cyan' };
    case 3: return { kind: 'processing', label: 'Processing', color: 'cyan' };
    case 2: return { kind: 'requested', label: 'Requested', color: 'amber' };
    default: return { kind: 'request', label: 'Request', color: 'slate' };
  }
}

// Search results that map to these are already in the library and playable.
const isWatchable = (status?: number) => status === 5 || status === 4;

// ---- tmdbId → real title/poster cache (jellyseerr's /request only returns "#<tmdbId>") ----
// Populated from search results, trending, and requests created this session; persisted so it
// accumulates across visits. Lets "My requests" show real titles+posters instead of raw ids.
type Meta = { title: string; posterUrl?: string; year?: string; mediaType: string };
const META_KEY = 'cb_req_meta';
const DISMISS_KEY = 'cb_req_dismissed';
const metaKey = (mediaType: string, tmdbId?: number) => `${mediaType}:${tmdbId ?? '?'}`;
const isRawId = (t?: string) => !t || /^#\d+$/.test(t.trim());
const normTitle = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
function loadMeta(): Record<string, Meta> { try { return JSON.parse(localStorage.getItem(META_KEY) || '{}'); } catch { return {}; } }
function loadDismissed(): number[] { try { return JSON.parse(localStorage.getItem(DISMISS_KEY) || '[]'); } catch { return []; } }

// ---- My-request state: combine request.status (approval) with mediaStatus (availability) ----
type Tone = 'pending' | 'processing' | 'available' | 'declined';
type ReqState = {
  tone: Tone;
  label: string;
  detail: string;
  color: 'amber' | 'cyan' | 'green' | 'red';
  icon: 'clock' | 'download' | 'check' | 'close';
  progress: number; // 0..100 for the progress bar feel
};

function reqState(req: MyRequest): ReqState {
  // Declined trumps everything.
  if (req.status === 3) return { tone: 'declined', label: 'Declined', detail: 'Request was declined', color: 'red', icon: 'close', progress: 0 };
  const ms = req.mediaStatus;
  if (ms === 5) return { tone: 'available', label: 'In your library', detail: 'Ready to watch', color: 'green', icon: 'check', progress: 100 };
  if (ms === 4) return { tone: 'available', label: 'Partially available', detail: 'Some episodes ready', color: 'green', icon: 'check', progress: 66 };
  if (ms === 3) return { tone: 'processing', label: 'Downloading', detail: 'In progress', color: 'cyan', icon: 'download', progress: 45 };
  if (req.status === 2) return { tone: 'processing', label: 'Approved', detail: 'Queued for download', color: 'cyan', icon: 'download', progress: 20 };
  return { tone: 'pending', label: 'Pending approval', detail: 'Awaiting approval', color: 'amber', icon: 'clock', progress: 8 };
}

function StateIcon({ icon, size = 14, className }: { icon: ReqState['icon']; size?: number; className?: string }) {
  if (icon === 'check') return <Icon.Check size={size} className={className} />;
  if (icon === 'download') return <Icon.Download size={size} className={className} />;
  if (icon === 'close') return <Icon.Close size={size} className={className} />;
  return <Icon.Clock size={size} className={className} />;
}

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

// ---- Poster ----
function Poster({ url, title, className }: { url?: string; title: string; className?: string }) {
  const [err, setErr] = useState(false);
  const src = url ? api.requests.imageUrl(url) : '';
  if (!src || err) {
    return (
      <div className={cx('w-full h-full grid place-items-center bg-gradient-to-br from-ink-800 to-ink-900 text-slate-600 p-2 text-center', className)}>
        <span className="text-xs font-medium text-slate-500 line-clamp-3">{title}</span>
      </div>
    );
  }
  return <img src={src} alt={title} loading="lazy" onError={() => setErr(true)} className={cx('w-full h-full object-cover', className)} />;
}

// ---- Result card ----
function ResultCard({
  item, busy, overrideStatus, onOpen, onRequest, onWatch,
}: {
  item: Result;
  busy: boolean;
  overrideStatus?: number;
  onOpen: () => void;
  onRequest: () => void;
  onWatch: () => void;
}) {
  const effStatus = overrideStatus ?? item.status;
  const avail = availFor(effStatus);
  const canRequest = avail.kind === 'request';
  const watchable = isWatchable(effStatus);
  return (
    <div className="group card-hover overflow-hidden rounded-xl bg-ink-850 flex flex-col">
      <button onClick={onOpen} className="relative block w-full aspect-[2/3] overflow-hidden text-left">
        <Poster url={item.posterUrl} title={item.title} className="transition-transform duration-500 group-hover:scale-105" />
        <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-transparent to-transparent opacity-0 group-hover:opacity-100 transition-opacity" />
        {/* type + rating chips */}
        <div className="absolute top-2 left-2 flex items-center gap-1">
          <span className="chip !py-0.5 !px-2 text-[10px] bg-black/60 border-white/10 backdrop-blur-sm gap-1">
            {item.mediaType === 'movie' ? <Icon.Movie size={11} /> : <Icon.TV size={11} />}
            {item.mediaType === 'movie' ? 'Movie' : 'TV'}
          </span>
        </div>
        {!!item.rating && (
          <div className="absolute top-2 right-2 chip !py-0.5 !px-2 text-[10px] bg-black/60 border-white/10 backdrop-blur-sm text-accent-amber gap-0.5">
            <Icon.Star size={10} /> {item.rating.toFixed(1)}
          </div>
        )}
        {!canRequest && (
          <div className="absolute bottom-2 left-2">
            <Badge color={avail.color}>{avail.kind === 'available' ? '✓ ' : ''}{avail.label}</Badge>
          </div>
        )}
      </button>
      <div className="p-2.5 flex flex-col gap-2 flex-1">
        <div className="min-w-0">
          <p className="text-sm font-medium text-white leading-tight line-clamp-2">{item.title}</p>
          {item.year && <p className="text-[11px] muted mt-0.5">{item.year}</p>}
        </div>
        {canRequest ? (
          <button
            onClick={onRequest}
            disabled={busy}
            className="btn-primary !py-2 !px-3 w-full mt-auto text-xs gap-1.5 min-h-[40px] disabled:opacity-60"
          >
            {busy ? <Spinner size={14} /> : <><Icon.Plus size={14} /> Request</>}
          </button>
        ) : watchable ? (
          <button
            onClick={onWatch}
            className="btn-secondary !py-2 !px-3 w-full mt-auto text-xs gap-1.5 min-h-[40px] text-accent-green"
          >
            <Icon.Play size={13} /> Watch
          </button>
        ) : (
          <div className="mt-auto flex items-center justify-center gap-1.5 min-h-[40px] text-xs font-medium text-accent-amber">
            <Icon.Clock size={14} /> {avail.label}
          </div>
        )}
      </div>
    </div>
  );
}

// ---- Skeleton ----
function GridSkeleton({ count = 12 }: { count?: number }) {
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-3 sm:gap-4">
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="rounded-xl bg-ink-850 overflow-hidden">
          <div className="aspect-[2/3] bg-white/[0.05] animate-pulse" />
          <div className="p-2.5 space-y-2">
            <div className="h-3 w-3/4 rounded bg-white/[0.05] animate-pulse" />
            <div className="h-8 w-full rounded bg-white/[0.04] animate-pulse" />
          </div>
        </div>
      ))}
    </div>
  );
}

// ---- Music: artist image with a graceful gradient + music-icon fallback ----
// posterUrl is a same-origin /api/requests/image proxy path (the server allowlists
// the fanart.tv/coverartarchive hosts) — load it via imageUrl() like movie posters
// so the auth token is attached and browsers never hotlink external hosts.
function ArtistImage({ url, name }: { url?: string; name: string }) {
  const [err, setErr] = useState(false);
  const src = url ? api.requests.imageUrl(url) : '';
  if (!src || err) {
    return (
      <div className="w-full h-full grid place-items-center bg-gradient-to-br from-brand-900/50 to-ink-900 text-brand-300/40">
        <Icon.Music size={30} />
      </div>
    );
  }
  return <img src={src} alt={name} loading="lazy" onError={() => setErr(true)} className="w-full h-full object-cover" />;
}

// ---- Music: artist result card ----
function MusicCard({ artist, busy, requested, label, onRequest }: {
  artist: MusicResult;
  busy: boolean;
  requested: boolean;
  label: string;
  onRequest: () => void;
}) {
  const subtitle = [artist.type, artist.disambiguation].filter(Boolean).join(' • ');
  return (
    <div className="group card-hover overflow-hidden rounded-xl bg-ink-850 flex flex-col">
      <div className="relative w-full aspect-square overflow-hidden">
        <ArtistImage url={artist.posterUrl} name={artist.name} />
        <div className="absolute inset-0 bg-gradient-to-t from-black/70 via-transparent to-transparent opacity-0 group-hover:opacity-100 transition-opacity" />
        {requested && (
          <div className="absolute bottom-2 left-2">
            <Badge color="green">✓ {label}</Badge>
          </div>
        )}
      </div>
      <div className="p-2.5 flex flex-col gap-2 flex-1">
        <div className="min-w-0">
          <p className="text-sm font-medium text-white leading-tight line-clamp-2">{artist.name}</p>
          {subtitle && <p className="text-[11px] muted mt-0.5 line-clamp-1">{subtitle}</p>}
        </div>
        {requested ? (
          <div className="mt-auto flex items-center justify-center gap-1.5 min-h-[40px] text-xs font-medium text-accent-green">
            <Icon.Check size={14} /> {label}
          </div>
        ) : (
          <button
            onClick={onRequest}
            disabled={busy}
            className="btn-primary !py-2 !px-3 w-full mt-auto text-xs gap-1.5 min-h-[40px] disabled:opacity-60"
          >
            {busy ? <Spinner size={14} /> : <><Icon.Music size={14} /> Request</>}
          </button>
        )}
      </div>
    </div>
  );
}

export default function Requests() {
  const navigate = useNavigate();
  const [loading, setLoading] = useState(true);
  const [configured, setConfigured] = useState(true);
  const [online, setOnline] = useState(true);

  const [query, setQuery] = useState('');
  const debounced = useDebounced(query.trim(), 350);
  const [results, setResults] = useState<Result[]>([]);
  const [searching, setSearching] = useState(false);

  const [trending, setTrending] = useState<Result[]>([]);
  const [myRequests, setMyRequests] = useState<MyRequest[]>([]);

  const [busy, setBusy] = useState<Set<string>>(new Set());
  const [overrides, setOverrides] = useState<Record<string, number>>({});
  const [selected, setSelected] = useState<Result | null>(null);
  const [meta, setMeta] = useState<Record<string, Meta>>(() => loadMeta());
  const [dismissed, setDismissed] = useState<Set<number>>(() => new Set(loadDismissed()));

  const searchReq = useRef(0);
  const inputRef = useRef<HTMLInputElement>(null);

  // ---- Music mode (Lidarr-backed) ----
  const [mode, setMode] = useState<'movies' | 'music'>('movies');
  const [musicConfigured, setMusicConfigured] = useState(false);
  const [musicOnline, setMusicOnline] = useState(false);
  const [musicQuery, setMusicQuery] = useState('');
  const musicDebounced = useDebounced(musicQuery.trim(), 350);
  const [musicResults, setMusicResults] = useState<MusicResult[]>([]);
  const [musicSearching, setMusicSearching] = useState(false);
  const [musicBusy, setMusicBusy] = useState<Set<string>>(new Set());
  const [musicRequested, setMusicRequested] = useState<Set<string>>(new Set());
  const [musicError, setMusicError] = useState(false);
  const [musicTrending, setMusicTrending] = useState<MusicResult[]>([]);
  const [musicMine, setMusicMine] = useState<MusicRequest[]>([]);
  const [musicStaticLoading, setMusicStaticLoading] = useState(true);
  const [forYou, setForYou] = useState<ForYou | null>(null);
  const [forYouLoading, setForYouLoading] = useState(true);
  const [surpriseBusy, setSurpriseBusy] = useState(false);

  // Trending chart + my music requests (shown when the music search is empty).
  const loadMusicStatic = () => {
    Promise.allSettled([
      api.requests.musicTrending().then(t => setMusicTrending(t || [])),
      api.requests.musicMine().then(m => setMusicMine(m || [])),
    ]).then(() => setMusicStaticLoading(false));
  };
  const musicSearchReq = useRef(0);
  const musicInputRef = useRef<HTMLInputElement>(null);

  const keyFor = (r: { mediaType: string; tmdbId: number }) => `${r.mediaType}:${r.tmdbId}`;

  // Merge title/poster metadata from search/trending/created items into the persistent cache.
  const cacheMeta = (items: { mediaType: string; tmdbId?: number; title?: string; posterUrl?: string; year?: string }[]) => {
    setMeta(prev => {
      const next = { ...prev }; let changed = false;
      for (const it of items) {
        if (!it.tmdbId || isRawId(it.title)) continue;
        const k = metaKey(it.mediaType, it.tmdbId);
        const cur = next[k];
        if (!cur || cur.title !== it.title || (!cur.posterUrl && it.posterUrl)) {
          next[k] = { title: it.title!, posterUrl: it.posterUrl || cur?.posterUrl, year: it.year || cur?.year, mediaType: it.mediaType };
          changed = true;
        }
      }
      if (changed) { try { localStorage.setItem(META_KEY, JSON.stringify(next)); } catch { /* */ } }
      return changed ? next : prev;
    });
  };

  // Resolve a raw "#<tmdbId>" request into a real title + poster using the cache.
  const enrichReq = (req: MyRequest) => {
    const m = meta[metaKey(req.mediaType, req.tmdbId)];
    const known = !isRawId(req.title) ? req.title : m?.title;
    return {
      ...req,
      resolvedName: known,                                            // real title, if we have one (for library matching)
      displayTitle: known || (req.mediaType === 'movie' ? 'Movie request' : 'TV request'),
      posterUrl: req.posterUrl || m?.posterUrl,
    };
  };

  const loadStatic = async () => {
    const [tr, mine] = await Promise.all([
      api.requests.trending().catch(() => [] as Result[]),
      api.requests.list().catch(() => [] as MyRequest[]),
    ]);
    setTrending(tr || []);
    setMyRequests(mine || []);
    cacheMeta(tr || []);
  };

  const loadForYou = async () => {
    setForYouLoading(true);
    try {
      const s = await api.autorequest.suggestions();
      setForYou({
        movies: (s.movies || []).map((x: any) => ({ ...x, id: x.tmdbId, status: 0 })),
        tv: (s.tv || []).map((x: any) => ({ ...x, id: x.tmdbId, status: 0 })),
        artists: (s.artists || []).map((x: any) => ({ ...x, foreignArtistId: '', status: 'none' as const })),
        reason: s.reason,
      });
      cacheMeta([...(s.movies || []), ...(s.tv || [])]);
    } catch {
      setForYou(null);
    } finally {
      setForYouLoading(false);
    }
  };

  // Hide a submitted request from the local list (jellyseerr exposes no cancel endpoint).
  const dismiss = (id: number) => {
    setDismissed(prev => {
      const n = new Set(prev); n.add(id);
      try { localStorage.setItem(DISMISS_KEY, JSON.stringify([...n])); } catch { /* */ }
      return n;
    });
    toast('Removed from your list', 'info', 'Hidden here — this does not affect an in-progress download.');
  };

  // Deep-link straight to a specific library title when possible, else fall back to the library.
  const openInLibrary = async (title: string | undefined, mediaType: string) => {
    const fallback = () => navigate(mediaType === 'movie' ? '/movies' : '/tv');
    if (!title) return fallback();
    try {
      const results = await api.media.search(title);
      const pool = results.filter(m => mediaType === 'movie' ? m.type === 'Movie' : (m.type === 'Series' || m.type === 'Episode'));
      const list = pool.length ? pool : results;
      const n = normTitle(title);
      const match = list.find(m => normTitle(m.name) === n)
        || list.find(m => { const mn = normTitle(m.name); return mn.includes(n) || n.includes(mn); })
        || list[0];
      if (match) { navigate(`${match.type === 'Movie' ? '/movies' : '/tv'}?item=${match.id}`); return; }
    } catch { /* fall through */ }
    fallback();
  };

  // Initial load
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const st = await api.requests.status();
        if (cancelled) return;
        loadForYou();
        // Music state first: Lidarr is independent of Jellyseerr, so the Music tab
        // must survive Jellyseerr being unconfigured or down.
        setMusicConfigured(!!st?.music?.configured);
        setMusicOnline(!!st?.music?.online);
        if (st?.music?.configured) loadMusicStatic();
        if (!st?.configured) {
          setConfigured(false);
          if (st?.music?.configured) setMode('music');
          setLoading(false);
          return;
        }
        setConfigured(true);
        setOnline(!!st.online);
        await loadStatic();
      } catch {
        if (!cancelled) setConfigured(false);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Live polling of my requests so statuses update without a reload.
  useEffect(() => {
    if (!configured) return;
    const t = setInterval(() => {
      api.requests.list().then(m => setMyRequests(m || [])).catch(() => {});
    }, 20000);
    return () => clearInterval(t);
  }, [configured]);

  // Same for music: download progress moves as Lidarr grabs albums.
  useEffect(() => {
    if (!musicConfigured) return;
    const t = setInterval(() => {
      api.requests.musicMine().then(m => setMusicMine(m || [])).catch(() => {});
    }, 20000);
    return () => clearInterval(t);
  }, [musicConfigured]);

  // Debounced search
  useEffect(() => {
    if (!configured) return;
    if (!debounced) { searchReq.current++; setResults([]); setSearching(false); return; }
    const id = ++searchReq.current;
    setSearching(true);
    api.requests.search(debounced)
      .then(res => { if (id === searchReq.current) { setResults(res || []); cacheMeta(res || []); } })
      .catch(() => { if (id === searchReq.current) setResults([]); })
      .finally(() => { if (id === searchReq.current) setSearching(false); });
  }, [debounced, configured]);

  // Debounced artist search (music mode)
  useEffect(() => {
    if (!musicConfigured) return;
    if (!musicDebounced) { musicSearchReq.current++; setMusicResults([]); setMusicSearching(false); setMusicError(false); return; }
    const id = ++musicSearchReq.current;
    setMusicSearching(true);
    api.requests.musicSearch(musicDebounced)
      .then(res => { if (id === musicSearchReq.current) { setMusicResults(res || []); setMusicError(false); } })
      .catch(() => { if (id === musicSearchReq.current) { setMusicResults([]); setMusicError(true); setMusicOnline(false); } })
      .finally(() => { if (id === musicSearchReq.current) setMusicSearching(false); });
  }, [musicDebounced, musicConfigured]);

  const doRequest = async (item: Result) => {
    const k = keyFor(item);
    if (busy.has(k)) return;
    setBusy(prev => new Set(prev).add(k));
    cacheMeta([item]); // remember its title/poster so "My requests" can render it
    try {
      if (item.mediaType === 'movie') await api.requests.create('movie', item.tmdbId);
      else await api.requests.create('tv', item.tmdbId, 'all');
      setOverrides(prev => ({ ...prev, [k]: 2 })); // mark as requested/pending
      toast(`Requested “${item.title}”`, 'success', 'You will be notified when it is available.');
      // refresh my requests in the background
      api.requests.list().then(m => setMyRequests(m || [])).catch(() => {});
    } catch (e: any) {
      const msg = String(e?.message || '');
      if (/already exists|409/i.test(msg)) {
        setOverrides(prev => ({ ...prev, [k]: 2 }));
        toast('Already requested', 'info', 'This title is already in the request queue.');
      } else {
        toast('Request failed', 'error', msg || 'Could not submit request.');
      }
    } finally {
      setBusy(prev => { const n = new Set(prev); n.delete(k); return n; });
    }
  };

  // Add an artist to Lidarr (monitored + auto-search its discography) = the "request".
  // Search results carry a MusicBrainz id; trending chart entries only a name.
  const doRequestMusic = async (artist: MusicResult) => {
    const id = artist.foreignArtistId || artist.name;
    if (musicBusy.has(id)) return;
    setMusicBusy(prev => new Set(prev).add(id));
    try {
      const res = await api.requests.requestMusic(
        artist.foreignArtistId ? { foreignArtistId: artist.foreignArtistId } : { name: artist.name },
      );
      if (res?.ok) {
        // Mark every identity of this artist requested: search cards key by MBID,
        // trending cards by chart name, and the server may return a canonical name.
        setMusicRequested(prev => {
          const n = new Set(prev).add(id).add(artist.name);
          if (res.name) n.add(res.name);
          return n;
        });
        toast(
          res.already ? 'Already in your library' : 'Added to your music library',
          res.already ? 'info' : 'success',
          res.name || artist.name,
        );
        api.requests.musicMine().then(m => setMusicMine(m || [])).catch(() => {});
      } else {
        toast('Request failed', 'error', 'Could not add this artist to your library.');
      }
    } catch (e: any) {
      toast('Request failed', 'error', String(e?.message || 'Could not add this artist to your library.'));
    } finally {
      setMusicBusy(prev => { const n = new Set(prev); n.delete(id); return n; });
    }
  };

  const surpriseMe = async () => {
    if (surpriseBusy) return;
    setSurpriseBusy(true);
    try {
      const res = await api.autorequest.run();
      if (res.requested) {
        toast(`Added “${res.requested.title}”`, 'success', res.requested.why || 'Picked from your history.');
        loadForYou();
        api.requests.list().then(m => setMyRequests(m || [])).catch(() => {});
        api.requests.musicMine().then(m => setMusicMine(m || [])).catch(() => {});
      } else if (res.capped) {
        toast("You've hit this week's limit", 'warning', 'Auto-adds are limited to 3 in a rolling 7 days.');
      } else if (res.noHistory) {
        toast('Watch a few things first so we can learn your taste', 'info');
      } else {
        toast('No new match found', 'info', 'Everything suggested was already in your library or request queue.');
      }
    } catch (e: any) {
      toast('Surprise me failed', 'error', String(e?.message || 'Could not add a recommendation.'));
    } finally {
      setSurpriseBusy(false);
    }
  };

  // Shared card renderer for music search results and the trending rail.
  const musicCard = (a: MusicResult) => {
    const id = a.foreignArtistId || a.name;
    const alreadyReq = musicRequested.has(id) || musicRequested.has(a.name);
    const requested = alreadyReq || a.status === 'requested' || a.status === 'available';
    const label = (a.status === 'available' && !alreadyReq) ? 'In library' : 'Requested';
    return (
      <MusicCard
        key={id}
        artist={a}
        busy={musicBusy.has(id)}
        requested={requested}
        label={label}
        onRequest={() => doRequestMusic(a)}
      />
    );
  };

  const overrideFor = (r: Result) => overrides[keyFor(r)];

  const visibleRequests = useMemo(() => myRequests.filter(r => !dismissed.has(r.id)), [myRequests, dismissed]);

  const summary = useMemo(() => {
    let pending = 0, processing = 0, available = 0;
    for (const r of visibleRequests) {
      const t = reqState(r).tone;
      if (t === 'pending') pending++;
      else if (t === 'processing') processing++;
      else if (t === 'available') available++;
    }
    return { pending, processing, available };
  }, [visibleRequests]);

  const showTrending = !debounced;
  const modeOnline = mode === 'music' ? musicOnline : online;
  const forYouItems = forYou ? [...forYou.movies, ...forYou.tv] : [];
  const showForYou = !!forYou && (forYouItems.length > 0 || forYou.artists.length > 0 || forYou.reason === 'no history yet');

  if (loading) {
    return (
      <div className="animate-fade-in">
        <PageHeader title="Request Movies & TV" subtitle="Search and request titles for your library" icon={<Icon.Plus size={22} />} />
        <div className="h-14 rounded-2xl bg-white/[0.04] animate-pulse mb-8" />
        <GridSkeleton />
      </div>
    );
  }

  if (!configured && !musicConfigured) {
    return (
      <div className="animate-fade-in">
        <PageHeader title="Request Movies & TV" subtitle="Search and request titles for your library" icon={<Icon.Plus size={22} />} />
        <EmptyState
          icon={<Icon.Sparkles size={30} />}
          title="Requests not configured"
          subtitle="Connect a Jellyseerr server in Settings to search and request movies and TV shows for your library."
        />
      </div>
    );
  }

  return (
    <div className="animate-fade-in">
      <PageHeader
        title={mode === 'music' ? 'Request Music' : 'Request Movies & TV'}
        subtitle={mode === 'music' ? 'Search for an artist to add their music to your library' : 'Search TMDB and add titles to your library'}
        icon={mode === 'music' ? <Icon.Music size={22} /> : <Icon.Plus size={22} />}
        actions={
          <span className={cx('chip gap-1.5 text-xs', modeOnline ? 'text-accent-green' : 'text-slate-400')}>
            <span className={cx('w-2 h-2 rounded-full', modeOnline ? 'bg-accent-green' : 'bg-slate-500')} />
            {modeOnline ? 'Online' : 'Offline'}
          </span>
        }
      />

      {/* ---- Mode switcher (Movies & TV / Music) — only when both modes work ---- */}
      {musicConfigured && configured && (
        <div className="flex mb-6">
          <div role="tablist" aria-label="Request type" className="inline-flex items-center gap-1 p-1 rounded-xl bg-ink-850 border border-white/[0.06]">
            {(['movies', 'music'] as const).map(m => (
              <button
                key={m}
                role="tab"
                aria-selected={mode === m}
                onClick={() => setMode(m)}
                className={cx(
                  'inline-flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium transition-all min-h-[40px]',
                  mode === m ? 'bg-brand-600 text-white shadow-[0_4px_16px_-4px_rgba(99,102,241,0.6)]' : 'text-slate-400 hover:text-white',
                )}
              >
                {m === 'music' ? <Icon.Music size={16} /> : <Icon.Movie size={16} />}
                {m === 'music' ? 'Music' : 'Movies & TV'}
              </button>
            ))}
          </div>
        </div>
      )}

      {(forYouLoading || showForYou) && (
        <div className="mb-8">
          <div className="flex items-center gap-3 mb-4 flex-wrap">
            <div className="flex items-center gap-2">
              <Icon.Sparkles size={18} className="text-brand-400" />
              <h2 className="section-title !mb-0">Recommended for you</h2>
            </div>
            <button
              onClick={surpriseMe}
              disabled={surpriseBusy}
              className="btn-secondary !py-2 !px-3 text-xs gap-1.5 ml-auto disabled:opacity-60"
            >
              {surpriseBusy ? <Spinner size={14} /> : <><Icon.Sparkles size={14} /> Surprise me →</>}
            </button>
          </div>
          {forYouLoading ? (
            <GridSkeleton count={6} />
          ) : forYou?.reason === 'no history yet' ? (
            <div className="card p-5 text-sm muted">Watch a few movies, shows, or music tracks first so Aerie can learn your taste.</div>
          ) : (
            <div className="space-y-5">
              {forYouItems.length > 0 && (
                <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-3 sm:gap-4">
                  {forYouItems.map(r => (
                    <ResultCard
                      key={`fy-${r.mediaType}-${r.tmdbId}`}
                      item={r}
                      busy={busy.has(keyFor(r))}
                      overrideStatus={overrideFor(r)}
                      onOpen={() => setSelected(r)}
                      onRequest={() => doRequest(r)}
                      onWatch={() => openInLibrary(r.title, r.mediaType)}
                    />
                  ))}
                </div>
              )}
              {forYou?.artists.length > 0 && (
                <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-3 sm:gap-4">
                  {forYou.artists.map(musicCard)}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {mode === 'movies' ? (
      <>
      {/* ---- Search bar ---- */}
      <div className="sticky top-0 z-20 -mx-1 px-1 py-2 mb-6 bg-ink-950/80 backdrop-blur-md">
        <div className="relative">
          <div className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-500 pointer-events-none">
            {searching ? <Spinner size={18} /> : <Icon.Search size={20} />}
          </div>
          <input
            ref={inputRef}
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Search for a movie or TV show…"
            autoComplete="off"
            className="input w-full !pl-12 !pr-11 !py-3.5 text-base rounded-2xl"
          />
          {query && (
            <button
              onClick={() => { setQuery(''); inputRef.current?.focus(); }}
              className="absolute right-3 top-1/2 -translate-y-1/2 icon-btn"
              aria-label="Clear search"
            >
              <Icon.Close size={18} />
            </button>
          )}
        </div>
      </div>

      {/* ---- Search results ---- */}
      {!showTrending && (
        <div className="mb-10">
          {searching && results.length === 0 ? (
            <GridSkeleton />
          ) : results.length === 0 ? (
            <EmptyState icon={<Icon.Search size={28} />} title="No results" subtitle={`Nothing found for “${debounced}”. Try another title.`} />
          ) : (
            <>
              <div className="flex items-baseline justify-between mb-4">
                <h2 className="section-title">Results</h2>
                <span className="muted text-sm">{results.length} title{results.length === 1 ? '' : 's'}</span>
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-3 sm:gap-4">
                {results.map(r => (
                  <ResultCard
                    key={`${r.mediaType}-${r.id}`}
                    item={r}
                    busy={busy.has(keyFor(r))}
                    overrideStatus={overrideFor(r)}
                    onOpen={() => setSelected(r)}
                    onRequest={() => doRequest(r)}
                    onWatch={() => openInLibrary(r.title, r.mediaType)}
                  />
                ))}
              </div>
            </>
          )}
        </div>
      )}

      {/* ---- Trending (empty search) ---- */}
      {showTrending && trending.length > 0 && (
        <div className="mb-10">
          <div className="flex items-center gap-2 mb-4">
            <Icon.Bolt size={18} className="text-accent-amber" />
            <h2 className="section-title !mb-0">Trending now</h2>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-3 sm:gap-4">
            {trending.map(r => (
              <ResultCard
                key={`${r.mediaType}-${r.id}`}
                item={r}
                busy={busy.has(keyFor(r))}
                overrideStatus={overrideFor(r)}
                onOpen={() => setSelected(r)}
                onRequest={() => doRequest(r)}
                onWatch={() => openInLibrary(r.title, r.mediaType)}
              />
            ))}
          </div>
        </div>
      )}

      {/* ---- My requests ---- */}
      {showTrending && (
        <div className="mb-4">
          <div className="flex items-center gap-2 mb-4 flex-wrap">
            <Icon.Clock size={18} className="text-brand-400" />
            <h2 className="section-title !mb-0">My requests</h2>
            {visibleRequests.length > 0 && (
              <div className="flex items-center gap-1.5 ml-auto flex-wrap">
                {summary.pending > 0 && (
                  <span className="chip !py-0.5 !px-2 text-[11px] gap-1 text-accent-amber">
                    <span className="w-1.5 h-1.5 rounded-full bg-accent-amber" />{summary.pending} pending
                  </span>
                )}
                {summary.processing > 0 && (
                  <span className="chip !py-0.5 !px-2 text-[11px] gap-1 text-accent-cyan">
                    <span className="w-1.5 h-1.5 rounded-full bg-accent-cyan" />{summary.processing} downloading
                  </span>
                )}
                {summary.available > 0 && (
                  <span className="chip !py-0.5 !px-2 text-[11px] gap-1 text-accent-green">
                    <span className="w-1.5 h-1.5 rounded-full bg-accent-green" />{summary.available} available
                  </span>
                )}
              </div>
            )}
          </div>
          {visibleRequests.length === 0 ? (
            <div className="card p-8 text-center">
              <p className="muted text-sm">You haven't requested anything yet. Search above to add movies and shows.</p>
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {visibleRequests.map(req => {
                const e = enrichReq(req);
                const s = reqState(req);
                const watchable = s.tone === 'available';
                return (
                  <div key={req.id} className="card p-3 flex gap-3">
                    <div className="w-14 h-[84px] shrink-0 rounded-lg overflow-hidden bg-ink-800">
                      <Poster url={e.posterUrl} title={e.displayTitle} />
                    </div>
                    <div className="flex-1 min-w-0 flex flex-col">
                      <div className="flex items-start gap-2">
                        <p className="text-sm font-medium text-white leading-tight line-clamp-2 flex-1">{e.displayTitle}</p>
                        <button
                          onClick={() => dismiss(req.id)}
                          className="icon-btn !p-1 -mr-1 -mt-0.5 shrink-0 text-slate-500 hover:text-white"
                          aria-label={`Remove ${e.displayTitle} from your list`}
                          title="Remove from list"
                        >
                          <Icon.Close size={15} />
                        </button>
                      </div>
                      <div className="flex items-center gap-2 mt-1.5 flex-wrap">
                        <span className="chip !py-0.5 !px-2 text-[10px] gap-1">
                          {req.mediaType === 'movie' ? <Icon.Movie size={10} /> : <Icon.TV size={10} />}
                          {req.mediaType === 'movie' ? 'Movie' : 'TV'}
                        </span>
                        <Badge color={s.color}>
                          <StateIcon icon={s.icon} size={11} />
                          {s.label}
                        </Badge>
                      </div>
                      {/* progress feel */}
                      {s.tone !== 'declined' && (
                        <ProgressBar
                          value={s.progress}
                          className={cx('mt-2', s.tone === 'processing' && 'animate-pulse')}
                          color={s.tone === 'available' ? 'bg-accent-green' : s.tone === 'processing' ? 'bg-accent-cyan' : 'bg-accent-amber'}
                        />
                      )}
                      <div className="flex items-center gap-2 mt-auto pt-1.5">
                        <p className="text-[11px] muted truncate flex-1">
                          {req.requestedBy ? `by ${req.requestedBy}` : ''}
                          {req.createdAt ? `${req.requestedBy ? ' • ' : ''}${formatRelative(req.createdAt)}` : ''}
                        </p>
                        {watchable && (
                          <button
                            onClick={() => openInLibrary(e.resolvedName, req.mediaType)}
                            className="btn-ghost !py-1 !px-2 text-[11px] gap-1 text-accent-green shrink-0"
                          >
                            <Icon.Play size={11} /> Watch
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
      </>
      ) : (
        <div className="animate-fade-in">
          {/* ---- Music search bar ---- */}
          <div className="sticky top-0 z-20 -mx-1 px-1 py-2 mb-6 bg-ink-950/80 backdrop-blur-md">
            <div className="relative">
              <div className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-500 pointer-events-none">
                {musicSearching ? <Spinner size={18} /> : <Icon.Search size={20} />}
              </div>
              <input
                ref={musicInputRef}
                value={musicQuery}
                onChange={e => setMusicQuery(e.target.value)}
                placeholder="Search for an artist…"
                autoComplete="off"
                className="input w-full !pl-12 !pr-11 !py-3.5 text-base rounded-2xl"
              />
              {musicQuery && (
                <button
                  onClick={() => { setMusicQuery(''); musicInputRef.current?.focus(); }}
                  className="absolute right-3 top-1/2 -translate-y-1/2 icon-btn"
                  aria-label="Clear search"
                >
                  <Icon.Close size={18} />
                </button>
              )}
            </div>
          </div>

          {/* ---- Music: trending + my requests (empty search) or results ---- */}
          {!musicDebounced ? (
            musicStaticLoading && musicTrending.length === 0 && musicMine.length === 0 ? (
              <GridSkeleton count={6} />
            ) : musicTrending.length === 0 && musicMine.length === 0 ? (
              <EmptyState
                icon={<Icon.Music size={30} />}
                title="Search any artist to add their music to your library"
                subtitle="Find any artist and Aerie will fetch their discography into your library."
              />
            ) : (
              <>
                {musicTrending.length > 0 && (
                  <div className="mb-10">
                    <div className="flex items-center gap-2 mb-4">
                      <Icon.Bolt size={18} className="text-accent-amber" />
                      <h2 className="section-title !mb-0">Trending now</h2>
                    </div>
                    <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-3 sm:gap-4">
                      {musicTrending.map(musicCard)}
                    </div>
                  </div>
                )}
                <div className="mb-4">
                  <div className="flex items-center gap-2 mb-4">
                    <Icon.Clock size={18} className="text-brand-400" />
                    <h2 className="section-title !mb-0">My requests</h2>
                  </div>
                  {musicMine.length === 0 ? (
                    <div className="card p-8 text-center">
                      <p className="muted text-sm">You haven't requested any music yet. Search above or pick a trending artist.</p>
                    </div>
                  ) : (
                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                      {musicMine.map(mr => {
                        const s = mr.status;
                        const badge = s === 'available' ? { color: 'green' as const, icon: 'check' as const, label: 'In library' }
                          : s === 'downloading' ? { color: 'cyan' as const, icon: 'download' as const, label: `Downloading ${mr.percent}%` }
                          : s === 'removed' ? { color: 'slate' as const, icon: 'close' as const, label: 'Removed' }
                          : { color: 'amber' as const, icon: 'clock' as const, label: 'Searching' };
                        return (
                          <div key={mr.foreignArtistId || mr.name} className="card p-3 flex gap-3">
                            <div className="w-14 h-14 shrink-0 rounded-lg overflow-hidden bg-ink-800">
                              <ArtistImage url={mr.posterUrl} name={mr.name} />
                            </div>
                            <div className="flex-1 min-w-0 flex flex-col">
                              <div className="flex items-start gap-2">
                                <p className="text-sm font-medium text-white leading-tight line-clamp-1 flex-1">{mr.name}</p>
                                <Badge color={badge.color}>
                                  <StateIcon icon={badge.icon} size={11} />
                                  {badge.label}
                                </Badge>
                              </div>
                              {s !== 'removed' && (
                                <ProgressBar
                                  value={s === 'available' ? 100 : s === 'downloading' ? Math.max(5, mr.percent) : 8}
                                  className={cx('mt-2', s === 'downloading' && 'animate-pulse')}
                                  color={s === 'available' ? 'bg-accent-green' : s === 'downloading' ? 'bg-accent-cyan' : 'bg-accent-amber'}
                                />
                              )}
                              <div className="flex items-center gap-2 mt-auto pt-1.5">
                                <p className="text-[11px] muted truncate flex-1">
                                  {mr.requestedBy ? `by ${mr.requestedBy}` : ''}
                                  {mr.createdAt ? `${mr.requestedBy ? ' • ' : ''}${formatRelative(mr.createdAt)}` : ''}
                                </p>
                                {s === 'available' && (
                                  <button
                                    onClick={() => navigate('/music')}
                                    className="btn-ghost !py-1 !px-2 text-[11px] gap-1 text-accent-green shrink-0"
                                  >
                                    <Icon.Play size={11} /> Listen
                                  </button>
                                )}
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              </>
            )
          ) : musicSearching && musicResults.length === 0 ? (
            <div className="grid place-items-center py-24 text-brand-400">
              <Spinner size={32} />
            </div>
          ) : musicError ? (
            <EmptyState
              icon={<Icon.Music size={28} />}
              title="Music search is unavailable"
              subtitle="Could not reach the music server (Lidarr). Check that it is running, then search again."
            />
          ) : musicResults.length === 0 ? (
            <EmptyState
              icon={<Icon.Search size={28} />}
              title="No artists found"
              subtitle={`Nothing found for “${musicDebounced}”. Try another name.`}
            />
          ) : (
            <div className="mb-10">
              <div className="flex items-baseline justify-between mb-4">
                <h2 className="section-title">Artists</h2>
                <span className="muted text-sm">{musicResults.length} result{musicResults.length === 1 ? '' : 's'}</span>
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-3 sm:gap-4">
                {musicResults.map(musicCard)}
              </div>
            </div>
          )}
        </div>
      )}

      {/* ---- Detail modal ---- */}
      <Modal open={!!selected} onClose={() => setSelected(null)} size="lg">
        {selected && (() => {
          const avail = availFor(overrideFor(selected) ?? selected.status);
          const k = keyFor(selected);
          return (
            <div className="-m-5">
              <div className="relative h-44 sm:h-56 overflow-hidden rounded-t-2xl bg-ink-800">
                {selected.backdropUrl || selected.posterUrl
                  ? <img src={api.requests.imageUrl((selected.backdropUrl || selected.posterUrl)!)} alt="" className="w-full h-full object-cover" />
                  : <div className="w-full h-full bg-gradient-to-br from-brand-900 to-ink-900" />}
                <div className="absolute inset-0 bg-gradient-to-t from-ink-900 via-ink-900/40 to-transparent" />
                <button onClick={() => setSelected(null)} className="absolute top-3 right-3 icon-btn bg-black/50 backdrop-blur-sm"><Icon.Close size={18} /></button>
              </div>
              <div className="px-5 sm:px-6 pb-6 -mt-16 relative flex gap-4">
                <div className="w-24 sm:w-32 shrink-0 rounded-xl overflow-hidden shadow-float bg-ink-800 aspect-[2/3]">
                  <Poster url={selected.posterUrl} title={selected.title} />
                </div>
                <div className="flex-1 min-w-0 pt-16 sm:pt-20">
                  <h2 className="text-xl sm:text-2xl font-bold text-white tracking-tight leading-tight">{selected.title}</h2>
                  <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 mt-2 text-sm text-slate-300">
                    <span className="chip !py-0.5 !px-2 text-[11px] gap-1">
                      {selected.mediaType === 'movie' ? <Icon.Movie size={11} /> : <Icon.TV size={11} />}
                      {selected.mediaType === 'movie' ? 'Movie' : 'TV Series'}
                    </span>
                    {selected.year && <span>{selected.year}</span>}
                    {!!selected.rating && <span className="text-accent-amber gap-0.5 inline-flex items-center"><Icon.Star size={12} /> {selected.rating.toFixed(1)}</span>}
                  </div>
                </div>
              </div>
              <div className="px-5 sm:px-6 pb-6 -mt-2">
                {selected.overview && <p className="text-slate-300 text-sm leading-relaxed">{selected.overview}</p>}
                <div className="mt-5 flex flex-wrap gap-3">
                  {avail.kind === 'request' ? (
                    <button
                      onClick={() => doRequest(selected)}
                      disabled={busy.has(k)}
                      className="btn-primary !px-6 !py-3 gap-2 disabled:opacity-60"
                    >
                      {busy.has(k) ? <Spinner size={16} /> : <Icon.Plus size={18} />}
                      {selected.mediaType === 'tv' ? 'Request all seasons' : 'Request movie'}
                    </button>
                  ) : isWatchable(overrideFor(selected) ?? selected.status) ? (
                    <button
                      onClick={() => openInLibrary(selected.title, selected.mediaType)}
                      className="btn-primary !px-6 !py-3 gap-2"
                    >
                      <Icon.Play size={16} /> Watch now
                    </button>
                  ) : (
                    <div className="flex items-center gap-2 text-sm font-medium text-slate-300 px-4 py-3 rounded-xl bg-white/[0.04]">
                      <Icon.Clock size={18} className="text-accent-amber" />
                      {avail.label}
                    </div>
                  )}
                  <button className="btn-secondary !px-5 !py-3" onClick={() => setSelected(null)}>Close</button>
                </div>
              </div>
            </div>
          );
        })()}
      </Modal>
    </div>
  );
}
