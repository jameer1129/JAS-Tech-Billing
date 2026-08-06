/* =========================================================
   JAS TECH BILLING — service-worker.js
   Online First + Image Cache
   ========================================================= */

const CACHE_NAME = "jas-tech-assets-v2.0.1";

// Only static assets
const STATIC_ASSETS = [
  "./assets/logo/logo.png",
  "./assets/logo/main-logo.png",
  "./assets/logo/horizontal-logo.png",
  "./assets/signature/signature.png",
  "./assets/icons/app-icon.png",
  "./assets/icons/whatsapp-qr.jpeg"
];

// Install
self.addEventListener("install", event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(STATIC_ASSETS))
  );

  self.skipWaiting();
});

// Activate
self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(key => key !== CACHE_NAME)
          .map(key => caches.delete(key))
      )
    )
  );

  self.clients.claim();
});

// Fetch
self.addEventListener("fetch", event => {

  if (event.request.method !== "GET") return;

  const url = new URL(event.request.url);

  // Never cache HTML
  if (
      event.request.mode === "navigate" ||
      url.pathname.endsWith(".html")
  ) {

      event.respondWith(fetch(event.request));
      return;
  }

  // Never cache config
  if (url.pathname.endsWith("config.json")) {

      event.respondWith(fetch(event.request));
      return;
  }

  // Never cache JS
  if (url.pathname.endsWith(".js")) {

      event.respondWith(fetch(event.request));
      return;
  }

  // Never cache CSS
  if (url.pathname.endsWith(".css")) {

      event.respondWith(fetch(event.request));
      return;
  }

  // Cache images only
  if (
      event.request.destination === "image" ||
      /\.(png|jpg|jpeg|gif|svg|webp|ico)$/i.test(url.pathname)
  ) {

      event.respondWith(

          caches.match(event.request).then(cached => {

              const network = fetch(event.request)
                  .then(response => {

                      if (response.ok) {
                          const copy = response.clone();

                          caches.open(CACHE_NAME)
                              .then(cache => cache.put(event.request, copy));
                      }

                      return response;
                  })
                  .catch(() => cached);

              return cached || network;
          })

      );

      return;
  }

  // Everything else: always network
  event.respondWith(fetch(event.request));
});