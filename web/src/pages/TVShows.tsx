import React, { useState, useEffect, useMemo, useRef } from 'react';
import { Link, useSearchParams, useNavigate, useLocation } from 'react-router-dom';
import { api } from '../lib/api';
import { Icon } from '../lib/icons';
import { cx } from '../lib/utils';
import { toast } from '../lib/store';
import { Spinner, PageLoader, EmptyState, PageHeader, Modal, Badge, Menu } from '../components/ui';
import { PosterCard, VideoPlayer } from '../components/media';
import type { MediaItem } from '../lib/model';
import { imageSrcSet } from '../lib/images';
import { episodeNeighbors, orderEpisodes } from '../lib/episodes';

function runtimeLabel(m?: number) {
  if (!m) return '';
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

type SortKey = 'recent' | 'title' | 'rating' | 'year';
const SORT_LABELS: Record<SortKey, string> = {
  recent: 'Recently added',
  title: 'Title (A–Z)',
  rating: 'Top rated',
  year: 'Newest first',
};

// Poster with a "watched" badge overlaid on the shared PosterCard.
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

// ---- Episode row ----
function EpisodeRow({ ep, index, onPlay, forceWatched }: { ep: MediaItem; index: number; onPlay: () => void; forceWatched?: boolean }) {
  const thumb = ep.thumbUrl || ep.backdropUrl || ep.posterUrl;
  const epNo = ep.episodeNumber ?? index + 1;
  const watched = forceWatched || (typeof ep.progressPct === 'number' && ep.progressPct >= 99);
  return (
    <button
      onClick={onPlay}
      className="group w-full flex gap-3 sm:gap-4 p-2.5 sm:p-3 rounded-xl text-left hover:bg-white/[0.04] transition-colors"
    >
      <div className="relative w-32 sm:w-48 shrink-0 aspect-video rounded-lg overflow-hidden bg-ink-800 shadow-card">
        {thumb ? (
          <img src={thumb} srcSet={imageSrcSet(thumb, [320, 640])} sizes="(max-width: 640px) 128px, 192px"
            loading="lazy" decoding="async" className="w-full h-full object-cover" />
        ) : (
          <div className="w-full h-full grid place-items-center text-slate-600"><Icon.TV size={22} /></div>
        )}
        <div className="absolute inset-0 bg-gradient-to-t from-black/60 to-transparent opacity-0 group-hover:opacity-100 transition-opacity" />
        <div className="absolute inset-0 grid place-items-center opacity-0 group-hover:opacity-100 transition-opacity">
          <div className="w-10 h-10 rounded-full bg-white/90 text-ink-900 grid place-items-center shadow-float scale-90 group-hover:scale-100 transition-transform">
            <Icon.Play size={18} />
          </div>
        </div>
        {!forceWatched && typeof ep.progressPct === 'number' && ep.progressPct > 0 && ep.progressPct < 99 && (
          <div className="absolute bottom-0 inset-x-0 h-1 bg-black/40"><div className="h-full bg-brand-500" style={{ width: `${ep.progressPct}%` }} /></div>
        )}
      </div>
      <div className="min-w-0 flex-1 py-0.5">
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold text-slate-500 tabular-nums">{epNo}</span>
          <p className="text-sm font-semibold text-white truncate group-hover:text-brand-300 transition-colors">{ep.name}</p>
          {watched && <Icon.Check size={14} className="text-accent-green shrink-0" />}
        </div>
        <div className="flex items-center gap-2 mt-1 text-xs muted">
          {ep.runtimeMinutes ? <span>{runtimeLabel(ep.runtimeMinutes)}</span> : null}
          {ep.communityRating ? <span className="text-amber-400/80">★ {ep.communityRating.toFixed(1)}</span> : null}
        </div>
        {ep.overview && <p className="text-xs text-slate-400 mt-1.5 line-clamp-2 hidden sm:block">{ep.overview}</p>}
      </div>
    </button>
  );
}

// ---- Series detail modal ----
function SeriesDetail({ series, onClose, onPlay, watched, onToggleWatched, isWatched, onOpenSeries }: { series: MediaItem; onClose: () => void; onPlay: (ep: MediaItem, queue?: MediaItem[]) => void; watched: boolean; onToggleWatched: () => Promise<void> | void; isWatched: (i: MediaItem) => boolean; onOpenSeries: (s: MediaItem) => void }) {
  const [seasons, setSeasons] = useState<MediaItem[] | null>(null);
  const [activeSeason, setActiveSeason] = useState<string | null>(null);
  const [episodes, setEpisodes] = useState<MediaItem[] | null>(null);
  const [epLoading, setEpLoading] = useState(false);
  const [similar, setSimilar] = useState<MediaItem[] | null>(null);
  const [busyWatched, setBusyWatched] = useState(false);
  // Bumped after mark-watched to re-pull season/episode played state from the server.
  const [refresh, setRefresh] = useState(0);

  useEffect(() => {
    let alive = true;
    setSimilar(null);
    api.media.similar(series.id)
      .then(list => { if (alive) setSimilar((list || []).filter(s => s.id !== series.id).slice(0, 18)); })
      .catch(() => { if (alive) setSimilar([]); });
    return () => { alive = false; };
  }, [series.id]);

  useEffect(() => {
    let alive = true;
    api.media.children(series.id)
      .then(ch => {
        if (!alive) return;
        const s = ch.filter(c => c.type === 'Season');
        const list = s.length ? s : ch; // some libraries expose episodes directly
        setSeasons(list);
        // Keep the active season across refreshes if it still exists.
        setActiveSeason(prev => (prev && list.some(x => x.id === prev)) ? prev : (list[0]?.id ?? null));
      })
      .catch(() => { if (alive) { setSeasons([]); toast('Could not load seasons', 'error'); } });
    return () => { alive = false; };
  }, [series.id, refresh]);

  useEffect(() => {
    if (!activeSeason || !seasons) return;
    const chosen = seasons.find(s => s.id === activeSeason);
    // If the "seasons" list is actually episodes (flat library), just show them.
    if (chosen && chosen.type === 'Episode') { setEpisodes(seasons.filter(s => s.type === 'Episode')); return; }
    let alive = true;
    setEpLoading(true);
    api.media.children(activeSeason)
      .then(ch => { if (alive) setEpisodes(ch.filter(c => c.type === 'Episode')); })
      .catch(() => { if (alive) { setEpisodes([]); toast('Could not load episodes', 'error'); } })
      .finally(() => { if (alive) setEpLoading(false); });
    return () => { alive = false; };
  }, [activeSeason, seasons, refresh]);

  // Mark-watched: persist via the parent (api.media.setPlayed on the series, which
  // cascades to every episode in Jellyfin), then re-pull so episode rows + the Play
  // button reflect the new played state.
  const handleToggleWatched = async () => {
    if (busyWatched) return;
    setBusyWatched(true);
    try {
      await onToggleWatched();
      setRefresh(r => r + 1);
    } finally {
      setBusyWatched(false);
    }
  };

  const backdrop = series.backdropUrl || series.posterUrl || series.thumbUrl;
  const seasonCount = seasons ? seasons.filter(s => s.type === 'Season').length : 0;

  // Best episode to launch from the current season: in-progress > first unwatched > first.
  const nextEp = useMemo(() => {
    if (!episodes || episodes.length === 0) return null;
    // Whole series marked watched → nothing "up next"; offer a restart from the top.
    if (watched) return episodes[0];
    const inProgress = episodes.find(e => typeof e.progressPct === 'number' && e.progressPct > 0 && e.progressPct < 99);
    if (inProgress) return inProgress;
    const unwatched = episodes.find(e => !(typeof e.progressPct === 'number' && e.progressPct >= 99));
    return unwatched || episodes[0];
  }, [episodes, watched]);

  const playLabel = watched
    ? 'Play again'
    : (nextEp && typeof nextEp.progressPct === 'number' && nextEp.progressPct > 0 && nextEp.progressPct < 99 ? 'Resume' : 'Play');

  return (
    <Modal open onClose={onClose} size="xl">
      <div className="-m-5 sm:-m-6 w-[calc(100vw-2rem)] sm:w-auto max-h-[90vh] sm:max-h-[85vh] overflow-y-auto overflow-x-hidden">
        {/* Cinematic header */}
        <div className="relative h-56 sm:h-72 overflow-hidden">
          {backdrop ? (
            <img src={backdrop} srcSet={imageSrcSet(backdrop, [640, 960, 1280])} sizes="(max-width: 640px) 100vw, 896px" decoding="async" className="w-full h-full object-cover" />
          ) : (
            <div className="w-full h-full grid place-items-center bg-ink-800 text-slate-700"><Icon.TV size={48} /></div>
          )}
          <div className="absolute inset-0 bg-gradient-to-t from-ink-900 via-ink-900/60 to-transparent" />
          <button
            className="absolute top-3 right-3 icon-btn bg-black/40 text-white hover:bg-black/60 backdrop-blur-sm"
            onClick={onClose}
            aria-label="Close"
          ><Icon.Close size={18} /></button>
          <div className="absolute inset-x-0 bottom-0 p-5 sm:p-6">
            <h2 className="text-2xl sm:text-3xl font-bold text-white tracking-tight drop-shadow">{series.name}</h2>
            <div className="flex flex-wrap items-center gap-2 mt-2 text-xs text-slate-300">
              {series.year && <span>{series.year}</span>}
              {series.communityRating ? <span className="text-amber-400">★ {series.communityRating.toFixed(1)}</span> : null}
              {seasonCount > 0 && <Badge color="brand">{seasonCount} season{seasonCount !== 1 ? 's' : ''}</Badge>}
              {series.genres?.slice(0, 3).map(g => <span key={g} className="chip !py-0.5 !px-2 text-[10px]">{g}</span>)}
            </div>
          </div>
        </div>

        <div className="p-5 sm:p-6">
          {/* Prominent play + request */}
          <div className="flex flex-wrap gap-2.5 mb-5">
            <button
              className="btn-primary !px-6 !py-3 text-base gap-2 disabled:opacity-50"
              disabled={!nextEp}
              onClick={() => nextEp && onPlay(nextEp, episodes || undefined)}
            >
              <Icon.Play size={20} />
              {nextEp && nextEp.seasonNumber != null && nextEp.episodeNumber != null
                ? `${playLabel} S${nextEp.seasonNumber}E${nextEp.episodeNumber}`
                : playLabel}
            </button>
            <button
              className={cx('!px-5 !py-3 gap-2 disabled:opacity-60', watched ? 'btn-primary !bg-brand-600/80' : 'btn-secondary')}
              onClick={handleToggleWatched}
              disabled={busyWatched}
            >
              {busyWatched ? <Spinner size={18} /> : <Icon.Check size={18} />} {watched ? 'Watched' : 'Mark watched'}
            </button>
            <Link to="/requests" className="btn-secondary !px-5 !py-3 gap-2">
              <Icon.Plus size={18} /> Request seasons
            </Link>
          </div>

          {series.overview && <p className="text-sm text-slate-300 leading-relaxed mb-5 max-w-3xl">{series.overview}</p>}

          {/* Season selector. Loading states reserve realistic space so the
              modal opens near its settled size instead of jumping when the
              seasons/episodes arrive. */}
          {seasons === null ? (
            <div className="min-h-[38vh] grid place-items-center"><Spinner size={28} /></div>
          ) : seasons.length === 0 ? (
            <EmptyState
              icon={<Icon.TV size={28} />}
              title="No episodes found"
              subtitle="This series has no playable episodes yet. You can request them to be added."
              action={<Link to="/requests" className="btn-primary gap-2"><Icon.Plus size={18} /> Request episodes</Link>}
            />
          ) : (
            <>
              {seasonCount > 0 && (
                <div className="flex gap-2 overflow-x-auto pb-2 -mx-1 px-1 mb-4 snap-x">
                  {seasons.map(s => (
                    <button
                      key={s.id}
                      onClick={() => setActiveSeason(s.id)}
                      className={cx(
                        'chip shrink-0 whitespace-nowrap transition-colors',
                        activeSeason === s.id ? '!bg-brand-500 !text-white !border-brand-500' : 'hover:!bg-white/[0.08]'
                      )}
                    >
                      {s.name}
                    </button>
                  ))}
                </div>
              )}

              {/* Episodes */}
              {epLoading || episodes === null ? (
                <div className="min-h-[30vh] grid place-items-center"><Spinner size={28} /></div>
              ) : episodes.length === 0 ? (
                <EmptyState icon={<Icon.TV size={26} />} title="No episodes" subtitle="Nothing to play in this season." />
              ) : (
                <div className="space-y-1">
                  {episodes.map((ep, i) => (
                    <EpisodeRow key={ep.id} ep={ep} index={i} onPlay={() => onPlay(ep, episodes)} forceWatched={watched} />
                  ))}
                </div>
              )}
            </>
          )}

          {/* More like this */}
          <div className="mt-8">
            <h3 className="section-title mb-3">More like this</h3>
            <div className="min-h-[13.5rem] sm:min-h-[15.25rem] grid">
              {similar === null ? (
                <div className="place-self-center"><Spinner size={26} /></div>
              ) : similar.length === 0 ? (
                <p className="muted text-sm py-2">No similar shows found yet.</p>
              ) : (
                <div className="self-start w-full min-w-0 flex gap-3 sm:gap-4 overflow-x-auto pb-2 -mx-1 px-1 snap-x">
                  {similar.map(s => (
                    <div key={s.id} className="snap-start shrink-0 w-28 sm:w-32">
                      <CheckPoster item={s} aspect="portrait" watched={isWatched(s)} onClick={() => onOpenSeries(s)} />
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </Modal>
  );
}

export default function TVShows() {
  const [series, setSeries] = useState<MediaItem[] | null>(null);
  const [total, setTotal] = useState(0);
  const [genres, setGenres] = useState<string[]>([]);
  const [loadingMore, setLoadingMore] = useState(false);
  const [resume, setResume] = useState<MediaItem[]>([]);
  const [recs, setRecs] = useState<MediaItem[]>([]);
  const [configured, setConfigured] = useState(true);
  const [selected, setSelected] = useState<MediaItem | null>(null);
  const [watchedIds, setWatchedIds] = useState<Set<string>>(new Set());
  const [unwatchedIds, setUnwatchedIds] = useState<Set<string>>(new Set());
  const [playing, setPlaying] = useState<MediaItem | null>(null);
  const [episodeQueue, setEpisodeQueue] = useState<MediaItem[]>([]);
  const [episodeQueueLoading, setEpisodeQueueLoading] = useState(false);
  const [episodeQueueComplete, setEpisodeQueueComplete] = useState(false);
  const episodeQueueToken = useRef(0);
  const [query, setQuery] = useState('');
  const [genre, setGenre] = useState('all');
  const [sort, setSort] = useState<SortKey>('recent');
  const [visibleCount, setVisibleCount] = useState(50);
  const loadMoreRef = useRef<HTMLButtonElement>(null);
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const location = useLocation();

  // ---- Deep-link reader: /tv?item=<id> opens that show/episode's detail modal ----
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
    let alive = true;
    (async () => {
      try {
        const st = await api.media.status();
        if (!alive) return;
        if (!st.configured) { setConfigured(false); setSeries([]); return; }
        const [list, res, rec] = await Promise.all([
          api.media.seriesPage(0, 50, { sort: 'recent' }).catch(() => ({ items: [] as MediaItem[], total: 0, offset: 0, limit: 50, hasMore: false })),
          api.media.resumeVideo().catch(() => [] as MediaItem[]),
          api.media.recommendations().catch(() => ({ nextUp: [], suggestions: [], recentlyAdded: [] })),
        ]);
        if (!alive) return;
        setSeries(list.items);
        setTotal(list.total);
        api.media.genres('series').then(g => { if (alive) setGenres(g.genres || []); }).catch(() => {});
        setResume(res.filter(r => r.type === 'Episode'));
        setRecs((rec?.suggestions || []).filter(s => s.type === 'Series').slice(0, 18));
      } catch {
        if (alive) { setSeries([]); toast('Could not reach media library', 'error'); }
      }
    })();
    return () => { alive = false; };
  }, []);

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
      setWatchedIds(prev => { const s = new Set(prev); next ? s.delete(item.id) : s.add(item.id); return s; });
      setUnwatchedIds(prev => { const s = new Set(prev); next ? s.add(item.id) : s.delete(item.id); return s; });
      toast('Could not update', 'error', e?.message);
    }
  };

  const showCount = total;

  const allGenres = genres;

  const filtering = query.trim() !== '' || genre !== 'all' || sort !== 'recent';

  const filtered = series || [];

  const firstFilter = useRef(true);
  useEffect(() => {
    if (firstFilter.current) { firstFilter.current = false; return; }
    let alive = true;
    const timer = setTimeout(() => {
      setLoadingMore(true);
      api.media.seriesPage(0, 50, { q: query.trim(), genre, sort }).then(page => {
        if (!alive) return;
        setSeries(page.items); setTotal(page.total); setVisibleCount(page.items.length);
      }).catch(() => { if (alive) toast('Could not update shows', 'error'); })
        .finally(() => { if (alive) setLoadingMore(false); });
    }, 250);
    return () => { alive = false; clearTimeout(timer); };
  }, [query, genre, sort]);

  const loadMore = async () => {
    const current = series || [];
    if (loadingMore || current.length >= total) return;
    setLoadingMore(true);
    try {
      const page = await api.media.seriesPage(current.length, 50, { q: query.trim(), genre, sort });
      setSeries(prev => [...(prev || []), ...page.items.filter(x => !(prev || []).some(p => p.id === x.id))]);
      setTotal(page.total); setVisibleCount(n => n + page.items.length);
    } finally { setLoadingMore(false); }
  };
  useEffect(() => {
    const node = loadMoreRef.current;
    if (!node || (series || []).length >= total || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) loadMore();
    }, { rootMargin: '600px 0px' });
    observer.observe(node);
    return () => observer.disconnect();
  }, [series?.length, total, loadingMore, query, genre, sort]);

  const startEpisode = (episode: MediaItem, knownEpisodes: MediaItem[] = []) => {
    const token = ++episodeQueueToken.current;
    const seed = orderEpisodes([...knownEpisodes, episode]);
    setPlaying(episode);
    setEpisodeQueue(seed);
    setEpisodeQueueLoading(!!episode.seriesId);
    setEpisodeQueueComplete(!episode.seriesId);
    if (!episode.seriesId) return;

    // One server request returns the series in canonical season/episode order,
    // including the next season. The current-season seed keeps navigation useful
    // immediately while that request is in flight.
    api.media.episodes(episode.seriesId).then(items => {
      if (episodeQueueToken.current !== token) return;
      const ordered = orderEpisodes(items);
      if (ordered.some(item => item.id === episode.id)) {
        setEpisodeQueue(ordered);
        setEpisodeQueueComplete(true);
      }
    }).catch(() => {
      // Keep the known current-season queue; never invent a cross-season jump.
      if (episodeQueueToken.current === token) setEpisodeQueueComplete(false);
    }).finally(() => {
      if (episodeQueueToken.current === token) setEpisodeQueueLoading(false);
    });
  };

  const closePlayer = () => {
    episodeQueueToken.current++;
    setPlaying(null);
    setEpisodeQueueLoading(false);
  };

  if (series === null) return <PageLoader />;

  const hasLibrary = configured && (series.length > 0 || filtering);

  return (
    <div className="animate-fade-in">
      <PageHeader
        title="TV Shows"
        subtitle={configured ? `${showCount} series in your library` : undefined}
        icon={<Icon.TV size={22} />}
        actions={
          <Link to="/requests" className="btn-primary gap-2 whitespace-nowrap">
            <Icon.Plus size={16} /> <span className="hidden sm:inline">Request more</span><span className="sm:hidden">Request</span>
          </Link>
        }
      />

      {!hasLibrary ? (
        <EmptyState
          icon={<Icon.TV size={32} />}
          title={configured ? 'No shows yet' : 'Media library not configured'}
          subtitle={configured ? 'Add TV shows to your media server, or request new titles to be added.' : 'Connect a media backend to browse your series.'}
          action={configured ? <Link to="/requests" className="btn-primary gap-2"><Icon.Plus size={18} /> Request a show</Link> : undefined}
        />
      ) : (
        <>
          {/* Continue watching (hidden while filtering) */}
          {resume.length > 0 && !filtering && (
            <div className="mb-8">
              <h2 className="section-title mb-3">Continue watching</h2>
              <div className="flex gap-4 overflow-x-auto pb-2 -mx-1 px-1 snap-x">
                {resume.map(ep => (
                  <button
                    key={ep.id}
                    onClick={() => startEpisode(ep)}
                    className="group snap-start shrink-0 w-56 sm:w-64 text-left"
                  >
                    <div className="relative aspect-video rounded-xl overflow-hidden bg-ink-800 shadow-card card-hover">
                      {(ep.thumbUrl || ep.backdropUrl || ep.posterUrl) ? (
                        <img src={ep.thumbUrl || ep.backdropUrl || ep.posterUrl} srcSet={imageSrcSet(ep.thumbUrl || ep.backdropUrl || ep.posterUrl, [320, 640])} sizes="256px" loading="lazy" decoding="async" className="w-full h-full object-cover" />
                      ) : (
                        <div className="w-full h-full grid place-items-center text-slate-600"><Icon.TV size={26} /></div>
                      )}
                      <div className="absolute inset-0 bg-gradient-to-t from-black/70 via-transparent to-transparent opacity-0 group-hover:opacity-100 transition-opacity" />
                      <div className="absolute inset-0 grid place-items-center opacity-0 group-hover:opacity-100 transition-opacity">
                        <div className="w-11 h-11 rounded-full bg-white/90 text-ink-900 grid place-items-center shadow-float scale-90 group-hover:scale-100 transition-transform">
                          <Icon.Play size={20} />
                        </div>
                      </div>
                      {typeof ep.progressPct === 'number' && ep.progressPct > 0 && (
                        <div className="absolute bottom-0 inset-x-0 h-1 bg-black/40"><div className="h-full bg-brand-500" style={{ width: `${ep.progressPct}%` }} /></div>
                      )}
                    </div>
                    <p className="text-sm font-medium text-white truncate mt-2 group-hover:text-brand-300 transition-colors">{ep.name}</p>
                    <p className="text-xs muted truncate">
                      {ep.seriesName || 'Episode'}
                      {ep.seasonNumber != null && ep.episodeNumber != null ? ` · S${ep.seasonNumber}E${ep.episodeNumber}` : ''}
                    </p>
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Recommended for you */}
          {recs.length > 0 && !filtering && (
            <div className="mb-8">
              <h2 className="section-title">Recommended for you</h2>
              <p className="muted text-xs mt-0.5 mb-3">Picked from what you love</p>
              <div className="flex gap-4 overflow-x-auto pb-2 -mx-1 px-1 snap-x">
                {recs.map(s => (
                  <div key={s.id} className="snap-start shrink-0 w-32 sm:w-36">
                    <CheckPoster item={s} aspect="portrait" watched={isWatched(s)} onClick={() => setSelected(s)} />
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* All series */}
          <div className="flex items-center justify-between mb-3">
            <h2 className="section-title">{filtering ? 'Results' : 'All shows'}</h2>
            <span className="muted text-sm">{total} series</span>
          </div>

          {/* Search / filter toolbar */}
          <div className="flex flex-col gap-3 mb-5">
            <div className="flex flex-wrap items-center gap-2">
              <div className="relative flex-1 min-w-[180px]">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500 pointer-events-none"><Icon.Search size={16} /></span>
                <input
                  className="input !pl-9 w-full"
                  placeholder="Search shows…"
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

          {filtered.length === 0 ? (
            <EmptyState
              icon={<Icon.Search size={28} />}
              title="No matches"
              subtitle="No shows match your filters. Try a different search, or request the title to be added."
              action={<Link to="/requests" className="btn-primary gap-2"><Icon.Plus size={18} /> Request it</Link>}
            />
          ) : (
            <>
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-3 sm:gap-4">
                {filtered.slice(0, visibleCount).map(s => (
                  <CheckPoster key={s.id} item={s} aspect="portrait" watched={isWatched(s)} onClick={() => setSelected(s)} />
                ))}
              </div>
              {series.length < total && (
                <button ref={loadMoreRef} type="button" onClick={loadMore} disabled={loadingMore}
                  className="btn-secondary mx-auto mt-6">
                  {loadingMore ? 'Loading…' : 'Show more'} <span className="muted text-xs">({total - series.length} remaining)</span>
                </button>
              )}
            </>
          )}
        </>
      )}

      {selected && (
        <SeriesDetail
          series={selected}
          onClose={() => setSelected(null)}
          onPlay={startEpisode}
          watched={isWatched(selected)}
          onToggleWatched={() => toggleWatched(selected)}
          isWatched={isWatched}
          onOpenSeries={s => setSelected(s)}
        />
      )}

      {playing && (() => {
        const neighbors = episodeNeighbors(episodeQueue, playing.id);
        return <VideoPlayer item={playing} onClose={closePlayer}
          episodeNavigation={playing.type === 'Episode' ? {
            previous: neighbors.previous,
            next: neighbors.next,
            loading: episodeQueueLoading,
            complete: episodeQueueComplete,
            onSelect: setPlaying,
          } : undefined} />;
      })()}
    </div>
  );
}
