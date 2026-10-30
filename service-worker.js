
/* =========================================================
   JAS TECH BILLING — service-worker.js
   Cache First Strategy
   Safe Activation Handoff
   ========================================================= */

const CACHE_NAME = "v3.1.2";
const CLAIM_DELAY_MS = 2000;

const STATIC_ASSETS = [
  "./index.html",
  "./invoice-engine.js",
  "./invoice-engine.css",
  "./config.json",
  "./manifest.json",
  "./assets/logo/logo.png",
  "./assets/logo/logo-qr.png",
  "./assets/logo/main-logo.png",
  "./assets/logo/horizontal-logo.png",
  "./assets/signature/signature.png",
  "./assets/icons/app-icon.png",
  "./assets/icons/app-icon-maskable.png",
  "./assets/icons/whatsapp-qr.jpeg",
];

const CDN_HOSTS = [
  "cdnjs.cloudflare.com",
  "cdn.jsdelivr.net",
  "fonts.googleapis.com",
  "fonts.gstatic.com",
];

const CDN_SCRIPTS = [
  "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2",
  "https://cdn.jsdelivr.net/npm/qrcode@1.4.4/build/qrcode.min.js",
  "https://cdnjs.cloudflare.com/ajax/libs/html2pdf.js/0.10.1/html2pdf.bundle.min.js",
  "https://cdnjs.cloudflare.com/ajax/libs/cropperjs/1.6.2/cropper.min.js",
  "https://cdn.jsdelivr.net/npm/canvas-confetti@1.9.3/dist/confetti.browser.min.js"
];

const CDN_STYLESHEETS = [
  "https://cdnjs.cloudflare.com/ajax/libs/font-awesome/7.3.1/css/all.min.css",
  "https://fonts.googleapis.com/css2?family=Roboto:wght@400;500;600;700;750;800&display=swap",
  "https://cdnjs.cloudflare.com/ajax/libs/cropperjs/1.6.2/cropper.min.css",
  "https://cdn.jsdelivr.net/npm/canvas-confetti@1.9.3/dist/confetti.browser.min.css"
];

async function precacheCdn(cache) {
  await Promise.allSettled(
    CDN_SCRIPTS.map(async (url) => {
      const response = await fetch(
        new Request(url, { mode: "no-cors" })
      );
      await cache.put(url, response);
    })
  );

  await Promise.allSettled(
    CDN_STYLESHEETS.map(async (url) => {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const css = await response.clone().text();
      await cache.put(url, response);

      const fontUrls = new Set();

      for (const match of css.matchAll(
        /url\(\s*["']?([^"')]+)["']?\s*\)/g
      )) {
        const fontUrl = new URL(match[1], url).href;

        if (/\.woff2(\?|#|$)/i.test(fontUrl)) {
          fontUrls.add(fontUrl);
        }
      }

      await Promise.allSettled(
        [...fontUrls].map(async (fontUrl) => {
          const fontResponse = await fetch(fontUrl);

          if (fontResponse.ok) {
            await cache.put(fontUrl, fontResponse);
          }
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

      await precacheCdn(cache).catch((error) => {
        console.warn(
          "Service worker failed to cache CDN files:",
          error
        );
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
 * 1. Check cache.
 * 2. Return cached response when available.
 * 3. Otherwise fetch from network.
 * 4. Cache successful or opaque responses.
 */
function cacheFirst(request) {
  return caches.open(CACHE_NAME).then(async (cache) => {
    const cached = await cache.match(request);

    if (cached) {
      return cached;
    }

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
  if (event.request.method !== "GET") return;

  if (
    event.request.headers.get("X-Bypass-SW") === "1"
  ) {
    return;
  }

  const url = new URL(event.request.url);

  // =========================================================
  // PUBLIC PROFILE AVATARS — CACHE FIRST
  // =========================================================
  // Only cache images from the public profile-avatars bucket.
  // Other Supabase requests remain network-only.
  if (
    (url.hostname === "supabase.co" ||
      url.hostname.endsWith(".supabase.co")) &&
    url.pathname.includes(
      "/storage/v1/object/public/profile-avatars/"
    ) &&
    (event.request.destination === "image" ||
      /\.(png|jpe?g|gif|svg|webp|ico)$/i.test(
        url.pathname
      ))
  ) {
    event.respondWith(cacheFirst(event.request));
    return;
  }

  // =========================================================
  // SUPABASE — OTHER REQUESTS NETWORK ONLY
  // =========================================================
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
    event.respondWith(cacheFirst(event.request));
    return;
  }

  // =========================================================
  // MANIFEST.JSON — CACHE FIRST
  // =========================================================
  if (url.pathname.endsWith("manifest.json")) {
    event.respondWith(cacheFirst(event.request));
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
    // invoice.html must NEVER be cached.
    if (
      url.pathname.endsWith("/invoice.html") ||
      url.pathname === "/invoice.html"
    ) {
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
    (url.pathname.endsWith(".js") ||
      url.pathname.endsWith(".css") ||
      event.request.destination === "script" ||
      event.request.destination === "style")
  ) {
    event.respondWith(cacheFirst(event.request));
    return;
  }

  // =========================================================
  // FONTS — CACHE FIRST (SAME ORIGIN)
  // =========================================================
  if (
    url.origin === self.location.origin &&
    (event.request.destination === "font" ||
      /\.(woff2?|ttf|otf|eot)$/i.test(url.pathname))
  ) {
    event.respondWith(cacheFirst(event.request));
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
    event.respondWith(cacheFirst(event.request));
    return;
  }

  // =========================================================
  // EVERYTHING ELSE — NETWORK ONLY
  // =========================================================
  event.respondWith(
    fetch(event.request).catch(() => Response.error())
  );
});
