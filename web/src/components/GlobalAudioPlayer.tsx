// The persistent now-playing bar + <audio> engine. Mounted once in Layout so
// music/audiobooks/podcasts keep playing while the user browses.
import React, { useEffect, useRef, useState } from 'react';
import { usePlayer } from '../lib/store';
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

export function GlobalAudioPlayer() {
  const p = usePlayer();
  const audioRef = useRef<HTMLAudioElement>(null);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    const a = audioRef.current; if (!a || !p.current) return;
    // Compare resolved URLs: a.src reflects the ABSOLUTE url while streamUrl is
    // relative, so a raw comparison mismatches every run and the re-set src +
    // load() resets playback to 0:00 on every pause/resume.
    const src = new URL(p.current.streamUrl, location.origin).href;
    if (a.src !== src) { a.src = src; a.load(); }
    if (p.playing) a.play().catch(() => {}); else a.pause();
  }, [p.current, p.playing]);

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

  if (!p.current) return <audio ref={audioRef} />;

  // Streaming media often reports duration = Infinity (no Content-Length). Fall back
  // to the track's known durationSec so the scrubber + time display work.
  const effDur = () => {
    const d = audioRef.current?.duration;
    return d && isFinite(d) && d > 0 ? d : (p.current?.durationSec || 0);
  };
  const seek = (e: React.ChangeEvent<HTMLInputElement>) => {
    const a = audioRef.current; const dur = effDur(); if (!a || !dur) return;
    a.currentTime = (Number(e.target.value) / 100) * dur;
  };
  const skip = (secs: number) => { const a = audioRef.current; if (!a) return; a.currentTime = Math.max(0, Math.min(effDur() || a.duration || 0, a.currentTime + secs)); };
  const isBook = p.current.kind === 'audiobook' || p.current.kind === 'podcast';

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
          <p className="text-xs muted truncate">{p.current.subtitle}</p>
        </div>
      </div>

      {/* controls + scrubber */}
      <div className="flex-1 flex flex-col items-center gap-1.5 max-w-2xl mx-auto">
        <div className="flex items-center gap-2">
          <button className={cx('icon-btn', p.shuffle && 'text-brand-400')} onClick={p.toggleShuffle}><Icon.Shuffle size={17} /></button>
          <button className="icon-btn" onClick={p.prev}><Icon.Prev size={19} /></button>
          <button className="w-10 h-10 rounded-full bg-white text-ink-900 grid place-items-center hover:scale-105 transition-transform" onClick={p.toggle}>
            {p.playing ? <Icon.Pause size={20} /> : <Icon.Play size={20} />}
          </button>
          <button className="icon-btn" onClick={p.next}><Icon.Next size={19} /></button>
          <button className={cx('icon-btn', p.repeat !== 'off' && 'text-brand-400')} onClick={p.cycleRepeat}><Icon.Repeat size={17} /></button>
        </div>
        <div className="flex items-center gap-2 w-full">
          <span className="text-[11px] tabular-nums muted w-10 text-right">{formatDuration(p.currentTime)}</span>
          <input type="range" min={0} max={100} value={p.progress * 100 || 0} onChange={seek} className="cb-range flex-1" />
          <span className="text-[11px] tabular-nums muted w-10">{formatDuration(p.duration)}</span>
        </div>
      </div>

      {/* volume */}
      <div className="hidden md:flex items-center gap-2 w-[160px]">
        <Icon.Volume size={18} className="text-slate-400" />
        <input type="range" min={0} max={1} step={0.01} value={p.volume} onChange={(e) => p.setVolume(Number(e.target.value))} className="cb-range flex-1" />
        <button className="icon-btn" onClick={p.clear}><Icon.Close size={16} /></button>
      </div>

      {expanded && <NowPlayingCard p={p} isBook={isBook} seek={seek} skip={skip} onClose={() => setExpanded(false)} />}
    </div>
  );
}

// Full-screen "Now Playing" card (opens when the bar artwork is tapped). Reuses
// the same <audio> engine + store; it only renders a bigger surface.
function NowPlayingCard({ p, isBook, seek, skip, onClose }: {
  p: ReturnType<typeof usePlayer>; isBook: boolean;
  seek: (e: React.ChangeEvent<HTMLInputElement>) => void; skip: (secs: number) => void; onClose: () => void;
}) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);
  const cur = p.current!;
  return (
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
            {cur.kind === 'audiobook' ? 'Audiobook' : cur.kind === 'podcast' ? 'Podcast' : 'Now Playing'}
          </span>
          <button className="icon-btn h-11 w-11 text-white hover:bg-white/10" onClick={() => { p.clear(); onClose(); }} title="Close player"><Icon.Close size={20} /></button>
        </div>

        {/* Artwork fits the remaining height (object-contain, max-h-full) so it can
            never push the title/scrubber/controls off a short mobile screen. */}
        <div className="flex-1 flex items-center justify-center w-full min-h-0 py-4">
          {cur.artUrl
            ? <img src={cur.artUrl} className="max-h-full max-w-full w-auto object-contain rounded-2xl shadow-float aspect-square" />
            : <div className="h-full aspect-square max-h-full rounded-2xl bg-ink-800 grid place-items-center text-slate-600 shadow-float">{isBook ? <Icon.Book size={64} /> : <Icon.Music size={64} />}</div>}
        </div>

        <div className="w-full text-center mb-4 shrink-0">
          <p className="text-xl font-bold text-white truncate">{cur.title}</p>
          {cur.subtitle && <p className="text-sm text-slate-400 truncate mt-1">{cur.subtitle}</p>}
        </div>

        <div className="w-full flex items-center gap-2 mb-5 shrink-0">
          <span className="text-[11px] tabular-nums text-slate-400 w-10 text-right">{formatDuration(p.currentTime)}</span>
          <input type="range" min={0} max={100} value={p.progress * 100 || 0} onChange={seek} className="cb-range flex-1" />
          <span className="text-[11px] tabular-nums text-slate-400 w-10">{formatDuration(p.duration)}</span>
        </div>

        <div className="w-full flex items-center justify-center gap-5 shrink-0">
          {isBook ? (
            <>
              <button className="icon-btn h-12 w-12 text-white hover:bg-white/10" onClick={() => skip(-15)} title="Back 15s"><Skip dir={-1} secs={15} /></button>
              <button className="w-16 h-16 rounded-full bg-white text-ink-900 grid place-items-center hover:scale-105 transition-transform" onClick={p.toggle}>
                {p.playing ? <Icon.Pause size={28} /> : <Icon.Play size={28} />}
              </button>
              <button className="icon-btn h-12 w-12 text-white hover:bg-white/10" onClick={() => skip(30)} title="Forward 30s"><Skip dir={1} secs={30} /></button>
            </>
          ) : (
            <>
              <button className={cx('icon-btn h-11 w-11', p.shuffle ? 'text-brand-400' : 'text-white')} onClick={p.toggleShuffle}><Icon.Shuffle size={19} /></button>
              <button className="icon-btn h-12 w-12 text-white hover:bg-white/10" onClick={p.prev}><Icon.Prev size={24} /></button>
              <button className="w-16 h-16 rounded-full bg-white text-ink-900 grid place-items-center hover:scale-105 transition-transform" onClick={p.toggle}>
                {p.playing ? <Icon.Pause size={28} /> : <Icon.Play size={28} />}
              </button>
              <button className="icon-btn h-12 w-12 text-white hover:bg-white/10" onClick={p.next}><Icon.Next size={24} /></button>
              <button className={cx('icon-btn h-11 w-11', p.repeat !== 'off' ? 'text-brand-400' : 'text-white')} onClick={p.cycleRepeat}><Icon.Repeat size={19} /></button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
