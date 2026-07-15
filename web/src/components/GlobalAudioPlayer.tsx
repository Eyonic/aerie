// The persistent now-playing bar + <audio> engine. Mounted once in Layout so
// music/audiobooks/podcasts keep playing while the user browses.
import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { usePlayer, toast, type Track } from '../lib/store';
import { Icon } from '../lib/icons';
import { formatDuration, cx } from '../lib/utils';
import { api } from '../lib/api';

// Skip-back-15 / skip-forward-30 glyphs (audiobooks/podcasts) — the shared icon
// set ships no seek icons, so keep them local like the video player's controls.
const Skip = ({ dir, secs }: { dir: -1 | 1; secs: number }) => (
  <svg width={26} height={26} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round">
    {dir === -1
      ? <path d="M11 4 5 9l6 5" />
      : <path d="M13 4l6 5-6 5" />}
    <path d={dir === -1 ? 'M5 9h9a5 5 0 0 1 0 10h-3' : 'M19 9h-9a5 5 0 0 0 0 10h3'} />
    <text x="12" y="22.5" textAnchor="middle" fontSize="6.5" fontWeight="700" fill="currentColor" stroke="none">{secs}</text>
  </svg>
);

const CastIcon = ({ size = 20 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round">
    <path d="M4 8V7a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2h-6" />
    <path d="M4 12a8 8 0 0 1 8 8" /><path d="M4 16a4 4 0 0 1 4 4" /><path d="M4 20h.01" />
  </svg>
);

type CastDevice = { ip: string; name: string };
type CastState = { active: boolean; playerState?: string; idleReason?: string; currentTime?: number; duration?: number };

export function GlobalAudioPlayer() {
  const p = usePlayer();
  const audioRef = useRef<HTMLAudioElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [castDevices, setCastDevices] = useState<CastDevice[]>([]);
  const [castOpen, setCastOpen] = useState(false);
  const [castBusy, setCastBusy] = useState(false);
  const [tvCast, setTvCast] = useState<CastDevice | null>(null);
  const [tvState, setTvState] = useState<CastState | null>(null);
  const [tvCanSeek, setTvCanSeek] = useState(true);
  const tvOffset = useRef(0);
  const tvGone = useRef(0);

  useEffect(() => {
    const a = audioRef.current; if (!a || !p.current) return;
    // Compare resolved URLs: a.src reflects the ABSOLUTE url while streamUrl is
    // relative, so a raw comparison mismatches every run and the re-set src +
    // load() resets playback to 0:00 on every pause/resume.
    const src = new URL(p.current.streamUrl, location.origin).href;
    if (a.src !== src) { a.src = src; a.load(); }
    if (tvCast || castBusy) { a.pause(); return; }
    if (p.playing) a.play().catch(() => {}); else a.pause();
  }, [p.current, p.playing, tvCast, castBusy]);

  useEffect(() => { const a = audioRef.current; if (a) a.volume = p.volume; }, [p.volume]);

  // Save listening position for audiobooks/podcasts so "Continue listening"
  // works and playback resumes where you left off. Reports every 15s + on change.
  const resumedRef = useRef<string>('');
  useEffect(() => {
    const cur = p.current;
    if (!cur || (cur.kind !== 'audiobook' && cur.kind !== 'podcast')) return;
    const bookId = String(cur.id).split(':')[0];
    const report = () => {
      const a = audioRef.current;
      if (a && a.currentTime > 1) api.books.progress(bookId, a.currentTime, a.duration || cur.durationSec || 0).catch(() => {});
    };
    const t = setInterval(report, 15000);
    return () => { clearInterval(t); report(); };
  }, [p.current]);

  useEffect(() => {
    const cur = p.current;
    const a = audioRef.current;
    if (!cur || !a) return;
    const beat = () => {
      const st = usePlayer.getState();
      if (!st.playing || a.paused) return;
      const d = a.duration && isFinite(a.duration) && a.duration > 0 ? a.duration : (cur.durationSec || st.duration || 0);
      api.history.beat({
        kind: cur.kind === 'audiobook' || cur.kind === 'podcast' ? cur.kind : 'music',
        itemId: cur.id, title: cur.title, subtitle: cur.subtitle, imageUrl: cur.artUrl,
        positionSec: a.currentTime || st.currentTime || 0, durationSec: d,
      }).catch(() => {});
    };
    a.addEventListener('play', beat);
    const t = p.playing ? setInterval(beat, 20000) : null;
    if (p.playing) beat();
    return () => { if (t) clearInterval(t); a.removeEventListener('play', beat); };
  }, [p.current, p.playing]);

  // OS media controls (lock screen / notification badge on phones).
  useEffect(() => {
    if (!('mediaSession' in navigator) || !p.current) return;
    const abs = (u?: string) => u ? new URL(u, location.origin).href : undefined;
    const art = abs(p.current.artUrl);
    navigator.mediaSession.metadata = new MediaMetadata({
      title: p.current.title,
      artist: p.current.subtitle || '',
      album: p.current.kind === 'audiobook' ? 'Audiobook' : p.current.kind === 'podcast' ? 'Podcast' : 'Aerie',
      artwork: art ? [96, 192, 256, 384, 512].map(s => ({ src: art, sizes: `${s}x${s}`, type: 'image/jpeg' })) : [],
    });
    const a = audioRef.current;
    navigator.mediaSession.setActionHandler('play', () => { p.setPlaying(true); a?.play().catch(() => {}); });
    navigator.mediaSession.setActionHandler('pause', () => { p.setPlaying(false); a?.pause(); });
    navigator.mediaSession.setActionHandler('nexttrack', p.queue.length > 1 ? () => p.next() : null);
    navigator.mediaSession.setActionHandler('previoustrack', p.queue.length > 1 ? () => p.prev() : null);
    // Audiobooks/podcasts: skip 15s/30s instead of track change.
    const skip = p.current.kind !== 'music';
    navigator.mediaSession.setActionHandler('seekbackward', skip ? (d) => { if (a) a.currentTime = Math.max(0, a.currentTime - (d.seekOffset || 15)); } : null);
    navigator.mediaSession.setActionHandler('seekforward', skip ? (d) => { if (a) a.currentTime = Math.min(a.duration || 0, a.currentTime + (d.seekOffset || 30)); } : null);
    navigator.mediaSession.setActionHandler('seekto', (d) => { if (a && d.seekTime != null) a.currentTime = d.seekTime; });
  }, [p.current, p.queue.length]);

  // ---- Native Android app bridge (Aerie Android WebView wrapper) ----
  // A WebView never surfaces web audio to the OS, so the wrapper injects
  // window.CloudBoxNative (legacy bridge name — never rename; installed apps
  // inject it under exactly that name): we report now-playing state to it (it runs a real
  // MediaSession + notification) and it calls window.__cbMediaControl back for
  // notification / lock-screen / headset taps.
  const native = (window as any).CloudBoxNative;
  useEffect(() => {
    if (!native) return;
    (window as any).__cbMediaControl = (action: string, value?: number) => {
      const st = usePlayer.getState();
      const a = audioRef.current;
      if (action === 'play') { st.setPlaying(true); a?.play().catch(() => {}); }
      else if (action === 'pause') { st.setPlaying(false); a?.pause(); }
      else if (action === 'next') st.next();
      else if (action === 'prev') st.prev();
      else if (action === 'seek' && a && value != null && isFinite(value)) a.currentTime = value;
    };
    return () => { delete (window as any).__cbMediaControl; };
  }, []);

  // Layout unmounts this component the moment the queue is cleared, so the
  // mediaState effect never re-runs with cur=null — stop the native session on
  // unmount, and on page unload (reload/navigation kills the audio engine).
  useEffect(() => {
    if (!native?.mediaStop) return;
    const stop = () => { try { native.mediaStop(); } catch { /* */ } };
    window.addEventListener('pagehide', stop);
    return () => { window.removeEventListener('pagehide', stop); stop(); };
  }, []);

  useEffect(() => {
    if (!native?.mediaState) return;
    const cur = p.current;
    if (!cur) { try { native.mediaStop(); } catch { /* */ } return; }
    const abs = (u?: string) => u ? new URL(u, location.origin).href : '';
    const a = audioRef.current;
    // Element duration, not p.duration — the store still holds the previous
    // track's duration when the current track just changed.
    const durSec = a && isFinite(a.duration) && a.duration > 0 ? a.duration : (cur.durationSec || 0);
    try {
      native.mediaState(JSON.stringify({
        title: cur.title,
        artist: cur.subtitle || (cur.kind === 'audiobook' ? 'Audiobook' : cur.kind === 'podcast' ? 'Podcast' : 'Aerie'),
        artUrl: abs(cur.artUrl),
        playing: p.playing,
        position: Math.round((a?.currentTime || 0) * 1000),
        duration: Math.round(durSec * 1000),
        hasQueue: p.queue.length > 1,
      }));
    } catch { /* bridge call failed — native side gone */ }
  }, [p.current, p.playing, p.queue.length]);

  // Periodic position sync so the notification seek bar stays honest.
  useEffect(() => {
    if (!native?.mediaPosition || !p.playing) return;
    const t = setInterval(() => {
      const a = audioRef.current; const cur = usePlayer.getState().current;
      if (!a || !cur) return;
      const dur = a.duration && isFinite(a.duration) ? a.duration : (cur.durationSec || 0);
      try { native.mediaPosition(Math.round(a.currentTime * 1000), Math.round(dur * 1000)); } catch { /* */ }
    }, 5000);
    return () => clearInterval(t);
  }, [p.playing]);

  // Keep OS play/pause state + scrubber position in sync (the media badge).
  useEffect(() => {
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = p.playing ? 'playing' : 'paused';
  }, [p.playing]);
  useEffect(() => {
    if (!('mediaSession' in navigator) || !('setPositionState' in navigator.mediaSession)) return;
    if (p.duration && isFinite(p.duration)) {
      try { navigator.mediaSession.setPositionState({ duration: p.duration, position: Math.min(p.currentTime, p.duration), playbackRate: 1 }); } catch { /* */ }
    }
  }, [p.currentTime, p.duration]);

  // Device discovery is server-side, so it also works from the native app and
  // plain HTTP LAN sessions. Only tracks carrying trusted backend identifiers
  // expose Cast; downloaded/generated/local-file audio deliberately does not.
  useEffect(() => {
    if (!p.current?.cast) { setCastDevices([]); return; }
    api.cast.devices().then(d => setCastDevices(d || [])).catch(() => {});
  }, [p.current?.cast?.source]);

  const castPosition = () => (tvState?.currentTime || 0) + tvOffset.current;
  const castDuration = () => {
    const d = tvState?.duration || 0;
    return d > 0 ? d + tvOffset.current : (usePlayer.getState().current?.durationSec || 0);
  };

  const beginCast = async (device: CastDevice, track: Track, positionSec: number) => {
    if (!track.cast) return;
    setCastOpen(false);
    setCastBusy(true);
    const previous = tvCast;
    audioRef.current?.pause();
    usePlayer.getState().setPlaying(false);
    try {
      const result = await api.cast.playAudio(device.ip, track.cast, Math.max(0, positionSec || 0));
      if (previous && previous.ip !== device.ip) api.cast.control(previous.ip, 'quit').catch(() => {});
      tvOffset.current = result.offset || 0;
      setTvCanSeek(result.canSeek !== false);
      setTvState({ active: true, playerState: 'BUFFERING', currentTime: Math.max(0, positionSec - (result.offset || 0)), duration: track.durationSec });
      setTvCast(device);
      tvGone.current = 0;
      toast(`Casting to ${device.name}`, 'success', track.title);
    } catch (e: any) {
      if (!previous) {
        setTvCast(null); setTvState(null);
        usePlayer.getState().setPlaying(true);
      }
      toast('Cast failed', 'error', String(e?.message || 'The TV could not load this audio stream.'));
    } finally {
      setCastBusy(false);
    }
  };

  const castQueueTrack = (device: CastDevice, index: number) => {
    const st = usePlayer.getState();
    const track = st.queue[index];
    if (!track?.cast) return false;
    st.playAt(index);
    void beginCast(device, track, 0);
    return true;
  };

  const nextTrack = () => {
    if (!tvCast) { p.next(); return; }
    const st = usePlayer.getState();
    let next = st.shuffle ? Math.floor(Math.random() * st.queue.length) : st.index + 1;
    if (next >= st.queue.length) next = st.repeat === 'all' ? 0 : -1;
    if (next >= 0 && castQueueTrack(tvCast, next)) return;
    api.cast.control(tvCast.ip, 'quit').catch(() => {});
    setTvCast(null); setTvState(null);
  };

  const previousTrack = () => {
    if (!tvCast) { p.prev(); return; }
    if (castPosition() > 3 && tvCanSeek) {
      setTvState(s => s ? { ...s, currentTime: 0 } : s);
      api.cast.control(tvCast.ip, 'seek', 0).catch(() => {});
      return;
    }
    castQueueTrack(tvCast, Math.max(0, usePlayer.getState().index - 1));
  };

  const togglePlayback = () => {
    if (!tvCast) { p.toggle(); return; }
    const paused = tvState?.playerState === 'PAUSED';
    const action = paused ? 'play' : 'pause';
    setTvState(s => s ? { ...s, playerState: paused ? 'PLAYING' : 'PAUSED' } : s);
    api.cast.control(tvCast.ip, action).catch(() => {});
  };

  const stopCasting = (resumeLocally = true) => {
    if (!tvCast) return;
    const resumeAt = castPosition();
    api.cast.control(tvCast.ip, 'quit').catch(() => {});
    setTvCast(null); setTvState(null);
    tvOffset.current = 0;
    if (resumeLocally) setTimeout(() => {
      const a = audioRef.current;
      if (a && resumeAt > 0) { try { a.currentTime = resumeAt; } catch { /* metadata may still be loading */ } }
      usePlayer.getState().setPlaying(true);
    }, 0);
  };

  // Keep the player bar in sync with the receiver, persist audiobook progress,
  // and advance album/book queues when the TV finishes the current file.
  useEffect(() => {
    if (!tvCast || castBusy) return;
    let lastReport = 0;
    const poll = () => api.cast.status(tvCast.ip).then(s => {
      if (s?.active && s.playerState === 'IDLE' && s.idleReason === 'FINISHED') {
        nextTrack();
        return;
      }
      if (!s?.active) {
        if (++tvGone.current >= 3) {
          setTvCast(null); setTvState(null);
          toast('Casting ended', 'info');
        }
        return;
      }
      tvGone.current = 0;
      setTvState(s);
      if (Date.now() - lastReport < 15000) return;
      lastReport = Date.now();
      const cur = usePlayer.getState().current;
      if (!cur) return;
      const positionSec = (s.currentTime || 0) + tvOffset.current;
      const durationSec = (s.duration || 0) + tvOffset.current || cur.durationSec || 0;
      if (cur.kind === 'audiobook' || cur.kind === 'podcast') {
        api.books.progress(cur.cast?.itemId || cur.id.split(':')[0], positionSec, durationSec).catch(() => {});
      }
      api.history.beat({
        kind: cur.kind, itemId: cur.id, title: cur.title, subtitle: cur.subtitle,
        imageUrl: cur.artUrl, positionSec, durationSec,
      }).catch(() => {});
    }).catch(() => { if (++tvGone.current >= 3) { setTvCast(null); setTvState(null); } });
    poll();
    const timer = setInterval(poll, 4000);
    return () => clearInterval(timer);
  }, [tvCast, castBusy, p.current?.id]);

  if (!p.current) return <audio ref={audioRef} />;

  // Streaming media often reports duration = Infinity (no Content-Length). Fall back
  // to the track's known durationSec so the scrubber + time display work.
  const effDur = () => {
    const d = audioRef.current?.duration;
    return d && isFinite(d) && d > 0 ? d : (p.current?.durationSec || 0);
  };
  const seek = (e: React.ChangeEvent<HTMLInputElement>) => {
    const dur = tvCast ? castDuration() : effDur(); if (!dur) return;
    const next = (Number(e.target.value) / 100) * dur;
    if (tvCast) {
      if (!tvCanSeek) return;
      setTvState(s => s ? { ...s, currentTime: next } : s);
      api.cast.control(tvCast.ip, 'seek', next).catch(() => {});
      return;
    }
    const a = audioRef.current; if (a) a.currentTime = next;
  };
  const skip = (secs: number) => {
    if (tvCast) {
      if (!tvCanSeek) return;
      const next = Math.max(0, Math.min(castDuration(), castPosition() + secs));
      setTvState(s => s ? { ...s, currentTime: next } : s);
      api.cast.control(tvCast.ip, 'seek', next).catch(() => {});
      return;
    }
    const a = audioRef.current; if (!a) return;
    a.currentTime = Math.max(0, Math.min(effDur() || a.duration || 0, a.currentTime + secs));
  };
  const isBook = p.current.kind === 'audiobook' || p.current.kind === 'podcast';
  const shownTime = tvCast ? castPosition() : p.currentTime;
  const shownDuration = tvCast ? castDuration() : p.duration;
  const shownProgress = shownDuration > 0 ? shownTime / shownDuration : 0;
  const shownPlaying = tvCast ? tvState?.playerState !== 'PAUSED' && tvState?.playerState !== 'IDLE' : p.playing;
  const closePlayer = () => { if (tvCast) stopCasting(false); p.clear(); };

  return (
    <div className="shrink-0 h-20 glass-strong border-t border-white/[0.07] px-4 flex items-center gap-4 z-40">
      <audio ref={audioRef}
        preload="metadata"
        onTimeUpdate={(e) => { const d = e.currentTarget.duration; p.setProgress(e.currentTarget.currentTime, d && isFinite(d) && d > 0 ? d : (usePlayer.getState().current?.durationSec || 0)); }}
        onEnded={() => p.next()}
        onLoadedMetadata={(e) => { const cur = usePlayer.getState().current; if (cur?.startAt && resumedRef.current !== cur.id && e.currentTarget.currentTime < 2) { resumedRef.current = cur.id; try { e.currentTarget.currentTime = cur.startAt; } catch { /* */ } delete cur.startAt; } }}
        onPlay={() => p.setPlaying(true)}
        // Buffering/stall (common with large unoptimized m4b audiobooks) makes the
        // media element fire spurious pause/waiting events with readyState < 3. Do
        // NOT flip the player state on those — auto-resume instead. A pause WITH
        // data available (readyState >= HAVE_FUTURE_DATA) is a genuine external
        // pause (audio-focus loss on a call, becoming-noisy, another app playing)
        // and must sync to the store, or the auto-resume fights the OS and the
        // media notification sticks on "playing".
        onPause={(e) => { const el = e.currentTarget; if (!el.ended && !el.seeking && el.readyState >= 3 && usePlayer.getState().playing) p.setPlaying(false); }}
        onCanPlay={(e) => { if (usePlayer.getState().playing && e.currentTarget.paused) e.currentTarget.play().catch(() => {}); }}
        onPlaying={() => p.setPlaying(true)}
        onStalled={(e) => { if (usePlayer.getState().playing) e.currentTarget.play().catch(() => {}); }}
        // Notification scrubber: report seeks even while paused (the position
        // interval only runs during playback).
        onSeeked={(e) => {
          const nat = (window as any).CloudBoxNative;
          if (!nat?.mediaPosition) return;
          const d = e.currentTarget.duration;
          const dur = d && isFinite(d) && d > 0 ? d : (usePlayer.getState().current?.durationSec || 0);
          try { nat.mediaPosition(Math.round(e.currentTarget.currentTime * 1000), Math.round(dur * 1000)); } catch { /* */ }
        }} />

      {/* track info — tap the artwork to open the full Now Playing card */}
      <div className="flex items-center gap-3 w-[240px] min-w-0">
        <button
          onClick={() => setExpanded(true)}
          title="Open now playing"
          className="group relative w-14 h-14 rounded-lg bg-ink-700 overflow-hidden shrink-0 shadow-card focus:outline-none focus:ring-2 focus:ring-brand-500"
        >
          {p.current.artUrl ? <img src={p.current.artUrl} className="w-full h-full object-cover" /> :
            <div className="w-full h-full grid place-items-center text-slate-600"><Icon.Music size={22} /></div>}
          <span className="absolute inset-0 grid place-items-center bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity text-white">
            <Icon.ChevronDown size={20} className="rotate-180" />
          </span>
        </button>
        <div className="min-w-0">
          <p className="text-sm font-medium text-white truncate">{p.current.title}</p>
          <p className={cx('text-xs truncate', tvCast ? 'text-brand-400' : 'muted')}>{tvCast ? `Casting to ${tvCast.name}` : p.current.subtitle}</p>
        </div>
      </div>

      {/* controls + scrubber */}
      <div className="flex-1 flex flex-col items-center gap-1.5 max-w-2xl mx-auto">
        <div className="flex items-center gap-2">
          <button className={cx('icon-btn', p.shuffle && 'text-brand-400')} onClick={p.toggleShuffle}><Icon.Shuffle size={17} /></button>
          <button className="icon-btn" onClick={previousTrack}><Icon.Prev size={19} /></button>
          <button className="w-10 h-10 rounded-full bg-white text-ink-900 grid place-items-center hover:scale-105 transition-transform" onClick={togglePlayback}>
            {shownPlaying ? <Icon.Pause size={20} /> : <Icon.Play size={20} />}
          </button>
          <button className="icon-btn" onClick={nextTrack}><Icon.Next size={19} /></button>
          <button className={cx('icon-btn', p.repeat !== 'off' && 'text-brand-400')} onClick={p.cycleRepeat}><Icon.Repeat size={17} /></button>
          {p.current.cast && <button className={cx('icon-btn', (tvCast || castBusy) && 'text-brand-400')} onClick={() => setCastOpen(true)} title="Cast audio"><CastIcon /></button>}
        </div>
        <div className="flex items-center gap-2 w-full">
          <span className="text-[11px] tabular-nums muted w-10 text-right">{formatDuration(shownTime)}</span>
          <input type="range" min={0} max={100} value={shownProgress * 100 || 0} onChange={seek} disabled={!!tvCast && !tvCanSeek} className="cb-range flex-1 disabled:opacity-40" />
          <span className="text-[11px] tabular-nums muted w-10">{formatDuration(shownDuration)}</span>
        </div>
      </div>

      {/* volume */}
      <div className="hidden md:flex items-center gap-2 w-[160px]">
        <Icon.Volume size={18} className="text-slate-400" />
        <input type="range" min={0} max={1} step={0.01} value={p.volume} onChange={(e) => p.setVolume(Number(e.target.value))} className="cb-range flex-1" />
        <button className="icon-btn" onClick={closePlayer}><Icon.Close size={16} /></button>
      </div>

      {expanded && <NowPlayingCard p={p} isBook={isBook} seek={seek} skip={skip} onClose={() => setExpanded(false)}
        currentTime={shownTime} duration={shownDuration} progress={shownProgress} playing={shownPlaying}
        onToggle={togglePlayback} onNext={nextTrack} onPrev={previousTrack} onPlayAt={(i) => tvCast ? castQueueTrack(tvCast, i) : p.playAt(i)}
        onCast={p.current.cast ? () => setCastOpen(true) : undefined} castingName={tvCast?.name} onClear={closePlayer} />}

      {castOpen && createPortal(
        <div className="fixed inset-0 z-[220] bg-black/60 backdrop-blur-sm flex items-end sm:items-center justify-center p-4" onClick={() => setCastOpen(false)}>
          <div className="glass-strong rounded-2xl shadow-float w-full max-w-sm overflow-hidden" onClick={e => e.stopPropagation()}>
            <div className="px-4 py-3 border-b border-white/10 flex items-center gap-3">
              <CastIcon size={22} /><div className="min-w-0 flex-1"><p className="font-semibold text-white">Cast audio</p><p className="text-xs muted truncate">{p.current.title}</p></div>
              <button className="icon-btn" onClick={() => setCastOpen(false)}><Icon.Close size={17} /></button>
            </div>
            <div className="max-h-72 overflow-y-auto py-1">
              {castDevices.map(d => (
                <button key={d.ip} disabled={castBusy} onClick={() => void beginCast(d, p.current!, tvCast ? castPosition() : (audioRef.current?.currentTime || p.currentTime || p.current.startAt || 0))}
                  className={cx('w-full px-4 py-3 text-left flex items-center gap-3 hover:bg-white/10 disabled:opacity-50', tvCast?.ip === d.ip ? 'text-brand-300' : 'text-white')}>
                  <span className="w-5">{tvCast?.ip === d.ip && <Icon.Check size={17} />}</span><span className="truncate">{d.name}</span>
                </button>
              ))}
              {!castDevices.length && <p className="px-4 py-5 text-sm muted text-center">No Cast devices found.</p>}
            </div>
            <div className="px-3 py-2 border-t border-white/10 flex gap-2">
              {tvCast && <button className="btn-secondary flex-1 justify-center" onClick={() => { setCastOpen(false); stopCasting(true); }}>Stop casting</button>}
              <button className="btn-secondary flex-1 justify-center" disabled={castBusy} onClick={() => api.cast.devices(true).then(d => setCastDevices(d || [])).catch(() => {})}>{castBusy ? 'Connecting…' : 'Refresh'}</button>
            </div>
          </div>
        </div>, document.body,
      )}
    </div>
  );
}

// Full-screen "Now Playing" card (opens when the bar artwork is tapped). Reuses
// the same <audio> engine + store; it only renders a bigger surface.
function NowPlayingCard({ p, isBook, seek, skip, onClose, currentTime, duration, progress, playing, onToggle, onNext, onPrev, onPlayAt, onCast, castingName, onClear }: {
  p: ReturnType<typeof usePlayer>; isBook: boolean;
  seek: (e: React.ChangeEvent<HTMLInputElement>) => void; skip: (secs: number) => void; onClose: () => void;
  currentTime: number; duration: number; progress: number; playing: boolean;
  onToggle: () => void; onNext: () => void; onPrev: () => void; onPlayAt: (i: number) => void | boolean;
  onCast?: () => void; castingName?: string; onClear: () => void;
}) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);
  const cur = p.current!;
  // Music with a real queue (an album/playlist) shows the tracklist, like any
  // proper player. A single track or an audiobook keeps the big-artwork layout.
  const showList = !isBook && p.queue.length > 1;
  // Portal to <body>: the audio bar uses backdrop-blur (backdrop-filter), which
  // makes it the containing block for fixed children — without the portal the
  // card would be trapped inside the 80px bar instead of covering the viewport.
  return createPortal(
    <div
      className="fixed inset-0 z-[130] flex flex-col items-center animate-fade-in overflow-hidden"
      // 100dvh + safe-area padding: on mobile, inset-0 spills behind the browser
      // chrome / system bars, which would hide the transport controls. dvh tracks
      // the *visible* height so the controls always sit on-screen.
      style={{ height: '100dvh', paddingTop: 'env(safe-area-inset-top)', paddingBottom: 'env(safe-area-inset-bottom)' }}
    >
      {/* blurred artwork backdrop */}
      <div className="absolute inset-0 bg-ink-950" />
      {cur.artUrl && <img src={cur.artUrl} aria-hidden className="absolute inset-0 w-full h-full object-cover scale-110 blur-3xl opacity-30" />}
      <div className="absolute inset-0 bg-gradient-to-b from-ink-950/60 via-ink-950/80 to-ink-950" />

      <div className="relative w-full max-w-md flex flex-col items-center flex-1 min-h-0 px-6 pt-3 pb-5">
        <div className="w-full flex items-center justify-between shrink-0">
          <button className="icon-btn h-11 w-11 text-white hover:bg-white/10" onClick={onClose} title="Close"><Icon.ChevronDown size={24} /></button>
          <span className="text-[11px] uppercase tracking-widest text-slate-400">
            {castingName ? `Casting to ${castingName}` : cur.kind === 'audiobook' ? 'Audiobook' : cur.kind === 'podcast' ? 'Podcast' : 'Now Playing'}
          </span>
          <div className="flex items-center">
            {onCast && <button className={cx('icon-btn h-11 w-11 hover:bg-white/10', castingName ? 'text-brand-400' : 'text-white')} onClick={onCast} title="Cast audio"><CastIcon /></button>}
            <button className="icon-btn h-11 w-11 text-white hover:bg-white/10" onClick={() => { onClear(); onClose(); }} title="Close player"><Icon.Close size={20} /></button>
          </div>
        </div>

        {/* Artwork. Without a tracklist it fills the free height (object-contain so
            it never pushes controls off a short screen); with a tracklist it's a
            fixed medium size to leave room for the list. */}
        <div className={cx('flex items-center justify-center w-full py-4', showList ? 'shrink-0' : 'flex-1 min-h-0')}>
          {cur.artUrl
            ? <img src={cur.artUrl} className={cx('object-cover rounded-2xl shadow-float aspect-square', showList ? 'w-40 h-40 sm:w-44 sm:h-44' : 'max-h-full max-w-full w-auto object-contain')} />
            : <div className={cx('rounded-2xl bg-ink-800 grid place-items-center text-slate-600 shadow-float aspect-square', showList ? 'w-40 h-40' : 'h-full max-h-full')}>{isBook ? <Icon.Book size={64} /> : <Icon.Music size={64} />}</div>}
        </div>

        <div className="w-full text-center mb-4 shrink-0">
          <p className="text-xl font-bold text-white truncate">{cur.title}</p>
          {cur.subtitle && <p className="text-sm text-slate-400 truncate mt-1">{cur.subtitle}</p>}
        </div>

        <div className="w-full flex items-center gap-2 mb-5 shrink-0">
          <span className="text-[11px] tabular-nums text-slate-400 w-10 text-right">{formatDuration(currentTime)}</span>
          <input type="range" min={0} max={100} value={progress * 100 || 0} onChange={seek} className="cb-range flex-1" />
          <span className="text-[11px] tabular-nums text-slate-400 w-10">{formatDuration(duration)}</span>
        </div>

        <div className="w-full flex items-center justify-center gap-5 shrink-0">
          {isBook ? (
            <>
              <button className="icon-btn h-12 w-12 text-white hover:bg-white/10" onClick={() => skip(-15)} title="Back 15s"><Skip dir={-1} secs={15} /></button>
              <button className="w-16 h-16 rounded-full bg-white text-ink-900 grid place-items-center hover:scale-105 transition-transform" onClick={onToggle}>
                {playing ? <Icon.Pause size={28} /> : <Icon.Play size={28} />}
              </button>
              <button className="icon-btn h-12 w-12 text-white hover:bg-white/10" onClick={() => skip(30)} title="Forward 30s"><Skip dir={1} secs={30} /></button>
            </>
          ) : (
            <>
              <button className={cx('icon-btn h-11 w-11', p.shuffle ? 'text-brand-400' : 'text-white')} onClick={p.toggleShuffle}><Icon.Shuffle size={19} /></button>
              <button className="icon-btn h-12 w-12 text-white hover:bg-white/10" onClick={onPrev}><Icon.Prev size={24} /></button>
              <button className="w-16 h-16 rounded-full bg-white text-ink-900 grid place-items-center hover:scale-105 transition-transform" onClick={onToggle}>
                {playing ? <Icon.Pause size={28} /> : <Icon.Play size={28} />}
              </button>
              <button className="icon-btn h-12 w-12 text-white hover:bg-white/10" onClick={onNext}><Icon.Next size={24} /></button>
              <button className={cx('icon-btn h-11 w-11', p.repeat !== 'off' ? 'text-brand-400' : 'text-white')} onClick={p.cycleRepeat}><Icon.Repeat size={19} /></button>
            </>
          )}
        </div>

        {showList && (
          <div className="w-full flex-1 min-h-0 overflow-y-auto mt-6 -mx-1 px-1">
            <p className="text-[11px] uppercase tracking-widest text-slate-500 mb-2 px-2">Up next · {p.queue.length} tracks</p>
            {p.queue.map((t, i) => (
              <button
                key={`${t.id}-${i}`}
                onClick={() => onPlayAt(i)}
                className={cx('w-full flex items-center gap-3 rounded-lg px-2 py-2 text-left transition',
                  i === p.index ? 'bg-white/10' : 'hover:bg-white/[0.05]')}
              >
                <span className="w-6 shrink-0 text-center text-xs tabular-nums">
                  {i === p.index
                    ? <Icon.Volume size={15} className="mx-auto text-brand-400" />
                    : <span className="text-slate-500">{i + 1}</span>}
                </span>
                <span className="min-w-0 flex-1">
                  <span className={cx('block truncate text-sm', i === p.index ? 'text-brand-300 font-medium' : 'text-white')}>{t.title}</span>
                  {t.subtitle && <span className="block truncate text-xs text-slate-500">{t.subtitle}</span>}
                </span>
                {t.durationSec ? <span className="shrink-0 text-[11px] tabular-nums text-slate-500">{formatDuration(t.durationSec)}</span> : null}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
