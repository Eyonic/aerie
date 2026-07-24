// Reusable media components: poster/cover cards, horizontal rails, and a
// fullscreen HLS video player. Shared by Movies, TV, Videos, Music.
import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from '../lib/icons';
import { cx, ticksToTime, formatDuration } from '../lib/utils';
import { api } from '../lib/api';
import type { MediaItem, TranslationCapabilities, TranslationPreferences } from '../lib/model';
import { toast, useAuth, usePlayer } from '../lib/store';
import { Spinner } from './ui';
import { VideoUpscaler, upscaleSupported } from '../lib/upscaler';
import { publicUrlSync } from '../lib/serverinfo';
import { imageSrcSet } from '../lib/images';
import { downloads } from '../lib/downloads';
import { episodeNeighbors, episodeNumberLabel, orderEpisodes } from '../lib/episodes';
import { applyPlaybackRate, playbackRateLabel, stepPlaybackRate, VIDEO_PLAYBACK_RATES } from '../lib/playback-rate';
import { popupNavigationIndex, popupTabNavigationIndex, usePlayerDialog, usePopupFocusReturn, type PopupNavigationKey } from '../lib/player-dialog';
import { resolveStreamReloadIntent, whenMediaMetadataReady, type StreamReloadIntent } from '../lib/media-lifecycle';
import { loadVideoVolume, saveVideoVolume, type VideoVolumePreference } from '../lib/video-volume';
import {
  castProgressSnapshot,
  episodeProgressSnapshot,
  episodeResumeSeconds,
  isFinishedCastState,
  transitionCastEpisode,
  type CastPlaybackResponse,
  type EpisodeSessionProgress,
} from '../lib/cast-episode';
import { beginCastLoad, ownsCastLoad, releaseCastLoad, type CastLoadLease } from '../lib/cast-load-lease';
import {
  activeVideoChapterIndex,
  audioTrackDisplayLabel,
  autoplayNeedsInteraction,
  loadVideoPlaybackPreferences,
  matcherForTrack,
  normalizeTrackLanguage,
  parseVideoPlaybackPreferences,
  sanitizeVideoChapters,
  saveVideoPlaybackPreferences,
  selectPreferredAudioTrack,
  selectPreferredSubtitleTrack,
  type SubtitleAppearance,
  type SubtitleMode,
  type VideoChapter,
  type VideoPlaybackPreferences,
} from '../lib/video-preferences';
import {
  PLAYBACK_QUALITY_IDS,
  parseVideoPlaybackPlan,
  playbackStatusLabel,
  playbackVariantForHlsLevel,
  type PlaybackVariant,
  type PlaybackQuality,
  type VideoPlaybackPlan,
} from '../lib/video-playback-plan';

// 2K GPU upscaling is desktop-only (Windows/Linux): phone GPUs and Android's
// WebView can't sustain per-frame FSR at 1440p, and macOS stays on AirPlay.
const UPSCALE_PLATFORM = typeof navigator !== 'undefined'
  && /Windows NT|Linux/.test(navigator.userAgent)
  && !/Android|Mobile/.test(navigator.userAgent);

let automaticAudioChannelsProbe: Promise<2 | 6> | null = null;
function automaticAudioChannels(): Promise<2 | 6> {
  if (automaticAudioChannelsProbe) return automaticAudioChannelsProbe;
  automaticAudioChannelsProbe = (async () => {
    const Context = (window as any).AudioContext || (window as any).webkitAudioContext;
    if (!Context || !navigator.mediaCapabilities?.decodingInfo) return 2;
    let context: AudioContext | null = null;
    try {
      context = new Context();
      if ((context.destination.maxChannelCount || 0) < 6) return 2;
      const result = await navigator.mediaCapabilities.decodingInfo({
        type: 'file',
        audio: { contentType: 'audio/mp4; codecs="mp4a.40.2"', channels: '6', bitrate: 640_000, samplerate: 48_000 },
      });
      return result.supported && result.smooth ? 6 : 2;
    } catch { return 2; }
    finally { try { await context?.close(); } catch { /* no active context */ } }
  })();
  return automaticAudioChannelsProbe;
}

function browserPlaybackQuery(video: HTMLVideoElement, nativeHls: boolean, audioChannels: 2 | 6): Record<string, string | number> {
  const supports = (mime: string) => { try { return video.canPlayType(mime) !== ''; } catch { return false; } };
  const audio = document.createElement('audio');
  const supportsAudio = (mime: string) => { try { return audio.canPlayType(mime) !== ''; } catch { return false; } };
  const containers = [
    ...(supports('video/mp4') ? ['mp4', 'm4v', 'mov'] : []),
    ...(supports('video/webm') ? ['webm'] : []),
  ];
  const videoCodecs = [
    ...(supports('video/mp4; codecs="avc1.42E01E"') ? ['h264'] : []),
    ...(supports('video/mp4; codecs="hvc1"') ? ['hevc'] : []),
    ...(supports('video/webm; codecs="vp9"') || supports('video/mp4; codecs="vp09.00.10.08"') ? ['vp9'] : []),
    ...(supports('video/mp4; codecs="av01.0.05M.08"') || supports('video/webm; codecs="av1"') ? ['av1'] : []),
  ];
  const audioCodecs = [
    ...(supportsAudio('audio/mp4; codecs="mp4a.40.2"') ? ['aac'] : []),
    ...(supportsAudio('audio/mpeg') ? ['mp3'] : []),
    ...(supportsAudio('audio/webm; codecs="opus"') ? ['opus'] : []),
    ...(supportsAudio('audio/ogg; codecs="vorbis"') ? ['vorbis'] : []),
    ...(supportsAudio('audio/flac') ? ['flac'] : []),
    ...(supportsAudio('audio/mp4; codecs="ac-3"') ? ['ac3'] : []),
    ...(supportsAudio('audio/mp4; codecs="ec-3"') ? ['eac3'] : []),
  ];
  const pixelRatio = Math.max(1, Math.min(4, window.devicePixelRatio || 1));
  const maxWidth = Math.max(320, Math.min(7680, Math.round((window.screen?.width || window.innerWidth || 1920) * pixelRatio)));
  const maxHeight = Math.max(240, Math.min(4320, Math.round((window.screen?.height || window.innerHeight || 1080) * pixelRatio)));
  return {
    containers: (containers.length ? containers : ['mp4', 'm4v', 'mov']).join(','),
    videoCodecs: (videoCodecs.length ? videoCodecs : ['h264']).join(','),
    audioCodecs: (audioCodecs.length ? audioCodecs : ['aac', 'mp3']).join(','),
    audioChannels,
    maxWidth,
    maxHeight,
    direct: 1,
    native: nativeHls ? 1 : 0,
  };
}

function translatedLanguageName(code: string): string {
  try { return new Intl.DisplayNames([navigator.language || 'en'], { type: 'language' }).of(code) || code; }
  catch { return code; }
}

function subtitleJobError(value: unknown): string {
  const message = String(value || 'Subtitle job failed.');
  if (message === 'translation_provider_changed') return 'Your translation engine changed. Start again with the new setting.';
  if (message === 'external_translation_provider_unavailable') return 'The cloud translation provider is no longer available or permitted.';
  if (message === 'local_translation_provider_unavailable') return 'The local translation provider is not configured.';
  if (message === 'subtitle_translation_failed') return 'The translator returned no usable result. No partial subtitle was saved.';
  if (message === 'translation_language_not_configured') return 'That target language is no longer selected in Settings.';
  return message;
}

export function PosterCard({ item, onClick, aspect = 'portrait' }: { item: MediaItem; onClick?: () => void; aspect?: 'portrait' | 'landscape' | 'square' }) {
  const ar = aspect === 'portrait' ? 'aspect-[2/3]' : aspect === 'landscape' ? 'aspect-video' : 'aspect-square';
  const img = item.posterUrl || item.thumbUrl || item.backdropUrl;
  const widths = aspect === 'landscape' ? [320, 640, 960] : [240, 480];
  const sizes = aspect === 'landscape' ? '(max-width: 640px) 80vw, 256px' : '(max-width: 640px) 44vw, 144px';
  return (
    <button onClick={onClick} className="group text-left w-full">
      <div className={cx('relative rounded-xl overflow-hidden bg-ink-800 shadow-card card-hover', ar)}>
        {img ? <img src={img} srcSet={imageSrcSet(img, widths)} sizes={sizes} loading="lazy" decoding="async" className="w-full h-full object-cover" /> :
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
type SubSel = number | string | null;

function handlePopupListKeyDown(event: React.KeyboardEvent<HTMLElement>, onClose: () => void) {
  if (event.key === 'Escape') {
    event.preventDefault();
    event.stopPropagation();
    onClose();
    return;
  }
  const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not([disabled])'));
  if (event.key === 'Tab') {
    const nextIndex = popupTabNavigationIndex(
      items.findIndex(item => item === document.activeElement),
      items.length,
      event.shiftKey,
    );
    if (nextIndex < 0) return;
    event.preventDefault();
    event.stopPropagation();
    items[nextIndex].focus();
    return;
  }
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
  const nextIndex = popupNavigationIndex(
    event.key as PopupNavigationKey,
    items.findIndex(item => item === document.activeElement),
    items.length,
  );
  if (nextIndex < 0) return;
  event.preventDefault();
  event.stopPropagation();
  items[nextIndex].focus();
}

function handlePopupDialogKeyDown(event: React.KeyboardEvent<HTMLElement>, onClose: () => void) {
  if (event.key === 'Escape') {
    event.preventDefault();
    event.stopPropagation();
    onClose();
    return;
  }
  if (event.key !== 'Tab') return;
  const items = Array.from(event.currentTarget.querySelectorAll<HTMLElement>(
    'button:not([disabled]), input:not([disabled]), select:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])',
  ));
  const nextIndex = popupTabNavigationIndex(
    items.findIndex(item => item === document.activeElement),
    items.length,
    event.shiftKey,
  );
  if (nextIndex < 0) return;
  event.preventDefault();
  event.stopPropagation();
  items[nextIndex].focus();
}

function TrackMenu({ open, onClose, heading, options, current, onPick, tools, footer }: {
  open: boolean; onClose: () => void; heading: string;
  options: { key: string; label: string; value: SubSel }[];
  current: SubSel; onPick: (v: SubSel) => void;
  tools?: { key: string; label: string; detail?: string; disabled?: boolean; onClick: () => void }[];
  footer?: React.ReactNode;
}) {
  const popupRef = useRef<HTMLDivElement>(null);
  usePopupFocusReturn(open, popupRef);
  if (!open) return null;
  return (
    <>
      <div className="fixed inset-0 z-[310]" aria-hidden="true" onClick={onClose} />
      <div ref={popupRef} role="dialog" aria-label={`${heading} menu`} tabIndex={-1}
        onKeyDown={event => handlePopupListKeyDown(event, onClose)}
        className="absolute right-2 top-[max(3.75rem,calc(env(safe-area-inset-top)+3.25rem))] z-[320] w-80 max-w-[86vw] glass-strong rounded-xl shadow-float overflow-hidden animate-fade-in">
        <p className="px-3 py-2 text-[11px] uppercase tracking-wide text-slate-400 border-b border-white/10">{heading}</p>
        <div className="max-h-[52vh] overflow-y-auto py-1">
          {options.map(o => (
            <button key={o.key} type="button" onClick={() => onPick(o.value)}
              className={cx('w-full min-h-11 text-left px-3 py-2.5 text-sm flex items-center gap-2 hover:bg-white/10 active:bg-white/15',
                o.value === current ? 'text-brand-400' : 'text-white')}>
              <span className="w-4 shrink-0 grid place-items-center">{o.value === current && <Icon.Check size={16} />}</span>
              <span className="truncate">{o.label}</span>
            </button>
          ))}
          {footer}
          {tools && (
            <div className="mt-1 pt-1 border-t border-white/10">
              <p className="px-3 py-2 text-[11px] uppercase tracking-wide text-slate-400">AI tools</p>
              {tools.map(t => (
                <button key={t.key} type="button" disabled={t.disabled} onClick={t.onClick}
                  className={cx('w-full min-h-11 text-left px-3 py-2.5 text-sm flex items-start gap-2 hover:bg-white/10 active:bg-white/15 text-white disabled:text-slate-500 disabled:hover:bg-transparent')}>
                  <span className="w-4 shrink-0" />
                  <span className="min-w-0 leading-snug">
                    <span className="block whitespace-normal break-words">{t.label}</span>
                    {t.detail && <span className="mt-0.5 block whitespace-normal break-words text-[11px] text-slate-500">{t.detail}</span>}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </>
  );
}

// Big-tap-target control button used in the player top bar. `dim` renders an
// inert-looking (but still tappable) state so blocked features can explain why.
function CtrlBtn({ onClick, title, active, dim, popup, expanded, children }: {
  onClick: () => void; title: string; active?: boolean; dim?: boolean;
  popup?: 'menu' | 'dialog'; expanded?: boolean; children: React.ReactNode;
}) {
  return (
    <button type="button" onClick={onClick} title={title} aria-label={title}
      aria-haspopup={popup} aria-expanded={popup ? expanded === true : undefined}
      className={cx('w-11 h-11 grid place-items-center rounded-full transition-colors shrink-0',
        active ? 'bg-brand-500 text-white shadow-glow'
          : dim ? 'text-slate-500 hover:bg-white/10 active:bg-white/15'
          : 'text-white hover:bg-white/15 active:bg-white/25')}>
      {children}
    </button>
  );
}

type PlayerAction = {
  key: string;
  label: string;
  icon: React.ReactNode;
  onClick: () => void;
  active?: boolean;
  dim?: boolean;
  popup?: 'menu' | 'dialog';
  expanded?: boolean;
};

function PlayerActionMenu({ open, actions, onClose }: { open: boolean; actions: PlayerAction[]; onClose: () => void }) {
  const popupRef = useRef<HTMLDivElement>(null);
  usePopupFocusReturn(open, popupRef);
  if (!open) return null;
  return (
    <>
      <div className="fixed inset-0 z-[310]" aria-hidden="true" onClick={onClose} />
      <div ref={popupRef} role="menu" aria-label="Playback options" aria-orientation="vertical" tabIndex={-1}
        onKeyDown={event => handlePopupListKeyDown(event, onClose)}
        className="absolute right-2 top-[max(3.75rem,calc(env(safe-area-inset-top)+3.25rem))] z-[320] w-64 max-w-[86vw] glass-strong rounded-xl shadow-float overflow-hidden animate-fade-in">
        <p className="px-3 py-2 text-[11px] uppercase tracking-wide text-slate-400 border-b border-white/10">Playback options</p>
        <div className="max-h-[62vh] overflow-y-auto py-1">
          {actions.map(action => (
            <button key={action.key} type="button" role="menuitem" onClick={action.onClick}
              aria-haspopup={action.popup} aria-expanded={action.popup ? action.expanded === true : undefined}
              className={cx('w-full min-h-11 px-3 py-2.5 text-sm flex items-center gap-3 text-left hover:bg-white/10 active:bg-white/15',
                action.active ? 'text-brand-300' : action.dim ? 'text-slate-500' : 'text-white')}>
              <span className="w-6 shrink-0 grid place-items-center">{action.icon}</span>
              <span className="min-w-0 flex-1 leading-snug">{action.label}</span>
              {action.active && <Icon.Check size={16} className="shrink-0" />}
            </button>
          ))}
        </div>
      </div>
    </>
  );
}

function PlayerSwitch({ label, checked, onChange }: { label: string; checked: boolean; onChange: (checked: boolean) => void }) {
  return (
    <button type="button" role="switch" aria-label={label} aria-checked={checked} onClick={() => onChange(!checked)}
      className="relative h-11 w-14 shrink-0 rounded-xl">
      <span aria-hidden="true" className={cx('absolute inset-x-1 top-2 h-7 rounded-full transition-colors', checked ? 'bg-brand-500' : 'bg-white/15')}>
        <span className={cx('absolute top-1 h-5 w-5 rounded-full bg-white shadow transition-all', checked ? 'left-6' : 'left-1')} />
      </span>
    </button>
  );
}

function languageOptions(tracks: any[]): { value: string; label: string }[] {
  const seen = new Set<string>();
  const options: { value: string; label: string }[] = [];
  for (const track of tracks) {
    const language = normalizeTrackLanguage(track?.lang ?? track?.language);
    if (!language || seen.has(language)) continue;
    seen.add(language);
    options.push({ value: language, label: translatedLanguageName(language) });
  }
  return options.sort((a, b) => a.label.localeCompare(b.label));
}

function PlayerPreferencesMenu({ open, onClose, preferences, audioTracks, subtitleTracks, playbackPlan, onChange }: {
  open: boolean;
  onClose: () => void;
  preferences: VideoPlaybackPreferences;
  audioTracks: any[];
  subtitleTracks: any[];
  playbackPlan: VideoPlaybackPlan | null;
  onChange: (patch: Partial<VideoPlaybackPreferences>) => void;
}) {
  const popupRef = useRef<HTMLDivElement>(null);
  usePopupFocusReturn(open, popupRef);
  if (!open) return null;
  const audioLanguages = languageOptions(audioTracks);
  const subtitleLanguages = languageOptions(subtitleTracks);
  if (preferences.audioLanguage && !audioLanguages.some(option => option.value === preferences.audioLanguage)) {
    audioLanguages.unshift({ value: preferences.audioLanguage, label: `${translatedLanguageName(preferences.audioLanguage)} (not in this video)` });
  }
  if (preferences.subtitleLanguage && !subtitleLanguages.some(option => option.value === preferences.subtitleLanguage)) {
    subtitleLanguages.unshift({ value: preferences.subtitleLanguage, label: `${translatedLanguageName(preferences.subtitleLanguage)} (not in this video)` });
  }
  const appearance = preferences.subtitleAppearance;
  const updateAppearance = (patch: Partial<SubtitleAppearance>) => onChange({ subtitleAppearance: { ...appearance, ...patch } });
  return (
    <>
      <div className="fixed inset-0 z-[310]" aria-hidden="true" onClick={onClose} />
      <div ref={popupRef} role="dialog" aria-label="Player preferences" tabIndex={-1}
        onKeyDown={event => handlePopupDialogKeyDown(event, onClose)}
        className="absolute right-2 top-[max(3.75rem,calc(env(safe-area-inset-top)+3.25rem))] z-[320] w-[23rem] max-w-[calc(100vw-1rem)] glass-strong rounded-xl shadow-float overflow-hidden animate-fade-in">
        <div className="flex items-center justify-between border-b border-white/10 px-3 py-2">
          <p className="text-[11px] uppercase tracking-wide text-slate-400">Player preferences</p>
          <button type="button" className="w-11 h-11 grid place-items-center rounded-full text-slate-300 hover:bg-white/10" onClick={onClose} aria-label="Close player preferences"><Icon.Close size={17} /></button>
        </div>
        <div className="max-h-[70vh] overflow-y-auto p-3 space-y-4 text-sm">
          <label className="block">
            <span className="block text-xs font-medium text-slate-200 mb-1.5">Audio language</span>
            <select className="input !py-2 min-h-11 w-full" value={preferences.audioLanguage}
              onChange={event => onChange({ audioLanguage: event.target.value, manualAudio: null })}>
              <option value="">Automatic (media default)</option>
              {audioLanguages.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
          </label>
          <label className="block">
            <span className="block text-xs font-medium text-slate-200 mb-1.5">Audio output</span>
            <select className="input !py-2 min-h-11 w-full" value={preferences.audioOutput}
              onChange={event => onChange({ audioOutput: event.target.value as VideoPlaybackPreferences['audioOutput'] })}>
              <option value="auto">Auto (safe device detection)</option>
              <option value="stereo">Stereo</option>
              <option value="surround">5.1 surround</option>
            </select>
            <span className="block mt-1 text-[11px] leading-snug text-slate-500">Auto enables 5.1 only when the browser reports a six-channel output and smooth decoding. Choosing 5.1 requests it explicitly.</span>
            {playbackPlan?.audio.stereoFallback && <span className="block mt-1 text-[11px] leading-snug text-amber-300">This stream is being converted to stereo for the current output setting.</span>}
          </label>
          <div className="grid grid-cols-2 gap-3">
            <label className="block min-w-0">
              <span className="block text-xs font-medium text-slate-200 mb-1.5">Subtitle mode</span>
              <select className="input !py-2 min-h-11 w-full" value={preferences.subtitleMode}
                onChange={event => onChange({ subtitleMode: event.target.value as SubtitleMode })}>
                <option value="off">Off</option>
                <option value="foreign-only">Foreign parts only</option>
                <option value="always">Always</option>
              </select>
            </label>
            <label className="block min-w-0">
              <span className="block text-xs font-medium text-slate-200 mb-1.5">Subtitle language</span>
              <select className="input !py-2 min-h-11 w-full" value={preferences.subtitleLanguage}
                onChange={event => onChange({ subtitleLanguage: event.target.value, manualSubtitle: null })}>
                <option value="">Automatic</option>
                {subtitleLanguages.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
              </select>
            </label>
          </div>
          <div className="border-t border-white/10 pt-3 space-y-3">
            <div className="flex items-center justify-between gap-3">
              <div><p className="text-xs font-medium text-slate-200">Caption size</p><p className="text-[11px] text-slate-500">{appearance.sizePct}%</p></div>
              <input type="range" min={75} max={175} step={5} value={appearance.sizePct} aria-label="Caption size"
                onInput={event => updateAppearance({ sizePct: +(event.target as HTMLInputElement).value })} className="w-36 accent-brand-500" />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <label className="block min-w-0">
                <span className="block text-xs font-medium text-slate-200 mb-1.5">Background</span>
                <select className="input !py-2 min-h-11 w-full" value={appearance.background}
                  onChange={event => updateAppearance({ background: event.target.value as SubtitleAppearance['background'] })}>
                  <option value="black">Black</option><option value="none">None</option>
                </select>
              </label>
              <label className="block min-w-0">
                <span className="block text-xs font-medium text-slate-200 mb-1.5">Text edge</span>
                <select className="input !py-2 min-h-11 w-full" value={appearance.edge}
                  onChange={event => updateAppearance({ edge: event.target.value as SubtitleAppearance['edge'] })}>
                  <option value="none">None</option><option value="shadow">Shadow</option><option value="outline">Outline</option>
                </select>
              </label>
            </div>
            <div className="flex items-center justify-between gap-3">
              <div><p className="text-xs font-medium text-slate-200">Background opacity</p><p className="text-[11px] text-slate-500">{Math.round(appearance.opacity * 100)}%</p></div>
              <input type="range" min={0.2} max={1} step={0.05} value={appearance.opacity} disabled={appearance.background === 'none'} aria-label="Caption background opacity"
                onInput={event => updateAppearance({ opacity: +(event.target as HTMLInputElement).value })} className="w-36 accent-brand-500 disabled:opacity-40" />
            </div>
            <div className="flex items-center justify-between gap-3">
              <div><p className="text-xs font-medium text-slate-200">High contrast captions</p><p className="text-[11px] text-slate-500">Stronger text and background separation</p></div>
              <PlayerSwitch label="High contrast captions" checked={appearance.contrast === 'high'}
                onChange={checked => updateAppearance({ contrast: checked ? 'high' : 'normal' })} />
            </div>
          </div>
          <div className="flex items-center justify-between gap-3 border-t border-white/10 pt-3">
            <div className="min-w-0"><p className="text-xs font-medium text-slate-200">Autoplay next episode</p><p className="text-[11px] text-slate-500 leading-snug">Off by default. Stops after two hours without interaction.</p></div>
            <PlayerSwitch label="Autoplay next episode" checked={preferences.autoplayNextEpisode}
              onChange={autoplayNextEpisode => onChange({ autoplayNextEpisode })} />
          </div>
        </div>
      </div>
    </>
  );
}

function ChapterMenu({ open, onClose, chapters, currentIndex, onSeek, onPrevious, onNext }: {
  open: boolean;
  onClose: () => void;
  chapters: VideoChapter[];
  currentIndex: number;
  onSeek: (seconds: number) => void;
  onPrevious: () => void;
  onNext: () => void;
}) {
  const popupRef = useRef<HTMLDivElement>(null);
  usePopupFocusReturn(open, popupRef);
  if (!open) return null;
  return (
    <>
      <div className="fixed inset-0 z-[310]" aria-hidden="true" onClick={onClose} />
      <div ref={popupRef} role="dialog" aria-label="Chapters" tabIndex={-1}
        onKeyDown={event => handlePopupListKeyDown(event, onClose)}
        className="absolute right-2 top-[max(3.75rem,calc(env(safe-area-inset-top)+3.25rem))] z-[320] w-80 max-w-[86vw] glass-strong rounded-xl shadow-float overflow-hidden animate-fade-in">
        <div className="flex items-center justify-between gap-2 border-b border-white/10 px-3 py-2">
          <p className="text-[11px] uppercase tracking-wide text-slate-400">Chapters</p>
          <div className="flex gap-1">
            <button type="button" className="w-11 h-11 grid place-items-center rounded-full text-white hover:bg-white/10 disabled:text-slate-600" disabled={currentIndex < 0} onClick={onPrevious} aria-label="Previous chapter"><Icon.Prev size={17} /></button>
            <button type="button" className="w-11 h-11 grid place-items-center rounded-full text-white hover:bg-white/10 disabled:text-slate-600" disabled={currentIndex >= chapters.length - 1} onClick={onNext} aria-label="Next chapter"><Icon.Next size={17} /></button>
          </div>
        </div>
        <div className="max-h-[62vh] overflow-y-auto py-1">
          {chapters.map((chapter, index) => (
            <button key={`${chapter.startSec}-${chapter.name}`} type="button" onClick={() => { onSeek(chapter.startSec); onClose(); }}
              aria-current={index === currentIndex ? 'true' : undefined}
              className={cx('w-full min-h-11 px-3 py-2.5 flex items-center gap-3 text-left hover:bg-white/10 active:bg-white/15', index === currentIndex ? 'text-brand-300' : 'text-white')}>
              <span className="w-12 shrink-0 text-xs tabular-nums text-slate-400">{formatDuration(chapter.startSec)}</span>
              <span className="min-w-0 flex-1 truncate text-sm">{chapter.name}</span>
              {index === currentIndex && <Icon.Check size={16} className="shrink-0" />}
            </button>
          ))}
        </div>
      </div>
    </>
  );
}

export type EpisodeNavigation = {
  previous?: MediaItem | null;
  next?: MediaItem | null;
  loading?: boolean;
  complete?: boolean;
  onSelect: (episode: MediaItem) => void;
};

// Fullscreen player for movies/episodes/videos (HLS via proxy)
export function VideoPlayer({ item, audio = false, onClose, episodeNavigation, onEpisodeSelect }: {
  item: MediaItem;
  audio?: boolean;
  onClose: () => void;
  episodeNavigation?: EpisodeNavigation;
  onEpisodeSelect?: (episode: MediaItem) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const accountId = useAuth(state => state.user?.id ?? null);
  const [videoPreferences, setVideoPreferences] = useState<VideoPlaybackPreferences>(() => loadVideoPlaybackPreferences(accountId));
  const videoPreferencesRef = useRef(videoPreferences);
  const preferenceSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const preferenceSaveTailRef = useRef<Promise<unknown>>(Promise.resolve());
  const preferencesTouchedRef = useRef(false);
  const preferenceSyncWarningRef = useRef(false);
  videoPreferencesRef.current = videoPreferences;

  const syncVideoPreferences = (value: VideoPlaybackPreferences) => {
    preferenceSaveTailRef.current = preferenceSaveTailRef.current
      .catch(() => undefined)
      .then(() => api.settings.preferences({ videoPlayback: value }))
      .then(result => {
        const saved = parseVideoPlaybackPreferences(result.preferences?.videoPlayback ?? value);
        saveVideoPlaybackPreferences(accountId, saved);
        preferenceSyncWarningRef.current = false;
      })
      .catch(() => {
        if (!preferenceSyncWarningRef.current) {
          preferenceSyncWarningRef.current = true;
          toast('Player preferences saved on this device', 'info', 'Aerie will try to sync them again after your next change.');
        }
      });
  };
  const updateVideoPreferences = (patch: Partial<VideoPlaybackPreferences>) => {
    const next = parseVideoPlaybackPreferences({ ...videoPreferencesRef.current, ...patch });
    preferencesTouchedRef.current = true;
    videoPreferencesRef.current = next;
    setVideoPreferences(next);
    saveVideoPlaybackPreferences(accountId, next);
    if (preferenceSaveTimerRef.current) clearTimeout(preferenceSaveTimerRef.current);
    preferenceSaveTimerRef.current = setTimeout(() => {
      preferenceSaveTimerRef.current = null;
      syncVideoPreferences(videoPreferencesRef.current);
    }, 450);
  };

  useEffect(() => {
    const local = loadVideoPlaybackPreferences(accountId);
    preferencesTouchedRef.current = false;
    videoPreferencesRef.current = local;
    setVideoPreferences(local);
    return () => {
      if (preferenceSaveTimerRef.current) {
        clearTimeout(preferenceSaveTimerRef.current);
        preferenceSaveTimerRef.current = null;
        if (preferencesTouchedRef.current) syncVideoPreferences(videoPreferencesRef.current);
      }
    };
  }, [accountId]);

  usePlayerDialog(containerRef);
  useEffect(() => {
    if (!audio && usePlayer.getState().playing) usePlayer.getState().setPlaying(false);
  }, [audio]);
  const hlsRef = useRef<any>(null);
  const loadToken = useRef(0);
  const streamIntentRef = useRef<StreamReloadIntent>({ itemId: item.id, startAt: 0, autoplay: true });
  const mediaTimelineItemIdRef = useRef<string | null>(null);
  const trackLoadToken = useRef(0);
  const playbackPlanRef = useRef<{ itemId: string; plan: VideoPlaybackPlan } | null>(null);
  const recoveryRef = useRef({ network: 0, media: 0 });
  const [loading, setLoading] = useState(true);
  const [buffering, setBuffering] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [canRemote, setCanRemote] = useState(false);   // a Cast/DLNA device is available (Remote Playback API)
  const [remoteBlocked, setRemoteBlocked] = useState(false); // Remote Playback exists in theory but needs HTTPS
  const [canAirplay, setCanAirplay] = useState(false); // Safari AirPlay
  const [canPip, setCanPip] = useState(false);
  const [casting, setCasting] = useState(false);
  const [isFs, setIsFs] = useState(false);
  const [segments, setSegments] = useState<{ kind: 'intro' | 'credits'; startSec: number; endSec: number; source: string }[]>([]);
  const [chapters, setChapters] = useState<VideoChapter[]>([]);
  const [playbackPlan, setPlaybackPlan] = useState<VideoPlaybackPlan | null>(null);
  const [activePlaybackVariant, setActivePlaybackVariant] = useState<PlaybackVariant | null>(null);
  const [plannedAudioOutput, setPlannedAudioOutput] = useState<VideoPlaybackPreferences['audioOutput'] | null>(null);
  const [playbackPlanSupported, setPlaybackPlanSupported] = useState<boolean | null>(null);
  const [seekPreview, setSeekPreview] = useState<{ sec: number; leftPct: number } | null>(null);
  const [downloadPct, setDownloadPct] = useState<number | null>(null);

  // Server-side Google Cast (works everywhere, incl. the Android app's WebView,
  // where the Remote Playback API never fires).
  const [castDevices, setCastDevices] = useState<{ ip: string; name: string }[]>([]);
  const [castOpen, setCastOpen] = useState(false);
  const castPopupRef = useRef<HTMLDivElement>(null);
  usePopupFocusReturn(castOpen, castPopupRef);
  const [tvCast, setTvCast] = useState<{ ip: string; name: string } | null>(null);
  const [tvState, setTvState] = useState<{ active: boolean; playerState?: string; idleReason?: string; currentTime?: number; duration?: number } | null>(null);
  const [tvCanSeek, setTvCanSeek] = useState(true);
  const [castSwitchError, setCastSwitchError] = useState<string | null>(null);
  const tvGone = useRef(0);
  const castTransitionRef = useRef(false);
  const castRequestTokenRef = useRef(0);
  // Transcoded casts start the TV timeline at 0 (resume happens server-side);
  // `tvOffset` maps TV time back to real movie time for display + progress.
  const tvOffset = useRef(0);
  const tvLastAbsolutePositionRef = useRef(0);
  const tvCastRef = useRef<typeof tvCast>(null);
  const tvItemIdRef = useRef<string | null>(null);
  const tvFinishedItemIdRef = useRef<string | null>(null);
  const tvControllerGenerationRef = useRef<string | null>(null);
  tvCastRef.current = tvCast;

  // A server-side Cast session has no controller outside this player. Always
  // stop it when playback UI goes away, and invalidate any in-flight LOAD so a
  // late response cannot start an orphaned TV session after close/navigation.
  useEffect(() => () => {
    castRequestTokenRef.current += 1;
    const device = tvCastRef.current;
    const controllerGeneration = tvControllerGenerationRef.current;
    tvCastRef.current = null;
    tvItemIdRef.current = null;
    tvFinishedItemIdRef.current = null;
    tvControllerGenerationRef.current = null;
    if (device && controllerGeneration) api.cast.control(device.ip, 'quit', undefined, controllerGeneration).catch(() => {});
  }, []);

  // Subtitle + audio tracks (from Jellyfin via our proxy)
  const [audioTracks, setAudioTracks] = useState<any[]>([]);
  const [subTracks, setSubTracks] = useState<any[]>([]);
  const [audioIdx, setAudioIdx] = useState<number | null>(null);
  const [subIdx, setSubIdx] = useState<SubSel>(null); // null = Off
  const [subJob, setSubJob] = useState<{ id: string; action: string; status: string; progress: number } | null>(null);
  const [translationPrefs, setTranslationPrefs] = useState<TranslationPreferences | null>(null);
  const [translationCaps, setTranslationCaps] = useState<TranslationCapabilities | null>(null);
  const [translationLoadState, setTranslationLoadState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [translationAiAllowed, setTranslationAiAllowed] = useState<boolean | null>(null);
  const [ccOpen, setCcOpen] = useState(false);
  const [audioOpen, setAudioOpen] = useState(false);
  const [speedOpen, setSpeedOpen] = useState(false);
  const [qualityOpen, setQualityOpen] = useState(false);
  const [actionsOpen, setActionsOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [chaptersOpen, setChaptersOpen] = useState(false);
  const [autoplayCountdown, setAutoplayCountdown] = useState<number | null>(null);
  const [autoplayCancelledForItem, setAutoplayCancelledForItem] = useState<string | null>(null);
  const [autoplayWaitingForInteraction, setAutoplayWaitingForInteraction] = useState(false);
  const lastPlaybackInteractionRef = useRef(Date.now());
  const currentItemIdRef = useRef(item.id);
  const episodeTransitionTokenRef = useRef(0);
  const episodeSessionProgressRef = useRef(new Map<string, EpisodeSessionProgress>());
  currentItemIdRef.current = item.id;
  useEffect(() => () => { episodeTransitionTokenRef.current++; }, []);
  const rememberEpisodeProgress = (
    candidate: MediaItem,
    positionSec: number,
    durationSec: number,
    completed = false,
  ) => {
    if (candidate.type !== 'Episode') return;
    const fallbackDuration = Number(candidate.runtimeTicks || 0) / 1e7;
    episodeSessionProgressRef.current.set(candidate.id,
      episodeProgressSnapshot(positionSec, durationSec || fallbackDuration, completed));
  };
  const resumeEpisodeSeconds = (candidate: MediaItem) => episodeResumeSeconds(
    candidate,
    episodeSessionProgressRef.current.get(candidate.id),
  );
  const episodeWithSessionProgress = (candidate: MediaItem): MediaItem => {
    const progress = episodeSessionProgressRef.current.get(candidate.id);
    return progress ? { ...candidate, ...progress } : candidate;
  };
  const cueBaseTimesRef = useRef(new WeakMap<object, { start: number; end: number }>());
  // Refs so the (re)load path can re-apply the chosen subtitle after an audio swap
  const audioIdxRef = useRef<number | null>(null);
  const subIdxRef = useRef<SubSel>(null);
  const subTracksRef = useRef<any[]>([]);
  subTracksRef.current = subTracks;

  useEffect(() => {
    if (audio) return;
    let active = true;
    api.settings.get().then(result => {
      if (!active) return;
      setTranslationPrefs(result.preferences?.translation || null);
      setTranslationCaps(result.translationCapabilities);
      setTranslationAiAllowed(result.user.aiMode !== 'disabled' && result.user.features?.ai !== false);
      setTranslationLoadState('ready');
      if (!preferencesTouchedRef.current) {
        const saved = parseVideoPlaybackPreferences(result.preferences?.videoPlayback);
        videoPreferencesRef.current = saved;
        setVideoPreferences(saved);
        saveVideoPlaybackPreferences(accountId, saved);
      }
    }).catch(() => { if (active) setTranslationLoadState('error'); });
    return () => { active = false; };
  }, [audio, accountId]);

  // Episodes opened outside the TV detail page (Dashboard, collections, device
  // handoff) still get the same canonical cross-season navigation.
  const [autoEpisodeQueue, setAutoEpisodeQueue] = useState<MediaItem[]>([]);
  const [autoEpisodeLoading, setAutoEpisodeLoading] = useState(false);
  const [autoEpisodeComplete, setAutoEpisodeComplete] = useState(false);
  useEffect(() => {
    let active = true;
    if (episodeNavigation || !onEpisodeSelect || item.type !== 'Episode' || !item.seriesId) {
      setAutoEpisodeQueue([]); setAutoEpisodeLoading(false); setAutoEpisodeComplete(false);
      return () => { active = false; };
    }
    setAutoEpisodeQueue([item]); setAutoEpisodeLoading(true); setAutoEpisodeComplete(false);
    api.media.episodes(item.seriesId).then(items => {
      if (!active) return;
      const ordered = orderEpisodes(items);
      if (ordered.some(episode => episode.id === item.id)) {
        setAutoEpisodeQueue(ordered); setAutoEpisodeComplete(true);
      }
    }).catch(() => { /* playback remains available without a guessed queue */ })
      .finally(() => { if (active) setAutoEpisodeLoading(false); });
    return () => { active = false; };
  }, [item.id, item.seriesId, item.type, !!episodeNavigation, !!onEpisodeSelect]);
  const autoEpisodeNeighbors = episodeNeighbors(autoEpisodeQueue, item.id);
  const activeEpisodeNavigation = episodeNavigation || (onEpisodeSelect && item.type === 'Episode' ? {
    previous: autoEpisodeNeighbors.previous,
    next: autoEpisodeNeighbors.next,
    loading: autoEpisodeLoading,
    complete: autoEpisodeComplete,
    onSelect: onEpisodeSelect,
  } : undefined);

  // ---- 2K GPU upscaling (desktop Windows/Linux only) ----
  // The <video> keeps decoding as usual but turns invisible; each frame is
  // re-rendered through FSR (EASU+RCAS) shaders onto a 2560×1440 canvas by the
  // viewer's own GPU. Aerie's controls and subtitle overlay work identically
  // with the native video and the upscaled canvas.
  const upscaleOk = !audio && UPSCALE_PLATFORM && upscaleSupported();
  const [upscale, setUpscale] = useState(() => {
    try { return upscaleOk && localStorage.getItem('cb_upscale2k') === '1'; } catch { return false; }
  });
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [upRes, setUpRes] = useState<{ sw: number; sh: number; dw: number; dh: number } | null>(null);
  const [cueText, setCueText] = useState('');
  const [playing, setPlaying] = useState(false);
  const [ended, setEnded] = useState(false);
  const [episodeSwitching, setEpisodeSwitching] = useState(false);
  const [curTime, setCurTime] = useState(0);
  const [dur, setDur] = useState(0);
  const [bufferedEnd, setBufferedEnd] = useState(0);
  const initialVideoVolumeRef = useRef<VideoVolumePreference | null>(null);
  if (!initialVideoVolumeRef.current) initialVideoVolumeRef.current = loadVideoVolume(accountId);
  const [vol, setVol] = useState(initialVideoVolumeRef.current.volume);
  const [muted, setMuted] = useState(initialVideoVolumeRef.current.muted);
  const [playbackRate, setPlaybackRate] = useState(1);
  const [ctrlShow, setCtrlShow] = useState(true);
  const [controlsFocused, setControlsFocused] = useState(false);
  const ctrlTimer = useRef<any>(null);
  const durationTicks = () => {
    const v = videoRef.current;
    const sec = v?.duration && isFinite(v.duration) && v.duration > 0 ? v.duration : ((item.runtimeTicks || 0) / 1e7);
    return sec > 0 ? Math.round(sec * 1e7) : (item.runtimeTicks || 0);
  };

  const toggleUpscale = () => {
    const next = !upscale;
    setUpscale(next);
    try { localStorage.setItem('cb_upscale2k', next ? '1' : '0'); } catch { /* */ }
    if (next) toast('2K upscaling on', 'success', 'Your GPU now upscales this video to 1440p.');
  };
  const togglePlay = () => {
    const v = videoRef.current; if (!v) return;
    // While a replacement source has no confirmed timeline, `v.paused` only
    // describes the browser's loading placeholder. Toggle the pending intent
    // so Pause during episode planning cannot turn back into autoplay later.
    const timelineReady = mediaTimelineItemIdRef.current === item.id && v.readyState >= 1;
    const autoplay = timelineReady ? v.paused : !streamIntentRef.current.autoplay;
    streamIntentRef.current = { ...streamIntentRef.current, itemId: item.id, autoplay };
    if (autoplay) v.play().catch(() => {}); else v.pause();
  };
  const choosePlaybackRate = (rate: number) => {
    const v = videoRef.current;
    if (!v || !applyPlaybackRate(v, rate)) return;
    // Preserve pitch for dialogue whenever the browser exposes the control.
    try { (v as any).preservesPitch = true; } catch { /* unsupported */ }
    setPlaybackRate(rate);
    setSpeedOpen(false);
  };
  const pokeCtrls = () => {
    setCtrlShow(true);
    clearTimeout(ctrlTimer.current);
    if (videoRef.current && !videoRef.current.paused) {
      ctrlTimer.current = setTimeout(() => setCtrlShow(false), 3000);
    }
  };
  useEffect(() => {
    clearTimeout(ctrlTimer.current);
    if (playing) ctrlTimer.current = setTimeout(() => setCtrlShow(false), 3000);
    else setCtrlShow(true);
    return () => clearTimeout(ctrlTimer.current);
  }, [playing, item.id]);

  // Collect active subtitle cues for the Aerie overlay. Keeping subtitle
  // painting in one place prevents native cues from colliding with our bar.
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

  // TextTrack timing is adjusted in-place from immutable base times. This makes
  // every 100 ms offset tap audible/visible immediately without re-downloading
  // the VTT, while avoiding cumulative drift as the setting changes repeatedly.
  const applySubtitleOffset = () => {
    const v = videoRef.current; if (!v) return;
    const delta = videoPreferencesRef.current.subtitleOffsetMs / 1000;
    for (let trackIndex = 0; trackIndex < v.textTracks.length; trackIndex++) {
      const cues = v.textTracks[trackIndex].cues;
      if (!cues) continue;
      for (let cueIndex = 0; cueIndex < cues.length; cueIndex++) {
        const cue = cues[cueIndex] as TextTrackCue;
        let base = cueBaseTimesRef.current.get(cue);
        if (!base) {
          base = { start: cue.startTime, end: cue.endTime };
          cueBaseTimesRef.current.set(cue, base);
        }
        const start = Math.max(0, base.start + delta);
        const end = Math.max(start + 0.01, base.end + delta);
        try {
          if (start > cue.endTime) { cue.endTime = end; cue.startTime = start; }
          else { cue.startTime = start; cue.endTime = end; }
        } catch { /* a few legacy WebViews expose read-only cue timing */ }
      }
    }
    readCues();
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

  // Mirror playback state for custom controls, skip markers and hover previews.
  useEffect(() => {
    const v = videoRef.current; if (!v) return;
    const savedVolume = loadVideoVolume(accountId);
    v.volume = savedVolume.volume;
    v.muted = savedVolume.muted;
    const tu = () => {
      setCurTime(v.currentTime || 0);
      if (!v.paused) setBuffering(false);
      if (v.duration && v.currentTime < v.duration - 0.5) setEnded(false);
    };
    const du = () => { if (isFinite(v.duration) && v.duration > 0) setDur(v.duration); };
    const pp = () => { setPlaying(!v.paused); if (v.paused) setBuffering(false); };
    const vo = () => {
      setVol(v.volume); setMuted(v.muted);
      saveVideoVolume(accountId, { volume: v.volume, muted: v.muted });
    };
    const rate = () => setPlaybackRate(v.playbackRate || 1);
    const bu = () => {
      let end = 0;
      for (let i = 0; i < v.buffered.length; i++) end = Math.max(end, v.buffered.end(i));
      setBufferedEnd(end);
    };
    const wait = () => setBuffering(true);
    const ready = () => setBuffering(false);
    const end = () => {
      const duration = v.duration && isFinite(v.duration) && v.duration > 0
        ? v.duration : Number(item.runtimeTicks || 0) / 1e7;
      rememberEpisodeProgress(item, duration, duration, true);
      setEnded(true); setPlaying(false); setBuffering(false);
    };
    tu(); du(); pp(); vo(); rate(); bu();
    v.addEventListener('timeupdate', tu);
    v.addEventListener('durationchange', du);
    v.addEventListener('play', pp);
    v.addEventListener('pause', pp);
    v.addEventListener('volumechange', vo);
    v.addEventListener('ratechange', rate);
    v.addEventListener('progress', bu);
    v.addEventListener('waiting', wait);
    v.addEventListener('stalled', wait);
    v.addEventListener('playing', ready);
    v.addEventListener('canplay', ready);
    v.addEventListener('seeked', ready);
    v.addEventListener('ended', end);
    return () => {
      v.removeEventListener('timeupdate', tu);
      v.removeEventListener('durationchange', du);
      v.removeEventListener('play', pp);
      v.removeEventListener('pause', pp);
      v.removeEventListener('volumechange', vo);
      v.removeEventListener('ratechange', rate);
      v.removeEventListener('progress', bu);
      v.removeEventListener('waiting', wait);
      v.removeEventListener('stalled', wait);
      v.removeEventListener('playing', ready);
      v.removeEventListener('canplay', ready);
      v.removeEventListener('seeked', ready);
      v.removeEventListener('ended', end);
    };
  }, [item.id, accountId]);

  // Browser cue painting cannot account for Aerie's custom control height, so
  // keep tracks active-but-hidden and render their cues in the shared overlay.
  useEffect(() => {
    const v = videoRef.current; if (!v) return;
    for (let i = 0; i < v.textTracks.length; i++) {
      const t = v.textTracks[i];
      if (t.mode !== 'disabled') t.mode = 'hidden';
    }
    readCues();
  }, [upscale, subIdx]);

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
    el.src = sub.custom ? api.subtitles.fileUrl(sub.id) : api.media.subtitleUrl(sub.url);
    el.label = sub.name || sub.lang || 'Subtitles';
    if (sub.lang) el.srclang = sub.lang;
    el.default = true;
    v.appendChild(el);
    // Keep the track active for cue events without also painting native cues.
    const show = () => {
      try { if (el.track) el.track.mode = 'hidden'; } catch {}
      applySubtitleOffset();
      readCues();
    };
    el.addEventListener('load', show);
    show();
    try { el.track.oncuechange = readCues; } catch { /* */ }
  };

  useEffect(() => { applySubtitleOffset(); }, [videoPreferences.subtitleOffsetMs, item.id]);

  // (Re)load the HLS/native source, optionally for a specific audio stream index,
  // resuming from `startAt` seconds. hls.js is lazy-loaded so it never bloats boot.
  // Recovery after an uncertain TV disconnect deliberately loads paused to
  // avoid playing locally while an unreachable receiver may still be audible.
  const loadStream = async (audioStream?: number | null, startAt = 0, autoplay = true) => {
    const v = videoRef.current; if (!v) return;
    startAt = Number.isFinite(startAt) && startAt >= 0 ? startAt : 0;
    streamIntentRef.current = { itemId: item.id, startAt, autoplay };
    mediaTimelineItemIdRef.current = null;
    const token = ++loadToken.current;
    try { hlsRef.current?.destroy(); } catch {}
    hlsRef.current = null;
    recoveryRef.current = { network: 0, media: 0 };
    setActivePlaybackVariant(null);
    setError(null); setLoading(true); setBuffering(false); setBufferedEnd(0); setEnded(false);
    const canNative = !!v.canPlayType('application/vnd.apple.mpegurl');
    let src = api.media.streamUrl(item.id, audio);
    let useHls = !audio;
    let compatibilityStream = !audio && playbackPlanSupported === false;
    let selectedPlan: VideoPlaybackPlan | null = null;
    if (!audio && playbackPlanSupported !== false) {
      try {
        const quality = videoPreferencesRef.current.quality;
        const requestedAudioOutput = videoPreferencesRef.current.audioOutput;
        const audioChannels: 2 | 6 = requestedAudioOutput === 'surround' ? 6
          : requestedAudioOutput === 'stereo' ? 2 : await automaticAudioChannels();
        if (token !== loadToken.current) return;
        const capabilities = browserPlaybackQuery(v, canNative, audioChannels);
        // Auto uses the physical display as a sensible bandwidth ceiling. A
        // user-selected cap (including Original) is explicit and must not be
        // silently lowered to the current window/screen size.
        if (quality !== 'auto') { delete capabilities.maxWidth; delete capabilities.maxHeight; }
        const rawPlan = await api.media.playbackPlan(item.id, {
          ...capabilities,
          quality,
          ...(audioStream != null ? { audioStream } : {}),
          ...(playbackPlanRef.current?.itemId === item.id ? { source: playbackPlanRef.current.plan.source.id } : {}),
        });
        if (token !== loadToken.current) return;
        const plan = parseVideoPlaybackPlan(rawPlan);
        if (!plan) throw new Error('invalid_playback_plan');
        src = plan.streamUrl;
        useHls = plan.hls;
        selectedPlan = plan;
        playbackPlanRef.current = { itemId: item.id, plan };
        setPlaybackPlan(plan);
        setPlannedAudioOutput(requestedAudioOutput);
        setPlaybackPlanSupported(true);
        if (plan.audio.selectedStreamIndex != null) {
          audioIdxRef.current = plan.audio.selectedStreamIndex;
          setAudioIdx(plan.audio.selectedStreamIndex);
        }
      } catch (planError: any) {
        if (token !== loadToken.current) return;
        if (planError?.status === 404) {
          // Compatibility path for Aerie servers from before playback preflight.
          setPlaybackPlan(null);
          playbackPlanRef.current = null;
          setPlannedAudioOutput(null);
          setPlaybackPlanSupported(false);
          compatibilityStream = true;
          if (audioStream != null) src += (src.includes('?') ? '&' : '?') + `audioStream=${audioStream}`;
        } else {
          setError(planError?.message === 'invalid_playback_plan'
            ? 'The server returned an invalid playback plan.'
            : 'Aerie could not prepare this video for your device.');
          setLoading(false); setBuffering(false);
          return;
        }
      }
    } else if (audioStream != null) src += (src.includes('?') ? '&' : '?') + `audioStream=${audioStream}`;
    let startQueued = false;
    const start = () => {
      if (token !== loadToken.current || startQueued) return;
      startQueued = true;
      whenMediaMetadataReady(v, () => {
        if (token !== loadToken.current) return;
        const confirmTimeline = () => {
          if (token === loadToken.current) mediaTimelineItemIdRef.current = item.id;
        };
        if (startAt > 0) {
          try { v.currentTime = startAt; } catch {}
          // Most engines reflect the seek synchronously. If one temporarily
          // reports zero, keep using the episode snapshot until seeked confirms
          // that this source owns a usable timeline.
          if (Math.abs((v.currentTime || 0) - startAt) < 0.5) confirmTimeline();
          else v.addEventListener('seeked', confirmTimeline, { once: true });
        } else confirmTimeline();
        setLoading(false); setBuffering(false); applySubtitle();
        // A video restored paused by a network handoff stays paused.
        if ((item as any)._resumePaused) {
          (item as any)._resumePaused = false;
          streamIntentRef.current = { ...streamIntentRef.current, autoplay: false };
          return;
        }
        if (!streamIntentRef.current.autoplay) return;
        v.play().catch(() => {});
      });
    };
    if (!useHls) {
      v.src = src;
      v.addEventListener('loadedmetadata', start, { once: true });
      v.addEventListener('error', () => {
        if (token !== loadToken.current) return;
        setError('This direct-play video could not be loaded.'); setLoading(false); setBuffering(false);
      }, { once: true });
      return;
    }
    if (canNative) {
      // Tell the server this is a native HLS engine (Safari) so it drops
      // BreakOnNonKeyFrames, which native players can stall on. New playback
      // plans already carry this flag in their credential-free stream URL.
      v.src = compatibilityStream ? src + (src.includes('?') ? '&' : '?') + 'native=1' : src;
      v.addEventListener('loadedmetadata', start, { once: true });
      v.addEventListener('error', () => {
        if (token !== loadToken.current) return;
        setError('This video could not be loaded. Check the connection and try again.'); setLoading(false); setBuffering(false);
      }, { once: true });
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
      hls.on(Hls.Events.LEVEL_SWITCHED, (_event: unknown, data: { level?: number }) => {
        if (token !== loadToken.current || !selectedPlan?.adaptive || !Number.isInteger(data?.level)) return;
        const levelIndex = data.level!;
        setActivePlaybackVariant(playbackVariantForHlsLevel(selectedPlan.variants, hls.levels?.[levelIndex], levelIndex));
      });
      hls.on(Hls.Events.ERROR, (_e: any, data: any) => {
        if (!data.fatal || token !== loadToken.current) return;
        if (data.type === Hls.ErrorTypes.NETWORK_ERROR && recoveryRef.current.network < 1) {
          recoveryRef.current.network++;
          setBuffering(true);
          hls.startLoad();
          return;
        }
        if (data.type === Hls.ErrorTypes.MEDIA_ERROR && recoveryRef.current.media < 1) {
          recoveryRef.current.media++;
          setBuffering(true);
          hls.recoverMediaError();
          return;
        }
        setError(data.type === Hls.ErrorTypes.NETWORK_ERROR
          ? 'The connection to the video was interrupted.'
          : 'The video decoder could not continue playback.');
        setLoading(false); setBuffering(false);
      });
    } else {
      v.src = src; v.addEventListener('loadedmetadata', start, { once: true });
      v.addEventListener('error', () => {
        if (token !== loadToken.current) return;
        setError('This browser could not play the video stream.'); setLoading(false); setBuffering(false);
      }, { once: true });
    }
  };

  const currentStreamReloadIntent = (fallbackStartAt = 0) => resolveStreamReloadIntent(
    videoRef.current,
    mediaTimelineItemIdRef.current,
    item.id,
    streamIntentRef.current,
    fallbackStartAt,
  );

  const installMediaTracks = (streams: { audio?: any[]; subtitles?: any[]; chapters?: any[] }, custom: { subtitles?: any[] },
    runtimeSec: number, startAt: number, initialSource: boolean) => {
    const at = Array.isArray(streams?.audio) ? streams.audio : [];
    const st = Array.isArray(streams?.subtitles) ? streams.subtitles : [];
    const ct = (custom.subtitles || []).map((entry: any) => ({
      ...entry, id: entry.id, custom: true, index: `c:${entry.id}`, name: entry.label,
      url: `/api/subtitles/file/${entry.id}`,
    }));
    const tracks = [...st, ...ct];
    const previousAudioIndex = audioIdxRef.current;
    setAudioTracks(at); setSubTracks(tracks); subTracksRef.current = tracks;
    const selectedAudio = selectPreferredAudioTrack(at, videoPreferencesRef.current);
    const selectedAudioIndex = typeof selectedAudio?.index === 'number' ? selectedAudio.index : null;
    audioIdxRef.current = selectedAudioIndex;
    setAudioIdx(selectedAudioIndex);
    const selectedSubtitle = selectPreferredSubtitleTrack(tracks, videoPreferencesRef.current);
    const selectedSubtitleIndex = selectedSubtitle?.index ?? null;
    subIdxRef.current = selectedSubtitleIndex;
    setSubIdx(selectedSubtitleIndex);
    if (Array.isArray(streams?.chapters) && streams.chapters.length) setChapters(sanitizeVideoChapters(streams.chapters, runtimeSec));
    const needsAudioReload = selectedAudioIndex != null && !tvCastRef.current
      && (initialSource ? selectedAudio?.default !== true : selectedAudioIndex !== previousAudioIndex);
    if (needsAudioReload) {
      const intent = currentStreamReloadIntent(startAt);
      void loadStream(selectedAudioIndex, intent.startAt, intent.autoplay);
    }
    else if (selectedSubtitleIndex != null) applySubtitle();
  };

  useEffect(() => {
    const v = videoRef.current; if (!v) return;
    let active = true;
    // Resume from the saved position (Continue watching). Skip if within 15s of the
    // end (treat as finished, start over).
    const runtimeSec = item.runtimeTicks ? item.runtimeTicks / 1e7 : 0;
    const startAt = resumeEpisodeSeconds(item);

    // The player deliberately survives episode changes so fullscreen, volume,
    // mute and playback speed do too. Reset only state that belongs to the old
    // media item, before either the stream or metadata request can resolve.
    audioIdxRef.current = null;
    subIdxRef.current = null;
    subTracksRef.current = [];
    playbackPlanRef.current = null;
    trackLoadToken.current++;
    cueBaseTimesRef.current = new WeakMap();
    v.querySelectorAll('track').forEach(track => track.remove());
    for (let i = 0; i < v.textTracks.length; i++) v.textTracks[i].mode = 'disabled';
    setAudioTracks([]); setSubTracks([]); setAudioIdx(null); setSubIdx(null);
    setSegments([]); setChapters(sanitizeVideoChapters((item as any).chapters, runtimeSec)); setPlaybackPlan(null); setPlannedAudioOutput(null); setCueText(''); setSeekPreview(null); setDownloadPct(null);
    setCcOpen(false); setAudioOpen(false); setSpeedOpen(false); setQualityOpen(false); setActionsOpen(false); setCastOpen(false); setSettingsOpen(false); setChaptersOpen(false);
    setAutoplayCountdown(null); setAutoplayCancelledForItem(null); setAutoplayWaitingForInteraction(false);
    setEpisodeSwitching(false); setCastSwitchError(null); setCurTime(startAt); setDur(runtimeSec); setBufferedEnd(0); setCtrlShow(true);
    if (tvCastRef.current) {
      // A successful Cast episode handoff updates `item` while preserving the
      // receiver session. Never start that new episode locally underneath it.
      loadToken.current++;
      try { hlsRef.current?.destroy(); } catch { /* */ }
      hlsRef.current = null;
      mediaTimelineItemIdRef.current = null;
      v.pause(); v.removeAttribute('src'); v.load();
      setError(null); setLoading(false); setBuffering(false); setEnded(false); setPlaying(false);
    } else loadStream(null, startAt);
    // Fetch selectable audio/subtitle tracks for this item (best-effort)
    const loadSubs = async () => {
      const requestToken = ++trackLoadToken.current;
      const [s, custom] = await Promise.all([
        api.media.streams(item.id),
        api.subtitles.list(item.id).catch(() => ({ subtitles: [] as any[] })),
      ]);
      if (!active || requestToken !== trackLoadToken.current) return;
      installMediaTracks(s, custom, runtimeSec, startAt, true);
    };
    loadSubs().catch(() => {});
    api.media.segments(item.id).then(r => { if (active) setSegments(r.segments || []); }).catch(() => { if (active) setSegments([]); });
    api.media.chapters(item.id).then(r => {
      if (active) setChapters(sanitizeVideoChapters(r.chapters, runtimeSec));
    }).catch(() => { /* old servers and chapter-less media keep embedded metadata, if any */ });
    // Only save a position once playback has meaningfully advanced (>5s) so we never
    // clobber a real saved position with a near-zero value before the seek lands.
    // While casting, the local video is paused/detached — its stale position must
    // not clobber the TV's progress (the cast poll reports instead).
    const report = () => {
      if (!tvCastRef.current && v.currentTime > 5) {
        const duration = v.duration && isFinite(v.duration) && v.duration > 0
          ? v.duration : Number(item.runtimeTicks || 0) / 1e7;
        rememberEpisodeProgress(item, v.currentTime, duration, v.ended);
        api.media.progress(item.id, Math.round(v.currentTime * 1e7), durationTicks(), item.seriesId).catch(() => {});
      }
    };
    const rep = setInterval(report, 15000);
    // Expose the live position for the native network-handoff (origin hop must
    // reopen this exact video at this exact second). Not while casting — the TV
    // plays independently of which origin the app uses.
    const onTime = () => {
      if (tvCastRef.current) return;
      if (v.readyState >= 1) {
        const duration = v.duration && isFinite(v.duration) && v.duration > 0
          ? v.duration : Number(item.runtimeTicks || 0) / 1e7;
        rememberEpisodeProgress(item, v.currentTime, duration, v.ended);
      }
      (window as any).__cbVideo = { itemId: item.id, pos: v.currentTime, paused: v.paused };
    };
    v.addEventListener('timeupdate', onTime);
    v.addEventListener('play', onTime);
    v.addEventListener('pause', onTime);
    return () => {
      active = false;
      loadToken.current++; clearInterval(rep); report();
      v.removeEventListener('timeupdate', onTime);
      v.removeEventListener('play', onTime);
      v.removeEventListener('pause', onTime);
      if ((window as any).__cbVideo?.itemId === item.id) (window as any).__cbVideo = null;
      try { hlsRef.current?.destroy(); } catch {}
    };
  }, [item.id]);

  // Playback planning may select a different Jellyfin media source than the
  // library default. Reload pickers against that exact, server-revalidated
  // source so stream indexes and channel metadata always describe what plays.
  useEffect(() => {
    const sourceId = playbackPlan?.source.id;
    if (!sourceId) return;
    let active = true;
    Promise.all([
      api.media.streams(item.id, sourceId),
      api.subtitles.list(item.id).catch(() => ({ subtitles: [] as any[] })),
    ]).then(([streams, custom]) => {
      if (!active) return;
      // Supersede the default-source request only after this exact-source
      // request succeeds. If it fails, the in-flight fallback may still fill
      // the pickers instead of being invalidated and leaving them empty.
      ++trackLoadToken.current;
      installMediaTracks(streams, custom, item.runtimeTicks ? item.runtimeTicks / 1e7 : 0, resumeEpisodeSeconds(item), false);
    }).catch(() => { /* retain the already loaded default-source picker */ });
    return () => { active = false; };
  }, [item.id, playbackPlan?.source.id]);

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

  const refreshCustomSubs = async (selectId?: string) => {
    const custom = await api.subtitles.list(item.id).catch(() => ({ subtitles: [] as any[] }));
    const base = subTracksRef.current.filter((s: any) => !s.custom);
    const ct = (custom.subtitles || []).map((c: any) => ({ ...c, id: c.id, custom: true, index: `c:${c.id}`, name: c.label, url: `/api/subtitles/file/${c.id}` }));
    const next = [...base, ...ct];
    subTracksRef.current = next;
    setSubTracks(next);
    if (selectId) chooseSub(`c:${selectId}`);
  };
  const chooseSub = (index: SubSel) => {
    const track = subTracksRef.current.find((candidate: any) => candidate.index === index);
    subIdxRef.current = index; setSubIdx(index); setCcOpen(false); applySubtitle();
    if (index == null) updateVideoPreferences({ subtitleMode: 'off' });
    else updateVideoPreferences({
      subtitleMode: track?.forced === true ? 'foreign-only' : 'always',
      subtitleLanguage: normalizeTrackLanguage(track?.lang ?? track?.language),
      manualSubtitle: matcherForTrack(track || {}) || null,
    });
  };
  const currentSource = () => {
    const s = subTracksRef.current.find((x: any) => x.index === subIdxRef.current);
    if (!s) return null;
    const mediaSourceId = s.mediaSourceId || String(s.url || '').split('/')[5];
    return s.custom ? { type: 'custom', id: s.id } : { type: 'jf', mediaSourceId, index: s.index };
  };
  const startSubJob = async (action: string, fn: () => Promise<{ jobId: string }>) => {
    try { const r = await fn(); setSubJob({ id: r.jobId, action, status: 'queued', progress: 0 }); setCcOpen(false); }
    catch (e: any) { toast(`${action} failed`, 'error', subtitleJobError(e?.message || 'Could not start subtitle job.')); }
  };
  const cleanCurrent = async () => {
    const source = currentSource(); if (!source) return;
    try {
      const r = await api.subtitles.cleanup(item.id, source);
      await refreshCustomSubs(r.subtitle?.id);
      toast('Subtitles cleaned', 'success', r.subtitle?.label || item.name);
    } catch (e: any) { toast('Cleanup failed', 'error', String(e?.message || 'Could not clean subtitles.')); }
  };
  useEffect(() => {
    let alive = true;
    setSubJob(null);
    api.subtitles.active(item.id).then(({ job }) => {
      if (alive && job) setSubJob(current => current || job);
    }).catch(() => {});
    return () => { alive = false; };
  }, [item.id]);
  useEffect(() => {
    if (!subJob) return;
    let settled = false;
    let t: ReturnType<typeof setInterval> | undefined;
    const poll = async () => {
      try {
        const j = await api.subtitles.job(subJob.id);
        if (settled) return;
        if (j.status === 'done') {
          settled = true; if (t) clearInterval(t); setSubJob(null);
          await refreshCustomSubs(j.subtitleId);
          toast(`${subJob.action} complete`, 'success', item.name);
        } else if (j.status === 'error') {
          settled = true; if (t) clearInterval(t); setSubJob(null);
          toast(`${subJob.action} failed`, 'error', subtitleJobError(j.error));
        } else {
          setSubJob(s => s ? { ...s, action: j.action || s.action, status: j.status, progress: Math.max(s.progress, j.progress || 0) } : s);
        }
      } catch { /* keep polling through brief network interruptions */ }
    };
    poll();
    t = setInterval(poll, 2000);
    return () => { settled = true; if (t) clearInterval(t); };
  }, [subJob?.id]);
  const chooseAudio = (value: SubSel) => {
    const index = typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
    audioIdxRef.current = index; setAudioIdx(index); setAudioOpen(false);
    if (index == null) return;
    const track = audioTracks.find((candidate: any) => candidate.index === index);
    updateVideoPreferences({
      audioLanguage: normalizeTrackLanguage(track?.lang ?? track?.language),
      manualAudio: matcherForTrack(track || {}) || null,
    });
    const intent = currentStreamReloadIntent();
    loadStream(index, intent.startAt, intent.autoplay);
  };
  const chooseQuality = (value: SubSel) => {
    if (typeof value !== 'string' || !PLAYBACK_QUALITY_IDS.includes(value as PlaybackQuality)) return;
    updateVideoPreferences({ quality: value as PlaybackQuality });
    setQualityOpen(false);
  };

  const audioPreferenceKey = JSON.stringify({ language: videoPreferences.audioLanguage, manual: videoPreferences.manualAudio });
  const subtitlePreferenceKey = JSON.stringify({
    language: videoPreferences.subtitleLanguage,
    mode: videoPreferences.subtitleMode,
    manual: videoPreferences.manualSubtitle,
  });
  useEffect(() => {
    if (!audioTracks.length) return;
    const selected = selectPreferredAudioTrack(audioTracks, videoPreferencesRef.current);
    const index = typeof selected?.index === 'number' ? selected.index : null;
    if (index === audioIdxRef.current) return;
    audioIdxRef.current = index;
    setAudioIdx(index);
    if (index != null && !tvCastRef.current) {
      const intent = currentStreamReloadIntent();
      void loadStream(index, intent.startAt, intent.autoplay);
    }
  }, [item.id, audioTracks, audioPreferenceKey]);
  useEffect(() => {
    if (!subTracks.length) return;
    const selected = selectPreferredSubtitleTrack(subTracks, videoPreferencesRef.current);
    const index = selected?.index ?? null;
    if (index === subIdxRef.current) return;
    subIdxRef.current = index;
    setSubIdx(index);
    applySubtitle();
  }, [item.id, subTracks, subtitlePreferenceKey]);
  useEffect(() => {
    if (audio || !playbackPlan || (playbackPlan.quality === videoPreferences.quality && plannedAudioOutput === videoPreferences.audioOutput)) return;
    const intent = currentStreamReloadIntent();
    void loadStream(audioIdxRef.current, intent.startAt, intent.autoplay);
  }, [audio, item.id, playbackPlan?.quality, plannedAudioOutput, videoPreferences.quality, videoPreferences.audioOutput]);

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
    const onWebkitFs = () => setIsFs(!!(v as any).webkitDisplayingFullscreen);
    document.addEventListener('fullscreenchange', onFs);
    v.addEventListener('webkitbeginfullscreen', onWebkitFs);
    v.addEventListener('webkitendfullscreen', onWebkitFs);
    return () => {
      try { if (watchId !== undefined) remote?.cancelWatchAvailability?.(watchId); } catch {}
      remote?.removeEventListener?.('connect', onConnect);
      remote?.removeEventListener?.('connecting', onConnect);
      remote?.removeEventListener?.('disconnect', onDisconnect);
      if (airplayBound) v.removeEventListener('webkitplaybacktargetavailabilitychanged', onAirplay);
      document.removeEventListener('fullscreenchange', onFs);
      v.removeEventListener('webkitbeginfullscreen', onWebkitFs);
      v.removeEventListener('webkitendfullscreen', onWebkitFs);
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
    let recoveredLocally = false;
    const recoverLocally = (title: string, detail: string) => {
      if (recoveredLocally) return;
      recoveredLocally = true;
      const resumeAt = Math.max(0, tvLastAbsolutePositionRef.current);
      const duration = Math.max(resumeAt, Number(item.runtimeTicks || 0) / 1e7);
      rememberEpisodeProgress(item, resumeAt, duration, false);
      if (resumeAt > 2) {
        api.media.progress(item.id, Math.round(resumeAt * 1e7), Math.round(duration * 1e7), item.seriesId).catch(() => {});
      }
      castRequestTokenRef.current += 1;
      tvCastRef.current = null;
      tvItemIdRef.current = null;
      tvFinishedItemIdRef.current = null;
      tvControllerGenerationRef.current = null;
      tvGone.current = 0;
      tvOffset.current = 0;
      setTvCast(null); setTvState(null); setCastSwitchError(null);
      setPlaying(false); setEnded(false); setBuffering(false);
      void loadStream(audioIdxRef.current, resumeAt, false);
      toast(title, 'error', `${detail} Playback is paused here at ${formatDuration(resumeAt)}; press Play to continue.`);
    };
    const strike = () => {
      if (++tvGone.current >= 3) {
        recoverLocally('TV connection lost', `Aerie could no longer confirm playback on ${tvCast.name}.`);
      }
    };
    const t = setInterval(() => {
      // FINISHED releases server ownership, so later status calls correctly say
      // inactive. Keep the receiver as the selected target until the viewer
      // chooses Next, restarts, closes, or returns playback to this device.
      if (tvFinishedItemIdRef.current === item.id) return;
      const controllerGeneration = tvControllerGenerationRef.current;
      if (!controllerGeneration) return;
      api.cast.status(tvCast.ip, controllerGeneration).then(s => {
        // Restarting or restoring this same episode replaces the receiver
        // generation without changing `item.id`. Ignore a response from the
        // prior generation instead of letting it count as a vanished TV.
        if (tvControllerGenerationRef.current !== controllerGeneration) return;
        // LOAD briefly reports the old session or IDLE. The explicit transition
        // request owns state until it succeeds or restores the prior episode.
        if (castTransitionRef.current || tvItemIdRef.current !== item.id) return;
        if (s?.active && s.playerState === 'IDLE') {
          // Movie ended (or the receiver dropped the media). Mark it finished
          // and retain the receiver target for Up Next / autoplay.
          if ((s as any).idleReason === 'FINISHED') {
            const total = (s.duration || 0) + tvOffset.current
              || Number(item.runtimeTicks || 0) / 1e7;
            tvLastAbsolutePositionRef.current = total;
            rememberEpisodeProgress(item, total, total, true);
            if (total > 0) api.media.progress(item.id, Math.round(total * 1e7), Math.round(total * 1e7), item.seriesId).catch(() => {});
            tvFinishedItemIdRef.current = item.id;
            tvControllerGenerationRef.current = null;
            const receiverTotal = Math.max(0, total - tvOffset.current);
            setTvState({ ...s, active: true, playerState: 'IDLE', idleReason: 'FINISHED', currentTime: receiverTotal, duration: receiverTotal });
            setCurTime(total); setDur(total); setEnded(true); setPlaying(false); setBuffering(false);
            toast('Finished playing on TV', 'info', item.name);
            return;
          }
          const reason = String(s.idleReason || '').toLowerCase();
          if (reason && reason !== 'finished') {
            recoverLocally('TV playback stopped', `${tvCast.name} reported ${reason}.`);
          } else strike();
          return;
        }
        if (s?.active) {
          tvGone.current = 0;
          setTvState(s);
          const total = (s.duration || 0) + tvOffset.current
            || Number(item.runtimeTicks || 0) / 1e7;
          const absolutePosition = (s.currentTime || 0) + tvOffset.current;
          tvLastAbsolutePositionRef.current = absolutePosition;
          rememberEpisodeProgress(item, absolutePosition, total, false);
          if (s.currentTime && s.currentTime > 2 && Date.now() - lastReport > 15000) {
            lastReport = Date.now();
            api.media.progress(
              item.id,
              Math.round((s.currentTime + tvOffset.current) * 1e7),
              total > 0 ? Math.round(total * 1e7) : durationTicks(),
              item.seriesId,
            ).catch(() => {});
          }
        } else strike();
      }).catch(() => {
        if (tvControllerGenerationRef.current === controllerGeneration && !castTransitionRef.current) strike();
      }); // unreachable TV/server counts too — never a stuck overlay
    }, 4000);
    return () => clearInterval(t);
  }, [tvCast, item.id]);

  const applyTvPlayback = (result: CastPlaybackResponse, absolutePositionSec: number) => {
    const offset = Number.isFinite(result.offset) && result.offset > 0 ? result.offset : 0;
    tvOffset.current = offset;
    tvLastAbsolutePositionRef.current = Math.max(0, absolutePositionSec);
    tvFinishedItemIdRef.current = null;
    tvControllerGenerationRef.current = result.controllerGeneration;
    setEnded(false);
    setTvCanSeek(result.canSeek !== false);
    setTvState({
      active: true,
      playerState: 'BUFFERING',
      currentTime: Math.max(0, absolutePositionSec - offset),
    });
  };

  const castToDevice = async (d: { ip: string; name: string }) => {
    setCastOpen(false);
    if (tvCast?.ip === d.ip) return; // already casting there
    const requestToken = ++castRequestTokenRef.current;
    const loadLease = beginCastLoad(d.ip);
    const v = videoRef.current;
    const prev = tvCast;
    const previousControllerGeneration = tvControllerGenerationRef.current;
    // Switching devices resumes from the old TV's live position, else from local.
    const pos = Math.floor((prev ? (tvState?.currentTime || 0) + tvOffset.current : v?.currentTime || 0));
    try {
      const r = await api.cast.play(d.ip, item.id, pos, loadLease.controllerGeneration);
      if (r.controllerGeneration !== loadLease.controllerGeneration) throw new Error('cast_generation_mismatch');
      if (requestToken !== castRequestTokenRef.current || !ownsCastLoad(loadLease)) {
        // The player closed or a newer device request won while this LOAD was
        // in flight. Stop only this stale generation; never disturb a newer
        // player that has since loaded the same receiver.
        releaseCastLoad(loadLease);
        api.cast.control(d.ip, 'quit', undefined, loadLease.controllerGeneration).catch(() => {});
        return;
      }
      releaseCastLoad(loadLease);
      if (prev && previousControllerGeneration) {
        api.cast.control(prev.ip, 'quit', undefined, previousControllerGeneration).catch(() => {});
      }
      // Fully silence the local pipeline: a pending loadStream start() or hls
      // buffer would otherwise resume audio underneath the casting overlay.
      loadToken.current++;
      try { hlsRef.current?.destroy(); } catch { /* */ }
      hlsRef.current = null;
      // Guard onTime before the next React render, then clear the handoff hint —
      // else an origin hop would resume the movie locally while the TV plays it.
      tvCastRef.current = d;
      tvItemIdRef.current = item.id;
      if ((window as any).__cbVideo?.itemId === item.id) (window as any).__cbVideo = null;
      if (v) { v.pause(); v.removeAttribute('src'); v.load(); }
      setLoading(false);
      applyTvPlayback(r, pos);
      setCastSwitchError(null);
      setTvCast(d);
      toast(`Casting to ${d.name}`, 'success', item.name);
    } catch (e: any) {
      const owned = releaseCastLoad(loadLease);
      // A lost HTTP response does not prove the receiver missed LOAD.
      api.cast.control(d.ip, 'quit', undefined, loadLease.controllerGeneration).catch(() => {});
      if (requestToken !== castRequestTokenRef.current || !owned) return;
      toast('Cast failed', 'error', String(e?.message || 'The TV did not accept the stream.'));
    }
  };

  const stopCasting = () => {
    if (!tvCast) return;
    castRequestTokenRef.current += 1;
    const finished = tvFinishedItemIdRef.current === item.id;
    const resumeAt = finished ? 0 : ((tvState?.currentTime || 0) + tvOffset.current) || videoRef.current?.currentTime || 0;
    const controllerGeneration = tvControllerGenerationRef.current;
    if (controllerGeneration) api.cast.control(tvCast.ip, 'quit', undefined, controllerGeneration).catch(() => {});
    tvItemIdRef.current = null;
    tvFinishedItemIdRef.current = null;
    tvControllerGenerationRef.current = null;
    tvCastRef.current = null;
    setTvCast(null); setTvState(null);
    setCastSwitchError(null);
    tvOffset.current = 0;
    loadStream(audioIdx, resumeAt);
  };
  const closePlayer = () => {
    castRequestTokenRef.current += 1;
    const device = tvCastRef.current;
    const controllerGeneration = tvControllerGenerationRef.current;
    tvCastRef.current = null;
    tvItemIdRef.current = null;
    tvFinishedItemIdRef.current = null;
    tvControllerGenerationRef.current = null;
    if (device && controllerGeneration) api.cast.control(device.ip, 'quit', undefined, controllerGeneration).catch(() => {});
    onClose();
  };

  const tvSkip = (delta: number) => {
    if (!tvCast || !tvCanSeek) return;
    const controllerGeneration = tvControllerGenerationRef.current;
    if (!controllerGeneration) return;
    const cur = tvState?.currentTime || 0;
    const max = tvState?.duration || Number.MAX_SAFE_INTEGER;
    const next = Math.max(0, Math.min(max - 2, cur + delta));
    // Optimistic: the poll is up to 4s stale; show the target immediately.
    setTvState(s => s ? { ...s, currentTime: next } : s);
    api.cast.control(tvCast.ip, 'seek', next, controllerGeneration).catch(() => {});
  };
  const toggleTvPlayback = () => {
    if (!tvCast || episodeSwitching) return;
    const device = tvCast;
    const controllerGeneration = tvControllerGenerationRef.current;
    if (!controllerGeneration) return;
    const wasPaused = tvState?.playerState === 'PAUSED';
    const nextState = wasPaused ? 'PLAYING' : 'PAUSED';
    setTvState(state => state ? { ...state, playerState: nextState } : state);
    api.cast.control(device.ip, wasPaused ? 'play' : 'pause', undefined, controllerGeneration).catch(() => {
      if (tvCastRef.current?.ip !== device.ip || tvControllerGenerationRef.current !== controllerGeneration) return;
      setTvState(state => state?.playerState === nextState
        ? { ...state, playerState: wasPaused ? 'PAUSED' : 'PLAYING' } : state);
      toast('TV control failed', 'error', `Aerie could not ${wasPaused ? 'resume' : 'pause'} playback on ${device.name}.`);
    });
  };
  const airplay = () => { const v = videoRef.current as any; v?.webkitShowPlaybackTargetPicker?.(); };
  const togglePip = async () => {
    const v = videoRef.current as any; if (!v) return;
    try { if (document.pictureInPictureElement) await document.exitPictureInPicture(); else await v.requestPictureInPicture(); } catch {}
  };
  const toggleFs = () => {
    const el = containerRef.current; if (!el) return;
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else if (el.requestFullscreen) el.requestFullscreen().catch(() => {});
    else {
      const video = videoRef.current as any;
      try { if (video?.webkitDisplayingFullscreen) video.webkitExitFullscreen?.(); else video?.webkitEnterFullscreen?.(); } catch { /* unsupported */ }
    }
  };
  const selectEpisode = async (target?: MediaItem | null) => {
    if (!target || !activeEpisodeNavigation || episodeSwitching) return;
    const effectiveTarget = episodeWithSessionProgress(target);
    setAutoplayCountdown(null);
    setAutoplayWaitingForInteraction(false);
    setEpisodeSwitching(true);
    if (tvCast) {
      const transitionToken = ++episodeTransitionTokenRef.current;
      const sourceItemId = item.id;
      const transitionIsCurrent = () => transitionToken === episodeTransitionTokenRef.current
        && currentItemIdRef.current === sourceItemId;
      const device = tvCast;
      const sourceWasFinished = tvFinishedItemIdRef.current === item.id;
      const loadLease = beginCastLoad(device.ip);
      const snapshot = castProgressSnapshot(tvState?.currentTime, tvState?.duration, tvOffset.current, item.runtimeTicks);
      if (snapshot) rememberEpisodeProgress(item, snapshot.positionSec, snapshot.durationSec, sourceWasFinished);
      const targetPosition = resumeEpisodeSeconds(effectiveTarget);
      const playForTransition = async (targetId: string, position: number) => {
        const playback = await api.cast.play(device.ip, targetId, position, loadLease.controllerGeneration);
        if (playback.controllerGeneration !== loadLease.controllerGeneration) throw new Error('cast_generation_mismatch');
        return playback;
      };
      castTransitionRef.current = true;
      setCastSwitchError(null);
      try {
        const result = await transitionCastEpisode({
          saveProgress: snapshot ? () => api.media.progress(
            item.id,
            Math.round(snapshot.positionSec * 1e7),
            Math.round(snapshot.durationSec * 1e7),
            item.seriesId,
          ) : undefined,
          playTarget: () => playForTransition(effectiveTarget.id, targetPosition),
        });
        // A Cast LOAD may resolve after the player was closed or another item
        // took its place. Never let that stale response reopen/switch the UI.
        if (!transitionIsCurrent() || !ownsCastLoad(loadLease)) {
          releaseCastLoad(loadLease);
          api.cast.control(device.ip, 'quit', undefined, loadLease.controllerGeneration).catch(() => {});
          return;
        }
        releaseCastLoad(loadLease);
        if (result.ok === true) {
          rememberEpisodeProgress(
            effectiveTarget,
            targetPosition,
            Number(effectiveTarget.runtimeTicks || 0) / 1e7,
            false,
          );
          applyTvPlayback(result.playback, targetPosition);
          tvItemIdRef.current = effectiveTarget.id;
          activeEpisodeNavigation.onSelect(effectiveTarget);
          toast(`Playing ${episodeNumberLabel(effectiveTarget)} on ${device.name}`, 'success');
        } else {
          // The TV may have accepted LOAD even if its HTTP confirmation was
          // lost. This quit is generation-scoped and cannot touch a newer
          // player that has since taken the same receiver. Do not issue an
          // automatic restoration LOAD: it could overwrite that newer player.
          api.cast.control(device.ip, 'quit', undefined, loadLease.controllerGeneration).catch(() => {});
          const detail = sourceWasFinished
            ? `The next episode did not start on ${device.name}. Your finished episode was left alone.`
            : `${device.name} did not confirm the episode change. The current episode was not reloaded, so a newer TV session stays safe.`;
          setCastSwitchError(detail);
          setAutoplayCancelledForItem(item.id);
          toast('Could not switch episodes', 'error', detail);
          setEpisodeSwitching(false);
        }
      } finally {
        releaseCastLoad(loadLease);
        if (transitionToken === episodeTransitionTokenRef.current) {
          castTransitionRef.current = false;
          setEpisodeSwitching(false);
        }
      }
      return;
    }
    const v = videoRef.current;
    if (v) {
      const duration = v.duration && isFinite(v.duration) && v.duration > 0
        ? v.duration : Number(item.runtimeTicks || 0) / 1e7;
      rememberEpisodeProgress(item, v.currentTime, duration, v.ended);
    }
    if (v && v.currentTime > 5) {
      // Start the save before changing source, but never make navigation wait on
      // an unbounded network request. The item-effect cleanup reports once more.
      void api.media.progress(item.id, Math.round(v.currentTime * 1e7), durationTicks(), item.seriesId).catch(() => {});
    }
    activeEpisodeNavigation.onSelect(episodeWithSessionProgress(effectiveTarget));
  };
  const restartCastEpisode = async () => {
    if (!tvCast || episodeSwitching) return;
    const transitionToken = ++episodeTransitionTokenRef.current;
    const sourceItemId = item.id;
    const transitionIsCurrent = () => transitionToken === episodeTransitionTokenRef.current
      && currentItemIdRef.current === sourceItemId;
    const device = tvCast;
    const sourceWasFinished = tvFinishedItemIdRef.current === item.id;
    const loadLease = beginCastLoad(device.ip);
    const snapshot = castProgressSnapshot(tvState?.currentTime, tvState?.duration, tvOffset.current, item.runtimeTicks);
    if (snapshot) rememberEpisodeProgress(item, snapshot.positionSec, snapshot.durationSec, sourceWasFinished);
    const playForRestart = async (position: number) => {
      const playback = await api.cast.play(device.ip, item.id, position, loadLease.controllerGeneration);
      if (playback.controllerGeneration !== loadLease.controllerGeneration) throw new Error('cast_generation_mismatch');
      return playback;
    };
    setEpisodeSwitching(true); setCastSwitchError(null); castTransitionRef.current = true;
    try {
      const result = await transitionCastEpisode({
        saveProgress: snapshot ? () => api.media.progress(
          item.id,
          Math.round(snapshot.positionSec * 1e7),
          Math.round(snapshot.durationSec * 1e7),
          item.seriesId,
        ) : undefined,
        playTarget: () => playForRestart(0),
      });
      if (!transitionIsCurrent() || !ownsCastLoad(loadLease)) {
        releaseCastLoad(loadLease);
        api.cast.control(device.ip, 'quit', undefined, loadLease.controllerGeneration).catch(() => {});
        return;
      }
      releaseCastLoad(loadLease);
      if (result.ok === true) {
        rememberEpisodeProgress(
          item,
          0,
          snapshot?.durationSec || Number(item.runtimeTicks || 0) / 1e7,
          false,
        );
        tvItemIdRef.current = item.id;
        applyTvPlayback(result.playback, 0);
      }
      else {
        api.cast.control(device.ip, 'quit', undefined, loadLease.controllerGeneration).catch(() => {});
        const detail = `The TV did not confirm playback. ${item.name} was not reloaded, so a newer TV session stays safe.`;
        setCastSwitchError(detail); toast('Could not restart episode', 'error', detail);
      }
    } finally {
      releaseCastLoad(loadLease);
      if (transitionToken === episodeTransitionTokenRef.current) {
        castTransitionRef.current = false;
        setEpisodeSwitching(false);
      }
    }
  };
  const previousEpisode = () => {
    if (tvCast) {
      const position = (tvState?.currentTime || 0) + tvOffset.current;
      if (position > 3) {
        void restartCastEpisode();
        return;
      }
      void selectEpisode(activeEpisodeNavigation?.previous);
      return;
    }
    const v = videoRef.current;
    // Familiar media-player semantics: first press restarts the current episode;
    // a press near its beginning moves to the previous episode.
    if (v && v.currentTime > 3) {
      v.currentTime = 0;
      pokeCtrls();
      return;
    }
    void selectEpisode(activeEpisodeNavigation?.previous);
  };

  const notePlaybackInteraction = () => { lastPlaybackInteractionRef.current = Date.now(); };
  const seekChapter = (seconds: number) => {
    const target = Math.max(0, seconds);
    if (tvCast) {
      if (!tvCanSeek) return;
      const controllerGeneration = tvControllerGenerationRef.current;
      if (!controllerGeneration) return;
      const receiverTarget = Math.max(0, target - tvOffset.current);
      setTvState(state => state ? { ...state, currentTime: receiverTarget } : state);
      api.cast.control(tvCast.ip, 'seek', receiverTarget, controllerGeneration).catch(() => {});
    } else if (videoRef.current) videoRef.current.currentTime = target;
    pokeCtrls();
  };
  const previousChapter = () => {
    if (!chapters.length) return;
    const position = tvCast ? (tvState?.currentTime || 0) + tvOffset.current : (videoRef.current?.currentTime || curTime);
    const index = activeVideoChapterIndex(chapters, position);
    if (index < 0) { seekChapter(chapters[0].startSec); return; }
    const target = position > chapters[index].startSec + 3 ? index : Math.max(0, index - 1);
    seekChapter(chapters[target].startSec);
  };
  const nextChapter = () => {
    if (!chapters.length) return;
    const position = tvCast ? (tvState?.currentTime || 0) + tvOffset.current : (videoRef.current?.currentTime || curTime);
    const index = activeVideoChapterIndex(chapters, position);
    const target = index < 0 ? 0 : index + 1;
    if (target < chapters.length) seekChapter(chapters[target].startSec);
  };

  const castFinished = Boolean(tvCast && isFinishedCastState(tvState));

  useEffect(() => {
    const next = activeEpisodeNavigation?.next;
    if (!ended || !next || !videoPreferences.autoplayNextEpisode || autoplayCancelledForItem === item.id
        || episodeSwitching || (tvCast && !castFinished) || error) {
      setAutoplayCountdown(null);
      if (!ended || !videoPreferences.autoplayNextEpisode) setAutoplayWaitingForInteraction(false);
      return;
    }
    if (autoplayNeedsInteraction(lastPlaybackInteractionRef.current)) {
      setAutoplayCountdown(null);
      setAutoplayWaitingForInteraction(true);
      return;
    }
    setAutoplayWaitingForInteraction(false);
    let remaining = 10;
    setAutoplayCountdown(remaining);
    const timer = setInterval(() => {
      remaining -= 1;
      if (remaining <= 0) {
        clearInterval(timer);
        setAutoplayCountdown(null);
        void selectEpisode(next);
      } else setAutoplayCountdown(remaining);
    }, 1000);
    return () => clearInterval(timer);
  }, [ended, activeEpisodeNavigation?.next?.id, videoPreferences.autoplayNextEpisode,
    autoplayCancelledForItem, autoplayWaitingForInteraction, episodeSwitching, item.id, tvCast, castFinished, error]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target;
      const editing = target instanceof HTMLElement && target.matches('input, textarea, select, button, [contenteditable="true"]');
      if (event.key === 'Escape') {
        if (ccOpen || audioOpen || speedOpen || qualityOpen || castOpen || actionsOpen || settingsOpen || chaptersOpen) {
          event.preventDefault();
          setCcOpen(false); setAudioOpen(false); setSpeedOpen(false); setQualityOpen(false); setCastOpen(false); setActionsOpen(false); setSettingsOpen(false); setChaptersOpen(false);
        } else if (!document.fullscreenElement) closePlayer();
        return;
      }
      if (editing || ccOpen || audioOpen || speedOpen || qualityOpen || castOpen || actionsOpen || settingsOpen || chaptersOpen) return;

      const v = videoRef.current;
      const key = event.key.toLowerCase();
      if (key === ' ' || key === 'k') {
        event.preventDefault();
        if (tvCast) toggleTvPlayback();
        else togglePlay();
      } else if (event.altKey && event.key === 'ArrowLeft' && chapters.length) {
        event.preventDefault(); previousChapter();
      } else if (event.altKey && event.key === 'ArrowRight' && chapters.length) {
        event.preventDefault(); nextChapter();
      } else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight' || key === 'j' || key === 'l') {
        event.preventDefault();
        const delta = event.key === 'ArrowLeft' ? -5 : event.key === 'ArrowRight' ? 5 : key === 'j' ? -10 : 10;
        if (tvCast) tvSkip(delta);
        else if (v) v.currentTime = Math.max(0, Math.min(v.duration || Number.MAX_SAFE_INTEGER, v.currentTime + delta));
      } else if (key === 'm' && v && !tvCast) {
        event.preventDefault(); v.muted = !v.muted;
      } else if (key === 'c' && !audio) {
        event.preventDefault();
        setActionsOpen(false); setAudioOpen(false); setCastOpen(false); setCcOpen(true);
      } else if (event.shiftKey && key === 'n' && activeEpisodeNavigation?.next) {
        event.preventDefault(); void selectEpisode(activeEpisodeNavigation.next);
      } else if (event.shiftKey && key === 'p' && activeEpisodeNavigation
        && (activeEpisodeNavigation.previous || (tvCast ? (tvState?.currentTime || 0) + tvOffset.current : (v?.currentTime || 0)) > 3)) {
        event.preventDefault(); previousEpisode();
      } else if ((event.key === '[' || event.key === ']') && v && !tvCast) {
        event.preventDefault();
        choosePlaybackRate(stepPlaybackRate(v.playbackRate || 1, event.key === '[' ? -1 : 1));
      } else if (key === 'f') {
        event.preventDefault(); toggleFs();
      } else return;
      notePlaybackInteraction();
      pokeCtrls();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [actionsOpen, audio, audioOpen, speedOpen, qualityOpen, castOpen, ccOpen, settingsOpen, chaptersOpen, chapters, activeEpisodeNavigation?.next?.id, activeEpisodeNavigation?.previous?.id,
    activeEpisodeNavigation?.onSelect, episodeSwitching, item.id, item.name, item.runtimeTicks, item.seriesId,
    onClose, tvCanSeek, tvCast, tvState?.currentTime, tvState?.duration, tvState?.playerState]);
  const subJobPct = subJob ? Math.max(0, Math.min(99, Math.round(subJob.progress * 100))) : 0;
  const subJobDetail = subJob?.status === 'queued'
    ? 'Waiting for the subtitle worker…'
    : subJob?.action === 'Generating'
      ? (subJobPct < 2 ? 'Preparing movie audio…' : 'Transcribing movie audio…')
      : subJob?.action === 'Translating'
        ? 'Translating subtitle lines…'
        : 'Matching subtitles to the dialogue…';
  const playerSec = tvCast ? (tvState?.currentTime || 0) + tvOffset.current : curTime;
  const currentChapterIndex = activeVideoChapterIndex(chapters, playerSec);
  const activeSegment = !audio ? segments.find(s => playerSec >= s.startSec && playerSec < s.endSec - 0.5) : undefined;
  const skipActiveSegment = () => {
    if (!activeSegment) return;
    if (tvCast) {
      if (!tvCanSeek) return;
      const controllerGeneration = tvControllerGenerationRef.current;
      if (!controllerGeneration) return;
      const target = Math.max(0, activeSegment.endSec - tvOffset.current);
      setTvState(s => s ? { ...s, currentTime: target } : s);
      api.cast.control(tvCast.ip, 'seek', target, controllerGeneration).catch(() => {});
    } else if (videoRef.current) videoRef.current.currentTime = activeSegment.endSec;
  };
  const saveOffline = async () => {
    if (downloads.has(`video:${item.id}`)) { toast('Already downloaded', 'info', item.name); return; }
    setDownloadPct(0);
    try {
      await downloads.save({ id: `video:${item.id}`, url: api.media.offlineUrl(item.id), title: item.name, subtitle: item.seriesName || (item.year ? String(item.year) : 'Video'), artUrl: item.posterUrl || item.thumbUrl, kind: 'video', mediaItem: item }, p => setDownloadPct(p < 0 ? 0 : Math.round(p * 100)));
      toast('Saved for offline', 'success', item.name);
    } catch (e: any) { toast('Download failed', 'error', e?.message); } finally { setDownloadPct(null); }
  };

  const translationProviderName = translationPrefs?.provider === 'external'
    ? translationCaps?.externalName || 'Cloud provider'
    : translationCaps?.localName || 'Local AI';
  const translationProviderAvailable = translationLoadState === 'ready' && translationAiAllowed === true
    && !!translationPrefs && !!translationCaps
    && (translationPrefs.provider === 'external' ? translationCaps.externalAllowed : translationCaps.localConfigured);
  const translationProviderDetail = translationAiAllowed === false
    ? 'AI is disabled for this account'
    : translationPrefs?.provider === 'external' && !translationCaps?.externalConfigured
      ? `${translationProviderName} is not configured`
      : translationPrefs?.provider === 'external' && !translationCaps?.externalAllowed
        ? `${translationProviderName} is not permitted`
        : translationPrefs?.provider === 'local' && !translationCaps?.localConfigured
          ? `${translationProviderName} is not configured`
          : translationProviderName;
  const translationTools = translationLoadState === 'loading'
    ? [{ key: 'tr-loading', label: 'Loading translation settings…', disabled: true, onClick: () => {} }]
    : translationLoadState === 'error'
      ? [{ key: 'tr-unavailable', label: 'Translation settings unavailable', detail: 'Open Settings to try again', disabled: true, onClick: () => {} }]
      : (translationPrefs?.languages || []).map(language => ({
        key: `tr-${language}`,
        label: `Translate current to ${translatedLanguageName(language)}`,
        detail: translationProviderAvailable
          ? (subIdx == null ? `${translationProviderName} · select a subtitle first` : translationProviderName)
          : `${translationProviderDetail} · unavailable`,
        disabled: !!subJob || subIdx == null || !translationProviderAvailable,
        onClick: () => { const source = currentSource(); if (source) startSubJob('Translating', () => api.subtitles.translate(item.id, source, language)); },
      }));
  const aiToolsAllowed = translationAiAllowed !== false;
  const playerActions: PlayerAction[] = [];
  if (!audio && downloads.supported()) {
    playerActions.push({
      key: 'offline',
      label: downloadPct == null ? (downloads.has(`video:${item.id}`) ? 'Available offline' : 'Download for offline') : `Downloading ${downloadPct}%`,
      icon: <Icon.Download size={20} />,
      active: downloads.has(`video:${item.id}`),
      onClick: () => { setActionsOpen(false); saveOffline(); },
    });
  }
  if (upscaleOk) {
    playerActions.push({
      key: 'upscale', label: upscale ? '2K GPU upscaling on' : 'Upscale to 2K', icon: <TwoKIcon />, active: upscale,
      onClick: () => { setActionsOpen(false); toggleUpscale(); },
    });
  }
  if (!audio) {
    playerActions.push({
      key: 'subtitles', label: subIdx == null ? 'Subtitles (C)' : 'Subtitles on (C)', icon: <CcIcon />, active: subIdx != null,
      popup: 'dialog', expanded: ccOpen,
      onClick: () => { setActionsOpen(false); setAudioOpen(false); setCastOpen(false); setCcOpen(o => !o); },
    });
  }
  if (!audio && audioTracks.length > 1) {
    playerActions.push({
      key: 'audio', label: 'Audio track', icon: <AudioTrackIcon />,
      popup: 'dialog', expanded: audioOpen,
      onClick: () => { setActionsOpen(false); setCcOpen(false); setCastOpen(false); setAudioOpen(o => !o); },
    });
  }
  if (!audio && chapters.length > 0) {
    const chapter = currentChapterIndex >= 0 ? chapters[currentChapterIndex] : chapters[0];
    playerActions.push({
      key: 'chapters', label: `Chapters · ${chapter.name}`, icon: <Icon.List size={20} />, active: chaptersOpen,
      popup: 'dialog', expanded: chaptersOpen,
      onClick: () => { setActionsOpen(false); setCcOpen(false); setAudioOpen(false); setQualityOpen(false); setSettingsOpen(false); setChaptersOpen(open => !open); },
    });
  }
  if (!audio && playbackPlan) {
    const qualityOption = playbackPlan.qualityOptions.find(option => option.id === videoPreferences.quality);
    playerActions.push({
      key: 'quality',
      label: `Quality · ${qualityOption?.label || videoPreferences.quality} · ${playbackStatusLabel(playbackPlan, activePlaybackVariant)}`,
      icon: <span className="text-[10px] font-bold tabular-nums">{videoPreferences.quality === 'auto' ? 'AUTO' : videoPreferences.quality.replace('p', '')}</span>,
      active: videoPreferences.quality !== 'auto',
      popup: 'dialog', expanded: qualityOpen,
      onClick: () => { setActionsOpen(false); setCcOpen(false); setAudioOpen(false); setSpeedOpen(false); setSettingsOpen(false); setChaptersOpen(false); setQualityOpen(open => !open); },
    });
  }
  if (!audio) {
    playerActions.push({
      key: 'speed', label: `Playback speed · ${playbackRateLabel(playbackRate)}`, active: playbackRate !== 1,
      icon: <span className="text-[11px] font-bold tabular-nums">{playbackRateLabel(playbackRate)}</span>,
      popup: 'dialog', expanded: speedOpen,
      onClick: () => { setActionsOpen(false); setCcOpen(false); setAudioOpen(false); setCastOpen(false); setSpeedOpen(true); },
    });
  }
  if (castDevices.length > 0 || canRemote) {
    playerActions.push({
      key: 'cast', label: tvCast ? `Playing on ${tvCast.name}` : 'Cast to TV', icon: <CastIcon />, active: casting || !!tvCast,
      popup: 'dialog', expanded: castOpen,
      onClick: () => { setActionsOpen(false); setCcOpen(false); setAudioOpen(false); setCastOpen(o => !o); },
    });
  } else if (!audio && remoteBlocked) {
    playerActions.push({
      key: 'cast-blocked', label: 'Casting needs HTTPS', icon: <CastIcon />, dim: true,
      onClick: () => { setActionsOpen(false); castBlocked(); },
    });
  }
  if (canAirplay) {
    playerActions.push({ key: 'airplay', label: 'AirPlay', icon: <AirplayIcon />, active: casting, onClick: () => { setActionsOpen(false); airplay(); } });
  }
  if (canPip) {
    playerActions.push({ key: 'pip', label: 'Picture in picture', icon: <PipIcon />, onClick: () => { setActionsOpen(false); togglePip(); } });
  }
  if (!audio) {
    playerActions.push({
      key: 'preferences', label: 'Player preferences', icon: <Icon.Settings size={20} />, active: settingsOpen,
      popup: 'dialog', expanded: settingsOpen,
      onClick: () => { setActionsOpen(false); setCcOpen(false); setAudioOpen(false); setSpeedOpen(false); setQualityOpen(false); setCastOpen(false); setChaptersOpen(false); setSettingsOpen(open => !open); },
    });
  }
  const controlsVisible = ctrlShow || !playing || controlsFocused || actionsOpen || ccOpen || audioOpen || speedOpen || qualityOpen || castOpen || settingsOpen || chaptersOpen || !!subJob;
  const mediaDuration = dur || (item.runtimeTicks ? item.runtimeTicks / 1e7 : 0) || 0;
  const playedPct = mediaDuration ? Math.max(0, Math.min(100, (curTime / mediaDuration) * 100)) : 0;
  const bufferedPct = mediaDuration ? Math.max(playedPct, Math.min(100, (bufferedEnd / mediaDuration) * 100)) : 0;
  const nearEpisodeEnd = !!activeEpisodeNavigation && (ended || (mediaDuration > 0
    && curTime >= Math.max(mediaDuration * 0.9, mediaDuration - 60)));
  const showEpisodePrompt = nearEpisodeEnd && (!!activeEpisodeNavigation?.next
    || !!activeEpisodeNavigation?.loading || !!activeEpisodeNavigation?.complete);
  const previousEpisodeControlDisabled = episodeSwitching
    || (!activeEpisodeNavigation?.previous && playerSec <= 3);
  const previousEpisodeControlLabel = playerSec > 3
    ? 'Restart episode (Shift+P)'
    : activeEpisodeNavigation?.previous
      ? `Previous episode: ${episodeNumberLabel(activeEpisodeNavigation.previous)} (Shift+P)`
      : 'No previous episode';
  const previousEpisodeControlTitle = playerSec > 3
    ? 'Restart episode (Shift+P)'
    : activeEpisodeNavigation?.previous ? 'Previous episode (Shift+P)' : 'No previous episode';
  const episodeStatusAnnouncement = showEpisodePrompt && activeEpisodeNavigation?.next && (!tvCast || castFinished) && !error
    ? autoplayWaitingForInteraction
      ? `Autoplay paused. Still watching? Up next: ${episodeNumberLabel(activeEpisodeNavigation.next)}`
      : autoplayCountdown != null
        ? `Autoplay will continue shortly. Up next: ${episodeNumberLabel(activeEpisodeNavigation.next)}`
        : `Up next: ${episodeNumberLabel(activeEpisodeNavigation.next)}`
    : '';
  const subtitleAppearance = videoPreferences.subtitleAppearance;
  const subtitleScale = subtitleAppearance.sizePct / 100;
  const subtitleOpacity = subtitleAppearance.contrast === 'high'
    ? Math.max(0.85, subtitleAppearance.opacity) : subtitleAppearance.opacity;
  const subtitleTextShadow = subtitleAppearance.edge === 'outline'
    ? '-2px -2px 0 #000, 2px -2px 0 #000, -2px 2px 0 #000, 2px 2px 0 #000'
    : subtitleAppearance.edge === 'shadow'
      ? '0 2px 3px #000, 0 0 6px rgba(0,0,0,.8)'
      : subtitleAppearance.contrast === 'high' ? '0 0 3px #000' : 'none';
  const subtitleStyle: React.CSSProperties = {
    fontSize: `clamp(${(1.05 * subtitleScale).toFixed(3)}rem, ${(3.4 * subtitleScale).toFixed(3)}vh, ${(2.6 * subtitleScale).toFixed(3)}rem)`,
    backgroundColor: subtitleAppearance.background === 'black' ? `rgba(0,0,0,${subtitleOpacity})` : 'transparent',
    color: subtitleAppearance.contrast === 'high' ? '#fff' : '#f8fafc',
    fontWeight: subtitleAppearance.contrast === 'high' ? 600 : 400,
    textShadow: subtitleTextShadow,
  };

  return createPortal((
    <div ref={containerRef} className="fixed inset-0 z-[300] bg-black flex flex-col animate-fade-in"
      role="dialog" aria-modal="true" aria-label={`Video player: ${item.name}`} tabIndex={-1}
      onPointerMove={() => { notePlaybackInteraction(); pokeCtrls(); }}
      onPointerDown={() => { notePlaybackInteraction(); pokeCtrls(); }}
      onFocusCapture={event => {
        const target = event.target;
        if (target instanceof HTMLElement && target !== containerRef.current && !target.matches('video, canvas')) setControlsFocused(true);
        pokeCtrls();
      }}
      onBlurCapture={event => {
        const next = event.relatedTarget;
        const focusedControl = next instanceof HTMLElement && containerRef.current?.contains(next)
          && next !== containerRef.current && !next.matches('video, canvas');
        setControlsFocused(!!focusedControl);
        pokeCtrls();
      }}>
      <div className={cx('absolute top-0 inset-x-0 z-[30] p-3 pt-[max(0.75rem,env(safe-area-inset-top))] bg-gradient-to-b from-black/90 via-black/55 to-transparent transition-opacity duration-300',
        controlsVisible ? 'opacity-100' : 'opacity-0 pointer-events-none')}>
        <div className="flex items-center gap-2 min-w-0">
          <button className="w-11 h-11 grid place-items-center rounded-full text-white hover:bg-white/15 active:bg-white/25 shrink-0" onClick={closePlayer} aria-label="Close player"><Icon.ChevronLeft size={26} /></button>
          <div className="min-w-0 flex-1 leading-tight">
            <p className="text-white font-semibold truncate">{item.name}</p>
            {(casting || item.seriesName) && (
              <p className={cx('mt-1 text-xs truncate', casting ? 'text-brand-300' : 'text-slate-400')}>
                {casting ? 'Casting to TV…' : <>{item.seriesName}{item.seasonNumber != null && item.episodeNumber != null ? ` · S${item.seasonNumber}E${item.episodeNumber}` : ''}</>}
              </p>
            )}
          </div>
          <div className="hidden lg:flex items-center gap-1 shrink-0" aria-label="Playback options">
            {playerActions.map(action => (
              <CtrlBtn key={action.key} onClick={action.onClick} title={action.label} active={action.active} dim={action.dim}
                popup={action.popup} expanded={action.expanded}>
                {action.icon}
              </CtrlBtn>
            ))}
          </div>
          {playerActions.length > 0 && (
            <div className="lg:hidden shrink-0">
              <CtrlBtn onClick={() => { setCcOpen(false); setAudioOpen(false); setSpeedOpen(false); setQualityOpen(false); setCastOpen(false); setSettingsOpen(false); setChaptersOpen(false); setActionsOpen(o => !o); }}
                title="More playback options" active={actionsOpen} popup="menu" expanded={actionsOpen}><Icon.More size={22} /></CtrlBtn>
            </div>
          )}
        </div>
        <PlayerActionMenu open={actionsOpen} actions={playerActions} onClose={() => setActionsOpen(false)} />
        <TrackMenu open={ccOpen} onClose={() => setCcOpen(false)} heading="Subtitles" current={subIdx} onPick={chooseSub}
          options={[{ key: 'off', label: 'Off', value: null }, ...subTracks.map((s, i) => ({ key: `s${s.index ?? i}`, label: s.name || s.lang || `Subtitle ${i + 1}`, value: s.index }))]}
          footer={(
            <div className="mt-1 border-t border-white/10 px-3 py-2.5">
              <div className="flex items-center gap-2">
                <span className="min-w-0 flex-1 text-xs text-slate-300">Subtitle timing <span className="tabular-nums text-slate-500">{videoPreferences.subtitleOffsetMs === 0 ? '0.0s' : `${videoPreferences.subtitleOffsetMs > 0 ? '+' : ''}${(videoPreferences.subtitleOffsetMs / 1000).toFixed(1)}s`}</span></span>
                <button type="button" className="min-w-11 h-11 rounded-lg bg-white/10 text-white hover:bg-white/15" onClick={() => updateVideoPreferences({ subtitleOffsetMs: videoPreferencesRef.current.subtitleOffsetMs - 100 })} aria-label="Show subtitles 0.1 seconds earlier">−0.1</button>
                <button type="button" className="min-w-11 h-11 rounded-lg bg-white/10 text-white hover:bg-white/15" onClick={() => updateVideoPreferences({ subtitleOffsetMs: 0 })} aria-label="Reset subtitle timing">Reset</button>
                <button type="button" className="min-w-11 h-11 rounded-lg bg-white/10 text-white hover:bg-white/15" onClick={() => updateVideoPreferences({ subtitleOffsetMs: videoPreferencesRef.current.subtitleOffsetMs + 100 })} aria-label="Show subtitles 0.1 seconds later">+0.1</button>
              </div>
              <button type="button" className="mt-2 w-full text-left text-xs text-brand-300 hover:text-brand-200"
                aria-haspopup="dialog" aria-expanded={settingsOpen}
                onClick={() => { setCcOpen(false); setSettingsOpen(true); }}>
                Appearance, languages and autoplay…
              </button>
            </div>
          )}
          tools={[
            { key: 'gen', label: subJob?.action === 'Generating' ? `Generating… ${Math.round(subJob.progress * 100)}%` : 'Create subtitles from audio', detail: 'Local speech-to-text with automatic language detection · this is not translation', disabled: !!subJob || !aiToolsAllowed, onClick: () => startSubJob('Generating', () => api.subtitles.generate(item.id)) },
            ...translationTools,
            { key: 'tr-settings', label: 'Choose translation engine & languages…', onClick: () => { setCcOpen(false); window.location.href = '/settings?tab=ai'; } },
            { key: 'sync', label: subJob?.action === 'Syncing' ? `Syncing… ${Math.round(subJob.progress * 100)}%` : 'Sync current to audio', disabled: !!subJob || subIdx == null || !aiToolsAllowed, onClick: () => { const s = currentSource(); if (s) startSubJob('Syncing', () => api.subtitles.sync(item.id, s)); } },
            { key: 'clean', label: 'Clean up current', disabled: !!subJob || subIdx == null || !aiToolsAllowed, onClick: () => { setCcOpen(false); cleanCurrent(); } },
          ]} />
        <TrackMenu open={audioOpen} onClose={() => setAudioOpen(false)} heading="Audio" current={audioIdx} onPick={chooseAudio}
          options={audioTracks.map((a, i) => ({ key: `a${a.index ?? i}`, label: audioTrackDisplayLabel(a, i), value: a.index }))} />
        <TrackMenu open={speedOpen} onClose={() => setSpeedOpen(false)} heading="Playback speed" current={playbackRate} onPick={value => choosePlaybackRate(Number(value))}
          options={VIDEO_PLAYBACK_RATES.map(rate => ({ key: `speed-${rate}`, label: `${playbackRateLabel(rate)}${rate === 1 ? ' · Normal' : ''}`, value: rate }))} />
        {playbackPlan && <TrackMenu open={qualityOpen} onClose={() => setQualityOpen(false)} heading="Video quality" current={videoPreferences.quality} onPick={chooseQuality}
          options={playbackPlan.qualityOptions.map(option => ({
            key: `quality-${option.id}`,
            label: `${option.label}${option.id === 'auto' ? ' · best for this device and connection' : option.id === 'original' ? ' · no resolution cap' : ' maximum'}`,
            value: option.id,
          }))} />}
        <PlayerPreferencesMenu open={settingsOpen} onClose={() => setSettingsOpen(false)} preferences={videoPreferences}
          audioTracks={audioTracks} subtitleTracks={subTracks} playbackPlan={playbackPlan} onChange={updateVideoPreferences} />
        <ChapterMenu open={chaptersOpen} onClose={() => setChaptersOpen(false)} chapters={chapters}
          currentIndex={currentChapterIndex} onSeek={seekChapter} onPrevious={previousChapter} onNext={nextChapter} />
        {/* Cast device picker */}
        {castOpen && (
          <>
            <div className="fixed inset-0 z-[310]" aria-hidden="true" onClick={() => setCastOpen(false)} />
            <div ref={castPopupRef} role="dialog" aria-label="Cast devices" tabIndex={-1}
              onKeyDown={event => handlePopupListKeyDown(event, () => setCastOpen(false))}
              className="absolute right-2 top-[max(3.75rem,calc(env(safe-area-inset-top)+3.25rem))] z-[320] w-64 max-w-[76vw] glass-strong rounded-xl shadow-float overflow-hidden animate-fade-in">
              <p className="px-3 py-2 text-[11px] uppercase tracking-wide text-slate-400 border-b border-white/10">Cast to</p>
              <div className="max-h-[52vh] overflow-y-auto py-1">
                {castDevices.map(d => (
                  <button key={d.ip} type="button" onClick={() => castToDevice(d)}
                    className={cx('w-full min-h-11 text-left px-3 py-2.5 text-sm flex items-center gap-2 hover:bg-white/10 active:bg-white/15',
                      tvCast?.ip === d.ip ? 'text-brand-400' : 'text-white')}>
                    <span className="w-4 shrink-0 grid place-items-center">{tvCast?.ip === d.ip && <Icon.Check size={16} />}</span>
                    <span className="truncate">{d.name}</span>
                  </button>
                ))}
                {canRemote && (
                  <button type="button" onClick={() => { setCastOpen(false); cast(); }}
                    className="w-full min-h-11 text-left px-3 py-2.5 text-sm flex items-center gap-2 hover:bg-white/10 active:bg-white/15 text-white">
                    <span className="w-4 shrink-0" />
                    <span className="truncate">Browser cast dialog…</span>
                  </button>
                )}
                {castDevices.length === 0 && !canRemote && (
                  <p className="px-3 py-2.5 text-sm text-slate-400">No cast devices found.</p>
                )}
                <button type="button"
                  onClick={() => api.cast.devices(true).then(d => setCastDevices(d || [])).catch(() => {})}
                  className="w-full min-h-11 text-left px-3 py-2.5 text-xs text-slate-400 hover:bg-white/10 border-t border-white/10">
                  ⟳ Rescan network
                </button>
              </div>
            </div>
          </>
        )}
      </div>
      {subJob && (
        <div className="absolute left-1/2 -translate-x-1/2 top-[calc(env(safe-area-inset-top)+4.75rem)] z-20 w-[calc(100%-2rem)] max-w-md rounded-2xl border border-white/10 bg-black/80 backdrop-blur-xl px-4 py-3 shadow-float pointer-events-none"
          role="progressbar" aria-label={`${subJob.action} AI subtitles`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={subJobPct}>
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-brand-500/20 text-brand-300 grid place-items-center shrink-0"><Icon.Sparkles size={18} /></div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center justify-between gap-3">
                <p className="text-sm font-semibold text-white truncate">{subJob.action} AI subtitles</p>
                <span className="text-sm font-semibold text-brand-300 tabular-nums shrink-0">{subJobPct}%</span>
              </div>
              <p className="text-xs text-slate-400 truncate mt-0.5">{subJobDetail}</p>
            </div>
          </div>
          <div className="relative h-2 mt-3 rounded-full overflow-hidden bg-white/10">
            <div className="absolute inset-y-0 left-0 rounded-full bg-gradient-to-r from-brand-600 to-brand-400 transition-[width] duration-500"
              style={{ width: `${subJobPct}%` }} />
            {subJobPct === 0 && <div className="absolute inset-y-0 left-0 w-1/4 rounded-full bg-brand-400/70 animate-pulse" />}
          </div>
        </div>
      )}
      {showEpisodePrompt && !tvCast && !error && (
        <div className={cx('absolute left-4 sm:left-8 z-[20] max-w-[calc(100%-2rem)] sm:max-w-sm rounded-xl border border-white/10 bg-black/80 backdrop-blur-lg p-3 shadow-float',
          activeSegment ? 'bottom-52 sm:bottom-48' : 'bottom-36 sm:bottom-32')}>
          {activeEpisodeNavigation?.next ? (
            <div className="flex items-center gap-3">
              <div className="min-w-0 flex-1">
                <p className="text-[11px] uppercase tracking-wide text-brand-300">
                  {autoplayWaitingForInteraction ? 'Still watching?' : autoplayCountdown != null ? `Playing next in ${autoplayCountdown}s` : 'Up next'}
                </p>
                <p className="text-sm font-medium text-white truncate mt-0.5">{episodeNumberLabel(activeEpisodeNavigation.next)}</p>
              </div>
              {autoplayWaitingForInteraction ? (
                <button type="button" className="btn-primary !min-h-11 !px-3 !py-2 shrink-0" onClick={() => { notePlaybackInteraction(); setAutoplayWaitingForInteraction(false); }}>
                  Keep watching
                </button>
              ) : autoplayCountdown != null ? (
                <div className="flex items-center gap-1.5 shrink-0">
                  <button type="button" className="btn-secondary !min-h-11 !px-3 !py-2" onClick={() => { setAutoplayCancelledForItem(item.id); setAutoplayCountdown(null); }}>Cancel</button>
                  <button type="button" className="btn-primary !min-h-11 !px-3 !py-2" disabled={episodeSwitching}
                    onClick={() => { notePlaybackInteraction(); void selectEpisode(activeEpisodeNavigation.next); }} aria-label={`Play now: ${episodeNumberLabel(activeEpisodeNavigation.next)}`}>
                    <Icon.Next size={16} /> Now
                  </button>
                </div>
              ) : (
                <button type="button" className="btn-primary !min-h-11 !px-3 !py-2 shrink-0" disabled={episodeSwitching}
                  onClick={() => { notePlaybackInteraction(); void selectEpisode(activeEpisodeNavigation.next); }} aria-label={`Play next: ${episodeNumberLabel(activeEpisodeNavigation.next)}`}>
                  <Icon.Next size={16} /> Next
                </button>
              )}
            </div>
          ) : activeEpisodeNavigation?.loading ? (
            <div className="flex items-center gap-2 text-sm text-slate-300"><Spinner size={16} /> Finding the next episode…</div>
          ) : (
            <p className="text-sm font-medium text-slate-200">End of series</p>
          )}
        </div>
      )}
      <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {episodeStatusAnnouncement}
      </div>
      {activeSegment && (!tvCast || (tvCanSeek && !castFinished)) && <button type="button" onClick={skipActiveSegment}
        className="absolute right-5 sm:right-10 bottom-36 sm:bottom-32 z-[20] rounded-xl bg-white text-black font-semibold px-5 py-3 shadow-float hover:bg-slate-100 active:scale-95 transition"
        aria-label={`Skip ${activeSegment.kind}`}>Skip {activeSegment.kind}</button>}
      {(loading || buffering) && !error && !tvCast && (
        <div className="absolute inset-0 z-[7] grid place-items-center text-white pointer-events-none" role="status" aria-live="polite">
          <div className="rounded-2xl bg-black/55 backdrop-blur-sm px-4 py-3 flex items-center gap-3 shadow-float">
            <Spinner size={loading ? 36 : 26} />
            <span className="text-sm font-medium">{loading ? 'Loading video…' : 'Buffering…'}</span>
          </div>
        </div>
      )}
      {error && (
        <div className="absolute inset-0 z-[9] grid place-items-center text-center p-6 bg-black/60">
          <div className="max-w-md rounded-2xl bg-ink-900/90 border border-white/10 p-5 shadow-float">
            <p className="text-white font-semibold">Playback stopped</p>
            <p className="text-sm text-slate-300 mt-1">{error}</p>
            <div className="flex items-center justify-center gap-2 mt-4">
              <button className="btn-primary !min-h-11" onClick={() => loadStream(audioIdx, curTime)}>Try again</button>
              <button className="btn-secondary !min-h-11" onClick={closePlayer}>Close</button>
            </div>
          </div>
        </div>
      )}
      {/* Casting overlay: the TV is playing, the local video stays paused */}
      {tvCast && (
        <div className="absolute inset-0 z-[5] grid place-items-center bg-black/85 p-6">
          <div className="text-center max-w-sm w-full">
            <div className="mx-auto w-16 h-16 rounded-2xl bg-brand-600/20 text-brand-400 grid place-items-center mb-4"><CastIcon /></div>
            <p className="text-white font-semibold text-lg truncate">{castFinished ? 'Finished on' : 'Playing on'} {tvCast.name}</p>
            <p className="text-sm text-slate-400 mt-1 truncate">{item.name}</p>
            <p className="text-xs text-slate-500 mt-2 tabular-nums">
              {episodeSwitching ? 'Switching episode…' : castFinished ? 'Finished' : tvState?.playerState === 'PAUSED' ? 'Paused' : tvState?.playerState === 'BUFFERING' ? 'Buffering…' : 'Playing'}
              {tvState?.currentTime != null && ` · ${formatDuration(tvState.currentTime + tvOffset.current)}${tvState?.duration ? ` / ${formatDuration(tvState.duration + tvOffset.current)}` : ''}`}
            </p>
            {castSwitchError && (
              <p className="mt-3 rounded-lg border border-red-400/25 bg-red-500/10 px-3 py-2 text-xs leading-relaxed text-red-200" role="alert">
                {castSwitchError}
              </p>
            )}
            {castFinished && activeEpisodeNavigation?.next && (
              <div className="mt-4 rounded-xl border border-white/10 bg-white/5 px-3 py-3 text-left">
                <p className="text-[11px] uppercase tracking-wide text-brand-300">
                  {autoplayWaitingForInteraction ? 'Still watching?' : autoplayCountdown != null ? `Playing next in ${autoplayCountdown}s` : 'Up next'}
                </p>
                <p className="mt-1 truncate text-sm font-medium text-white">{episodeNumberLabel(activeEpisodeNavigation.next)}</p>
                {autoplayWaitingForInteraction ? (
                  <button type="button" className="btn-primary mt-3 !min-h-11 !px-3 !py-2"
                    onClick={() => { notePlaybackInteraction(); setAutoplayWaitingForInteraction(false); }}>
                    Keep watching
                  </button>
                ) : autoplayCountdown != null ? (
                  <button type="button" className="btn-secondary mt-3 !min-h-11 !px-3 !py-2"
                    onClick={() => { setAutoplayCancelledForItem(item.id); setAutoplayCountdown(null); }}>
                    Cancel autoplay
                  </button>
                ) : null}
              </div>
            )}
            {castFinished && activeEpisodeNavigation?.complete && !activeEpisodeNavigation.next && (
              <p className="mt-4 text-sm font-medium text-slate-300">End of series</p>
            )}
            <div className="flex items-center justify-center gap-2 mt-5 flex-wrap">
              {activeEpisodeNavigation && (
                <button type="button" className="w-11 h-11 grid place-items-center rounded-full text-white bg-white/10 hover:bg-white/15 active:bg-white/25 disabled:opacity-45"
                  onClick={previousEpisode} disabled={previousEpisodeControlDisabled}
                  aria-label={previousEpisodeControlLabel} title={previousEpisodeControlTitle}>
                  <Icon.Prev size={20} />
                </button>
              )}
              {tvCanSeek && !castFinished && <button className="btn-secondary !min-h-11 !px-3.5" onClick={() => tvSkip(-30)} title="Back 30 seconds">−30s</button>}
              {!castFinished && <button className="btn-secondary !min-h-11 !px-4"
                disabled={episodeSwitching}
                onClick={toggleTvPlayback}>
                {tvState?.playerState === 'PAUSED' ? <><Icon.Play size={16} /> Resume</> : <><Icon.Pause size={16} /> Pause</>}
              </button>}
              {tvCanSeek && !castFinished && <button className="btn-secondary !min-h-11 !px-3.5" onClick={() => tvSkip(30)} title="Forward 30 seconds">+30s</button>}
              {activeEpisodeNavigation?.next && (
                <button type="button" className="w-11 h-11 grid place-items-center rounded-full text-white bg-white/10 hover:bg-white/15 active:bg-white/25 disabled:opacity-45"
                  onClick={() => void selectEpisode(activeEpisodeNavigation.next)} disabled={episodeSwitching}
                  aria-label={`Next episode: ${episodeNumberLabel(activeEpisodeNavigation.next)} (Shift+N)`} title="Next episode (Shift+N)">
                  <Icon.Next size={20} />
                </button>
              )}
            </div>
            <button className="btn-primary !min-h-11 !px-5 mt-3" onClick={stopCasting}>
              <Icon.Play size={15} /> {castFinished ? 'Replay here' : 'Play here instead'}
            </button>
          </div>
        </div>
      )}
      <video ref={videoRef} controls={false} playsInline
        onClick={() => { pokeCtrls(); togglePlay(); }}
        onDoubleClick={toggleFs}
        className={cx('w-full h-full object-contain bg-black', upscale && 'opacity-0')}
        poster={item.backdropUrl || item.posterUrl} aria-label={`Playing ${item.name}`} />
      {/* 2K upscale output: FSR-rendered frames from the (invisible) video */}
      {upscale && (
        <canvas ref={canvasRef} className="absolute inset-0 z-[2] w-full h-full object-contain bg-black pointer-events-none" />
      )}
      {/* Shared subtitle overlay stays clear of the single Aerie control bar. */}
      {!tvCast && cueText && (
        <div className={cx('absolute inset-x-0 z-[4] flex justify-center px-6 pointer-events-none transition-all',
          controlsVisible ? 'bottom-28 sm:bottom-24' : 'bottom-8')}>
          <p className="text-center leading-snug rounded-lg px-3 py-1.5 whitespace-pre-line max-w-[90%]"
            style={subtitleStyle}>{cueText}</p>
        </div>
      )}
      {/* One control surface for native, HLS and upscaled playback. */}
      {!tvCast && !error && (
        <div className={cx('absolute inset-x-0 bottom-0 z-[8] px-3 sm:px-5 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-12',
          'bg-gradient-to-t from-black/95 via-black/70 to-transparent transition-opacity duration-300',
          controlsVisible ? 'opacity-100' : 'opacity-0 pointer-events-none')} role="group" aria-label="Playback controls">
          <div className="relative h-8 flex items-center"
            onPointerLeave={() => setSeekPreview(null)}
            onPointerMove={e => {
              if (audio || !mediaDuration) return;
              const rect = e.currentTarget.getBoundingClientRect();
              const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
              setSeekPreview({ sec: pct * mediaDuration, leftPct: pct * 100 });
            }}>
            {seekPreview && !audio && (
              <div className="absolute bottom-8 -translate-x-1/2 pointer-events-none"
                style={{ left: `clamp(5rem, ${seekPreview.leftPct}%, calc(100% - 5rem))` }}>
                <img src={api.media.previewUrl(item.id, seekPreview.sec)} alt=""
                  className="w-40 aspect-video object-cover rounded-lg border border-white/20 bg-black shadow-float" />
                <p className="text-center text-xs text-white bg-black/80 rounded px-1.5 py-0.5 w-fit mx-auto -mt-6 relative">{formatDuration(seekPreview.sec)}</p>
              </div>
            )}
            <span aria-hidden="true" className="absolute inset-x-0 top-1/2 h-1.5 -translate-y-1/2 rounded-full"
              style={{ background: `linear-gradient(to right, rgb(99 102 241) 0% ${playedPct}%, rgba(255,255,255,.38) ${playedPct}% ${bufferedPct}%, rgba(255,255,255,.18) ${bufferedPct}% 100%)` }} />
            {mediaDuration > 0 && chapters.filter(chapter => chapter.startSec > 0 && chapter.startSec < mediaDuration).map(chapter => (
              <button key={`${chapter.startSec}-${chapter.name}`} type="button"
                className="absolute top-1/2 z-[2] h-11 w-[24px] -translate-x-1/2 -translate-y-1/2 group/chapter"
                style={{ left: `${Math.max(0, Math.min(100, (chapter.startSec / mediaDuration) * 100))}%` }}
                onClick={() => { notePlaybackInteraction(); seekChapter(chapter.startSec); }}
                aria-label={`Go to chapter ${chapter.name}, ${formatDuration(chapter.startSec)}`} title={`${chapter.name} · ${formatDuration(chapter.startSec)}`}>
                <span className="absolute left-1/2 top-1/2 h-3.5 w-0.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white/80 group-hover/chapter:bg-white" />
              </button>
            ))}
            <input type="range" min={0} max={mediaDuration || 1} step={0.1}
              value={Math.min(curTime, mediaDuration || Number.MAX_SAFE_INTEGER)} disabled={!mediaDuration}
              aria-label="Seek through video" aria-valuetext={`${formatDuration(curTime)} of ${formatDuration(mediaDuration)}`}
              onInput={e => { const v = videoRef.current; if (v) v.currentTime = +(e.target as HTMLInputElement).value; }}
              className="aerie-video-seek absolute inset-x-0 top-1/2 z-[1] w-full -translate-y-1/2 disabled:cursor-default" />
          </div>
          <div className="flex items-center gap-1 sm:gap-2 min-w-0">
            {activeEpisodeNavigation && (
              <button type="button" onClick={previousEpisode} disabled={previousEpisodeControlDisabled}
                aria-label={previousEpisodeControlLabel} title={previousEpisodeControlTitle}
                className="w-11 h-11 grid place-items-center rounded-full text-white hover:bg-white/15 active:bg-white/25 disabled:opacity-50 shrink-0">
                <Icon.Prev size={21} />
              </button>
            )}
            <button type="button" onClick={togglePlay} aria-label={playing ? 'Pause (Space or K)' : 'Play (Space or K)'}
              title={playing ? 'Pause (Space or K)' : 'Play (Space or K)'}
              className="w-11 h-11 grid place-items-center rounded-full text-white hover:bg-white/15 active:bg-white/25 shrink-0">
              {playing ? <Icon.Pause size={22} /> : <Icon.Play size={22} />}
            </button>
            {activeEpisodeNavigation?.next && (
              <button type="button" onClick={() => selectEpisode(activeEpisodeNavigation.next)} disabled={episodeSwitching}
                aria-label={`Next episode: ${episodeNumberLabel(activeEpisodeNavigation.next)} (Shift+N)`} title="Next episode (Shift+N)"
                className="w-11 h-11 grid place-items-center rounded-full text-white hover:bg-white/15 active:bg-white/25 disabled:opacity-50 shrink-0">
                <Icon.Next size={21} />
              </button>
            )}
            <button type="button" onClick={() => { const v = videoRef.current; if (v) v.currentTime = Math.max(0, v.currentTime - 10); }}
              aria-label="Back 10 seconds" title="Back 10 seconds (J)"
              className="hidden sm:grid w-10 h-10 place-items-center rounded-full text-xs font-semibold text-white hover:bg-white/15 active:bg-white/25 shrink-0">−10</button>
            <button type="button" onClick={() => { const v = videoRef.current; if (v) v.currentTime = Math.min(v.duration || Number.MAX_SAFE_INTEGER, v.currentTime + 10); }}
              aria-label="Forward 10 seconds" title="Forward 10 seconds (L)"
              className="hidden sm:grid w-10 h-10 place-items-center rounded-full text-xs font-semibold text-white hover:bg-white/15 active:bg-white/25 shrink-0">+10</button>
            <span className="text-[11px] sm:text-xs text-slate-200 tabular-nums whitespace-nowrap shrink-0" aria-live="off">
              {formatDuration(curTime)}
              {mediaDuration > 0 && <span className="hidden min-[360px]:inline"> / {formatDuration(mediaDuration)}</span>}
            </span>
            <span className="flex-1 min-w-0" />
            {playbackPlan && (
              <span className="hidden xl:inline-flex chip !py-0.5 !px-2 text-[10px] bg-white/10 text-slate-200 border border-white/10 whitespace-nowrap"
                title={`${playbackPlan.source.videoCodec.toUpperCase()} source${playbackPlan.source.height ? ` ${playbackPlan.source.height}p` : ''} → ${playbackPlan.output.videoCodec.toUpperCase()}${playbackPlan.audio.stereoFallback ? ' · surround converted to stereo' : ''}`}>
                {playbackStatusLabel(playbackPlan, activePlaybackVariant)}
              </span>
            )}
            {upscale && (
              <span className="hidden xl:inline-flex chip !py-0.5 !px-2 text-[10px] bg-brand-600/25 text-brand-300 border border-brand-500/30 whitespace-nowrap">
                {upRes ? `${upRes.sw}×${upRes.sh} → ${upRes.dw}×${upRes.dh} · GPU` : '2K · GPU'}
              </span>
            )}
            <button type="button" onClick={() => { const v = videoRef.current; if (v) v.muted = !v.muted; }}
              aria-label={muted ? 'Unmute (M)' : 'Mute (M)'} title={muted ? 'Unmute (M)' : 'Mute (M)'}
              className="w-11 h-11 grid place-items-center rounded-full text-white hover:bg-white/15 active:bg-white/25 shrink-0">
              {muted || vol === 0 ? <MutedIcon /> : <Icon.Volume size={20} />}
            </button>
            <input type="range" min={0} max={1} step={0.05} value={muted ? 0 : vol} aria-label="Volume"
              onInput={e => { const v = videoRef.current; if (v) { v.muted = false; v.volume = +(e.target as HTMLInputElement).value; } }}
              className="w-24 accent-brand-500 hidden md:block" />
            <button type="button" onClick={toggleFs} aria-label={isFs ? 'Exit fullscreen (F)' : 'Fullscreen (F)'}
              title={isFs ? 'Exit fullscreen (F)' : 'Fullscreen (F)'}
              className="w-11 h-11 grid place-items-center rounded-full text-white hover:bg-white/15 active:bg-white/25 shrink-0">
              {isFs ? <ShrinkIcon /> : <ExpandIcon />}
            </button>
          </div>
        </div>
      )}
    </div>
  ), document.body);
}
