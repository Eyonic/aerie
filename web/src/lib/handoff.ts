// Network-handoff between the two Aerie origins (https://your-domain and
// the LAN address). The Android app switches origins when the current one stops
// answering — home WiFi may not reach the public domain (hairpin NAT) and mobile
// data can't reach the LAN IP. localStorage is per-origin, so the app carries the auth
// token + live playback state across in a #cbho= URL hash; the JWT itself is
// origin-independent (same backend signs both).
import { getToken, setToken } from './api';
import { usePlayer } from './store';

export interface HandoffState {
  token: string | null;
  path: string;
  player?: { queue: any[]; index: number; position: number; playing: boolean } | null;
  video?: { itemId: string; position: number; paused: boolean } | null;
}

let pending: HandoffState | null = null;

/** Called from main.tsx BEFORE React renders: absorb #cbho=… into token + memory.
 *  Returns true when a token arrived via the hash (i.e. we landed here through a
 *  native-app origin hop or cold start) so boot can re-establish the cookie. */
export function absorbHandoff(): boolean {
  // The native app is the only legitimate producer of #cbho= (its bridge is
  // injected on the WebView). Ignoring it in a plain browser blocks a crafted
  // link from fixating someone else's session token.
  if (!(window as any).CloudBoxNative) return false;
  const m = /[#&]cbho=([A-Za-z0-9\-_]+)/.exec(location.hash || '');
  if (!m) return false;
  try {
    const bin = atob(m[1].replace(/-/g, '+').replace(/_/g, '/'));
    // The payload is UTF-8 (Java encoded it as such) — bare atob is Latin-1 and
    // would mojibake accented track titles.
    const json = new TextDecoder().decode(Uint8Array.from(bin, c => c.charCodeAt(0)));
    const st = JSON.parse(json) as HandoffState;
    if (st.token) setToken(st.token);
    pending = st;
    history.replaceState(null, '', st.path && st.path.startsWith('/') ? st.path : location.pathname);
    return !!st.token;
  } catch { return false; /* malformed hash — boot normally */ }
}

/** The cb_token cookie is per-origin, so after a hop this origin has none — and
 *  plain <img>/<a> requests (posters, downloads) authenticate by cookie, not by
 *  the Authorization header. Re-establish it before first render; bounded so a
 *  dead network can't block boot (tokenized URLs still work without it). */
export async function syncSessionCookie(timeoutMs = 2500): Promise<void> {
  const t = getToken();
  if (!t) return;
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    await fetch('/api/auth/cookie', { method: 'POST', headers: { Authorization: `Bearer ${t}` }, signal: ctl.signal });
    clearTimeout(timer);
  } catch { /* cookie heals on next login; images fall back to ?token= URLs */ }
}

export function takePendingHandoff(): HandoffState | null {
  const p = pending;
  pending = null;
  // Only valid for the session it arrived with — if auth failed and the user
  // logged in as someone else, its stale ?token= URLs are dead; drop it.
  return p && p.token === getToken() ? p : null;
}

/** The native app calls window.__cbHandoff() right before hopping origins;
 *  evaluateJavascript JSON-encodes the returned object. */
export function installHandoffProvider() {
  (window as any).__cbHandoff = (): HandoffState => {
    const p = usePlayer.getState();
    const video = (window as any).__cbVideo as { itemId: string; pos: number; paused?: boolean } | null;
    let player: HandoffState['player'] = null;
    if (p.current) {
      // Cap the carried queue so the URL stays a sane size for huge playlists.
      const from = Math.max(0, p.index - 10);
      const queue = p.queue.slice(from, from + 120);
      player = { queue, index: p.index - from, position: p.currentTime || 0, playing: p.playing };
    }
    return {
      token: getToken(),
      path: location.pathname + location.search,
      player,
      video: video && video.itemId ? { itemId: video.itemId, position: video.pos || 0, paused: !!video.paused } : null,
    };
  };
}
