import React, { useState, useEffect, useMemo } from 'react';
import { api } from '../lib/api';
import { Icon } from '../lib/icons';
import { usePlayer, toast } from '../lib/store';
import { cx, formatDuration } from '../lib/utils';
import { PageLoader, EmptyState, PageHeader, Modal, ProgressBar, Badge, Spinner } from '../components/ui';
import type { Book, Chapter } from '../lib/model';

type ShowDetail = Book & { chapters: Chapter[]; overview?: string };

const SPEEDS = [0.75, 1, 1.25, 1.5, 1.75, 2];

// ---- shared audio helpers (talk to the single global <audio> element) ----
function getAudio(): HTMLAudioElement | null {
  return document.querySelector('audio');
}

let sessionSpeed = 1;
function applySpeed(next?: number) {
  if (next != null) sessionSpeed = next;
  const a = getAudio();
  if (a) a.playbackRate = sessionSpeed;
}

// ---- helpers ------------------------------------------------------------
function trackForShow(b: Book) {
  return {
    id: b.id,
    title: b.title,
    subtitle: b.author || 'Podcast',
    artUrl: b.coverUrl ? api.books.coverUrl(b.coverUrl) : undefined,
    streamUrl: api.books.streamUrl(b.id),
    kind: 'podcast' as const,
    durationSec: b.durationSec,
  };
}

function Cover({ url, className = '', size = 22 }: { url?: string; className?: string; size?: number }) {
  return (
    <div className={cx('bg-ink-700 overflow-hidden grid place-items-center text-slate-600', className)}>
      {url ? (
        <img src={api.books.coverUrl(url)} loading="lazy" className="w-full h-full object-cover" />
      ) : (
        <Icon.Podcast size={size} />
      )}
    </div>
  );
}

// ---- show tile ----------------------------------------------------------
function ShowTile({ show, onOpen, onPlay }: { show: Book; onOpen: () => void; onPlay: () => void }) {
  return (
    <div className="group text-left">
      <button onClick={onOpen} className="relative w-full aspect-square rounded-2xl overflow-hidden bg-ink-800 shadow-card card-hover block">
        <Cover url={show.coverUrl} className="w-full h-full rounded-none" size={40} />
        <div className="absolute inset-0 bg-gradient-to-t from-black/70 via-black/0 to-black/0 opacity-0 group-hover:opacity-100 transition-opacity" />
        <span
          onClick={(e) => { e.stopPropagation(); onPlay(); }}
          className="absolute bottom-3 right-3 w-11 h-11 rounded-full bg-brand-500 text-white grid place-items-center shadow-glow translate-y-2 opacity-0 group-hover:translate-y-0 group-hover:opacity-100 transition-all hover:bg-brand-400 active:scale-95"
        >
          <Icon.Play size={18} className="ml-0.5" />
        </span>
        {typeof show.progressPct === 'number' && show.progressPct > 0 && (
          <div className="absolute inset-x-0 bottom-0"><ProgressBar value={show.progressPct} /></div>
        )}
      </button>
      <button onClick={onOpen} className="block w-full mt-2.5 text-left">
        <p className="text-sm font-medium text-white truncate group-hover:text-brand-300 transition-colors">{show.title}</p>
        <p className="text-xs muted truncate">{show.author || 'Podcast'}</p>
      </button>
    </div>
  );
}

// ---- main ---------------------------------------------------------------
export default function Podcasts() {
  const [shows, setShows] = useState<Book[] | null>(null);
  const [configured, setConfigured] = useState(true);
  const [disabled, setDisabled] = useState(false);
  const [speed, setSpeed] = useState(sessionSpeed);
  const [query, setQuery] = useState('');

  const [openId, setOpenId] = useState<string | null>(null);
  const [detail, setDetail] = useState<ShowDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  // reactive player slices to reflect the current episode
  const curId = usePlayer((s) => s.current?.id);
  const curTime = usePlayer((s) => s.currentTime);
  const playing = usePlayer((s) => s.playing);

  async function load() {
    try {
      setDisabled(false);
      const [st, list] = await Promise.all([
        api.books.status().catch(() => ({ configured: true } as { configured: boolean })),
        api.books.podcasts(),
      ]);
      setConfigured(!!st?.configured);
      setShows(Array.isArray(list) ? list : []);
    } catch (e: any) {
      setShows([]);
      if (e?.message === 'feature_disabled') setDisabled(true);
      else toast('Failed to load podcasts', 'error', e?.message);
    }
  }
  useEffect(() => { load(); }, []);

  useEffect(() => {
    if (!openId) { setDetail(null); return; }
    let alive = true;
    setDetailLoading(true);
    api.books.item(openId)
      .then((d) => { if (alive) setDetail(d); })
      .catch((e: any) => { if (alive) { toast('Could not open show', 'error', e?.message); setOpenId(null); } })
      .finally(() => { if (alive) setDetailLoading(false); });
    return () => { alive = false; };
  }, [openId]);

  const filtered = useMemo<Book[]>(() => {
    if (!shows) return [];
    const q = query.trim().toLowerCase();
    if (!q) return shows;
    return shows.filter((s) => s.title.toLowerCase().includes(q) || (s.author || '').toLowerCase().includes(q));
  }, [shows, query]);

  const continuing = useMemo<Book[]>(() => (shows || []).filter((s) => (s.progressPct ?? 0) > 1 && (s.progressPct ?? 0) < 99), [shows]);
  const fresh = useMemo<Book[]>(() => (shows || []).filter((s) => (s.progressPct ?? 0) === 0).slice(0, 12), [shows]);

  const setSpeedFn = (s: number) => { setSpeed(s); applySpeed(s); };

  function playShow(b: Book) {
    const P = usePlayer.getState();
    if (P.current?.id === b.id) { P.setPlaying(true); applySpeed(); }
    else { P.playTrack(trackForShow(b)); setTimeout(() => applySpeed(), 300); }
    toast('Now playing', 'success', b.title);
  }

  function playEpisode(show: ShowDetail, ch: Chapter, index: number) {
    const P = usePlayer.getState();
    const streamUrl = api.books.streamUrl(show.id);
    const a = getAudio();
    const sameStream = !!(P.current && P.current.streamUrl === streamUrl && a);
    P.playTrack({
      id: `${show.id}:${ch.id ?? index}`,
      title: ch.title || show.title,
      subtitle: show.title,
      artUrl: show.coverUrl ? api.books.coverUrl(show.coverUrl) : undefined,
      streamUrl,
      kind: 'podcast',
      durationSec: ch.end != null && ch.start != null ? Math.max(0, ch.end - ch.start) : show.durationSec,
    });
    const seconds = ch.start || 0;
    if (sameStream && a) {
      a.currentTime = seconds; P.setPlaying(true); applySpeed();
    } else {
      const started = Date.now();
      const attempt = () => {
        const el = getAudio();
        if (el && el.readyState >= 1) { if (seconds > 0) el.currentTime = seconds; applySpeed(); }
        else if (Date.now() - started < 8000) setTimeout(attempt, 200);
      };
      setTimeout(attempt, 250);
    }
    toast('Now playing', 'success', ch.title || show.title);
  }

  if (shows === null) return <PageLoader />;

  const SpeedPicker = (
    <div className="hidden sm:flex items-center gap-1 glass rounded-xl px-1.5 py-1">
      <Icon.Bolt size={14} className="text-brand-400 ml-1" />
      {SPEEDS.map((s) => (
        <button
          key={s}
          onClick={() => setSpeedFn(s)}
          className={cx(
            'text-xs font-medium rounded-lg px-2 py-1 transition-colors',
            speed === s ? 'bg-brand-500 text-white' : 'text-slate-400 hover:text-white hover:bg-white/[0.06]'
          )}
        >
          {s}×
        </button>
      ))}
    </div>
  );

  const empty = shows.length === 0;
  const isActiveShow = !!(detail && curId && (curId === detail.id || curId.startsWith(detail.id + ':')));
  const activeEpIdx = isActiveShow && detail?.chapters?.length
    ? detail.chapters.findIndex((c) => curTime >= c.start && curTime < (c.end || Infinity))
    : -1;

  return (
    <div className="animate-fade-in">
      <PageHeader
        title="Podcasts"
        subtitle={empty ? 'Your subscriptions live here' : `${shows.length} show${shows.length === 1 ? '' : 's'} in your library`}
        icon={<Icon.Podcast size={22} />}
        actions={
          <div className="flex items-center gap-2">
            {SpeedPicker}
            <button className="icon-btn" title="Refresh" onClick={() => { setShows(null); load(); }}>
              <Icon.Refresh size={18} />
            </button>
          </div>
        }
      />

      {empty ? (
        <EmptyState
          icon={<Icon.Podcast size={30} />}
          title={disabled ? 'Not available on this account' : configured ? 'No podcasts yet' : 'Podcasts not configured'}
          subtitle={disabled ? 'Audiobooks and podcasts are disabled for this account.' : configured ? 'Subscribe to shows in your media server and they will appear here.' : 'Connect your audiobook & podcast server to start listening.'}
        />
      ) : (
        <div className="space-y-9">
          {/* Continue listening */}
          {continuing.length > 0 && (
            <section>
              <h2 className="section-title mb-3">Continue listening</h2>
              <div className="flex gap-4 overflow-x-auto pb-2 -mx-1 px-1">
                {continuing.map((s) => (
                  <button
                    key={s.id}
                    onClick={() => playShow(s)}
                    className="group shrink-0 w-[280px] sm:w-[300px] card card-hover !p-3 flex items-center gap-3 text-left"
                  >
                    <Cover url={s.coverUrl} className="w-16 h-16 rounded-xl shrink-0" />
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium text-white truncate group-hover:text-brand-300">{s.title}</p>
                      <p className="text-xs muted truncate mb-2">{s.author || 'Podcast'}</p>
                      <ProgressBar value={s.progressPct || 0} />
                      <p className="text-[11px] text-slate-500 mt-1">
                        {Math.round(s.progressPct || 0)}% listened
                        {s.durationSec ? ` · ${formatDuration(s.durationSec)}` : ''}
                      </p>
                    </div>
                    <span className="w-10 h-10 rounded-full bg-brand-500 text-white grid place-items-center shrink-0 shadow-glow">
                      <Icon.Play size={15} className="ml-0.5" />
                    </span>
                  </button>
                ))}
              </div>
            </section>
          )}

          {/* New / fresh episodes rail */}
          {fresh.length > 0 && (
            <section>
              <div className="flex items-center justify-between mb-3">
                <h2 className="section-title">New episodes</h2>
                <Badge color="brand">{fresh.length} unplayed</Badge>
              </div>
              <div className="flex gap-4 overflow-x-auto pb-2 -mx-1 px-1">
                {fresh.map((s) => (
                  <div key={s.id} className="shrink-0 w-[140px] sm:w-[150px]">
                    <ShowTile show={s} onOpen={() => setOpenId(s.id)} onPlay={() => playShow(s)} />
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* All shows */}
          <section>
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-4">
              <h2 className="section-title">All shows</h2>
              <div className="relative w-full sm:w-64">
                <Icon.Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
                <input
                  className="input !pl-9"
                  placeholder="Search shows…"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
              </div>
            </div>
            {filtered.length === 0 ? (
              <EmptyState icon={<Icon.Search size={26} />} title="No matches" subtitle={`Nothing matches “${query}”.`} />
            ) : (
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-x-4 gap-y-6">
                {filtered.map((s: Book) => (
                  <ShowTile key={s.id} show={s} onOpen={() => setOpenId(s.id)} onPlay={() => playShow(s)} />
                ))}
              </div>
            )}
          </section>
        </div>
      )}

      {/* Show detail modal */}
      <Modal open={!!openId} onClose={() => setOpenId(null)} title="" size="lg">
        {detailLoading || !detail ? (
          <div className="py-16 grid place-items-center"><Spinner size={28} /></div>
        ) : (
          <div className="relative max-h-[86vh] sm:max-h-[80vh] overflow-y-auto -m-1 p-1">
            <button
              onClick={() => setOpenId(null)}
              className="absolute top-1 right-1 z-10 icon-btn bg-ink-900/70 backdrop-blur"
              aria-label="Close"
            >
              <Icon.Close size={18} />
            </button>
            <div className="flex gap-4 sm:gap-5">
              <Cover url={detail.coverUrl} className="w-24 h-24 sm:w-36 sm:h-36 rounded-2xl shrink-0 shadow-card" size={44} />
              <div className="min-w-0 flex-1">
                <p className="text-[11px] uppercase tracking-wide text-brand-400 font-semibold mb-1">Podcast</p>
                <h2 className="text-lg sm:text-2xl font-bold text-white leading-tight pr-8">{detail.title}</h2>
                {detail.author && <p className="muted mt-0.5 truncate">{detail.author}</p>}
                <div className="flex flex-wrap items-center gap-2 mt-3">
                  <button className="btn-primary min-h-[44px]" onClick={() => playShow(detail)}>
                    <Icon.Play size={16} /> Play latest
                  </button>
                  {detail.chapters?.length ? (
                    <Badge color="slate">{detail.chapters.length} episode{detail.chapters.length === 1 ? '' : 's'}</Badge>
                  ) : null}
                </div>
              </div>
            </div>

            {/* Speed (works on all sizes here) */}
            <div className="mt-4 flex items-center gap-1.5 flex-wrap">
              <span className="text-xs muted mr-1 flex items-center gap-1"><Icon.Bolt size={13} className="text-brand-400" /> Speed</span>
              {SPEEDS.map((s) => (
                <button
                  key={s}
                  onClick={() => setSpeedFn(s)}
                  className={cx('min-w-[44px] px-2.5 py-1.5 rounded-lg text-xs font-medium transition-colors',
                    speed === s ? 'bg-brand-500 text-white shadow-glow' : 'glass text-slate-400 hover:text-white')}
                >{s}×</button>
              ))}
            </div>

            {detail.overview && (
              <p className="text-sm text-slate-300 leading-relaxed mt-5 whitespace-pre-line line-clamp-6">{detail.overview}</p>
            )}

            <div className="mt-6">
              <h3 className="section-title mb-3">Episodes</h3>
              {detail.chapters && detail.chapters.length > 0 ? (
                <div className="max-h-[45vh] overflow-y-auto pr-1 divide-y divide-white/[0.05]">
                  {detail.chapters.map((ch, i) => {
                    const len = ch.end != null && ch.start != null ? Math.max(0, ch.end - ch.start) : undefined;
                    const active = i === activeEpIdx;
                    return (
                      <button
                        key={ch.id ?? i}
                        onClick={() => playEpisode(detail, ch, i)}
                        className={cx('w-full flex items-center gap-3 py-3 text-left group rounded-lg px-2 -mx-2 transition-colors',
                          active ? 'bg-brand-500/15' : 'hover:bg-white/[0.03]')}
                      >
                        <span className={cx('w-9 h-9 rounded-full grid place-items-center shrink-0 transition-colors',
                          active ? 'bg-brand-500 text-white' : 'bg-white/[0.05] text-slate-400 group-hover:bg-brand-500 group-hover:text-white')}>
                          {active && playing ? <Icon.Pause size={14} /> : <Icon.Play size={14} className="ml-0.5" />}
                        </span>
                        <div className="min-w-0 flex-1">
                          <p className={cx('text-sm truncate', active ? 'text-brand-300 font-medium' : 'text-white group-hover:text-brand-300')}>{ch.title || `Episode ${i + 1}`}</p>
                          <p className="text-xs muted">Episode {i + 1}{len ? ` · ${formatDuration(len)}` : ''}</p>
                        </div>
                        <Icon.ChevronRight size={16} className="text-slate-600 shrink-0" />
                      </button>
                    );
                  })}
                </div>
              ) : (
                <div className="card !p-4 flex items-center gap-3">
                  <Cover url={detail.coverUrl} className="w-12 h-12 rounded-xl shrink-0" size={18} />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm text-white truncate">{detail.title}</p>
                    <p className="text-xs muted">
                      Single feed{detail.durationSec ? ` · ${formatDuration(detail.durationSec)}` : ''}
                      {detail.progressPct ? ` · ${Math.round(detail.progressPct)}% listened` : ''}
                    </p>
                  </div>
                  <button className="btn-secondary" onClick={() => playShow(detail)}>
                    <Icon.Play size={15} /> Play
                  </button>
                </div>
              )}
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
