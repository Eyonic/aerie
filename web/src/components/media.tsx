// Reusable media components: poster/cover cards, horizontal rails, and a
// fullscreen HLS video player. Shared by Movies, TV, Videos, Music.
import React, { useEffect, useRef, useState } from 'react';
import { Icon } from '../lib/icons';
import { cx, ticksToTime, formatDuration } from '../lib/utils';
import { api } from '../lib/api';
import type { MediaItem } from '../lib/model';
import { toast } from '../lib/store';
import { Spinner } from './ui';
import { VideoUpscaler, upscaleSupported } from '../lib/upscaler';
import { publicUrlSync } from '../lib/serverinfo';

// 2K GPU upscaling is desktop-only (Windows/Linux): phone GPUs and Android's
// WebView can't sustain per-frame FSR at 1440p, and macOS stays on AirPlay.
const UPSCALE_PLATFORM = typeof navigator !== 'undefined'
  && /Windows NT|Linux/.test(navigator.userAgent)
  && !/Android|Mobile/.test(navigator.userAgent);

export function PosterCard({ item, onClick, aspect = 'portrait' }: { item: MediaItem; onClick?: () => void; aspect?: 'portrait' | 'landscape' | 'square' }) {
  const ar = aspect === 'portrait' ? 'aspect-[2/3]' : aspect === 'landscape' ? 'aspect-video' : 'aspect-square';
  const img = item.posterUrl || item.thumbUrl || item.backdropUrl;
  return (
    <button onClick={onClick} className="group text-left w-full">
      <div className={cx('relative rounded-xl overflow-hidden bg-ink-800 shadow-card card-hover', ar)}>
        {img ? <img src={img} loading="lazy" className="w-full h-full object-cover" /> :
          <div className="w-full h-full grid place-items-center text-slate-600"><Icon.Movie size={30} /></div>}
        <div className="absolute inset-0 bg-gradient-to-t from-black/70 via-transparent to-transparent opacity-0 group-hover:opacity-100 transition-opacity" />
        <div className="absolute inset-0 grid place-items-center opacity-0 group-hover:opacity-100 transition-opacity">
          <div className="w-12 h-12 rounded-full bg-white/90 text-ink-900 grid place-items-center shadow-float scale-90 group-hover:scale-100 transition-transform">
            <Icon.Play size={22} />
          </div>
        </div>
        {typeof item.progressPct === 'number' && item.progressPct > 0 && item.progressPct < 99 && (
          <div className="absolute bottom-0 inset-x-0 h-1 bg-black/40"><div className="h-full bg-brand-500" style={{ width: `${item.progressPct}%` }} /></div>
        )}
        {item.communityRating && <div className="absolute top-2 right-2 chip !py-0.5 !px-2 text-[10px] bg-black/50">★ {item.communityRating.toFixed(1)}</div>}
      </div>
      <p className="text-sm font-medium text-white truncate mt-2">{item.name}</p>
      <p className="text-xs muted truncate">{item.year || item.seriesName || (item.runtimeMinutes ? `${item.runtimeMinutes} min` : '')}</p>
    </button>
  );
}

export function Rail({ title, items, onOpen, aspect }: { title: string; items: MediaItem[]; onOpen: (i: MediaItem) => void; aspect?: 'portrait' | 'landscape' | 'square' }) {
  if (!items.length) return null;
  return (
    <div className="mb-8">
      <h2 className="section-title mb-3">{title}</h2>
      <div className="flex gap-4 overflow-x-auto pb-2 -mx-1 px-1 snap-x">
        {items.map(it => (
          <div key={it.id} className={cx('snap-start shrink-0', aspect === 'landscape' ? 'w-64' : 'w-36')}>
            <PosterCard item={it} onClick={() => onOpen(it)} aspect={aspect} />
          </div>
        ))}
      </div>
    </div>
  );
}

// Inline, CSP-safe stroke icons for the cast/AirPlay/PiP/fullscreen controls
// (kept local so we don't depend on icons the shared set doesn't ship).
const Svg = ({ children, size = 22 }: { children: React.ReactNode; size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round">{children}</svg>
);
const CastIcon = () => <Svg><path d="M4 8V7a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2h-6" /><path d="M4 12a8 8 0 0 1 8 8" /><path d="M4 16a4 4 0 0 1 4 4" /><path d="M4 20h.01" /></Svg>;
const AirplayIcon = () => <Svg><path d="M5 17H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-1" /><path d="m12 14 5 7H7z" /></Svg>;
const PipIcon = () => <Svg><path d="M3 8V6a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-6" /><rect x="3" y="11.5" width="9" height="7" rx="1.5" /></Svg>;
const ExpandIcon = () => <Svg><path d="M8 3H5a2 2 0 0 0-2 2v3" /><path d="M16 3h3a2 2 0 0 1 2 2v3" /><path d="M16 21h3a2 2 0 0 0 2-2v-3" /><path d="M8 21H5a2 2 0 0 1-2-2v-3" /></Svg>;
const ShrinkIcon = () => <Svg><path d="M3 8h3a2 2 0 0 0 2-2V3" /><path d="M21 8h-3a2 2 0 0 1-2-2V3" /><path d="M21 16h-3a2 2 0 0 0-2 2v3" /><path d="M3 16h3a2 2 0 0 1 2 2v3" /></Svg>;
const CcIcon = () => <Svg><rect x="3" y="5" width="18" height="14" rx="2.5" /><path d="M10 10.5a2.2 2.2 0 1 0 0 3" /><path d="M17 10.5a2.2 2.2 0 1 0 0 3" /></Svg>;
const TwoKIcon = () => <Svg><rect x="2.5" y="5" width="19" height="14" rx="2.5" /><text x="12" y="15.5" textAnchor="middle" fontSize="8" fontWeight="700" fill="currentColor" stroke="none">2K</text></Svg>;
const MutedIcon = () => <Svg size={20}><path d="M11 5 6 9H3v6h3l5 4z" /><path d="m16 9 5 6" /><path d="m21 9-5 6" /></Svg>;
const AudioTrackIcon = () => <Svg><path d="M3 10v4" /><path d="M7.5 6v12" /><path d="M12 3v18" /><path d="M16.5 6v12" /><path d="M21 10v4" /></Svg>;

// Dropdown used by the CC / audio-track pickers in the player top bar. Anchored
// under the top control cluster; a full-screen scrim closes it on outside tap.
function TrackMenu({ open, onClose, heading, options, current, onPick }: {
  open: boolean; onClose: () => void; heading: string;
  options: { key: string; label: string; value: number | null }[];
  current: number | null; onPick: (v: number | null) => void;
}) {
  if (!open) return null;
  return (
    <>
      <div className="fixed inset-0 z-[310]" onClick={onClose} />
      <div className="absolute right-2 top-[max(3.75rem,calc(env(safe-area-inset-top)+3.25rem))] z-[320] w-60 max-w-[72vw] glass-strong rounded-xl shadow-float overflow-hidden animate-fade-in">
        <p className="px-3 py-2 text-[11px] uppercase tracking-wide text-slate-400 border-b border-white/10">{heading}</p>
        <div className="max-h-[52vh] overflow-y-auto py-1">
          {options.map(o => (
            <button key={o.key} type="button" onClick={() => onPick(o.value)}
              className={cx('w-full text-left px-3 py-2.5 text-sm flex items-center gap-2 hover:bg-white/10 active:bg-white/15',
                o.value === current ? 'text-brand-400' : 'text-white')}>
              <span className="w-4 shrink-0 grid place-items-center">{o.value === current && <Icon.Check size={16} />}</span>
              <span className="truncate">{o.label}</span>
            </button>
          ))}
        </div>
      </div>
    </>
  );
}

// Big-tap-target control button used in the player top bar. `dim` renders an
// inert-looking (but still tappable) state so blocked features can explain why.
function CtrlBtn({ onClick, title, active, dim, children }: { onClick: () => void; title: string; active?: boolean; dim?: boolean; children: React.ReactNode }) {
  return (
    <button type="button" onClick={onClick} title={title} aria-label={title}
      className={cx('w-11 h-11 grid place-items-center rounded-full transition-colors shrink-0',
        active ? 'bg-brand-500 text-white shadow-glow'
          : dim ? 'text-slate-500 hover:bg-white/10 active:bg-white/15'
          : 'text-white hover:bg-white/15 active:bg-white/25')}>
      {children}
    </button>
  );
}

// Fullscreen player for movies/episodes/videos (HLS via proxy)
export function VideoPlayer({ item, audio = false, onClose }: { item: MediaItem; audio?: boolean; onClose: () => void }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const hlsRef = useRef<any>(null);
  const loadToken = useRef(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [canRemote, setCanRemote] = useState(false);   // a Cast/DLNA device is available (Remote Playback API)
  const [remoteBlocked, setRemoteBlocked] = useState(false); // Remote Playback exists in theory but needs HTTPS
  const [canAirplay, setCanAirplay] = useState(false); // Safari AirPlay
  const [canPip, setCanPip] = useState(false);
  const [casting, setCasting] = useState(false);
  const [isFs, setIsFs] = useState(false);

  // Server-side Google Cast (works everywhere, incl. the Android app's WebView,
  // where the Remote Playback API never fires).
  const [castDevices, setCastDevices] = useState<{ ip: string; name: string }[]>([]);
  const [castOpen, setCastOpen] = useState(false);
  const [tvCast, setTvCast] = useState<{ ip: string; name: string } | null>(null);
  const [tvState, setTvState] = useState<{ active: boolean; playerState?: string; idleReason?: string; currentTime?: number; duration?: number } | null>(null);
  const [tvCanSeek, setTvCanSeek] = useState(true);
  const tvGone = useRef(0);
  // Transcoded casts start the TV timeline at 0 (resume happens server-side);
  // `tvOffset` maps TV time back to real movie time for display + progress.
  const tvOffset = useRef(0);
  const tvCastRef = useRef<typeof tvCast>(null);
  tvCastRef.current = tvCast;

  // Subtitle + audio tracks (from Jellyfin via our proxy)
  const [audioTracks, setAudioTracks] = useState<any[]>([]);
  const [subTracks, setSubTracks] = useState<any[]>([]);
  const [audioIdx, setAudioIdx] = useState<number | null>(null);
  const [subIdx, setSubIdx] = useState<number | null>(null); // null = Off
  const [ccOpen, setCcOpen] = useState(false);
  const [audioOpen, setAudioOpen] = useState(false);
  // Refs so the (re)load path can re-apply the chosen subtitle after an audio swap
  const subIdxRef = useRef<number | null>(null);
  const subTracksRef = useRef<any[]>([]);
  subTracksRef.current = subTracks;

  // ---- 2K GPU upscaling (desktop Windows/Linux only) ----
  // The <video> keeps decoding as usual but turns invisible; each frame is
  // re-rendered through FSR (EASU+RCAS) shaders onto a 2560×1440 canvas by the
  // viewer's own GPU. Native controls are hidden with the video, so a slim
  // custom control bar + subtitle overlay take over while it's on.
  const upscaleOk = !audio && UPSCALE_PLATFORM && upscaleSupported();
  const [upscale, setUpscale] = useState(() => {
    try { return upscaleOk && localStorage.getItem('cb_upscale2k') === '1'; } catch { return false; }
  });
  const upscaleRef = useRef(upscale);
  upscaleRef.current = upscale;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [upRes, setUpRes] = useState<{ sw: number; sh: number; dw: number; dh: number } | null>(null);
  const [cueText, setCueText] = useState('');
  const [playing, setPlaying] = useState(true);
  const [curTime, setCurTime] = useState(0);
  const [dur, setDur] = useState(0);
  const [vol, setVol] = useState(1);
  const [muted, setMuted] = useState(false);
  const [ctrlShow, setCtrlShow] = useState(true);
  const ctrlTimer = useRef<any>(null);

  const toggleUpscale = () => {
    const next = !upscale;
    setUpscale(next);
    try { localStorage.setItem('cb_upscale2k', next ? '1' : '0'); } catch { /* */ }
    if (next) toast('2K upscaling on', 'success', 'Your GPU now upscales this video to 1440p.');
  };
  const togglePlay = () => {
    const v = videoRef.current; if (!v) return;
    if (v.paused) v.play().catch(() => {}); else v.pause();
  };
  const pokeCtrls = () => {
    if (!upscaleRef.current) return;
    setCtrlShow(true);
    clearTimeout(ctrlTimer.current);
    ctrlTimer.current = setTimeout(() => setCtrlShow(false), 3000);
  };
  useEffect(() => () => clearTimeout(ctrlTimer.current), []);

  // Collect the active subtitle cues for the custom overlay (native cues are
  // painted on the hidden <video>, so in upscale mode we draw them ourselves).
  const readCues = () => {
    const v = videoRef.current; if (!v) return;
    let txt = '';
    for (let i = 0; i < v.textTracks.length; i++) {
      const t = v.textTracks[i];
      if (t.mode === 'disabled' || !t.activeCues) continue;
      for (let c = 0; c < t.activeCues.length; c++) {
        txt += String((t.activeCues[c] as any).text || '').replace(/<[^>]*>/g, '') + '\n';
      }
    }
    setCueText(txt.trim());
  };

  // Create/destroy the WebGL upscaler with the toggle.
  useEffect(() => {
    if (!upscale) return;
    const v = videoRef.current, c = canvasRef.current;
    if (!v || !c) return;
    let u: VideoUpscaler;
    try {
      u = new VideoUpscaler(v, c);
    } catch (e: any) {
      setUpscale(false);
      toast('GPU upscaling unavailable', 'error', String(e?.message || 'WebGL2 init failed'));
      return;
    }
    u.onError = m => { setUpscale(false); toast('GPU upscaling stopped', 'error', m); };
    u.onResize = (sw, sh, dw, dh) => setUpRes({ sw, sh, dw, dh });
    u.start();
    return () => { setUpRes(null); u.destroy(); };
  }, [upscale]);

  // Mirror playback state for the custom controls shown in upscale mode.
  useEffect(() => {
    const v = videoRef.current; if (!v || !upscale) return;
    const tu = () => setCurTime(v.currentTime || 0);
    const du = () => { if (isFinite(v.duration) && v.duration > 0) setDur(v.duration); };
    const pp = () => setPlaying(!v.paused);
    const vo = () => { setVol(v.volume); setMuted(v.muted); };
    tu(); du(); pp(); vo();
    v.addEventListener('timeupdate', tu);
    v.addEventListener('durationchange', du);
    v.addEventListener('play', pp);
    v.addEventListener('pause', pp);
    v.addEventListener('volumechange', vo);
    return () => {
      v.removeEventListener('timeupdate', tu);
      v.removeEventListener('durationchange', du);
      v.removeEventListener('play', pp);
      v.removeEventListener('pause', pp);
      v.removeEventListener('volumechange', vo);
    };
  }, [upscale, item.id]);

  // Flip subtitle rendering between native ('showing') and overlay ('hidden').
  useEffect(() => {
    const v = videoRef.current; if (!v) return;
    for (let i = 0; i < v.textTracks.length; i++) {
      const t = v.textTracks[i];
      if (t.mode !== 'disabled') t.mode = upscale ? 'hidden' : 'showing';
    }
    if (upscale) readCues(); else setCueText('');
  }, [upscale]);

  // Render the chosen VTT by adding a <track> to the <video>. Called after every
  // (re)load so the subtitle survives audio-track switches that reload the source.
  const applySubtitle = () => {
    const v = videoRef.current; if (!v) return;
    v.querySelectorAll('track').forEach(t => t.remove());
    for (let i = 0; i < v.textTracks.length; i++) v.textTracks[i].mode = 'disabled';
    const sub = subTracksRef.current.find(s => s.index === subIdxRef.current);
    if (!sub || !sub.url) return;
    const el = document.createElement('track');
    el.kind = 'subtitles';
    el.src = api.media.subtitleUrl(sub.url);
    el.label = sub.name || sub.lang || 'Subtitles';
    if (sub.lang) el.srclang = sub.lang;
    el.default = true;
    v.appendChild(el);
    // In upscale mode the video (and its native cue painting) is invisible, so
    // the track runs 'hidden' and cue changes feed the custom overlay instead.
    const show = () => { try { if (el.track) el.track.mode = upscaleRef.current ? 'hidden' : 'showing'; } catch {} };
    el.addEventListener('load', show);
    show();
    try { el.track.oncuechange = readCues; } catch { /* */ }
  };

  // (Re)load the HLS/native source, optionally for a specific audio stream index,
  // resuming from `startAt` seconds. hls.js is lazy-loaded so it never bloats boot.
  const loadStream = async (audioStream?: number | null, startAt = 0) => {
    const v = videoRef.current; if (!v) return;
    const token = ++loadToken.current;
    try { hlsRef.current?.destroy(); } catch {}
    hlsRef.current = null;
    setError(null); setLoading(true);
    let src = api.media.streamUrl(item.id, audio);
    if (audioStream != null) src += (src.includes('?') ? '&' : '?') + `audioStream=${audioStream}`;
    const start = () => {
      if (token !== loadToken.current) return;
      if (startAt > 0) { try { v.currentTime = startAt; } catch {} }
      setLoading(false); applySubtitle();
      // A video restored paused by a network handoff stays paused.
      if ((item as any)._resumePaused) { (item as any)._resumePaused = false; return; }
      v.play().catch(() => {});
    };
    const canNative = v.canPlayType('application/vnd.apple.mpegurl');
    if (canNative) {
      // Tell the server this is a native HLS engine (Safari) so it drops
      // BreakOnNonKeyFrames, which native players can stall on.
      v.src = src + (src.includes('?') ? '&' : '?') + 'native=1';
      v.addEventListener('loadedmetadata', start, { once: true });
      return;
    }
    const { default: Hls } = await import('hls.js');
    if (token !== loadToken.current) return;
    if (Hls.isSupported()) {
      const hls = new Hls({ maxBufferLength: 30 });
      hlsRef.current = hls;
      hls.loadSource(src);
      hls.attachMedia(v);
      hls.on(Hls.Events.MANIFEST_PARSED, start);
      hls.on(Hls.Events.ERROR, (_e: any, data: any) => { if (data.fatal) { setError('Playback error — the media engine may be transcoding.'); setLoading(false); } });
    } else {
      v.src = src; v.addEventListener('loadedmetadata', start, { once: true });
    }
  };

  useEffect(() => {
    const v = videoRef.current; if (!v) return;
    // Resume from the saved position (Continue watching). Skip if within 15s of the
    // end (treat as finished, start over).
    const resumeSec = item.positionTicks && item.positionTicks > 0 ? item.positionTicks / 1e7 : 0;
    const runtimeSec = item.runtimeTicks ? item.runtimeTicks / 1e7 : 0;
    const startAt = (resumeSec > 5 && (!runtimeSec || resumeSec < runtimeSec - 15)) ? resumeSec : 0;
    loadStream(null, startAt);
    // Fetch selectable audio/subtitle tracks for this item (best-effort)
    api.media.streams(item.id).then(s => {
      const at = Array.isArray(s?.audio) ? s.audio : [];
      const st = Array.isArray(s?.subtitles) ? s.subtitles : [];
      setAudioTracks(at); setSubTracks(st);
      const da = at.find((a: any) => a.default);
      if (da) setAudioIdx(da.index);
    }).catch(() => {});
    // Only save a position once playback has meaningfully advanced (>5s) so we never
    // clobber a real saved position with a near-zero value before the seek lands.
    // While casting, the local video is paused/detached — its stale position must
    // not clobber the TV's progress (the cast poll reports instead).
    const report = () => { if (!tvCastRef.current && v.currentTime > 5) api.media.progress(item.id, Math.round(v.currentTime * 1e7)).catch(() => {}); };
    const rep = setInterval(report, 15000);
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && !document.fullscreenElement && onClose();
    window.addEventListener('keydown', esc);
    // Expose the live position for the native network-handoff (origin hop must
    // reopen this exact video at this exact second). Not while casting — the TV
    // plays independently of which origin the app uses.
    const onTime = () => { if (!tvCastRef.current) (window as any).__cbVideo = { itemId: item.id, pos: v.currentTime, paused: v.paused }; };
    v.addEventListener('timeupdate', onTime);
    v.addEventListener('play', onTime);
    v.addEventListener('pause', onTime);
    return () => {
      loadToken.current++; clearInterval(rep); window.removeEventListener('keydown', esc); report();
      v.removeEventListener('timeupdate', onTime);
      v.removeEventListener('play', onTime);
      v.removeEventListener('pause', onTime);
      if ((window as any).__cbVideo?.itemId === item.id) (window as any).__cbVideo = null;
      try { hlsRef.current?.destroy(); } catch {}
    };
  }, [item.id]);

  useEffect(() => {
    if (audio) return;
    const v = videoRef.current; if (!v) return;
    const beat = () => {
      if (v.paused) return;
      const kind = item.type === 'Movie' ? 'movie' : item.type === 'Episode' ? 'episode' : 'video';
      const d = v.duration && isFinite(v.duration) && v.duration > 0 ? v.duration : ((item.runtimeTicks || 0) / 1e7);
      api.history.beat({
        kind, itemId: item.id, title: item.name, subtitle: item.seriesName,
        imageUrl: item.posterUrl || item.thumbUrl,
        positionSec: v.currentTime || 0, durationSec: d || 0,
      }).catch(() => {});
    };
    const t = setInterval(beat, 20000);
    v.addEventListener('play', beat);
    return () => { clearInterval(t); v.removeEventListener('play', beat); };
  }, [audio, item.id]);

  const chooseSub = (index: number | null) => {
    subIdxRef.current = index; setSubIdx(index); setCcOpen(false); applySubtitle();
  };
  const chooseAudio = (index: number | null) => {
    setAudioIdx(index); setAudioOpen(false);
    if (index == null) return;
    const v = videoRef.current;
    loadStream(index, v?.currentTime || 0);
  };

  // Detect casting / AirPlay / PiP capabilities and track their live state
  useEffect(() => {
    const v = videoRef.current as any; if (!v) return;
    setCanPip(!!document.pictureInPictureEnabled && typeof v.requestPictureInPicture === 'function' && !audio);

    // Chrome / Remote Playback API — only expose the button when a device is
    // available. This API (and AirPlay) require a SECURE CONTEXT: over plain
    // http `video.remote` may exist but watchAvailability never resolves, so we
    // surface a disabled button that tells the user to switch to HTTPS instead.
    let watchId: number | undefined;
    const remote = v.remote;
    const secure = typeof window !== 'undefined' && window.isSecureContext;
    const onConnect = () => setCasting(true);
    const onDisconnect = () => setCasting(false);
    setCanRemote(false); setRemoteBlocked(false);
    if (remote && typeof remote.watchAvailability === 'function' && secure) {
      remote.watchAvailability((available: boolean) => setCanRemote(available))
        .then((id: number) => { watchId = id; }).catch(() => { if (!audio) setRemoteBlocked(true); });
      remote.addEventListener?.('connect', onConnect);
      remote.addEventListener?.('connecting', onConnect);
      remote.addEventListener?.('disconnect', onDisconnect);
    } else if (!audio && !secure && (remote || (window as any).chrome)) {
      // Insecure origin on a browser that would otherwise support casting.
      setRemoteBlocked(true);
    }

    // Safari / AirPlay — availability arrives via a proprietary event
    const onAirplay = (e: any) => setCanAirplay(e.availability === 'available');
    let airplayBound = false;
    if ((window as any).WebKitPlaybackTargetAvailabilityEvent && typeof v.webkitShowPlaybackTargetPicker === 'function') {
      v.addEventListener('webkitplaybacktargetavailabilitychanged', onAirplay);
      v.addEventListener('webkitcurrentplaybacktargetiswirelesschanged', () => setCasting(!!v.webkitCurrentPlaybackTargetIsWireless));
      airplayBound = true;
    }

    const onFs = () => setIsFs(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', onFs);
    return () => {
      try { if (watchId !== undefined) remote?.cancelWatchAvailability?.(watchId); } catch {}
      remote?.removeEventListener?.('connect', onConnect);
      remote?.removeEventListener?.('connecting', onConnect);
      remote?.removeEventListener?.('disconnect', onDisconnect);
      if (airplayBound) v.removeEventListener('webkitplaybacktargetavailabilitychanged', onAirplay);
      document.removeEventListener('fullscreenchange', onFs);
    };
  }, [item.id, audio]);

  const cast = () => {
    const v = videoRef.current as any;
    const p = v?.remote?.prompt?.();
    if (p && typeof p.catch === 'function') p.catch(() => {});
  };
  const castBlocked = () => toast('Casting needs HTTPS', 'info', `Open ${publicUrlSync() || 'your HTTPS address'} to cast this to your TV.`);

  // ---- Server-side casting (Google Cast via the Aerie server) ----
  useEffect(() => {
    if (audio) return;
    api.cast.devices().then(d => setCastDevices(d || [])).catch(() => {});
  }, [audio]);

  // While casting: poll the TV for state, mirror progress into Jellyfin so
  // Continue Watching stays correct, and clear the overlay when the session ends.
  useEffect(() => {
    if (!tvCast) return;
    tvGone.current = 0;
    let lastReport = 0;
    const strike = () => { if (++tvGone.current >= 3) { setTvCast(null); setTvState(null); } };
    const t = setInterval(() => {
      api.cast.status(tvCast.ip).then(s => {
        if (s?.active && s.playerState === 'IDLE') {
          // Movie ended (or the receiver dropped the media). Mark it finished
          // and close the overlay rather than showing "Playing · 0:00".
          if ((s as any).idleReason === 'FINISHED') {
            const total = (s.duration || 0) + tvOffset.current;
            if (total > 0) api.media.progress(item.id, Math.round(total * 1e7)).catch(() => {});
            toast('Finished playing on TV', 'info', item.name);
          }
          setTvCast(null); setTvState(null);
          return;
        }
        if (s?.active) {
          tvGone.current = 0;
          setTvState(s);
          if (s.currentTime && s.currentTime > 2 && Date.now() - lastReport > 15000) {
            lastReport = Date.now();
            api.media.progress(item.id, Math.round((s.currentTime + tvOffset.current) * 1e7)).catch(() => {});
          }
        } else strike();
      }).catch(strike); // unreachable TV/server counts too — never a stuck overlay
    }, 4000);
    return () => clearInterval(t);
  }, [tvCast, item.id]);

  const castToDevice = async (d: { ip: string; name: string }) => {
    setCastOpen(false);
    if (tvCast?.ip === d.ip) return; // already casting there
    const v = videoRef.current;
    const prev = tvCast;
    // Switching devices resumes from the old TV's live position, else from local.
    const pos = Math.floor((prev ? (tvState?.currentTime || 0) + tvOffset.current : v?.currentTime || 0));
    try {
      const r = await api.cast.play(d.ip, item.id, pos);
      if (prev) api.cast.control(prev.ip, 'quit').catch(() => {});
      // Fully silence the local pipeline: a pending loadStream start() or hls
      // buffer would otherwise resume audio underneath the casting overlay.
      loadToken.current++;
      try { hlsRef.current?.destroy(); } catch { /* */ }
      hlsRef.current = null;
      // Guard onTime before the next React render, then clear the handoff hint —
      // else an origin hop would resume the movie locally while the TV plays it.
      tvCastRef.current = d;
      if ((window as any).__cbVideo?.itemId === item.id) (window as any).__cbVideo = null;
      if (v) { v.pause(); v.removeAttribute('src'); v.load(); }
      setLoading(false);
      tvOffset.current = (r as any)?.offset || 0;
      setTvCanSeek((r as any)?.canSeek !== false);
      setTvState({ active: true, playerState: 'BUFFERING', currentTime: pos - ((r as any)?.offset || 0) });
      setTvCast(d);
      toast(`Casting to ${d.name}`, 'success', item.name);
    } catch (e: any) {
      toast('Cast failed', 'error', String(e?.message || 'The TV did not accept the stream.'));
    }
  };

  const stopCasting = () => {
    if (!tvCast) return;
    const resumeAt = ((tvState?.currentTime || 0) + tvOffset.current) || videoRef.current?.currentTime || 0;
    api.cast.control(tvCast.ip, 'quit').catch(() => {});
    setTvCast(null); setTvState(null);
    tvOffset.current = 0;
    loadStream(audioIdx, resumeAt);
  };

  const tvSkip = (delta: number) => {
    if (!tvCast || !tvCanSeek) return;
    const cur = tvState?.currentTime || 0;
    const max = tvState?.duration || Number.MAX_SAFE_INTEGER;
    const next = Math.max(0, Math.min(max - 2, cur + delta));
    // Optimistic: the poll is up to 4s stale; show the target immediately.
    setTvState(s => s ? { ...s, currentTime: next } : s);
    api.cast.control(tvCast.ip, 'seek', next).catch(() => {});
  };
  const airplay = () => { const v = videoRef.current as any; v?.webkitShowPlaybackTargetPicker?.(); };
  const togglePip = async () => {
    const v = videoRef.current as any; if (!v) return;
    try { if (document.pictureInPictureElement) await document.exitPictureInPicture(); else await v.requestPictureInPicture(); } catch {}
  };
  const toggleFs = () => {
    const el = containerRef.current; if (!el) return;
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else el.requestFullscreen?.().catch(() => {});
  };

  return (
    <div ref={containerRef} className="fixed inset-0 z-[300] bg-black flex flex-col animate-fade-in"
      onPointerMove={pokeCtrls} onPointerDown={pokeCtrls}>
      <div className="absolute top-0 inset-x-0 z-10 flex items-center gap-2 p-3 pt-[max(0.75rem,env(safe-area-inset-top))] bg-gradient-to-b from-black/85 to-transparent">
        <button className="w-11 h-11 grid place-items-center rounded-full text-white hover:bg-white/15 active:bg-white/25 shrink-0" onClick={onClose} aria-label="Back"><Icon.ChevronLeft size={26} /></button>
        <div className="min-w-0 flex-1">
          <p className="text-white font-semibold truncate">{item.name}</p>
          {item.seriesName && <p className="text-xs text-slate-400 truncate">{item.seriesName} · S{item.seasonNumber}E{item.episodeNumber}</p>}
          {casting && <p className="text-xs text-brand-400 truncate">Casting to TV…</p>}
        </div>
        <div className="flex items-center gap-1 shrink-0">
          {upscaleOk && (
            <CtrlBtn onClick={toggleUpscale} active={upscale}
              title={upscale ? '2K GPU upscaling on — click to turn off' : 'Upscale to 2K using your GPU'}>
              <TwoKIcon />
            </CtrlBtn>
          )}
          {!audio && subTracks.length > 0 && (
            <CtrlBtn onClick={() => { setAudioOpen(false); setCcOpen(o => !o); }} title="Subtitles" active={subIdx != null}><CcIcon /></CtrlBtn>
          )}
          {!audio && audioTracks.length > 1 && (
            <CtrlBtn onClick={() => { setCcOpen(false); setAudioOpen(o => !o); }} title="Audio track"><AudioTrackIcon /></CtrlBtn>
          )}
          {(castDevices.length > 0 || canRemote) && (
            <CtrlBtn onClick={() => { setCcOpen(false); setAudioOpen(false); setCastOpen(o => !o); }} title="Cast to TV" active={casting || !!tvCast}><CastIcon /></CtrlBtn>
          )}
          {castDevices.length === 0 && !canRemote && remoteBlocked && <CtrlBtn onClick={castBlocked} dim title={`Casting needs HTTPS — open ${publicUrlSync() || 'your HTTPS address'}`}><CastIcon /></CtrlBtn>}
          {canAirplay && <CtrlBtn onClick={airplay} title="AirPlay" active={casting}><AirplayIcon /></CtrlBtn>}
          {canPip && <CtrlBtn onClick={togglePip} title="Picture in picture"><PipIcon /></CtrlBtn>}
          <CtrlBtn onClick={toggleFs} title={isFs ? 'Exit fullscreen' : 'Fullscreen'}>{isFs ? <ShrinkIcon /> : <ExpandIcon />}</CtrlBtn>
        </div>
        <TrackMenu open={ccOpen} onClose={() => setCcOpen(false)} heading="Subtitles" current={subIdx} onPick={chooseSub}
          options={[{ key: 'off', label: 'Off', value: null }, ...subTracks.map((s, i) => ({ key: `s${s.index ?? i}`, label: s.name || s.lang || `Subtitle ${i + 1}`, value: s.index }))]} />
        <TrackMenu open={audioOpen} onClose={() => setAudioOpen(false)} heading="Audio" current={audioIdx} onPick={chooseAudio}
          options={audioTracks.map((a, i) => ({ key: `a${a.index ?? i}`, label: a.name || a.lang || `Audio ${i + 1}`, value: a.index }))} />
        {/* Cast device picker */}
        {castOpen && (
          <>
            <div className="fixed inset-0 z-[310]" onClick={() => setCastOpen(false)} />
            <div className="absolute right-2 top-[max(3.75rem,calc(env(safe-area-inset-top)+3.25rem))] z-[320] w-64 max-w-[76vw] glass-strong rounded-xl shadow-float overflow-hidden animate-fade-in">
              <p className="px-3 py-2 text-[11px] uppercase tracking-wide text-slate-400 border-b border-white/10">Cast to</p>
              <div className="max-h-[52vh] overflow-y-auto py-1">
                {castDevices.map(d => (
                  <button key={d.ip} type="button" onClick={() => castToDevice(d)}
                    className={cx('w-full text-left px-3 py-2.5 text-sm flex items-center gap-2 hover:bg-white/10 active:bg-white/15',
                      tvCast?.ip === d.ip ? 'text-brand-400' : 'text-white')}>
                    <span className="w-4 shrink-0 grid place-items-center">{tvCast?.ip === d.ip && <Icon.Check size={16} />}</span>
                    <span className="truncate">{d.name}</span>
                  </button>
                ))}
                {canRemote && (
                  <button type="button" onClick={() => { setCastOpen(false); cast(); }}
                    className="w-full text-left px-3 py-2.5 text-sm flex items-center gap-2 hover:bg-white/10 active:bg-white/15 text-white">
                    <span className="w-4 shrink-0" />
                    <span className="truncate">Browser cast dialog…</span>
                  </button>
                )}
                {castDevices.length === 0 && !canRemote && (
                  <p className="px-3 py-2.5 text-sm text-slate-400">No cast devices found.</p>
                )}
                <button type="button"
                  onClick={() => api.cast.devices(true).then(d => setCastDevices(d || [])).catch(() => {})}
                  className="w-full text-left px-3 py-2.5 text-xs text-slate-400 hover:bg-white/10 border-t border-white/10">
                  ⟳ Rescan network
                </button>
              </div>
            </div>
          </>
        )}
      </div>
      {loading && <div className="absolute inset-0 z-[3] grid place-items-center text-white"><Spinner size={40} /></div>}
      {error && <div className="absolute inset-0 z-[3] grid place-items-center text-center p-6"><div><p className="text-white mb-2">{error}</p><button className="btn-secondary" onClick={onClose}>Close</button></div></div>}
      {/* Casting overlay: the TV is playing, the local video stays paused */}
      {tvCast && (
        <div className="absolute inset-0 z-[5] grid place-items-center bg-black/85 p-6">
          <div className="text-center max-w-sm w-full">
            <div className="mx-auto w-16 h-16 rounded-2xl bg-brand-600/20 text-brand-400 grid place-items-center mb-4"><CastIcon /></div>
            <p className="text-white font-semibold text-lg truncate">Playing on {tvCast.name}</p>
            <p className="text-sm text-slate-400 mt-1 truncate">{item.name}</p>
            <p className="text-xs text-slate-500 mt-2 tabular-nums">
              {tvState?.playerState === 'PAUSED' ? 'Paused' : tvState?.playerState === 'BUFFERING' ? 'Buffering…' : 'Playing'}
              {tvState?.currentTime != null && ` · ${formatDuration(tvState.currentTime + tvOffset.current)}${tvState?.duration ? ` / ${formatDuration(tvState.duration + tvOffset.current)}` : ''}`}
            </p>
            <div className="flex items-center justify-center gap-2 mt-5 flex-wrap">
              {tvCanSeek && <button className="btn-secondary !px-3.5" onClick={() => tvSkip(-30)} title="Back 30 seconds">−30s</button>}
              <button className="btn-secondary !px-4"
                onClick={() => tvCast && api.cast.control(tvCast.ip, tvState?.playerState === 'PAUSED' ? 'play' : 'pause').catch(() => {})}>
                {tvState?.playerState === 'PAUSED' ? <><Icon.Play size={16} /> Resume</> : <><Icon.Pause size={16} /> Pause</>}
              </button>
              {tvCanSeek && <button className="btn-secondary !px-3.5" onClick={() => tvSkip(30)} title="Forward 30 seconds">+30s</button>}
            </div>
            <button className="btn-primary !px-5 mt-3" onClick={stopCasting}>
              <Icon.Play size={15} /> Play here instead
            </button>
          </div>
        </div>
      )}
      <video ref={videoRef} controls={!upscale} autoPlay playsInline
        onClick={() => { if (upscaleRef.current) { pokeCtrls(); togglePlay(); } }}
        onDoubleClick={() => { if (upscaleRef.current) toggleFs(); }}
        className={cx('w-full h-full object-contain bg-black', upscale && 'opacity-0')}
        poster={item.backdropUrl || item.posterUrl} />
      {/* 2K upscale output: FSR-rendered frames from the (invisible) video */}
      {upscale && (
        <canvas ref={canvasRef} className="absolute inset-0 z-[2] w-full h-full object-contain bg-black pointer-events-none" />
      )}
      {/* Subtitle overlay (native cues live on the hidden video) */}
      {upscale && !tvCast && cueText && (
        <div className={cx('absolute inset-x-0 z-[4] flex justify-center px-6 pointer-events-none transition-all',
          (ctrlShow || !playing) ? 'bottom-24' : 'bottom-8')}>
          <p className="text-white text-center text-lg leading-snug bg-black/60 rounded-lg px-3 py-1.5 whitespace-pre-line max-w-3xl">{cueText}</p>
        </div>
      )}
      {/* Custom controls while the canvas covers the native ones */}
      {upscale && !tvCast && !error && (
        <div className={cx('absolute inset-x-0 bottom-0 z-[4] px-4 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-12',
          'bg-gradient-to-t from-black/85 to-transparent transition-opacity duration-300',
          (ctrlShow || !playing) ? 'opacity-100' : 'opacity-0 pointer-events-none')}>
          <input type="range" min={0} max={dur || (item.runtimeTicks ? item.runtimeTicks / 1e7 : 0) || 1} step={0.1}
            value={Math.min(curTime, dur || Number.MAX_SAFE_INTEGER)} aria-label="Seek"
            onInput={e => { const v = videoRef.current; if (v) v.currentTime = +(e.target as HTMLInputElement).value; }}
            className="w-full accent-brand-500 cursor-pointer" />
          <div className="flex items-center gap-2 mt-1">
            <button type="button" onClick={togglePlay} aria-label={playing ? 'Pause' : 'Play'}
              className="w-10 h-10 grid place-items-center rounded-full text-white hover:bg-white/15 active:bg-white/25">
              {playing ? <Icon.Pause size={22} /> : <Icon.Play size={22} />}
            </button>
            <span className="text-xs text-slate-300 tabular-nums">
              {formatDuration(curTime)}
              {(dur || item.runtimeTicks) ? ` / ${formatDuration(dur || (item.runtimeTicks || 0) / 1e7)}` : ''}
            </span>
            <span className="flex-1" />
            <span className="chip !py-0.5 !px-2 text-[10px] bg-brand-600/25 text-brand-300 border border-brand-500/30">
              {upRes ? `${upRes.sw}×${upRes.sh} → ${upRes.dw}×${upRes.dh} · GPU` : '2K · GPU'}
            </span>
            <button type="button" onClick={() => { const v = videoRef.current; if (v) v.muted = !v.muted; }}
              aria-label={muted ? 'Unmute' : 'Mute'}
              className="w-10 h-10 grid place-items-center rounded-full text-white hover:bg-white/15 active:bg-white/25">
              {muted || vol === 0 ? <MutedIcon /> : <Icon.Volume size={20} />}
            </button>
            <input type="range" min={0} max={1} step={0.05} value={muted ? 0 : vol} aria-label="Volume"
              onInput={e => { const v = videoRef.current; if (v) { v.muted = false; v.volume = +(e.target as HTMLInputElement).value; } }}
              className="w-24 accent-brand-500 hidden sm:block" />
          </div>
        </div>
      )}
    </div>
  );
}
