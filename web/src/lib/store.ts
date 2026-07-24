// Global state: auth, the app-wide media player (audio), and toast notifications.
import { create } from 'zustand';
import type { User, MediaItem, Book } from './model';
import {
  acknowledgeApiAuthMarker,
  api,
  configureApiCookieSessionSync,
  invalidateApiAccountScope,
  setApiAccountScope,
  setToken,
} from './api';
import { downloads } from './downloads';
import { accountScopedStorageKey } from './account-storage';
import { createAuthSync, type AuthSyncHandle, type AuthSyncReason } from './auth-sync';

// ---------- Auth ----------
interface AuthState {
  user: User | null;
  loading: boolean;
  init: () => Promise<void>;
  login: (u: string, p: string, code?: string) => Promise<'ok' | 'needs2fa'>;
  logout: () => Promise<void>;
  setUser: (u: User) => void;
}

let authOperation = 0;
let authSync: AuthSyncHandle | null = null;
let handledPeerMarker: string | null = null;
let peerMarkerListener: ((event: Event) => void) | null = null;
let invalidatedListener: (() => void) | null = null;

function stopPrivateMedia(removeSaved = false) {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event('aerie:stop-private-media'));
  deactivatePlayerSession(removeSaved);
  usePlayer.getState().clear();
}

function lockLocalAuth(previousUserId: number | undefined, loading: boolean, invalidate = true, removeSaved = false): Promise<void> {
  stopPrivateMedia(removeSaved);
  const lock = downloads.lock(previousUserId).catch(() => undefined);
  setToken(null);
  if (invalidate) invalidateApiAccountScope();
  useAuth.setState({ user: null, loading });
  return lock;
}

function publishAuthChange(reason: AuthSyncReason) {
  const event = authSync?.publish(reason);
  if (!event) return;
  handledPeerMarker = event.marker;
  acknowledgeApiAuthMarker(event.marker);
}

async function revalidatePeerSession(operation: number) {
  try {
    const { user } = await api.me();
    if (operation !== authOperation) return;
    setApiAccountScope(user.id);
    try { await downloads.activate(user.id); }
    catch { await downloads.lock().catch(() => undefined); }
    if (operation !== authOperation) return;
    activatePlayerSession(user.id);
    useAuth.setState({ user, loading: false });
  } catch {
    if (operation !== authOperation) return;
    await downloads.lock().catch(() => undefined);
    deactivatePlayerSession(false);
    usePlayer.getState().clear();
    setToken(null);
    setApiAccountScope(null);
    useAuth.setState({ user: null, loading: false });
  }
}

function handlePeerSessionChange(marker: string, alreadyInvalidated = false) {
  if (!marker || marker === handledPeerMarker) return;
  handledPeerMarker = marker;
  acknowledgeApiAuthMarker(marker);
  const operation = ++authOperation;
  const previousUserId = useAuth.getState().user?.id;
  void lockLocalAuth(previousUserId, true, !alreadyInvalidated);
  void revalidatePeerSession(operation);
}

function startAuthSynchronization() {
  if (authSync || typeof window === 'undefined') return;
  authSync = createAuthSync(event => handlePeerSessionChange(event.marker));
  configureApiCookieSessionSync(authSync.enabled);

  peerMarkerListener = (event: Event) => {
    const marker = (event as CustomEvent<{ marker?: string }>).detail?.marker;
    if (marker) handlePeerSessionChange(marker, true);
  };
  invalidatedListener = () => {
    ++authOperation;
    const previousUserId = useAuth.getState().user?.id;
    void lockLocalAuth(previousUserId, false, false);
    publishAuthChange('session-invalidated');
  };
  window.addEventListener('aerie:peer-auth-marker', peerMarkerListener);
  window.addEventListener('aerie:auth-invalidated', invalidatedListener);
}

export function stopAuthSynchronization() {
  authSync?.close();
  authSync = null;
  configureApiCookieSessionSync(false);
  if (typeof window !== 'undefined') {
    if (peerMarkerListener) window.removeEventListener('aerie:peer-auth-marker', peerMarkerListener);
    if (invalidatedListener) window.removeEventListener('aerie:auth-invalidated', invalidatedListener);
  }
  peerMarkerListener = null;
  invalidatedListener = null;
}

export const useAuth = create<AuthState>((set, get) => ({
  user: null,
  loading: true,
  init: async () => {
    startAuthSynchronization();
    const operation = ++authOperation;
    try {
      const { user } = await api.me();
      if (operation !== authOperation) return;
      setApiAccountScope(user.id);
      await downloads.activate(user.id);
      if (operation !== authOperation) return;
      activatePlayerSession(user.id);
      set({ user, loading: false });
    } catch {
      if (operation !== authOperation) return;
      // A stale or rejected session must not leave a previous account's player
      // queue or offline-cache binding alive in this tab.
      void downloads.lock().catch(() => undefined);
      deactivatePlayerSession(false);
      usePlayer.getState().clear();
      setToken(null);
      setApiAccountScope(null);
      set({ user: null, loading: false });
    }
  },
  login: async (username, password, code) => {
    startAuthSynchronization();
    const operation = ++authOperation;
    const res = await api.login(username, password, code);
    if (operation !== authOperation) throw new Error('account_session_changed');
    if ('needs2fa' in res) return 'needs2fa';
    const previous = get().user;
    if (previous?.id !== res.user.id) stopPrivateMedia();
    setToken(res.token);
    setApiAccountScope(res.user.id);
    // activate() locks a different account synchronously before its first
    // await; expose the new identity only after that lock has started.
    const activation = downloads.activate(res.user.id);
    set({ user: res.user, loading: false });
    publishAuthChange('login');
    try { await activation; }
    catch { await downloads.lock().catch(() => undefined); }
    if (operation !== authOperation) throw new Error('account_session_changed');
    activatePlayerSession(res.user.id);
    try { await api.devices.heartbeat(navigator.platform || 'Web', 'web'); } catch { /* */ }
    return 'ok';
  },
  logout: async () => {
    // Start the authenticated server request before dropping the token, while
    // locking private local state synchronously for the current account.
    const operation = ++authOperation;
    const user = get().user;
    const remoteLogout = api.logout().then(() => {
      if (operation === authOperation) publishAuthChange('logout');
    }).catch(() => undefined);
    const offlineLock = lockLocalAuth(user?.id, false, true, true);
    await Promise.all([remoteLogout, offlineLock]);
  },
  setUser: (user) => {
    startAuthSynchronization();
    setApiAccountScope(user.id);
    if (get().user?.id !== user.id) {
      ++authOperation;
      stopPrivateMedia();
    }
    // activate() immediately locks a different current scope before its first
    // await, so an account switch cannot briefly expose the old member's list.
    void downloads.activate(user.id).catch(() => downloads.lock(user.id).catch(() => undefined));
    activatePlayerSession(user.id);
    set({ user, loading: false });
  },
}));

startAuthSynchronization();

// ---------- Global audio player (music / audiobooks / podcasts) ----------
export interface Track {
  id: string;
  title: string;
  subtitle?: string;
  artUrl?: string;
  streamUrl: string;
  kind: 'music' | 'audiobook' | 'podcast';
  durationSec?: number;
  startAt?: number;   // resume position in seconds (audiobooks)
  timelineOffsetSec?: number; // local stream position -> whole book position
  totalDurationSec?: number;
  albumId?: string;
  replayGain?: {
    trackDb?: number;
    albumDb?: number;
    trackPeak?: number;
    albumPeak?: number;
  };
  cast?: {
    source: 'jellyfin' | 'audiobookshelf';
    itemId: string;
    fileId?: string;
  };
}
interface PlayerState {
  queue: Track[];
  index: number;
  current: Track | null;
  playing: boolean;
  progress: number;   // 0..1
  currentTime: number;
  duration: number;
  volume: number;
  muted: boolean;
  playbackRate: number;
  normalizationEnabled: boolean;
  shuffle: boolean;
  repeat: 'off' | 'one' | 'all';
  selectionId: number;
  history: number[];
  shuffleRemaining: number[];
  playTrack: (t: Track, queue?: Track[]) => void;
  playQueue: (q: Track[], startIndex?: number) => void;
  playAt: (i: number) => void;
  playNext: (tracks: Track | Track[]) => void;
  addToQueue: (tracks: Track | Track[]) => void;
  clearUpcoming: () => void;
  toggle: () => void;
  next: () => void;
  prev: () => void;
  removeAt: (i: number) => void;
  moveTrack: (from: number, to: number) => void;
  setPlaying: (p: boolean) => void;
  setProgress: (t: number, d: number) => void;
  setVolume: (v: number) => void;
  setMuted: (m: boolean) => void;
  setPlaybackRate: (rate: number) => void;
  setNormalizationEnabled: (enabled: boolean) => void;
  consumeStartAt: () => void;
  toggleShuffle: () => void;
  cycleRepeat: () => void;
  clear: () => void;
}

const PLAYER_SESSION_VERSION = 1;
const PLAYER_SESSION_NAMESPACE = 'aerie-player-v1';
const MAX_SAVED_QUEUE = 500;
const MAX_SESSION_AGE_MS = 30 * 24 * 60 * 60 * 1000;

type SavedPlayerSession = {
  version: 1;
  accountId: number;
  savedAt: number;
  queue: Track[];
  index: number;
  positionSec: number;
  durationSec: number;
  volume: number;
  muted: boolean;
  playbackRate: number;
  normalizationEnabled?: boolean;
  shuffle: boolean;
  repeat: PlayerState['repeat'];
};

let activePlayerAccountId: number | null = null;
let persistPlayerTimer: ReturnType<typeof setTimeout> | null = null;

function playerStorage(): Storage | null {
  try { return typeof localStorage === 'undefined' ? null : localStorage; }
  catch { return null; }
}

function playerSessionKey(accountId: number): string {
  return accountScopedStorageKey(PLAYER_SESSION_NAMESPACE, accountId);
}

function finiteNumber(value: unknown, min: number, max: number): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max ? value : undefined;
}

function safePlayerUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value || value.length > 4096) return undefined;
  try {
    if (typeof location === 'undefined') return value.startsWith('/') ? value : undefined;
    const url = new URL(value, location.origin);
    if (url.origin !== location.origin || url.username || url.password) return undefined;
    // Playback URLs authenticate with the HttpOnly session cookie. Never retain
    // legacy bearer credentials if an older server happened to return one.
    url.searchParams.delete('token');
    url.searchParams.delete('access_token');
    return value.startsWith('/') ? `${url.pathname}${url.search}${url.hash}` : url.toString();
  } catch { return undefined; }
}

function savedTrack(value: unknown): Track | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Partial<Track>;
  const streamUrl = safePlayerUrl(raw.streamUrl);
  if (typeof raw.id !== 'string' || !raw.id || raw.id.length > 512
    || typeof raw.title !== 'string' || !raw.title || raw.title.length > 1000
    || !streamUrl || !['music', 'audiobook', 'podcast'].includes(String(raw.kind))) return null;
  const track: Track = {
    id: raw.id,
    title: raw.title,
    streamUrl,
    kind: raw.kind as Track['kind'],
  };
  if (typeof raw.subtitle === 'string' && raw.subtitle.length <= 1000) track.subtitle = raw.subtitle;
  const artUrl = safePlayerUrl(raw.artUrl);
  if (artUrl) track.artUrl = artUrl;
  const durationSec = finiteNumber(raw.durationSec, 0, 366 * 24 * 3600);
  if (durationSec != null) track.durationSec = durationSec;
  const startAt = finiteNumber(raw.startAt, 0, 366 * 24 * 3600);
  if (startAt != null) track.startAt = startAt;
  const timelineOffsetSec = finiteNumber(raw.timelineOffsetSec, 0, 366 * 24 * 3600);
  if (timelineOffsetSec != null) track.timelineOffsetSec = timelineOffsetSec;
  const totalDurationSec = finiteNumber(raw.totalDurationSec, 0, 366 * 24 * 3600);
  if (totalDurationSec != null) track.totalDurationSec = totalDurationSec;
  if (typeof raw.albumId === 'string' && raw.albumId.length <= 512) track.albumId = raw.albumId;
  const replayGain = raw.replayGain;
  if (replayGain && typeof replayGain === 'object') {
    const safeGain = {
      trackDb: finiteNumber(replayGain.trackDb, -60, 24),
      albumDb: finiteNumber(replayGain.albumDb, -60, 24),
      trackPeak: finiteNumber(replayGain.trackPeak, Number.MIN_VALUE, 16),
      albumPeak: finiteNumber(replayGain.albumPeak, Number.MIN_VALUE, 16),
    };
    if (Object.values(safeGain).some(value => value != null)) {
      track.replayGain = {};
      if (safeGain.trackDb != null) track.replayGain.trackDb = safeGain.trackDb;
      if (safeGain.albumDb != null) track.replayGain.albumDb = safeGain.albumDb;
      if (safeGain.trackPeak != null) track.replayGain.trackPeak = safeGain.trackPeak;
      if (safeGain.albumPeak != null) track.replayGain.albumPeak = safeGain.albumPeak;
    }
  }
  const cast = raw.cast;
  if (cast && (cast.source === 'jellyfin' || cast.source === 'audiobookshelf')
    && typeof cast.itemId === 'string' && cast.itemId.length <= 512) {
    track.cast = {
      source: cast.source,
      itemId: cast.itemId,
      ...(typeof cast.fileId === 'string' && cast.fileId.length <= 512 ? { fileId: cast.fileId } : {}),
    };
  }
  return track;
}

function shuffledIndices(length: number, except: number): number[] {
  const values = Array.from({ length }, (_, index) => index).filter(index => index !== except);
  for (let i = values.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [values[i], values[j]] = [values[j], values[i]];
  }
  return values;
}

function playerSelection(queue: Track[], index: number, selectionId: number) {
  const current = queue[index] || null;
  const currentTime = current?.startAt || 0;
  const duration = current?.durationSec || 0;
  return {
    queue,
    index: current ? index : 0,
    current,
    playing: !!current,
    progress: duration > 0 ? Math.min(1, currentTime / duration) : 0,
    currentTime,
    duration,
    selectionId: selectionId + 1,
  };
}

export const usePlayer = create<PlayerState>((set, get) => ({
  queue: [], index: 0, current: null, playing: false,
  progress: 0, currentTime: 0, duration: 0, volume: 1, muted: false, playbackRate: 1, normalizationEnabled: false,
  shuffle: false, repeat: 'off', selectionId: 0, history: [], shuffleRemaining: [],
  playTrack: (t, suppliedQueue) => set(s => {
    let queue = suppliedQueue?.length ? suppliedQueue.slice() : [t];
    let index = queue.indexOf(t);
    if (index < 0) index = queue.findIndex(x => x.id === t.id && x.streamUrl === t.streamUrl);
    if (index < 0) index = queue.findIndex(x => x.id === t.id);
    if (index < 0) { queue = [t, ...queue]; index = 0; }
    const selection = playerSelection(queue, index, s.selectionId);
    return {
      ...selection,
      history: [],
      shuffleRemaining: s.shuffle && queue[index]?.kind === 'music' ? shuffledIndices(queue.length, index) : [],
    };
  }),
  playQueue: (q, startIndex = 0) => set(s => {
    if (!q.length) return {
      queue: [], index: 0, current: null, playing: false, progress: 0,
      currentTime: 0, duration: 0, history: [], shuffleRemaining: [],
      selectionId: s.selectionId + 1,
    };
    const index = Math.min(Math.max(0, Math.trunc(startIndex) || 0), q.length - 1);
    return {
      ...playerSelection(q.slice(), index, s.selectionId),
      history: [],
      shuffleRemaining: s.shuffle && q[index]?.kind === 'music' ? shuffledIndices(q.length, index) : [],
    };
  }),
  playAt: (i) => set(s => {
    if (!Number.isInteger(i) || i < 0 || i >= s.queue.length || i === s.index) {
      return i === s.index && s.current ? { playing: true } : {};
    }
    return {
      ...playerSelection(s.queue, i, s.selectionId),
      history: s.shuffle && s.queue[i]?.kind === 'music' ? [...s.history, s.index].slice(-s.queue.length) : [],
      shuffleRemaining: s.shuffle && s.queue[i]?.kind === 'music' ? s.shuffleRemaining.filter(index => index !== i) : [],
    };
  }),
  playNext: (value) => set(s => {
    const additions = (Array.isArray(value) ? value : [value]).filter(Boolean);
    if (!additions.length) return {};
    if (!s.current || !s.queue.length) {
      return {
        ...playerSelection(additions.slice(), 0, s.selectionId),
        history: [],
        shuffleRemaining: s.shuffle && additions[0]?.kind === 'music' ? shuffledIndices(additions.length, 0) : [],
      };
    }
    const insertion = s.index + 1;
    const queue = s.queue.slice();
    queue.splice(insertion, 0, ...additions);
    const remap = (index: number) => index >= insertion ? index + additions.length : index;
    const inserted = additions.map((_, offset) => insertion + offset);
    const shuffleActive = s.shuffle && s.current.kind === 'music';
    return {
      queue,
      current: queue[s.index],
      history: s.history.map(remap),
      // User-selected "Play next" takes priority over the random bag while
      // preserving every remaining shuffled item after the insertion.
      shuffleRemaining: shuffleActive
        ? [...inserted, ...s.shuffleRemaining.map(remap).filter(index => !inserted.includes(index))]
        : s.shuffleRemaining.map(remap),
    };
  }),
  addToQueue: (value) => set(s => {
    const additions = (Array.isArray(value) ? value : [value]).filter(Boolean);
    if (!additions.length) return {};
    if (!s.current || !s.queue.length) {
      return {
        ...playerSelection(additions.slice(), 0, s.selectionId),
        history: [],
        shuffleRemaining: s.shuffle && additions[0]?.kind === 'music' ? shuffledIndices(additions.length, 0) : [],
      };
    }
    const first = s.queue.length;
    const queue = [...s.queue, ...additions];
    const appended = additions.map((_, offset) => first + offset);
    return {
      queue,
      current: queue[s.index],
      shuffleRemaining: s.shuffle && s.current.kind === 'music'
        ? [...s.shuffleRemaining, ...appended]
        : s.shuffleRemaining,
    };
  }),
  clearUpcoming: () => set(s => {
    if (!s.current || !s.queue.length) return {};
    if (!(s.shuffle && s.current.kind === 'music')) {
      if (s.index >= s.queue.length - 1) return {};
      return { queue: s.queue.slice(0, s.index + 1), current: s.current };
    }
    if (!s.shuffleRemaining.length) return {};
    // A shuffled queue's future is the bag, not the visual index order. Keep
    // every visited item so Previous remains meaningful, then compact indices.
    const keep = new Set([...s.history, s.index]);
    const queue: Track[] = [];
    const remap = new Map<number, number>();
    s.queue.forEach((track, index) => {
      if (!keep.has(index)) return;
      remap.set(index, queue.length);
      queue.push(track);
    });
    const index = remap.get(s.index);
    if (index == null) return {};
    return {
      queue,
      index,
      current: queue[index],
      history: s.history.map(value => remap.get(value)).filter((value): value is number => value != null),
      shuffleRemaining: [],
    };
  }),
  toggle: () => set(s => ({ playing: !s.playing })),
  setPlaying: (playing) => set({ playing }),
  next: () => {
    const { queue, index, repeat, shuffle, shuffleRemaining, history, selectionId, current } = get();
    if (!queue.length) return;
    const shuffleActive = shuffle && current?.kind === 'music';
    const repeatQueue = repeat === 'all' && current?.kind === 'music';
    let ni: number;
    let remaining = shuffleRemaining;
    if (shuffleActive) {
      if (!remaining.length) {
        if (!repeatQueue) return set({ playing: false });
        remaining = shuffledIndices(queue.length, index);
      }
      if (!remaining.length) return set({ playing: false });
      [ni, ...remaining] = remaining;
    } else {
      ni = index + 1;
      if (ni >= queue.length) {
        if (repeatQueue) ni = 0;
        else return set({ playing: false });
      }
    }
    set({
      ...playerSelection(queue, ni, selectionId),
      history: [...history, index].slice(-queue.length),
      shuffleRemaining: remaining,
    });
  },
  prev: () => {
    const { queue, index, shuffle, shuffleRemaining, history, selectionId, current } = get();
    if (!queue.length) return;
    const shuffleActive = shuffle && current?.kind === 'music';
    const ni = shuffleActive && history.length ? history[history.length - 1] : Math.max(0, index - 1);
    if (ni === index) return;
    set({
      ...playerSelection(queue, ni, selectionId),
      history: shuffleActive ? history.slice(0, -1) : history,
      shuffleRemaining: shuffleActive ? [index, ...shuffleRemaining.filter(value => value !== index)] : shuffleRemaining,
    });
  },
  removeAt: (i) => set(s => {
    if (!Number.isInteger(i) || i < 0 || i >= s.queue.length) return {};
    if (s.queue.length === 1) return {
      queue: [], index: 0, current: null, playing: false, progress: 0,
      currentTime: 0, duration: 0, history: [], shuffleRemaining: [],
      selectionId: s.selectionId + 1,
    };
    const queue = s.queue.filter((_, index) => index !== i);
    const remap = (value: number) => value === i ? null : value > i ? value - 1 : value;
    const history = s.history.map(remap).filter((value): value is number => value != null);
    const shuffleRemaining = s.shuffleRemaining.map(remap).filter((value): value is number => value != null);
    if (i !== s.index) {
      const index = i < s.index ? s.index - 1 : s.index;
      return { queue, index, current: queue[index], history, shuffleRemaining };
    }
    const shuffleActive = s.shuffle && s.current?.kind === 'music';
    const shuffledNext = shuffleActive ? shuffleRemaining[0] : undefined;
    const historyFallback = shuffleActive ? history[history.length - 1] : undefined;
    const index = shuffledNext ?? historyFallback ?? Math.min(i, queue.length - 1);
    return {
      ...playerSelection(queue, index, s.selectionId),
      playing: s.playing,
      history: historyFallback === index && shuffledNext == null ? history.slice(0, -1) : history,
      shuffleRemaining: shuffleActive ? shuffleRemaining.filter(value => value !== index) : shuffleRemaining,
    };
  }),
  moveTrack: (from, to) => set(s => {
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < 0
      || from >= s.queue.length || to >= s.queue.length || from === to) return {};
    const queue = s.queue.slice();
    const [track] = queue.splice(from, 1);
    queue.splice(to, 0, track);
    const remap = (value: number) => {
      if (value === from) return to;
      if (from < to && value > from && value <= to) return value - 1;
      if (to < from && value >= to && value < from) return value + 1;
      return value;
    };
    const index = remap(s.index);
    return {
      queue,
      index,
      current: queue[index],
      history: s.history.map(remap),
      shuffleRemaining: s.shuffleRemaining.map(remap),
    };
  }),
  setProgress: (currentTime, duration) => set({
    currentTime: Math.max(0, Number.isFinite(currentTime) ? currentTime : 0),
    duration: Math.max(0, Number.isFinite(duration) ? duration : 0),
    progress: duration > 0 && Number.isFinite(duration) ? Math.max(0, Math.min(1, currentTime / duration)) : 0,
  }),
  setVolume: (value) => set({ volume: Math.max(0, Math.min(1, Number.isFinite(value) ? value : 1)), muted: false }),
  setMuted: (muted) => set({ muted }),
  setPlaybackRate: (value) => set({ playbackRate: Math.max(0.5, Math.min(3, Number.isFinite(value) ? value : 1)) }),
  setNormalizationEnabled: (normalizationEnabled) => set({ normalizationEnabled: !!normalizationEnabled }),
  consumeStartAt: () => set(s => {
    if (!s.current || s.current.startAt == null) return {};
    const current = { ...s.current };
    delete current.startAt;
    const queue = s.queue.slice();
    if (queue[s.index]) queue[s.index] = current;
    return { current, queue };
  }),
  toggleShuffle: () => set(s => ({
    shuffle: !s.shuffle,
    history: [],
    shuffleRemaining: !s.shuffle && s.current?.kind === 'music' ? shuffledIndices(s.queue.length, s.index) : [],
  })),
  cycleRepeat: () => set(s => ({ repeat: s.repeat === 'off' ? 'all' : s.repeat === 'all' ? 'one' : 'off' })),
  clear: () => set(s => ({
    queue: [], index: 0, current: null, playing: false, progress: 0,
    currentTime: 0, duration: 0, history: [], shuffleRemaining: [],
    selectionId: s.selectionId + 1,
  })),
}));

function parsePlayerSession(raw: string | null, accountId: number): SavedPlayerSession | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<SavedPlayerSession>;
    if (value.version !== PLAYER_SESSION_VERSION || value.accountId !== accountId
      || !Array.isArray(value.queue) || value.queue.length > MAX_SAVED_QUEUE
      || !Number.isFinite(value.savedAt) || Date.now() - Number(value.savedAt) > MAX_SESSION_AGE_MS) return null;
    const queue = value.queue.map(savedTrack);
    if (queue.some(track => !track)) return null;
    const index = queue.length ? finiteNumber(value.index, 0, queue.length - 1) : 0;
    const volume = finiteNumber(value.volume, 0, 1);
    const playbackRate = finiteNumber(value.playbackRate, 0.5, 3) ?? 1;
    const positionSec = finiteNumber(value.positionSec, 0, 366 * 24 * 3600) || 0;
    const durationSec = finiteNumber(value.durationSec, 0, 366 * 24 * 3600) || 0;
    if (index == null || volume == null || typeof value.muted !== 'boolean' || typeof value.shuffle !== 'boolean'
      || !['off', 'one', 'all'].includes(String(value.repeat))) return null;
    return {
      version: 1,
      accountId,
      savedAt: Number(value.savedAt),
      queue: queue as Track[],
      index,
      positionSec,
      durationSec,
      volume,
      muted: value.muted,
      playbackRate,
      normalizationEnabled: value.normalizationEnabled === true,
      shuffle: value.shuffle,
      repeat: value.repeat as PlayerState['repeat'],
    };
  } catch { return null; }
}

export function flushPlayerSession(): void {
  if (persistPlayerTimer) { clearTimeout(persistPlayerTimer); persistPlayerTimer = null; }
  const accountId = activePlayerAccountId;
  const storage = playerStorage();
  if (!accountId || !storage) return;
  const state = usePlayer.getState();
  if (!state.current || !state.queue.length) {
    const preferences: SavedPlayerSession = {
      version: 1, accountId, savedAt: Date.now(), queue: [], index: 0,
      positionSec: 0, durationSec: 0, volume: state.volume, muted: state.muted,
      playbackRate: state.playbackRate, normalizationEnabled: state.normalizationEnabled, shuffle: state.shuffle, repeat: state.repeat,
    };
    try { storage.setItem(playerSessionKey(accountId), JSON.stringify(preferences)); } catch { /* quota/private mode */ }
    return;
  }
  const from = Math.max(0, Math.min(state.index - Math.floor(MAX_SAVED_QUEUE / 2), state.queue.length - MAX_SAVED_QUEUE));
  const queue = state.queue.slice(from, from + MAX_SAVED_QUEUE).map(savedTrack);
  // If a runtime-only/blob/cross-origin track cannot be restored safely, do not
  // write a partial queue whose index and next/previous semantics would differ.
  if (queue.some(track => !track)) return;
  const index = state.index - from;
  const durationSec = Number.isFinite(state.duration) ? Math.max(0, state.duration) : (state.current.durationSec || 0);
  const nearEnd = durationSec > 0 && durationSec - state.currentTime < 3;
  const positionSec = nearEnd ? 0 : Math.max(0, Number.isFinite(state.currentTime) ? state.currentTime : 0);
  const safeQueue = queue as Track[];
  safeQueue[index] = { ...safeQueue[index], startAt: positionSec || undefined };
  const value: SavedPlayerSession = {
    version: 1,
    accountId,
    savedAt: Date.now(),
    queue: safeQueue,
    index,
    positionSec,
    durationSec,
    volume: state.volume,
    muted: state.muted,
    playbackRate: state.playbackRate,
    normalizationEnabled: state.normalizationEnabled,
    shuffle: state.shuffle,
    repeat: state.repeat,
  };
  try { storage.setItem(playerSessionKey(accountId), JSON.stringify(value)); } catch { /* quota/private mode */ }
}

function schedulePlayerSessionSave(): void {
  if (!activePlayerAccountId || persistPlayerTimer) return;
  persistPlayerTimer = setTimeout(flushPlayerSession, 4000);
}

export function activatePlayerSession(accountId: number): void {
  if (!Number.isSafeInteger(accountId) || accountId < 1 || activePlayerAccountId === accountId) return;
  if (activePlayerAccountId) flushPlayerSession();
  activePlayerAccountId = accountId;
  const storage = playerStorage();
  const saved = parsePlayerSession(storage?.getItem(playerSessionKey(accountId)) || null, accountId);
  if (!saved) return;
  if (!saved.queue.length) {
    usePlayer.setState({ volume: saved.volume, muted: saved.muted, playbackRate: saved.playbackRate, normalizationEnabled: saved.normalizationEnabled === true, shuffle: saved.shuffle, repeat: saved.repeat });
    return;
  }
  const queue = saved.queue.slice();
  queue[saved.index] = { ...queue[saved.index], startAt: saved.positionSec || undefined };
  usePlayer.setState(state => ({
    ...playerSelection(queue, saved.index, state.selectionId),
    // Browsers correctly block surprise autoplay after a reload. Restore the
    // exact queue and position, visibly paused, so one tap resumes it.
    playing: false,
    currentTime: saved.positionSec,
    duration: saved.durationSec || queue[saved.index]?.durationSec || 0,
    progress: (saved.durationSec || queue[saved.index]?.durationSec || 0) > 0
      ? Math.max(0, Math.min(1, saved.positionSec / (saved.durationSec || queue[saved.index]!.durationSec!))) : 0,
    volume: saved.volume,
    muted: saved.muted,
    playbackRate: saved.playbackRate,
    normalizationEnabled: saved.normalizationEnabled === true,
    shuffle: saved.shuffle,
    repeat: saved.repeat,
    history: [],
    shuffleRemaining: saved.shuffle && queue[saved.index]?.kind === 'music' ? shuffledIndices(queue.length, saved.index) : [],
  }));
}

export function deactivatePlayerSession(removeSaved: boolean): void {
  const accountId = activePlayerAccountId;
  if (persistPlayerTimer) { clearTimeout(persistPlayerTimer); persistPlayerTimer = null; }
  if (accountId && !removeSaved) flushPlayerSession();
  activePlayerAccountId = null;
  if (accountId && removeSaved) {
    try { playerStorage()?.removeItem(playerSessionKey(accountId)); } catch { /* storage unavailable */ }
  }
}

usePlayer.subscribe((state, previous) => {
  if (!activePlayerAccountId) return;
  if (!state.current) {
    if (persistPlayerTimer) { clearTimeout(persistPlayerTimer); persistPlayerTimer = null; }
    flushPlayerSession();
    return;
  }
  if (state.current !== previous.current || state.queue !== previous.queue || state.index !== previous.index || state.currentTime !== previous.currentTime
    || state.playing !== previous.playing || state.volume !== previous.volume || state.muted !== previous.muted
    || state.playbackRate !== previous.playbackRate || state.normalizationEnabled !== previous.normalizationEnabled
    || state.shuffle !== previous.shuffle || state.repeat !== previous.repeat) schedulePlayerSessionSave();
});

if (typeof window !== 'undefined') window.addEventListener('pagehide', flushPlayerSession);

// ---------- Toasts ----------
export interface Toast { id: string; title: string; body?: string; level: 'info' | 'success' | 'warning' | 'error'; }
interface ToastState { toasts: Toast[]; push: (t: Omit<Toast, 'id'>) => void; dismiss: (id: string) => void; }
export const useToasts = create<ToastState>((set) => ({
  toasts: [],
  push: (t) => {
    const id = Math.random().toString(36).slice(2);
    set(s => ({ toasts: [...s.toasts, { ...t, id }] }));
    setTimeout(() => set(s => ({ toasts: s.toasts.filter(x => x.id !== id) })), 4200);
  },
  dismiss: (id) => set(s => ({ toasts: s.toasts.filter(x => x.id !== id) })),
}));

export function toast(title: string, level: Toast['level'] = 'info', body?: string) {
  useToasts.getState().push({ title, body, level });
}

// ---------- Command palette / search open state ----------
interface UiState { searchOpen: boolean; setSearchOpen: (o: boolean) => void; sidebarOpen: boolean; setSidebarOpen: (o: boolean) => void; }
export const useUi = create<UiState>((set) => ({
  searchOpen: false, setSearchOpen: (searchOpen) => set({ searchOpen }),
  sidebarOpen: false, setSidebarOpen: (sidebarOpen) => set({ sidebarOpen }),
}));
