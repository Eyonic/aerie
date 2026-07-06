import React, { useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import './styles/index.css';
import App from './App';
import { useAuth } from './lib/store';
import { absorbHandoff, installHandoffProvider, syncSessionCookie } from './lib/handoff';

// Cross-origin handoff (native app network failover) — must run before the
// auth init reads the token.
const hopped = absorbHandoff();
installHandoffProvider();

function Root() {
  const init = useAuth(s => s.init);
  useEffect(() => { init(); }, [init]);
  return <App />;
}

async function boot() {
  // A hop delivered the token via #cbho= but this origin has no session cookie
  // yet — set it before first paint so cookie-authed <img> requests don't 401.
  if (hopped) await syncSessionCookie();
  try { (window as any).aerieSync?.setAuth?.(localStorage.getItem('cb_token') || ''); } catch { /* not in desktop */ }
  createRoot(document.getElementById('root')!).render(<Root />);
}
void boot();

// Register the service worker for installable PWA + offline shell.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  });
}
