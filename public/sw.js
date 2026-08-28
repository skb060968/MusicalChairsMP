/* Musical Chairs PWA Service Worker */

const CACHE_VERSION = 'v1.25.0';
const CACHE_NAME = `musical-chairs-${CACHE_VERSION}`;

const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/favicon.ico',
  '/images/chair.png',
  '/sounds/tap.mp3',
  '/sounds/eliminate.mp3',
  '/sounds/victory.mp3',
];

const EXCLUDED_PATHS = ['/sounds/music.mp3'];

function isCacheable(request, response) {
  if (!response || !response.ok) return false;
  try {
    return new URL(request.url).origin === self.location.origin;
  } catch (_) {
    return false;
  }
}

async function cacheSuccessful(cache, request) {
  try {
    const response = await fetch(request);
    if (isCacheable(request, response)) await cache.put(request, response.clone());
    return response;
  } catch (_) {
    return null;
  }
}

self.addEventListener('install', (event) => {
  // Do not call skipWaiting here. An update remains installed and waiting until
  // the player explicitly chooses Update app in the client prompt.
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      Promise.all(STATIC_ASSETS.map((path) =>
        cacheSuccessful(cache, new Request(path, { cache: 'reload' })),
      )),
    ),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.map((key) => (
        key === CACHE_NAME ? undefined : caches.delete(key)
      ))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;
  if (EXCLUDED_PATHS.includes(url.pathname)) return;
  // Never intercept/cache API calls (e.g. the LiveKit token endpoint).
  if (url.pathname.startsWith('/api/')) return;

  const isNavigation = request.mode === 'navigate';
  const networkFirst = isNavigation
    || url.pathname.endsWith('.js')
    || url.pathname.endsWith('.css')
    || url.pathname.startsWith('/assets/');

  if (networkFirst) {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE_NAME);
      const response = await cacheSuccessful(cache, request);
      if (response) return response;
      const cached = await caches.match(request);
      if (cached) return cached;
      if (isNavigation) {
        const shell = await caches.match('/index.html');
        if (shell) return shell;
      }
      return Response.error();
    })());
    return;
  }

  event.respondWith((async () => {
    const cached = await caches.match(request);
    if (cached) return cached;
    const cache = await caches.open(CACHE_NAME);
    const response = await cacheSuccessful(cache, request);
    return response || Response.error();
  })());
});

self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
});