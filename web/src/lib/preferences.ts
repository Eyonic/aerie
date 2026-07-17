export interface AppearancePrefs {
  reduceMotion: boolean;
  compact: boolean;
  highContrast: boolean;
  largeText: boolean;
  language: 'en' | 'nl';
}

export const DEFAULT_APPEARANCE: AppearancePrefs = { reduceMotion: false, compact: false, highContrast: false, largeText: false, language: 'en' };
export const PREFS_LS_KEY = 'cloudbox:prefs'; // legacy key: installed clients already use it

export function applyAppearance(p: Partial<AppearancePrefs>) {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  root.classList.toggle('cb-reduce-motion', !!p.reduceMotion);
  root.classList.toggle('cb-compact', !!p.compact);
  root.classList.toggle('cb-high-contrast', !!p.highContrast);
  root.classList.toggle('cb-large-text', !!p.largeText);
  const lang = p.language === 'nl' ? 'nl' : 'en';
  if (root.lang !== lang) { root.lang = lang; window.dispatchEvent(new CustomEvent('aerie-language', { detail: lang })); }
}

export function cacheAppearance(p: AppearancePrefs) {
  try { localStorage.setItem(PREFS_LS_KEY, JSON.stringify(p)); } catch { /* private mode */ }
}

export function cachedAppearance(): AppearancePrefs {
  try { return { ...DEFAULT_APPEARANCE, ...JSON.parse(localStorage.getItem(PREFS_LS_KEY) || '{}') }; } catch { return DEFAULT_APPEARANCE; }
}

export function bootAppearance() { const p = cachedAppearance(); applyAppearance(p); return p; }
