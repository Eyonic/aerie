import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { api } from '../lib/api';
import { Icon } from '../lib/icons';
import { toast } from '../lib/store';
import { cx, formatBytes, formatRelative, formatDuration } from '../lib/utils';
import { PageLoader, EmptyState, PageHeader, Badge, Spinner } from '../components/ui';
import { VideoPlayer } from '../components/media';
import type { MediaItem, FileEntry } from '../lib/model';
import { imageSrcSet } from '../lib/images';

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

type ResumeInfo = { pos: number; dur: number; at: number };
type ResumeMap = Record<string, ResumeInfo>;

const RESUME_KEY = 'cbx.videos.resume.v1';
function loadResume(): ResumeMap {
  try { return JSON.parse(localStorage.getItem(RESUME_KEY) || '{}') || {}; } catch { return {}; }
}
function persistResume(m: ResumeMap) {
  try { localStorage.setItem(RESUME_KEY, JSON.stringify(m)); } catch { /* ignore quota */ }
}

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
// Fullscreen native player for Drive videos (files are direct MP4/WebM,
// no HLS). Resumes from and saves local progress.
// ------------------------------------------------------------------
function DriveVideoPlayer({ v, startAt, onSaveProgress, onClose }: {
  v: Vid; startAt: number; onSaveProgress: (pos: number, dur: number) => void; onClose: () => void;
}) {
  const ref = useRef<HTMLVideoElement>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const lastSave = useRef(0);

  const save = useCallback(() => {
    const el = ref.current;
    if (el && el.currentTime > 0 && el.duration && isFinite(el.duration)) {
      onSaveProgress(el.currentTime, el.duration);
    }
  }, [onSaveProgress]);

  useEffect(() => {
    const el = ref.current; if (!el) return;
    const onMeta = () => {
      setLoading(false);
      if (startAt > 0 && startAt < el.duration - 5) { try { el.currentTime = startAt; } catch { /* noop */ } }
      el.play().catch(() => {});
    };
    const onTime = () => {
      const now = Date.now();
      if (now - lastSave.current > 5000) { lastSave.current = now; save(); }
    };
    const onErr = () => { setError(true); setLoading(false); };
    el.addEventListener('loadedmetadata', onMeta);
    el.addEventListener('timeupdate', onTime);
    el.addEventListener('error', onErr);
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', esc);
    return () => {
      save();
      el.removeEventListener('loadedmetadata', onMeta);
      el.removeEventListener('timeupdate', onTime);
      el.removeEventListener('error', onErr);
      window.removeEventListener('keydown', esc);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [v.key]);

  return (
    <div className="fixed inset-0 z-[200] bg-black flex flex-col animate-fade-in">
      <div className="absolute top-0 inset-x-0 z-10 p-3 sm:p-4 flex items-center gap-2 bg-gradient-to-b from-black/80 to-transparent">
        <button className="icon-btn text-white hover:bg-white/10 shrink-0" onClick={onClose} aria-label="Close">
          <Icon.ChevronLeft size={24} />
        </button>
        <div className="min-w-0 flex-1">
          <p className="text-white font-semibold truncate">{v.name}</p>
          <p className="text-xs text-slate-400 truncate">{v.folderName}{v.size ? ` · ${formatBytes(v.size)}` : ''}</p>
        </div>
        {v.downloadUrl && (
          <a href={v.downloadUrl} className="icon-btn text-white hover:bg-white/10 shrink-0" aria-label="Download" onClick={e => e.stopPropagation()}>
            <Icon.Download size={20} />
          </a>
        )}
      </div>
      {loading && !error && <div className="absolute inset-0 grid place-items-center text-white"><Spinner size={40} /></div>}
      {error && (
        <div className="absolute inset-0 grid place-items-center text-center p-6">
          <div>
            <p className="text-white mb-2">This video couldn't be played in the browser.</p>
            {v.downloadUrl && <a href={v.downloadUrl} className="btn-secondary inline-flex items-center gap-2"><Icon.Download size={16} /> Download</a>}
          </div>
        </div>
      )}
      <video ref={ref} controls autoPlay playsInline className="w-full h-full object-contain bg-black"
        src={v.streamUrl} poster={v.thumbUrl} />
    </div>
  );
}

type SortKey = 'recent' | 'name' | 'size';

export default function Videos() {
  const [loading, setLoading] = useState(true);
  const [vids, setVids] = useState<Vid[]>([]);
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<SortKey>('recent');
  const [folder, setFolder] = useState<string>('all');
  const [resume, setResume] = useState<ResumeMap>(() => loadResume());
  const [playing, setPlaying] = useState<Vid | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadPct, setUploadPct] = useState(0);
  const fileInput = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
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
      setVids(list);
    } catch (e: any) {
      toast('Could not load videos', 'error', e?.message);
      setVids([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const saveProgress = useCallback((key: string, pos: number, dur: number) => {
    setResume(prev => {
      const next = { ...prev };
      if (dur > 0 && pos >= dur - 12) {
        // finished — clear from continue-watching
        delete next[key];
      } else {
        next[key] = { pos, dur, at: Date.now() };
      }
      persistResume(next);
      return next;
    });
  }, []);

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

  function play(v: Vid) { setPlaying(v); }

  function closePlayer() {
    setPlaying(null);
    // Pull fresh media resume state (progressPct) in case a media item advanced.
    if (playing?.source === 'media') load();
  }

  if (loading) return <PageLoader />;

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
