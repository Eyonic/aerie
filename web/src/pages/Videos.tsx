import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../lib/api';
import { Icon } from '../lib/icons';
import { toast, useAuth, usePlayer } from '../lib/store';
import { cx, formatBytes, formatRelative, formatDuration } from '../lib/utils';
import { PageLoader, EmptyState, PageHeader, Badge, Spinner } from '../components/ui';
import { VideoPlayer } from '../components/media';
import type { MediaItem, FileEntry } from '../lib/model';
import { imageSrcSet } from '../lib/images';
import {
  loadDriveVideoResume,
  saveDriveVideoResume,
  type DriveVideoResumeInfo as ResumeInfo,
  type DriveVideoResumeMap as ResumeMap,
} from '../lib/drive-video-resume';
import { applyPlaybackRate, playbackRateLabel, stepPlaybackRate, VIDEO_PLAYBACK_RATES } from '../lib/playback-rate';
import {
  popupNavigationIndex,
  popupTabNavigationIndex,
  usePlayerDialog,
  usePopupFocusReturn,
  type PopupNavigationKey,
} from '../lib/player-dialog';
import { loadVideoVolume, saveVideoVolume, type VideoVolumePreference } from '../lib/video-volume';

// ------------------------------------------------------------------
// Unified "personal video" — sourced from the user's Drive (Files) and,
// defensively, from any Jellyfin "home videos" library.
// ------------------------------------------------------------------
type Vid = {
  key: string;
  name: string;          // cleaned display name (no extension)
  folder: string;        // parent path, used for grouping
  folderName: string;    // display label for the folder
  thumbUrl?: string;
  streamUrl: string;
  downloadUrl?: string;
  size?: number;
  modifiedAt?: string;
  durationSec?: number;  // from the listing, so the badge shows before playback
  source: 'files' | 'media';
  path?: string;         // files: raw path
  mediaItem?: MediaItem; // media: for the HLS player
};

const VIDEO_EXT = /\.(mp4|mov|m4v|webm|mkv|avi|wmv|flv|mpg|mpeg|3gp|ogv|ts)$/i;
function cleanName(filename: string): string {
  return filename.replace(VIDEO_EXT, '').replace(/[_.]+/g, ' ').trim() || filename;
}
function folderLabel(path: string): string {
  if (!path || path === '/') return 'Home';
  const seg = path.split('/').filter(Boolean).pop();
  return seg || 'Home';
}

// Recursively scan the Drive for video files.
async function scanDriveVideos(): Promise<FileEntry[]> {
  const found: FileEntry[] = [];
  const seen = new Set<string>();
  async function walk(path: string, depth: number): Promise<void> {
    if (depth > 6 || seen.has(path)) return;
    seen.add(path);
    let listing;
    try { listing = await api.files.list(path); } catch { return; }
    const subdirs: string[] = [];
    for (const e of listing.entries) {
      if (e.isFolder) subdirs.push(e.path);
      else if (e.kind === 'video' || e.mime?.startsWith('video/') || VIDEO_EXT.test(e.name)) found.push(e);
    }
    // Bounded fan-out — the tree is small, but stay safe.
    for (const d of subdirs) await walk(d, depth + 1);
  }
  await walk('/', 0);
  return found;
}

// ------------------------------------------------------------------
// Thumbnail with graceful fallback to a distinctive per-item placeholder
// (deterministic gradient + initial) so tiles aren't an identical grey icon.
// ------------------------------------------------------------------
const PLACEHOLDER_GRADS = [
  'from-brand-500/40 to-brand-700/20',
  'from-accent-cyan/40 to-sky-700/20',
  'from-accent-amber/40 to-orange-700/20',
  'from-fuchsia-500/40 to-purple-700/20',
  'from-emerald-500/40 to-teal-700/20',
  'from-rose-500/40 to-pink-700/20',
];
function hashStr(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}
function ThumbPlaceholder({ name }: { name: string }) {
  const grad = PLACEHOLDER_GRADS[hashStr(name) % PLACEHOLDER_GRADS.length];
  // A framed "video" placeholder (film-strip perforations + play glyph) reads as a
  // clip far better than a bare letter tile.
  return (
    <div className={cx('w-full h-full grid place-items-center bg-gradient-to-br relative overflow-hidden', grad)}>
      <div className="absolute inset-y-0 left-0 w-2.5 flex flex-col justify-around py-1.5 opacity-40">
        {Array.from({ length: 5 }).map((_, i) => <span key={i} className="mx-auto w-1 h-1 rounded-[1px] bg-black/70" />)}
      </div>
      <div className="absolute inset-y-0 right-0 w-2.5 flex flex-col justify-around py-1.5 opacity-40">
        {Array.from({ length: 5 }).map((_, i) => <span key={i} className="mx-auto w-1 h-1 rounded-[1px] bg-black/70" />)}
      </div>
      <div className="w-11 h-11 rounded-full bg-white/15 backdrop-blur-sm ring-1 ring-white/25 grid place-items-center shadow-card">
        <Icon.Play size={18} className="text-white/90 translate-x-[1px]" />
      </div>
    </div>
  );
}
function Thumb({ src, name }: { src?: string; name: string }) {
  const [failed, setFailed] = useState(false);
  if (!src || failed) return <ThumbPlaceholder name={name} />;
  return (
    <img src={src} srcSet={imageSrcSet(src, [320, 640])} sizes="(max-width: 640px) 50vw, 320px" alt={name} loading="lazy" decoding="async" onError={() => setFailed(true)}
      className="w-full h-full object-cover" />
  );
}

// ------------------------------------------------------------------
// Duration probe for Drive videos.
// The Files listing carries no duration (media-library items already do, via
// runtime), so a clip's length would otherwise only appear once it's been
// played. We read it up-front from the file header with a detached <video
// preload="metadata">, which fetches only the moov atom — not the whole file.
// Results are cached module-wide (survives sort/filter re-renders) and a small
// concurrency cap keeps a large grid from opening dozens of connections at once.
// ------------------------------------------------------------------
const durCache = new Map<string, number>();
const durListeners = new Set<(url: string, val: number) => void>();
const durQueue: string[] = [];
const durInFlight = new Set<string>();
let durActive = 0;
function pumpDurations() {
  while (durActive < 3 && durQueue.length) {
    const url = durQueue.shift()!;
    if (durCache.has(url) || durInFlight.has(url)) continue;
    durInFlight.add(url);
    durActive++;
    const el = document.createElement('video');
    el.preload = 'metadata';
    el.muted = true;
    const finish = (val?: number) => {
      durActive--;
      durInFlight.delete(url);
      el.removeAttribute('src');
      try { el.load(); } catch { /* noop */ }
      if (val && isFinite(val) && val > 0) {
        durCache.set(url, val);
        durListeners.forEach(fn => fn(url, val));
      }
      pumpDurations();
    };
    el.onloadedmetadata = () => finish(el.duration);
    el.onerror = () => finish();
    el.src = url;
  }
}
function requestDuration(url: string) {
  if (durCache.has(url) || durInFlight.has(url) || durQueue.includes(url)) return;
  durQueue.push(url);
  pumpDurations();
}
function useProbedDuration(v: Vid): number | undefined {
  const probeable = !v.durationSec && v.source === 'files' && !!v.streamUrl;
  const [dur, setDur] = useState<number | undefined>(() =>
    probeable ? durCache.get(v.streamUrl) : undefined);
  useEffect(() => {
    if (!probeable) return;
    const cached = durCache.get(v.streamUrl);
    if (cached) { setDur(cached); return; }
    const fn = (url: string, val: number) => { if (url === v.streamUrl) setDur(val); };
    durListeners.add(fn);
    requestDuration(v.streamUrl);
    return () => { durListeners.delete(fn); };
  }, [probeable, v.streamUrl]);
  return v.durationSec ?? dur;
}

// ------------------------------------------------------------------
// Video card
// ------------------------------------------------------------------
function VideoCard({ v, resume, onPlay }: { v: Vid; resume?: ResumeInfo; onPlay: () => void }) {
  const probed = useProbedDuration(v);
  const pct = resume && resume.dur > 0
    ? Math.min(100, (resume.pos / resume.dur) * 100)
    : (v.mediaItem?.progressPct || 0);
  const dur = resume?.dur || probed;
  const meta = [v.folderName, v.size ? formatBytes(v.size) : '', v.modifiedAt ? formatRelative(v.modifiedAt) : '']
    .filter(Boolean).join(' · ');
  return (
    <button onClick={onPlay} className="group text-left w-full">
      <div className="relative rounded-xl overflow-hidden bg-ink-800 shadow-card card-hover aspect-video">
        <Thumb src={v.thumbUrl} name={v.name} />
        <div className="absolute inset-0 bg-gradient-to-t from-black/70 via-transparent to-transparent opacity-0 group-hover:opacity-100 transition-opacity" />
        <div className="absolute inset-0 grid place-items-center opacity-0 group-hover:opacity-100 transition-opacity">
          <div className="w-12 h-12 rounded-full bg-white/90 text-ink-900 grid place-items-center shadow-float scale-90 group-hover:scale-100 transition-transform">
            <Icon.Play size={22} />
          </div>
        </div>
        {dur ? (
          <div className="absolute bottom-1.5 right-1.5 chip !py-0.5 !px-2 text-[10px] bg-black/60 text-white">
            {formatDuration(dur)}
          </div>
        ) : null}
        {pct > 1 && pct < 99 && (
          <div className="absolute bottom-0 inset-x-0 h-1 bg-black/40">
            <div className="h-full bg-brand-500" style={{ width: `${pct}%` }} />
          </div>
        )}
      </div>
      <p className="text-sm font-medium text-white truncate mt-2">{v.name}</p>
      <p className="text-xs muted truncate">{meta}</p>
    </button>
  );
}

// ------------------------------------------------------------------
// Fullscreen player for Drive videos (files are direct MP4/WebM, no HLS).
// It deliberately uses the same single custom transport as library playback;
// browser-native controls must not create a second, competing bar.
// ------------------------------------------------------------------
const DriveSvg = ({ children }: { children: React.ReactNode }) => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round">{children}</svg>
);
const DriveExpandIcon = () => <DriveSvg><path d="M8 3H5a2 2 0 0 0-2 2v3M16 3h3a2 2 0 0 1 2 2v3M16 21h3a2 2 0 0 0 2-2v-3M8 21H5a2 2 0 0 1-2-2v-3" /></DriveSvg>;
const DriveShrinkIcon = () => <DriveSvg><path d="M3 8h3a2 2 0 0 0 2-2V3M21 8h-3a2 2 0 0 1-2-2V3M21 16h-3a2 2 0 0 0-2 2v3M3 16h3a2 2 0 0 1 2 2v3" /></DriveSvg>;
const DriveMutedIcon = () => <DriveSvg><path d="M11 5 6 9H3v6h3l5 4zM16 9l5 6M21 9l-5 6" /></DriveSvg>;
const DrivePipIcon = () => <DriveSvg><path d="M3 8V6a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-6" /><rect x="3" y="11.5" width="9" height="7" rx="1.5" /></DriveSvg>;
const DriveAirplayIcon = () => <DriveSvg><path d="M5 17H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-1M12 14l5 7H7z" /></DriveSvg>;

function handleDrivePlayerMenuKeyDown(event: React.KeyboardEvent<HTMLElement>, onClose: () => void) {
  if (event.key === 'Escape') {
    event.preventDefault();
    event.stopPropagation();
    onClose();
    return;
  }
  const items = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button:not([disabled]), a[href]'));
  if (event.key === 'Tab') {
    const nextIndex = popupTabNavigationIndex(
      items.findIndex(item => item === document.activeElement), items.length, event.shiftKey,
    );
    if (nextIndex < 0) return;
    event.preventDefault(); event.stopPropagation(); items[nextIndex].focus();
    return;
  }
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
  const nextIndex = popupNavigationIndex(
    event.key as PopupNavigationKey,
    items.findIndex(item => item === document.activeElement),
    items.length,
  );
  if (nextIndex < 0) return;
  event.preventDefault(); event.stopPropagation(); items[nextIndex].focus();
}

function DriveVideoPlayer({ v, startAt, onSaveProgress, onClose }: {
  v: Vid; startAt: number; onSaveProgress: (pos: number, dur: number) => void; onClose: () => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const ref = useRef<HTMLVideoElement>(null);
  const accountId = useAuth(state => state.user?.id ?? null);
  usePlayerDialog(containerRef);
  useEffect(() => {
    if (usePlayer.getState().playing) usePlayer.getState().setPlaying(false);
  }, []);
  const [loading, setLoading] = useState(true);
  const [buffering, setBuffering] = useState(false);
  const [error, setError] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [bufferedEnd, setBufferedEnd] = useState(0);
  const initialVideoVolumeRef = useRef<VideoVolumePreference | null>(null);
  if (!initialVideoVolumeRef.current) initialVideoVolumeRef.current = loadVideoVolume(accountId);
  const [volume, setVolume] = useState(initialVideoVolumeRef.current.volume);
  const [muted, setMuted] = useState(initialVideoVolumeRef.current.muted);
  const [playbackRate, setPlaybackRate] = useState(1);
  const [controlsShown, setControlsShown] = useState(true);
  const [controlsFocused, setControlsFocused] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [canPip, setCanPip] = useState(false);
  const [canAirplay, setCanAirplay] = useState(false);
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [speedOpen, setSpeedOpen] = useState(false);
  const optionsMenuRef = useRef<HTMLDivElement>(null);
  const speedMenuRef = useRef<HTMLDivElement>(null);
  usePopupFocusReturn(optionsOpen, optionsMenuRef);
  usePopupFocusReturn(speedOpen, speedMenuRef);
  const lastSave = useRef(0);
  const currentRef = useRef(0);
  const retryAt = useRef(startAt);
  const controlsTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const save = useCallback(() => {
    const el = ref.current;
    if (el && el.currentTime > 0 && el.duration && isFinite(el.duration)) {
      onSaveProgress(el.currentTime, el.duration);
    }
  }, [onSaveProgress]);

  const pokeControls = useCallback(() => {
    setControlsShown(true);
    if (controlsTimer.current) clearTimeout(controlsTimer.current);
    if (ref.current && !ref.current.paused) controlsTimer.current = setTimeout(() => setControlsShown(false), 3000);
  }, []);
  const togglePlay = useCallback(() => {
    const el = ref.current; if (!el) return;
    if (el.paused) el.play().catch(() => {}); else el.pause();
  }, []);
  const toggleFullscreen = useCallback(() => {
    const el = containerRef.current; if (!el) return;
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else if (el.requestFullscreen) el.requestFullscreen().catch(() => {});
    else {
      const video = ref.current as any;
      try { if (video?.webkitDisplayingFullscreen) video.webkitExitFullscreen?.(); else video?.webkitEnterFullscreen?.(); } catch { /* unsupported */ }
    }
  }, []);
  const togglePip = async () => {
    const el = ref.current as any; if (!el) return;
    try { if (document.pictureInPictureElement) await document.exitPictureInPicture(); else await el.requestPictureInPicture(); } catch { /* unsupported at runtime */ }
  };
  const airplay = () => (ref.current as any)?.webkitShowPlaybackTargetPicker?.();
  const choosePlaybackRate = useCallback((rate: number) => {
    const el = ref.current;
    if (!el || !applyPlaybackRate(el, rate)) return;
    try { (el as any).preservesPitch = true; } catch { /* unsupported */ }
    setPlaybackRate(rate);
    setSpeedOpen(false);
  }, []);
  const retry = () => {
    const el = ref.current; if (!el) return;
    retryAt.current = currentRef.current || startAt;
    setError(false); setLoading(true); setBuffering(false);
    el.load();
  };

  useEffect(() => {
    const el = ref.current; if (!el) return;
    const savedVolume = loadVideoVolume(accountId);
    el.volume = savedVolume.volume;
    el.muted = savedVolume.muted;
    setVolume(savedVolume.volume);
    setMuted(savedVolume.muted);
    const onMeta = () => {
      setLoading(false); setBuffering(false); setError(false); setDuration(isFinite(el.duration) ? el.duration : 0);
      const resumeAt = retryAt.current;
      if (resumeAt > 0 && resumeAt < el.duration - 5) { try { el.currentTime = resumeAt; } catch { /* noop */ } }
      el.play().catch(() => {});
    };
    const onTime = () => {
      currentRef.current = el.currentTime || 0;
      setCurrentTime(currentRef.current);
      if (!el.paused) setBuffering(false);
      const now = Date.now();
      if (now - lastSave.current > 5000) { lastSave.current = now; save(); }
    };
    const onProgress = () => {
      let end = 0;
      for (let i = 0; i < el.buffered.length; i++) end = Math.max(end, el.buffered.end(i));
      setBufferedEnd(end);
    };
    const onPlay = () => { setPlaying(true); setBuffering(false); };
    const onPause = () => { setPlaying(false); setBuffering(false); };
    const onVolume = () => {
      setVolume(el.volume); setMuted(el.muted);
      saveVideoVolume(accountId, { volume: el.volume, muted: el.muted });
    };
    const onRate = () => setPlaybackRate(el.playbackRate || 1);
    const onErr = () => { retryAt.current = currentRef.current || startAt; setError(true); setLoading(false); setBuffering(false); };
    const onWait = () => setBuffering(true);
    const onReady = () => setBuffering(false);
    const onFs = () => setIsFullscreen(!!document.fullscreenElement);
    const onWebkitFs = () => setIsFullscreen(!!(el as any).webkitDisplayingFullscreen);
    const onAirplay = (event: any) => setCanAirplay(event.availability === 'available');
    el.addEventListener('loadedmetadata', onMeta);
    el.addEventListener('timeupdate', onTime);
    el.addEventListener('progress', onProgress);
    el.addEventListener('play', onPlay);
    el.addEventListener('pause', onPause);
    el.addEventListener('volumechange', onVolume);
    el.addEventListener('ratechange', onRate);
    el.addEventListener('error', onErr);
    el.addEventListener('waiting', onWait);
    el.addEventListener('stalled', onWait);
    el.addEventListener('playing', onReady);
    el.addEventListener('canplay', onReady);
    el.addEventListener('seeked', onReady);
    document.addEventListener('fullscreenchange', onFs);
    el.addEventListener('webkitbeginfullscreen', onWebkitFs);
    el.addEventListener('webkitendfullscreen', onWebkitFs);
    setCanPip(!!document.pictureInPictureEnabled && typeof (el as any).requestPictureInPicture === 'function');
    if ((window as any).WebKitPlaybackTargetAvailabilityEvent && typeof (el as any).webkitShowPlaybackTargetPicker === 'function') {
      el.addEventListener('webkitplaybacktargetavailabilitychanged', onAirplay);
    }
    return () => {
      save();
      el.removeEventListener('loadedmetadata', onMeta);
      el.removeEventListener('timeupdate', onTime);
      el.removeEventListener('progress', onProgress);
      el.removeEventListener('play', onPlay);
      el.removeEventListener('pause', onPause);
      el.removeEventListener('volumechange', onVolume);
      el.removeEventListener('ratechange', onRate);
      el.removeEventListener('error', onErr);
      el.removeEventListener('waiting', onWait);
      el.removeEventListener('stalled', onWait);
      el.removeEventListener('playing', onReady);
      el.removeEventListener('canplay', onReady);
      el.removeEventListener('seeked', onReady);
      document.removeEventListener('fullscreenchange', onFs);
      el.removeEventListener('webkitbeginfullscreen', onWebkitFs);
      el.removeEventListener('webkitendfullscreen', onWebkitFs);
      el.removeEventListener('webkitplaybacktargetavailabilitychanged', onAirplay);
      if (controlsTimer.current) clearTimeout(controlsTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [v.key, accountId]);

  useEffect(() => {
    if (controlsTimer.current) clearTimeout(controlsTimer.current);
    if (playing) controlsTimer.current = setTimeout(() => setControlsShown(false), 3000);
    else setControlsShown(true);
    return () => { if (controlsTimer.current) clearTimeout(controlsTimer.current); };
  }, [playing, v.key]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target;
      const el = ref.current;
      const key = event.key.toLowerCase();
      if (event.key === 'Escape') {
        if (optionsOpen || speedOpen) { event.preventDefault(); setOptionsOpen(false); setSpeedOpen(false); }
        else if (!document.fullscreenElement) onClose();
        return;
      }
      if (target instanceof HTMLElement && target.matches('input, textarea, select, button, [contenteditable="true"]')) return;
      if (optionsOpen || speedOpen) return;
      if (key === ' ' || key === 'k') { event.preventDefault(); togglePlay(); }
      else if ((event.key === 'ArrowLeft' || event.key === 'ArrowRight' || key === 'j' || key === 'l') && el) {
        event.preventDefault();
        const delta = event.key === 'ArrowLeft' ? -5 : event.key === 'ArrowRight' ? 5 : key === 'j' ? -10 : 10;
        el.currentTime = Math.max(0, Math.min(el.duration || Number.MAX_SAFE_INTEGER, el.currentTime + delta));
      } else if (key === 'm' && el) { event.preventDefault(); el.muted = !el.muted; }
      else if ((event.key === '[' || event.key === ']') && el) {
        event.preventDefault(); choosePlaybackRate(stepPlaybackRate(el.playbackRate || 1, event.key === '[' ? -1 : 1));
      }
      else if (key === 'f') { event.preventDefault(); toggleFullscreen(); }
      else return;
      pokeControls();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [choosePlaybackRate, onClose, optionsOpen, speedOpen, pokeControls, toggleFullscreen, togglePlay]);

  const controlsVisible = controlsShown || !playing || controlsFocused || error || optionsOpen || speedOpen;
  const playedPct = duration ? Math.max(0, Math.min(100, (currentTime / duration) * 100)) : 0;
  const bufferedPct = duration ? Math.max(playedPct, Math.min(100, (bufferedEnd / duration) * 100)) : 0;

  return createPortal((
    <div ref={containerRef} className="fixed inset-0 z-[300] bg-black flex flex-col animate-fade-in"
      role="dialog" aria-modal="true" aria-label={`Video player: ${v.name}`} tabIndex={-1}
      onPointerMove={pokeControls} onPointerDown={pokeControls}
      onFocusCapture={event => {
        const target = event.target;
        if (target instanceof HTMLElement && target !== containerRef.current && !target.matches('video')) setControlsFocused(true);
        pokeControls();
      }}
      onBlurCapture={event => {
        const next = event.relatedTarget;
        const focusedControl = next instanceof HTMLElement && containerRef.current?.contains(next)
          && next !== containerRef.current && !next.matches('video');
        setControlsFocused(!!focusedControl);
        pokeControls();
      }}>
      <div className={cx('absolute top-0 inset-x-0 z-10 p-3 pt-[max(0.75rem,env(safe-area-inset-top))] flex items-center gap-2 bg-gradient-to-b from-black/90 via-black/55 to-transparent transition-opacity duration-300',
        controlsVisible ? 'opacity-100' : 'opacity-0 pointer-events-none')}>
        <button className="w-11 h-11 grid place-items-center rounded-full text-white hover:bg-white/15 active:bg-white/25 shrink-0" onClick={onClose} aria-label="Close player">
          <Icon.ChevronLeft size={24} />
        </button>
        <div className="min-w-0 flex-1">
          <p className="text-white font-semibold truncate">{v.name}</p>
          <p className="text-xs text-slate-400 truncate">{v.folderName}{v.size ? ` · ${formatBytes(v.size)}` : ''}</p>
        </div>
        <div className="hidden sm:flex items-center gap-1 shrink-0">
          <button type="button" onClick={() => { setOptionsOpen(false); setSpeedOpen(open => !open); }}
            className={cx('w-11 h-11 grid place-items-center rounded-full text-[11px] font-bold hover:bg-white/15 active:bg-white/25', playbackRate !== 1 ? 'text-brand-300' : 'text-white')}
            aria-label={`Playback speed ${playbackRateLabel(playbackRate)}`} aria-haspopup="menu" aria-expanded={speedOpen}
            title="Playback speed ([ or ])">{playbackRateLabel(playbackRate)}</button>
          {v.downloadUrl && <a href={v.downloadUrl} className="w-11 h-11 grid place-items-center rounded-full text-white hover:bg-white/15 active:bg-white/25" aria-label="Download video" title="Download video"><Icon.Download size={20} /></a>}
          {canAirplay && <button type="button" onClick={airplay} aria-label="AirPlay" title="AirPlay" className="w-11 h-11 grid place-items-center rounded-full text-white hover:bg-white/15 active:bg-white/25"><DriveAirplayIcon /></button>}
          {canPip && <button type="button" onClick={togglePip} aria-label="Picture in picture" title="Picture in picture" className="w-11 h-11 grid place-items-center rounded-full text-white hover:bg-white/15 active:bg-white/25"><DrivePipIcon /></button>}
        </div>
        <button type="button" onClick={() => { setSpeedOpen(false); setOptionsOpen(open => !open); }}
          className="sm:hidden w-11 h-11 grid place-items-center rounded-full text-white hover:bg-white/15 active:bg-white/25 shrink-0"
          aria-label="More playback options" aria-haspopup="menu" aria-expanded={optionsOpen} title="More playback options"><Icon.More size={22} /></button>
        {optionsOpen && <>
          <div className="fixed inset-0 z-[310]" aria-hidden="true" onClick={() => setOptionsOpen(false)} />
          <div ref={optionsMenuRef} role="menu" aria-label="Playback options" tabIndex={-1}
            onKeyDown={event => handleDrivePlayerMenuKeyDown(event, () => setOptionsOpen(false))}
            className="absolute right-2 top-[max(3.75rem,calc(env(safe-area-inset-top)+3.25rem))] z-[320] w-64 max-w-[86vw] glass-strong rounded-xl shadow-float overflow-hidden animate-fade-in sm:hidden">
            <p className="px-3 py-2 text-[11px] uppercase tracking-wide text-slate-400 border-b border-white/10">Playback options</p>
            <button type="button" role="menuitem" onClick={() => { setOptionsOpen(false); setSpeedOpen(true); }} className="w-full min-h-11 px-3 py-2.5 text-sm flex items-center gap-3 text-white hover:bg-white/10">
              <span className="w-6 text-center text-[11px] font-bold tabular-nums">{playbackRateLabel(playbackRate)}</span> Playback speed
            </button>
            {v.downloadUrl && <a href={v.downloadUrl} role="menuitem" onClick={() => setOptionsOpen(false)} className="w-full min-h-11 px-3 py-2.5 text-sm flex items-center gap-3 text-white hover:bg-white/10"><Icon.Download size={20} /> Download video</a>}
            {canAirplay && <button type="button" role="menuitem" onClick={() => { setOptionsOpen(false); airplay(); }} className="w-full min-h-11 px-3 py-2.5 text-sm flex items-center gap-3 text-white hover:bg-white/10"><DriveAirplayIcon /> AirPlay</button>}
            {canPip && <button type="button" role="menuitem" onClick={() => { setOptionsOpen(false); togglePip(); }} className="w-full min-h-11 px-3 py-2.5 text-sm flex items-center gap-3 text-white hover:bg-white/10"><DrivePipIcon /> Picture in picture</button>}
          </div>
        </>}
        {speedOpen && <>
          <div className="fixed inset-0 z-[310]" aria-hidden="true" onClick={() => setSpeedOpen(false)} />
          <div ref={speedMenuRef} role="menu" aria-label="Playback speed" tabIndex={-1}
            onKeyDown={event => handleDrivePlayerMenuKeyDown(event, () => setSpeedOpen(false))}
            className="absolute right-2 top-[max(3.75rem,calc(env(safe-area-inset-top)+3.25rem))] z-[320] w-56 max-w-[86vw] glass-strong rounded-xl shadow-float overflow-hidden animate-fade-in">
            <p className="px-3 py-2 text-[11px] uppercase tracking-wide text-slate-400 border-b border-white/10">Playback speed</p>
            {VIDEO_PLAYBACK_RATES.map(rate => <button key={rate} type="button" role="menuitemradio" aria-checked={rate === playbackRate}
              onClick={() => choosePlaybackRate(rate)} className={cx('w-full min-h-11 px-3 py-2.5 text-sm flex items-center gap-3 text-left hover:bg-white/10', rate === playbackRate ? 'text-brand-300' : 'text-white')}>
              <span className="w-5 grid place-items-center">{rate === playbackRate && <Icon.Check size={16} />}</span>
              {playbackRateLabel(rate)}{rate === 1 ? ' · Normal' : ''}
            </button>)}
          </div>
        </>}
      </div>
      {(loading || buffering) && !error && <div className="absolute inset-0 z-[7] grid place-items-center text-white pointer-events-none" role="status" aria-live="polite">
        <div className="rounded-2xl bg-black/55 backdrop-blur-sm px-4 py-3 flex items-center gap-3 shadow-float">
          <Spinner size={loading ? 36 : 26} /><span className="text-sm font-medium">{loading ? 'Loading video…' : 'Buffering…'}</span>
        </div>
      </div>}
      {error && (
        <div className="absolute inset-0 z-[9] grid place-items-center text-center p-6 bg-black/60">
          <div className="max-w-md rounded-2xl bg-ink-900/90 border border-white/10 p-5 shadow-float">
            <p className="text-white font-semibold">Playback stopped</p>
            <p className="text-sm text-slate-300 mt-1">This video could not be played in the browser.</p>
            <div className="flex items-center justify-center gap-2 mt-4 flex-wrap">
              <button type="button" className="btn-primary !min-h-11" onClick={retry}>Try again</button>
              {v.downloadUrl && <a href={v.downloadUrl} className="btn-secondary !min-h-11 inline-flex items-center gap-2"><Icon.Download size={16} /> Download</a>}
              <button type="button" className="btn-secondary !min-h-11" onClick={onClose}>Close</button>
            </div>
          </div>
        </div>
      )}
      <video ref={ref} controls={false} autoPlay playsInline className="w-full h-full object-contain bg-black"
        src={v.streamUrl} poster={v.thumbUrl} aria-label={`Playing ${v.name}`}
        onClick={() => { pokeControls(); togglePlay(); }} onDoubleClick={toggleFullscreen} />
      {!error && (
        <div className={cx('absolute inset-x-0 bottom-0 z-[8] px-3 sm:px-5 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-12 bg-gradient-to-t from-black/95 via-black/70 to-transparent transition-opacity duration-300',
          controlsVisible ? 'opacity-100' : 'opacity-0 pointer-events-none')} role="group" aria-label="Playback controls">
          <div className="relative h-8 flex items-center">
            <span aria-hidden="true" className="absolute inset-x-0 top-1/2 h-1.5 -translate-y-1/2 rounded-full"
              style={{ background: `linear-gradient(to right, rgb(99 102 241) 0% ${playedPct}%, rgba(255,255,255,.38) ${playedPct}% ${bufferedPct}%, rgba(255,255,255,.18) ${bufferedPct}% 100%)` }} />
            <input type="range" min={0} max={duration || 1} step={0.1} value={Math.min(currentTime, duration || Number.MAX_SAFE_INTEGER)} disabled={!duration}
              aria-label="Seek through video" aria-valuetext={`${formatDuration(currentTime)} of ${formatDuration(duration)}`}
              onInput={event => { const el = ref.current; if (el) el.currentTime = +(event.target as HTMLInputElement).value; }}
              className="aerie-video-seek absolute inset-x-0 top-1/2 z-[1] w-full -translate-y-1/2 disabled:cursor-default" />
          </div>
          <div className="flex items-center gap-1 sm:gap-2 min-w-0">
            <button type="button" onClick={togglePlay} aria-label={playing ? 'Pause (Space or K)' : 'Play (Space or K)'} title={playing ? 'Pause (Space or K)' : 'Play (Space or K)'}
              className="w-11 h-11 grid place-items-center rounded-full text-white hover:bg-white/15 active:bg-white/25 shrink-0">
              {playing ? <Icon.Pause size={22} /> : <Icon.Play size={22} />}
            </button>
            <button type="button" onClick={() => { const el = ref.current; if (el) el.currentTime = Math.max(0, el.currentTime - 10); }} aria-label="Back 10 seconds" title="Back 10 seconds (J)"
              className="hidden sm:grid w-10 h-10 place-items-center rounded-full text-xs font-semibold text-white hover:bg-white/15 active:bg-white/25 shrink-0">−10</button>
            <button type="button" onClick={() => { const el = ref.current; if (el) el.currentTime = Math.min(el.duration || Number.MAX_SAFE_INTEGER, el.currentTime + 10); }} aria-label="Forward 10 seconds" title="Forward 10 seconds (L)"
              className="hidden sm:grid w-10 h-10 place-items-center rounded-full text-xs font-semibold text-white hover:bg-white/15 active:bg-white/25 shrink-0">+10</button>
            <span className="text-[11px] sm:text-xs text-slate-200 tabular-nums whitespace-nowrap shrink-0">
              {formatDuration(currentTime)}{duration > 0 && <span className="hidden min-[360px]:inline"> / {formatDuration(duration)}</span>}
            </span>
            <span className="flex-1 min-w-0" />
            <button type="button" onClick={() => { const el = ref.current; if (el) el.muted = !el.muted; }} aria-label={muted ? 'Unmute (M)' : 'Mute (M)'} title={muted ? 'Unmute (M)' : 'Mute (M)'}
              className="w-11 h-11 grid place-items-center rounded-full text-white hover:bg-white/15 active:bg-white/25 shrink-0">
              {muted || volume === 0 ? <DriveMutedIcon /> : <Icon.Volume size={20} />}
            </button>
            <input type="range" min={0} max={1} step={0.05} value={muted ? 0 : volume} aria-label="Volume"
              onInput={event => { const el = ref.current; if (el) { el.muted = false; el.volume = +(event.target as HTMLInputElement).value; } }}
              className="w-24 accent-brand-500 hidden md:block" />
            <button type="button" onClick={toggleFullscreen} aria-label={isFullscreen ? 'Exit fullscreen (F)' : 'Fullscreen (F)'} title={isFullscreen ? 'Exit fullscreen (F)' : 'Fullscreen (F)'}
              className="w-11 h-11 grid place-items-center rounded-full text-white hover:bg-white/15 active:bg-white/25 shrink-0">
              {isFullscreen ? <DriveShrinkIcon /> : <DriveExpandIcon />}
            </button>
          </div>
        </div>
      )}
    </div>
  ), document.body);
}

type SortKey = 'recent' | 'name' | 'size';

export default function Videos() {
  const accountId = useAuth(state => state.user?.id ?? null);
  const [loading, setLoading] = useState(true);
  const [videoState, setVideoState] = useState<{ accountId: number | null; items: Vid[] }>({ accountId: null, items: [] });
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<SortKey>('recent');
  const [folder, setFolder] = useState<string>('all');
  const [resumeState, setResumeState] = useState<{ accountId: number | null; items: ResumeMap }>(() => ({
    accountId,
    items: accountId ? loadDriveVideoResume(accountId) : {},
  }));
  const [playingState, setPlayingState] = useState<{ accountId: number; video: Vid } | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadPct, setUploadPct] = useState(0);
  const fileInput = useRef<HTMLInputElement>(null);
  const loadToken = useRef(0);
  // Never render a previous member's in-memory list/history/player during the
  // render before account-change effects run.
  const vids = videoState.accountId === accountId ? videoState.items : [];
  const resume = resumeState.accountId === accountId ? resumeState.items : {};
  const playing = playingState?.accountId === accountId ? playingState.video : null;

  const load = useCallback(async () => {
    const requestedAccount = accountId;
    const token = ++loadToken.current;
    if (!requestedAccount) {
      setVideoState({ accountId: null, items: [] });
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const [driveFiles, mediaVids] = await Promise.all([
        scanDriveVideos().catch(() => [] as FileEntry[]),
        api.media.videos().catch(() => [] as MediaItem[]),
      ]);
      const list: Vid[] = [];
      for (const f of driveFiles) {
        list.push({
          key: `f:${f.path}`,
          name: cleanName(f.name),
          folder: f.parent || '/',
          folderName: folderLabel(f.parent || '/'),
          thumbUrl: api.files.videoThumbUrl(f.path),
          streamUrl: api.files.rawUrl(f.path),
          downloadUrl: api.files.rawUrl(f.path, true),
          size: f.size,
          modifiedAt: f.modifiedAt,
          source: 'files',
          path: f.path,
        });
      }
      for (const m of Array.isArray(mediaVids) ? mediaVids : []) {
        list.push({
          key: `m:${m.id}`,
          name: m.name,
          folder: '__library__',
          folderName: 'Media library',
          thumbUrl: m.thumbUrl || m.posterUrl || m.backdropUrl,
          streamUrl: api.media.streamUrl(m.id),
          size: undefined,
          durationSec: m.runtimeMinutes ? m.runtimeMinutes * 60
            : (m.runtimeTicks ? m.runtimeTicks / 1e7 : undefined),
          source: 'media',
          mediaItem: m,
        });
      }
      if (loadToken.current === token) setVideoState({ accountId: requestedAccount, items: list });
    } catch (e: any) {
      if (loadToken.current === token) {
        toast('Could not load videos', 'error', e?.message);
        setVideoState({ accountId: requestedAccount, items: [] });
      }
    } finally {
      if (loadToken.current === token) setLoading(false);
    }
  }, [accountId]);

  useEffect(() => {
    setPlayingState(null);
    setResumeState({ accountId, items: accountId ? loadDriveVideoResume(accountId) : {} });
    void load();
    return () => { loadToken.current++; };
  }, [accountId, load]);

  const saveProgress = useCallback((key: string, pos: number, dur: number) => {
    const immutableAccountId = accountId;
    if (!immutableAccountId) return;
    setResumeState(previous => {
      // A late media cleanup from an account that just signed out must not
      // replace the newly active member's state.
      if (previous.accountId !== immutableAccountId) return previous;
      const next = { ...previous.items };
      if (dur > 0 && pos >= dur - 12) {
        // finished — clear from continue-watching
        delete next[key];
      } else {
        next[key] = { pos, dur, at: Date.now() };
      }
      return { accountId: immutableAccountId, items: saveDriveVideoResume(immutableAccountId, next) };
    });
  }, [accountId]);

  const folders = useMemo(() => {
    const map = new Map<string, number>();
    for (const v of vids) map.set(v.folder, (map.get(v.folder) || 0) + 1);
    return Array.from(map.entries())
      .map(([path, count]) => ({ path, label: vids.find(v => v.folder === path)!.folderName, count }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [vids]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    let out = vids.filter(v =>
      (folder === 'all' || v.folder === folder) &&
      (!q || v.name.toLowerCase().includes(q) || v.folderName.toLowerCase().includes(q))
    );
    out = [...out].sort((a, b) => {
      if (sort === 'name') return a.name.localeCompare(b.name);
      if (sort === 'size') return (b.size || 0) - (a.size || 0);
      return (b.modifiedAt ? Date.parse(b.modifiedAt) : 0) - (a.modifiedAt ? Date.parse(a.modifiedAt) : 0);
    });
    return out;
  }, [vids, query, folder, sort]);

  const continueWatching = useMemo(() => {
    const byKey = new Map<string, Vid>(vids.map(v => [v.key, v] as [string, Vid]));
    return (Object.entries(resume) as [string, ResumeInfo][])
      .filter(([k, r]) => byKey.has(k) && r.dur > 0 && r.pos > 5 && r.pos < r.dur * 0.95)
      .sort((a, b) => b[1].at - a[1].at)
      .map(([k]) => byKey.get(k)!)
      .slice(0, 12);
  }, [vids, resume]);

  const totalSize = useMemo(() => vids.reduce((s, v) => s + (v.size || 0), 0), [vids]);

  async function handleUpload(files: FileList | null) {
    if (!files || !files.length) return;
    const arr = Array.from(files).filter(f => f.type.startsWith('video/') || VIDEO_EXT.test(f.name));
    if (!arr.length) { toast('No video files selected', 'error'); return; }
    setUploading(true); setUploadPct(0);
    try {
      await api.files.mkdir('/', 'Videos').catch(() => {}); // ensure folder (ignore if exists)
      await api.files.upload('/Videos', arr, undefined, p => setUploadPct(p));
      toast(`Uploaded ${arr.length} video${arr.length > 1 ? 's' : ''}`, 'success');
      await load();
    } catch (e: any) {
      toast('Upload failed', 'error', e?.message);
    } finally {
      setUploading(false); setUploadPct(0);
      if (fileInput.current) fileInput.current.value = '';
    }
  }

  function play(v: Vid) { if (accountId) setPlayingState({ accountId, video: v }); }

  function closePlayer() {
    setPlayingState(null);
    // Pull fresh media resume state (progressPct) in case a media item advanced.
    if (playing?.source === 'media') load();
  }

  if (loading || !accountId || videoState.accountId !== accountId) return <PageLoader />;

  const empty = vids.length === 0;
  // Folder sections are a browsing convenience for the default (chronological)
  // view. The moment the user picks an explicit ordering (Name/Size) we collapse
  // to a single flat, globally-sorted grid so the sort visibly reorders the page
  // instead of only reshuffling within each fixed-order folder section.
  const showSections = folder === 'all' && !query.trim() && folders.length > 1 && sort === 'recent';

  const uploadBtn = (
    <>
      <input ref={fileInput} type="file" accept="video/*" multiple className="hidden"
        onChange={e => handleUpload(e.target.files)} />
      <button className="btn-secondary inline-flex items-center gap-2 shrink-0"
        onClick={() => fileInput.current?.click()} disabled={uploading}>
        {uploading ? <Spinner size={16} /> : <Icon.Upload size={16} />}
        <span>{uploading ? `Uploading ${uploadPct}%` : 'Upload'}</span>
      </button>
    </>
  );

  return (
    <div className="animate-fade-in">
      <PageHeader
        title="Videos"
        subtitle="Your personal home videos, clips, and recordings"
        icon={<Icon.Video size={22} />}
        actions={
          <div className="flex items-center gap-2 w-full sm:w-auto">
            {!empty && (
              <div className="relative flex-1 sm:flex-none sm:w-64 min-w-0">
                <Icon.Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500 pointer-events-none" />
                <input
                  className="input pl-9 pr-8 w-full"
                  placeholder="Search videos…"
                  value={query}
                  onChange={e => setQuery(e.target.value)}
                />
                {query && (
                  <button
                    onClick={() => setQuery('')}
                    className="absolute right-2 top-1/2 -translate-y-1/2 icon-btn !w-7 !h-7 text-slate-400"
                    aria-label="Clear search"
                  >
                    <Icon.Close size={14} />
                  </button>
                )}
              </div>
            )}
            {uploadBtn}
          </div>
        }
      />

      {empty ? (
        <EmptyState
          icon={<Icon.Video size={40} />}
          title="No videos yet"
          subtitle="Upload home videos, clips, or recordings from your phone and they'll appear here ready to stream."
          action={
            <button className="btn-primary inline-flex items-center gap-2" onClick={() => fileInput.current?.click()} disabled={uploading}>
              {uploading ? <Spinner size={16} /> : <Icon.Upload size={16} />}
              <span>{uploading ? `Uploading ${uploadPct}%` : 'Upload videos'}</span>
            </button>
          }
        />
      ) : (
        <>
          {/* Stats */}
          <div className="grid grid-cols-3 gap-3 sm:gap-4 mb-6">
            <div className="card p-3 sm:p-4 flex flex-col items-center text-center gap-1.5 sm:flex-row sm:text-left sm:gap-3">
              <div className="w-9 h-9 sm:w-10 sm:h-10 rounded-xl grid place-items-center bg-brand-500/15 text-brand-400 shrink-0"><Icon.Video size={20} /></div>
              <div className="min-w-0">
                <p className="text-lg sm:text-xl font-bold text-white leading-tight">{vids.length}</p>
                <p className="text-[11px] sm:text-xs muted whitespace-nowrap">Videos</p>
              </div>
            </div>
            <div className="card p-3 sm:p-4 flex flex-col items-center text-center gap-1.5 sm:flex-row sm:text-left sm:gap-3">
              <div className="w-9 h-9 sm:w-10 sm:h-10 rounded-xl grid place-items-center bg-accent-cyan/15 text-accent-cyan shrink-0"><Icon.Cloud size={20} /></div>
              <div className="min-w-0">
                <p className="text-lg sm:text-xl font-bold text-white leading-tight">{totalSize ? formatBytes(totalSize) : '—'}</p>
                <p className="text-[11px] sm:text-xs muted whitespace-nowrap">Total size</p>
              </div>
            </div>
            <div className="card p-3 sm:p-4 flex flex-col items-center text-center gap-1.5 sm:flex-row sm:text-left sm:gap-3">
              <div className="w-9 h-9 sm:w-10 sm:h-10 rounded-xl grid place-items-center bg-accent-amber/15 text-accent-amber shrink-0"><Icon.Play size={20} /></div>
              <div className="min-w-0">
                <p className="text-lg sm:text-xl font-bold text-white leading-tight">{continueWatching.length}</p>
                <p className="text-[11px] sm:text-xs muted whitespace-nowrap">In progress</p>
              </div>
            </div>
          </div>

          {/* Continue watching */}
          {continueWatching.length > 0 && (
            <div className="mb-8">
              <h2 className="section-title mb-3">Continue watching</h2>
              <div className="flex gap-4 overflow-x-auto pb-2 -mx-1 px-1 snap-x">
                {continueWatching.map(v => (
                  <div key={v.key} className="snap-start shrink-0 w-56 sm:w-64">
                    <VideoCard v={v} resume={resume[v.key] as ResumeInfo | undefined} onPlay={() => play(v)} />
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Toolbar: folder filter + sort. Stacks on mobile so the sort segment
              is never pushed off-screen by a long, scrolling row of folder chips. */}
          <div className="flex flex-col sm:flex-row sm:items-center gap-2 mb-4">
            {folders.length > 1 && (
              <div className="flex items-center gap-2 overflow-x-auto pb-1 -mx-1 px-1 sm:flex-1 min-w-0">
                <button
                  onClick={() => setFolder('all')}
                  className={cx('chip shrink-0', folder === 'all' ? '!bg-brand-500/20 !text-brand-300 !border-brand-500/40' : '')}
                >
                  All
                </button>
                {folders.map(f => (
                  <button
                    key={f.path}
                    onClick={() => setFolder(f.path)}
                    className={cx('chip shrink-0 inline-flex items-center gap-1.5', folder === f.path ? '!bg-brand-500/20 !text-brand-300 !border-brand-500/40' : '')}
                  >
                    <Icon.Folder size={13} /> {f.label}
                    <span className="opacity-60">{f.count}</span>
                  </button>
                ))}
              </div>
            )}
            <div className="flex items-center gap-1 shrink-0 self-start sm:self-auto sm:ml-auto bg-ink-850 rounded-lg p-0.5">
              {([['recent', 'Recent'], ['name', 'Name'], ['size', 'Size']] as [SortKey, string][]).map(([k, label]) => (
                <button
                  key={k}
                  onClick={() => setSort(k)}
                  className={cx('px-3 py-1.5 rounded-md text-xs font-medium transition-colors',
                    sort === k ? 'bg-ink-700 text-white' : 'text-slate-400 hover:text-white')}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          {/* Library */}
          {filtered.length === 0 ? (
            <div className="card p-10">
              <EmptyState
                icon={<Icon.Search size={36} />}
                title="No matches"
                subtitle={query ? `Nothing found for “${query}”.` : 'No videos in this folder.'}
              />
            </div>
          ) : showSections ? (
            <div className="space-y-8">
              {folders.map(f => {
                const items = filtered.filter(v => v.folder === f.path);
                if (!items.length) return null;
                return (
                  <div key={f.path}>
                    <div className="flex items-center justify-between mb-3">
                      <h2 className="section-title inline-flex items-center gap-2">
                        <Icon.Folder size={16} className="text-slate-500" /> {f.label}
                      </h2>
                      <Badge color="slate">{items.length}</Badge>
                    </div>
                    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3 sm:gap-4">
                      {items.map((v: Vid) => <div key={v.key} className="min-w-0"><VideoCard v={v} resume={resume[v.key] as ResumeInfo | undefined} onPlay={() => play(v)} /></div>)}
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <>
              <div className="flex items-center justify-between mb-3">
                <h2 className="section-title">{query ? 'Results' : 'All videos'}</h2>
                <Badge color="slate">{filtered.length}</Badge>
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3 sm:gap-4">
                {filtered.map((v: Vid) => <div key={v.key} className="min-w-0"><VideoCard v={v} resume={resume[v.key] as ResumeInfo | undefined} onPlay={() => play(v)} /></div>)}
              </div>
            </>
          )}
        </>
      )}

      {playing && playing.source === 'media' && playing.mediaItem && (
        <VideoPlayer item={playing.mediaItem} onClose={closePlayer} />
      )}
      {playing && playing.source === 'files' && (
        <DriveVideoPlayer
          v={playing}
          startAt={resume[playing.key]?.pos || 0}
          onSaveProgress={(pos, dur) => saveProgress(playing.key, pos, dur)}
          onClose={closePlayer}
        />
      )}
    </div>
  );
}
