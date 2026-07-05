import React, { useState, useEffect, useLayoutEffect, useRef, useMemo } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../lib/api';
import { Icon } from '../lib/icons';
import { cx, formatRelative } from '../lib/utils';
import { toast } from '../lib/store';
import { voice } from '../lib/voice';
import { Spinner, EmptyState, Modal, Badge } from '../components/ui';
import type { FileEntry, GeneratedImage } from '../lib/model';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
type Tool =
  | 'move' | 'crop' | 'brush' | 'eraser' | 'text'
  | 'shape' | 'gradient' | 'eyedropper' | 'mask';
type ShapeKind = 'rect' | 'ellipse' | 'line';
type Sheet = null | 'layers' | 'adjust' | 'filters' | 'ai' | 'tool';
type Blend = 'source-over' | 'multiply' | 'screen' | 'overlay';

interface Layer {
  id: string;
  name: string;
  visible: boolean;
  opacity: number;      // 0..1
  blend: Blend;         // compositing mode
  canvas: HTMLCanvasElement; // full document resolution
}
const BLENDS: { id: Blend; label: string }[] = [
  { id: 'source-over', label: 'Normal' },
  { id: 'multiply', label: 'Multiply' },
  { id: 'screen', label: 'Screen' },
  { id: 'overlay', label: 'Overlay' },
];
interface Adjustments {
  brightness: number; contrast: number; saturation: number; exposure: number;
  temperature: number; tint: number; hue: number; sharpen: number; blur: number; vignette: number;
}
interface Snapshot {
  w: number; h: number; activeId: string;
  layers: { id: string; name: string; visible: boolean; opacity: number; blend: Blend; data: ImageData }[];
}

const ADJ0: Adjustments = {
  brightness: 100, contrast: 100, saturation: 100, exposure: 0,
  temperature: 0, tint: 0, hue: 0, sharpen: 0, blur: 0, vignette: 0,
};
const HISTORY_CAP = 14;
const SWATCHES = ['#ffffff', '#000000', '#6366f1', '#ec4899', '#22d3ee', '#f59e0b', '#10b981', '#ef4444'];

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------
const uid = () => Math.random().toString(36).slice(2, 9);
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
const clamp255 = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : v);
function newCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas'); c.width = w; c.height = h; return c;
}
function parentDir(path: string): string { const i = path.lastIndexOf('/'); return i <= 0 ? '/' : path.slice(0, i); }
function baseName(path: string): string {
  const clean = path.split('?')[0].replace(/\/$/, '');
  const i = clean.lastIndexOf('/');
  return i < 0 ? clean : clean.slice(i + 1);
}
function stripExt(name: string): string { const i = name.lastIndexOf('.'); return i <= 0 ? name : name.slice(0, i); }

const cssFilter = (a: Adjustments): string => {
  const bright = (a.brightness / 100) * (1 + a.exposure / 200);
  const parts = [`brightness(${bright})`, `contrast(${a.contrast}%)`, `saturate(${a.saturation}%)`];
  if (a.hue) parts.push(`hue-rotate(${a.hue}deg)`);
  if (a.blur) parts.push(`blur(${a.blur}px)`);
  return parts.join(' ');
};
const adjDirty = (a: Adjustments) => (Object.keys(ADJ0) as (keyof Adjustments)[]).some(k => a[k] !== ADJ0[k]);

// simple 3x3 unsharp
function sharpenImage(img: ImageData, amount: number): ImageData {
  const { data, width: w, height: h } = img;
  const out = new Uint8ClampedArray(data);
  const c = 1 + 4 * amount, s = -amount;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = (y * w + x) * 4;
      for (let k = 0; k < 3; k++) {
        const v =
          data[i + k] * c +
          data[i - 4 + k] * s + data[i + 4 + k] * s +
          data[i - w * 4 + k] * s + data[i + w * 4 + k] * s;
        out[i + k] = clamp255(v);
      }
    }
  }
  return new ImageData(out, w, h);
}

// ---------------------------------------------------------------------------
export default function ImageEditor() {
  const [params, setParams] = useSearchParams();
  const nav = useNavigate();
  const path = params.get('path') || '';
  const src = params.get('src') || '';

  // ---- canvases / refs ----
  const viewRef = useRef<HTMLCanvasElement>(null);      // composited display
  const maskRef = useRef<HTMLCanvasElement>(null);      // AI inpaint mask
  const overlayRef = useRef<HTMLCanvasElement>(null);   // live shape/gradient preview
  const stageRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);         // editor root (mobile fills to viewport)

  const layersRef = useRef<Layer[]>([]);
  const historyRef = useRef<Snapshot[]>([]);
  const redoRef = useRef<Snapshot[]>([]);
  const pendingRef = useRef<HTMLImageElement | null>(null);

  const pointers = useRef<Map<number, { x: number; y: number }>>(new Map());
  const pinch = useRef<{ dist: number; zoom: number; mx: number; my: number; px: number; py: number } | null>(null);
  const drawing = useRef(false);
  const lastPt = useRef<{ x: number; y: number } | null>(null);
  const gestureStart = useRef<{ x: number; y: number } | null>(null);
  const moveDelta = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const recRef = useRef<{ stop: () => Promise<string>; cancel: () => void } | null>(null);

  // ---- state ----
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [dims, setDims] = useState({ w: 0, h: 0 });
  const [srcName, setSrcName] = useState('untitled');
  const [, forceTick] = useState(0);
  const bump = () => forceTick(t => t + 1);

  const [tool, setTool] = useState<Tool>('move');
  const [shapeKind, setShapeKind] = useState<ShapeKind>('rect');
  const [shapeFill, setShapeFill] = useState(false);
  const [brushColor, setBrushColor] = useState('#6366f1');
  const [brushSize, setBrushSize] = useState(24);
  const [brushOpacity, setBrushOpacity] = useState(1);
  const [fontSize, setFontSize] = useState(48);

  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });

  const [activeId, setActiveId] = useState('');
  const [adj, setAdj] = useState<Adjustments>(ADJ0);

  const [crop, setCrop] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const [cropAspect, setCropAspect] = useState<number | null>(null); // w/h or null(free)
  const [textBox, setTextBox] = useState<{ x: number; y: number; value: string } | null>(null);

  const [recentImgs, setRecentImgs] = useState<FileEntry[] | null>(null);

  // AI
  const [aiAvailable, setAiAvailable] = useState<boolean | null>(null);
  const [gpuBusy, setGpuBusy] = useState(false);
  const [prompt, setPrompt] = useState('remove this object');
  const [aiMode, setAiMode] = useState<'inpaint' | 'variation'>('inpaint');
  const [aiBusy, setAiBusy] = useState(false);
  const [aiResult, setAiResult] = useState<GeneratedImage | null>(null);
  const [sttAvailable, setSttAvailable] = useState<boolean | null>(null);
  const [listening, setListening] = useState(false);
  const [transcribing, setTranscribing] = useState(false);

  const [sheet, setSheet] = useState<Sheet>(null);
  const [saveOpen, setSaveOpen] = useState(false);
  const [saveName, setSaveName] = useState('');
  const [saveDir, setSaveDir] = useState('/Edited');
  const [saving, setSaving] = useState(false);
  const [freeRot, setFreeRot] = useState(0);
  // On mobile the editor root fills from its live top offset down to the viewport bottom, so
  // the canvas takes the available height instead of leaving dead space above the fixed tool
  // bar. Measured live so it's correct regardless of the (wrapping) insecure-context banner.
  const [mobileH, setMobileH] = useState<number | null>(null);

  const dirty = adjDirty(adj);
  const previewFilter = dirty ? cssFilter(adj) : 'none';

  // ---- layer helpers ----
  const activeLayer = (): Layer | undefined =>
    layersRef.current.find(l => l.id === activeId) || layersRef.current[layersRef.current.length - 1];
  const activeCtx = () =>
    activeLayer()?.canvas.getContext('2d', { willReadFrequently: true }) || null;

  // ---- compositing ----
  function renderComposite() {
    const view = viewRef.current;
    if (!view) return;
    const g = view.getContext('2d')!;
    g.clearRect(0, 0, view.width, view.height);
    for (const L of layersRef.current) {
      if (!L.visible) continue;
      g.save();
      g.globalAlpha = L.opacity;
      g.globalCompositeOperation = L.blend;
      const isActive = L.id === activeId;
      if (isActive && dirty) g.filter = previewFilter;
      const dx = isActive && drawing.current && tool === 'move' ? moveDelta.current.x : 0;
      const dy = isActive && drawing.current && tool === 'move' ? moveDelta.current.y : 0;
      g.drawImage(L.canvas, dx, dy);
      g.restore();
    }
  }

  function flatten(applyAdj = true): HTMLCanvasElement {
    const c = newCanvas(dims.w, dims.h);
    const g = c.getContext('2d')!;
    for (const L of layersRef.current) {
      if (!L.visible) continue;
      g.save(); g.globalAlpha = L.opacity; g.globalCompositeOperation = L.blend;
      if (applyAdj && L.id === activeId && dirty) g.filter = previewFilter;
      g.drawImage(L.canvas, 0, 0);
      g.restore();
    }
    return c;
  }

  // ---- history ----
  const snapshot = (): Snapshot => ({
    w: dims.w, h: dims.h, activeId,
    layers: layersRef.current.map(L => ({
      id: L.id, name: L.name, visible: L.visible, opacity: L.opacity, blend: L.blend,
      data: L.canvas.getContext('2d', { willReadFrequently: true })!.getImageData(0, 0, L.canvas.width, L.canvas.height),
    })),
  });
  const pushHistory = () => {
    try {
      historyRef.current.push(snapshot());
      if (historyRef.current.length > HISTORY_CAP) historyRef.current.shift();
      redoRef.current = [];
    } catch { /* tainted */ }
  };
  const restoreSnap = (s: Snapshot) => {
    layersRef.current = s.layers.map(l => {
      const c = newCanvas(s.w, s.h);
      c.getContext('2d')!.putImageData(l.data, 0, 0);
      return { id: l.id, name: l.name, visible: l.visible, opacity: l.opacity, blend: l.blend, canvas: c };
    });
    setDims({ w: s.w, h: s.h });
    setActiveId(s.activeId);
    setAdj(ADJ0);
    requestAnimationFrame(renderComposite);
    bump();
  };
  const undo = () => {
    if (historyRef.current.length < 1) return;
    redoRef.current.push(snapshot());
    const s = historyRef.current.pop()!;
    restoreSnap(s);
  };
  const redo = () => {
    const s = redoRef.current.pop();
    if (!s) return;
    historyRef.current.push(snapshot());
    restoreSnap(s);
  };
  const canUndo = historyRef.current.length > 0;
  const canRedo = redoRef.current.length > 0;

  const syncSurfaces = (w: number, h: number) => {
    [maskRef.current, overlayRef.current].forEach(c => { if (c) { c.width = w; c.height = h; } });
    if (viewRef.current) { viewRef.current.width = w; viewRef.current.height = h; }
  };
  const clearMask = () => { const m = maskRef.current; if (m) m.getContext('2d')!.clearRect(0, 0, m.width, m.height); };
  const clearOverlay = () => { const o = overlayRef.current; if (o) o.getContext('2d')!.clearRect(0, 0, o.width, o.height); };

  // ---- loading ----
  const initFromImage = (img: HTMLImageElement) => {
    const w = img.naturalWidth, h = img.naturalHeight;
    const base = newCanvas(w, h);
    base.getContext('2d')!.drawImage(img, 0, 0);
    const id = uid();
    layersRef.current = [{ id, name: 'Background', visible: true, opacity: 1, blend: 'source-over', canvas: base }];
    setActiveId(id);
    setDims({ w, h });
    historyRef.current = []; redoRef.current = [];
    setAdj(ADJ0); setCrop(null); setTool('move'); setPan({ x: 0, y: 0 });
    requestAnimationFrame(() => {
      syncSurfaces(w, h);
      renderComposite();
      fit(w, h);
      pushHistory();
      bump();
    });
  };
  const placeImage = (img: HTMLImageElement) => {
    if (viewRef.current) initFromImage(img);
    else { pendingRef.current = img; setLoaded(true); }
  };
  useEffect(() => {
    if (loaded && pendingRef.current) {
      const img = pendingRef.current; pendingRef.current = null;
      requestAnimationFrame(() => initFromImage(img));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded]);

  const loadFromUrl = (url: string, revokeAfter = false) => {
    setLoading(true);
    const img = new Image();
    img.onload = () => { placeImage(img); setLoading(false); setLoaded(true); if (revokeAfter) URL.revokeObjectURL(url); };
    img.onerror = () => { setLoading(false); if (revokeAfter) URL.revokeObjectURL(url); toast('Could not load image', 'error'); };
    img.src = url;
  };
  const loadFromFile = (file: File) => {
    if (!file.type.startsWith('image/')) { toast('Please choose an image file', 'warning'); return; }
    const url = URL.createObjectURL(file);
    setSrcName(stripExt(file.name) || 'image');
    loadFromUrl(url, true);
  };
  const loadExternal = async (url: string) => {
    setLoading(true);
    // Same-origin API paths (e.g. /api/images/file/...) are token-protected — attach it.
    const authed = url.startsWith('/') ? api.url(url) : url;
    try {
      const res = await fetch(authed);
      if (!res.ok) throw new Error(String(res.status));
      const blob = await res.blob();
      const obj = URL.createObjectURL(blob);
      setSrcName(stripExt(baseName(url)) || 'photo');
      loadFromUrl(obj, true);
    } catch {
      setSrcName(stripExt(baseName(url)) || 'photo');
      loadFromUrl(authed, false);
    }
  };

  useEffect(() => {
    if (path) { setSrcName(stripExt(baseName(path)) || 'image'); loadFromUrl(api.files.rawUrl(path)); }
    else if (src) { loadExternal(src); }
    else { setLoaded(false); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, src]);

  useEffect(() => {
    api.images.status().then((s: any) => {
      setAiAvailable(!!s.available);
      setGpuBusy(s?.gpu?.running === 'music');
    }).catch(() => setAiAvailable(false));
    api.ai.transcribeStatus().then(s => setSttAvailable(!!s.available)).catch(() => setSttAvailable(false));
  }, []);

  useEffect(() => {
    if (path || src || loaded) return;
    api.files.recent(60).then(list => setRecentImgs(list.filter(f => f.kind === 'image'))).catch(() => setRecentImgs([]));
  }, [path, src, loaded]);

  // recomposite on meaningful change
  useEffect(() => { renderComposite(); /* eslint-disable-next-line */ }, [adj, activeId, dims.w, dims.h]);

  // Size the editor root to the available viewport height on mobile (desktop uses the CSS
  // height). This fills the canvas down to just above the fixed tool bar with no dead space.
  useLayoutEffect(() => {
    const compute = () => {
      if (typeof window === 'undefined') return;
      if (window.innerWidth >= 1024) { setMobileH(null); return; }
      const el = rootRef.current;
      if (!el) return;
      const top = el.getBoundingClientRect().top;
      setMobileH(Math.max(320, Math.round(window.innerHeight - top)));
    };
    compute();
    window.addEventListener('resize', compute);
    return () => window.removeEventListener('resize', compute);
  }, [loaded]);

  const fit = (w = dims.w, h = dims.h) => {
    const stage = stageRef.current;
    if (!stage || !w || !h) return;
    const pad = 32;
    const z = Math.min((stage.clientWidth - pad) / w, (stage.clientHeight - pad) / h, 1);
    setZoom(Math.max(0.05, z));
    setPan({ x: 0, y: 0 });
  };

  // ---- keyboard ----
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (textBox || !loaded) return;
      const el = e.target as HTMLElement;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) return;
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); }
      else if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); }
      else if (!mod) {
        const m: Record<string, Tool> = { v: 'move', c: 'crop', b: 'brush', e: 'eraser', t: 'text', u: 'shape', g: 'gradient', i: 'eyedropper', m: 'mask' };
        if (m[e.key]) setTool(m[e.key]);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [textBox, loaded, activeId]);

  // ---- coordinate mapping (rect reflects zoom+pan CSS) ----
  const toDoc = (clientX: number, clientY: number) => {
    const c = viewRef.current!;
    const r = c.getBoundingClientRect();
    return {
      x: Math.round((clientX - r.left) * (c.width / r.width)),
      y: Math.round((clientY - r.top) * (c.height / r.height)),
    };
  };

  // ---- drawing primitives (active layer) ----
  const strokeSeg = (a: { x: number; y: number }, b: { x: number; y: number }, erase = false) => {
    const g = activeCtx(); if (!g) return;
    g.save();
    g.globalAlpha = brushOpacity;
    g.globalCompositeOperation = erase ? 'destination-out' : 'source-over';
    g.strokeStyle = brushColor; g.lineWidth = brushSize; g.lineCap = 'round'; g.lineJoin = 'round';
    g.beginPath(); g.moveTo(a.x, a.y); g.lineTo(b.x, b.y); g.stroke();
    g.restore();
  };
  const maskSeg = (a: { x: number; y: number }, b: { x: number; y: number }) => {
    const m = maskRef.current; if (!m) return;
    const g = m.getContext('2d')!;
    g.strokeStyle = 'rgba(239,68,68,1)'; g.lineWidth = brushSize; g.lineCap = 'round'; g.lineJoin = 'round';
    g.beginPath(); g.moveTo(a.x, a.y); g.lineTo(b.x, b.y); g.stroke();
  };
  const drawShapeOn = (g: CanvasRenderingContext2D, s: { x: number; y: number }, e: { x: number; y: number }) => {
    g.save();
    g.globalAlpha = brushOpacity;
    g.strokeStyle = brushColor; g.fillStyle = brushColor;
    g.lineWidth = brushSize; g.lineCap = 'round'; g.lineJoin = 'round';
    const x = Math.min(s.x, e.x), y = Math.min(s.y, e.y), w = Math.abs(e.x - s.x), h = Math.abs(e.y - s.y);
    if (shapeKind === 'rect') { g.beginPath(); g.rect(x, y, w, h); shapeFill ? g.fill() : g.stroke(); }
    else if (shapeKind === 'ellipse') { g.beginPath(); g.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2); shapeFill ? g.fill() : g.stroke(); }
    else { g.beginPath(); g.moveTo(s.x, s.y); g.lineTo(e.x, e.y); g.stroke(); }
    g.restore();
  };
  const drawGradientOn = (g: CanvasRenderingContext2D, s: { x: number; y: number }, e: { x: number; y: number }) => {
    const grd = g.createLinearGradient(s.x, s.y, e.x, e.y);
    grd.addColorStop(0, brushColor);
    grd.addColorStop(1, brushColor + '00');
    g.save(); g.globalAlpha = brushOpacity; g.fillStyle = grd; g.fillRect(0, 0, dims.w, dims.h); g.restore();
  };

  // ---- pointer handling (draw + pinch) ----
  const onDown = (e: React.PointerEvent) => {
    if (!loaded) return;
    // Text tool: place a caret WITHOUT capturing the pointer. Pointer capture routes the
    // follow-up compatibility `click` to the (non-focusable) canvas, which blurs the just-
    // mounted text input — onBlur then commits an empty box and unmounts it (the "flash").
    if (tool === 'text') {
      const tp = toDoc(e.clientX, e.clientY);
      if (textBox && textBox.value.trim()) commitText();
      setTextBox({ x: tp.x, y: tp.y, value: '' });
      return;
    }
    (e.target as Element).setPointerCapture?.(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.current.size === 2) {
      // begin pinch
      drawing.current = false;
      const pts: { x: number; y: number }[] = Array.from(pointers.current.values());
      const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      pinch.current = { dist, zoom, mx: (pts[0].x + pts[1].x) / 2, my: (pts[0].y + pts[1].y) / 2, px: pan.x, py: pan.y };
      clearOverlay();
      return;
    }
    if (pointers.current.size > 2) return;
    const p = toDoc(e.clientX, e.clientY);
    if (tool === 'eyedropper') {
      const view = viewRef.current!; const d = view.getContext('2d')!.getImageData(clamp(p.x, 0, dims.w - 1), clamp(p.y, 0, dims.h - 1), 1, 1).data;
      const hex = '#' + [d[0], d[1], d[2]].map(v => v.toString(16).padStart(2, '0')).join('');
      setBrushColor(hex); toast('Picked color', 'success', hex); setTool('brush'); return;
    }
    drawing.current = true; lastPt.current = p; gestureStart.current = p; moveDelta.current = { x: 0, y: 0 };
    if (tool === 'brush') { pushHistory(); strokeSeg(p, p); renderComposite(); }
    else if (tool === 'eraser') { pushHistory(); strokeSeg(p, p, true); renderComposite(); }
    else if (tool === 'mask') { maskSeg(p, p); }
    else if (tool === 'crop') setCrop({ x: p.x, y: p.y, w: 0, h: 0 });
    else if (tool === 'shape' || tool === 'gradient') { /* preview on move */ }
    else if (tool === 'move') pushHistory();
  };

  const onMove = (e: React.PointerEvent) => {
    if (pointers.current.has(e.pointerId)) pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    // pinch zoom / pan
    if (pinch.current && pointers.current.size >= 2) {
      const pts: { x: number; y: number }[] = Array.from(pointers.current.values());
      const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      const mx = (pts[0].x + pts[1].x) / 2, my = (pts[0].y + pts[1].y) / 2;
      const nz = clamp(pinch.current.zoom * (dist / pinch.current.dist), 0.05, 6);
      setZoom(nz);
      setPan({ x: pinch.current.px + (mx - pinch.current.mx), y: pinch.current.py + (my - pinch.current.my) });
      return;
    }
    if (!drawing.current) return;
    const p = toDoc(e.clientX, e.clientY);
    const last = lastPt.current!;
    if (tool === 'brush') { strokeSeg(last, p); renderComposite(); }
    else if (tool === 'eraser') { strokeSeg(last, p, true); renderComposite(); }
    else if (tool === 'mask') maskSeg(last, p);
    else if (tool === 'move') { moveDelta.current = { x: p.x - gestureStart.current!.x, y: p.y - gestureStart.current!.y }; renderComposite(); }
    else if (tool === 'crop' && gestureStart.current) {
      const s = gestureStart.current;
      let w = p.x - s.x, h = p.y - s.y;
      if (cropAspect) { const aw = Math.abs(w); h = (aw / cropAspect) * Math.sign(h || 1); w = aw * Math.sign(w || 1); }
      setCrop({ x: Math.min(s.x, s.x + w), y: Math.min(s.y, s.y + h), w: Math.abs(w), h: Math.abs(h) });
    } else if ((tool === 'shape' || tool === 'gradient') && gestureStart.current) {
      const o = overlayRef.current!; const og = o.getContext('2d')!;
      og.clearRect(0, 0, o.width, o.height);
      if (tool === 'shape') drawShapeOn(og, gestureStart.current, p);
      else { og.save(); og.strokeStyle = brushColor; og.lineWidth = 2 / zoom; og.setLineDash([6 / zoom, 4 / zoom]); og.beginPath(); og.moveTo(gestureStart.current.x, gestureStart.current.y); og.lineTo(p.x, p.y); og.stroke(); og.restore(); }
    }
    lastPt.current = p;
  };

  const onUp = (e: React.PointerEvent) => {
    pointers.current.delete(e.pointerId);
    if (pointers.current.size < 2) pinch.current = null;
    if (!drawing.current) return;
    const p = lastPt.current;
    if ((tool === 'shape' || tool === 'gradient') && gestureStart.current && p) {
      const g = activeCtx();
      if (g) {
        pushHistory();
        if (tool === 'shape') drawShapeOn(g, gestureStart.current, p);
        else drawGradientOn(g, gestureStart.current, p);
      }
      clearOverlay(); renderComposite(); bump();
    } else if (tool === 'move' && (moveDelta.current.x || moveDelta.current.y)) {
      const L = activeLayer();
      if (L) {
        const tmp = newCanvas(L.canvas.width, L.canvas.height);
        tmp.getContext('2d')!.drawImage(L.canvas, moveDelta.current.x, moveDelta.current.y);
        const g = L.canvas.getContext('2d')!; g.clearRect(0, 0, L.canvas.width, L.canvas.height); g.drawImage(tmp, 0, 0);
      }
      moveDelta.current = { x: 0, y: 0 };
      renderComposite(); bump();
    } else if (tool === 'brush' || tool === 'eraser') bump();
    drawing.current = false; lastPt.current = null; gestureStart.current = null;
  };

  // ---- transforms (all layers) ----
  const remapAll = (nw: number, nh: number, paint: (g: CanvasRenderingContext2D, from: HTMLCanvasElement) => void) => {
    pushHistory();
    layersRef.current = layersRef.current.map(L => {
      const c = newCanvas(nw, nh); const g = c.getContext('2d')!; paint(g, L.canvas);
      return { ...L, canvas: c };
    });
    setDims({ w: nw, h: nh });
    requestAnimationFrame(() => { syncSurfaces(nw, nh); renderComposite(); fit(nw, nh); clearMask(); });
    bump();
  };
  const rotate90 = (dir: -1 | 1) => remapAll(dims.h, dims.w, (g, from) => {
    g.translate(dims.h / 2, dims.w / 2); g.rotate((dir * Math.PI) / 2); g.drawImage(from, -dims.w / 2, -dims.h / 2);
  });
  const flip = (axis: 'h' | 'v') => remapAll(dims.w, dims.h, (g, from) => {
    g.translate(axis === 'h' ? dims.w : 0, axis === 'v' ? dims.h : 0);
    g.scale(axis === 'h' ? -1 : 1, axis === 'v' ? -1 : 1); g.drawImage(from, 0, 0);
  });
  const applyFreeRotate = () => {
    if (!freeRot) return;
    const rad = (freeRot * Math.PI) / 180, w = dims.w, h = dims.h;
    const nw = Math.round(Math.abs(w * Math.cos(rad)) + Math.abs(h * Math.sin(rad)));
    const nh = Math.round(Math.abs(w * Math.sin(rad)) + Math.abs(h * Math.cos(rad)));
    remapAll(nw, nh, (g, from) => { g.translate(nw / 2, nh / 2); g.rotate(rad); g.drawImage(from, -w / 2, -h / 2); });
    setFreeRot(0);
  };
  const applyCrop = () => {
    if (!crop || crop.w < 4 || crop.h < 4) { toast('Draw a crop region first', 'warning'); return; }
    const cx0 = clamp(Math.round(crop.x), 0, Math.max(0, dims.w - 1)), cy0 = clamp(Math.round(crop.y), 0, Math.max(0, dims.h - 1));
    const cw = Math.max(1, Math.min(Math.round(crop.w), dims.w - cx0)), ch = Math.max(1, Math.min(Math.round(crop.h), dims.h - cy0));
    if (cw < 1 || ch < 1) { toast('Crop region is off the image', 'warning'); return; }
    remapAll(cw, ch, (g, from) => g.drawImage(from, -cx0, -cy0));
    setCrop(null); setTool('move');
  };

  // ---- adjustments / filters bake (active layer) ----
  const bakeAdjustments = () => {
    if (!dirty) return;
    const L = activeLayer(); if (!L) return;
    pushHistory();
    const c = L.canvas, w = c.width, h = c.height;
    const g = c.getContext('2d', { willReadFrequently: true })!;
    const tmp = newCanvas(w, h); tmp.getContext('2d')!.drawImage(c, 0, 0);
    g.clearRect(0, 0, w, h);
    g.filter = cssFilter(adj); g.drawImage(tmp, 0, 0); g.filter = 'none';
    if (adj.temperature || adj.tint || adj.sharpen) {
      let img = g.getImageData(0, 0, w, h);
      if (adj.sharpen) img = sharpenImage(img, adj.sharpen / 100);
      if (adj.temperature || adj.tint) {
        const d = img.data, t = (adj.temperature / 100) * 50, ti = (adj.tint / 100) * 50;
        for (let i = 0; i < d.length; i += 4) {
          d[i] = clamp255(d[i] + t + ti * 0.4);
          d[i + 1] = clamp255(d[i + 1] - ti * 0.6);
          d[i + 2] = clamp255(d[i + 2] - t + ti * 0.4);
        }
      }
      g.putImageData(img, 0, 0);
    }
    if (adj.vignette) {
      const grd = g.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.32, w / 2, h / 2, Math.max(w, h) * 0.72);
      grd.addColorStop(0, 'rgba(0,0,0,0)');
      grd.addColorStop(1, `rgba(0,0,0,${(adj.vignette / 100) * 0.85})`);
      g.save(); g.globalCompositeOperation = 'source-over'; g.fillStyle = grd; g.fillRect(0, 0, w, h); g.restore();
    }
    setAdj(ADJ0); renderComposite(); bump();
    toast('Adjustments applied', 'success', 'Undo to revert');
  };
  const applyPreset = (name: string, filter: string, vignette = 0) => {
    const L = activeLayer(); if (!L) return;
    pushHistory();
    const c = L.canvas, w = c.width, h = c.height;
    const g = c.getContext('2d')!;
    const tmp = newCanvas(w, h); tmp.getContext('2d')!.drawImage(c, 0, 0);
    g.clearRect(0, 0, w, h); g.filter = filter; g.drawImage(tmp, 0, 0); g.filter = 'none';
    if (vignette) {
      const grd = g.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.32, w / 2, h / 2, Math.max(w, h) * 0.72);
      grd.addColorStop(0, 'rgba(0,0,0,0)'); grd.addColorStop(1, `rgba(0,0,0,${vignette})`);
      g.fillStyle = grd; g.fillRect(0, 0, w, h);
    }
    renderComposite(); bump();
    toast(`${name} filter applied`, 'success', 'Undo to revert');
  };

  // ---- text ----
  const commitText = () => {
    if (!textBox) return;
    const t = textBox.value.trim();
    if (t) {
      const g = activeCtx();
      if (g) {
        pushHistory();
        g.save();
        g.fillStyle = brushColor;
        g.font = `600 ${fontSize}px ui-sans-serif, system-ui, -apple-system, sans-serif`;
        g.textBaseline = 'top';
        g.fillText(t, textBox.x, textBox.y);
        g.restore();
        renderComposite(); bump();
      }
    }
    setTextBox(null);
  };

  // ---- layers ops ----
  const setLayer = (id: string, patch: Partial<Layer>) => {
    layersRef.current = layersRef.current.map(L => (L.id === id ? { ...L, ...patch } : L));
    renderComposite(); bump();
  };
  const addLayer = () => {
    pushHistory();
    const c = newCanvas(dims.w, dims.h);
    const id = uid();
    const idx = layersRef.current.findIndex(l => l.id === activeId);
    const layer: Layer = { id, name: `Layer ${layersRef.current.length + 1}`, visible: true, opacity: 1, blend: 'source-over', canvas: c };
    const arr = [...layersRef.current]; arr.splice(idx + 1, 0, layer);
    layersRef.current = arr; setActiveId(id); renderComposite(); bump();
  };
  const duplicateLayer = (id: string) => {
    pushHistory();
    const L = layersRef.current.find(l => l.id === id); if (!L) return;
    const c = newCanvas(L.canvas.width, L.canvas.height); c.getContext('2d')!.drawImage(L.canvas, 0, 0);
    const nid = uid();
    const idx = layersRef.current.findIndex(l => l.id === id);
    const arr = [...layersRef.current]; arr.splice(idx + 1, 0, { ...L, id: nid, name: L.name + ' copy', canvas: c });
    layersRef.current = arr; setActiveId(nid); renderComposite(); bump();
  };
  const deleteLayer = (id: string) => {
    if (layersRef.current.length <= 1) { toast('Keep at least one layer', 'warning'); return; }
    pushHistory();
    const idx = layersRef.current.findIndex(l => l.id === id);
    layersRef.current = layersRef.current.filter(l => l.id !== id);
    if (activeId === id) setActiveId(layersRef.current[Math.max(0, idx - 1)].id);
    renderComposite(); bump();
  };
  const moveLayer = (id: string, dir: -1 | 1) => {
    const arr = [...layersRef.current];
    const i = arr.findIndex(l => l.id === id);
    const j = i + dir;
    if (j < 0 || j >= arr.length) return;
    pushHistory();
    [arr[i], arr[j]] = [arr[j], arr[i]];
    layersRef.current = arr; renderComposite(); bump();
  };

  // ---- AI ----
  const maskHasPaint = () => {
    const m = maskRef.current; if (!m) return false;
    try { const d = m.getContext('2d')!.getImageData(0, 0, m.width, m.height).data; for (let i = 3; i < d.length; i += 40) if (d[i] > 10) return true; } catch { /* */ }
    return false;
  };
  const runAi = async (modeArg?: 'inpaint' | 'variation') => {
    const mode = modeArg || aiMode;
    if (!aiAvailable) { toast('Image engine offline', 'warning', 'Start it in AI Image Studio.'); return; }
    if (mode === 'inpaint' && !maskHasPaint()) { toast('Paint a mask over the area first', 'warning'); setTool('mask'); setSheet(null); return; }
    if (!prompt.trim()) { toast('Describe the change first', 'warning', 'Type what should appear in the painted area.'); return; }
    if (dirty) bakeAdjustments();
    setAiBusy(true); setAiResult(null);
    try {
      const init = flatten(false);
      const initImage = init.toDataURL('image/png').split(',')[1];
      const payload: any = { initImage, prompt: prompt.trim(), width: dims.w, height: dims.h };
      if (mode === 'inpaint') {
        const m = maskRef.current!;
        const mask = newCanvas(m.width, m.height);
        const mg = mask.getContext('2d')!;
        mg.fillStyle = '#000'; mg.fillRect(0, 0, mask.width, mask.height);
        const s = m.getContext('2d')!.getImageData(0, 0, m.width, m.height);
        const out = mg.getImageData(0, 0, mask.width, mask.height);
        for (let i = 0; i < s.data.length; i += 4) {
          if (s.data[i + 3] > 10) { out.data[i] = out.data[i + 1] = out.data[i + 2] = 255; }
          out.data[i + 3] = 255;
        }
        mg.putImageData(out, 0, 0);
        payload.maskImage = mask.toDataURL('image/png').split(',')[1];
      }
      const res = await api.images.edit(payload);
      const first = res.images?.[0];
      if (first?.url) setAiResult(first); else toast('No result returned', 'warning');
    } catch (err: any) {
      toast('AI edit failed', 'error', err?.message || 'The image engine did not respond');
    } finally { setAiBusy(false); }
  };
  const applyAiAsLayer = async () => {
    if (!aiResult) return;
    try {
      const res = await fetch(api.url(aiResult.url));
      if (!res.ok) throw new Error(String(res.status));
      const blob = await res.blob();
      const obj = URL.createObjectURL(blob);
      const img = new Image();
      img.onload = () => {
        pushHistory();
        const c = newCanvas(dims.w, dims.h);
        c.getContext('2d')!.drawImage(img, 0, 0, dims.w, dims.h);
        const id = uid();
        layersRef.current = [...layersRef.current, { id, name: aiMode === 'inpaint' ? 'AI Inpaint' : 'AI Variation', visible: true, opacity: 1, blend: 'source-over', canvas: c }];
        setActiveId(id);
        URL.revokeObjectURL(obj); clearMask(); setAiResult(null); setTool('move');
        renderComposite(); bump();
        toast('Added AI result as a layer', 'success');
      };
      img.onerror = () => { URL.revokeObjectURL(obj); toast('Could not load result', 'error'); };
      img.src = obj;
    } catch { toast('Could not load result', 'error'); }
  };
  const saveAiResult = async () => {
    if (!aiResult) return;
    try { const r = await api.images.saveToFiles(aiResult.id, '/Edited'); toast('Saved AI edit to Files', 'success', r.path); }
    catch (e: any) { toast('Save failed', 'error', e?.message); }
  };

  // ---- voice dictation for AI prompt (shared voice helper) ----
  const talk = async () => {
    if (listening) {
      // stop & transcribe
      const rec = recRef.current; recRef.current = null;
      setListening(false);
      if (!rec) return;
      setTranscribing(true);
      try {
        const text = await rec.stop();
        if (text?.trim()) setPrompt(p => (p.trim() ? p.trim() + ' ' : '') + text.trim());
        else toast('Nothing heard', 'warning', 'Try holding the mic a little longer.');
      } catch (e: any) { toast('Transcription failed', 'error', e?.message); }
      finally { setTranscribing(false); }
      return;
    }
    if (sttAvailable === false) { toast('Voice unavailable', 'warning', 'Speech-to-text (Whisper) is offline.'); return; }
    const reason = voice.unavailableReason();
    if (reason) { toast('Voice unavailable', 'warning', reason); return; }
    try {
      recRef.current = await voice.start();
      setListening(true);
    } catch (e: any) { toast('Microphone error', 'error', e?.message || 'Could not access the microphone.'); }
  };
  useEffect(() => () => { try { recRef.current?.cancel(); } catch { /* */ } }, []);

  // ---- export / save ----
  const exportDownload = () => {
    if (dirty) bakeAdjustments();
    try {
      const a = document.createElement('a');
      a.href = flatten(false).toDataURL('image/png');
      a.download = `${srcName}-edited.png`; a.click();
    } catch { toast('Export blocked (image is cross-origin)', 'error'); }
  };
  const openSave = () => { setSaveName(`${srcName}-edited`); setSaveOpen(true); };
  const ensureDir = async (dir: string) => {
    if (!dir || dir === '/') return;
    try { await api.files.mkdir(parentDir(dir), baseName(dir)); } catch { /* exists */ }
  };
  const doSave = async () => {
    if (dirty) bakeAdjustments();
    setSaving(true);
    try {
      const blob: Blob = await new Promise((resolve, reject) => flatten(false).toBlob(b => (b ? resolve(b) : reject(new Error('toBlob failed'))), 'image/png'));
      const dir = saveDir.trim() || '/';
      const fname = `${saveName.trim() || `${srcName}-edited`}.png`;
      await ensureDir(dir);
      await api.files.upload(dir, [new File([blob], fname, { type: 'image/png' })]);
      toast('Saved to Files', 'success', `${dir === '/' ? '' : dir}/${fname}`);
      setSaveOpen(false);
    } catch (err: any) {
      toast('Save failed', 'error', err?.message || 'Could not export (image may be cross-origin)');
    } finally { setSaving(false); }
  };

  const displayW = dims.w * zoom;
  const displayH = dims.h * zoom;

  // ================= OPEN STATE =================
  if (!loaded) {
    return (
      <div className="animate-fade-in">
        <div className="flex items-center gap-3 mb-6">
          <div className="w-11 h-11 rounded-2xl bg-brand-500/15 grid place-items-center text-brand-400"><Icon.Crop size={22} /></div>
          <div>
            <h1 className="text-2xl font-bold text-white tracking-tight">Image Editor</h1>
            <p className="muted text-sm">Layers, retouching, filters and AI inpainting.</p>
          </div>
        </div>

        <div className="card p-5 sm:p-8 max-w-4xl">
          <div className="flex flex-col items-center text-center py-4 sm:py-6">
            <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-brand-500/25 to-accent-pink/20 grid place-items-center text-brand-300 mb-4">
              <Icon.Image size={30} />
            </div>
            <h2 className="text-lg font-semibold text-white">Open an image to start editing</h2>
            <p className="muted text-sm mt-1 mb-5">Upload from your device or pick a recent photo from Files.</p>
            <label className="btn-primary cursor-pointer">
              <Icon.Upload size={16} /> Upload image
              <input type="file" accept="image/*" className="hidden"
                onChange={e => { const f = e.target.files?.[0]; if (f) loadFromFile(f); e.target.value = ''; }} />
            </label>
            {loading && <div className="mt-4 flex items-center gap-2 text-sm muted"><Spinner size={14} /> Loading…</div>}
          </div>

          <div className="mt-6">
            <h3 className="section-title mb-3">Recent images</h3>
            {recentImgs === null ? (
              <div className="grid place-items-center py-10"><Spinner /></div>
            ) : recentImgs.length === 0 ? (
              <EmptyState icon={<Icon.Photos size={26} />} title="No recent images"
                subtitle="Upload an image above, or open one from the Files app."
                action={<button className="btn-secondary" onClick={() => nav('/files')}>Open Files</button>} />
            ) : (
              <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-6 gap-2.5 sm:gap-3">
                {recentImgs.slice(0, 18).map(f => (
                  <button key={f.id} onClick={() => setParams({ path: f.path })} className="group text-left">
                    <div className="aspect-square rounded-xl overflow-hidden bg-ink-800 card-hover">
                      <img src={api.files.thumbUrl(f.path)} loading="lazy"
                        className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300" />
                    </div>
                    <p className="text-xs text-slate-300 truncate mt-1.5">{f.name}</p>
                    <p className="text-[11px] text-slate-500 truncate">{formatRelative(f.modifiedAt)}</p>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }

  // ================= EDITOR =================
  const tools: { id: Tool; icon: React.ReactNode; label: string }[] = [
    { id: 'move', icon: <Icon.Grid size={18} />, label: 'Move' },
    { id: 'crop', icon: <Icon.Crop size={18} />, label: 'Crop' },
    { id: 'brush', icon: <Icon.Edit size={18} />, label: 'Brush' },
    { id: 'eraser', icon: <Icon.Close size={18} />, label: 'Eraser' },
    { id: 'text', icon: <Icon.Doc size={18} />, label: 'Text' },
    { id: 'shape', icon: <Icon.Star size={18} />, label: 'Shape' },
    { id: 'gradient', icon: <Icon.Bolt size={18} />, label: 'Gradient' },
    { id: 'eyedropper', icon: <Icon.Search size={18} />, label: 'Eyedropper' },
    { id: 'mask', icon: <Icon.Sparkles size={18} />, label: 'AI Mask' },
  ];
  const cursorClass =
    tool === 'move' ? 'cursor-move' : tool === 'text' ? 'cursor-text' :
    tool === 'eyedropper' ? 'cursor-copy' : 'cursor-crosshair';
  const paintTool = tool === 'brush' || tool === 'eraser' || tool === 'mask' || tool === 'shape' || tool === 'gradient' || tool === 'text';

  const ColorRow = (
    <div>
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs muted">Color</span>
        <span className="text-xs text-slate-400 tabular-nums">{brushColor}</span>
      </div>
      <div className="flex items-center gap-2 flex-wrap">
        <input type="color" value={brushColor} onChange={e => setBrushColor(e.target.value)}
          className="w-9 h-9 rounded-lg bg-transparent cursor-pointer border border-white/10" />
        {SWATCHES.map(c => (
          <button key={c} onClick={() => setBrushColor(c)}
            className={cx('w-7 h-7 rounded-md border', brushColor === c ? 'ring-2 ring-brand-400 border-transparent' : 'border-white/10')}
            style={{ background: c }} />
        ))}
      </div>
    </div>
  );

  const ToolSettings = (
    <div className="card p-4 space-y-4">
      <h3 className="section-title">
        {tool === 'text' ? 'Text' : tool === 'mask' ? 'AI mask brush' : tool === 'shape' ? 'Shape' :
         tool === 'gradient' ? 'Gradient' : tool === 'eraser' ? 'Eraser' : 'Brush'}
      </h3>
      {(tool === 'brush' || tool === 'text' || tool === 'shape' || tool === 'gradient') && ColorRow}
      {tool === 'shape' && (
        <div>
          <div className="grid grid-cols-3 gap-2 mb-2">
            {(['rect', 'ellipse', 'line'] as ShapeKind[]).map(k => (
              <button key={k} onClick={() => setShapeKind(k)}
                className={cx('btn-secondary !py-1.5 text-xs justify-center capitalize', shapeKind === k && 'ring-1 ring-brand-400 text-white')}>{k}</button>
            ))}
          </div>
          {shapeKind !== 'line' && (
            <label className="flex items-center gap-2 text-xs muted">
              <input type="checkbox" checked={shapeFill} onChange={e => setShapeFill(e.target.checked)} className="accent-brand-500" /> Filled
            </label>
          )}
        </div>
      )}
      {tool === 'text' ? (
        <label className="block">
          <span className="text-xs muted">Font size · {fontSize}px</span>
          <input type="range" min={12} max={240} value={fontSize} onChange={e => setFontSize(+e.target.value)} className="w-full accent-brand-500 mt-1" />
          <span className="text-[11px] text-slate-500">Tap the canvas, type, press Enter to place.</span>
        </label>
      ) : (
        <>
          <label className="block">
            <span className="text-xs muted">Size · {brushSize}px</span>
            <input type="range" min={2} max={200} value={brushSize} onChange={e => setBrushSize(+e.target.value)} className="w-full accent-brand-500 mt-1" />
          </label>
          {tool !== 'mask' && (
            <label className="block">
              <span className="text-xs muted">Opacity · {Math.round(brushOpacity * 100)}%</span>
              <input type="range" min={5} max={100} value={Math.round(brushOpacity * 100)} onChange={e => setBrushOpacity(+e.target.value / 100)} className="w-full accent-brand-500 mt-1" />
            </label>
          )}
        </>
      )}
    </div>
  );

  const LayersPanel = (
    <div className="card p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="section-title flex items-center gap-1.5"><Icon.Copy size={14} /> Layers</h3>
        <button className="icon-btn" title="Add layer" onClick={addLayer}><Icon.Plus size={16} /></button>
      </div>
      <div className="space-y-1.5">
        {[...layersRef.current].reverse().map(L => (
          <div key={L.id}
            className={cx('rounded-xl p-2 flex flex-wrap items-center gap-2 border transition-colors cursor-pointer',
              activeId === L.id ? 'bg-brand-500/15 border-brand-400/40' : 'bg-white/[0.03] border-white/[0.06] hover:bg-white/[0.06]')}
            onClick={() => { setActiveId(L.id); renderComposite(); bump(); }}>
            <button className="icon-btn !w-7 !h-7 shrink-0" title={L.visible ? 'Hide' : 'Show'}
              onClick={e => { e.stopPropagation(); setLayer(L.id, { visible: !L.visible }); }}>
              <Icon.Eye size={14} className={cx(!L.visible && 'opacity-30')} />
            </button>
            <div className="w-9 h-9 rounded-md bg-ink-800 overflow-hidden shrink-0 border border-white/10 grid place-items-center">
              <LayerThumb layer={L} />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-xs text-white truncate">{L.name}</p>
              <input type="range" min={0} max={100} value={Math.round(L.opacity * 100)}
                onClick={e => e.stopPropagation()}
                onChange={e => setLayer(L.id, { opacity: +e.target.value / 100 })}
                className="w-full accent-brand-500 h-1" />
            </div>
            <div className="flex flex-col shrink-0">
              <button className="text-slate-500 hover:text-white" title="Move up" onClick={e => { e.stopPropagation(); moveLayer(L.id, 1); }}><Icon.ChevronDown size={13} className="-scale-y-100" /></button>
              <button className="text-slate-500 hover:text-white" title="Move down" onClick={e => { e.stopPropagation(); moveLayer(L.id, -1); }}><Icon.ChevronDown size={13} /></button>
            </div>
            <button className="icon-btn !w-7 !h-7 shrink-0" title="Duplicate" onClick={e => { e.stopPropagation(); duplicateLayer(L.id); }}><Icon.Copy size={13} /></button>
            <button className="icon-btn !w-7 !h-7 shrink-0 text-accent-red" title="Delete" onClick={e => { e.stopPropagation(); deleteLayer(L.id); }}><Icon.Trash size={13} /></button>
            {activeId === L.id && (
              <label className="basis-full flex items-center gap-2 mt-0.5" onClick={e => e.stopPropagation()}>
                <span className="text-[10px] uppercase tracking-wide text-slate-500 shrink-0">Blend</span>
                <select value={L.blend}
                  onChange={e => setLayer(L.id, { blend: e.target.value as Blend })}
                  className="flex-1 min-w-0 bg-ink-800 border border-white/10 rounded-md text-[11px] text-slate-200 pl-2 pr-6 py-1 outline-none focus:border-brand-400 cursor-pointer">
                  {BLENDS.map(bl => <option key={bl.id} value={bl.id}>{bl.label}</option>)}
                </select>
              </label>
            )}
          </div>
        ))}
      </div>
    </div>
  );

  const TransformPanel = (
    <div className="card p-4">
      <h3 className="section-title mb-3">Transform</h3>
      <div className="grid grid-cols-2 gap-2 mb-3">
        <button className="btn-secondary !py-2 text-xs justify-center" onClick={() => rotate90(-1)}><Icon.Refresh size={14} className="-scale-x-100" /> Rotate L</button>
        <button className="btn-secondary !py-2 text-xs justify-center" onClick={() => rotate90(1)}><Icon.Refresh size={14} /> Rotate R</button>
        <button className="btn-secondary !py-2 text-xs justify-center" onClick={() => flip('h')}><Icon.ChevronLeft size={13} className="-mr-1.5" /><Icon.ChevronRight size={13} /> Flip H</button>
        <button className="btn-secondary !py-2 text-xs justify-center" onClick={() => flip('v')}><Icon.ChevronDown size={13} /> Flip V</button>
      </div>
      <label className="block">
        <div className="flex justify-between text-xs mb-1"><span className="muted">Free rotate</span><span className="text-slate-400 tabular-nums">{freeRot}°</span></div>
        <input type="range" min={-45} max={45} value={freeRot} onChange={e => setFreeRot(+e.target.value)} className="w-full accent-brand-500" />
      </label>
      <div className="flex gap-2 mt-2">
        <button className="btn-secondary flex-1 !py-1.5 text-xs disabled:opacity-40" disabled={!freeRot} onClick={applyFreeRotate}><Icon.Check size={14} /> Apply</button>
        <button className="btn-ghost !py-1.5 text-xs disabled:opacity-40" disabled={!freeRot} onClick={() => setFreeRot(0)}>Reset</button>
      </div>
      {tool === 'crop' && (
        <div className="mt-3 pt-3 border-t border-white/[0.06]">
          <p className="text-xs muted mb-2">Crop aspect</p>
          <div className="flex flex-wrap gap-1.5">
            {([['Free', null], ['1:1', 1], ['4:3', 4 / 3], ['16:9', 16 / 9]] as [string, number | null][]).map(([lbl, r]) => (
              <button key={lbl} onClick={() => setCropAspect(r)}
                className={cx('chip !py-1 text-xs', cropAspect === r && 'ring-1 ring-brand-400 text-white')}>{lbl}</button>
            ))}
          </div>
        </div>
      )}
    </div>
  );

  const ADJ_ROWS: [string, keyof Adjustments, number, number][] = [
    ['Brightness', 'brightness', 0, 200], ['Contrast', 'contrast', 0, 200], ['Saturation', 'saturation', 0, 200],
    ['Exposure', 'exposure', -100, 100], ['Temperature', 'temperature', -100, 100], ['Tint', 'tint', -100, 100],
    ['Hue', 'hue', -180, 180], ['Sharpen', 'sharpen', 0, 100], ['Blur', 'blur', 0, 20], ['Vignette', 'vignette', 0, 100],
  ];
  const AdjustPanel = (
    <div className="card p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="section-title">Adjustments</h3>
        <span className="text-[11px] text-slate-500">active layer</span>
      </div>
      <div className="max-h-[42vh] lg:max-h-none overflow-y-auto -mr-1 pr-1">
        {ADJ_ROWS.map(([label, key, min, max]) => (
          <label key={key} className="block mb-2.5">
            <div className="flex justify-between text-xs mb-1"><span className="muted">{label}</span><span className="text-slate-400 tabular-nums">{adj[key]}</span></div>
            <input type="range" min={min} max={max} value={adj[key]} onChange={e => setAdj({ ...adj, [key]: +e.target.value })} className="w-full accent-brand-500" />
          </label>
        ))}
      </div>
      <div className="flex gap-2 mt-1">
        <button className="btn-secondary flex-1 !py-1.5 text-xs disabled:opacity-40" disabled={!dirty} onClick={bakeAdjustments}><Icon.Check size={14} /> Apply</button>
        <button className="btn-ghost !py-1.5 text-xs disabled:opacity-40" disabled={!dirty} onClick={() => setAdj(ADJ0)}>Reset</button>
      </div>
    </div>
  );

  const PRESETS: [string, string, number][] = [
    ['B&W', 'grayscale(1) contrast(1.05)', 0],
    ['Sepia', 'sepia(0.75) contrast(1.05) brightness(1.02)', 0],
    ['Vivid', 'saturate(1.5) contrast(1.12)', 0],
    ['Cool', 'saturate(1.1) hue-rotate(-12deg) brightness(1.02)', 0],
    ['Warm', 'sepia(0.25) saturate(1.15) brightness(1.03)', 0],
    ['Film', 'contrast(0.92) saturate(0.85) sepia(0.2) brightness(1.03)', 0.35],
  ];
  const FiltersPanel = (
    <div className="card p-4">
      <h3 className="section-title mb-3">Filter presets</h3>
      <div className="grid grid-cols-3 gap-2">
        {PRESETS.map(([name, f, v]) => (
          <button key={name} onClick={() => applyPreset(name, f, v)}
            className="rounded-xl overflow-hidden bg-ink-800 border border-white/[0.06] hover:border-brand-400/40 transition-colors p-0">
            <div className="aspect-square grid place-items-center bg-gradient-to-br from-brand-500/20 to-accent-pink/10" style={{ filter: f }}>
              <Icon.Image size={20} className="text-slate-300" />
            </div>
            <p className="text-[11px] text-slate-300 py-1 text-center">{name}</p>
          </button>
        ))}
      </div>
    </div>
  );

  const AiPanel = (
    <div className="card p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="section-title flex items-center gap-1.5"><Icon.Sparkles size={15} className="text-accent-purple" /> AI Studio</h3>
        {aiAvailable === null ? <Spinner size={12} /> : aiAvailable ? <Badge color="green">Online</Badge> : <Badge color="slate">Offline</Badge>}
      </div>
      <div className={cx('space-y-3', !aiAvailable && 'opacity-50 pointer-events-none select-none')}>
        <div className="grid grid-cols-2 gap-2">
          <button onClick={() => setAiMode('inpaint')} className={cx('btn-secondary !py-1.5 text-xs justify-center', aiMode === 'inpaint' && 'ring-1 ring-brand-400 text-white')}>Inpaint</button>
          <button onClick={() => setAiMode('variation')} className={cx('btn-secondary !py-1.5 text-xs justify-center', aiMode === 'variation' && 'ring-1 ring-brand-400 text-white')}>Variation</button>
        </div>
        {aiMode === 'inpaint' && (
          <>
            <p className="text-xs muted leading-relaxed">Pick the <span className="text-accent-pink">AI Mask</span> tool, paint over an object, then describe the change.</p>
            <button onClick={() => { setTool('mask'); setSheet(null); }} className={cx('w-full btn-secondary !py-1.5 text-xs', tool === 'mask' && 'ring-1 ring-brand-400')}><Icon.Edit size={14} /> Paint mask</button>
          </>
        )}
        <div className="relative">
          <textarea value={prompt} onChange={e => setPrompt(e.target.value)} rows={2}
            placeholder={aiMode === 'inpaint' ? 'remove this object' : 'reimagine as an oil painting'}
            className="input !py-2 text-sm resize-none w-full pr-10" />
          <button onClick={talk} disabled={transcribing} title={listening ? 'Stop' : 'Dictate'}
            className={cx('absolute right-1.5 bottom-1.5 w-8 h-8 rounded-lg grid place-items-center transition-colors',
              listening ? 'bg-accent-red text-white animate-pulse' : 'text-slate-400 hover:text-white hover:bg-white/[0.08]')}>
            {transcribing ? <Spinner size={14} /> : <Icon.Volume size={16} />}
          </button>
        </div>
        {listening && <p className="text-[11px] text-accent-red text-center">Listening… tap the mic again to stop</p>}
        {transcribing && <p className="text-[11px] text-slate-500 text-center flex items-center justify-center gap-1.5"><Spinner size={11} /> Transcribing…</p>}
        {gpuBusy && <p className="text-[11px] text-accent-amber flex items-center gap-1.5"><Icon.Warning size={13} /> GPU is busy generating music — image edits may queue.</p>}
        <button onClick={runAi} disabled={aiBusy} className="btn-primary w-full !py-2 disabled:opacity-60">
          {aiBusy ? <><Spinner size={14} /> Generating…</> : <><Icon.Sparkles size={15} /> {aiMode === 'inpaint' ? 'Inpaint' : 'Generate variation'}</>}
        </button>
        {aiBusy && <p className="text-[11px] text-slate-500 text-center">Krea2 usually takes 15–30s…</p>}
        {aiResult && (
          <div className="animate-scale-in">
            <p className="text-xs muted mb-2">Result</p>
            <div className="rounded-xl overflow-hidden bg-ink-800 border border-white/10">
              <img src={api.url(aiResult.url)} className="w-full object-contain max-h-52" />
            </div>
            <div className="grid grid-cols-3 gap-2 mt-2">
              <button className="btn-primary !py-1.5 text-xs justify-center" onClick={applyAiAsLayer}><Icon.Check size={14} /> Apply</button>
              <button className="btn-secondary !py-1.5 text-xs justify-center" onClick={saveAiResult}><Icon.Cloud size={14} /> Save</button>
              <button className="btn-ghost !py-1.5 text-xs justify-center" onClick={() => setAiResult(null)}>Discard</button>
            </div>
          </div>
        )}
      </div>
      {aiAvailable === false && <p className="text-[11px] text-slate-500 mt-3 flex items-center gap-1.5"><Icon.Info size={13} /> Image engine offline — start it in AI Studio.</p>}
    </div>
  );

  // Settings panel for the active NON-paint tool (move / crop / eyedropper). Transform
  // lives in the Layers sheet, so the mobile "Tool" sheet stays specific to the tool.
  const activeToolLabel = tools.find(t => t.id === tool)?.label || 'Tool';
  const NonPaintToolPanel = (
    <div className="card p-4 space-y-3">
      <h3 className="section-title">{activeToolLabel}</h3>
      {tool === 'crop' ? (
        <>
          <p className="text-xs muted leading-relaxed">Drag on the canvas to select a region, then Apply.</p>
          <div>
            <p className="text-xs muted mb-2">Aspect ratio</p>
            <div className="flex flex-wrap gap-1.5">
              {([['Free', null], ['1:1', 1], ['4:3', 4 / 3], ['16:9', 16 / 9]] as [string, number | null][]).map(([lbl, r]) => (
                <button key={lbl} onClick={() => setCropAspect(r)}
                  className={cx('chip !py-1 text-xs', cropAspect === r && 'ring-1 ring-brand-400 text-white')}>{lbl}</button>
              ))}
            </div>
          </div>
          <button className="btn-primary w-full justify-center !py-2 text-sm" onClick={() => { applyCrop(); setSheet(null); }}><Icon.Check size={14} /> Apply crop</button>
        </>
      ) : tool === 'move' ? (
        <p className="text-xs muted leading-relaxed">Drag on the canvas to reposition the active layer. Rotate, flip and free-rotate live in the <span className="text-slate-300">Layers</span> tab.</p>
      ) : (
        <p className="text-xs muted leading-relaxed">Tap anywhere on the canvas to sample that color into your brush.</p>
      )}
    </div>
  );

  const fullPanel = (
    <>
      {LayersPanel}
      {paintTool && ToolSettings}
      {TransformPanel}
      {AdjustPanel}
      {FiltersPanel}
      {AiPanel}
    </>
  );

  const sheetTitle: Record<Exclude<Sheet, null>, string> = { layers: 'Layers', adjust: 'Adjustments', filters: 'Filters', ai: 'AI Studio', tool: 'Tool' };
  const sheetBody =
    sheet === 'layers' ? <>{LayersPanel}{TransformPanel}</> :
    sheet === 'adjust' ? AdjustPanel :
    sheet === 'filters' ? FiltersPanel :
    sheet === 'ai' ? AiPanel :
    sheet === 'tool' ? (paintTool ? ToolSettings : NonPaintToolPanel) : null;

  const historyControls = (
    <div className="glass rounded-xl flex items-center p-1 gap-1 shrink-0">
      <button className="icon-btn disabled:opacity-30" disabled={!canUndo} onClick={undo} title="Undo (⌘Z)"><Icon.Prev size={16} /></button>
      <button className="icon-btn disabled:opacity-30" disabled={!canRedo} onClick={redo} title="Redo (⌘⇧Z)"><Icon.Next size={16} /></button>
    </div>
  );
  const zoomControls = (
    <div className="glass rounded-xl flex items-center p-1 gap-1 shrink-0">
      <button className="icon-btn" onClick={() => setZoom(z => clamp(z - 0.15, 0.05, 6))} title="Zoom out"><Icon.ChevronDown size={16} /></button>
      <button className="text-xs text-slate-300 w-11 tabular-nums" onClick={() => fit()} title="Fit to screen">{Math.round(zoom * 100)}%</button>
      <button className="icon-btn" onClick={() => setZoom(z => clamp(z + 0.15, 0.05, 6))} title="Zoom in"><Icon.Plus size={16} /></button>
    </div>
  );

  return (
    <div ref={rootRef} className="animate-fade-in flex flex-col lg:h-[calc(100vh-7rem)] pb-24 lg:pb-0"
      style={mobileH != null ? { height: mobileH } : undefined}>
      {/* Top bar */}
      <div className="mb-3 sm:mb-4">
        <div className="flex items-center gap-2 sm:gap-3">
          <button className="icon-btn shrink-0" onClick={() => ((path || src) ? nav(-1) : setLoaded(false))} title="Close"><Icon.ChevronLeft size={18} /></button>
          <div className="min-w-0 flex-1">
            <h1 className="text-base sm:text-lg font-semibold text-white truncate leading-tight">{srcName}</h1>
            <p className="text-xs muted truncate">{dims.w} × {dims.h}px · {layersRef.current.length} layer{layersRef.current.length > 1 ? 's' : ''}</p>
          </div>
          {/* desktop keeps history + zoom inline */}
          <div className="hidden sm:flex items-center gap-2 sm:gap-3">
            {historyControls}
            {zoomControls}
          </div>
          <button className="btn-secondary shrink-0" onClick={exportDownload} title="Download PNG"><Icon.Download size={16} /><span className="hidden sm:inline"> Export</span></button>
          <button className="btn-primary shrink-0" onClick={openSave}><Icon.Cloud size={16} /><span className="hidden sm:inline"> Save copy</span></button>
        </div>
        {/* mobile second row so the filename gets full width above */}
        <div className="flex sm:hidden items-center gap-2 mt-2">
          {historyControls}
          <div className="flex-1" />
          {zoomControls}
        </div>
      </div>

      <div className="flex flex-col lg:flex-row gap-3 lg:gap-4 flex-1 min-h-0">
        {/* Tool dock */}
        <div className="glass-strong rounded-2xl p-1.5 sm:p-2 flex lg:flex-col gap-1 shrink-0 overflow-x-auto lg:overflow-visible order-2 lg:order-1">
          {tools.map(t => (
            <button key={t.id} onClick={() => { setTool(t.id); if (t.id !== 'crop') setCrop(null); if (t.id === 'mask') setAiMode('inpaint'); }}
              title={t.label}
              className={cx('w-11 h-11 rounded-xl grid place-items-center transition-colors shrink-0',
                tool === t.id ? 'bg-brand-500 text-white shadow-glow' : 'text-slate-400 hover:bg-white/[0.06] hover:text-white')}>
              {t.icon}
            </button>
          ))}
        </div>

        {/* Canvas stage */}
        <div ref={stageRef}
          className="flex-1 rounded-2xl relative overflow-hidden grid place-items-center min-h-[260px] lg:min-h-0 order-1 lg:order-2 touch-none"
          style={{ background: 'repeating-conic-gradient(#1a1a24 0% 25%, #12121a 0% 50%) 50% / 22px 22px' }}>
          {loading && <div className="absolute inset-0 grid place-items-center bg-ink-950/40 z-20"><Spinner size={28} /></div>}

          <div className="relative shadow-float" style={{ width: displayW, height: displayH, transform: `translate(${pan.x}px, ${pan.y}px)` }}>
            <canvas ref={viewRef}
              onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp} onPointerLeave={onUp}
              onMouseDown={e => { if (tool === 'text') e.preventDefault(); }}
              className={cx('block touch-none select-none', cursorClass)}
              style={{ width: displayW, height: displayH }} />
            <canvas ref={maskRef} className="absolute inset-0 pointer-events-none" style={{ width: displayW, height: displayH, opacity: 0.5 }} />
            <canvas ref={overlayRef} className="absolute inset-0 pointer-events-none" style={{ width: displayW, height: displayH }} />
            {/* live preview overlays for temperature/tint/vignette */}
            {dirty && (adj.temperature !== 0) && (
              <div className="absolute inset-0 pointer-events-none" style={{ mixBlendMode: 'overlay', background: adj.temperature > 0 ? `rgba(255,150,40,${adj.temperature / 100 * 0.5})` : `rgba(60,150,255,${-adj.temperature / 100 * 0.5})` }} />
            )}
            {dirty && (adj.tint !== 0) && (
              <div className="absolute inset-0 pointer-events-none" style={{ mixBlendMode: 'overlay', background: adj.tint > 0 ? `rgba(236,72,153,${adj.tint / 100 * 0.4})` : `rgba(16,185,129,${-adj.tint / 100 * 0.4})` }} />
            )}
            {dirty && adj.vignette > 0 && (
              <div className="absolute inset-0 pointer-events-none" style={{ background: `radial-gradient(ellipse at center, transparent 42%, rgba(0,0,0,${adj.vignette / 100 * 0.85}) 100%)` }} />
            )}
            {crop && crop.w > 0 && (
              <div className="absolute border-2 border-brand-400 bg-brand-400/10 pointer-events-none"
                style={{ left: crop.x * zoom, top: crop.y * zoom, width: crop.w * zoom, height: crop.h * zoom }}>
                <span className="absolute -top-6 left-0 text-[11px] bg-brand-500 text-white px-1.5 py-0.5 rounded">{Math.round(crop.w)}×{Math.round(crop.h)}</span>
              </div>
            )}
            {textBox && (
              <input autoFocus value={textBox.value}
                onChange={e => setTextBox({ ...textBox, value: e.target.value })}
                onBlur={commitText}
                onPointerDown={e => e.stopPropagation()}
                onKeyDown={e => { e.stopPropagation(); if (e.key === 'Enter') commitText(); if (e.key === 'Escape') setTextBox(null); }}
                placeholder="Type…"
                className="absolute bg-transparent outline-none border border-dashed border-white/40 px-1"
                style={{ left: textBox.x * zoom, top: textBox.y * zoom, color: brushColor, fontSize: fontSize * zoom, fontWeight: 600, minWidth: 80 }} />
            )}
          </div>

          {/* contextual hints */}
          {tool === 'crop' && (
            <div className="absolute bottom-3 left-1/2 -translate-x-1/2 glass-strong rounded-xl px-3 py-2 flex items-center gap-2 sm:gap-3 z-10 max-w-[calc(100%-1.5rem)] flex-wrap justify-center">
              <span className="text-xs text-slate-300">Drag to select {cropAspect ? '(fixed ratio)' : ''}</span>
              <button className="btn-primary !py-1 !px-3 text-xs" onClick={applyCrop}>Apply crop</button>
              {crop && <button className="btn-ghost !py-1 !px-2 text-xs" onClick={() => setCrop(null)}>Clear</button>}
            </div>
          )}
          {tool === 'mask' && (
            <div className="absolute bottom-3 left-1/2 -translate-x-1/2 z-10 w-[min(94%,600px)]">
              {aiResult ? (
                <div className="glass-strong rounded-2xl p-3 shadow-float animate-scale-in flex items-center gap-3">
                  <img src={api.url(aiResult.url)} className="w-14 h-14 rounded-lg object-cover shrink-0 bg-ink-800" />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm text-white font-medium">Result ready</p>
                    <p className="text-xs muted truncate">Apply it to your image, or discard and retry.</p>
                  </div>
                  <button className="btn-primary !py-1.5 !px-3 text-sm shrink-0" onClick={applyAiAsLayer}><Icon.Check size={14} /> Apply</button>
                  <button className="btn-ghost !py-1.5 !px-2 text-sm shrink-0" onClick={() => setAiResult(null)}>Discard</button>
                </div>
              ) : (
                <div className="glass-strong rounded-2xl px-3 py-2.5 shadow-float">
                  <div className="flex items-center gap-2 mb-2">
                    <Icon.Sparkles size={14} className="text-accent-purple shrink-0" />
                    <span className="text-xs text-slate-300 font-medium truncate">Paint over an area, then describe what should appear there</span>
                    <div className="ml-auto flex items-center gap-1.5 shrink-0">
                      <input type="range" min={8} max={140} value={brushSize} onChange={e => setBrushSize(+e.target.value)} className="cb-range w-14 sm:w-20" title="Brush size" />
                      <button className="btn-ghost !py-1 !px-2 text-xs" onClick={() => { clearMask(); bump(); }}>Clear</button>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <input value={prompt} onChange={e => setPrompt(e.target.value)}
                      placeholder="e.g. a field of red roses  ·  or “remove this”"
                      onKeyDown={e => { if (e.key === 'Enter' && !aiBusy) runAi('inpaint'); }}
                      className="input !py-2 text-sm flex-1" />
                    <button onClick={() => runAi('inpaint')} disabled={aiBusy || aiAvailable === false} className="btn-primary !py-2 !px-4 text-sm shrink-0">
                      {aiBusy ? <><Spinner size={14} /> <span className="hidden sm:inline">Generating…</span></> : <><Icon.Sparkles size={14} /> Inpaint</>}
                    </button>
                  </div>
                  {aiAvailable === false && <p className="text-[10px] text-accent-amber mt-1.5">Image engine offline — start it in AI Image Studio.</p>}
                  {aiBusy && <p className="text-[10px] text-slate-400 mt-1.5 text-center">Krea2 usually takes 15–30s…</p>}
                </div>
              )}
            </div>
          )}
          <p className="absolute top-2.5 right-3 text-[11px] text-slate-500 hidden sm:block pointer-events-none">two fingers to pan &amp; pinch-zoom</p>
        </div>

        {/* Desktop right rail */}
        <div className="hidden lg:block lg:w-72 shrink-0 lg:overflow-y-auto space-y-4 lg:pr-0.5 order-3">
          {fullPanel}
        </div>
      </div>

      {/* Mobile bottom bar */}
      <div className="lg:hidden fixed bottom-0 inset-x-0 z-30 glass-strong border-t border-white/[0.06] px-2 py-2 flex items-center gap-1 justify-around" style={{ paddingBottom: 'calc(env(safe-area-inset-bottom) + 0.5rem)' }}>
        {([['tool', 'Tool', <Icon.Settings size={18} />], ['layers', 'Layers', <Icon.Copy size={18} />], ['adjust', 'Adjust', <Icon.Bolt size={18} />], ['filters', 'Filters', <Icon.Filter size={18} />], ['ai', 'AI', <Icon.Sparkles size={18} />]] as [Sheet, string, React.ReactNode][]).map(([id, label, ic]) => (
          <button key={label} onClick={() => setSheet(id)} className="flex flex-col items-center gap-0.5 text-slate-400 hover:text-white px-2 py-1">
            <span className={cx('grid place-items-center w-9 h-9 rounded-xl', id === 'ai' && 'text-accent-purple')}>{ic}</span>
            <span className="text-[10px]">{label}</span>
          </button>
        ))}
      </div>

      {/* Mobile bottom sheet */}
      {sheet && (
        <div className="lg:hidden fixed inset-0 z-40 flex items-end" onClick={() => setSheet(null)}>
          <div className="absolute inset-0 bg-ink-950/60 backdrop-blur-sm animate-fade-in" />
          <div className="relative w-full glass-strong rounded-t-2xl border-t border-white/10 max-h-[80vh] overflow-y-auto animate-scale-in p-4 pb-8" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-3 sticky -top-4 -mx-4 px-4 pt-4 -mt-4 pb-2 bg-ink-900/80 backdrop-blur">
              <h3 className="text-white font-semibold">{sheet && sheetTitle[sheet]}</h3>
              <button className="icon-btn" onClick={() => setSheet(null)}><Icon.Close size={18} /></button>
            </div>
            <div className="space-y-4">{sheetBody}</div>
          </div>
        </div>
      )}

      {/* Save modal */}
      <Modal open={saveOpen} onClose={() => setSaveOpen(false)} title="Save as copy" size="sm"
        footer={<>
          <button className="btn-ghost" onClick={() => setSaveOpen(false)}>Cancel</button>
          <button className="btn-primary" onClick={doSave} disabled={saving}>{saving ? <><Spinner size={14} /> Saving…</> : <><Icon.Cloud size={16} /> Save</>}</button>
        </>}>
        <div className="space-y-4">
          <label className="block">
            <span className="text-xs muted">File name</span>
            <div className="flex items-center gap-2 mt-1">
              <input className="input flex-1" value={saveName} onChange={e => setSaveName(e.target.value)} placeholder="my-image-edited" />
              <span className="text-sm text-slate-500">.png</span>
            </div>
          </label>
          <label className="block">
            <span className="text-xs muted">Destination folder</span>
            <input className="input mt-1" value={saveDir} onChange={e => setSaveDir(e.target.value)} placeholder="/Edited" />
          </label>
          <p className="text-xs text-slate-500 flex items-center gap-1.5"><Icon.Info size={13} /> Flattens all layers to a PNG at {dims.w}×{dims.h}. The folder is created if it doesn't exist.</p>
        </div>
      </Modal>
    </div>
  );
}

// Small layer thumbnail that samples the layer canvas
function LayerThumb({ layer }: { layer: Layer }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current; if (!c) return;
    const g = c.getContext('2d')!;
    g.clearRect(0, 0, c.width, c.height);
    try { g.drawImage(layer.canvas, 0, 0, c.width, c.height); } catch { /* */ }
  });
  return <canvas ref={ref} width={36} height={36} className="w-full h-full object-contain" style={{ opacity: layer.visible ? 1 : 0.3 }} />;
}
