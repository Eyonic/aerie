import React, { useState, useEffect, useRef, useCallback } from 'react';
import { api } from '../lib/api';
import { Icon } from '../lib/icons';
import { cx, formatRelative, formatDuration } from '../lib/utils';
import { toast, usePlayer, type Track } from '../lib/store';
import { Spinner, PageLoader, EmptyState, PageHeader, Badge, ConfirmModal } from '../components/ui';

// ---- backend track shape (music-gen) ----
interface GenTrack {
  id: string;
  prompt: string;
  lyrics?: string;
  status: 'queued' | 'running' | 'done' | 'error';
  url?: string;
  durationSec?: number;
  error?: string;
  createdAt?: string;
}

// Engine status shape (server also returns live gpu state)
interface EngineStatus {
  up: boolean;
  queue?: number;
  gpu?: { busy?: boolean; running?: string | null; runningSeconds?: number; queued?: number };
}

// The server stores createdAt as UTC but serializes it WITHOUT a timezone
// (e.g. "2026-07-04 08:47:10"). new Date() would parse that as *local* time,
// so a freshly made track reads hours off ("2h ago"). Normalize to a real
// UTC ISO string first.
//
// Second, createdAt is stamped by the *server* clock, which on a self-hosted box
// routinely drifts several minutes from the viewer's device clock. Measured naively
// against the browser clock, a just-created track reads "~10m ago". We correct for
// that by shifting the timestamp by the measured server↔client skew so it is compared
// against server "now" — a fresh track then reads "just now".
function relTime(s?: string, skewMs = 0): string {
  if (!s) return '';
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2}(?:\.\d+)?)$/.exec(s.trim());
  const iso = m ? `${m[1]}T${m[2]}Z` : s;
  const t = Date.parse(iso);
  if (isNaN(t)) return formatRelative(s);
  return formatRelative(new Date(t - skewMs).toISOString());
}

const GENRE_PRESETS: { label: string; prompt: string; emoji: string }[] = [
  { label: 'Lofi Chill', emoji: '🌙', prompt: 'lofi hip hop, chill, mellow piano, vinyl crackle, relaxed boom bap beat' },
  { label: 'Synthwave', emoji: '🌆', prompt: 'retro synthwave, 80s, pulsing analog synths, driving bass, neon nostalgia' },
  { label: 'Epic Cinematic', emoji: '🎬', prompt: 'epic orchestral cinematic, soaring strings, powerful drums, heroic brass' },
  { label: 'Deep House', emoji: '🪩', prompt: 'deep house, four on the floor, warm bassline, groovy, late night club vibe' },
  { label: 'Acoustic Folk', emoji: '🪕', prompt: 'acoustic folk, fingerpicked guitar, warm vocals, cozy campfire, heartfelt' },
  { label: 'Jazz Cafe', emoji: '☕', prompt: 'smooth jazz, upright bass, brushed drums, saxophone, cozy cafe ambience' },
  { label: 'Ambient', emoji: '🌌', prompt: 'ambient soundscape, ethereal pads, gentle drones, dreamy, meditative' },
  { label: 'Trap Beat', emoji: '🔥', prompt: 'modern trap beat, hard 808s, crisp hi-hats, dark melodic, hard hitting' },
  { label: 'Metal', emoji: '🤘', prompt: 'heavy metal, distorted guitars, double kick drums, aggressive, powerful' },
  { label: 'Pop Anthem', emoji: '✨', prompt: 'upbeat pop anthem, catchy hook, bright synths, punchy drums, feel good' },
];

// Map raw backend error strings to friendly, human copy. The engine returns
// technical detail (e.g. "ACE-Step: generation timed out", "CUDA out of memory /
// VRAM"), which we never surface verbatim as the headline — the raw string stays
// available on hover/expand instead. VRAM/memory errors are the common failure
// (music shares one GPU with the Image Studio), so they get their own hint.
function friendlyError(raw?: string): string {
  const r = (raw || '').toLowerCase();
  if (/vram|out of memory|\boom\b|cuda|memory/.test(r))
    return 'Generation failed — the music engine ran out of GPU memory. Try a shorter clip, or wait for the AI Image Studio to finish, then retry.';
  if (/timed out|timeout|deadline/.test(r))
    return 'Generation failed — the request timed out. The engine may be busy; try again, or use a shorter clip.';
  return 'Generation failed, please try again.';
}

const DURATION_ACCENT = '#ec4899';

function Slider({ label, value, min, max, step = 1, onChange, hint, accent }: {
  label: string; value: number; min: number; max: number; step?: number; onChange: (v: number) => void; hint?: string; accent: string;
}) {
  const pct = ((value - min) / (max - min)) * 100;
  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs font-medium text-slate-300">{label}</span>
        <span className="text-xs font-semibold text-white tabular-nums">{value}{hint}</span>
      </div>
      <input
        type="range" min={min} max={max} step={step} value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full h-1.5 appearance-none rounded-full cursor-pointer accent-pink-500"
        style={{ background: `linear-gradient(90deg, ${accent} ${pct}%, rgba(148,163,184,0.18) ${pct}%)` }}
      />
    </div>
  );
}

export default function MusicStudio() {
  const playTrack = usePlayer(s => s.playTrack);

  const [engine, setEngine] = useState<EngineStatus | null>(null);
  const [tracks, setTracks] = useState<GenTrack[] | null>(null);

  const [prompt, setPrompt] = useState('');
  const [lyrics, setLyrics] = useState('');
  const [duration, setDuration] = useState(30);
  const [busy, setBusy] = useState(false);
  const [confirmDel, setConfirmDel] = useState<GenTrack | null>(null);
  // serverMs - clientMs, from a response Date header (see relTime).
  const [skewMs, setSkewMs] = useState(0);

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const loadTracks = useCallback(async () => {
    try {
      const t = await api.musicGen.tracks();
      setTracks(Array.isArray(t) ? t : []);
    } catch {
      setTracks([]);
    }
  }, []);

  const loadStatus = useCallback(async () => {
    try { setEngine(await api.musicGen.status()); }
    catch { setEngine({ up: false }); }
  }, []);

  useEffect(() => {
    loadStatus();
    loadTracks();
    // Measure server↔client clock skew from a response Date header so relative
    // timestamps track server time, not the (possibly-drifted) device clock.
    fetch('/api/apps', { cache: 'no-store' }).then(r => {
      const d = r.headers.get('date');
      if (d) { const server = Date.parse(d); if (!isNaN(server)) setSkewMs(server - Date.now()); }
    }).catch(() => { /* keep skew 0 */ });
  }, [loadStatus, loadTracks]);

  // Poll while work is queued or running. The durable server queue exposes the
  // distinction so a track waiting for the shared GPU is not called running.
  const anyRunning = (tracks || []).some(t => t.status === 'queued' || t.status === 'running');
  useEffect(() => {
    if (anyRunning) {
      if (!pollRef.current) {
        pollRef.current = setInterval(() => { loadTracks(); loadStatus(); }, 3000);
      }
    } else if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
    return () => {
      if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
    };
  }, [anyRunning, loadTracks, loadStatus]);

  async function generate() {
    const text = prompt.trim();
    if (!text) { toast('Describe a style first', 'warning', 'e.g. "lofi hip hop, chill, mellow piano"'); return; }
    setBusy(true);
    try {
      await api.musicGen.generate({
        prompt: text,
        lyrics: lyrics.trim() || undefined,
        durationSec: duration,
      });
      toast('Composing your track', 'success', 'This can take a minute — it will appear below.');
      await loadTracks();
      await loadStatus();
    } catch (e: any) {
      toast('Generation failed', 'error', e?.message || 'The music engine may be offline or busy.');
    } finally {
      setBusy(false);
    }
  }

  async function doDelete(t: GenTrack) {
    try {
      await api.musicGen.remove(t.id);
      setTracks(prev => (prev || []).filter(x => x.id !== t.id));
      toast('Track deleted', 'success');
    } catch (e: any) {
      toast('Delete failed', 'error', e?.message);
    }
    setConfirmDel(null);
  }

  function playInAerie(t: GenTrack) {
    if (!t.url) return;
    const track: Track = {
      id: `musicgen:${t.id}`,
      title: t.prompt.slice(0, 60) || 'AI Track',
      subtitle: 'AI Music Studio',
      streamUrl: api.musicGen.audioUrl(t.url),
      kind: 'music',
      durationSec: t.durationSec,
    };
    playTrack(track);
    toast('Playing in Aerie', 'success');
  }

  // Strict online check: null only before the first status load, otherwise a
  // real boolean straight from api.musicGen.status().up.
  const up = engine == null ? null : engine.up === true;
  // Live GPU state (music shares one GPU with the AI Image Studio via the mutex).
  const gpuBusy = !!engine?.gpu?.busy;
  const gpuRunning = engine?.gpu?.running || null;
  const list = tracks || [];
  const doneCount = list.filter(t => t.status === 'done').length;

  return (
    <div className="animate-fade-in">
      <PageHeader
        title="AI Music Studio"
        subtitle="Compose original music from a text prompt — powered by ACE-Step on your private cloud."
        icon={<Icon.Music size={22} />}
        actions={
          <div className="flex items-center gap-2">
            {up === false && (
              <button onClick={loadStatus} className="btn-secondary">
                <Icon.Refresh size={15} /> Retry engine
              </button>
            )}
            <span className={cx('chip', up ? 'text-pink-300' : 'text-slate-400')}>
              <span className={cx('w-1.5 h-1.5 rounded-full mr-0.5', up ? 'bg-pink-400' : up === false ? 'bg-red-400' : 'bg-slate-500')} />
              {up == null ? 'Checking…' : up ? 'Engine online' : 'Engine offline'}
              {up && engine?.queue ? ` · ${engine.queue} queued` : ''}
            </span>
          </div>
        }
      />

      {/* ---- Status banners ---- */}
      {up === false && (
        <div className="mb-4 rounded-2xl border border-red-500/25 bg-red-500/10 px-4 py-3 flex items-start gap-3 animate-fade-in">
          <div className="w-9 h-9 rounded-xl bg-red-500/20 grid place-items-center text-red-300 shrink-0"><Icon.Warning size={18} /></div>
          <div className="min-w-0">
            <p className="text-sm font-semibold text-red-100">Music engine offline</p>
            <p className="text-xs text-red-200/70 mt-0.5">The ACE-Step backend isn't responding. Hit Retry engine, or try Generate to wake it up.</p>
          </div>
        </div>
      )}
      <div className="mb-6 rounded-2xl border border-purple-500/20 bg-purple-500/10 px-4 py-3 flex items-start gap-3">
        <div className="w-9 h-9 rounded-xl bg-purple-500/20 grid place-items-center text-purple-300 shrink-0"><Icon.Info size={18} /></div>
        <div className="min-w-0">
          {up && gpuBusy && gpuRunning !== 'music' ? (
            <p className="text-xs text-purple-100/90 leading-relaxed">
              The shared GPU is <span className="font-semibold">busy right now</span>
              {gpuRunning === 'image' ? ' rendering an AI image' : ''} — your track will queue and start
              automatically once it frees up. Music and images never run at the same time.
            </p>
          ) : (
            <p className="text-xs text-purple-100/90 leading-relaxed">
              Music generation shares one GPU with the <span className="font-semibold">AI Image Studio</span>, so only one
              runs at a time. If a track fails with an out-of-memory error, an image was likely mid-render — just try again
              once it's idle.
            </p>
          )}
        </div>
      </div>

      {/* ---- Composer ---- */}
      <div className="card p-0 overflow-hidden mb-8 relative">
        <div className="absolute -top-24 -right-24 w-72 h-72 rounded-full bg-pink-600/20 blur-3xl pointer-events-none" />
        <div className="absolute -bottom-24 -left-16 w-72 h-72 rounded-full bg-purple-600/20 blur-3xl pointer-events-none" />
        <div className="relative p-5 sm:p-6 grid lg:grid-cols-[1fr_300px] gap-6">
          {/* prompt column */}
          <div className="flex flex-col gap-3 min-w-0">
            <label className="section-title flex items-center gap-2"><Icon.Sparkles size={13} /> Style / genre</label>
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') generate(); }}
              placeholder="lofi hip hop, chill, mellow piano, warm vinyl crackle, relaxed beat…"
              rows={3}
              className="input resize-none text-[15px] leading-relaxed min-h-[84px]"
            />

            <div>
              <p className="section-title mb-2">Presets</p>
              <div className="flex flex-wrap gap-2">
                {GENRE_PRESETS.map(g => (
                  <button key={g.label} type="button" onClick={() => setPrompt(g.prompt)}
                    className="chip hover:bg-pink-500/15 hover:text-pink-200 hover:border-pink-500/40 transition-colors">
                    <span className="mr-0.5">{g.emoji}</span> {g.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="mt-1">
              <label className="section-title flex items-center gap-2 mb-2">
                <Icon.Edit size={13} /> Lyrics
                <span className="muted font-normal normal-case tracking-normal text-[11px]">optional</span>
              </label>
              <textarea
                value={lyrics}
                onChange={(e) => setLyrics(e.target.value)}
                placeholder="[inst] for instrumental&#10;&#10;[verse]&#10;Write your lyrics here…&#10;[chorus]&#10;…"
                rows={5}
                className="input resize-none text-sm leading-relaxed min-h-[120px]"
              />
            </div>
          </div>

          {/* settings column */}
          <div className="flex flex-col gap-5">
            <Slider label="Duration" value={duration} min={10} max={120} step={5} hint="s" onChange={setDuration} accent={DURATION_ACCENT} />
            <p className="text-[11px] text-slate-500 -mt-3">Longer tracks take more time and GPU memory.</p>

            <button onClick={generate} disabled={busy || !prompt.trim()}
              className={cx('btn-primary w-full justify-center h-11 text-[15px] mt-auto',
                'bg-gradient-to-r from-pink-500 via-fuchsia-600 to-purple-600 hover:brightness-110 disabled:opacity-50 disabled:cursor-not-allowed')}>
              {busy ? <><Spinner size={16} /> Composing…</> : <><Icon.Music size={17} /> Generate music</>}
            </button>
            <p className="text-[11px] text-slate-500 text-center -mt-2">⌘ / Ctrl + Enter to generate</p>
          </div>
        </div>
      </div>

      {/* ---- Tracks ---- */}
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-semibold text-white tracking-tight flex items-center gap-2">
          <Icon.Play size={16} className="text-pink-400" /> Your tracks
          {doneCount > 0 && <Badge color="slate">{doneCount}</Badge>}
        </h2>
        <button onClick={loadTracks} className="icon-btn" aria-label="Refresh"><Icon.Refresh size={16} /></button>
      </div>

      {tracks === null ? (
        <PageLoader />
      ) : list.length === 0 ? (
        <EmptyState
          icon={<Icon.Music size={28} />}
          title="No tracks yet"
          subtitle="Describe a vibe above and hit Generate music. Your creations will appear here."
        />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          {list.map((t: GenTrack) => (
            <TrackCard key={t.id} t={t} skewMs={skewMs} onDelete={() => { setConfirmDel(t); }} onPlay={() => { playInAerie(t); }} />
          ))}
        </div>
      )}

      <ConfirmModal
        open={!!confirmDel}
        onClose={() => setConfirmDel(null)}
        onConfirm={() => confirmDel && doDelete(confirmDel)}
        title="Delete track?"
        message="This generated track will be permanently removed. This cannot be undone."
        confirmLabel="Delete"
        danger
      />
    </div>
  );
}

function TrackCard({ t, skewMs = 0, onDelete, onPlay }: { t: GenTrack; skewMs?: number; onDelete: () => void; onPlay: () => void }) {
  const audioUrl = t.url ? api.musicGen.audioUrl(t.url) : undefined;
  return (
    <div className="card p-4 flex flex-col gap-3 min-w-0 animate-fade-in">
      <div className="flex items-start gap-3 min-w-0">
        <div className={cx('w-10 h-10 rounded-xl grid place-items-center shrink-0',
          t.status === 'done' ? 'bg-gradient-to-br from-pink-500/30 to-purple-600/30 text-pink-200'
            : t.status === 'error' ? 'bg-red-500/20 text-red-300'
              : 'bg-purple-500/20 text-purple-200')}>
          {t.status === 'running' || t.status === 'queued' ? <Spinner size={18} /> : <Icon.Music size={18} />}
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-white leading-snug line-clamp-2 break-words">{t.prompt || 'Untitled track'}</p>
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 mt-1 text-[11px] text-slate-500">
            {t.status === 'queued' && <span className="text-purple-300 font-medium">Waiting for the GPU…</span>}
            {t.status === 'running' && <span className="text-purple-300 font-medium">Composing…</span>}
            {t.status === 'done' && <Badge color="green">Done</Badge>}
            {t.status === 'error' && <Badge color="red">Error</Badge>}
            {t.durationSec ? <span className="tabular-nums">{formatDuration(t.durationSec)}</span> : null}
            {t.createdAt && <span>{relTime(t.createdAt, skewMs)}</span>}
          </div>
        </div>
      </div>

      {t.lyrics && t.lyrics.trim() && t.lyrics.trim().toLowerCase() !== '[inst]' && (
        <p className="text-[11px] text-slate-500 line-clamp-2 whitespace-pre-line -mt-1">{t.lyrics}</p>
      )}

      {t.status === 'error' && (
        <div className="rounded-xl border border-red-500/20 bg-red-500/10 px-3 py-2 leading-relaxed break-words">
          <p className="text-[11px] text-red-200/90" title={t.error || undefined}>{friendlyError(t.error)}</p>
          {t.error && (
            <details className="mt-1">
              <summary className="text-[10px] text-red-300/60 hover:text-red-200 cursor-pointer select-none list-none marker:content-['']">
                Show details
              </summary>
              <p className="mt-1 text-[10px] text-red-200/60 font-mono break-words whitespace-pre-wrap">{t.error}</p>
            </details>
          )}
        </div>
      )}

      {t.status === 'done' && audioUrl && (
        <div className="flex flex-wrap gap-2">
          <button onClick={onPlay} className="btn-secondary flex-1 justify-center min-w-[120px]">
            <Icon.Play size={14} /> Play in Aerie
          </button>
          <a href={audioUrl} download={`aerie-track-${t.id}.mp3`} className="btn-secondary justify-center px-3" aria-label="Download">
            <Icon.Download size={15} />
          </a>
          <button onClick={onDelete} className="btn-danger justify-center px-3" aria-label="Delete">
            <Icon.Trash size={15} />
          </button>
        </div>
      )}

      {t.status !== 'done' && (
        <div className="flex justify-end">
          <button onClick={onDelete} className="btn-ghost text-slate-400 hover:text-red-300 px-3" aria-label="Delete">
            <Icon.Trash size={15} />
          </button>
        </div>
      )}
    </div>
  );
}
