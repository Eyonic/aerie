// Shared UI primitives used across every page. Keeps the look consistent.
import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from '../lib/icons';
import { cx } from '../lib/utils';
import { useToasts } from '../lib/store';

export function Spinner({ size = 20, className = '' }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className={cx('animate-spin', className)} fill="none">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.2" strokeWidth="2.5" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
    </svg>
  );
}

export function PageLoader() {
  return <div className="grid place-items-center h-full min-h-[50vh] text-brand-400"><Spinner size={34} /></div>;
}

export function EmptyState({ icon, title, subtitle, action }: { icon?: React.ReactNode; title: string; subtitle?: string; action?: React.ReactNode }) {
  return (
    <div className="grid place-items-center text-center py-20 px-6 animate-fade-in">
      <div className="w-16 h-16 rounded-2xl bg-white/[0.04] border border-white/[0.06] grid place-items-center text-slate-500 mb-4">
        {icon || <Icon.Cloud size={30} />}
      </div>
      <h3 className="text-white font-semibold text-lg">{title}</h3>
      {subtitle && <p className="muted text-sm max-w-sm mt-1">{subtitle}</p>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

export function PageHeader({ title, subtitle, icon, actions }: { title: string; subtitle?: string; icon?: React.ReactNode; actions?: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 mb-6 flex-wrap">
      <div className="flex items-center gap-3.5">
        {icon && <div className="w-11 h-11 rounded-2xl bg-gradient-to-br from-brand-500/25 to-brand-600/5 border border-brand-500/20 grid place-items-center text-brand-300">{icon}</div>}
        <div>
          <h1 className="text-2xl font-bold text-white tracking-tight">{title}</h1>
          {subtitle && <p className="muted text-sm mt-0.5">{subtitle}</p>}
        </div>
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  );
}

export function Modal({ open, onClose, title, children, footer, size = 'md' }:
  { open: boolean; onClose: () => void; title?: string; children: React.ReactNode; footer?: React.ReactNode; size?: 'sm' | 'md' | 'lg' | 'xl' }) {
  useEffect(() => {
    if (!open) return;
    const h = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [open, onClose]);
  if (!open) return null;
  const w = { sm: 'max-w-sm', md: 'max-w-lg', lg: 'max-w-2xl', xl: 'max-w-4xl' }[size];
  // Portal to <body> so the modal is positioned relative to the viewport, not a
  // page ancestor with a CSS transform (animate-fade-in) — that was shifting/clipping
  // modals off-center. max-h + inner scroll keeps tall modals inside the screen.
  return createPortal(
    <div className="fixed inset-0 z-[200] grid place-items-center p-4 bg-black/60 backdrop-blur-sm animate-fade-in" onClick={onClose}>
      <div className={cx('glass-strong rounded-2xl shadow-float w-full max-h-[92vh] flex flex-col animate-scale-in', w)} onClick={e => e.stopPropagation()}>
        {title && (
          <div className="flex items-center justify-between px-5 py-4 border-b border-white/[0.06] shrink-0">
            <h2 className="font-semibold text-white">{title}</h2>
            <button className="icon-btn" onClick={onClose}><Icon.Close size={18} /></button>
          </div>
        )}
        <div className="p-5 overflow-y-auto">{children}</div>
        {footer && <div className="flex justify-end gap-2 px-5 py-4 border-t border-white/[0.06] shrink-0">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

// Lightweight right-click / kebab menu
export function Menu({ trigger, items }: { trigger: React.ReactNode; items: { label: string; icon?: React.ReactNode; onClick: () => void; danger?: boolean; divider?: boolean }[] }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, []);
  return (
    <div className="relative" ref={ref}>
      <div onClick={(e) => { e.stopPropagation(); setOpen(o => !o); }}>{trigger}</div>
      {open && (
        <div className="absolute right-0 top-full mt-1 z-50 min-w-[190px] glass-strong rounded-xl shadow-float py-1.5 animate-scale-in origin-top-right">
          {items.map((it, i) => (it.divider && !it.label) ? <div key={i} className="my-1 border-t border-white/[0.06]" /> : (
            <button key={i} onClick={(e) => { e.stopPropagation(); setOpen(false); it.onClick(); }}
              className={cx('w-full flex items-center gap-2.5 px-3.5 py-2 text-sm text-left transition-colors hover:bg-white/[0.06]',
                it.divider && 'border-t border-white/[0.06] mt-1 pt-2.5',
                it.danger ? 'text-accent-red hover:bg-accent-red/10' : 'text-slate-300 hover:text-white')}>
              {it.icon && <span className="text-current opacity-80">{it.icon}</span>}{it.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function ProgressBar({ value, className = '', color = 'bg-brand-500' }: { value: number; className?: string; color?: string }) {
  return (
    <div className={cx('h-1.5 rounded-full bg-white/[0.08] overflow-hidden', className)}>
      <div className={cx('h-full rounded-full transition-all', color)} style={{ width: `${Math.max(0, Math.min(100, value))}%` }} />
    </div>
  );
}

export function Badge({ children, color = 'brand' }: { children: React.ReactNode; color?: 'brand' | 'green' | 'red' | 'amber' | 'cyan' | 'slate' }) {
  const map: Record<string, string> = {
    brand: 'bg-brand-500/15 text-brand-300 border-brand-500/20',
    green: 'bg-accent-green/15 text-accent-green border-accent-green/20',
    red: 'bg-accent-red/15 text-accent-red border-accent-red/20',
    amber: 'bg-accent-amber/15 text-accent-amber border-accent-amber/20',
    cyan: 'bg-accent-cyan/15 text-accent-cyan border-accent-cyan/20',
    slate: 'bg-white/[0.06] text-slate-300 border-white/[0.08]',
  };
  return <span className={cx('inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium border', map[color])}>{children}</span>;
}

export function Toaster() {
  const { toasts, dismiss } = useToasts();
  const iconFor = (l: string) => l === 'success' ? <Icon.Check size={18} /> : l === 'error' ? <Icon.Warning size={18} /> : l === 'warning' ? <Icon.Warning size={18} /> : <Icon.Info size={18} />;
  const colorFor = (l: string) => l === 'success' ? 'text-accent-green' : l === 'error' ? 'text-accent-red' : l === 'warning' ? 'text-accent-amber' : 'text-brand-300';
  return (
    <div className="fixed bottom-4 right-4 z-[200] flex flex-col gap-2 w-80 max-w-[calc(100vw-2rem)]">
      {toasts.map(t => (
        <div key={t.id} className="glass-strong rounded-xl shadow-float p-3.5 flex gap-3 animate-scale-in cursor-pointer" onClick={() => dismiss(t.id)}>
          <div className={cx('mt-0.5', colorFor(t.level))}>{iconFor(t.level)}</div>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-white">{t.title}</p>
            {t.body && <p className="text-xs muted mt-0.5">{t.body}</p>}
          </div>
        </div>
      ))}
    </div>
  );
}

// Simple confirm dialog hook usage: <ConfirmModal .../>
export function ConfirmModal({ open, onClose, onConfirm, title, message, confirmLabel = 'Confirm', danger }:
  { open: boolean; onClose: () => void; onConfirm: () => void; title: string; message?: string; confirmLabel?: string; danger?: boolean }) {
  return (
    <Modal open={open} onClose={onClose} title={title} size="sm"
      footer={<>
        <button className="btn-secondary" onClick={onClose}>Cancel</button>
        <button className={danger ? 'btn-danger' : 'btn-primary'} onClick={() => { onConfirm(); onClose(); }}>{confirmLabel}</button>
      </>}>
      <p className="text-sm muted">{message}</p>
    </Modal>
  );
}
