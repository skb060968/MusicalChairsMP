/* Musical Chairs service worker — deliberate updates, safe fallbacks.
 * BUMP CACHE_NAME on every deploy so clients get the update prompt. */
const CACHE_NAME = 'chairs-mp-v1';
const STATIC_ASSETS = [
  '/', '/index.html', '/manifest.json',
  '/icons/icon-192.png', '/icons/icon-512.png', '/icons/favicon.ico',
  '/images/chair.png',
  '/sounds/tap.mp3', '/sounds/eliminate.mp3', '/sounds/victory.mp3',
];
// The music track is ~1 MB and streams fine; keep it out of the precache.
const EXCLUDED_PATHS = ['/sounds/music.mp3'];
self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) =>
    Promise.allSettled(STATIC_ASSETS.map((asset) => cache.add(asset)))
  ));
});
self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(
    keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
  )).then(() => self.clients.claim()));
});
async function cacheSuccessful(request, response) {
  if (response && response.ok && response.type === 'basic') {
    const cache = await caches.open(CACHE_NAME);
    await cache.put(request, response.clone());
  }
  return response;
}
async function networkFirst(request, navigation) {
  try {
    return await cacheSuccessful(request, await fetch(request));
  } catch (_) {
    const cached = await caches.match(request);
    if (cached) return cached;
    if (navigation) return caches.match('/index.html');
    return Response.error();
  }
}
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return;
  if (EXCLUDED_PATHS.includes(url.pathname)) return;
  const navigation = event.request.mode === 'navigate';
  const dynamicAsset = navigation || url.pathname.endsWith('.js') ||
    url.pathname.endsWith('.css') || url.pathname.startsWith('/assets/');
  if (dynamicAsset) {
    event.respondWith(networkFirst(event.request, navigation));
    return;
  }
  event.respondWith(caches.match(event.request).then(async (cached) => {
    if (cached) return cached;
    try { return await cacheSuccessful(event.request, await fetch(event.request)); }
    catch (_) { return Response.error(); }
  }));
});
self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
});
