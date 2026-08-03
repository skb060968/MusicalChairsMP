/* Musical Chairs PWA Service Worker */

/*
 * WORKSPACE CONVENTION: bump CACHE_VERSION on every deployed code change.
 * Installed PWAs only pick up new assets when the cache name changes, so a
 * deploy without a version bump leaves players on stale JS/CSS.
 */
const CACHE_VERSION = 'v1.10.0'; // Reset stale join-room state after room exit
const CACHE_NAME = `musical-chairs-${CACHE_VERSION}`;

/*
 * Precache = app shell plus the small chair artwork used by every round. Vite
 * emits hashed bundles into /assets/, so built JS/CSS filenames are unknown
 * here; those are handled network-first at runtime (see fetch handler).
 * The dev-only /src/*.js paths are deliberately NOT listed.
 *
 * /sounds/music.mp3 (~6 MB) is excluded on purpose: precaching it would stall
 * or fail the install step on mobile data. It is left to the browser's own
 * media pipeline (see fetch handler).
 */
const STATIC_ASSETS = [
  "/",
  "/index.html",
  "/manifest.json",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/favicon.ico",
  "/images/chair.png",
  "/sounds/tap.mp3",
  "/sounds/eliminate.mp3",
  "/sounds/victory.mp3",
];

// Large media handled by the network/browser, never cached by the SW
const EXCLUDED_PATHS = ["/sounds/music.mp3"];

self.addEventListener("install", (event) => {
  console.log(`[SW] Installing version ${CACHE_VERSION}`);
  // Skip waiting to activate new service worker immediately
  self.skipWaiting();

  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      console.log('[SW] Caching app shell');
      return cache.addAll(STATIC_ASSETS);
    })
  );
});

self.addEventListener("activate", (event) => {
  console.log(`[SW] Activating version ${CACHE_VERSION}`);

  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.map((key) => {
        if (key !== CACHE_NAME) {
          console.log(`[SW] Deleting old cache: ${key}`);
          return caches.delete(key);
        }
      })),
    ).then(() => self.clients.claim())
    .then(() => {
      // Notify all clients about the update
      return self.clients.matchAll().then((clients) => {
        clients.forEach((client) => {
          client.postMessage({
            type: 'UPDATE_AVAILABLE',
            version: CACHE_VERSION
          });
        });
      });
    })
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.origin !== self.location.origin) return;

  // Let the browser stream the music file itself (range requests, no 6 MB cache)
  if (EXCLUDED_PATHS.includes(url.pathname)) return;

  if (
    event.request.mode === "navigate" ||
    url.pathname.endsWith(".js") ||
    url.pathname.endsWith(".css") ||
    url.pathname.startsWith("/assets/")
  ) {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          return response;
        })
        .catch(() =>
          caches.match(event.request).then((cached) => cached || caches.match("/index.html")),
        ),
    );
    return;
  }

  event.respondWith(
    caches.match(event.request)
      .then((cached) =>
        cached ||
        fetch(event.request).then((response) => {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          return response;
        }),
      )
      .catch(() => caches.match("/index.html")),
  );
});

self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") {
    self.skipWaiting();
  }
});
