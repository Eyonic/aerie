import React, { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams, useNavigate, useLocation } from 'react-router-dom';
import { api } from '../lib/api';
import { Icon } from '../lib/icons';
import { cx } from '../lib/utils';
import { toast } from '../lib/store';
import { EmptyState, Modal, Badge, Menu, Spinner } from '../components/ui';
import { PosterCard, VideoPlayer } from '../components/media';
import type { MediaItem } from '../lib/model';

function runtimeLabel(min?: number) {
  if (!min) return '';
  const h = Math.floor(min / 60);
  const m = min % 60;
  return h ? `${h}h ${m}m` : `${m}m`;
}

// Poster with a "watched" badge overlaid on top of the shared PosterCard.
function CheckPoster({ item, aspect = 'portrait', watched, onClick }: { item: MediaItem; aspect?: 'portrait' | 'landscape'; watched?: boolean; onClick?: () => void }) {
  return (
    <div className="relative">
      <PosterCard item={item} aspect={aspect} onClick={onClick} />
      {watched && (
        <div className="absolute top-2 left-2 w-6 h-6 rounded-full bg-brand-500 text-white grid place-items-center shadow-float ring-2 ring-black/40 pointer-events-none">
          <Icon.Check size={14} />
        </div>
      )}
    </div>
  );
}

// A horizontal rail that shows watched badges (mirrors the shared Rail).
function PosterRail({ title, subtitle, items, aspect, isWatched, onOpen }: { title: string; subtitle?: string; items: MediaItem[]; aspect?: 'portrait' | 'landscape'; isWatched: (i: MediaItem) => boolean; onOpen: (i: MediaItem) => void }) {
  if (!items.length) return null;
  return (
    <div className="mb-8">
      <div className="mb-3">
        <h2 className="section-title">{title}</h2>
        {subtitle && <p className="muted text-xs mt-0.5">{subtitle}</p>}
      </div>
      <div className="flex gap-4 overflow-x-auto pb-2 -mx-1 px-1 snap-x">
        {items.map(it => (
          <div key={it.id} className={cx('snap-start shrink-0', aspect === 'landscape' ? 'w-64' : 'w-36')}>
            <CheckPoster item={it} aspect={aspect} watched={isWatched(it)} onClick={() => onOpen(it)} />
          </div>
        ))}
      </div>
    </div>
  );
}

type SortKey = 'recent' | 'title' | 'rating' | 'year';
const SORT_LABELS: Record<SortKey, string> = {
  recent: 'Recently added',
  title: 'Title (A–Z)',
  rating: 'Top rated',
  year: 'Newest first',
};

// ---- Skeletons ----
function RailSkeleton({ wide = false }: { wide?: boolean }) {
  return (
    <div className="mb-8">
      <div className="h-4 w-40 rounded bg-white/[0.06] mb-4 animate-pulse" />
      <div className="flex gap-4 overflow-hidden">
        {Array.from({ length: 8 }).map((_, i) => (
          <div key={i} className={cx('shrink-0', wide ? 'w-64' : 'w-36')}>
            <div className={cx('rounded-xl bg-white/[0.05] animate-pulse', wide ? 'aspect-video' : 'aspect-[2/3]')} />
            <div className="h-3 w-3/4 rounded bg-white/[0.05] mt-2 animate-pulse" />
          </div>
        ))}
      </div>
    </div>
  );
}

function LoadingSkeleton() {
  return (
    <div className="animate-fade-in">
      <div className="relative h-[42vh] min-h-[300px] sm:h-[52vh] rounded-3xl overflow-hidden bg-ink-850 mb-8">
        <div className="absolute inset-0 animate-pulse bg-gradient-to-br from-white/[0.04] to-transparent" />
        <div className="absolute bottom-0 left-0 p-6 sm:p-8 space-y-4 w-full max-w-xl">
          <div className="h-10 w-2/3 rounded-lg bg-white/[0.08] animate-pulse" />
          <div className="h-3 w-full rounded bg-white/[0.05] animate-pulse" />
          <div className="h-3 w-4/5 rounded bg-white/[0.05] animate-pulse" />
          <div className="flex gap-3 pt-2">
            <div className="h-11 w-32 rounded-xl bg-white/[0.08] animate-pulse" />
            <div className="h-11 w-32 rounded-xl bg-white/[0.05] animate-pulse" />
          </div>
        </div>
      </div>
      <RailSkeleton wide />
      <RailSkeleton />
      <RailSkeleton />
    </div>
  );
}

export default function Movies() {
  const [loading, setLoading] = useState(true);
  const [configured, setConfigured] = useState(true);
  const [movies, setMovies] = useState<MediaItem[]>([]);
  const [resume, setResume] = useState<MediaItem[]>([]);
  const [recs, setRecs] = useState<MediaItem[]>([]);
  const [selected, setSelected] = useState<MediaItem | null>(null);
  const [playing, setPlaying] = useState<MediaItem | null>(null);
  const [similar, setSimilar] = useState<MediaItem[] | null>(null);
  const [watchedIds, setWatchedIds] = useState<Set<string>>(new Set());
  const [unwatchedIds, setUnwatchedIds] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState('');
  const [genre, setGenre] = useState<string>('all');
  const [sort, setSort] = useState<SortKey>('recent');
  // Server-side search results (whole library, not just the loaded page). null = not searching.
  const [serverResults, setServerResults] = useState<MediaItem[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const location = useLocation();

  // ---- Deep-link reader: /movies?item=<id> opens that title's detail modal ----
  useEffect(() => {
    const itemId = searchParams.get('item');
    if (!itemId) return;
    let alive = true;
    api.media.item(itemId)
      .then(it => { if (alive && it) setSelected(it); })
      .catch(() => { if (alive) toast('Could not open that title', 'error'); })
      .finally(() => { if (alive) navigate(location.pathname, { replace: true }); });
    return () => { alive = false; };
  }, [searchParams]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const status = await api.media.status();
        if (cancelled) return;
        if (!status?.configured) {
          setConfigured(false);
          setLoading(false);
          return;
        }
        setConfigured(true);
        const [mv, rv, rec] = await Promise.all([
          api.media.movies().catch(() => [] as MediaItem[]),
          api.media.resumeVideo().catch(() => [] as MediaItem[]),
          api.media.recommendations().catch(() => ({ nextUp: [], suggestions: [], recentlyAdded: [] })),
        ]);
        if (cancelled) return;
        setMovies(mv || []);
        // Prefer true movies in the resume rail, but fall back to whatever resume returns.
        const movieIds = new Set((mv || []).map(m => m.id));
        const resumeMovies = (rv || []).filter(r => r.type === 'Movie' || movieIds.has(r.id));
        setResume(resumeMovies.length ? resumeMovies : (rv || []));
        // Recommendations, restricted to movies for this page.
        const resumeIds = new Set((resumeMovies.length ? resumeMovies : (rv || [])).map(r => r.id));
        setRecs((rec?.suggestions || []).filter(s => s.type === 'Movie' && !resumeIds.has(s.id)).slice(0, 18));
      } catch (e: any) {
        if (!cancelled) {
          setConfigured(false);
          toast('Could not load movies', 'error', e?.message);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Load "more like this" whenever the detail modal opens on a new title.
  useEffect(() => {
    if (!selected) { setSimilar(null); return; }
    let alive = true;
    setSimilar(null);
    api.media.similar(selected.id)
      .then(list => { if (alive) setSimilar((list || []).filter(s => s.id !== selected.id).slice(0, 18)); })
      .catch(() => { if (alive) setSimilar([]); });
    return () => { alive = false; };
  }, [selected?.id]);

  // ---- Server-side search: query the WHOLE library, not just the loaded page ----
  useEffect(() => {
    const q = query.trim();
    if (!q) { setServerResults(null); setSearching(false); return; }
    let alive = true;
    setSearching(true);
    const t = setTimeout(() => {
      api.media.search(q)
        .then(list => { if (alive) setServerResults((list || []).filter(m => m.type === 'Movie')); })
        .catch(() => { if (alive) setServerResults([]); })
        .finally(() => { if (alive) setSearching(false); });
    }, 300);
    return () => { alive = false; clearTimeout(t); };
  }, [query]);

  const isWatched = (item: MediaItem) => {
    if (unwatchedIds.has(item.id)) return false;
    if (watchedIds.has(item.id)) return true;
    return item.playedPct === 100;
  };

  const toggleWatched = async (item: MediaItem) => {
    const next = !isWatched(item);
    setWatchedIds(prev => { const s = new Set(prev); next ? s.add(item.id) : s.delete(item.id); return s; });
    setUnwatchedIds(prev => { const s = new Set(prev); next ? s.delete(item.id) : s.add(item.id); return s; });
    try {
      await api.media.setPlayed(item.id, next, item.runtimeTicks);
      toast(next ? 'Marked as watched' : 'Marked as unwatched', 'success', item.name);
    } catch (e: any) {
      // revert on failure
      setWatchedIds(prev => { const s = new Set(prev); next ? s.delete(item.id) : s.add(item.id); return s; });
      setUnwatchedIds(prev => { const s = new Set(prev); next ? s.add(item.id) : s.delete(item.id); return s; });
      toast('Could not update', 'error', e?.message);
    }
  };

  const recentlyAdded = useMemo(() => movies.slice(0, 18), [movies]);

  const allGenres = useMemo(() => {
    const set = new Set<string>();
    for (const m of movies) for (const g of m.genres || []) set.add(g);
    return Array.from(set).sort();
  }, [movies]);

  const genreRails = useMemo(() => {
    const map = new Map<string, MediaItem[]>();
    for (const m of movies) {
      for (const g of m.genres || []) {
        if (!map.has(g)) map.set(g, []);
        map.get(g)!.push(m);
      }
    }
    return Array.from(map.entries())
      .filter(([, list]) => list.length >= 3)
      .sort((a, b) => b[1].length - a[1].length)
      .slice(0, 4)
      .map(([genre, list]) => ({ genre, list: list.slice(0, 18) }));
  }, [movies]);

  const filtering = query.trim() !== '' || genre !== 'all' || sort !== 'recent';

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    // When searching, use the server results (whole library). The server already
    // matched the query, so don't re-filter by name — only apply the genre facet.
    const usingServer = q !== '' && serverResults !== null;
    const base = usingServer ? serverResults! : movies;
    let list = base.filter(m => {
      if (genre !== 'all' && !(m.genres || []).includes(genre)) return false;
      if (!usingServer && q && !(m.name || '').toLowerCase().includes(q)) return false;
      return true;
    });
    if (sort === 'title') list = [...list].sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    else if (sort === 'rating') list = [...list].sort((a, b) => (b.communityRating || 0) - (a.communityRating || 0));
    else if (sort === 'year') list = [...list].sort((a, b) => (b.year || 0) - (a.year || 0));
    return list;
  }, [movies, serverResults, query, genre, sort]);

  const hero = useMemo<MediaItem | null>(() => {
    const withBackdrop = (arr: MediaItem[]) => arr.find(m => m.backdropUrl || m.posterUrl);
    return withBackdrop(resume) || withBackdrop(movies) || movies[0] || null;
  }, [resume, movies]);

  if (loading) return <LoadingSkeleton />;

  if (!configured || movies.length === 0) {
    return (
      <div className="animate-fade-in">
        <div className="flex items-center gap-3 mb-6">
          <div className="w-10 h-10 rounded-xl grid place-items-center bg-brand-500/15 text-brand-400"><Icon.Movie size={22} /></div>
          <div>
            <h1 className="text-2xl font-bold text-white tracking-tight">Movies</h1>
            <p className="muted text-sm">Your cinematic library</p>
          </div>
        </div>
        <EmptyState
          icon={<Icon.Movie size={30} />}
          title={configured ? 'No movies found' : 'Movies engine not connected'}
          subtitle={configured ? 'Add movies to your library, or request new titles to be added automatically.' : 'Connect a media server in Settings to stream your movie collection in-app.'}
          action={<Link to="/requests" className="btn-primary gap-2"><Icon.Plus size={18} /> Request a movie</Link>}
        />
      </div>
    );
  }

  const heroBg = hero?.backdropUrl || hero?.posterUrl;

  // ---- Search / filter toolbar (shared) ----
  const toolbar = (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[180px]">
          <span className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500 pointer-events-none"><Icon.Search size={16} /></span>
          <input
            className="input !pl-9 w-full"
            placeholder="Search movies…"
            value={query}
            onChange={e => setQuery(e.target.value)}
          />
          {query && (
            <button
              className="absolute right-2 top-1/2 -translate-y-1/2 icon-btn !w-7 !h-7"
              onClick={() => setQuery('')}
              aria-label="Clear search"
            ><Icon.Close size={14} /></button>
          )}
        </div>
        <Menu
          trigger={
            <span className="btn-secondary gap-2 whitespace-nowrap">
              <Icon.Filter size={16} /> <span className="hidden sm:inline">{SORT_LABELS[sort]}</span><span className="sm:hidden">Sort</span>
              <Icon.ChevronDown size={14} />
            </span>
          }
          items={(Object.keys(SORT_LABELS) as SortKey[]).map(k => ({
            label: SORT_LABELS[k],
            icon: sort === k ? <Icon.Check size={16} /> : <span className="w-4" />,
            onClick: () => setSort(k),
          }))}
        />
        <Link to="/requests" className="btn-primary gap-2 whitespace-nowrap">
          <Icon.Plus size={16} /> <span className="hidden sm:inline">Request more</span><span className="sm:hidden">Request</span>
        </Link>
      </div>

      {allGenres.length > 0 && (
        <div className="flex gap-2 overflow-x-auto pb-1 -mx-1 px-1 snap-x">
          <button
            onClick={() => setGenre('all')}
            className={cx('chip shrink-0 whitespace-nowrap transition-colors', genre === 'all' ? '!bg-brand-500 !text-white !border-brand-500' : 'hover:!bg-white/[0.08]')}
          >All</button>
          {allGenres.map(g => (
            <button
              key={g}
              onClick={() => setGenre(g)}
              className={cx('chip shrink-0 whitespace-nowrap transition-colors', genre === g ? '!bg-brand-500 !text-white !border-brand-500' : 'hover:!bg-white/[0.08]')}
            >{g}</button>
          ))}
        </div>
      )}
    </div>
  );

  return (
    <div className="animate-fade-in">
      {/* ---- Search / sort / genre toolbar (sticky near the top, always visible) ---- */}
      <div className="sticky top-0 z-20 -mx-4 lg:-mx-8 px-4 lg:px-8 pt-1 pb-3 mb-5 bg-ink-950/85 backdrop-blur-xl border-b border-white/[0.05]">
        {toolbar}
      </div>

      {/* ---- Hero banner (hidden while actively filtering to focus results) ---- */}
      {hero && !filtering && (
        <div className="relative h-[44vh] min-h-[320px] sm:h-[54vh] sm:min-h-[400px] rounded-3xl overflow-hidden mb-8 shadow-float">
          {heroBg
            ? <img src={heroBg} className="absolute inset-0 w-full h-full object-cover scale-105" />
            : <div className="absolute inset-0 bg-gradient-to-br from-brand-900 to-ink-950" />}
          <div className="absolute inset-0 bg-gradient-to-t from-ink-950 via-ink-950/60 to-transparent" />
          <div className="absolute inset-0 bg-gradient-to-r from-ink-950/90 via-ink-950/30 to-transparent" />

          <div className="relative h-full flex flex-col justify-end p-5 sm:p-10 max-w-2xl">
            {resume.some(r => r.id === hero.id) && (
              <span className="chip w-fit mb-3 bg-brand-500/20 text-brand-200 border-brand-500/30">Continue watching</span>
            )}
            <h1 className="text-2xl sm:text-5xl font-bold text-white tracking-tight drop-shadow-lg line-clamp-2">{hero.name}</h1>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-3 text-sm text-slate-300">
              {hero.year && <span>{hero.year}</span>}
              {hero.runtimeMinutes ? <><span className="text-slate-600">•</span><span>{runtimeLabel(hero.runtimeMinutes)}</span></> : null}
              {hero.communityRating ? <><span className="text-slate-600">•</span><span className="text-accent-amber">★ {hero.communityRating.toFixed(1)}</span></> : null}
              {(hero.genres || []).slice(0, 2).map(g => <span key={g} className="chip !py-0.5 !px-2 text-[11px]">{g}</span>)}
            </div>
            {hero.overview && <p className="text-slate-300 mt-4 line-clamp-3 max-w-xl leading-relaxed hidden sm:block">{hero.overview}</p>}
            {typeof hero.progressPct === 'number' && hero.progressPct > 0 && hero.progressPct < 99 && (
              <div className="mt-4 max-w-sm">
                <div className="h-1 rounded-full bg-white/15 overflow-hidden"><div className="h-full bg-brand-500" style={{ width: `${hero.progressPct}%` }} /></div>
              </div>
            )}
            <div className="flex flex-wrap gap-2 sm:gap-3 mt-6">
              <button className="btn-primary !px-5 sm:!px-6 !py-3 text-base gap-2" onClick={() => setPlaying(hero)}>
                <Icon.Play size={20} /> {typeof hero.progressPct === 'number' && hero.progressPct > 0 && hero.progressPct < 99 ? 'Resume' : 'Play'}
              </button>
              <button className="btn-secondary !px-5 sm:!px-6 !py-3 text-base gap-2" onClick={() => setSelected(hero)}>
                <Icon.Info size={20} /> More info
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ---- Rails (hidden while filtering) ---- */}
      {!filtering && (
        <>
          {resume.length > 0 && <PosterRail title="Continue watching" items={resume} aspect="landscape" isWatched={isWatched} onOpen={setSelected} />}
          {recs.length > 0 && <PosterRail title="Recommended for you" subtitle="Picked from what you love" items={recs} aspect="portrait" isWatched={isWatched} onOpen={setSelected} />}
          <PosterRail title="Recently added" items={recentlyAdded} aspect="portrait" isWatched={isWatched} onOpen={setSelected} />
          {genreRails.map(({ genre, list }) => (
            <PosterRail key={genre} title={genre} items={list} aspect="portrait" isWatched={isWatched} onOpen={setSelected} />
          ))}
        </>
      )}

      {/* ---- Full library grid ---- */}
      <div className="mt-4">
        <div className="flex items-center justify-between mb-4">
          <h2 className="section-title">{filtering ? 'Results' : 'All movies'}</h2>
          <span className="muted text-sm">{filtered.length} title{filtered.length === 1 ? '' : 's'}</span>
        </div>
        {searching && filtered.length === 0 ? (
          <div className="py-16 grid place-items-center"><Spinner size={28} /></div>
        ) : filtered.length === 0 ? (
          <EmptyState
            icon={<Icon.Search size={28} />}
            title="No matches"
            subtitle="No movies match your filters. Try a different search, or request the title to be added."
            action={<Link to="/requests" className="btn-primary gap-2"><Icon.Plus size={18} /> Request it</Link>}
          />
        ) : (
          <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 xl:grid-cols-8 gap-3 sm:gap-4">
            {filtered.map(m => <CheckPoster key={m.id} item={m} aspect="portrait" watched={isWatched(m)} onClick={() => setSelected(m)} />)}
          </div>
        )}
      </div>

      {/* ---- Detail modal ---- */}
      <Modal open={!!selected} onClose={() => setSelected(null)} size="xl">
        {selected && (
          <div className="-m-5 sm:-m-6 w-[calc(100vw-2rem)] sm:w-auto max-h-[90vh] sm:max-h-[85vh] overflow-y-auto overflow-x-hidden">
            <div className="relative h-52 sm:h-72 overflow-hidden rounded-t-2xl">
              {(selected.backdropUrl || selected.posterUrl)
                ? <img src={selected.backdropUrl || selected.posterUrl} className="w-full h-full object-cover" />
                : <div className="w-full h-full bg-gradient-to-br from-brand-900 to-ink-900" />}
              <div className="absolute inset-0 bg-gradient-to-t from-ink-900 via-ink-900/40 to-transparent" />
              <button
                className="absolute top-3 right-3 icon-btn bg-black/40 text-white hover:bg-black/60 backdrop-blur-sm"
                onClick={() => setSelected(null)}
                aria-label="Close"
              ><Icon.Close size={18} /></button>
            </div>
            <div className="px-5 sm:px-8 pb-7 -mt-20 sm:-mt-24 relative flex flex-col sm:flex-row gap-5 sm:gap-6">
              <div className="w-28 sm:w-44 shrink-0 rounded-xl overflow-hidden shadow-float bg-ink-800 aspect-[2/3]">
                {(selected.posterUrl || selected.thumbUrl)
                  ? <img src={selected.posterUrl || selected.thumbUrl} className="w-full h-full object-cover" />
                  : <div className="w-full h-full grid place-items-center text-slate-600"><Icon.Movie size={32} /></div>}
              </div>
              <div className="flex-1 min-w-0 sm:pt-24">
                <h2 className="text-2xl sm:text-3xl font-bold text-white tracking-tight">{selected.name}</h2>
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-2 text-sm text-slate-300">
                  {selected.year && <span>{selected.year}</span>}
                  {selected.runtimeMinutes ? <><span className="text-slate-600">•</span><span>{runtimeLabel(selected.runtimeMinutes)}</span></> : null}
                  {selected.communityRating ? <Badge color="amber">★ {selected.communityRating.toFixed(1)}</Badge> : null}
                </div>
                {(selected.genres || []).length > 0 && (
                  <div className="flex flex-wrap gap-2 mt-3">
                    {selected.genres!.map(g => <span key={g} className="chip !py-0.5 !px-2.5 text-[11px]">{g}</span>)}
                  </div>
                )}
                {selected.overview && <p className="text-slate-300 mt-4 leading-relaxed text-sm max-w-2xl">{selected.overview}</p>}
                {typeof selected.progressPct === 'number' && selected.progressPct > 0 && selected.progressPct < 99 && (
                  <div className="mt-4 max-w-xs">
                    <div className="flex justify-between text-xs muted mb-1"><span>Watched</span><span>{Math.round(selected.progressPct)}%</span></div>
                    <div className="h-1.5 rounded-full bg-white/10 overflow-hidden"><div className="h-full bg-brand-500" style={{ width: `${selected.progressPct}%` }} /></div>
                  </div>
                )}
                <div className="flex flex-wrap gap-3 mt-6">
                  <button className="btn-primary !px-6 !py-3 text-base gap-2" onClick={() => setPlaying(selected)}>
                    <Icon.Play size={20} /> {typeof selected.progressPct === 'number' && selected.progressPct > 0 && selected.progressPct < 99 ? 'Resume' : 'Play'}
                  </button>
                  <button
                    className={cx('!px-5 !py-3 gap-2', isWatched(selected) ? 'btn-primary !bg-brand-600/80' : 'btn-secondary')}
                    onClick={() => toggleWatched(selected)}
                  >
                    <Icon.Check size={18} /> {isWatched(selected) ? 'Watched' : 'Mark watched'}
                  </button>
                  <button className="btn-secondary !px-5 !py-3" onClick={() => setSelected(null)}>Close</button>
                </div>
              </div>
            </div>

            {/* ---- More like this ---- */}
            <div className="px-5 sm:px-8 pb-8">
              <h3 className="section-title mb-3">More like this</h3>
              {/* Reserve the loaded row's height for every state so the modal
                  opens at its settled size instead of growing (and re-centering)
                  when the results arrive a beat later. */}
              <div className="min-h-[13.5rem] sm:min-h-[15.25rem] grid">
                {similar === null ? (
                  <div className="place-self-center"><Spinner size={26} /></div>
                ) : similar.length === 0 ? (
                  <p className="muted text-sm py-2">No similar titles found yet.</p>
                ) : (
                  <div className="self-start w-full min-w-0 flex gap-3 sm:gap-4 overflow-x-auto pb-2 -mx-1 px-1 snap-x">
                    {similar.map(s => (
                      <div key={s.id} className="snap-start shrink-0 w-28 sm:w-32">
                        <CheckPoster item={s} aspect="portrait" watched={isWatched(s)} onClick={() => setSelected(s)} />
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
      </Modal>

      {/* ---- Fullscreen player ---- */}
      {playing && <VideoPlayer item={playing} onClose={() => setPlaying(null)} />}
    </div>
  );
}
