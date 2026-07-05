import React, { useState, useEffect, useMemo } from 'react';
import { api } from '../lib/api';
import { Icon } from '../lib/icons';
import { cx, ticksToTime, colorFor, initials } from '../lib/utils';
import { usePlayer, useAuth, toast } from '../lib/store';
import type { Track } from '../lib/store';
import { PageLoader, EmptyState, PageHeader, Modal, Spinner } from '../components/ui';
import type { MediaItem } from '../lib/model';

type Tab = 'albums' | 'artists' | 'songs' | 'playlists';

// ---- helpers ---------------------------------------------------------------

function durationSecOf(m: MediaItem): number {
  if (m.runtimeTicks) return Math.round(m.runtimeTicks / 10_000_000);
  if (m.runtimeMinutes) return m.runtimeMinutes * 60;
  return 0;
}

function trackLabel(m: MediaItem): string {
  return ticksToTime(m.runtimeTicks) || (m.runtimeMinutes ? `${m.runtimeMinutes}:00` : '—');
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function fmtMins(sec: number): string {
  if (!sec) return '';
  const m = Math.round(sec / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return `${h} hr ${m % 60} min`;
}

function toTrack(m: MediaItem, artFallback?: string): Track {
  return {
    id: m.id,
    title: m.name,
    subtitle: m.albumArtist || m.album || 'Unknown artist',
    artUrl: m.posterUrl || m.thumbUrl || artFallback,
    streamUrl: api.media.streamUrl(m.id, true),
    kind: 'music',
    durationSec: durationSecOf(m),
  };
}

function shuffled(arr: MediaItem[]): MediaItem[] {
  return [...arr].sort(() => Math.random() - 0.5);
}

// Jellyfin seeds junk "system" artists (e.g. "_auto-import") that shouldn't be
// shown as real artists. Treat empty names and any leading-underscore name as
// system entries and hide them everywhere.
function isSystemArtist(name?: string): boolean {
  const n = (name || '').trim();
  return !n || n.startsWith('_');
}

// ---- tiny visuals ----------------------------------------------------------

function EqBars() {
  return (
    <span className="inline-flex items-end gap-[2px] h-3.5">
      {[0, 1, 2].map(i => (
        <span
          key={i}
          className="w-[3px] bg-brand-400 rounded-full animate-eq"
          style={{ height: '100%', animationDelay: `${i * 0.18}s` }}
        />
      ))}
      <style>{`@keyframes eqp{0%,100%{transform:scaleY(0.35)}50%{transform:scaleY(1)}}.animate-eq{transform-origin:bottom;animation:eqp 0.9s ease-in-out infinite}`}</style>
    </span>
  );
}

function TabButton({ active, onClick, icon, label }: { active: boolean; onClick: () => void; icon: React.ReactNode; label: string }) {
  return (
    <button
      onClick={onClick}
      className={cx(
        'flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium transition-all shrink-0 whitespace-nowrap',
        active ? 'bg-brand-500/15 text-brand-300 shadow-glow' : 'text-slate-400 hover:text-white hover:bg-white/[0.04]'
      )}
    >
      {icon}
      {label}
    </button>
  );
}

// ---- cover art with generated fallback -------------------------------------
// Never shows an empty grey box: if there is no art (or the <img> fails to load)
// we render a gradient tile derived from the title plus its initials / a note.

function CoverArt({ src, title, className, shape = 'square', textClass = 'text-2xl', iconSize = 22, useInitials = true }: {
  src?: string | null; title: string; className?: string;
  shape?: 'square' | 'circle'; textClass?: string; iconSize?: number; useInitials?: boolean;
}) {
  const [failed, setFailed] = useState(false);
  useEffect(() => { setFailed(false); }, [src]);
  const show = !!src && !failed;
  const c = colorFor(title || 'music');
  const ini = title ? initials(title) : '';
  return (
    <div className={cx('relative w-full h-full overflow-hidden bg-ink-800', shape === 'circle' ? 'rounded-full' : '', className)}>
      {show ? (
        <img src={src!} loading="lazy" onError={() => setFailed(true)} className="w-full h-full object-cover" />
      ) : (
        <div
          className="w-full h-full grid place-items-center"
          style={{ background: `radial-gradient(120% 120% at 30% 20%, ${c}66, ${c}22 55%, ${c}10 100%)` }}
        >
          {useInitials && ini ? (
            <span className={cx('font-bold text-white/90 leading-none tracking-tight select-none', textClass)} style={{ textShadow: '0 1px 6px rgba(0,0,0,0.35)' }}>{ini}</span>
          ) : (
            <Icon.Music size={iconSize} className="text-white/70" />
          )}
        </div>
      )}
    </div>
  );
}

// ---- album card (local, so we control the missing-art fallback) ------------

function AlbumCard({ album, onClick }: { album: MediaItem; onClick: () => void }) {
  const img = album.posterUrl || album.thumbUrl || album.backdropUrl;
  return (
    <button onClick={onClick} className="group text-left w-full">
      <div className="relative aspect-square rounded-xl overflow-hidden bg-ink-800 shadow-card card-hover">
        <CoverArt src={img} title={album.name} textClass="text-3xl sm:text-4xl" />
        <div className="absolute inset-0 bg-gradient-to-t from-black/70 via-transparent to-transparent opacity-0 group-hover:opacity-100 transition-opacity" />
        <div className="absolute inset-0 grid place-items-center opacity-0 group-hover:opacity-100 transition-opacity">
          <div className="w-12 h-12 rounded-full bg-white/90 text-ink-900 grid place-items-center shadow-float scale-90 group-hover:scale-100 transition-transform">
            <Icon.Play size={22} />
          </div>
        </div>
      </div>
      <p className="text-sm font-medium text-white truncate mt-2">{album.name}</p>
      <p className="text-xs muted truncate">{album.albumArtist || (album.year ? String(album.year) : 'Album')}</p>
    </button>
  );
}

// ---- artist card -----------------------------------------------------------

function ArtistCard({ item, onClick }: { item: MediaItem; onClick: () => void }) {
  const img = item.posterUrl || item.thumbUrl;
  return (
    <button onClick={onClick} className="group flex flex-col items-center text-center w-full">
      <div className="relative aspect-square w-full rounded-full overflow-hidden bg-ink-800 shadow-card card-hover">
        <CoverArt src={img} title={item.name} shape="circle" textClass="text-3xl sm:text-4xl" />
        <div className="absolute inset-0 grid place-items-center opacity-0 group-hover:opacity-100 transition-opacity bg-black/30">
          <div className="w-11 h-11 rounded-full bg-white/90 text-ink-900 grid place-items-center shadow-float scale-90 group-hover:scale-100 transition-transform">
            <Icon.Play size={20} />
          </div>
        </div>
      </div>
      <p className="text-sm font-medium text-white truncate mt-2 w-full">{item.name}</p>
      <p className="text-xs muted">Artist</p>
    </button>
  );
}

// ---- "Made for you" mix card -----------------------------------------------
// A shuffle-based mix built from an artist's songs. Album-forward: uses the
// artist's cover art tinted with their signature gradient, never a blank box.

function MixCard({ name, art, count, onPlay, isPlaying }: {
  name: string; art?: string | null; count: number; onPlay: () => void; isPlaying?: boolean;
}) {
  const c = colorFor(name);
  return (
    <button onClick={onPlay} className="group text-left w-full">
      <div className="relative aspect-square rounded-xl overflow-hidden bg-ink-800 shadow-card card-hover">
        <CoverArt src={art} title={name} textClass="text-3xl sm:text-4xl" />
        <div className="absolute inset-0" style={{ background: `linear-gradient(150deg, ${c}66 0%, transparent 55%)` }} />
        <div className="absolute inset-x-0 bottom-0 h-2/3 bg-gradient-to-t from-black/85 via-black/35 to-transparent" />
        <span className="absolute top-2 left-2 px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase tracking-wider bg-white/15 text-white backdrop-blur-sm">
          Mix
        </span>
        <div className="absolute inset-x-0 bottom-0 p-2.5 sm:p-3">
          <p className="text-sm font-bold text-white truncate leading-tight">{name}</p>
          <p className="text-[11px] text-white/70 truncate">{plural(count, 'song')} · Made for you</p>
        </div>
        <div className="absolute right-2.5 bottom-2.5 w-9 h-9 rounded-full bg-brand-500 text-white grid place-items-center shadow-float translate-y-1 opacity-0 group-hover:opacity-100 group-hover:translate-y-0 transition-all">
          {isPlaying ? <Icon.Pause size={16} /> : <Icon.Play size={16} />}
        </div>
      </div>
    </button>
  );
}

// ---- song row --------------------------------------------------------------

function SongRow({ song, index, onPlay, isCurrent, isPlaying, isFav, onToggleFav, showArt, subtitle }: {
  song: MediaItem; index: number; onPlay: () => void; isCurrent: boolean; isPlaying?: boolean; isFav: boolean; onToggleFav: () => void; showArt?: boolean; subtitle?: string;
}) {
  return (
    <div
      className={cx(
        'group grid items-center gap-3 px-2 sm:px-3 py-2 rounded-xl transition-colors',
        showArt ? 'grid-cols-[1.75rem_2.75rem_1fr_auto_auto]' : 'grid-cols-[1.75rem_1fr_auto_auto]',
        isCurrent ? 'bg-brand-500/10' : 'hover:bg-white/[0.04] active:bg-white/[0.06]'
      )}
    >
      <button onClick={onPlay} aria-label={isCurrent && isPlaying ? `Pause ${song.name}` : `Play ${song.name}`} className="w-7 h-9 grid place-items-center text-slate-500 shrink-0">
        {isCurrent && isPlaying ? (
          <EqBars />
        ) : (
          <>
            <span className={cx('sm:group-hover:hidden tabular-nums text-sm', isCurrent && 'text-brand-300')}>{index + 1}</span>
            <Icon.Play size={15} className="hidden sm:group-hover:block text-white" />
          </>
        )}
      </button>
      {showArt && (
        <div className="w-11 h-11 rounded-lg overflow-hidden shrink-0">
          <CoverArt src={song.posterUrl || song.thumbUrl} title={song.album || song.name} textClass="text-sm" iconSize={16} />
        </div>
      )}
      <button onClick={onPlay} className="min-w-0 text-left py-1">
        <p className={cx('text-sm font-medium truncate', isCurrent ? 'text-brand-300' : 'text-white')}>{song.name}</p>
        <p className="text-xs muted truncate">{subtitle || song.albumArtist || song.album || 'Unknown artist'}</p>
      </button>
      <button
        onClick={onToggleFav}
        className={cx('icon-btn shrink-0 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity', isFav && '!opacity-100')}
        title={isFav ? 'Remove from Liked Songs' : 'Add to Liked Songs'}
      >
        <Icon.Heart size={16} filled={isFav} className={isFav ? 'text-accent-pink' : 'text-slate-400'} />
      </button>
      <span className="text-xs muted tabular-nums shrink-0 pr-1 w-11 text-right">{trackLabel(song)}</span>
    </div>
  );
}

// ---- album detail modal ----------------------------------------------------

function AlbumModal({ album, onClose, favIds, onToggleFav }: {
  album: MediaItem; onClose: () => void; favIds: Set<string>; onToggleFav: (s: MediaItem) => void;
}) {
  const player = usePlayer();
  const [tracks, setTracks] = useState<MediaItem[] | null>(null);
  const [err, setErr] = useState(false);

  useEffect(() => {
    let alive = true;
    setTracks(null); setErr(false);
    api.media.children(album.id)
      .then(list => { if (alive) setTracks((list || []).filter(t => t.type === 'Audio')); })
      .catch(() => { if (alive) { setErr(true); setTracks([]); } });
    return () => { alive = false; };
  }, [album.id]);

  const art = album.posterUrl || album.thumbUrl;
  const totalSec = (tracks || []).reduce((a, t) => a + durationSecOf(t), 0);

  const playFrom = (start: number) => {
    if (!tracks || !tracks.length) return;
    player.playQueue(tracks.map(t => toTrack(t, art)), start);
  };
  const shufflePlay = () => {
    if (!tracks || !tracks.length) return;
    player.playQueue(shuffled(tracks).map(t => toTrack(t, art)), 0);
    toast(`Shuffling ${album.name}`, 'success');
  };

  return (
    <Modal open onClose={onClose} size="lg" title={undefined}>
      <div className="relative">
      <button
        onClick={onClose}
        aria-label="Close"
        title="Close"
        className="icon-btn absolute -top-1 -right-1 z-10 bg-black/40 backdrop-blur-sm"
      >
        <Icon.Close size={18} />
      </button>
      <div className="flex flex-col sm:flex-row gap-5 mb-5 pr-8">
        <div className="w-36 h-36 sm:w-40 sm:h-40 shrink-0 rounded-2xl overflow-hidden bg-ink-800 shadow-float mx-auto sm:mx-0">
          <CoverArt src={art} title={album.name} textClass="text-5xl" />
        </div>
        <div className="flex flex-col justify-end min-w-0 text-center sm:text-left">
          <p className="text-xs uppercase tracking-wider muted mb-1">Album</p>
          <h2 className="text-xl sm:text-2xl font-bold text-white leading-tight break-words">{album.name}</h2>
          <p className="text-sm text-slate-300 mt-1 truncate">{album.albumArtist || 'Unknown artist'}</p>
          <p className="text-xs muted mt-1">
            {album.year ? `${album.year} · ` : ''}
            {tracks ? plural(tracks.length, 'song') : '…'}
            {totalSec ? ` · ${fmtMins(totalSec)}` : ''}
          </p>
          <div className="flex items-center gap-2 mt-4 justify-center sm:justify-start">
            <button className="btn-primary" onClick={() => playFrom(0)} disabled={!tracks || !tracks.length}>
              <Icon.Play size={16} /> Play
            </button>
            <button className="btn-secondary" onClick={shufflePlay} disabled={!tracks || !tracks.length}>
              <Icon.Shuffle size={16} /> Shuffle
            </button>
          </div>
        </div>
      </div>

      <div className="max-h-[45vh] overflow-y-auto -mx-1 pr-1">
        {tracks === null ? (
          <div className="py-10 grid place-items-center"><Spinner /></div>
        ) : tracks.length === 0 ? (
          <EmptyState icon={<Icon.Music size={26} />} title={err ? 'Could not load tracks' : 'No tracks'} subtitle={err ? 'This album is unavailable.' : 'This album is empty.'} />
        ) : (
          <div className="space-y-0.5">
            {tracks.map((t, i) => (
              <SongRow
                key={t.id}
                song={t}
                index={i}
                onPlay={() => playFrom(i)}
                isCurrent={player.current?.id === t.id}
                isPlaying={player.playing}
                isFav={favIds.has(t.id)}
                onToggleFav={() => onToggleFav(t)}
              />
            ))}
          </div>
        )}
      </div>
      </div>
    </Modal>
  );
}

// ---- artist detail modal ---------------------------------------------------

function ArtistModal({ artist, albums, songs, onClose, favIds, onToggleFav, onOpenAlbum }: {
  artist: MediaItem; albums: MediaItem[]; songs: MediaItem[]; onClose: () => void;
  favIds: Set<string>; onToggleFav: (s: MediaItem) => void; onOpenAlbum: (a: MediaItem) => void;
}) {
  const player = usePlayer();
  const name = artist.name.toLowerCase();
  const art = artist.posterUrl || artist.thumbUrl;

  const theirAlbums = useMemo(
    () => albums.filter(a => (a.albumArtist || '').toLowerCase() === name),
    [albums, name]
  );
  const theirSongs = useMemo(
    () => songs.filter(s => (s.albumArtist || '').toLowerCase() === name),
    [songs, name]
  );
  const totalSec = theirSongs.reduce((a, s) => a + durationSecOf(s), 0);

  const playAll = () => {
    if (!theirSongs.length) return;
    player.playQueue(theirSongs.map(s => toTrack(s, art)), 0);
    toast(`Playing ${artist.name}`, 'success', plural(theirSongs.length, 'song'));
  };
  const shufflePlay = () => {
    if (!theirSongs.length) return;
    player.playQueue(shuffled(theirSongs).map(s => toTrack(s, art)), 0);
    toast(`Shuffling ${artist.name}`, 'success');
  };

  return (
    <Modal open onClose={onClose} size="lg" title={undefined}>
      <div className="relative">
      <button
        onClick={onClose}
        aria-label="Close"
        title="Close"
        className="icon-btn absolute -top-1 -right-1 z-10 bg-black/40 backdrop-blur-sm"
      >
        <Icon.Close size={18} />
      </button>
      <div className="flex flex-col sm:flex-row items-center sm:items-end gap-5 mb-5 pr-8">
        <div className="w-32 h-32 sm:w-36 sm:h-36 shrink-0 rounded-full overflow-hidden bg-ink-800 shadow-float">
          <CoverArt src={art} title={artist.name} shape="circle" textClass="text-4xl sm:text-5xl" />
        </div>
        <div className="flex flex-col min-w-0 text-center sm:text-left">
          <p className="text-xs uppercase tracking-wider muted mb-1">Artist</p>
          <h2 className="text-2xl font-bold text-white leading-tight break-words">{artist.name}</h2>
          <p className="text-xs muted mt-1">
            {theirAlbums.length ? `${plural(theirAlbums.length, 'album')} · ` : ''}
            {plural(theirSongs.length, 'song')}
            {totalSec ? ` · ${fmtMins(totalSec)}` : ''}
          </p>
          <div className="flex items-center gap-2 mt-4 justify-center sm:justify-start">
            <button className="btn-primary" onClick={playAll} disabled={!theirSongs.length}>
              <Icon.Play size={16} /> Play
            </button>
            <button className="btn-secondary" onClick={shufflePlay} disabled={!theirSongs.length}>
              <Icon.Shuffle size={16} /> Shuffle
            </button>
          </div>
        </div>
      </div>

      <div className="max-h-[55vh] overflow-y-auto -mx-1 px-1">
        {theirAlbums.length > 0 && (
          <div className="mb-5">
            <h3 className="section-title mb-3">Albums</h3>
            <div className="grid grid-cols-3 sm:grid-cols-4 gap-3">
              {theirAlbums.map(a => (
                <AlbumCard key={a.id} album={a} onClick={() => onOpenAlbum(a)} />
              ))}
            </div>
          </div>
        )}
        {theirSongs.length > 0 && (
          <div>
            <h3 className="section-title mb-2">Songs</h3>
            <div className="space-y-0.5">
              {theirSongs.map((s, i) => (
                <SongRow
                  key={s.id}
                  song={s}
                  index={i}
                  showArt
                  subtitle={s.album}
                  onPlay={() => player.playQueue(theirSongs.map(t => toTrack(t, art)), i)}
                  isCurrent={player.current?.id === s.id}
                  isPlaying={player.playing}
                  isFav={favIds.has(s.id)}
                  onToggleFav={() => onToggleFav(s)}
                />
              ))}
            </div>
          </div>
        )}
        {!theirAlbums.length && !theirSongs.length && (
          <EmptyState icon={<Icon.Music size={26} />} title="Nothing here" subtitle="No songs found for this artist in your library." />
        )}
      </div>
      </div>
    </Modal>
  );
}

// ---- queue / now playing modal ---------------------------------------------

function QueueModal({ onClose }: { onClose: () => void }) {
  const player = usePlayer();
  const { queue, index, current, playing, shuffle, repeat } = player;

  const upcomingCount = Math.max(0, queue.length - index - 1);

  return (
    <Modal open onClose={onClose} size="md" title="Queue">
      {current && (
        <div className="flex items-center gap-3 mb-4 p-3 rounded-2xl bg-gradient-to-br from-brand-500/15 to-transparent">
          <div className="w-16 h-16 rounded-xl overflow-hidden shrink-0 shadow-float">
            <CoverArt src={current.artUrl} title={current.title} textClass="text-xl" iconSize={22} />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-[10px] uppercase tracking-wider muted flex items-center gap-1.5">
              {playing ? <EqBars /> : null} Now playing
            </p>
            <p className="text-sm font-semibold text-white truncate">{current.title}</p>
            <p className="text-xs muted truncate">{current.subtitle}</p>
          </div>
          <button aria-label={playing ? 'Pause' : 'Play'} className="w-11 h-11 rounded-full bg-white text-ink-900 grid place-items-center shadow-float shrink-0 hover:scale-105 transition-transform" onClick={player.toggle}>
            {playing ? <Icon.Pause size={20} /> : <Icon.Play size={20} />}
          </button>
        </div>
      )}

      <div className="flex items-center gap-2 mb-3">
        <button
          onClick={player.toggleShuffle}
          className={cx('flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors', shuffle ? 'bg-brand-500/15 text-brand-300' : 'text-slate-400 hover:text-white hover:bg-white/[0.05]')}
        >
          <Icon.Shuffle size={14} /> Shuffle
        </button>
        <button
          onClick={player.cycleRepeat}
          className={cx('flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors', repeat !== 'off' ? 'bg-brand-500/15 text-brand-300' : 'text-slate-400 hover:text-white hover:bg-white/[0.05]')}
        >
          <Icon.Repeat size={14} /> {repeat === 'one' ? 'Repeat one' : repeat === 'all' ? 'Repeat all' : 'Repeat'}
        </button>
        <button
          onClick={() => { player.clear(); onClose(); }}
          className="ml-auto flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-slate-400 hover:text-accent-red hover:bg-accent-red/10 transition-colors"
        >
          <Icon.Trash size={14} /> Clear
        </button>
      </div>

      {queue.length === 0 ? (
        <EmptyState icon={<Icon.List size={26} />} title="Queue is empty" subtitle="Play something to build your queue." />
      ) : (
        <div className="max-h-[50vh] overflow-y-auto -mx-1 px-1">
          <p className="text-[11px] uppercase tracking-wider muted mb-1.5 px-2">
            {upcomingCount > 0 ? `Up next · ${upcomingCount}` : 'End of queue'}
          </p>
          <div className="space-y-0.5">
            {queue.map((t, i) => {
              const isCur = i === index;
              return (
                <button
                  key={`${t.id}-${i}`}
                  onClick={() => player.playQueue(queue, i)}
                  className={cx('w-full group grid grid-cols-[2.5rem_1fr_auto] items-center gap-3 px-2 py-2 rounded-xl text-left transition-colors', isCur ? 'bg-brand-500/10' : 'hover:bg-white/[0.04]')}
                >
                  <div className="w-10 h-10 rounded-lg overflow-hidden shrink-0 relative">
                    <CoverArt src={t.artUrl} title={t.title} textClass="text-xs" iconSize={16} />
                    {isCur && (
                      <div className="absolute inset-0 grid place-items-center bg-black/40">
                        {playing ? <EqBars /> : <Icon.Play size={16} className="text-white" />}
                      </div>
                    )}
                  </div>
                  <div className="min-w-0">
                    <p className={cx('text-sm font-medium truncate', isCur ? 'text-brand-300' : 'text-white')}>{t.title}</p>
                    <p className="text-xs muted truncate">{t.subtitle}</p>
                  </div>
                  {t.durationSec ? <span className="text-xs muted tabular-nums shrink-0 pr-1">{ticksToTime(t.durationSec * 10_000_000)}</span> : <span />}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </Modal>
  );
}

// ---- main page -------------------------------------------------------------

export default function Music() {
  const player = usePlayer();
  const { user } = useAuth();
  const [tab, setTab] = useState<Tab>('albums');
  const [loading, setLoading] = useState(true);
  const [configured, setConfigured] = useState(true);

  const [albums, setAlbums] = useState<MediaItem[]>([]);
  const [artists, setArtists] = useState<MediaItem[]>([]);
  const [songs, setSongs] = useState<MediaItem[]>([]);
  const [resume, setResume] = useState<MediaItem[]>([]);
  const [recentAdded, setRecentAdded] = useState<MediaItem[]>([]);

  const [openAlbum, setOpenAlbum] = useState<MediaItem | null>(null);
  const [openArtistItem, setOpenArtistItem] = useState<MediaItem | null>(null);
  const [showQueue, setShowQueue] = useState(false);
  const [query, setQuery] = useState('');

  const [favIds, setFavIds] = useState<Set<string>>(new Set());
  const [prefs, setPrefs] = useState<any>({});

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const st = await api.media.status().catch(() => ({ configured: false }));
        if (!alive) return;
        setConfigured(!!st?.configured);
        const [al, ar, so, rs, rec, se] = await Promise.all([
          api.media.albums().catch(() => []),
          api.media.artists().catch(() => []),
          api.media.songs().catch(() => []),
          api.media.resumeAudio().catch(() => []),
          api.media.recommendations().catch(() => null),
          api.settings.get().catch(() => null),
        ]);
        if (!alive) return;
        setAlbums(al || []);
        setArtists((ar || []).filter(a => !isSystemArtist(a.name)));
        setSongs((so || []).slice(0, 500));
        setResume((rs || []).filter(x => x.type === 'Audio'));
        // Prefer server-side "recently added" albums when it surfaces music.
        const recAlbums = (rec?.recentlyAdded || []).filter(x => x.type === 'MusicAlbum');
        setRecentAdded(recAlbums);
        const p = (se as any)?.preferences || {};
        setPrefs(p);
        setFavIds(new Set<string>(Array.isArray(p.likedSongs) ? p.likedSongs : []));
      } catch {
        if (alive) toast('Failed to load music library', 'error');
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, []);

  const persistFavs = async (next: Set<string>) => {
    setFavIds(new Set<string>(next));
    try {
      const arr = Array.from(next);
      const merged = { ...prefs, likedSongs: arr };
      setPrefs(merged);
      await api.settings.preferences(merged);
    } catch {
      toast('Could not save Liked Songs', 'error');
    }
  };

  const toggleFav = (s: MediaItem) => {
    const next = new Set<string>(favIds);
    if (next.has(s.id)) { next.delete(s.id); }
    else { next.add(s.id); }
    persistFavs(next);
  };

  // Unified search across the library
  const q = query.trim().toLowerCase();
  const searching = q.length > 0;

  const filteredSongs = useMemo(() => {
    if (!q) return songs;
    return songs.filter(s =>
      s.name.toLowerCase().includes(q) ||
      (s.albumArtist || '').toLowerCase().includes(q) ||
      (s.album || '').toLowerCase().includes(q)
    );
  }, [songs, q]);

  const filteredAlbums = useMemo(() => {
    if (!q) return albums;
    return albums.filter(a =>
      a.name.toLowerCase().includes(q) || (a.albumArtist || '').toLowerCase().includes(q)
    );
  }, [albums, q]);

  const filteredArtists = useMemo(() => {
    if (!q) return artists;
    return artists.filter(a => a.name.toLowerCase().includes(q));
  }, [artists, q]);

  const likedSongs = useMemo(() => songs.filter(s => favIds.has(s.id)), [songs, favIds]);
  // Only the server's recommendations feed carries a real "date added" ordering.
  // When it doesn't surface music albums we fall back to the plain album list —
  // in that case label the rail "Albums" instead of falsely claiming recency.
  const hasRealRecent = recentAdded.length >= 4;
  const recentlyAdded = useMemo(
    () => (hasRealRecent ? recentAdded : albums).slice(0, 14),
    [hasRealRecent, recentAdded, albums]
  );

  // "Made for you" mixes: shuffle-based per-artist mixes, ranked by depth in
  // your library. Deterministic order (art derived from the artist's covers).
  const mixes = useMemo(() => {
    const byArtist = new Map<string, MediaItem[]>();
    for (const s of songs) {
      const a = (s.albumArtist || '').trim();
      if (isSystemArtist(a)) continue;
      const arr = byArtist.get(a);
      if (arr) arr.push(s); else byArtist.set(a, [s]);
    }
    return [...byArtist.entries()]
      .filter(([, v]) => v.length >= 4)
      .sort((a, b) => b[1].length - a[1].length)
      .slice(0, 6)
      .map(([name, tracks]) => {
        const withArt = tracks.find(t => t.posterUrl || t.thumbUrl);
        return { name, tracks, art: withArt ? (withArt.posterUrl || withArt.thumbUrl) : undefined };
      });
  }, [songs]);

  const playMix = (name: string, tracks: MediaItem[]) => {
    if (!tracks.length) return;
    const art = tracks.find(t => t.posterUrl || t.thumbUrl);
    player.playQueue(shuffled(tracks).map(t => toTrack(t, art?.posterUrl || art?.thumbUrl)), 0);
    toast(`${name} Mix`, 'success', `Shuffling ${plural(tracks.length, 'song')}`);
  };

  const playSong = (s: MediaItem, queue: MediaItem[]) => {
    const art = s.posterUrl || s.thumbUrl;
    player.playTrack(toTrack(s, art), queue.map(t => toTrack(t, t.posterUrl || t.thumbUrl)));
  };

  const shuffleAll = () => {
    if (!songs.length) return;
    player.playQueue(shuffled(songs).map(s => toTrack(s, s.posterUrl || s.thumbUrl)), 0);
    toast('Shuffling your library', 'success', plural(songs.length, 'song'));
  };

  if (loading) return <PageLoader />;

  const anyContent = albums.length || artists.length || songs.length;

  return (
    <div className="animate-fade-in">
      <PageHeader
        title="Music"
        subtitle={anyContent ? `${plural(songs.length, 'song')} · ${plural(albums.length, 'album')} · ${plural(artists.length, 'artist')}` : 'Your private music library'}
        icon={<Icon.Music size={22} />}
        actions={
          songs.length ? (
            <div className="flex items-center gap-2">
              {player.queue.length > 0 && (
                <button aria-label="Open queue" className="btn-secondary" onClick={() => setShowQueue(true)}>
                  <Icon.List size={16} /> <span className="hidden sm:inline">Queue</span>
                </button>
              )}
              <button aria-label="Shuffle all songs" className="btn-primary" onClick={shuffleAll}>
                <Icon.Shuffle size={16} /> Shuffle
              </button>
            </div>
          ) : undefined
        }
      />

      {!anyContent ? (
        <EmptyState
          icon={<Icon.Music size={30} />}
          title={configured ? 'No music yet' : 'Music library not configured'}
          subtitle={configured ? 'Add music to your library and it will appear here.' : 'Connect your media backend to start streaming your collection.'}
        />
      ) : (
        <>
          {/* Search bar */}
          <div className="relative mb-6">
            <Icon.Search size={16} className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-500 pointer-events-none" />
            <input
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder="Search songs, artists, albums…"
              className="input !pl-10 !pr-10"
            />
            {searching && (
              <button className="absolute right-3 top-1/2 -translate-y-1/2 icon-btn" onClick={() => setQuery('')} title="Clear">
                <Icon.Close size={16} />
              </button>
            )}
          </div>

          {searching ? (
            /* ---- Unified search results ---- */
            <div className="space-y-8">
              {filteredArtists.length > 0 && (
                <div>
                  <h2 className="section-title mb-3">Artists</h2>
                  <div className="grid grid-cols-3 sm:grid-cols-4 lg:grid-cols-6 gap-4">
                    {filteredArtists.slice(0, 12).map(a => <ArtistCard key={a.id} item={a} onClick={() => setOpenArtistItem(a)} />)}
                  </div>
                </div>
              )}
              {filteredAlbums.length > 0 && (
                <div>
                  <h2 className="section-title mb-3">Albums</h2>
                  <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4">
                    {filteredAlbums.slice(0, 15).map(a => <AlbumCard key={a.id} album={a} onClick={() => setOpenAlbum(a)} />)}
                  </div>
                </div>
              )}
              {filteredSongs.length > 0 && (
                <div>
                  <h2 className="section-title mb-3">Songs</h2>
                  <div className="card p-2 sm:p-3 space-y-0.5">
                    {filteredSongs.slice(0, 60).map((s, i) => (
                      <SongRow
                        key={s.id}
                        song={s}
                        index={i}
                        showArt
                        onPlay={() => playSong(s, filteredSongs.slice(0, 60))}
                        isCurrent={player.current?.id === s.id}
                        isPlaying={player.playing}
                        isFav={favIds.has(s.id)}
                        onToggleFav={() => toggleFav(s)}
                      />
                    ))}
                  </div>
                </div>
              )}
              {!filteredArtists.length && !filteredAlbums.length && !filteredSongs.length && (
                <EmptyState icon={<Icon.Search size={26} />} title="No matches" subtitle={`Nothing found for “${query}”.`} />
              )}
            </div>
          ) : (
            <>
              {/* Jump back in */}
              {resume.length > 0 && (
                <div className="mb-8">
                  <h2 className="section-title mb-3">Jump back in</h2>
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                    {resume.slice(0, 6).map(s => {
                      const isCur = player.current?.id === s.id;
                      return (
                        <button
                          key={s.id}
                          onClick={() => playSong(s, resume)}
                          className={cx('group flex items-center gap-3 rounded-2xl overflow-hidden pr-3 text-left transition-colors card', isCur ? '!bg-brand-500/10' : 'card-hover')}
                        >
                          <div className="w-14 h-14 shrink-0 overflow-hidden">
                            <CoverArt src={s.posterUrl || s.thumbUrl} title={s.album || s.name} textClass="text-lg" iconSize={18} />
                          </div>
                          <div className="min-w-0 flex-1">
                            <p className={cx('text-sm font-semibold truncate', isCur ? 'text-brand-300' : 'text-white')}>{s.name}</p>
                            <p className="text-xs muted truncate">{s.albumArtist || s.album}</p>
                          </div>
                          {isCur && player.playing ? <EqBars /> : <Icon.Play size={18} className="text-slate-500 group-hover:text-white shrink-0" />}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Made for you — shuffle-based mixes */}
              {mixes.length > 0 && (
                <div className="mb-8">
                  <div className="flex items-center gap-2 mb-3">
                    <h2 className="section-title">Made for you</h2>
                    <Icon.Sparkles size={15} className="text-brand-400" />
                  </div>
                  <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3 sm:gap-4">
                    {mixes.map(m => (
                      <MixCard
                        key={m.name}
                        name={m.name}
                        art={m.art}
                        count={m.tracks.length}
                        isPlaying={player.playing && player.current?.subtitle === m.name}
                        onPlay={() => playMix(m.name, m.tracks)}
                      />
                    ))}
                  </div>
                </div>
              )}

              {/* Recently added rail — only when the server gives us a real
                  "date added" ordering. Without it the fallback rail was just the
                  album list, duplicating the "Albums" tab grid directly below. */}
              {hasRealRecent && recentlyAdded.length > 0 && (
                <div className="mb-8">
                  <h2 className="section-title mb-3">Recently added</h2>
                  <div className="flex gap-4 overflow-x-auto pb-2 -mx-1 px-1 snap-x">
                    {recentlyAdded.map(a => (
                      <div key={a.id} className="snap-start shrink-0 w-32 sm:w-40">
                        <AlbumCard album={a} onClick={() => setOpenAlbum(a)} />
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Tabs */}
              <div className="flex items-center gap-2 mb-5 overflow-x-auto pb-1 -mx-1 px-1">
                <TabButton active={tab === 'albums'} onClick={() => setTab('albums')} icon={<Icon.Grid size={16} />} label="Albums" />
                <TabButton active={tab === 'artists'} onClick={() => setTab('artists')} icon={<Icon.Music size={16} />} label="Artists" />
                <TabButton active={tab === 'songs'} onClick={() => setTab('songs')} icon={<Icon.List size={16} />} label="Songs" />
                <TabButton active={tab === 'playlists'} onClick={() => setTab('playlists')} icon={<Icon.Heart size={16} filled={tab === 'playlists'} />} label="Liked" />
              </div>

              {/* Albums */}
              {tab === 'albums' && (
                albums.length === 0 ? (
                  <EmptyState icon={<Icon.Grid size={26} />} title="No albums" subtitle="Albums in your library will show here." />
                ) : (
                  <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4">
                    {albums.map(a => <AlbumCard key={a.id} album={a} onClick={() => setOpenAlbum(a)} />)}
                  </div>
                )
              )}

              {/* Artists */}
              {tab === 'artists' && (
                artists.length === 0 ? (
                  <EmptyState icon={<Icon.Music size={26} />} title="No artists" subtitle="Artists in your library will show here." />
                ) : (
                  <div className="grid grid-cols-3 sm:grid-cols-4 lg:grid-cols-6 gap-4">
                    {artists.map(a => <ArtistCard key={a.id} item={a} onClick={() => setOpenArtistItem(a)} />)}
                  </div>
                )
              )}

              {/* Songs */}
              {tab === 'songs' && (
                <div className="card p-2 sm:p-3">
                  {songs.length === 0 ? (
                    <EmptyState icon={<Icon.List size={24} />} title="No songs" subtitle="Songs in your library will show here." />
                  ) : (
                    <div className="space-y-0.5">
                      {songs.map((s, i) => (
                        <SongRow
                          key={s.id}
                          song={s}
                          index={i}
                          showArt
                          onPlay={() => playSong(s, songs)}
                          isCurrent={player.current?.id === s.id}
                          isPlaying={player.playing}
                          isFav={favIds.has(s.id)}
                          onToggleFav={() => toggleFav(s)}
                        />
                      ))}
                    </div>
                  )}
                </div>
              )}

              {/* Liked / Playlists */}
              {tab === 'playlists' && (
                <div>
                  <div className="card p-5 sm:p-6 mb-5 flex flex-col sm:flex-row items-center text-center sm:text-left gap-5 bg-gradient-to-br from-accent-pink/15 via-brand-500/10 to-transparent">
                    <div className="w-24 h-24 rounded-2xl grid place-items-center bg-gradient-to-br from-accent-pink to-brand-600 shadow-float shrink-0">
                      <Icon.Heart size={40} filled className="text-white" />
                    </div>
                    <div className="min-w-0">
                      <p className="text-xs uppercase tracking-wider muted">Playlist</p>
                      <h2 className="text-2xl font-bold text-white">Liked Songs</h2>
                      <p className="text-sm muted mt-1">{user?.displayName || 'You'} · {plural(likedSongs.length, 'song')}</p>
                      {likedSongs.length > 0 && (
                        <div className="flex items-center gap-2 mt-3 justify-center sm:justify-start">
                          <button
                            className="btn-primary"
                            onClick={() => player.playQueue(likedSongs.map(s => toTrack(s, s.posterUrl || s.thumbUrl)), 0)}
                          >
                            <Icon.Play size={16} /> Play
                          </button>
                          <button
                            className="btn-secondary"
                            onClick={() => player.playQueue(shuffled(likedSongs).map(s => toTrack(s, s.posterUrl || s.thumbUrl)), 0)}
                          >
                            <Icon.Shuffle size={16} /> Shuffle
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                  {likedSongs.length === 0 ? (
                    <EmptyState icon={<Icon.Heart size={26} />} title="No liked songs yet" subtitle="Tap the heart on any song to save it here." />
                  ) : (
                    <div className="card p-2 sm:p-3 space-y-0.5">
                      {likedSongs.map((s, i) => (
                        <SongRow
                          key={s.id}
                          song={s}
                          index={i}
                          showArt
                          onPlay={() => player.playQueue(likedSongs.map(t => toTrack(t, t.posterUrl || t.thumbUrl)), i)}
                          isCurrent={player.current?.id === s.id}
                          isPlaying={player.playing}
                          isFav={favIds.has(s.id)}
                          onToggleFav={() => toggleFav(s)}
                        />
                      ))}
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </>
      )}

      {openAlbum && (
        <AlbumModal
          album={openAlbum}
          onClose={() => setOpenAlbum(null)}
          favIds={favIds}
          onToggleFav={toggleFav}
        />
      )}

      {openArtistItem && (
        <ArtistModal
          artist={openArtistItem}
          albums={albums}
          songs={songs}
          favIds={favIds}
          onToggleFav={toggleFav}
          onOpenAlbum={(a) => { setOpenArtistItem(null); setOpenAlbum(a); }}
          onClose={() => setOpenArtistItem(null)}
        />
      )}

      {showQueue && <QueueModal onClose={() => setShowQueue(false)} />}
    </div>
  );
}
