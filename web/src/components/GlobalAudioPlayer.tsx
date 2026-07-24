// The persistent now-playing bar + <audio> engine. Mounted once in Layout so
// music/audiobooks/podcasts keep playing while the user browses.
import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { usePlayer, useAuth, toast, type Track } from '../lib/store';
import { Icon } from '../lib/icons';
import { formatDuration, cx } from '../lib/utils';
import { api } from '../lib/api';
import { downloads } from '../lib/downloads';
import {
  canAdvanceQueue, nextQueueIndex, resolveLoudnessNormalization, shouldLoopCurrentTrack, shouldRestartCurrentTrack,
} from '../lib/audio-engine';
import { usePlayerDialog } from '../lib/player-dialog';
import { beginCastLoad, ownsCastLoad, releaseCastLoad } from '../lib/cast-load-lease';

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
type PlaybackPhase = 'loading' | 'buffering' | 'playing' | 'paused' | 'error';
const LONGFORM_SPEEDS = [0.75, 1, 1.25, 1.5, 1.75, 2];

const MutedIcon = ({ size = 20 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round">
    <path d="M11 5 6 9H2v6h4l5 4zM16 9l5 6M21 9l-5 6" />
  </svg>
);

function mediaErrorText(error: MediaError | null): string {
  if (!error) return 'Playback stopped unexpectedly.';
  if (error.code === 1) return 'Playback was interrupted.';
  if (error.code === 2) return 'The connection to this audio stream was lost.';
  if (error.code === 3) return 'This audio file could not be decoded.';
  if (error.code === 4) return 'This audio format or stream is not supported.';
  return 'This track could not be played.';
}

function workPosition(track: Track, localPosition: number): number {
  return Math.max(0, (track.timelineOffsetSec || 0) + (localPosition || 0));
}

function workDuration(track: Track, localDuration: number): number {
  return track.totalDurationSec || localDuration || track.durationSec || 0;
}

export function GlobalAudioPlayer() {
  const p = usePlayer();
  const userId = useAuth(state => state.user?.id);
  const audioRef = useRef<HTMLAudioElement>(null);
  const audioDeckARef = useRef<HTMLAudioElement>(null);
  const audioDeckBRef = useRef<HTMLAudioElement>(null);
  const activeDeckRef = useRef<0 | 1>(0);
  const [activeDeck, setActiveDeck] = useState<0 | 1>(0);
  const preloadedTrackRef = useRef<{ deck: 0 | 1; index: number; src: string; track: Track } | null>(null);
  const audioGraphRef = useRef<{ context: AudioContext; gains: Map<HTMLAudioElement, GainNode> } | null>(null);
  const normalizationPreferenceRevision = useRef(0);
  const [webAudioFailed, setWebAudioFailed] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [castDevices, setCastDevices] = useState<CastDevice[]>([]);
  const [castOpen, setCastOpen] = useState(false);
  const [castBusy, setCastBusy] = useState(false);
  const [tvCast, setTvCast] = useState<CastDevice | null>(null);
  const [tvState, setTvState] = useState<CastState | null>(null);
  const [tvCanSeek, setTvCanSeek] = useState(true);
  const [downloadPct, setDownloadPct] = useState<number | null>(null);
  const [phase, setPhase] = useState<PlaybackPhase>('loading');
  const [playbackError, setPlaybackError] = useState<string | null>(null);
  const [bufferedFraction, setBufferedFraction] = useState(0);
  const tvOffset = useRef(0);
  const tvGone = useRef(0);
  const lastSelection = useRef(-1);
  const pendingSeek = useRef<number | null>(null);
  const retryCount = useRef(0);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastErrorSelection = useRef(-1);
  const castDialogRef = useRef<HTMLDivElement>(null);
  const activeCastRef = useRef<CastDevice | null>(null);
  const activeCastGenerationRef = useRef<string | null>(null);
  const castLoadTokenRef = useRef(0);
  activeCastRef.current = tvCast;
  const controlActiveCast = (device: CastDevice, action: 'play' | 'pause' | 'stop' | 'seek' | 'quit', value?: number) => {
    const controllerGeneration = activeCastGenerationRef.current;
    return controllerGeneration
      ? api.cast.control(device.ip, action, value, controllerGeneration)
      : Promise.resolve({ ok: false });
  };

  const deck = (index: 0 | 1) => index === 0 ? audioDeckARef.current : audioDeckBRef.current;
  const webAudioDeclared = typeof window !== 'undefined'
    && !!(window.AudioContext || (window as any).webkitAudioContext)
    && !webAudioFailed;

  const ensureAudioGraph = () => {
    if (audioGraphRef.current) return audioGraphRef.current;
    const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext as typeof AudioContext | undefined;
    const elements = [audioDeckARef.current, audioDeckBRef.current].filter((value): value is HTMLAudioElement => !!value);
    if (!AudioContextClass || elements.length !== 2) return null;
    let context: AudioContext | null = null;
    try {
      context = new AudioContextClass();
      const graph = { context, gains: new Map<HTMLAudioElement, GainNode>() };
      for (const element of elements) {
        const source = context.createMediaElementSource(element);
        const gain = context.createGain();
        source.connect(gain).connect(context.destination);
        graph.gains.set(element, gain);
      }
      audioGraphRef.current = graph;
      return graph;
    } catch {
      void context?.close().catch(() => {});
      setWebAudioFailed(true);
      return null;
    }
  };

  const applyAudioOutput = (audio: HTMLAudioElement, track: Track | null | undefined) => {
    const state = usePlayer.getState();
    const preliminary = resolveLoudnessNormalization(track, state.normalizationEnabled, state.shuffle, webAudioDeclared);
    // HTMLMediaElement.volume handles attenuation exactly. Only create a Web
    // Audio graph when ReplayGain genuinely needs a protected boost above 1.0.
    const graph = audioGraphRef.current || (audio === audioRef.current && preliminary.enabled && preliminary.available
      && preliminary.multiplier > 1 && state.volume * preliminary.multiplier > 1 && webAudioDeclared ? ensureAudioGraph() : null);
    const gainNode = graph?.gains.get(audio);
    const elementHasHeadroom = preliminary.multiplier <= 1 || state.volume * preliminary.multiplier <= 1;
    const result = resolveLoudnessNormalization(track, state.normalizationEnabled, state.shuffle, !!gainNode || elementHasHeadroom);
    if (gainNode && graph) {
      audio.volume = 1;
      audio.muted = false;
      const output = (state.muted ? 0 : state.volume) * result.multiplier;
      gainNode.gain.setValueAtTime(output, graph.context.currentTime);
    } else {
      audio.volume = Math.max(0, Math.min(1, state.volume * result.multiplier));
      audio.muted = state.muted;
    }
    return result;
  };

  const clearRetryTimer = () => {
    if (retryTimer.current) clearTimeout(retryTimer.current);
    retryTimer.current = null;
  };

  const effectiveDuration = (audio = audioRef.current) => {
    const d = audio?.duration;
    return d && Number.isFinite(d) && d > 0 ? d : (usePlayer.getState().current?.durationSec || 0);
  };

  const requestPlay = (audio: HTMLAudioElement) => {
    const track = audio === audioRef.current
      ? usePlayer.getState().current
      : preloadedTrackRef.current?.track;
    applyAudioOutput(audio, track);
    const graph = audioGraphRef.current;
    if (graph?.context.state === 'suspended') void graph.context.resume().catch(() => {});
    let attempt: Promise<void> | undefined;
    try { attempt = audio.play(); }
    catch (error: any) {
      const state = usePlayer.getState();
      state.setPlaying(false);
      const message = String(error?.message || 'The browser could not start this audio stream.');
      setPlaybackError(message);
      setPhase('error');
      if (lastErrorSelection.current !== state.selectionId) {
        lastErrorSelection.current = state.selectionId;
        toast('Could not start playback', 'error', message);
      }
      return;
    }
    if (!attempt) return;
    attempt.catch((error: any) => {
      if (error?.name === 'AbortError') return;
      const state = usePlayer.getState();
      state.setPlaying(false);
      if (error?.name === 'NotAllowedError') {
        setPhase('paused');
        return;
      }
      const message = String(error?.message || 'The browser could not start this audio stream.');
      setPlaybackError(message);
      setPhase('error');
      if (lastErrorSelection.current !== state.selectionId) {
        lastErrorSelection.current = state.selectionId;
        toast('Could not start playback', 'error', message);
      }
    });
  };

  const localPrevious = () => {
    const state = usePlayer.getState();
    const audio = audioRef.current;
    const position = audio?.currentTime || state.currentTime || 0;
    if (audio && shouldRestartCurrentTrack(position)) {
      audio.currentTime = 0;
      state.setProgress(0, effectiveDuration(audio));
      return;
    }
    state.prev();
  };

  const promotePreloadedNext = () => {
    const state = usePlayer.getState();
    const nextIndex = nextQueueIndex(
      state.queue.length,
      state.index,
      state.shuffle && state.current?.kind === 'music',
      state.shuffleRemaining,
      state.current?.kind === 'music' ? state.repeat : 'off',
    );
    const preload = preloadedTrackRef.current;
    if (nextIndex == null || !preload || preload.index !== nextIndex || preload.deck === activeDeckRef.current) return false;
    const target = state.queue[nextIndex];
    const standby = deck(preload.deck);
    const expectedSrc = target ? new URL(target.streamUrl, location.origin).href : '';
    if (!target || target.kind !== 'music' || preload.src !== expectedSrc || standby?.src !== expectedSrc
      || standby.readyState < HTMLMediaElement.HAVE_FUTURE_DATA) return false;

    const previousSelection = state.selectionId;
    state.next();
    const selected = usePlayer.getState();
    // Queue edits cannot interleave within this synchronous transition, but
    // still fail safe if a future store implementation changes that contract.
    if (selected.selectionId === previousSelection || selected.current?.streamUrl !== target.streamUrl) return true;
    const oldAudio = audioRef.current;
    activeDeckRef.current = preload.deck;
    audioRef.current = standby;
    preloadedTrackRef.current = null;
    setActiveDeck(preload.deck);
    oldAudio?.pause();
    applyAudioOutput(standby, selected.current);
    if (selected.playing) requestPlay(standby);
    return true;
  };

  const localNext = () => {
    if (!promotePreloadedNext()) usePlayer.getState().next();
  };

  const retryLocalPlayback = () => {
    const audio = audioRef.current;
    const state = usePlayer.getState();
    if (!audio || !state.current) return;
    clearRetryTimer();
    retryCount.current = 0;
    pendingSeek.current = Math.max(0, audio.currentTime || state.currentTime || state.current.startAt || 0);
    setPlaybackError(null);
    setPhase('loading');
    state.setPlaying(true);
    audio.load();
    requestPlay(audio);
  };

  useEffect(() => {
    activeDeckRef.current = activeDeck;
    audioRef.current = deck(activeDeck);
  }, [activeDeck]);

  // The server preference follows the signed-in account. The persisted player
  // session remains an account-scoped offline fallback until this request
  // returns, so a network outage does not silently reset the choice.
  useEffect(() => {
    if (!userId) return;
    let alive = true;
    const revision = normalizationPreferenceRevision.current;
    api.settings.get().then(settings => {
      if (!alive || useAuth.getState().user?.id !== userId || normalizationPreferenceRevision.current !== revision) return;
      usePlayer.getState().setNormalizationEnabled(settings?.preferences?.musicLoudnessNormalization === true);
    }).catch(() => {});
    return () => { alive = false; };
  }, [userId]);

  useEffect(() => {
    const a = audioRef.current; if (!a || !p.current) return;
    // Compare resolved URLs: a.src reflects the ABSOLUTE url while streamUrl is
    // relative, so a raw comparison mismatches every run and the re-set src +
    // load() resets playback to 0:00 on every pause/resume.
    const src = new URL(p.current.streamUrl, location.origin).href;
    const selectionChanged = lastSelection.current !== p.selectionId;
    if (selectionChanged) {
      lastSelection.current = p.selectionId;
      pendingSeek.current = Math.max(0, p.current.startAt || 0);
      retryCount.current = 0;
      lastErrorSelection.current = -1;
      setPlaybackError(null);
      setPhase('loading');
      setBufferedFraction(0);
    }
    if (a.src !== src) {
      a.src = src;
      a.load();
    } else if (selectionChanged && a.readyState >= HTMLMediaElement.HAVE_METADATA) {
      try { a.currentTime = Math.min(pendingSeek.current || 0, effectiveDuration(a) || Number.MAX_SAFE_INTEGER); } catch { /* seek waits for metadata */ }
      pendingSeek.current = null;
      usePlayer.getState().consumeStartAt();
    }
    if (tvCast || castBusy) { a.pause(); return; }
    if (p.playing) requestPlay(a);
    else {
      a.pause();
      if (!playbackError && a.readyState >= HTMLMediaElement.HAVE_METADATA) setPhase('paused');
    }
  }, [p.current?.streamUrl, p.selectionId, p.playing, tvCast, castBusy, activeDeck]);

  // Keep one inactive deck buffered with the exact item next() will consume.
  // It is promoted only after HAVE_FUTURE_DATA and an index/URL recheck; all
  // other cases retain the existing single-deck load path.
  useEffect(() => {
    const state = usePlayer.getState();
    const standbyDeck: 0 | 1 = activeDeck === 0 ? 1 : 0;
    const standby = deck(standbyDeck);
    if (!standby) return;
    const nextIndex = nextQueueIndex(
      state.queue.length,
      state.index,
      state.shuffle && state.current?.kind === 'music',
      state.shuffleRemaining,
      state.current?.kind === 'music' ? state.repeat : 'off',
    );
    const target = nextIndex == null ? null : state.queue[nextIndex];
    const src = target?.kind === 'music' ? new URL(target.streamUrl, location.origin).href : '';
    const existing = preloadedTrackRef.current;
    const connection = (navigator as any).connection;
    const constrainedNetwork = navigator.onLine === false || connection?.saveData === true
      || connection?.effectiveType === 'slow-2g' || connection?.effectiveType === '2g';

    if (tvCast || castBusy || constrainedNetwork || !target || !src || !state.playing) {
      if (!state.playing && existing?.deck === standbyDeck && existing.src === src) return;
      if (standby.src) {
        standby.pause();
        standby.removeAttribute('src');
        standby.load();
      }
      preloadedTrackRef.current = null;
      return;
    }
    if (standby.src !== src) {
      standby.pause();
      standby.src = src;
      standby.preload = 'auto';
      standby.load();
    }
    preloadedTrackRef.current = { deck: standbyDeck, index: nextIndex!, src, track: target };
    applyAudioOutput(standby, target);
  }, [activeDeck, p.current?.streamUrl, p.index, p.queue, p.shuffle, p.shuffleRemaining, p.repeat, p.playing, tvCast, castBusy]);

  useEffect(() => {
    for (const [audio, track] of [[audioRef.current, p.current], [deck(activeDeck === 0 ? 1 : 0), preloadedTrackRef.current?.track]] as const) {
      if (audio) {
        applyAudioOutput(audio, track);
        const rate = p.current?.kind === 'music' ? 1 : p.playbackRate;
        audio.defaultPlaybackRate = rate;
        audio.playbackRate = rate;
        if ('preservesPitch' in audio) audio.preservesPitch = true;
        if ('mozPreservesPitch' in audio) (audio as any).mozPreservesPitch = true;
        if ('webkitPreservesPitch' in audio) (audio as any).webkitPreservesPitch = true;
      }
    }
  }, [p.volume, p.muted, p.playbackRate, p.normalizationEnabled, p.shuffle, p.current?.kind, p.selectionId, activeDeck, webAudioFailed]);

  useEffect(() => () => {
    clearRetryTimer();
    for (const audio of [audioDeckARef.current, audioDeckBRef.current]) audio?.pause();
    const graph = audioGraphRef.current;
    audioGraphRef.current = null;
    if (graph) void graph.context.close().catch(() => {});
  }, []);
  useEffect(() => () => {
    castLoadTokenRef.current += 1;
    const device = activeCastRef.current;
    const controllerGeneration = activeCastGenerationRef.current;
    activeCastGenerationRef.current = null;
    if (device && controllerGeneration) api.cast.control(device.ip, 'quit', undefined, controllerGeneration).catch(() => {});
  }, []);
  useEffect(() => {
    const stopPrivateMedia = () => {
      audioDeckARef.current?.pause();
      audioDeckBRef.current?.pause();
      castLoadTokenRef.current += 1;
      const device = activeCastRef.current;
      const controllerGeneration = activeCastGenerationRef.current;
      activeCastGenerationRef.current = null;
      if (device && controllerGeneration) api.cast.control(device.ip, 'quit', undefined, controllerGeneration).catch(() => {});
    };
    window.addEventListener('aerie:stop-private-media', stopPrivateMedia);
    return () => window.removeEventListener('aerie:stop-private-media', stopPrivateMedia);
  }, []);

  useEffect(() => {
    if (!castOpen) return;
    const previousFocus = document.activeElement as HTMLElement | null;
    castDialogRef.current?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); setCastOpen(false); return; }
      if (event.key !== 'Tab' || !castDialogRef.current) return;
      const focusable = Array.from(castDialogRef.current.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), [tabindex]:not([tabindex="-1"])'));
      if (!focusable.length) return;
      const first = focusable[0], last = focusable[focusable.length - 1];
      const active = document.activeElement;
      if (event.shiftKey && (active === first || active === castDialogRef.current || !castDialogRef.current.contains(active))) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && (active === last || !castDialogRef.current.contains(active))) { event.preventDefault(); first.focus(); }
    };
    window.addEventListener('keydown', keydown);
    return () => { window.removeEventListener('keydown', keydown); previousFocus?.focus(); };
  }, [castOpen]);

  // Save listening position for audiobooks/podcasts so "Continue listening"
  // works and playback resumes where you left off. Reports every 15s + on change.
  useEffect(() => {
    const cur = p.current;
    if (!cur || (cur.kind !== 'audiobook' && cur.kind !== 'podcast')) return;
    const bookId = String(cur.id).split(':')[0];
    const report = () => {
      const a = audioRef.current;
      if (a && a.currentTime > 1) {
        const localDuration = a.duration && Number.isFinite(a.duration) ? a.duration : (cur.durationSec || 0);
        api.books.progress(bookId, workPosition(cur, a.currentTime), workDuration(cur, localDuration)).catch(() => {});
      }
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
      const longform = cur.kind === 'audiobook' || cur.kind === 'podcast';
      api.history.beat({
        kind: longform ? cur.kind : 'music',
        itemId: longform ? (cur.cast?.itemId || cur.id.split(':')[0]) : cur.id,
        title: cur.title, subtitle: cur.subtitle, imageUrl: cur.artUrl,
        positionSec: workPosition(cur, a.currentTime || st.currentTime || 0), durationSec: workDuration(cur, d),
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
    if (typeof MediaMetadata !== 'undefined') {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: p.current.title,
        artist: p.current.subtitle || '',
        album: p.current.kind === 'audiobook' ? 'Audiobook' : p.current.kind === 'podcast' ? 'Podcast' : 'Aerie',
        artwork: art ? [96, 192, 256, 384, 512].map(s => ({ src: art, sizes: `${s}x${s}` })) : [],
      });
    }
    const setAction = (action: MediaSessionAction, handler: MediaSessionActionHandler | null) => {
      try { navigator.mediaSession.setActionHandler(action, handler); } catch { /* unsupported by this browser */ }
    };
    setAction('play', () => {
      if (tvCast) {
        setTvState(state => state ? { ...state, playerState: 'PLAYING' } : state);
        controlActiveCast(tvCast, 'play').catch(() => {});
        return;
      }
      const audio = audioRef.current;
      usePlayer.getState().setPlaying(true);
      if (audio) requestPlay(audio);
    });
    setAction('pause', () => {
      if (tvCast) {
        setTvState(state => state ? { ...state, playerState: 'PAUSED' } : state);
        controlActiveCast(tvCast, 'pause').catch(() => {});
        return;
      }
      usePlayer.getState().setPlaying(false); audioRef.current?.pause();
    });
    const state = usePlayer.getState();
    const canAdvance = canAdvanceQueue(state.queue.length, state.index, state.shuffle && state.current?.kind === 'music', state.shuffleRemaining.length, state.current?.kind === 'music' ? state.repeat : 'off');
    setAction('nexttrack', canAdvance ? () => nextTrack() : null);
    setAction('previoustrack', previousTrack);
    // Audiobooks/podcasts: skip 15s/30s instead of track change.
    const skip = p.current.kind !== 'music';
    setAction('seekbackward', skip ? (d) => {
      if (tvCast && tvCanSeek) {
        const position = Math.max(0, castPosition() - (d.seekOffset || 15));
        setTvState(state => state ? { ...state, currentTime: position } : state);
        controlActiveCast(tvCast, 'seek', position).catch(() => {});
        return;
      }
      const a = audioRef.current; if (a) a.currentTime = Math.max(0, a.currentTime - (d.seekOffset || 15));
    } : null);
    setAction('seekforward', skip ? (d) => {
      if (tvCast && tvCanSeek) {
        const position = Math.min(castDuration(), castPosition() + (d.seekOffset || 30));
        setTvState(state => state ? { ...state, currentTime: position } : state);
        controlActiveCast(tvCast, 'seek', position).catch(() => {});
        return;
      }
      const a = audioRef.current; if (a) a.currentTime = Math.min(effectiveDuration(a), a.currentTime + (d.seekOffset || 30));
    } : null);
    setAction('seekto', (d) => {
      if (tvCast) {
        if (!tvCanSeek || d.seekTime == null) return;
        const position = Math.max(0, Math.min(castDuration() || d.seekTime, d.seekTime));
        setTvState(state => state ? { ...state, currentTime: position } : state);
        controlActiveCast(tvCast, 'seek', position).catch(() => {});
        return;
      }
      const a = audioRef.current;
      if (!a || d.seekTime == null) return;
      const position = Math.max(0, Math.min(effectiveDuration(a) || d.seekTime, d.seekTime));
      if (d.fastSeek && typeof a.fastSeek === 'function') a.fastSeek(position);
      else a.currentTime = position;
    });
    return () => {
      for (const action of ['play', 'pause', 'nexttrack', 'previoustrack', 'seekbackward', 'seekforward', 'seekto'] as MediaSessionAction[]) setAction(action, null);
      try { navigator.mediaSession.metadata = null; } catch { /* */ }
    };
  }, [p.current?.id, p.current?.streamUrl, p.queue.length, p.index, p.shuffle, p.shuffleRemaining.length, p.repeat, p.selectionId, tvCast?.ip, tvCanSeek, tvState?.currentTime, tvState?.duration]);

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
      if (action === 'play' && tvCast) { setTvState(state => state ? { ...state, playerState: 'PLAYING' } : state); controlActiveCast(tvCast, 'play').catch(() => {}); }
      else if (action === 'pause' && tvCast) { setTvState(state => state ? { ...state, playerState: 'PAUSED' } : state); controlActiveCast(tvCast, 'pause').catch(() => {}); }
      else if (action === 'play') { st.setPlaying(true); if (a) requestPlay(a); }
      else if (action === 'pause') { st.setPlaying(false); a?.pause(); }
      else if (action === 'next') nextTrack();
      else if (action === 'prev') previousTrack();
      else if (action === 'seek' && tvCast && tvCanSeek && value != null && isFinite(value)) controlActiveCast(tvCast, 'seek', value).catch(() => {});
      else if (action === 'seek' && a && value != null && isFinite(value)) a.currentTime = value;
    };
    return () => { delete (window as any).__cbMediaControl; };
  }, [tvCast?.ip, tvCanSeek, tvState?.currentTime]);

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
        playing: tvCast ? tvState?.playerState !== 'PAUSED' && tvState?.playerState !== 'IDLE' : p.playing,
        position: Math.round((tvCast ? castPosition() : (a?.currentTime || 0)) * 1000),
        duration: Math.round((tvCast ? castDuration() : durSec) * 1000),
        hasQueue: p.queue.length > 1,
      }));
    } catch { /* bridge call failed — native side gone */ }
  }, [p.current, p.playing, p.queue.length, tvCast?.ip, tvState?.playerState, tvState?.currentTime, tvState?.duration]);

  // Periodic position sync so the notification seek bar stays honest.
  useEffect(() => {
    if (!native?.mediaPosition || (!p.playing && !tvCast)) return;
    const t = setInterval(() => {
      const a = audioRef.current; const cur = usePlayer.getState().current;
      if (!a || !cur) return;
      const dur = a.duration && isFinite(a.duration) ? a.duration : (cur.durationSec || 0);
      try {
        native.mediaPosition(
          Math.round((tvCast ? castPosition() : a.currentTime) * 1000),
          Math.round((tvCast ? castDuration() : dur) * 1000),
        );
      } catch { /* */ }
    }, 5000);
    return () => clearInterval(t);
  }, [p.playing, tvCast?.ip, tvState?.currentTime, tvState?.duration]);

  // Keep OS play/pause state + scrubber position in sync (the media badge).
  useEffect(() => {
    if ('mediaSession' in navigator) {
      const remotePlaying = !!tvCast && tvState?.playerState !== 'PAUSED' && tvState?.playerState !== 'IDLE';
      navigator.mediaSession.playbackState = p.playing || remotePlaying ? 'playing' : 'paused';
    }
    return () => { if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'none'; };
  }, [p.playing, tvCast?.ip, tvState?.playerState]);
  useEffect(() => {
    if (!('mediaSession' in navigator) || !('setPositionState' in navigator.mediaSession)) return;
    const duration = tvCast ? castDuration() : p.duration;
    const currentTime = tvCast ? castPosition() : p.currentTime;
    if (duration > 0 && isFinite(duration)) {
      try {
        navigator.mediaSession.setPositionState({
          duration,
          position: Math.max(0, Math.min(currentTime, duration)),
          playbackRate: tvCast ? 1 : (audioRef.current?.playbackRate || 1),
        });
      } catch { /* */ }
    }
  }, [p.currentTime, p.duration, tvCast?.ip, tvState?.currentTime, tvState?.duration]);

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
    const requestToken = ++castLoadTokenRef.current;
    const loadLease = beginCastLoad(device.ip);
    setCastOpen(false);
    setCastBusy(true);
    const previous = tvCast;
    const previousControllerGeneration = activeCastGenerationRef.current;
    audioRef.current?.pause();
    usePlayer.getState().setPlaying(false);
    try {
      const result = await api.cast.playAudio(device.ip, track.cast, Math.max(0, positionSec || 0), loadLease.controllerGeneration);
      if (result.controllerGeneration !== loadLease.controllerGeneration) throw new Error('cast_generation_mismatch');
      if (requestToken !== castLoadTokenRef.current || !ownsCastLoad(loadLease)) {
        releaseCastLoad(loadLease);
        api.cast.control(device.ip, 'quit', undefined, loadLease.controllerGeneration).catch(() => {});
        return;
      }
      releaseCastLoad(loadLease);
      if (previous && previous.ip !== device.ip && previousControllerGeneration) {
        api.cast.control(previous.ip, 'quit', undefined, previousControllerGeneration).catch(() => {});
      }
      activeCastGenerationRef.current = result.controllerGeneration;
      tvOffset.current = result.offset || 0;
      setTvCanSeek(result.canSeek !== false);
      setTvState({ active: true, playerState: 'BUFFERING', currentTime: Math.max(0, positionSec - (result.offset || 0)), duration: track.durationSec });
      setTvCast(device);
      tvGone.current = 0;
      toast(`Casting to ${device.name}`, 'success', track.title);
    } catch (e: any) {
      const owned = releaseCastLoad(loadLease);
      api.cast.control(device.ip, 'quit', undefined, loadLease.controllerGeneration).catch(() => {});
      if (requestToken !== castLoadTokenRef.current || !owned) return;
      // Never leave the UI claiming that the newly selected queue item is on a
      // receiver that is actually still playing the old item. Fall back to the
      // requested track locally and close any previous Aerie Cast session.
      if (previous && previousControllerGeneration) {
        api.cast.control(previous.ip, 'quit', undefined, previousControllerGeneration).catch(() => {});
      }
      activeCastGenerationRef.current = null;
      setTvCast(null); setTvState(null);
      tvOffset.current = 0;
      const audio = audioRef.current;
      const requestedUrl = new URL(track.streamUrl, location.origin).href;
      if (audio?.src === requestedUrl && positionSec > 0) {
        try { audio.currentTime = positionSec; } catch { /* metadata may still be loading */ }
      }
      const state = usePlayer.getState();
      state.setProgress(positionSec, track.durationSec || effectiveDuration(audio));
      state.setPlaying(true);
      toast('Cast failed', 'error', String(e?.message || 'The TV could not load this audio stream.'));
    } finally {
      releaseCastLoad(loadLease);
      if (requestToken === castLoadTokenRef.current) setCastBusy(false);
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

  const nextTrack = (finished = false) => {
    if (!tvCast) { localNext(); return; }
    const st = usePlayer.getState();
    if (finished && st.current?.kind === 'music' && st.repeat === 'one') {
      void beginCast(tvCast, st.current, 0);
      return;
    }
    const previousSelection = st.selectionId;
    st.next();
    const next = usePlayer.getState();
    if (next.selectionId !== previousSelection && next.current?.cast) {
      void beginCast(tvCast, next.current, 0);
      return;
    }
    controlActiveCast(tvCast, 'quit').catch(() => {});
    activeCastGenerationRef.current = null;
    setTvCast(null); setTvState(null);
  };

  const previousTrack = () => {
    if (!tvCast) { localPrevious(); return; }
    if (castPosition() > 3 && tvCanSeek) {
      setTvState(s => s ? { ...s, currentTime: 0 } : s);
      controlActiveCast(tvCast, 'seek', 0).catch(() => {});
      return;
    }
    const state = usePlayer.getState();
    const previousSelection = state.selectionId;
    state.prev();
    const previous = usePlayer.getState();
    if (previous.selectionId !== previousSelection && previous.current?.cast) {
      void beginCast(tvCast, previous.current, 0);
      return;
    }
    if (previous.current?.cast) void beginCast(tvCast, previous.current, 0);
  };

  const togglePlayback = () => {
    if (!tvCast) { p.toggle(); return; }
    const paused = tvState?.playerState === 'PAUSED';
    const action = paused ? 'play' : 'pause';
    setTvState(s => s ? { ...s, playerState: paused ? 'PLAYING' : 'PAUSED' } : s);
    controlActiveCast(tvCast, action).catch(() => {});
  };

  const stopCasting = (resumeLocally = true) => {
    if (!tvCast) return;
    castLoadTokenRef.current += 1;
    const resumeAt = castPosition();
    controlActiveCast(tvCast, 'quit').catch(() => {});
    activeCastGenerationRef.current = null;
    setTvCast(null); setTvState(null);
    tvOffset.current = 0;
    if (resumeLocally) setTimeout(() => {
      const a = audioRef.current;
      if (a && resumeAt > 0) { try { a.currentTime = resumeAt; } catch { /* metadata may still be loading */ } }
      usePlayer.getState().setPlaying(true);
    }, 0);
  };
  const saveCurrent = async () => {
    const cur = p.current; if (!cur) return;
    if (downloads.has(cur.id)) { toast('Already downloaded', 'info', cur.title); return; }
    setDownloadPct(0);
    try {
      await downloads.save({ id: cur.id, url: cur.streamUrl, title: cur.title, subtitle: cur.subtitle, artUrl: cur.artUrl, kind: cur.kind }, n => setDownloadPct(n < 0 ? 0 : Math.round(n * 100)));
      toast('Saved for offline', 'success', cur.title);
    } catch (e: any) { toast('Download failed', 'error', e?.message); } finally { setDownloadPct(null); }
  };

  // Keep the player bar in sync with the receiver, persist audiobook progress,
  // and advance album/book queues when the TV finishes the current file.
  useEffect(() => {
    if (!tvCast || castBusy) return;
    const deviceIp = tvCast.ip;
    const controllerGeneration = activeCastGenerationRef.current;
    if (!controllerGeneration) return;
    let lastReport = 0;
    let cancelled = false;
    let inFlight = false;
    const isCurrentSession = () => !cancelled
      && activeCastRef.current?.ip === deviceIp
      && activeCastGenerationRef.current === controllerGeneration;
    const persistProgress = (s: CastState, completed = false) => {
      const cur = usePlayer.getState().current;
      if (!cur) return;
      const localDurationSec = (s.duration || 0) + tvOffset.current || cur.durationSec || 0;
      const reportedPosition = (s.currentTime || 0) + tvOffset.current;
      const localPositionSec = completed && localDurationSec > 0 ? localDurationSec : reportedPosition;
      // Keep account-scoped resume state current while playback is remote. If
      // the tab reloads or Cast drops, the local player resumes where the TV was.
      usePlayer.getState().setProgress(localPositionSec, localDurationSec);
      const positionSec = workPosition(cur, localPositionSec);
      const durationSec = workDuration(cur, localDurationSec);
      if (cur.kind === 'audiobook' || cur.kind === 'podcast') {
        api.books.progress(cur.cast?.itemId || cur.id.split(':')[0], positionSec, durationSec).catch(() => {});
      }
      api.history.beat({
        kind: cur.kind, itemId: cur.id, title: cur.title, subtitle: cur.subtitle,
        imageUrl: cur.artUrl, positionSec, durationSec,
      }).catch(() => {});
    };
    const poll = () => {
      if (inFlight || !isCurrentSession()) return;
      inFlight = true;
      api.cast.status(deviceIp, controllerGeneration).then(s => {
        // Status requests can take longer than the polling interval. A response
        // from track A must never clear or overwrite a newer track B session.
        if (!isCurrentSession()) return;
        if (s?.active && s.playerState === 'IDLE' && s.idleReason === 'FINISHED') {
          persistProgress(s, true);
          activeCastGenerationRef.current = null;
          nextTrack(true);
          return;
        }
        if (!s?.active) {
          if (++tvGone.current >= 3) {
            setTvCast(null); setTvState(null);
            activeCastGenerationRef.current = null;
            toast('Casting ended', 'info');
          }
          return;
        }
        tvGone.current = 0;
        setTvState(s);
        if (Date.now() - lastReport < 15000) return;
        lastReport = Date.now();
        persistProgress(s);
      }).catch(() => {
        if (!isCurrentSession()) return;
        if (++tvGone.current >= 3) {
          activeCastGenerationRef.current = null;
          setTvCast(null); setTvState(null);
        }
      }).finally(() => { inFlight = false; });
    };
    poll();
    const timer = setInterval(poll, 4000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [tvCast, castBusy, p.current?.id]);

  if (!p.current) return <audio ref={audioRef} data-aerie-player-engine="true" preload="none" />;

  // Streaming media often reports duration = Infinity (no Content-Length). Fall back
  // to the track's known durationSec so the scrubber + time display work.
  const effDur = () => effectiveDuration();
  const seek = (e: React.ChangeEvent<HTMLInputElement>) => {
    const dur = tvCast ? castDuration() : effDur(); if (!dur) return;
    const next = (Number(e.target.value) / 100) * dur;
    if (tvCast) {
      if (!tvCanSeek) return;
      setTvState(s => s ? { ...s, currentTime: next } : s);
      controlActiveCast(tvCast, 'seek', next).catch(() => {});
      return;
    }
    const a = audioRef.current; if (a) a.currentTime = next;
  };
  const skip = (secs: number) => {
    if (tvCast) {
      if (!tvCanSeek) return;
      const next = Math.max(0, Math.min(castDuration(), castPosition() + secs));
      setTvState(s => s ? { ...s, currentTime: next } : s);
      controlActiveCast(tvCast, 'seek', next).catch(() => {});
      return;
    }
    const a = audioRef.current; if (!a) return;
    a.currentTime = Math.max(0, Math.min(effDur() || a.duration || 0, a.currentTime + secs));
  };
  const isBook = p.current.kind === 'audiobook' || p.current.kind === 'podcast';
  const shownTime = tvCast ? castPosition() : p.currentTime;
  const shownDuration = tvCast ? castDuration() : p.duration;
  const shownProgress = shownDuration > 0 ? Math.max(0, Math.min(1, shownTime / shownDuration)) : 0;
  const shownBuffered = tvCast ? shownProgress : Math.max(shownProgress, bufferedFraction);
  const rangeBackground = {
    background: `linear-gradient(to right, #818cf8 0%, #818cf8 ${shownProgress * 100}%, rgba(255,255,255,.28) ${shownProgress * 100}%, rgba(255,255,255,.28) ${shownBuffered * 100}%, rgba(255,255,255,.12) ${shownBuffered * 100}%, rgba(255,255,255,.12) 100%)`,
  };
  const shownPlaying = tvCast ? tvState?.playerState !== 'PAUSED' && tvState?.playerState !== 'IDLE' : p.playing;
  const closePlayer = () => { if (tvCast) stopCasting(false); p.clear(); };
  const statusText = tvCast
    ? `Casting to ${tvCast.name}`
    : playbackError
      ? playbackError
      : phase === 'buffering'
        ? 'Buffering…'
        : phase === 'loading'
          ? 'Loading…'
          : p.current.subtitle || (p.current.kind === 'music' ? 'Music' : p.current.kind === 'audiobook' ? 'Audiobook' : 'Podcast');
  const canNext = canAdvanceQueue(p.queue.length, p.index, p.shuffle && p.current.kind === 'music', p.shuffleRemaining.length, p.current.kind === 'music' ? p.repeat : 'off');
  const repeatLabel = p.repeat === 'off' ? 'Repeat off' : p.repeat === 'all' ? 'Repeat queue' : 'Repeat current track';
  const tentativeNormalization = resolveLoudnessNormalization(p.current, p.normalizationEnabled, p.shuffle, true);
  const normalization = resolveLoudnessNormalization(p.current, p.normalizationEnabled, p.shuffle,
    webAudioDeclared || tentativeNormalization.multiplier <= 1 || p.volume * tentativeNormalization.multiplier <= 1);
  const normalizationStatus = tvCast && p.normalizationEnabled
    ? 'Enabled for local playback; Cast receiver volume is unchanged.'
    : normalization.message;
  const toggleNormalization = () => {
    const state = usePlayer.getState();
    const previous = state.normalizationEnabled;
    const next = !previous;
    const accountId = useAuth.getState().user?.id;
    normalizationPreferenceRevision.current += 1;
    state.setNormalizationEnabled(next);
    const audio = audioRef.current;
    if (audio) {
      applyAudioOutput(audio, state.current);
      const graph = audioGraphRef.current;
      if (graph?.context.state === 'suspended') void graph.context.resume().catch(() => {});
    }
    api.settings.preferences({ musicLoudnessNormalization: next }).catch(() => {
      if (useAuth.getState().user?.id === accountId && usePlayer.getState().normalizationEnabled === next) {
        usePlayer.getState().setNormalizationEnabled(previous);
      }
      toast('Could not save loudness setting', 'error');
    });
  };

  const finishLocalTrack = (audio: HTMLAudioElement) => {
    const state = usePlayer.getState();
    if (shouldLoopCurrentTrack(state.current?.kind || '', state.repeat, state.queue.length)) {
      audio.currentTime = 0;
      state.setProgress(0, effectiveDuration(audio));
      state.setPlaying(true);
      requestPlay(audio);
      return;
    }
    if (promotePreloadedNext()) return;
    const selection = state.selectionId;
    state.next();
    if (usePlayer.getState().selectionId === selection) setPhase('paused');
  };

  const failPlayback = (audio: HTMLAudioElement) => {
    clearRetryTimer();
    const state = usePlayer.getState();
    const error = audio.error;
    if (error?.code === 2 && retryCount.current < 1 && state.playing && navigator.onLine !== false) {
      retryCount.current += 1;
      pendingSeek.current = Math.max(0, audio.currentTime || state.currentTime || 0);
      setPhase('loading');
      retryTimer.current = setTimeout(() => {
        if (usePlayer.getState().selectionId !== state.selectionId) return;
        audio.load();
        requestPlay(audio);
      }, 1200);
      return;
    }
    const message = mediaErrorText(error);
    state.setPlaying(false);
    setPlaybackError(message);
    setPhase('error');
    if (lastErrorSelection.current !== state.selectionId) {
      lastErrorSelection.current = state.selectionId;
      toast('Playback failed', 'error', message);
    }
  };

  const applyPendingPosition = (audio: HTMLAudioElement) => {
    const state = usePlayer.getState();
    const requested = pendingSeek.current ?? state.current?.startAt ?? 0;
    const duration = effectiveDuration(audio);
    if (requested > 0) {
      const target = duration > 0 ? Math.min(requested, Math.max(0, duration - 0.1)) : requested;
      try { audio.currentTime = target; } catch { /* seek waits for a playable range */ }
    }
    pendingSeek.current = null;
    state.setProgress(audio.currentTime || requested || 0, duration);
    state.consumeStartAt();
  };

  const renderAudioDeck = (deckIndex: 0 | 1) => (
    <audio ref={deckIndex === 0 ? audioDeckARef : audioDeckBRef}
      data-aerie-player-engine={activeDeck === deckIndex ? 'true' : undefined}
      data-aerie-player-preload={activeDeck !== deckIndex ? 'true' : undefined}
      preload={activeDeck === deckIndex ? 'metadata' : 'auto'}
      onTimeUpdate={(e) => {
        if (audioRef.current !== e.currentTarget) return;
        const d = e.currentTarget.duration;
        p.setProgress(e.currentTarget.currentTime, d && isFinite(d) && d > 0 ? d : (usePlayer.getState().current?.durationSec || 0));
      }}
      onDurationChange={(e) => {
        if (audioRef.current === e.currentTarget) p.setProgress(e.currentTarget.currentTime, effectiveDuration(e.currentTarget));
      }}
      onProgress={(e) => {
        if (audioRef.current !== e.currentTarget) return;
        const audio = e.currentTarget;
        const duration = effectiveDuration(audio);
        if (!duration || !audio.buffered.length) return setBufferedFraction(0);
        let end = 0;
        for (let i = 0; i < audio.buffered.length; i += 1) end = Math.max(end, audio.buffered.end(i));
        setBufferedFraction(Math.max(0, Math.min(1, end / duration)));
      }}
      onEnded={(e) => { if (audioRef.current === e.currentTarget) finishLocalTrack(e.currentTarget); }}
      onLoadStart={(e) => { if (audioRef.current === e.currentTarget) { setPlaybackError(null); setPhase('loading'); } }}
      onLoadedMetadata={(e) => { if (audioRef.current === e.currentTarget) applyPendingPosition(e.currentTarget); }}
      onPlay={(e) => {
        if (audioRef.current !== e.currentTarget) return;
        p.setPlaying(true);
        if (e.currentTarget.readyState < HTMLMediaElement.HAVE_FUTURE_DATA) setPhase('loading');
      }}
      // Standby-deck events are ignored. In particular, pausing the old deck
      // during promotion must never flip the newly active track to paused.
      onPause={(e) => {
        if (audioRef.current !== e.currentTarget) return;
        const el = e.currentTarget;
        if (!el.ended && !el.seeking && el.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA && usePlayer.getState().playing) p.setPlaying(false);
        if (!playbackError && !el.ended) setPhase(usePlayer.getState().playing && el.readyState < HTMLMediaElement.HAVE_FUTURE_DATA ? 'buffering' : 'paused');
      }}
      onCanPlay={(e) => {
        if (audioRef.current !== e.currentTarget) return;
        clearRetryTimer();
        if (usePlayer.getState().playing && e.currentTarget.paused) requestPlay(e.currentTarget);
        else if (!usePlayer.getState().playing) setPhase('paused');
      }}
      onPlaying={(e) => {
        if (audioRef.current !== e.currentTarget) return;
        clearRetryTimer(); retryCount.current = 0; setPlaybackError(null); setPhase('playing'); p.setPlaying(true);
      }}
      onWaiting={(e) => { if (audioRef.current === e.currentTarget && usePlayer.getState().playing) setPhase('buffering'); }}
      onStalled={(e) => {
        const audio = e.currentTarget;
        if (audioRef.current !== audio || !usePlayer.getState().playing) return;
        setPhase('buffering');
        clearRetryTimer();
        const selection = usePlayer.getState().selectionId;
        retryTimer.current = setTimeout(() => {
          if (audioRef.current !== audio || usePlayer.getState().selectionId !== selection
            || !usePlayer.getState().playing || audio.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA) return;
          if (retryCount.current >= 1) {
            const message = 'The audio stream stopped responding.';
            usePlayer.getState().setPlaying(false);
            setPlaybackError(message);
            setPhase('error');
            if (lastErrorSelection.current !== selection) {
              lastErrorSelection.current = selection;
              toast('Playback stalled', 'error', message);
            }
            return;
          }
          retryCount.current += 1;
          pendingSeek.current = audio.currentTime || usePlayer.getState().currentTime || 0;
          audio.load();
          requestPlay(audio);
        }, 10000);
      }}
      onError={(e) => { if (audioRef.current === e.currentTarget) failPlayback(e.currentTarget); }}
      onSeeked={(e) => {
        if (audioRef.current !== e.currentTarget) return;
        const nat = (window as any).CloudBoxNative;
        const d = e.currentTarget.duration;
        const dur = d && isFinite(d) && d > 0 ? d : (usePlayer.getState().current?.durationSec || 0);
        usePlayer.getState().setProgress(e.currentTarget.currentTime, dur);
        if (!nat?.mediaPosition) return;
        try { nat.mediaPosition(Math.round(e.currentTarget.currentTime * 1000), Math.round(dur * 1000)); } catch { /* */ }
      }} />
  );

  return (
    <div className="shrink-0 h-24 sm:h-20 glass-strong border-t border-white/[0.07] px-3 sm:px-4 grid grid-cols-[minmax(0,1fr)_auto] sm:grid-cols-[minmax(150px,220px)_minmax(300px,1fr)] lg:grid-cols-[minmax(180px,240px)_minmax(300px,1fr)_minmax(130px,160px)] items-center gap-2 sm:gap-4 z-40 relative" role="region" aria-label="Audio player">
      {renderAudioDeck(0)}
      {renderAudioDeck(1)}

      <p className="sr-only" aria-live="polite">{phase === 'error' ? `Playback error: ${statusText}` : phase === 'buffering' ? 'Audio buffering' : ''}</p>

      {/* Track identity stays readable at phone widths; secondary actions move
          into Now Playing instead of competing with transport controls. */}
      <div className="flex items-center gap-2.5 min-w-0 pr-1">
        <button
          onClick={() => setExpanded(true)}
          title="Open now playing"
          aria-label={`Open Now Playing for ${p.current.title}`}
          className="group relative w-12 h-12 sm:w-14 sm:h-14 rounded-lg bg-ink-700 overflow-hidden shrink-0 shadow-card focus:outline-none focus:ring-2 focus:ring-brand-500"
        >
          {p.current.artUrl ? <img src={p.current.artUrl} alt="" className="w-full h-full object-cover" /> :
            <div className="w-full h-full grid place-items-center text-slate-600"><Icon.Music size={22} /></div>}
          <span className="absolute inset-0 grid place-items-center bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity text-white">
            <Icon.ChevronDown size={20} className="rotate-180" />
          </span>
        </button>
        <div className="min-w-0">
          <p className="text-sm font-medium text-white truncate">{p.current.title}</p>
          <p className={cx('text-xs truncate', playbackError ? 'text-red-300' : tvCast ? 'text-brand-400' : 'muted')}>{statusText}</p>
        </div>
      </div>

      {/* Mobile keeps the three primary controls large and obvious. */}
      <div className="sm:hidden flex items-center justify-end gap-0.5">
        <button type="button" className="icon-btn !w-11 !h-11" onClick={isBook ? () => skip(-15) : previousTrack}
          aria-label={isBook ? 'Back 15 seconds' : 'Previous track'} title={isBook ? 'Back 15 seconds' : 'Previous track'}>
          {isBook ? <Skip dir={-1} secs={15} /> : <Icon.Prev size={20} />}
        </button>
        <button type="button" className="w-11 h-11 rounded-full bg-white text-ink-900 grid place-items-center active:scale-95 transition-transform"
          onClick={playbackError ? retryLocalPlayback : togglePlayback}
          aria-label={playbackError ? 'Retry playback' : shownPlaying ? 'Pause' : 'Play'} title={playbackError ? 'Retry playback' : shownPlaying ? 'Pause' : 'Play'}>
          {playbackError ? <Icon.Refresh size={19} /> : shownPlaying ? <Icon.Pause size={20} /> : <Icon.Play size={20} />}
        </button>
        <button type="button" className="icon-btn !w-11 !h-11" onClick={isBook ? () => skip(30) : () => nextTrack()}
          disabled={!isBook && !canNext} aria-label={isBook ? 'Forward 30 seconds' : 'Next track'} title={isBook ? 'Forward 30 seconds' : 'Next track'}>
          {isBook ? <Skip dir={1} secs={30} /> : <Icon.Next size={20} />}
        </button>
      </div>

      {/* Desktop/tablet transport + scrubber. Secondary controls appear only
          when there is enough room, never squeezing title or timeline. */}
      <div className="hidden sm:flex min-w-0 flex-col items-center gap-1 max-w-2xl w-full mx-auto">
        <div className="flex items-center gap-1">
          {!isBook && <button type="button" className={cx('icon-btn !w-11 !h-11 hidden md:grid', p.shuffle && 'text-brand-400')} onClick={p.toggleShuffle}
            aria-label={p.shuffle ? 'Turn shuffle off' : 'Turn shuffle on'} aria-pressed={p.shuffle} title={p.shuffle ? 'Shuffle on' : 'Shuffle off'}><Icon.Shuffle size={17} /></button>}
          <button type="button" className="icon-btn !w-11 !h-11" onClick={isBook ? () => skip(-15) : previousTrack}
            aria-label={isBook ? 'Back 15 seconds' : 'Previous track'} title={isBook ? 'Back 15 seconds' : 'Previous track'}>
            {isBook ? <Skip dir={-1} secs={15} /> : <Icon.Prev size={19} />}
          </button>
          <button type="button" className="w-11 h-11 rounded-full bg-white text-ink-900 grid place-items-center hover:scale-105 transition-transform"
            onClick={playbackError ? retryLocalPlayback : togglePlayback}
            aria-label={playbackError ? 'Retry playback' : shownPlaying ? 'Pause' : 'Play'} title={playbackError ? 'Retry playback' : shownPlaying ? 'Pause' : 'Play'}>
            {playbackError ? <Icon.Refresh size={19} /> : shownPlaying ? <Icon.Pause size={20} /> : <Icon.Play size={20} />}
          </button>
          <button type="button" className="icon-btn !w-11 !h-11" onClick={isBook ? () => skip(30) : () => nextTrack()}
            disabled={!isBook && !canNext} aria-label={isBook ? 'Forward 30 seconds' : 'Next track'} title={isBook ? 'Forward 30 seconds' : 'Next track'}>
            {isBook ? <Skip dir={1} secs={30} /> : <Icon.Next size={19} />}
          </button>
          {!isBook && <button type="button" className={cx('icon-btn !w-11 !h-11 hidden md:grid relative', p.repeat !== 'off' && 'text-brand-400')} onClick={p.cycleRepeat}
            aria-label={repeatLabel} title={repeatLabel} aria-pressed={p.repeat !== 'off'}>
            <Icon.Repeat size={17} />{p.repeat === 'one' && <span className="absolute text-[9px] font-bold">1</span>}
          </button>}
        </div>
        <div className="flex items-center gap-2 w-full">
          <span className="text-[11px] tabular-nums muted w-10 text-right">{formatDuration(shownTime)}</span>
          <input type="range" min={0} max={100} step={0.1} value={shownProgress * 100 || 0} onChange={seek}
            disabled={shownDuration <= 0 || (!!tvCast && !tvCanSeek)} className="cb-range aerie-player-seek flex-1 disabled:opacity-40"
            style={rangeBackground}
            aria-label="Playback position" aria-valuetext={`${formatDuration(shownTime)} of ${shownDuration > 0 ? formatDuration(shownDuration) : 'unknown'}`} />
          <span className="text-[11px] tabular-nums muted w-10">{shownDuration > 0 ? formatDuration(shownDuration) : '--:--'}</span>
        </div>
      </div>

      {/* Desktop volume and lifecycle actions. Cast/download remain available in
          Now Playing at every width, and appear here only on wide screens. */}
      <div className="hidden lg:flex items-center justify-end gap-0.5 min-w-0">
        {p.current.cast && <button type="button" className={cx('icon-btn !w-10 !h-10 hidden xl:grid', (tvCast || castBusy) && 'text-brand-400')} onClick={() => setCastOpen(true)}
          aria-label="Cast audio" title="Cast audio"><CastIcon /></button>}
        {downloads.supported() && <button type="button" className={cx('icon-btn !w-10 !h-10 hidden xl:grid', downloads.has(p.current.id) && 'text-brand-400')} onClick={saveCurrent}
          aria-label={downloadPct == null ? 'Download for offline' : `Downloading ${downloadPct}%`} title={downloadPct == null ? 'Download for offline' : `Downloading ${downloadPct}%`}><Icon.Download size={18} /></button>}
        <button type="button" className="icon-btn !w-10 !h-10" onClick={() => p.setMuted(!p.muted)}
          aria-label={p.muted ? 'Unmute' : 'Mute'} aria-pressed={p.muted} title={p.muted ? 'Unmute (M)' : 'Mute (M)'}>
          {p.muted ? <MutedIcon size={18} /> : <Icon.Volume size={18} />}
        </button>
        <input type="range" min={0} max={1} step={0.01} value={p.volume} onChange={(e) => p.setVolume(Number(e.target.value))}
          className="cb-range flex-1 min-w-0 max-w-20" aria-label="Volume" aria-valuetext={`${Math.round(p.volume * 100)} percent`} />
        <button type="button" className="icon-btn !w-10 !h-10" onClick={closePlayer} aria-label="Stop playback and clear queue" title="Stop playback and clear queue"><Icon.Close size={16} /></button>
      </div>

      {/* Phone timeline gets its own row and hit area instead of being wedged
          between eight controls. */}
      <label className="sm:hidden absolute inset-x-3 bottom-0 h-6 flex items-center" title="Playback position">
        <span className="sr-only">Playback position</span>
        <input type="range" min={0} max={100} step={0.1} value={shownProgress * 100 || 0} onChange={seek}
          disabled={shownDuration <= 0 || (!!tvCast && !tvCanSeek)} className="cb-range aerie-player-seek w-full disabled:opacity-40"
          style={rangeBackground}
          aria-label="Playback position" aria-valuetext={`${formatDuration(shownTime)} of ${shownDuration > 0 ? formatDuration(shownDuration) : 'unknown'}`} />
      </label>

      {expanded && <NowPlayingCard p={p} isBook={isBook} seek={seek} skip={skip} onClose={() => setExpanded(false)}
        currentTime={shownTime} duration={shownDuration} progress={shownProgress} playing={shownPlaying}
        onToggle={playbackError ? retryLocalPlayback : togglePlayback} onNext={() => nextTrack()} onPrev={previousTrack} onPlayAt={(i) => tvCast ? castQueueTrack(tvCast, i) : p.playAt(i)}
        onCast={p.current.cast ? () => setCastOpen(true) : undefined} onDownload={downloads.supported() ? saveCurrent : undefined}
        downloadLabel={downloadPct == null ? (downloads.has(p.current.id) ? 'Saved offline' : 'Download for offline') : `Downloading ${downloadPct}%`}
        castingName={tvCast?.name} onClear={closePlayer} phase={phase} playbackError={playbackError}
        muted={p.muted} volume={p.volume} onMute={() => p.setMuted(!p.muted)} onVolume={p.setVolume}
        playbackRate={p.playbackRate} onPlaybackRate={p.setPlaybackRate} shortcutsDisabled={castOpen}
        normalizationEnabled={p.normalizationEnabled} normalizationStatus={normalizationStatus} onNormalization={toggleNormalization} />}

      {castOpen && createPortal(
        <div className="fixed inset-0 z-[220] bg-black/60 backdrop-blur-sm flex items-end sm:items-center justify-center p-4" onClick={() => setCastOpen(false)}>
          <div ref={castDialogRef} className="glass-strong rounded-2xl shadow-float w-full max-w-sm overflow-hidden" onClick={e => e.stopPropagation()}
            role="dialog" aria-modal="true" aria-label="Cast audio" tabIndex={-1}>
            <div className="px-4 py-3 border-b border-white/10 flex items-center gap-3">
              <CastIcon size={22} /><div className="min-w-0 flex-1"><p className="font-semibold text-white">Cast audio</p><p className="text-xs muted truncate">{p.current.title}</p></div>
              <button className="icon-btn !w-11 !h-11" onClick={() => setCastOpen(false)} aria-label="Close Cast devices" title="Close"><Icon.Close size={17} /></button>
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
              {tvCast && <button className="btn-secondary !min-h-11 flex-1 justify-center" onClick={() => { setCastOpen(false); stopCasting(true); }}>Stop casting</button>}
              <button className="btn-secondary !min-h-11 flex-1 justify-center" disabled={castBusy} onClick={() => api.cast.devices(true).then(d => setCastDevices(d || [])).catch(() => {})}>{castBusy ? 'Connecting…' : 'Refresh'}</button>
            </div>
          </div>
        </div>, document.body,
      )}
    </div>
  );
}

// Full-screen "Now Playing" card (opens when the bar artwork is tapped). Reuses
// the same <audio> engine + store; it only renders a bigger surface.
function NowPlayingCard({ p, isBook, seek, skip, onClose, currentTime, duration, progress, playing, onToggle, onNext, onPrev, onPlayAt, onCast, onDownload, downloadLabel, castingName, onClear, phase, playbackError, muted, volume, onMute, onVolume, playbackRate, onPlaybackRate, shortcutsDisabled, normalizationEnabled, normalizationStatus, onNormalization }: {
  p: ReturnType<typeof usePlayer.getState>; isBook: boolean;
  seek: (e: React.ChangeEvent<HTMLInputElement>) => void; skip: (secs: number) => void; onClose: () => void;
  currentTime: number; duration: number; progress: number; playing: boolean;
  onToggle: () => void; onNext: () => void; onPrev: () => void; onPlayAt: (i: number) => void | boolean;
  onCast?: () => void; onDownload?: () => void; downloadLabel: string; castingName?: string; onClear: () => void;
  phase: PlaybackPhase; playbackError: string | null; muted: boolean; volume: number; onMute: () => void; onVolume: (volume: number) => void;
  playbackRate: number; onPlaybackRate: (rate: number) => void; shortcutsDisabled: boolean;
  normalizationEnabled: boolean; normalizationStatus: string; onNormalization: () => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const shortcutActions = useRef({ onClose, onToggle, onMute, skip, isBook, shortcutsDisabled });
  shortcutActions.current = { onClose, onToggle, onMute, skip, isBook, shortcutsDisabled };
  usePlayerDialog(dialogRef, shortcutsDisabled);
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      const actions = shortcutActions.current;
      if (actions.shortcutsDisabled) return;
      if (e.key === 'Escape') { e.preventDefault(); actions.onClose(); return; }
      const target = e.target as HTMLElement | null;
      if (target?.closest('input, textarea, select, button, a, [contenteditable="true"]')) return;
      const key = e.key.toLowerCase();
      if (e.code === 'Space' || key === 'k') { e.preventDefault(); actions.onToggle(); }
      else if (key === 'm') { e.preventDefault(); actions.onMute(); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); actions.skip(actions.isBook ? -15 : -5); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); actions.skip(actions.isBook ? 30 : 5); }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, []);
  const cur = p.current!;
  // Music with a real queue (an album/playlist) shows the tracklist, like any
  // proper player. A single track or an audiobook keeps the big-artwork layout.
  const showList = !isBook && p.queue.length > 1;
  const canNext = canAdvanceQueue(p.queue.length, p.index, p.shuffle && p.current?.kind === 'music', p.shuffleRemaining.length, p.current?.kind === 'music' ? p.repeat : 'off');
  const upcomingCount = p.shuffle && p.current?.kind === 'music' ? p.shuffleRemaining.length : Math.max(0, p.queue.length - p.index - 1);
  // Portal to <body>: the audio bar uses backdrop-blur (backdrop-filter), which
  // makes it the containing block for fixed children — without the portal the
  // card would be trapped inside the 80px bar instead of covering the viewport.
  return createPortal(
    <div
      ref={dialogRef}
      className="fixed inset-0 z-[130] flex flex-col items-center animate-fade-in overflow-hidden"
      role="dialog"
      aria-modal="true"
      aria-label={`Now playing: ${cur.title}`}
      aria-hidden={shortcutsDisabled ? true : undefined}
      tabIndex={-1}
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
          <button className="icon-btn !h-11 !w-11 text-white hover:bg-white/10" onClick={onClose} title="Collapse Now Playing (Escape)" aria-label="Collapse Now Playing"><Icon.ChevronDown size={24} /></button>
          <span className="flex-1 text-center text-[11px] uppercase tracking-widest text-slate-400 min-w-0 truncate px-1">
            {castingName ? `Casting to ${castingName}` : cur.kind === 'audiobook' ? 'Audiobook' : cur.kind === 'podcast' ? 'Podcast' : 'Now Playing'}
          </span>
          <div className="flex items-center">
            {onDownload && <button className="icon-btn !h-11 !w-11 text-white hover:bg-white/10" onClick={onDownload} title={downloadLabel} aria-label={downloadLabel}><Icon.Download size={19} /></button>}
            {onCast && <button className={cx('icon-btn !h-11 !w-11 hover:bg-white/10', castingName ? 'text-brand-400' : 'text-white')} onClick={onCast} title="Cast audio" aria-label="Cast audio"><CastIcon /></button>}
            <button className="icon-btn !h-11 !w-11 text-white hover:bg-white/10" onClick={() => { onClear(); onClose(); }} title="Stop playback and clear queue" aria-label="Stop playback and clear queue"><Icon.Close size={20} /></button>
          </div>
        </div>

        {/* Artwork. Without a tracklist it fills the free height (object-contain so
            it never pushes controls off a short screen); with a tracklist it's a
            fixed medium size to leave room for the list. */}
        <div className={cx('flex items-center justify-center w-full py-4', showList ? 'shrink-0' : 'flex-1 min-h-0')}>
          {cur.artUrl
            ? <img src={cur.artUrl} alt="" className={cx('object-cover rounded-2xl shadow-float aspect-square', showList ? 'w-36 h-36 sm:w-44 sm:h-44' : 'max-h-full max-w-full w-auto object-contain')} />
            : <div className={cx('rounded-2xl bg-ink-800 grid place-items-center text-slate-600 shadow-float aspect-square', showList ? 'w-40 h-40' : 'h-full max-h-full')}>{isBook ? <Icon.Book size={64} /> : <Icon.Music size={64} />}</div>}
        </div>

        <div className="w-full text-center mb-4 shrink-0">
          <p className="text-xl font-bold text-white truncate">{cur.title}</p>
          {cur.subtitle && <p className="text-sm text-slate-400 truncate mt-1">{cur.subtitle}</p>}
          {(playbackError || phase === 'buffering' || phase === 'loading') && (
            <p className={cx('text-xs truncate mt-1', playbackError ? 'text-red-300' : 'text-brand-300')} aria-live="polite">
              {playbackError || (phase === 'buffering' ? 'Buffering…' : 'Loading…')}
            </p>
          )}
        </div>

        <div className="w-full flex items-center gap-2 mb-5 shrink-0">
          <span className="text-[11px] tabular-nums text-slate-400 w-10 text-right">{formatDuration(currentTime)}</span>
          <input type="range" min={0} max={100} step={0.1} value={progress * 100 || 0} onChange={seek} disabled={duration <= 0}
            className="cb-range aerie-player-seek flex-1 disabled:opacity-40" aria-label="Playback position"
            style={{ background: `linear-gradient(to right, #818cf8 0%, #818cf8 ${Math.max(0, Math.min(1, progress)) * 100}%, rgba(255,255,255,.12) ${Math.max(0, Math.min(1, progress)) * 100}%, rgba(255,255,255,.12) 100%)` }}
            aria-valuetext={`${formatDuration(currentTime)} of ${duration > 0 ? formatDuration(duration) : 'unknown'}`} />
          <span className="text-[11px] tabular-nums text-slate-400 w-10">{duration > 0 ? formatDuration(duration) : '--:--'}</span>
        </div>

        <div className="w-full flex items-center justify-center gap-2 sm:gap-4 shrink-0">
          {isBook ? (
            <>
              <button className="icon-btn !h-12 !w-12 text-white hover:bg-white/10" onClick={() => skip(-15)} title="Back 15 seconds (Left arrow)" aria-label="Back 15 seconds"><Skip dir={-1} secs={15} /></button>
              <button className="w-14 h-14 sm:w-16 sm:h-16 rounded-full bg-white text-ink-900 grid place-items-center hover:scale-105 transition-transform" onClick={onToggle}
                title={playbackError ? 'Retry playback' : playing ? 'Pause (Space or K)' : 'Play (Space or K)'} aria-label={playbackError ? 'Retry playback' : playing ? 'Pause' : 'Play'}>
                {playbackError ? <Icon.Refresh size={26} /> : playing ? <Icon.Pause size={28} /> : <Icon.Play size={28} />}
              </button>
              <button className="icon-btn !h-12 !w-12 text-white hover:bg-white/10" onClick={() => skip(30)} title="Forward 30 seconds (Right arrow)" aria-label="Forward 30 seconds"><Skip dir={1} secs={30} /></button>
            </>
          ) : (
            <>
              <button className={cx('icon-btn !h-11 !w-11', p.shuffle ? 'text-brand-400' : 'text-white')} onClick={p.toggleShuffle}
                aria-label={p.shuffle ? 'Turn shuffle off' : 'Turn shuffle on'} aria-pressed={p.shuffle} title={p.shuffle ? 'Shuffle on' : 'Shuffle off'}><Icon.Shuffle size={19} /></button>
              <button className="icon-btn !h-12 !w-12 text-white hover:bg-white/10" onClick={onPrev} title="Previous track" aria-label="Previous track"><Icon.Prev size={24} /></button>
              <button className="w-14 h-14 sm:w-16 sm:h-16 rounded-full bg-white text-ink-900 grid place-items-center hover:scale-105 transition-transform" onClick={onToggle}
                title={playbackError ? 'Retry playback' : playing ? 'Pause (Space or K)' : 'Play (Space or K)'} aria-label={playbackError ? 'Retry playback' : playing ? 'Pause' : 'Play'}>
                {playbackError ? <Icon.Refresh size={26} /> : playing ? <Icon.Pause size={28} /> : <Icon.Play size={28} />}
              </button>
              <button className="icon-btn !h-12 !w-12 text-white hover:bg-white/10" onClick={onNext} disabled={!canNext} title="Next track" aria-label="Next track"><Icon.Next size={24} /></button>
              <button className={cx('icon-btn !h-11 !w-11 relative', p.repeat !== 'off' ? 'text-brand-400' : 'text-white')} onClick={p.cycleRepeat}
                aria-label={p.repeat === 'off' ? 'Repeat off' : p.repeat === 'all' ? 'Repeat queue' : 'Repeat current track'} aria-pressed={p.repeat !== 'off'}
                title={p.repeat === 'off' ? 'Repeat off' : p.repeat === 'all' ? 'Repeat queue' : 'Repeat current track'}>
                <Icon.Repeat size={19} />{p.repeat === 'one' && <span className="absolute text-[9px] font-bold">1</span>}
              </button>
            </>
          )}
        </div>

        <div className="w-full max-w-xs flex items-center gap-2 mt-3 shrink-0">
          {isBook && !castingName && <button className="h-11 min-w-11 px-2 rounded-lg text-xs font-semibold text-white hover:bg-white/10"
            onClick={() => {
              onPlaybackRate(LONGFORM_SPEEDS.find(speed => speed > playbackRate + 0.001) ?? LONGFORM_SPEEDS[0]);
            }} aria-label={`Playback speed ${playbackRate} times`} title="Change playback speed">
            {playbackRate}×
          </button>}
          <button className="icon-btn !h-11 !w-11 text-white" onClick={onMute} aria-label={muted ? 'Unmute' : 'Mute'} aria-pressed={muted} title={muted ? 'Unmute (M)' : 'Mute (M)'}>
            {muted ? <MutedIcon size={19} /> : <Icon.Volume size={19} />}
          </button>
          <input type="range" min={0} max={1} step={0.01} value={volume} onChange={e => onVolume(Number(e.target.value))}
            className="cb-range flex-1" aria-label="Volume" aria-valuetext={`${Math.round(volume * 100)} percent`} />
        </div>

        {!isBook && (
          <div className="w-full mt-2 shrink-0 flex items-center gap-3 rounded-xl bg-white/[0.04] px-3 py-2">
            <button type="button" role="switch" aria-checked={normalizationEnabled} onClick={onNormalization}
              className={cx('h-9 shrink-0 rounded-lg px-3 text-xs font-semibold transition-colors',
                normalizationEnabled ? 'bg-brand-500/20 text-brand-200' : 'bg-white/[0.05] text-slate-300 hover:text-white')}
              title="Use exact library loudness metadata when available">
              Normalize {normalizationEnabled ? 'on' : 'off'}
            </button>
            <p className="min-w-0 text-[11px] leading-4 text-slate-400" aria-live="polite">{normalizationStatus}</p>
          </div>
        )}

        {showList && (
          <div className="w-full flex-1 min-h-0 overflow-y-auto mt-4 -mx-1 px-1" role="list" aria-label="Playback queue">
            <div className="flex items-center justify-between gap-2 mb-2 px-2">
              <p className="text-[11px] uppercase tracking-widest text-slate-500">Queue · track {p.index + 1} of {p.queue.length}</p>
              <button type="button" onClick={p.clearUpcoming} disabled={upcomingCount === 0}
                className="min-h-9 px-2 rounded-lg text-[11px] text-slate-400 hover:text-white hover:bg-white/[0.06] disabled:opacity-40 disabled:pointer-events-none">
                Clear upcoming
              </button>
            </div>
            {p.queue.map((t, i) => (
              <div
                key={`${t.id}-${i}`}
                aria-current={i === p.index ? 'true' : undefined}
                role="listitem"
                className={cx('group w-full flex items-center rounded-lg px-1 py-1 transition',
                  i === p.index ? 'bg-white/10' : 'hover:bg-white/[0.05]')}
              >
                <button onClick={() => onPlayAt(i)} disabled={!!castingName && !t.cast}
                  title={castingName && !t.cast
                    ? `${t.title} cannot be cast from this source`
                    : i === p.index ? `Currently playing ${t.title}` : `Play ${t.title}`}
                  className="min-w-0 flex-1 flex items-center gap-2 px-1 py-1.5 text-left rounded-md disabled:opacity-50 disabled:cursor-not-allowed">
                  <span className="w-6 shrink-0 text-center text-xs tabular-nums">
                    {i === p.index
                      ? <Icon.Volume size={15} className="mx-auto text-brand-400" />
                      : <span className="text-slate-500">{i + 1}</span>}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className={cx('block truncate text-sm', i === p.index ? 'text-brand-300 font-medium' : 'text-white')}>{t.title}</span>
                    {t.subtitle && <span className="block truncate text-xs text-slate-500">{t.subtitle}</span>}
                  </span>
                  {t.durationSec ? <span className="hidden sm:inline shrink-0 text-[11px] tabular-nums text-slate-500">{formatDuration(t.durationSec)}</span> : null}
                </button>
                <div className="shrink-0 flex items-center sm:opacity-0 sm:group-hover:opacity-100 sm:focus-within:opacity-100 transition-opacity">
                  <button className="icon-btn !w-10 !h-10" disabled={i === 0} onClick={() => p.moveTrack(i, i - 1)}
                    aria-label={`Move ${t.title} up`} title="Move up"><Icon.ChevronDown size={16} className="rotate-180" /></button>
                  <button className="icon-btn !w-10 !h-10" disabled={i === p.queue.length - 1} onClick={() => p.moveTrack(i, i + 1)}
                    aria-label={`Move ${t.title} down`} title="Move down"><Icon.ChevronDown size={16} /></button>
                  <button className="icon-btn !w-10 !h-10 hover:text-red-300" disabled={!!castingName && i === p.index} onClick={() => p.removeAt(i)}
                    aria-label={`Remove ${t.title} from queue`} title={castingName && i === p.index ? 'Stop casting before removing the current track' : 'Remove from queue'}><Icon.Close size={15} /></button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
