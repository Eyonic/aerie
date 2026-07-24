// Aerie service worker — offline app shell plus account-bound media caches.
// Protected cached media is deny-by-default: a controlled page must bind its
// client id to an authenticated account before the worker will read that cache.
const SHELL_CACHE = 'aerie-v2';
const MEDIA_PREFIX = 'aerie-media-v2-';
const LEGACY_MEDIA = 'cloudbox-media';
const SHELL = ['/', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png'];
const MEDIA_PATH = /^\/api\/(books|media)\/(stream|file|offline)\//;
const clientAccounts = new Map();

function normalizeOrigin(value) {
  try {
    const url = new URL(value);
    return (url.protocol === 'https:' || url.protocol === 'http:') ? url.origin : null;
  } catch { return null; }
}

function hex(value) {
  return Array.from(new TextEncoder().encode(value), byte => byte.toString(16).padStart(2, '0')).join('');
}

function accountScope(accountId, serverOrigin) {
  const id = Number(accountId);
  const origin = normalizeOrigin(serverOrigin);
  if (!Number.isSafeInteger(id) || id < 1 || origin !== self.location.origin) return null;
  const key = `${origin}#${id}`;
  return { key, cacheName: `${MEDIA_PREFIX}${hex(origin)}-u${id}` };
}

function tokenFreeCacheKey(input) {
  const url = new URL(input, self.location.origin);
  url.hash = '';
  url.searchParams.delete('token');
  url.searchParams.delete('access_token');
  url.searchParams.sort();
  return url.toString();
}

self.addEventListener('install', event => {
  event.waitUntil(caches.open(SHELL_CACHE).then(cache => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.map(name => {
        if (name === SHELL_CACHE || name.startsWith(MEDIA_PREFIX)) return Promise.resolve(false);
        return caches.delete(name);
      })))
      // Explicit for clarity: ownerless legacy downloads are never reassigned.
      .then(() => caches.delete(LEGACY_MEDIA))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('message', event => {
  const message = event.data;
  const sourceId = event.source && event.source.id;
  if (!message || typeof message !== 'object' || !sourceId) return;

  if (message.type === 'AERIE_OFFLINE_ACTIVATE') {
    const scope = accountScope(message.accountId, message.serverOrigin);
    if (scope) clientAccounts.set(sourceId, scope);
    else clientAccounts.delete(sourceId);
    return;
  }

  if (message.type === 'AERIE_OFFLINE_LOCK') {
    const scope = accountScope(message.accountId, message.serverOrigin);
    if (message.allClients && scope) {
      for (const [clientId, bound] of clientAccounts) {
        if (bound.key === scope.key) clientAccounts.delete(clientId);
      }
    } else {
      clientAccounts.delete(sourceId);
    }
  }
});

async function rangedResponse(hit, request) {
  const range = request.headers.get('range');
  if (!range) return hit;
  const blob = await hit.blob();
  const match = /^bytes=(\d+)-(\d*)$/.exec(range.trim());
  if (!match) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${blob.size}` } });
  const start = Number(match[1]);
  const end = match[2] ? Math.min(blob.size - 1, Number(match[2])) : blob.size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= blob.size || end < start) {
    return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${blob.size}` } });
  }
  const part = blob.slice(start, end + 1, blob.type);
  return new Response(part, {
    status: 206,
    headers: {
      'Content-Type': blob.type || hit.headers.get('Content-Type') || 'application/octet-stream',
      'Content-Length': String(part.size),
      'Content-Range': `bytes ${start}-${end}/${blob.size}`,
      'Accept-Ranges': 'bytes',
    },
  });
}

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET') return;

  if (url.origin === self.location.origin && MEDIA_PATH.test(url.pathname)) {
    event.respondWith((async () => {
      const scope = event.clientId ? clientAccounts.get(event.clientId) : null;
      if (scope) {
        try {
          const cache = await caches.open(scope.cacheName);
          const cacheKey = tokenFreeCacheKey(event.request.url);
          const hit = await cache.match(cacheKey);
          if (hit) {
            if (hit.headers.get('X-Aerie-Offline-Scope') === scope.key) {
              return await rangedResponse(hit, event.request);
            }
            await cache.delete(cacheKey);
          }
        } catch { /* corrupt/unavailable caches fall through to one network try */ }
      }
      return fetch(event.request);
    })());
    return;
  }

  // API, installer, map and authentication responses are never shell-cached.
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/downloads/') || url.pathname.startsWith('/tiles/')) return;

  if (event.request.mode === 'navigate') {
    event.respondWith(fetch(event.request).catch(() => caches.match('/')));
    return;
  }

  // Vite asset filenames are content-hashed. Return a cached copy immediately
  // and refresh it in the background for non-hashed public images/icons.
  if (/\.(js|css|png|jpg|jpeg|webp|svg|woff2?|ico)$/.test(url.pathname)) {
    const network = fetch(event.request);
    const update = network.then(response => response.ok
      ? caches.open(SHELL_CACHE).then(cache => cache.put(event.request, response.clone()))
      : undefined);
    event.waitUntil(update.catch(() => undefined));
    event.respondWith(caches.match(event.request).then(cached => cached || network));
  }
});
