// Global state: auth, the app-wide media player (audio), and toast notifications.
import { create } from 'zustand';
import type { User, MediaItem, Book } from './model';
import { api, setToken } from './api';

// ---------- Auth ----------
interface AuthState {
  user: User | null;
  loading: boolean;
  init: () => Promise<void>;
  login: (u: string, p: string, code?: string) => Promise<'ok' | 'needs2fa'>;
  logout: () => Promise<void>;
  setUser: (u: User) => void;
}
export const useAuth = create<AuthState>((set) => ({
  user: null,
  loading: true,
  init: async () => {
    try { const { user } = await api.me(); set({ user, loading: false }); }
    catch { set({ user: null, loading: false }); }
  },
  login: async (username, password, code) => {
    const res = await api.login(username, password, code);
    if ('needs2fa' in res) return 'needs2fa';
    setToken(res.token);
    set({ user: res.user });
    try { await api.devices.heartbeat(navigator.platform || 'Web', 'web'); } catch { /* */ }
    return 'ok';
  },
  logout: async () => {
    try { await api.logout(); } catch { /* */ }
    setToken(null);
    set({ user: null });
  },
  setUser: (user) => set({ user }),
}));

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
  shuffle: boolean;
  repeat: 'off' | 'one' | 'all';
  playTrack: (t: Track, queue?: Track[]) => void;
  playQueue: (q: Track[], startIndex?: number) => void;
  playAt: (i: number) => void;
  toggle: () => void;
  next: () => void;
  prev: () => void;
  setPlaying: (p: boolean) => void;
  setProgress: (t: number, d: number) => void;
  setVolume: (v: number) => void;
  toggleShuffle: () => void;
  cycleRepeat: () => void;
  clear: () => void;
}
export const usePlayer = create<PlayerState>((set, get) => ({
  queue: [], index: 0, current: null, playing: false,
  progress: 0, currentTime: 0, duration: 0, volume: 1, shuffle: false, repeat: 'off',
  playTrack: (t, queue) => set({ current: t, queue: queue || [t], index: (queue || [t]).findIndex(x => x.id === t.id) || 0, playing: true }),
  playQueue: (q, startIndex = 0) => set({ queue: q, index: startIndex, current: q[startIndex] || null, playing: true }),
  playAt: (i) => set(s => (i >= 0 && i < s.queue.length) ? { index: i, current: s.queue[i], playing: true, progress: 0, currentTime: 0 } : {}),
  toggle: () => set(s => ({ playing: !s.playing })),
  setPlaying: (playing) => set({ playing }),
  next: () => {
    const { queue, index, repeat, shuffle } = get();
    if (!queue.length) return;
    let ni = shuffle ? Math.floor(Math.random() * queue.length) : index + 1;
    if (ni >= queue.length) { if (repeat === 'all') ni = 0; else return set({ playing: false }); }
    set({ index: ni, current: queue[ni], playing: true, progress: 0, currentTime: 0 });
  },
  prev: () => {
    const { queue, index, currentTime } = get();
    if (currentTime > 3) return set({ progress: 0, currentTime: 0 });
    const ni = Math.max(0, index - 1);
    set({ index: ni, current: queue[ni], playing: true, progress: 0 });
  },
  setProgress: (currentTime, duration) => set({ currentTime, duration, progress: duration ? currentTime / duration : 0 }),
  setVolume: (volume) => set({ volume }),
  toggleShuffle: () => set(s => ({ shuffle: !s.shuffle })),
  cycleRepeat: () => set(s => ({ repeat: s.repeat === 'off' ? 'all' : s.repeat === 'all' ? 'one' : 'off' })),
  clear: () => set({ queue: [], current: null, playing: false, progress: 0 }),
}));

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
