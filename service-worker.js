/* =========================================================
JAS TECH BILLING — service-worker.js
Network-First HTML + Stale-While-Revalidate Assets
Safe Persistent Cache + Timeout Fallback
========================================================= */

const CACHE_NAME = "jas-tech-assets-v2.1.6";
const NETWORK_TIMEOUT_MS = 5000;

const STATIC_ASSETS = [
  "./index.html",
  "./manifest.json",
  "./assets/logo/logo.png",
  "./assets/logo/main-logo.png",
  "./assets/logo/horizontal-logo.png",
  "./assets/signature/signature.png",
  "./assets/icons/app-icon.png",
  "./assets/icons/whatsapp-qr.jpeg",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(async (cache) => {
      await Promise.allSettled(
        STATIC_ASSETS.map(async (asset) => {
          try {
            await cache.add(asset);
          } catch (error) {
            console.warn(
              `Service worker failed to cache "${asset}":`,
              error,
            );
          }
        }),
      );
    }),
  );

  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key !== CACHE_NAME)
            .map((key) =>
              caches.delete(key).catch(() => false),
            ),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

async function fetchWithTimeout(
  request,
  timeoutMs = NETWORK_TIMEOUT_MS,
) {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    timeoutMs,
  );

  try {
    return await fetch(request, {
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

async function updateCache(cache, request, response) {
  if (!response) return;

  const cacheable =
    response.ok || response.type === "opaque";

  if (!cacheable) return;

  try {
    await cache.put(request, response.clone());
  } catch (error) {
    console.warn(
      `Cache update failed for "${request.url}":`,
      error,
    );
  }
}

async function networkFirstWithTimeout(
  request,
  timeoutMs = NETWORK_TIMEOUT_MS,
) {
  const cache = await caches.open(CACHE_NAME);

  try {
    const response = await fetchWithTimeout(
      request,
      timeoutMs,
    );

    if (response && response.ok) {
      updateCache(cache, request, response);
      return response;
    }

    const cached = await cache.match(request);

    if (cached) return cached;

    return response;
  } catch (error) {
    const cached = await cache.match(request);

    if (cached) return cached;

    throw error;
  }
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);

  try {
    const response = await fetchWithTimeout(request);

    if (
      response &&
      (response.ok || response.type === "opaque")
    ) {
      updateCache(cache, request, response);
    }

    return response;
  } catch (error) {
    if (cached) return cached;

    return Response.error();
  }
}

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;

  const url = new URL(event.request.url);

  // Never intercept Supabase requests.
  if (
    url.hostname === "supabase.co" ||
    url.hostname.endsWith(".supabase.co")
  ) {
    return;
  }

  // HTML and config: fresh first, cached fallback.
  if (
    event.request.mode === "navigate" ||
    url.pathname.endsWith(".html") ||
    url.pathname.endsWith("config.json")
  ) {
    event.respondWith(
      networkFirstWithTimeout(event.request).catch(
        async () => {
          const isNavigationOrHtml =
            event.request.mode === "navigate" ||
            url.pathname.endsWith(".html");

          if (!isNavigationOrHtml) {
            return Response.error();
          }

          const cache = await caches.open(CACHE_NAME);

          return (
            (await cache.match("./index.html")) ||
            Response.error()
          );
        },
      ),
    );

    return;
  }

  // JavaScript and CSS.
  if (
    url.pathname.endsWith(".js") ||
    url.pathname.endsWith(".css") ||
    event.request.destination === "script" ||
    event.request.destination === "style"
  ) {
    event.respondWith(
      staleWhileRevalidate(event.request),
    );

    return;
  }

  // Fonts.
  if (
    event.request.destination === "font" ||
    /\.(woff2?|ttf|otf|eot)$/i.test(url.pathname)
  ) {
    event.respondWith(
      staleWhileRevalidate(event.request),
    );

    return;
  }

  // Images.
  if (
    event.request.destination === "image" ||
    /\.(png|jpg|jpeg|gif|svg|webp|ico)$/i.test(
      url.pathname,
    )
  ) {
    event.respondWith(
      staleWhileRevalidate(event.request),
    );

    return;
  }

  // Everything else: network only.
  event.respondWith(
    fetch(event.request).catch(() => Response.error()),
  );
});