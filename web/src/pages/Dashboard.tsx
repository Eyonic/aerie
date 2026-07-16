import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { Icon } from '../lib/icons';
import { useAuth, usePlayer } from '../lib/store';
import { formatRelative } from '../lib/utils';
import { PageLoader } from '../components/ui';
import { PosterCard, VideoPlayer } from '../components/media';
import type { DashboardData, MediaItem, Book } from '../lib/model';
import { imageSrcSet } from '../lib/images';

// A horizontal, swipeable content rail (Netflix-style).
function Rail({ title, onSeeAll, seeAllLabel = 'See all', children, count }: { title: string; onSeeAll?: () => void; seeAllLabel?: string; children: React.ReactNode; count?: number }) {
  if (count === 0) return null;
  return (
    <section className="mb-7">
      <div className="flex items-center justify-between mb-3 px-0.5">
        <h2 className="text-lg sm:text-xl font-bold text-white tracking-tight">{title}</h2>
        {onSeeAll && <button className="text-sm text-brand-400 hover:text-brand-300 shrink-0" onClick={onSeeAll}>{seeAllLabel}</button>}
      </div>
      <div className="flex gap-3 sm:gap-4 overflow-x-auto pb-2 -mx-4 px-4 sm:mx-0 sm:px-0 snap-x scroll-smooth [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden">
        {children}
      </div>
    </section>
  );
}

type Recs = { nextUp: MediaItem[]; suggestions: MediaItem[]; recentlyAdded: MediaItem[] };

export default function Dashboard() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [resume, setResume] = useState<MediaItem[]>([]);
  const [movies, setMovies] = useState<MediaItem[]>([]);
  const [series, setSeries] = useState<MediaItem[]>([]);
  const [albums, setAlbums] = useState<MediaItem[]>([]);
  const [books, setBooks] = useState<Book[]>([]);
  const [recs, setRecs] = useState<Recs>({ nextUp: [], suggestions: [], recentlyAdded: [] });
  const [ready, setReady] = useState(false);
  const [playing, setPlaying] = useState<MediaItem | null>(null);
  const { user } = useAuth();
  const player = usePlayer();
  const nav = useNavigate();

  useEffect(() => {
    const safe = <T,>(p: Promise<T>, f: T) => p.catch(() => f);
    Promise.all([
      safe(api.dashboard(), null as any),
      safe(api.media.resumeVideo(), [] as MediaItem[]),
      safe(api.media.movies(), [] as MediaItem[]),
      safe(api.media.series(), [] as MediaItem[]),
      safe(api.media.albums(), [] as MediaItem[]),
      safe(api.books.audiobooks(), [] as Book[]),
      safe(api.media.recommendations(), { nextUp: [], suggestions: [], recentlyAdded: [] } as Recs),
    ]).then(([d, r, m, s, a, b, rec]) => {
      setData(d); setResume(r || []); setMovies(m || []); setSeries(s || []); setAlbums(a || []); setBooks(b || []);
      setRecs(rec || { nextUp: [], suggestions: [], recentlyAdded: [] }); setReady(true);
    });
  }, []);

  if (!ready || !data) return <PageLoader />;

  const greeting = (() => { const h = new Date().getHours(); return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening'; })();
  const continueBooks = books.filter(b => (b.progressPct || 0) > 0 && (b.progressPct || 0) < 99).slice(0, 12);
  const recentAlbums = albums.slice(0, 18);
  const nextUp = (recs.nextUp || []).slice(0, 18);
  const suggestions = (recs.suggestions || []).slice(0, 18);
  const recentlyAdded = (recs.recentlyAdded || []).slice(0, 18);

  // Deep-link a tile to its SPECIFIC title's detail (branch by content type).
  const isTv = (m: MediaItem) => m.type === 'Series' || m.type === 'Season' || m.type === 'Episode';
  const navFor = (m: MediaItem) => nav(`${isTv(m) ? '/tv' : '/movies'}?item=${encodeURIComponent(m.id)}`);

  // Episode cards must carry SERIES context (two shows can both read "Pilot").
  // Reshape the item so the shared PosterCard shows the series as the title and
  // "S1·E1 · Pilot" as the subtitle, while onClick still uses the original item.
  const withSeriesContext = (m: MediaItem): MediaItem => {
    if (m.type !== 'Episode') return m;
    const s = m.seasonNumber, e = m.episodeNumber;
    const tag = s != null && e != null ? `S${s}·E${e}` : s != null ? `S${s}` : '';
    const sub = [tag, m.name].filter(Boolean).join(' · ');
    return m.seriesName ? { ...m, name: m.seriesName, year: undefined, seriesName: sub } : m;
  };

  // Continue-listening bar must match the actual resume point. progressPct can
  // overstate position (e.g. 17% while the book resumes at ~1.6%); when the two
  // disagree, trust the precise currentTimeSec/durationSec ratio.
  const bookPct = (b: Book): number => {
    const p = Math.max(0, Math.min(100, b.progressPct || 0));
    if (b.currentTimeSec && b.durationSec && b.durationSec > 0) {
      const real = Math.max(0, Math.min(100, (b.currentTimeSec / b.durationSec) * 100));
      if (Math.abs(real - p) > 1) return real;
    }
    return p;
  };
  // Continue-watching "See all" routes by what's actually in the rail.
  const resumeSeeAll = () => {
    const tv = resume.filter(isTv).length;
    nav(tv > resume.length / 2 ? '/tv' : '/movies');
  };

  const playAlbum = async (album: MediaItem) => {
    try {
      const tracks = await api.media.children(album.id);
      const q = tracks.filter(t => t.type === 'Audio').map(t => ({
        id: t.id, title: t.name, subtitle: album.albumArtist || album.name,
        artUrl: album.posterUrl && new URL(album.posterUrl, location.origin).href,
        streamUrl: api.media.streamUrl(t.id, true), kind: 'music' as const,
        cast: { source: 'jellyfin' as const, itemId: t.id },
      }));
      if (q.length) player.playQueue(q, 0);
    } catch { nav('/music'); }
  };

  // Clicking an audiobook plays it immediately via a track queue (like music).
  // If the book is already in progress, resume from currentTimeSec (player auto-saves).
  const playBook = async (b: Book) => {
    const art = (b.coverUrl && api.books.coverUrl(b.coverUrl)) || undefined;
    const resumeAt = (b.currentTimeSec && b.currentTimeSec > 0) ? b.currentTimeSec : undefined;
    try {
      const tracks = await api.books.tracks(b.id);
      if (tracks && tracks.length) {
        player.playQueue(tracks.map((t, i) => ({
          id: `${b.id}:${t.ino}`,
          title: tracks.length > 1 ? `${b.title} — ${t.title}` : b.title,
          subtitle: b.author || 'Unknown author',
          artUrl: art, streamUrl: api.books.trackUrl(t.streamUrl),
          kind: 'audiobook' as const, durationSec: t.durationSec,
          cast: { source: 'audiobookshelf' as const, itemId: b.id, fileId: t.ino },
          startAt: i === 0 ? resumeAt : undefined,
        })), 0);
        return;
      }
    } catch { /* fall through */ }
    player.playTrack({ id: b.id, title: b.title, subtitle: b.author, artUrl: art, streamUrl: api.books.streamUrl(b.id), kind: 'audiobook', startAt: resumeAt, cast: { source: 'audiobookshelf', itemId: b.id } });
  };

  const hasContinue = resume.length > 0 || continueBooks.length > 0;

  return (
    <div className="animate-fade-in">
      <div className="mb-6">
        <h1 className="text-2xl sm:text-3xl font-bold text-white tracking-tight">{greeting}, {user?.displayName?.split(' ')[0]}</h1>
        <p className="muted mt-1 text-sm sm:text-base">Jump back into your movies, music and books.</p>
      </div>

      {/* Continue watching — resume movies & episodes in the video player */}
      <Rail title="Continue watching" count={resume.length} onSeeAll={resumeSeeAll}>
        {resume.map(m => (
          <div key={m.id} className="snap-start shrink-0 w-56 sm:w-64"><PosterCard item={withSeriesContext(m)} aspect="landscape" onClick={() => setPlaying(m)} /></div>
        ))}
      </Rail>

      {/* Continue listening (audiobooks) — click plays via the queue */}
      <Rail title="Continue listening" count={continueBooks.length} onSeeAll={() => nav('/audiobooks')} seeAllLabel="Library">
        {continueBooks.map(b => (
          <button key={b.id} onClick={() => playBook(b)} className="snap-start shrink-0 w-32 sm:w-36 text-left group">
            <div className="aspect-[2/3] rounded-xl overflow-hidden bg-ink-800 shadow-card card-hover relative">
              {b.coverUrl ? <img src={api.books.coverUrl(b.coverUrl)} srcSet={imageSrcSet(api.books.coverUrl(b.coverUrl), [240, 480])} sizes="144px" loading="lazy" decoding="async" className="w-full h-full object-cover" /> : <div className="grid place-items-center h-full text-slate-600"><Icon.Book size={28} /></div>}
              <div className="absolute inset-0 grid place-items-center opacity-0 group-hover:opacity-100 transition-opacity bg-black/30"><div className="w-11 h-11 rounded-full bg-white/90 text-ink-900 grid place-items-center"><Icon.Play size={20} /></div></div>
              <div className="absolute bottom-0 inset-x-0 h-1 bg-black/40"><div className="h-full bg-brand-500" style={{ width: `${bookPct(b)}%` }} /></div>
            </div>
            <p className="text-sm font-medium text-white truncate mt-2">{b.title}</p>
            <p className="text-xs muted truncate">{b.author}</p>
          </button>
        ))}
      </Rail>

      {/* When nothing is in progress, a friendly nudge instead of empty rails */}
      {!hasContinue && (
        <div className="card p-5 sm:p-6 mb-7 flex items-center gap-4">
          <div className="w-11 h-11 rounded-xl bg-brand-500/15 text-brand-400 grid place-items-center shrink-0"><Icon.Play size={22} /></div>
          <div className="min-w-0">
            <p className="text-white font-semibold">Nothing in progress yet</p>
            <p className="text-sm muted">Start a movie, show or audiobook and it will show up here to pick up where you left off.</p>
          </div>
        </div>
      )}

      {/* Next up — the next TV episode to keep going with a show */}
      <Rail title="Next up" count={nextUp.length} onSeeAll={() => nav('/tv')}>
        {nextUp.map(m => (
          <div key={m.id} className="snap-start shrink-0 w-56 sm:w-64"><PosterCard item={withSeriesContext(m)} aspect="landscape" onClick={() => navFor(m)} /></div>
        ))}
      </Rail>

      {/* Recommended for you — personalised picks from across the library */}
      {suggestions.length > 0 && (
        <section className="mb-7">
          <div className="flex items-baseline justify-between mb-1 px-0.5">
            <h2 className="text-lg sm:text-xl font-bold text-white tracking-tight">Recommended for you</h2>
          </div>
          <p className="text-sm muted mb-3 px-0.5">Because you've been enjoying your library.</p>
          <div className="flex gap-3 sm:gap-4 overflow-x-auto pb-2 -mx-4 px-4 sm:mx-0 sm:px-0 snap-x scroll-smooth [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden">
            {suggestions.map(m => (<div key={m.id} className="snap-start shrink-0 w-32 sm:w-36"><PosterCard item={m} onClick={() => navFor(m)} /></div>))}
          </div>
        </section>
      )}

      {/* Recently added — freshest content in the library */}
      <Rail title="Recently added" count={recentlyAdded.length}>
        {recentlyAdded.map(m => (<div key={m.id} className="snap-start shrink-0 w-32 sm:w-36"><PosterCard item={m} onClick={() => navFor(m)} /></div>))}
      </Rail>

      {/* Movies */}
      <Rail title="Movies" count={movies.length} onSeeAll={() => nav('/movies')}>
        {movies.slice(0, 18).map(m => (<div key={m.id} className="snap-start shrink-0 w-32 sm:w-36"><PosterCard item={m} onClick={() => navFor(m)} /></div>))}
      </Rail>

      {/* TV Shows */}
      <Rail title="TV Shows" count={series.length} onSeeAll={() => nav('/tv')}>
        {series.slice(0, 18).map(m => (<div key={m.id} className="snap-start shrink-0 w-32 sm:w-36"><PosterCard item={m} onClick={() => navFor(m)} /></div>))}
      </Rail>

      {/* Music */}
      <Rail title="Music" count={recentAlbums.length} onSeeAll={() => nav('/music')}>
        {recentAlbums.map(a => (
          <button key={a.id} onClick={() => playAlbum(a)} className="snap-start shrink-0 w-32 sm:w-36 text-left group">
            <div className="aspect-square rounded-xl overflow-hidden bg-ink-800 shadow-card card-hover relative">
              {a.posterUrl ? <img src={a.posterUrl} srcSet={imageSrcSet(a.posterUrl, [160, 320, 480])} sizes="144px" loading="lazy" decoding="async" className="w-full h-full object-cover" /> : <div className="grid place-items-center h-full text-slate-600"><Icon.Music size={26} /></div>}
              <div className="absolute inset-0 grid place-items-center opacity-0 group-hover:opacity-100 transition-opacity bg-black/30"><div className="w-11 h-11 rounded-full bg-white/90 text-ink-900 grid place-items-center"><Icon.Play size={20} /></div></div>
            </div>
            <p className="text-sm font-medium text-white truncate mt-2">{a.name}</p>
            <p className="text-xs muted truncate">{a.albumArtist || a.year || ''}</p>
          </button>
        ))}
      </Rail>

      {/* Audiobooks library — click PLAYS the book (open library via See all) */}
      <Rail title="Audiobooks" count={books.length} onSeeAll={() => nav('/audiobooks')} seeAllLabel="Library">
        {books.slice(0, 18).map(b => (
          <button key={b.id} onClick={() => playBook(b)} className="snap-start shrink-0 w-32 sm:w-36 text-left group">
            <div className="aspect-[2/3] rounded-xl overflow-hidden bg-ink-800 shadow-card card-hover relative">
              {b.coverUrl ? <img src={api.books.coverUrl(b.coverUrl)} srcSet={imageSrcSet(api.books.coverUrl(b.coverUrl), [240, 480])} sizes="144px" loading="lazy" decoding="async" className="w-full h-full object-cover" /> : <div className="grid place-items-center h-full text-slate-600"><Icon.Book size={26} /></div>}
              <div className="absolute inset-0 grid place-items-center opacity-0 group-hover:opacity-100 transition-opacity bg-black/30"><div className="w-11 h-11 rounded-full bg-white/90 text-ink-900 grid place-items-center"><Icon.Play size={20} /></div></div>
              {typeof b.progressPct === 'number' && b.progressPct > 0 && b.progressPct < 99 && (
                <div className="absolute bottom-0 inset-x-0 h-1 bg-black/40"><div className="h-full bg-brand-500" style={{ width: `${bookPct(b)}%` }} /></div>
              )}
            </div>
            <p className="text-sm font-medium text-white truncate mt-2">{b.title}</p>
            <p className="text-xs muted truncate">{b.author}</p>
          </button>
        ))}
      </Rail>

      {/* Photos + Files at the bottom */}
      <div className="grid lg:grid-cols-2 gap-6 mt-2">
        {/* Recent photos */}
        <div>
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-lg font-bold text-white">Recent photos</h2>
            <button className="text-sm text-brand-400 hover:text-brand-300" onClick={() => nav('/photos')}>Open Photos</button>
          </div>
          {data.recentPhotos.length ? (
            <div className="grid grid-cols-4 sm:grid-cols-6 gap-1.5">
              {data.recentPhotos.slice(0, 12).map(p => (
                <button key={p.path} onClick={() => nav('/photos')} className="aspect-square rounded-lg overflow-hidden bg-ink-800 card-hover">
                  <img src={api.photos.native.thumbUrl(p.path)} loading="lazy" className="w-full h-full object-cover" />
                </button>
              ))}
            </div>
          ) : <div className="card p-6 text-center text-sm muted">No photos yet — set up phone backup.</div>}
        </div>

        {/* Recent files */}
        <div>
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-lg font-bold text-white">Recent files</h2>
            <button className="text-sm text-brand-400 hover:text-brand-300" onClick={() => nav('/files')}>Open Files</button>
          </div>
          <div className="card !p-0 overflow-hidden">
            {data.recentFiles.length ? (
              <div className="divide-y divide-white/[0.04]">
                {data.recentFiles.slice(0, 6).map(f => (
                  <button key={f.id} onClick={() => nav(`/files?path=${encodeURIComponent(f.parent)}`)} className="w-full flex items-center gap-3 px-4 py-3 hover:bg-white/[0.03] text-left">
                    <div className="w-9 h-9 rounded-lg bg-white/[0.05] grid place-items-center text-slate-400 shrink-0">
                      {f.kind === 'image' ? <Icon.Image size={17} /> : f.kind === 'video' ? <Icon.Video size={17} /> : f.kind === 'audio' ? <Icon.Music size={17} /> : f.kind === 'spreadsheet' || f.kind === 'csv' ? <Icon.Sheet size={17} /> : f.kind === 'pdf' || f.kind === 'document' || f.kind === 'markdown' ? <Icon.Doc size={17} /> : <Icon.Files size={17} />}
                    </div>
                    <div className="min-w-0 flex-1"><p className="text-sm text-white truncate">{f.name}</p><p className="text-xs muted truncate">{f.parent}</p></div>
                    <span className="text-xs text-slate-500 shrink-0 hidden sm:block">{formatRelative(f.modifiedAt)}</span>
                  </button>
                ))}
              </div>
            ) : <div className="p-6 text-center text-sm muted">No files yet — upload to get started.</div>}
          </div>
        </div>
      </div>

      {playing && <VideoPlayer item={playing} onClose={() => setPlaying(null)} />}
    </div>
  );
}
