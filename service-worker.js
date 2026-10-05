/* =========================================================
   JAS TECH BILLING — service-worker.js
   Cache First Strategy
   Safe Activation Handoff
   ========================================================= */

const CACHE_NAME = "v2.2.8";

// Delay before taking control of already-open pages.
const CLAIM_DELAY_MS = 2000;

const STATIC_ASSETS = [
  "./index.html",
  "./invoice-engine.js",
  "./invoice-engine.css",
  "./config.json",
  "./manifest.json",
  "./assets/logo/logo.png",
  "./assets/logo/main-logo.png",
  "./assets/logo/horizontal-logo.png",
  "./assets/signature/signature.png",
  "./assets/icons/app-icon.png",
  "./assets/icons/whatsapp-qr.jpeg",
];

// Third-party files that index.html needs at startup. They are cached so
// the app can open without any network.
const CDN_HOSTS = [
  "cdnjs.cloudflare.com",
  "cdn.jsdelivr.net",
  "fonts.googleapis.com",
  "fonts.gstatic.com",
];

const CDN_SCRIPTS = [
  "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2",
  "https://cdn.jsdelivr.net/npm/qrcode@1.4.4/build/qrcode.min.js",
  // Loaded later (on PDF export / print), cached now so it works offline.
  "https://cdnjs.cloudflare.com/ajax/libs/html2pdf.js/0.10.1/html2pdf.bundle.min.js",
];

// Stylesheets: we also read them to find and cache their font files.
const CDN_STYLESHEETS = [
  "https://cdnjs.cloudflare.com/ajax/libs/font-awesome/7.3.1/css/all.min.css",
  "https://fonts.googleapis.com/css2?family=Roboto:wght@400;500;600;700;750;800&display=swap",
];

async function precacheCdn(cache) {
  // Scripts (stored as opaque responses, same as a normal <script> load).
  await Promise.allSettled(
    CDN_SCRIPTS.map(async (url) => {
      const response = await fetch(new Request(url, { mode: "no-cors" }));
      await cache.put(url, response);
    })
  );

  // Stylesheets + the .woff2 font files they reference.
  await Promise.allSettled(
    CDN_STYLESHEETS.map(async (url) => {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      const css = await response.clone().text();
      await cache.put(url, response);

      const fontUrls = new Set();
      for (const match of css.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/g)) {
        const fontUrl = new URL(match[1], url).href;
        if (/\.woff2(\?|#|$)/i.test(fontUrl)) fontUrls.add(fontUrl);
      }

      await Promise.allSettled(
        [...fontUrls].map(async (fontUrl) => {
          const fontResponse = await fetch(fontUrl);
          if (fontResponse.ok) await cache.put(fontUrl, fontResponse);
        })
      );
    })
  );
}

self.addEventListener("message", (event) => {
  if (event.data?.type === "GET_VERSION") {
    event.source.postMessage(CACHE_NAME);
  }
});

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(async (cache) => {
      await Promise.allSettled(
        STATIC_ASSETS.map((asset) =>
          cache.add(asset).catch((error) => {
            console.warn(
              `Service worker failed to cache "${asset}":`,
              error
            );
          })
        )
      );

      // Never let a CDN problem block the install.
      await precacheCdn(cache).catch((error) => {
        console.warn("Service worker failed to cache CDN files:", error);
      });
    })
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
            .map((key) => caches.delete(key))
        )
      )
      .then(
        () =>
          new Promise((resolve) =>
            setTimeout(resolve, CLAIM_DELAY_MS)
          )
      )
      .then(() => self.clients.claim())
  );
});

/**
 * CACHE FIRST
 *
 * 1. Check cache first.
 * 2. If cached → return cached copy immediately.
 * 3. If not cached → request from network.
 * 4. Save successful network response into cache.
 */
function cacheFirst(request) {
  return caches.open(CACHE_NAME).then(async (cache) => {
    const cached = await cache.match(request);

    // Cached copy exists → use it immediately.
    if (cached) {
      return cached;
    }

    // No cached copy → get it from network.
    try {
      const response = await fetch(request);

      const isCacheable =
        response &&
        (response.ok || response.type === "opaque");

      if (isCacheable) {
        await cache.put(request, response.clone());
      }

      return response;
    } catch {
      return Response.error();
    }
  });
}

self.addEventListener("fetch", (event) => {
  // Only handle GET requests.
  if (event.request.method !== "GET") return;

  // The app sets this header when it must check the real server
  // (for example, before creating a PDF). Skip the cache for those.
  if (event.request.headers.get("X-Bypass-SW") === "1") return;

  const url = new URL(event.request.url);

  // =========================================================
  // SUPABASE
  // =========================================================
  // Never intercept Supabase requests.
  if (
    url.hostname === "supabase.co" ||
    url.hostname.endsWith(".supabase.co")
  ) {
    return;
  }

  // =========================================================
  // CDN SCRIPTS / STYLES / FONTS — CACHE FIRST
  // =========================================================
  if (CDN_HOSTS.includes(url.hostname)) {
    event.respondWith(
      cacheFirst(event.request)
    );

    return;
  }

  // =========================================================
  // MANIFEST.JSON — CACHE FIRST
  // =========================================================
  if (url.pathname.endsWith("manifest.json")) {
    event.respondWith(
      cacheFirst(event.request)
    );

    return;
  }

  // =========================================================
  // HTML + NAVIGATION + CONFIG — CACHE FIRST
  // =========================================================
  if (
    event.request.mode === "navigate" ||
    url.pathname.endsWith(".html") ||
    url.pathname.endsWith("config.json")
  ) {

    // invoice.html must NEVER be cached
    if (url.pathname.endsWith("/invoice.html") || url.pathname === "/invoice.html") {
      event.respondWith(fetch(event.request));
      return;
    }

    event.respondWith(
      cacheFirst(event.request).then(async (response) => {
        if (response && response.ok) {
          return response;
        }

        const isNavigationOrHtml =
          event.request.mode === "navigate" ||
          url.pathname.endsWith(".html");

        if (!isNavigationOrHtml) {
          return response;
        }

        const cache = await caches.open(CACHE_NAME);

        return (
          (await cache.match("./index.html")) ||
          response
        );
      })
    );

    return;
  }

  // =========================================================
  // JAVASCRIPT + CSS — CACHE FIRST
  // =========================================================
  if (
    url.origin === self.location.origin &&
    (
      url.pathname.endsWith(".js") ||
      url.pathname.endsWith(".css") ||
      event.request.destination === "script" ||
      event.request.destination === "style"
    )
  ) {
    event.respondWith(
      cacheFirst(event.request)
    );

    return;
  }

  // =========================================================
  // FONTS — CACHE FIRST (same-origin only; see note above)
  // =========================================================
  if (
    url.origin === self.location.origin &&
    (
      event.request.destination === "font" ||
      /\.(woff2?|ttf|otf|eot)$/i.test(url.pathname)
    )
  ) {
    event.respondWith(
      cacheFirst(event.request)
    );

    return;
  }

  // =========================================================
  // IMAGES — CACHE FIRST
  // =========================================================
  if (
    event.request.destination === "image" ||
    /\.(png|jpg|jpeg|gif|svg|webp|ico)$/i.test(
      url.pathname
    )
  ) {
    event.respondWith(
      cacheFirst(event.request)
    );

    return;
  }

  // =========================================================
  // EVERYTHING ELSE — NETWORK ONLY
  // =========================================================
  event.respondWith(
    fetch(event.request).catch(() =>
      Response.error()
    )
  );
});