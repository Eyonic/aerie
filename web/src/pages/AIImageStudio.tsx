import React, { useState, useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { Icon } from '../lib/icons';
import { cx, formatRelative, copyText } from '../lib/utils';
import { toast, useAuth } from '../lib/store';
import { Spinner, PageLoader, EmptyState, PageHeader, Modal, ConfirmModal, Badge } from '../components/ui';
import type { GeneratedImage } from '../lib/model';
import {
  aiPromptHistoryKey,
  loadAiPromptHistory,
  saveAiPromptHistory,
  switchScopedSnapshot,
} from '../lib/request-local-state';

// ---- size presets ----
type Preset = { id: string; label: string; ratio: number; w: number; h: number };
const PRESETS: Preset[] = [
  { id: 'sq512', label: '512', ratio: 1, w: 512, h: 512 },
  { id: 'sq768', label: '768', ratio: 1, w: 768, h: 768 },
  { id: 'sq1024', label: '1024', ratio: 1, w: 1024, h: 1024 },
  { id: 'portrait', label: 'Portrait', ratio: 0.7, w: 768, h: 1152 },
  { id: 'landscape', label: 'Landscape', ratio: 1.5, w: 1152, h: 768 },
];

function AspectGlyph({ r }: { r: number }) {
  const base = 14;
  const w = r >= 1 ? base : base * r;
  const h = r >= 1 ? base / r : base;
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
      <rect x={(16 - w) / 2} y={(16 - h) / 2} width={w} height={h} rx="2.5" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

const IDEAS = [
  'A serene bioluminescent forest at dusk, volumetric god rays, ultra-detailed, cinematic lighting',
  'Retro-futuristic city skyline at golden hour, flying cars, synthwave palette, 35mm film grain',
  'A cozy rain-soaked Tokyo alley at night, neon reflections on wet pavement, moody cinematic',
  'Majestic snow leopard on a misty mountain ridge, national geographic photo, sharp focus, bokeh',
  'Surreal floating islands with waterfalls into the clouds, epic fantasy concept art, dramatic sky',
  'Portrait of an astronaut made of stained glass, intricate, glowing, studio lighting, 8k',
  'Minimalist Scandinavian living room, warm morning light, soft shadows, architectural photography',
  'An enchanted library with towering shelves and floating candles, warm golden glow, painterly',
  'Macro shot of a dewy spiderweb at sunrise, iridescent droplets, extreme detail, shallow depth of field',
  'Cyberpunk samurai in the rain, glowing katana, holographic signage, cinematic wide shot',
  'A whimsical hot air balloon festival over rolling lavender fields, dreamy pastel colors',
  'Ancient overgrown temple reclaimed by jungle, shafts of sunlight, atmospheric, hyperreal',
];

type Pending = { id: string; prompt: string; count: number };

// User-friendly labels for the internal ComfyUI workflow names.
const WORKFLOW_LABEL: Record<string, string> = { txt2img: 'Generated', assistant: 'Generated', img2img: 'Edited', inpaint: 'Retouched' };
const workflowLabel = (w?: string) => (w ? WORKFLOW_LABEL[w] || w : '');

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
        className="w-full h-1.5 appearance-none rounded-full cursor-pointer accent-brand-500"
        style={{ background: `linear-gradient(90deg, ${accent} ${pct}%, rgba(148,163,184,0.18) ${pct}%)` }}
      />
    </div>
  );
}

export default function AIImageStudio() {
  const nav = useNavigate();
  const accountId = useAuth(state => state.user?.id ?? null);
  const historyScopeKey = accountId ? aiPromptHistoryKey(accountId) : null;
  const [available, setAvailable] = useState<boolean | null>(null);
  const [gallery, setGallery] = useState<GeneratedImage[] | null>(null);
  const [historySnapshot, setHistorySnapshot] = useState(() => ({
    scopeKey: historyScopeKey,
    value: loadAiPromptHistory(accountId),
  }));
  const visibleHistorySnapshot = switchScopedSnapshot(
    historySnapshot,
    historyScopeKey,
    () => loadAiPromptHistory(accountId),
  );
  if (visibleHistorySnapshot !== historySnapshot) setHistorySnapshot(visibleHistorySnapshot);
  const history = visibleHistorySnapshot.value;

  const [prompt, setPrompt] = useState('');
  const [negative, setNegative] = useState('');
  const [presetId, setPresetId] = useState('sq1024');
  const [steps, setSteps] = useState(8); // Krea2 turbo: 8 steps is the sweet spot
  const [batch, setBatch] = useState(1);

  const [pending, setPending] = useState<Pending[]>([]);
  const [busy, setBusy] = useState(false);
  const [lightbox, setLightbox] = useState<GeneratedImage | null>(null);
  const [confirmDel, setConfirmDel] = useState<GeneratedImage | null>(null);

  const preset = useMemo(() => PRESETS.find(p => p.id === presetId) || PRESETS[2], [presetId]);

  // Prefill the prompt when opened from the ⌘K command palette (/ai-images?prompt=…).
  useEffect(() => {
    const p = new URLSearchParams(window.location.search).get('prompt');
    if (p) { setPrompt(p); window.history.replaceState({}, '', '/ai-images'); }
  }, []);

  useEffect(() => {
    api.images.status().then(s => setAvailable(!!s.available)).catch(() => setAvailable(false));
    api.images.gallery().then(setGallery).catch(() => setGallery([]));
  }, []);

  async function reloadStatus() {
    try {
      const s = await api.images.status();
      setAvailable(!!s.available);
      toast(s.available ? 'Image engine online' : 'Still offline', s.available ? 'success' : 'warning');
    } catch { setAvailable(false); }
  }

  function pushHistory(p: string) {
    const next = [p, ...history.filter(h => h !== p)].slice(0, 12);
    setHistorySnapshot({ scopeKey: historyScopeKey, value: next });
    saveAiPromptHistory(accountId, next);
  }

  function clearHistory() {
    setHistorySnapshot({ scopeKey: historyScopeKey, value: [] });
    saveAiPromptHistory(accountId, []);
  }

  function surprise() {
    const pool = IDEAS.filter(i => i !== prompt);
    setPrompt(pool[Math.floor(Math.random() * pool.length)] || IDEAS[0]);
  }

  async function copyPrompt(p: string) {
    // navigator.clipboard is undefined on this plain-HTTP origin — copyText falls back safely.
    const ok = await copyText(p);
    toast(ok ? 'Prompt copied' : 'Copy failed', ok ? 'success' : 'error');
  }

  function remix(img: GeneratedImage) {
    setPrompt(img.prompt);
    const pr = PRESETS.find(p => p.w === img.width && p.h === img.height);
    if (pr) setPresetId(pr.id);
    setLightbox(null);
    window.scrollTo({ top: 0, behavior: 'smooth' });
    toast('Loaded into composer', 'success', 'Tweak the prompt and generate again.');
  }

  async function generate() {
    const text = prompt.trim();
    if (!text) { toast('Enter a prompt first', 'warning'); return; }
    if (busy) return;
    const jobId = `pending-${Date.now()}`;
    setPending(prev => [{ id: jobId, prompt: text, count: batch }, ...prev]);
    setBusy(true);
    pushHistory(text);
    try {
      const res = await api.images.generate({
        prompt: text, negativePrompt: negative.trim() || undefined,
        width: preset.w, height: preset.h, steps, batch,
      });
      const imgs = res?.images || [];
      if (!imgs.length) {
        // 200 but no image — don't fake a success; let the user retry (prompt is preserved).
        toast('No image returned', 'warning', 'The engine responded but produced no image. Press Generate to try again.');
        return;
      }
      // The generate response often omits createdAt until the gallery is re-fetched,
      // which left the lightbox showing "—" for the timestamp until reload. Stamp a
      // real time now so a freshly generated image reads correctly straight away.
      const now = new Date().toISOString();
      const stamped = imgs.map(im => ({ ...im, createdAt: im.createdAt || now }));
      setGallery(prev => [...stamped, ...(prev || [])]);
      setAvailable(true);
      toast(imgs.length > 1 ? `${imgs.length} images generated` : 'Image generated', 'success', text);
    } catch (e: any) {
      // Any non-2xx (e.g. HTTP 500 while the engine is idle) lands here; ApiError carries .status.
      const status = e?.status as number | undefined;
      const body = status && status >= 500
        ? `The image engine returned an error (HTTP ${status}). Your prompt is still here — press Generate to retry.`
        : (e?.message || 'The image engine may be offline or waking up. Press Generate to retry.');
      toast('Generation failed', 'error', body);
    } finally {
      // Always clear the placeholder so a failed job never leaves a stuck pending card.
      setPending(prev => prev.filter(p => p.id !== jobId));
      setBusy(false);
    }
  }

  async function doSaveToFiles(img: GeneratedImage) {
    try { const r = await api.images.saveToFiles(img.id); toast('Saved to Files', 'success', r?.path); }
    catch (e: any) { toast('Could not save', 'error', e?.message); }
  }

  async function doDelete(img: GeneratedImage) {
    try {
      await api.images.remove(img.id);
      setGallery(prev => (prev || []).filter(g => g.id !== img.id));
      if (lightbox?.id === img.id) setLightbox(null);
      toast('Image deleted', 'success');
    } catch (e: any) { toast('Delete failed', 'error', e?.message); }
    setConfirmDel(null);
  }

  const galleryCount = gallery?.length ?? 0;
  const hasContent = pending.length > 0 || galleryCount > 0;

  const lbIndex = lightbox ? (gallery || []).findIndex(g => g.id === lightbox.id) : -1;
  function stepLightbox(dir: number) {
    if (!gallery || lbIndex < 0) return;
    const n = lbIndex + dir;
    if (n >= 0 && n < gallery.length) setLightbox(gallery[n]);
  }

  useEffect(() => {
    if (!lightbox) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowLeft') stepLightbox(-1);
      else if (e.key === 'ArrowRight') stepLightbox(1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [lightbox, gallery]);

  return (
    <div className="animate-fade-in">
      <PageHeader
        title="AI Image Studio"
        subtitle="Turn words into pictures — text-to-image generation on your private cloud."
        icon={<Icon.Sparkles size={22} />}
        actions={
          <div className="flex items-center gap-2">
            {available === false && (
              <button onClick={reloadStatus} className="btn-secondary">
                <Icon.Refresh size={15} /> Retry engine
              </button>
            )}
            <span className={cx('chip', available ? 'text-emerald-300' : 'text-slate-400')}>
              <span className={cx('w-1.5 h-1.5 rounded-full mr-0.5', available ? 'bg-emerald-400' : available === false ? 'bg-red-400' : 'bg-slate-500')} />
              {available == null ? 'Checking…' : available ? 'Engine online' : 'Engine offline'}
            </span>
          </div>
        }
      />

      {available === false && (
        <div className="mb-6 rounded-2xl border border-amber-500/25 bg-amber-500/10 px-4 py-3 flex items-start gap-3 animate-scale-in">
          <div className="w-9 h-9 rounded-xl bg-amber-500/20 grid place-items-center text-amber-300 shrink-0"><Icon.Warning size={18} /></div>
          <div className="min-w-0">
            <p className="text-sm font-semibold text-amber-100">Image engine offline</p>
            <p className="text-xs text-amber-200/70 mt-0.5">The Stable Diffusion backend may be sleeping. You can still compose a prompt — hit Retry engine, or Generate to wake it.</p>
          </div>
        </div>
      )}

      {/* ---- Composer ---- */}
      <div className="card p-0 overflow-hidden mb-8 relative">
        <div className="absolute -top-24 -right-24 w-72 h-72 rounded-full bg-brand-600/20 blur-3xl pointer-events-none" />
        <div className="absolute -bottom-24 -left-16 w-72 h-72 rounded-full bg-fuchsia-600/15 blur-3xl pointer-events-none" />
        <div className="relative p-5 sm:p-6 grid lg:grid-cols-[1fr_320px] gap-6">
          {/* prompt column */}
          <div className="flex flex-col gap-3 min-w-0">
            <div className="flex items-center justify-between gap-2">
              <label className="section-title flex items-center gap-2"><Icon.Edit size={13} /> Prompt</label>
              <button onClick={surprise} type="button"
                className="chip hover:bg-white/10 hover:text-white transition-colors shrink-0">
                <Icon.Shuffle size={13} /> Surprise me
              </button>
            </div>
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') generate(); }}
              placeholder="A serene bioluminescent forest at dusk, volumetric light, ultra-detailed, cinematic…"
              rows={5}
              className="input resize-none text-[15px] leading-relaxed min-h-[120px]"
            />
            <div>
              <label className="section-title flex items-center gap-2 mb-2">
                <Icon.Close size={13} /> Negative prompt
                <span className="muted font-normal normal-case tracking-normal text-[11px]">optional</span>
              </label>
              <input
                value={negative}
                onChange={(e) => setNegative(e.target.value)}
                placeholder="blurry, lowres, extra fingers, watermark…"
                className="input"
              />
            </div>

            {history.length > 0 && (
              <div className="mt-1">
                <div className="flex items-center justify-between mb-2">
                  <p className="section-title flex items-center gap-2"><Icon.Clock size={13} /> Recent prompts</p>
                  <button onClick={clearHistory} type="button" className="text-[11px] text-slate-500 hover:text-slate-300 transition-colors">Clear</button>
                </div>
                <div className="flex flex-wrap gap-2">
                  {history.map((h, i) => (
                    <button key={i} onClick={() => setPrompt(h)} title={h}
                      className="chip max-w-[240px] truncate hover:bg-white/10 hover:text-white transition-colors">
                      {h}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* settings column */}
          <div className="flex flex-col gap-5">
            <div>
              <p className="section-title mb-2">Size</p>
              <div className="grid grid-cols-3 gap-2">
                {PRESETS.map(p => (
                  <button key={p.id} onClick={() => setPresetId(p.id)}
                    className={cx('flex flex-col items-center gap-1.5 rounded-xl border px-2 py-2.5 transition-all',
                      presetId === p.id ? 'border-brand-500 bg-brand-500/15 text-white shadow-glow' : 'border-white/8 bg-ink-850/60 text-slate-400 hover:border-white/20 hover:text-slate-200')}>
                    <AspectGlyph r={p.ratio} />
                    <span className="text-[11px] font-medium leading-none">{p.label}</span>
                  </button>
                ))}
              </div>
              <p className="text-[11px] text-slate-500 mt-1.5 text-right tabular-nums">{preset.w} × {preset.h}px</p>
            </div>

            <Slider label="Steps" value={steps} min={4} max={30} onChange={setSteps} accent="#6366f1" />
            <p className="text-[11px] text-slate-500 -mt-1">Krea2 turbo — 8 steps is ideal. Higher is slower with little gain.</p>

            <div>
              <p className="section-title mb-2">Batch count</p>
              <div className="grid grid-cols-4 gap-2">
                {[1, 2, 3, 4].map(n => (
                  <button key={n} onClick={() => setBatch(n)}
                    className={cx('h-9 rounded-xl border text-sm font-semibold transition-all',
                      batch === n ? 'border-brand-500 bg-brand-500/15 text-white' : 'border-white/8 bg-ink-850/60 text-slate-400 hover:text-slate-200 hover:border-white/20')}>
                    {n}
                  </button>
                ))}
              </div>
            </div>

            <button onClick={generate} disabled={busy || !prompt.trim()}
              className={cx('btn-primary w-full justify-center h-11 text-[15px] mt-1',
                'bg-gradient-to-r from-brand-500 via-brand-600 to-fuchsia-600 hover:brightness-110 disabled:opacity-50 disabled:cursor-not-allowed')}>
              {busy ? <><Spinner size={16} /> Generating…</> : <><Icon.Sparkles size={17} /> Generate{batch > 1 ? ` × ${batch}` : ''}</>}
            </button>
            <p className="text-[11px] text-slate-500 text-center -mt-2">⌘ / Ctrl + Enter to generate</p>
          </div>
        </div>
      </div>

      {/* ---- Gallery ---- */}
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-semibold text-white tracking-tight flex items-center gap-2">
          <Icon.Image size={18} className="text-brand-400" /> Gallery
          {galleryCount > 0 && <Badge color="slate">{galleryCount}</Badge>}
        </h2>
      </div>

      {gallery === null ? (
        <PageLoader />
      ) : !hasContent ? (
        <EmptyState
          icon={<Icon.Sparkles size={28} />}
          title="No creations yet"
          subtitle="Describe an image above and hit Generate. Your masterpieces will appear here."
        />
      ) : (
        <div className="columns-2 sm:columns-3 lg:columns-4 gap-4 [column-fill:_balance]">
          {pending.flatMap(p => Array.from({ length: p.count }).map((_, i) => (
            <PendingCard key={`${p.id}-${i}`} prompt={p.prompt} />
          )))}
          {gallery.map(img => (
            <GalleryCard key={img.id} img={img} onOpen={() => setLightbox(img)} />
          ))}
        </div>
      )}

      {/* ---- Lightbox ---- */}
      <Modal open={!!lightbox} onClose={() => setLightbox(null)} title="Generated image" size="xl">
        {lightbox && (
          <div className="grid md:grid-cols-[1fr_260px] gap-5">
            <div className="relative rounded-xl overflow-hidden bg-ink-950 grid place-items-center min-h-[240px]">
              <img src={lightbox.url} alt={lightbox.prompt} className="max-h-[70vh] w-full object-contain" />
              {lbIndex > 0 && (
                <button onClick={() => stepLightbox(-1)} aria-label="Previous"
                  className="absolute left-2 top-1/2 -translate-y-1/2 w-10 h-10 rounded-full bg-black/50 backdrop-blur grid place-items-center text-white/90 hover:bg-black/70 transition-colors">
                  <Icon.ChevronLeft size={20} />
                </button>
              )}
              {gallery && lbIndex >= 0 && lbIndex < gallery.length - 1 && (
                <button onClick={() => stepLightbox(1)} aria-label="Next"
                  className="absolute right-2 top-1/2 -translate-y-1/2 w-10 h-10 rounded-full bg-black/50 backdrop-blur grid place-items-center text-white/90 hover:bg-black/70 transition-colors">
                  <Icon.ChevronRight size={20} />
                </button>
              )}
              {gallery && lbIndex >= 0 && gallery.length > 1 && (
                <span className="absolute bottom-2 left-1/2 -translate-x-1/2 text-[11px] font-medium text-white/90 bg-black/50 backdrop-blur rounded-full px-2.5 py-1 tabular-nums">
                  {lbIndex + 1} / {gallery.length}
                </span>
              )}
            </div>
            {/* Actions live at the TOP of this column: the global toaster is fixed bottom-right
                (z-[200], above the Modal's z-[100]), so keeping the buttons out of the
                bottom-right corner stops success toasts from overlapping/blocking them. */}
            <div className="flex flex-col gap-3 min-w-0">
              <div className="flex flex-col gap-2">
                <button onClick={() => remix(lightbox)} className="btn-primary justify-center bg-gradient-to-r from-brand-500 via-brand-600 to-fuchsia-600 hover:brightness-110">
                  <Icon.Shuffle size={15} /> Remix this prompt
                </button>
                <a href={lightbox.url} download={`aerie-${lightbox.id}.png`} className="btn-secondary justify-center">
                  <Icon.Download size={15} /> Download
                </a>
                <button onClick={() => doSaveToFiles(lightbox)} className="btn-secondary justify-center">
                  <Icon.Cloud size={15} /> Save to Files
                </button>
                <button onClick={() => nav(`/image-editor?src=${encodeURIComponent(lightbox.url)}`)} className="btn-secondary justify-center">
                  <Icon.Crop size={15} /> Edit in Image Editor
                </button>
                <button onClick={() => setConfirmDel(lightbox)} className="btn-danger justify-center">
                  <Icon.Trash size={15} /> Delete
                </button>
              </div>
              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <p className="section-title">Prompt</p>
                  <button onClick={() => copyPrompt(lightbox.prompt)} className="text-[11px] text-slate-400 hover:text-white transition-colors flex items-center gap-1">
                    <Icon.Copy size={12} /> Copy
                  </button>
                </div>
                <p className="text-sm text-slate-200 leading-relaxed max-h-40 overflow-y-auto pr-1">{lightbox.prompt}</p>
              </div>
              <div className="flex flex-wrap gap-2 text-[11px]">
                <span className="chip">{lightbox.width} × {lightbox.height}</span>
                {lightbox.workflow && <span className="chip">{workflowLabel(lightbox.workflow)}</span>}
                <span className="chip">{formatRelative(lightbox.createdAt)}</span>
              </div>
            </div>
          </div>
        )}
      </Modal>

      <ConfirmModal
        open={!!confirmDel}
        onClose={() => setConfirmDel(null)}
        onConfirm={() => confirmDel && doDelete(confirmDel)}
        title="Delete image?"
        message="This generated image will be permanently removed. This cannot be undone."
        confirmLabel="Delete"
        danger
      />
    </div>
  );
}

function PendingCard({ prompt }: { prompt: string }) {
  return (
    <div className="break-inside-avoid mb-4 rounded-2xl overflow-hidden border border-white/8 bg-ink-850/70 relative animate-fade-in">
      <div className="aspect-square grid place-items-center bg-gradient-to-br from-brand-600/10 via-transparent to-fuchsia-600/10 relative overflow-hidden">
        <div className="absolute inset-0 -translate-x-full animate-[cbshimmer_1.6s_infinite] bg-gradient-to-r from-transparent via-white/5 to-transparent" />
        <div className="flex flex-col items-center gap-2 text-slate-400">
          <Spinner size={22} />
          <span className="text-[11px] font-medium">Generating…</span>
        </div>
      </div>
      <div className="p-3">
        <p className="text-[11px] text-slate-500 line-clamp-2">{prompt}</p>
      </div>
      <style>{`@keyframes cbshimmer{100%{transform:translateX(100%)}}`}</style>
    </div>
  );
}

function GalleryCard({ img, onOpen }: { img: GeneratedImage; onOpen: () => void }) {
  const [loaded, setLoaded] = useState(false);
  return (
    <div className="break-inside-avoid mb-4 group relative rounded-2xl overflow-hidden bg-ink-850 border border-white/6 cursor-pointer card-hover animate-fade-in"
      onClick={onOpen}>
      {!loaded && <div className="absolute inset-0 bg-ink-800 animate-pulse" />}
      <img
        src={img.thumbUrl || img.url}
        alt={img.prompt}
        loading="lazy"
        onLoad={() => setLoaded(true)}
        onError={() => setLoaded(true)}
        className={cx('w-full block transition-opacity duration-300', loaded ? 'opacity-100' : 'opacity-0')}
        style={{ aspectRatio: img.width && img.height ? `${img.width}/${img.height}` : undefined }}
      />
      <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-black/0 to-black/0 opacity-0 group-hover:opacity-100 transition-opacity flex items-end p-3">
        <p className="text-[11px] text-white/90 line-clamp-2 leading-snug drop-shadow">{img.prompt}</p>
      </div>
      <div className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity">
        <div className="icon-btn bg-black/50 backdrop-blur text-white/90"><Icon.Eye size={15} /></div>
      </div>
    </div>
  );
}
