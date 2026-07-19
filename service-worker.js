/* =========================================================
   JAS TECH BILLING — service-worker.js
   Caches the entire app (including all image assets) so the
   PWA works fully offline after the first successful load.
   Bump CACHE_NAME whenever cached files change to force refresh.
   ========================================================= */

const CACHE_NAME = 'jas-tech-billing-v3';

const ASSETS_TO_CACHE = [
  './',
  './index.html',
  './manifest.json',

  './assets/logo/horizontal-logo.png',
  './assets/logo/main-logo.png',
  './assets/logo/logo.png',
  './assets/signature/signature.png',
  './assets/icons/app-icon.png',
  './assets/icons/whatsapp-qr.jpeg'
];

// Install: pre-cache the app shell
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(ASSETS_TO_CACHE))
      .then(() => self.skipWaiting())
  );
});

// Activate: clean up old caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

// Fetch: cache-first, falling back to network, then caching new responses.
// Falls back to the cached index.html for navigations when fully offline.
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;

  event.respondWith(
    caches.match(event.request).then((cachedResponse) => {
      if (cachedResponse) return cachedResponse;

      return fetch(event.request)
        .then((networkResponse) => {
          if (networkResponse && networkResponse.status === 200) {
            const clone = networkResponse.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          }
          return networkResponse;
        })
        .catch(() => {
          if (event.request.mode === 'navigate') return caches.match('./index.html');
        });
    })
  );
});