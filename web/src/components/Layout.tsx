import React, { useEffect, useState, Suspense } from 'react';
import { NavLink, Outlet, useNavigate, useLocation } from 'react-router-dom';
import { Icon } from '../lib/icons';
import { useAuth, useUi, usePlayer, toast } from '../lib/store';
import { cx, initials } from '../lib/utils';
import { api } from '../lib/api';
import { GlobalAudioPlayer } from './GlobalAudioPlayer';
import { VideoPlayer } from './media';
import { takePendingHandoff } from '../lib/handoff';
import { publicUrlSync, getPublicUrl } from '../lib/serverinfo';
import { SearchOverlay } from './SearchOverlay';
import { Toaster, Menu, PageLoader } from './ui';
import type { Notification, UserFeatures } from '../lib/model';
import { useLanguage } from '../lib/i18n';

const NAV: { section?: string; items: { to: string; label: string; icon: React.ReactNode }[] }[] = [
  { items: [{ to: '/', label: 'Dashboard', icon: <Icon.Dashboard size={19} /> }, { to: '/files', label: 'Files', icon: <Icon.Files size={19} /> }] },
  { section: 'Media', items: [
    { to: '/photos', label: 'Photos', icon: <Icon.Photos size={19} /> },
    { to: '/videos', label: 'Videos', icon: <Icon.Video size={19} /> },
    { to: '/movies', label: 'Movies', icon: <Icon.Movie size={19} /> },
    { to: '/tv', label: 'TV Shows', icon: <Icon.TV size={19} /> },
    { to: '/music', label: 'Music', icon: <Icon.Music size={19} /> },
    { to: '/audiobooks', label: 'Audiobooks', icon: <Icon.Book size={19} /> },
    { to: '/requests', label: 'Request Movies', icon: <Icon.Plus size={19} /> },
    { to: '/downloads', label: 'Downloads', icon: <Icon.Download size={19} /> },
    { to: '/collections', label: 'Collections', icon: <Icon.Star size={19} /> },
    { to: '/history', label: 'History', icon: <Icon.Clock size={19} /> },
  ] },
  { section: 'Create', items: [
    { to: '/documents', label: 'Documents', icon: <Icon.Doc size={19} /> },
    { to: '/spreadsheets', label: 'Spreadsheets', icon: <Icon.Sheet size={19} /> },
    { to: '/image-editor', label: 'Image Editor', icon: <Icon.Edit size={19} /> },
    { to: '/ai-images', label: 'AI Image Studio', icon: <Icon.Sparkles size={19} /> },
    { to: '/music-studio', label: 'AI Music Studio', icon: <Icon.Music size={19} /> },
    { to: '/assistant', label: 'AI Assistant', icon: <Icon.Robot size={19} /> },
  ] },
  { section: 'System', items: [
    { to: '/jobs', label: 'Jobs', icon: <Icon.Bolt size={19} /> },
    { to: '/automations', label: 'Automations', icon: <Icon.Bolt size={19} /> },
    { to: '/backups', label: 'Backups', icon: <Icon.Backup size={19} /> },
    { to: '/sync', label: 'Folder Sync', icon: <Icon.Refresh size={19} /> },
    { to: '/monitoring', label: 'Monitoring', icon: <Icon.Monitor size={19} /> },
    { to: '/library-tools', label: 'Library Tools', icon: <Icon.Settings size={19} /> },
    { to: '/admin', label: 'Admin', icon: <Icon.Admin size={19} /> },
    { to: '/integrations', label: 'Integrations', icon: <Icon.Link size={19} /> },
    { to: '/settings', label: 'Settings', icon: <Icon.Settings size={19} /> },
    { to: '/get-apps', label: 'Get the Apps', icon: <Icon.Download size={19} /> },
  ] },
];

// Admin-only destinations, hidden from regular members (the pages also guard
// themselves client-side and the API returns 403 for non-admins).
const ADMIN_ONLY = new Set(['/admin', '/integrations', '/library-tools']);
const PATH_FEATURE: Partial<Record<string, Exclude<keyof UserFeatures, 'autoRequest'>>> = {
  '/files': 'files', '/photos': 'photos', '/videos': 'videos', '/movies': 'movies', '/tv': 'tv', '/music': 'music',
  '/audiobooks': 'audiobooks', '/podcasts': 'audiobooks', '/requests': 'requests', '/sync': 'sync',
  '/documents': 'create', '/spreadsheets': 'create', '/image-editor': 'create',
  '/ai-images': 'ai', '/music-studio': 'ai', '/assistant': 'ai',
};
const canOpen = (features: UserFeatures | undefined, path: string) => {
  const key = PATH_FEATURE[path];
  return !key || features?.[key] !== false;
};

function Sidebar() {
  const { user } = useAuth();
  const { sidebarOpen, setSidebarOpen } = useUi();
  const isAdmin = user?.role === 'admin';
  const { t: tr } = useLanguage();
  return (
    <>
      {sidebarOpen && <div className="fixed inset-0 bg-black/50 z-40 lg:hidden" onClick={() => setSidebarOpen(false)} />}
      <aside className={cx(
        'fixed lg:static inset-y-0 left-0 z-50 w-[248px] shrink-0 flex flex-col glass border-r border-white/[0.06] transition-transform',
        sidebarOpen ? 'translate-x-0' : '-translate-x-full lg:translate-x-0')}>
        <div className="h-16 flex items-center gap-2 px-4 shrink-0">
          <img src="/logo.svg?v=2" alt="Aerie" className="w-12 h-12 object-contain shrink-0" />
          <div>
            <p className="font-bold text-white tracking-tight leading-none">Aerie</p>
            <p className="text-[10px] text-slate-500 mt-0.5">{tr('private cloud')}</p>
          </div>
        </div>
        <nav className="flex-1 overflow-y-auto px-3 py-2 space-y-4">
          {NAV.map((group, gi) => (
            <div key={gi}>
              {group.section && <p className="text-[10px] font-semibold uppercase tracking-widest text-slate-600 px-3 mb-1.5">{tr(group.section)}</p>}
              <div className="space-y-0.5">
                {group.items
                  .filter(it => !ADMIN_ONLY.has(it.to) || isAdmin)
                  .filter(it => canOpen(user?.features, it.to))
                  .map(it => (
                  <NavLink key={it.to} to={it.to} end={it.to === '/'} onClick={() => setSidebarOpen(false)}
                    className={({ isActive }) => cx('nav-item', isActive && 'nav-item-active')}>
                    {it.icon}<span>{tr(it.label)}</span>
                  </NavLink>
                ))}
              </div>
            </div>
          ))}
        </nav>
      </aside>
    </>
  );
}

function NotificationsMenu() {
  const [items, setItems] = useState<Notification[]>([]);
  const unread = items.filter(n => !n.read).length;
  const load = () => api.notifications.list().then(setItems).catch(() => {});
  useEffect(() => {
    load();
    const t = setInterval(load, 30000);
    // Live push: instant toast + badge update when a job finishes.
    const unsub = api.notifications.subscribe((n) => {
      toast(n.title, n.level || 'info', n.body);
      setItems(prev => [{ ...n, read: false }, ...prev].slice(0, 50));
    });
    return () => { clearInterval(t); unsub(); };
  }, []);
  return (
    <Menu
      trigger={
        <button className="icon-btn relative">
          <Icon.Bell size={19} />
          {unread > 0 && <span className="absolute top-1 right-1 w-2 h-2 rounded-full bg-accent-pink ring-2 ring-ink-850" />}
        </button>}
      items={items.length ? items.slice(0, 8).map(n => ({
        label: n.title, icon: <span className={cx('w-1.5 h-1.5 rounded-full',
          n.level === 'success' ? 'bg-accent-green' : n.level === 'error' ? 'bg-accent-red' : n.level === 'warning' ? 'bg-accent-amber' : 'bg-brand-400')} />,
        onClick: () => { api.notifications.read(n.id).then(load); },
      })) : [{ label: 'No notifications', onClick: () => {} }]}
    />
  );
}

function Topbar() {
  const { user, logout } = useAuth();
  const { setSearchOpen, setSidebarOpen } = useUi();
  const nav = useNavigate();
  const { t: tr } = useLanguage();
  return (
    <header className="h-16 shrink-0 flex items-center gap-3 px-4 lg:px-6 border-b border-white/[0.06] glass z-30">
      <button className="icon-btn lg:hidden" onClick={() => setSidebarOpen(true)}><Icon.Menu size={20} /></button>
      <button onClick={() => setSearchOpen(true)}
        className="flex-1 max-w-md flex items-center gap-2.5 rounded-xl bg-ink-900/70 border border-white/[0.06] px-3.5 py-2 text-sm text-slate-500 hover:border-white/[0.12] transition">
        <Icon.Search size={17} /><span>{tr('Search everything…')}</span>
        <kbd className="ml-auto text-[10px] border border-white/10 rounded px-1.5 py-0.5 hidden sm:block">⌘K</kbd>
      </button>
      <div className="flex-1" />
      <NotificationsMenu />
      <Menu
        trigger={
          <button className="flex items-center gap-2 pl-1 pr-2 py-1 rounded-xl hover:bg-white/[0.06] transition">
            {user?.avatarUrl
              ? <img src={api.url(user.avatarUrl)} alt={user.displayName} className="w-8 h-8 rounded-full object-cover bg-ink-800" />
              : <div className="w-8 h-8 rounded-full grid place-items-center text-xs font-semibold text-white" style={{ background: user?.avatarColor || '#6366f1' }}>
                  {initials(user?.displayName || 'U')}
                </div>}
            <div className="hidden sm:block text-left">
              <p className="text-sm font-medium text-white leading-none">{user?.displayName}</p>
              <p className="text-[10px] text-slate-500 mt-0.5 capitalize">{user?.role}</p>
            </div>
            <Icon.ChevronDown size={15} className="text-slate-500 hidden sm:block" />
          </button>}
        items={[
          { label: tr('Settings'), icon: <Icon.Settings size={16} />, onClick: () => nav('/settings') },
          { label: tr('Devices'), icon: <Icon.Device size={16} />, onClick: () => nav('/settings?tab=devices') },
          { divider: true, label: '', onClick: () => {} },
          { label: tr('Sign out'), icon: <Icon.Logout size={16} />, danger: true, onClick: async () => { await logout(); nav('/login'); } },
        ]}
      />
    </header>
  );
}

// Mobile bottom tab bar — fast one-handed access to the core sections. Hidden on
// desktop (the sidebar takes over there).
const TABS = [
  { to: '/', label: 'Home', icon: <Icon.Dashboard size={22} /> },
  { to: '/files', label: 'Files', icon: <Icon.Files size={22} /> },
  { to: '/photos', label: 'Photos', icon: <Icon.Photos size={22} /> },
  { to: '/movies', label: 'Media', icon: <Icon.Movie size={22} /> },
  { to: '/assistant', label: 'AI', icon: <Icon.Robot size={22} /> },
];
function BottomTabBar() {
  const { user } = useAuth();
  const { pathname } = useLocation();
  const { t: tr } = useLanguage();
  // The image editor has its own full-width bottom tool bar; the global tabs would
  // overlap it and hijack taps. Hide there.
  if (pathname.startsWith('/image-editor')) return null;
  return (
    <nav className="lg:hidden shrink-0 glass-strong border-t border-white/[0.07] flex items-stretch z-40"
      style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}>
      {TABS.filter(t => canOpen(user?.features, t.to)).map(t => (
        <NavLink key={t.to} to={t.to} end={t.to === '/'}
          className={({ isActive }) => cx('flex-1 flex flex-col items-center justify-center gap-0.5 py-2 text-[10px] font-medium transition-colors',
            isActive ? 'text-brand-400' : 'text-slate-500 hover:text-slate-300')}>
          {t.icon}<span>{tr(t.label)}</span>
        </NavLink>
      ))}
    </nav>
  );
}

// Voice, casting, offline downloads and PWA install all require a secure context
// (HTTPS). On plain-HTTP LAN access they're silently blocked by the browser — tell
// the user how to unlock them.
function InsecureBanner() {
  const [dismissed, setDismissed] = useState(() => sessionStorage.getItem('cb_https_dismiss') === '1');
  const [publicUrl, setPublicUrl] = useState(() => publicUrlSync());
  useEffect(() => { getPublicUrl().then(setPublicUrl).catch(() => {}); }, []);
  const insecure = typeof window !== 'undefined' && !(window as any).isSecureContext;
  if (!insecure || dismissed) return null;
  return (
    <div className="shrink-0 bg-accent-amber/15 border-b border-accent-amber/25 text-amber-200 text-xs sm:text-sm px-4 py-2 flex items-center gap-2">
      <Icon.Warning size={16} className="shrink-0" />
      <span className="min-w-0 flex-1">{publicUrl
        ? <>Open <b>{publicUrl}</b> for the full experience.</>
        : <>Access Aerie over HTTPS to unlock mic, casting and offline features.</>}</span>
      <button className="icon-btn !w-7 !h-7 shrink-0" onClick={() => { sessionStorage.setItem('cb_https_dismiss', '1'); setDismissed(true); }}><Icon.Close size={15} /></button>
    </div>
  );
}

export function Layout() {
  const { current } = usePlayer();
  const { user } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  useEffect(() => {
    const root = '/' + location.pathname.split('/').filter(Boolean)[0];
    if ((ADMIN_ONLY.has(root) && user?.role !== 'admin') || !canOpen(user?.features, root)) navigate('/', { replace: true });
  }, [location.pathname, user?.role, user?.features]);
  // heartbeat device presence
  useEffect(() => { const t = setInterval(() => api.devices.heartbeat(navigator.platform || 'Web', 'web').catch(() => {}), 120000); return () => clearInterval(t); }, []);

  // Network handoff (native app origin hop): restore the audio queue and/or the
  // playing video exactly where the previous origin left off.
  const [handoffVideo, setHandoffVideo] = useState<any>(null);
  useEffect(() => {
    const h = takePendingHandoff();
    if (!h) return;
    if (h.player?.queue?.length) {
      const q = h.player.queue.slice();
      const idx = Math.min(Math.max(0, h.player.index || 0), q.length - 1);
      if (q[idx]) q[idx] = { ...q[idx], startAt: h.player.position || 0 };
      usePlayer.getState().playQueue(q, idx);
      // Synchronous, not a setTimeout: the player mounts on the next render, so
      // setting playing:false now means it never calls play() (no audible blip).
      if (!h.player.playing) usePlayer.getState().setPlaying(false);
    }
    if (h.video?.itemId) {
      const vid = h.video;
      const open = (attempt = 0): void => {
        api.media.item(vid.itemId)
          .then(it => setHandoffVideo({ ...it, positionTicks: Math.round((vid.position || 0) * 1e7), _resumePaused: vid.paused }))
          .catch(() => { if (attempt < 5) setTimeout(() => open(attempt + 1), 1500 * (attempt + 1)); });
      };
      open();
    }
  }, []);

  return (
    <>
    <a href="#main-content" className="skip-link">Skip to main content</a>
    <div className="flex h-full overflow-hidden bg-ink-950">
      <Sidebar />
      <div className="flex-1 flex flex-col min-w-0">
        <InsecureBanner />
        <Topbar />
        <main id="main-content" className="flex-1 overflow-y-auto" tabIndex={-1}>
          <div className="max-w-[1400px] mx-auto px-4 lg:px-8 py-6">
            <Suspense fallback={<PageLoader />}>
              <Outlet />
            </Suspense>
          </div>
        </main>
        {current && <GlobalAudioPlayer />}
        <BottomTabBar />
      </div>
      <SearchOverlay />
      <Toaster />
      {handoffVideo && <VideoPlayer item={handoffVideo} onClose={() => setHandoffVideo(null)} />}
    </div>
    </>
  );
}
