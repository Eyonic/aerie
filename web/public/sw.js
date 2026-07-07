// Aerie service worker — offline app shell + smart caching.
// Network-first for navigation/API (fresh data), cache-first for static assets.
const CACHE = 'aerie-v1';                 // renamed from cloudbox-v2: forces one clean shell refresh
const MEDIA = 'cloudbox-media';           // downloaded offline media — NEVER purge here.
                                          // Legacy cache name — keep: renaming it would orphan
                                          // (and on activate, delete) users' existing downloads.
const KEEP = [CACHE, MEDIA];
const SHELL = ['/', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => !KEEP.includes(k)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;

  // Offline media: if this stream/file was downloaded (cached by path, token
  // stripped), serve it from disk so it plays with no connection. Falls through
  // to the network when not downloaded.
  if (/^\/api\/(books|media)\/(stream|file)\//.test(url.pathname)) {
    e.respondWith(
      caches.open('cloudbox-media')
        .then((c) => c.match(url.origin + url.pathname))
        .then((hit) => hit || fetch(e.request))
        .catch(() => fetch(e.request))
    );
    return;
  }

  // Never cache API, streams, downloads, map tiles, or auth — always go to network.
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/downloads/') || url.pathname.startsWith('/tiles/')) return;

  // App navigations: network-first, fall back to cached shell (offline).
  if (e.request.mode === 'navigate') {
    e.respondWith(
      fetch(e.request).catch(() => caches.match('/'))
    );
    return;
  }

  // Static assets (JS/CSS/img/fonts): cache-first, update in background.
  if (/\.(js|css|png|jpg|jpeg|webp|svg|woff2?|ico)$/.test(url.pathname)) {
    e.respondWith(
      caches.match(e.request).then((cached) => {
        const network = fetch(e.request).then((res) => {
          if (res.ok) caches.open(CACHE).then((c) => c.put(e.request, res.clone()));
          return res;
        }).catch(() => cached);
        return cached || network;
      })
    );
  }
});
