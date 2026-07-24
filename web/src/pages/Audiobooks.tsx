import React, { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../lib/api';
import { Icon } from '../lib/icons';
import { cx, formatDuration } from '../lib/utils';
import { usePlayer, toast, type Track } from '../lib/store';
import { PageLoader, EmptyState, PageHeader, Modal, ProgressBar, Badge, Spinner } from '../components/ui';
import type { Book, Chapter } from '../lib/model';
import { imageSrcSet } from '../lib/images';
import { getAudioEngine } from '../lib/audio-engine';

const SPEEDS = [0.75, 1, 1.25, 1.5, 1.75, 2];
const SLEEP_OPTIONS = [15, 30, 45, 60];

// Human "3h 12m left" phrasing for a remaining duration in seconds.
function timeLeft(sec?: number): string {
  if (!sec || sec < 0) return '';
  const h = Math.floor(sec / 3600), m = Math.round((sec % 3600) / 60);
  if (h && m) return `${h}h ${m}m left`;
  if (h) return `${h}h left`;
  if (m) return `${m}m left`;
  return 'almost done';
}

function remainingSec(book: Book): number | undefined {
  return book.durationSec && book.currentTimeSec != null
    ? Math.max(0, book.durationSec - book.currentTimeSec) : undefined;
}

function coverSrc(book: Book): string | null {
  return book.coverUrl ? api.books.coverUrl(book.coverUrl) : null;
}

// Audiobookshelf/Jellyfin seed placeholder authors like "_auto-import" for books
// that were imported without metadata. Treat empty names and any leading-underscore
// system name as "unknown" so the raw placeholder never surfaces in the UI.
function authorName(book: Book): string {
  const a = (book.author || '').trim();
  return !a || a.startsWith('_') ? 'Unknown author' : a;
}

function trackFor(book: Book) {
  return {
    id: book.id,
    title: book.title,
    subtitle: authorName(book),
    artUrl: coverSrc(book) || undefined,
    streamUrl: api.books.streamUrl(book.id),
    kind: 'audiobook' as const,
    durationSec: book.durationSec,
    cast: { source: 'audiobookshelf' as const, itemId: book.id },
  };
}

// ---- shared audio helpers (talk to the single global <audio> element) ----
function getAudio(): HTMLAudioElement | null {
  return getAudioEngine();
}

// Long-form speed is owned by the account-scoped global player. Apply it
// immediately here as well; the persistent engine re-applies it after loads.
function applySpeed(next?: number) {
  const player = usePlayer.getState();
  if (next != null) player.setPlaybackRate(next);
  const a = getAudio();
  if (a) a.playbackRate = next ?? usePlayer.getState().playbackRate;
}

// Start (or resume) a book and optionally jump to an offset in seconds. Because
// every chapter shares one stream URL, jumping is a real seek on the element.
// A queue track id encodes the book: "<bookId>:<ino>" (or just "<bookId>" for the
// single-stream fallback). bookOf() recovers the book id for "is playing" checks.
function bookOf(trackId?: string): string { return (trackId || '').split(':')[0]; }

function playBook(book: Book, seconds?: number) {
  const P = usePlayer.getState();
  const a = getAudio();
  // Where to start: an explicit seek (chapter tap) wins, otherwise resume from the
  // saved listening position so the book picks up exactly where it was left off.
  const resumeAt = seconds != null ? seconds : (book.currentTimeSec || 0);
  if (bookOf(P.current?.id) === book.id && a) {
    if (seconds != null) {
      const targetIndex = P.queue.findIndex((track, index) => {
        if (bookOf(track.id) !== book.id) return false;
        const start = track.timelineOffsetSec || 0;
        const end = start + (track.durationSec || (index === P.queue.length - 1 ? Number.MAX_SAFE_INTEGER : 0));
        return seconds >= start && (seconds < end || index === P.queue.length - 1);
      });
      if (targetIndex >= 0 && targetIndex !== P.index) {
        const queue = P.queue.map((track, index) => index === targetIndex
          ? { ...track, startAt: Math.max(0, seconds - (track.timelineOffsetSec || 0)) }
          : track);
        P.playQueue(queue, targetIndex);
        setTimeout(() => applySpeed(), 250);
        return;
      }
      const localOffset = P.current?.timelineOffsetSec || 0;
      a.currentTime = Math.max(0, seconds - localOffset);
    }
    if (!P.playing) P.setPlaying(true);
    applySpeed();
    return;
  }
  // The browser resets playbackRate to 1 on load(); re-apply the session speed once
  // the fresh stream is playable. The resume seek itself is handled by the global
  // player via the first track's startAt (onLoadedMetadata seek + progress saving).
  const applyOnLoad = () => {
    const started = Date.now();
    const attempt = () => {
      const el = getAudio();
      if (el && el.readyState >= 1) applySpeed();
      else if (Date.now() - started < 8000) setTimeout(attempt, 200);
    };
    setTimeout(attempt, 250);
  };
  // Build a queue from the book's audio files so multi-file audiobooks play every
  // part in order (and single-file books stream the actual file, not a zip).
  // Resume is translated from the whole-book timeline to the right file + local
  // offset, so long multi-file books never jump backward to part one.
  api.books.tracks(book.id).then(tracks => {
    if (tracks && tracks.length) {
      const art = coverSrc(book) || undefined;
      const totalDurationSec = book.durationSec || tracks.reduce((sum, track) => sum + (track.durationSec || 0), 0);
      let offset = 0;
      let startIndex = 0;
      const queue: Track[] = tracks.map((t, i) => {
        const timelineOffsetSec = offset;
        const nextOffset = offset + (t.durationSec || 0);
        if (resumeAt >= timelineOffsetSec && (resumeAt < nextOffset || i === tracks.length - 1)) startIndex = i;
        offset = nextOffset;
        return {
          id: `${book.id}:${t.ino}`,
          title: tracks.length > 1 ? `${book.title} — ${t.title}` : book.title,
          subtitle: authorName(book),
          artUrl: art, streamUrl: api.books.trackUrl(t.streamUrl),
          kind: 'audiobook' as const, durationSec: t.durationSec,
          timelineOffsetSec, totalDurationSec,
          cast: { source: 'audiobookshelf' as const, itemId: book.id, fileId: t.ino },
        };
      });
      if (resumeAt > 0) queue[startIndex] = { ...queue[startIndex], startAt: Math.max(0, resumeAt - (queue[startIndex].timelineOffsetSec || 0)) };
      P.playQueue(queue, startIndex);
    } else P.playTrack(resumeAt > 0 ? { ...trackFor(book), startAt: resumeAt } : trackFor(book));
    applyOnLoad();
  }).catch(() => {
    P.playTrack(resumeAt > 0 ? { ...trackFor(book), startAt: resumeAt } : trackFor(book));
    applyOnLoad();
  });
}

function skip(delta: number) {
  const a = getAudio();
  if (!a) return;
  const max = a.duration && isFinite(a.duration) ? a.duration : Number.MAX_SAFE_INTEGER;
  a.currentTime = Math.max(0, Math.min(max, a.currentTime + delta));
}

// ---- session sleep timer (survives modal open/close) --------------------
const sleepMgr = {
  timer: null as ReturnType<typeof setTimeout> | null,
  until: 0,
  subs: new Set<() => void>(),
  set(min: number) {
    if (this.timer) clearTimeout(this.timer);
    this.until = Date.now() + min * 60000;
    this.timer = setTimeout(() => {
      usePlayer.getState().setPlaying(false);
      this.timer = null; this.until = 0; this.emit();
    }, min * 60000);
    this.emit();
  },
  stop() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null; this.until = 0; this.emit();
  },
  remaining() { return this.until ? Math.max(0, this.until - Date.now()) : 0; },
  emit() { this.subs.forEach((f) => f()); },
};

function useSleep() {
  const [, force] = useState(0);
  useEffect(() => {
    const cb = () => force((x) => x + 1);
    sleepMgr.subs.add(cb);
    const iv = setInterval(cb, 1000);
    return () => { sleepMgr.subs.delete(cb); clearInterval(iv); };
  }, []);
  return {
    active: sleepMgr.until > 0,
    remaining: sleepMgr.remaining(),
    set: (m: number) => sleepMgr.set(m),
    stop: () => sleepMgr.stop(),
  };
}

// Covers that 404'd once are remembered so the many places the same book renders
// (grid card, continue tile, detail modal) don't each re-request and spam the console.
const failedCovers = new Set<string>();

function Cover({ book, className, iconSize = 26 }: { book: Book; className?: string; iconSize?: number }) {
  const src = coverSrc(book);
  const [failed, setFailed] = useState(() => (src ? failedCovers.has(src) : false));
  // Reset (from the shared failure cache) if the cover source changes (e.g. tile reused).
  useEffect(() => { setFailed(src ? failedCovers.has(src) : false); }, [src]);
  return (
    <div className={cx('relative overflow-hidden bg-gradient-to-br from-ink-700 to-ink-850', className)}>
      {src && !failed ? (
        <img
          src={src}
          srcSet={imageSrcSet(src, [240, 480])}
          sizes="(max-width: 640px) 46vw, (max-width: 1280px) 24vw, 180px"
          loading="lazy"
          decoding="async"
          onError={() => { failedCovers.add(src); setFailed(true); }}
          className="w-full h-full object-cover"
        />
      ) : (
        <div className="w-full h-full grid place-items-center text-slate-600">
          <Icon.Book size={iconSize} />
        </div>
      )}
    </div>
  );
}

function BookCard({ book, onOpen }: { book: Book; onOpen: () => void }) {
  const pct = book.progressPct || 0;
  return (
    <div className="group cursor-pointer" onClick={onOpen}>
      <div className="relative rounded-2xl overflow-hidden shadow-card ring-1 ring-white/[0.06] aspect-[2/3] card-hover">
        <Cover book={book} className="w-full h-full" iconSize={34} />
        <div className="absolute inset-0 bg-gradient-to-t from-black/70 via-transparent to-transparent opacity-100 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity" />
        <button
          onClick={(e) => { e.stopPropagation(); playBook(book); toast(pct > 0 && pct < 100 ? 'Resuming' : 'Now playing', 'success', book.title); }}
          className="absolute bottom-3 right-3 w-11 h-11 rounded-full bg-brand-500 text-white grid place-items-center shadow-glow opacity-100 translate-y-0 sm:opacity-0 sm:translate-y-2 sm:group-hover:translate-y-0 sm:group-hover:opacity-100 transition-all hover:bg-brand-400 active:scale-95"
          aria-label={pct > 0 && pct < 100 ? 'Resume' : 'Play'}
        >
          <Icon.Play size={18} />
        </button>
        {pct >= 100 && (
          <div className="absolute top-2 left-2"><Badge color="green">Finished</Badge></div>
        )}
        {pct > 0 && pct < 100 && (
          <div className="absolute bottom-0 inset-x-0 h-1 bg-black/40">
            <div className="h-full bg-brand-500" style={{ width: `${pct}%` }} />
          </div>
        )}
      </div>
      <div className="mt-2.5 px-0.5">
        <p className="text-sm font-medium text-white truncate group-hover:text-brand-300 transition-colors">{book.title}</p>
        <p className="text-xs muted truncate">{authorName(book)}</p>
      </div>
    </div>
  );
}

function ContinueTile({ book, onOpen }: { book: Book; onOpen: () => void }) {
  const pct = book.progressPct || 0;
  const remaining = remainingSec(book);
  return (
    <div className="group w-[270px] sm:w-[300px] shrink-0 card card-hover p-3 flex gap-3.5 cursor-pointer" onClick={onOpen}>
      <div className="relative w-16 h-24 shrink-0">
        <Cover book={book} className="w-full h-full rounded-xl shadow-card ring-1 ring-white/10" iconSize={20} />
        <div className="absolute bottom-0 inset-x-0 h-1 bg-black/50 rounded-b-xl overflow-hidden">
          <div className="h-full bg-accent-amber" style={{ width: `${pct}%` }} />
        </div>
      </div>
      <div className="min-w-0 flex-1 flex flex-col">
        <p className="text-sm font-semibold text-white truncate group-hover:text-brand-300 transition-colors">{book.title}</p>
        <p className="text-xs muted truncate">{authorName(book)}</p>
        {book.narrator && <p className="text-[11px] text-slate-500 truncate mt-0.5">Read by {book.narrator}</p>}
        <div className="mt-auto pt-2">
          <div className="flex items-center justify-between text-[11px] mb-1">
            <span className="font-medium text-accent-amber tabular-nums">{Math.round(pct)}%</span>
            {remaining != null && <span className="text-slate-500">{timeLeft(remaining)}</span>}
          </div>
          <ProgressBar value={pct} color="bg-accent-amber" />
        </div>
      </div>
      <button
        onClick={(e) => { e.stopPropagation(); playBook(book); toast('Resuming', 'success', book.title); }}
        className="self-center w-10 h-10 rounded-full bg-brand-500 text-white grid place-items-center shrink-0 hover:bg-brand-400 shadow-glow active:scale-95 transition-colors"
        aria-label="Resume"
      >
        <Icon.Play size={16} />
      </button>
    </div>
  );
}

function BookDetail({ book, onClose }: { book: Book; onClose: () => void }) {
  const [detail, setDetail] = useState<(Book & { chapters: Chapter[]; overview?: string }) | null>(null);
  const [loading, setLoading] = useState(true);
  const speed = usePlayer((s) => s.playbackRate);
  const sleep = useSleep();

  // Reactive slices of the global player so we can reflect the current chapter.
  const curId = usePlayer((s) => s.current?.id);
  const curTime = usePlayer((s) => s.currentTime);
  const curTimelineOffset = usePlayer((s) => s.current?.timelineOffsetSec || 0);
  const playing = usePlayer((s) => s.playing);
  const isActive = bookOf(curId) === book.id;

  useEffect(() => {
    let alive = true;
    setLoading(true);
    api.books.item(book.id)
      .then((d) => { if (alive) setDetail(d); })
      .catch(() => { if (alive) { setDetail(null); toast('Could not load details', 'error'); } })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [book.id]);

  const chapters = detail?.chapters || [];
  const overview = detail?.overview;
  const pct = book.progressPct || 0;

  const activeIdx = isActive && chapters.length
    ? chapters.findIndex((c) => curTime + curTimelineOffset >= c.start && curTime + curTimelineOffset < (c.end || Infinity))
    : -1;

  const setSpeedFn = (s: number) => { applySpeed(s); if (isActive) toast(`Speed ${s}×`, 'info'); };

  const mainAction = () => {
    if (isActive) { usePlayer.getState().toggle(); applySpeed(); return; }
    const resuming = pct > 0 && pct < 100;
    playBook(book);
    toast(resuming ? 'Resuming' : 'Now playing', 'success', book.title);
  };
  const mainLabel = isActive ? (playing ? 'Pause' : 'Resume') : (pct > 0 && pct < 100 ? 'Resume' : 'Play');

  return (
    <Modal open onClose={onClose} title="" size="lg">
      <div className="animate-scale-in relative flex flex-col max-h-[88vh] sm:max-h-[80vh] -m-1 w-[calc(100vw-5rem)] max-w-full sm:w-auto">
        {/* Close pinned to the non-scrolling shell so it is always reachable, even on mobile. */}
        <button
          onClick={onClose}
          className="absolute top-1 right-1 z-20 icon-btn bg-ink-900/80 backdrop-blur ring-1 ring-white/10"
          aria-label="Close"
        >
          <Icon.Close size={18} />
        </button>

        <div className="overflow-y-auto overflow-x-hidden p-1">
        <div className="flex flex-col sm:flex-row gap-6">
          <div className="shrink-0 mx-auto sm:mx-0">
            <Cover book={book} className="w-36 h-56 sm:w-40 sm:h-60 rounded-2xl shadow-float ring-1 ring-white/10" iconSize={40} />
          </div>
          <div className="min-w-0 flex-1">
            <h2 className="text-2xl font-bold text-white tracking-tight pr-8">{book.title}</h2>
            <p className="text-slate-300 mt-1">{authorName(book)}</p>
            <div className="flex flex-wrap gap-2 mt-3">
              {book.series && <span className="chip"><Icon.Book size={13} className="mr-1" />{book.series}</span>}
              {book.narrator && <span className="chip"><Icon.Volume size={13} className="mr-1" />{book.narrator}</span>}
              {book.durationSec ? <span className="chip"><Icon.Clock size={13} className="mr-1" />{formatDuration(book.durationSec)}</span> : null}
              {(book.numChapters || chapters.length) ? <span className="chip">{book.numChapters || chapters.length} chapters</span> : null}
            </div>

            {pct > 0 && pct < 100 && !isActive && (
              <div className="mt-4">
                <div className="flex justify-between text-xs muted mb-1">
                  <span>{Math.round(pct)}% complete</span>
                  {remainingSec(book) != null && <span>{timeLeft(remainingSec(book))}</span>}
                </div>
                <ProgressBar value={pct} color="bg-accent-amber" />
              </div>
            )}

            <div className="flex flex-wrap items-center gap-2 mt-5">
              <button className="btn-primary min-h-[44px]" onClick={mainAction}>
                {isActive && playing ? <Icon.Pause size={16} className="mr-1.5" /> : <Icon.Play size={16} className="mr-1.5" />}
                {mainLabel}
              </button>

              {isActive && (
                <div className="flex items-center gap-1.5">
                  <button onClick={() => skip(-15)} className="w-11 h-11 rounded-full glass grid place-items-center text-slate-300 hover:text-white active:scale-95" aria-label="Back 15 seconds">
                    <span className="text-[11px] font-semibold tabular-nums">−15</span>
                  </button>
                  <button onClick={() => skip(30)} className="w-11 h-11 rounded-full glass grid place-items-center text-slate-300 hover:text-white active:scale-95" aria-label="Forward 30 seconds">
                    <span className="text-[11px] font-semibold tabular-nums">+30</span>
                  </button>
                </div>
              )}
            </div>

            {/* Playback speed */}
            <div className="mt-4">
              <div className="flex items-center gap-1.5 mb-1.5">
                <Icon.Bolt size={13} className="text-slate-400" />
                <span className="text-xs muted">Speed</span>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {SPEEDS.map((s) => (
                  <button
                    key={s}
                    onClick={() => setSpeedFn(s)}
                    className={cx('min-w-[44px] px-2.5 py-2 rounded-lg text-xs font-medium transition-colors',
                      speed === s ? 'bg-brand-500 text-white shadow-glow' : 'glass text-slate-400 hover:text-white')}
                  >{s}×</button>
                ))}
              </div>
            </div>

            {/* Sleep timer */}
            <div className="mt-4">
              <div className="flex items-center gap-1.5 mb-1.5">
                <Icon.Clock size={13} className="text-accent-purple" />
                <span className="text-xs muted">Sleep timer</span>
                {sleep.active && (
                  <span className="text-xs text-accent-purple font-medium tabular-nums ml-auto">
                    {formatDuration(Math.ceil(sleep.remaining / 1000))} left
                  </span>
                )}
              </div>
              <div className="flex flex-wrap gap-1.5">
                {SLEEP_OPTIONS.map((m) => (
                  <button
                    key={m}
                    onClick={() => { sleep.set(m); toast(`Sleeping in ${m} min`, 'info'); }}
                    className="min-w-[44px] px-2.5 py-2 rounded-lg text-xs transition-colors glass text-slate-400 hover:text-white"
                  >{m}m</button>
                ))}
                {sleep.active && (
                  <button
                    onClick={() => { sleep.stop(); toast('Sleep timer off', 'info'); }}
                    className="min-w-[44px] px-3 py-2 rounded-lg text-xs bg-accent-purple/25 text-accent-purple ring-1 ring-accent-purple/40"
                  >Off</button>
                )}
              </div>
            </div>
          </div>
        </div>

        {overview && (
          <div className="mt-6">
            <h3 className="section-title mb-2">About</h3>
            <p className="text-sm text-slate-300 leading-relaxed">{overview}</p>
          </div>
        )}

        <div className="mt-6">
          <div className="flex items-center justify-between mb-2">
            <h3 className="section-title">Chapters</h3>
            {chapters.length > 0 && <span className="text-xs muted">{chapters.length} total</span>}
          </div>
          {loading ? (
            <div className="py-8 grid place-items-center"><Spinner /></div>
          ) : chapters.length === 0 ? (
            <p className="text-sm muted py-4">No chapter markers for this title.</p>
          ) : (
            <div className="max-h-72 overflow-y-auto rounded-xl ring-1 ring-white/[0.05] divide-y divide-white/[0.04]">
              {chapters.map((ch, i) => {
                const active = i === activeIdx;
                return (
                  <button
                    key={ch.id ?? i}
                    onClick={() => { playBook(book, ch.start); if (!isActive) onClose(); }}
                    className={cx('w-full flex items-center gap-3 px-4 py-3 transition-colors text-left group',
                      active ? 'bg-brand-500/15' : 'hover:bg-white/[0.03]')}
                  >
                    {active ? (
                      <span className="w-6 shrink-0 grid place-items-center" aria-hidden>
                        <span className={cx('flex items-end gap-0.5 h-3.5', playing && 'animate-pulse')}>
                          <i className="w-0.5 h-2 bg-brand-400 rounded-full" />
                          <i className="w-0.5 h-3.5 bg-brand-400 rounded-full" />
                          <i className="w-0.5 h-2.5 bg-brand-400 rounded-full" />
                        </span>
                      </span>
                    ) : (
                      <span className="w-6 text-xs text-slate-500 tabular-nums shrink-0">{i + 1}</span>
                    )}
                    <span className={cx('text-sm truncate flex-1', active ? 'text-brand-300 font-medium' : 'text-slate-200 group-hover:text-white')}>
                      {ch.title || `Chapter ${i + 1}`}
                    </span>
                    <span className="text-xs muted tabular-nums shrink-0">{formatDuration(ch.start)}</span>
                  </button>
                );
              })}
            </div>
          )}
        </div>
        </div>
      </div>
    </Modal>
  );
}

export default function Audiobooks() {
  const [books, setBooks] = useState<Book[] | null>(null);
  const [total, setTotal] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);
  const [err, setErr] = useState(false);
  const [disabled, setDisabled] = useState(false);
  const [selected, setSelected] = useState<Book | null>(null);
  const [query, setQuery] = useState('');
  const [visibleCount, setVisibleCount] = useState(50);
  const loadMoreRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    let alive = true;
    setDisabled(false);
    api.books.audiobooksPage()
      .then((p) => { if (alive) { setBooks(p.items || []); setTotal(p.total || 0); } })
      .catch((e: any) => {
        if (!alive) return;
        setBooks([]); setErr(true);
        if (e?.message === 'feature_disabled') setDisabled(true);
        else toast('Failed to load audiobooks', 'error');
      });
    return () => { alive = false; };
  }, []);

  const matchesQuery = (b: Book, q: string) =>
    !q ||
    b.title.toLowerCase().includes(q) ||
    (b.author || '').toLowerCase().includes(q) ||
    (b.series || '').toLowerCase().includes(q);

  const continueListening = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (books || [])
      .filter((b) => (b.progressPct || 0) > 0 && (b.progressPct || 0) < 100 && matchesQuery(b, q))
      .sort((a, b) => (b.progressPct || 0) - (a.progressPct || 0));
  }, [books, query]);

  const filtered = books || [];

  // Keep the full library searchable, but only mount cards in batches. Rendering
  // thousands of image cards at once was expensive even with native lazy-loading.
  const firstQuery = useRef(true);
  useEffect(() => {
    if (firstQuery.current) { firstQuery.current = false; return; }
    let alive = true;
    const timer = setTimeout(() => {
      setLoadingMore(true);
      api.books.audiobooksPage(0, 50, query.trim()).then(page => {
        if (alive) { setBooks(page.items); setTotal(page.total); setVisibleCount(page.items.length); }
      }).catch(() => { if (alive) toast('Could not search audiobooks', 'error'); })
        .finally(() => { if (alive) setLoadingMore(false); });
    }, 250);
    return () => { alive = false; clearTimeout(timer); };
  }, [query]);

  const loadMore = async () => {
    const current = books || [];
    if (loadingMore || current.length >= total) return;
    setLoadingMore(true);
    try {
      const page = await api.books.audiobooksPage(current.length, 50, query.trim());
      setBooks(prev => [...(prev || []), ...page.items.filter(x => !(prev || []).some(p => p.id === x.id))]);
      setTotal(page.total); setVisibleCount(n => n + page.items.length);
    } finally { setLoadingMore(false); }
  };
  useEffect(() => {
    const node = loadMoreRef.current;
    if (!node || filtered.length >= total || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) loadMore();
    }, { rootMargin: '600px 0px' });
    observer.observe(node);
    return () => observer.disconnect();
  }, [filtered.length, total, loadingMore, query]);

  if (books === null) return <PageLoader />;

  return (
    <div className="animate-fade-in">
      <PageHeader
        title="Audiobooks"
        subtitle={total ? `${total} in your library` : 'Cozy up with a good listen'}
        icon={<Icon.Book size={22} />}
        actions={
          (books.length > 0 || query) ? (
            <div className="relative w-full sm:w-56 max-w-full">
              <Icon.Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
              <input
                className="input pl-9"
                placeholder="Search titles, authors…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
          ) : undefined
        }
      />

      {books.length === 0 && !query ? (
        <EmptyState
          icon={<Icon.Book size={30} />}
          title={disabled ? 'Not available on this account' : err ? 'Library unavailable' : 'No audiobooks yet'}
          subtitle={disabled ? 'Audiobooks and podcasts are disabled for this account.' : err ? 'Could not reach your audiobook library. Check the connection and try again.' : 'Add books to your Audiobookshelf library and they will appear here, ready to play.'}
        />
      ) : (
        <div className="space-y-8">
          {continueListening.length > 0 && (
            <section>
              <h2 className="section-title mb-3 flex items-center gap-2">
                <Icon.Clock size={16} className="text-accent-amber" /> Continue listening
                <span className="text-xs muted font-normal">{continueListening.length}</span>
              </h2>
              <div className="flex gap-4 overflow-x-auto pb-2 -mx-1 px-1">
                {continueListening.map((b) => (
                  <ContinueTile key={b.id} book={b} onOpen={() => setSelected(b)} />
                ))}
              </div>
            </section>
          )}

          <section>
            <h2 className="section-title mb-3">{query ? `Results (${total})` : 'Your library'}</h2>
            {filtered.length === 0 ? (
              <EmptyState icon={<Icon.Search size={26} />} title="No matches" subtitle="Try a different title or author." />
            ) : (
              <>
                <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4 sm:gap-5">
                  {filtered.slice(0, visibleCount).map((b) => (
                    <BookCard key={b.id} book={b} onOpen={() => setSelected(b)} />
                  ))}
                </div>
                {filtered.length < total && (
                  <button ref={loadMoreRef} type="button" onClick={loadMore} disabled={loadingMore}
                    className="btn-secondary mx-auto mt-6">
                    {loadingMore ? 'Loading…' : 'Show more'} <span className="muted text-xs">({total - filtered.length} remaining)</span>
                  </button>
                )}
              </>
            )}
          </section>
        </div>
      )}

      {selected && <BookDetail book={selected} onClose={() => setSelected(null)} />}
    </div>
  );
}
