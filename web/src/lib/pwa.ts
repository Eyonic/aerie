// Captures the PWA install prompt so a button can trigger it on demand.
let deferred: any = null;
const listeners = new Set<() => void>();

window.addEventListener('beforeinstallprompt', (e: any) => {
  e.preventDefault();
  deferred = e;
  listeners.forEach((l) => l());
});
window.addEventListener('appinstalled', () => {
  deferred = null;
  listeners.forEach((l) => l());
});

export const pwa = {
  canInstall: () => !!deferred,
  isStandalone: () =>
    window.matchMedia('(display-mode: standalone)').matches ||
    (window.navigator as any).standalone === true,
  onChange: (fn: () => void) => {
    listeners.add(fn);
    return () => { listeners.delete(fn); };
  },
  install: async (): Promise<boolean> => {
    if (!deferred) return false;
    deferred.prompt();
    const { outcome } = await deferred.userChoice;
    deferred = null;
    listeners.forEach((l) => l());
    return outcome === 'accepted';
  },
};
