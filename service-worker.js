/* =========================================================
JAS TECH BILLING — service-worker.js
Fresh-First With Timeout Fallback + Stale-While-Revalidate
========================================================= */

const CACHE_NAME = "jas-tech-assets-v2.0.3";

// How long we wait for the network before falling back to whatever's cached.
// Without this, a slow/flaky connection makes fetch() hang indefinitely on
// reopen — that's what caused the occasional "stuck loading" reports.
const NETWORK_TIMEOUT_MS = 5000;

const STATIC_ASSETS = [
    "./assets/logo/logo.png",
    "./assets/logo/main-logo.png",
    "./assets/logo/horizontal-logo.png",
    "./assets/signature/signature.png",
    "./assets/icons/app-icon.png",
    "./assets/icons/whatsapp-qr.jpeg"
];

self.addEventListener("install", event => {
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then(cache => cache.addAll(STATIC_ASSETS))
            .catch(error => {
                console.warn("Service worker asset cache failed:", error);
            })
    );

    self.skipWaiting();
});

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

/**
 * Always prefers a fresh network response (so users get the latest app/config
 * quickly under normal conditions), but never lets a slow network hang the
 * page forever: if the network hasn't answered within NETWORK_TIMEOUT_MS, or
 * it fails outright, we fall back to the last good cached copy instead.
 * A successful network response always refreshes the cache for next time.
 */
async function networkFirstWithTimeout(request, timeoutMs = NETWORK_TIMEOUT_MS) {
    const cache = await caches.open(CACHE_NAME);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
        const response = await fetch(request, { signal: controller.signal });
        clearTimeout(timeout);

        if (response && response.ok) {
            cache.put(request, response.clone()).catch(() => {});
        }
        return response;
    } catch (error) {
        clearTimeout(timeout);

        const cached = await cache.match(request);
        if (cached) return cached;

        // Nothing cached to fall back to (e.g. very first ever load while
        // offline/slow) — surface the original failure instead of hanging.
        throw error;
    }
}

/**
 * Serves instantly from cache when available while refreshing that cache
 * entry in the background, so the *next* load benefits from any update.
 * Good for assets that rarely change (CDN libraries, images) where a few
 * minutes of staleness is a non-issue but a network stall is.
 */
function staleWhileRevalidate(request) {
    return caches.open(CACHE_NAME).then(cache =>
        cache.match(request).then(cached => {
            const network = fetch(request)
                .then(response => {
                    if (response && response.ok) {
                        cache.put(request, response.clone()).catch(error => {
                            console.warn("Cache update failed:", error);
                        });
                    }
                    return response;
                })
                .catch(() => cached);

            return cached || network;
        })
    );
}

self.addEventListener("fetch", event => {
    if (event.request.method !== "GET") return;

    const url = new URL(event.request.url);

    // Never intercept Supabase requests
    if (
        url.hostname === "supabase.co" ||
        url.hostname.endsWith(".supabase.co")
    ) {
        return;
    }

    // HTML and config.json: try the network first (so users get the latest
    // app/config), but fall back to cache if the network is slow or down
    // instead of hanging indefinitely.
    if (
        event.request.mode === "navigate" ||
        url.pathname.endsWith(".html") ||
        url.pathname.endsWith("config.json")
    ) {
        event.respondWith(networkFirstWithTimeout(event.request));
        return;
    }

    // JS/CSS (CDN libraries — Font Awesome, PDF/Excel generation, etc.):
    // serve from cache instantly if we have it, refreshing in the
    // background. These are effectively version-pinned CDN URLs, so a
    // stale-for-a-few-minutes copy is harmless — but re-downloading all of
    // them from scratch on every reopen is a common source of slow loads.
    if (
        url.pathname.endsWith(".js") ||
        url.pathname.endsWith(".css")
    ) {
        event.respondWith(staleWhileRevalidate(event.request));
        return;
    }

    // Images: same stale-while-revalidate strategy.
    if (
        event.request.destination === "image" ||
        /\.(png|jpg|jpeg|gif|svg|webp|ico)$/i.test(url.pathname)
    ) {
        event.respondWith(staleWhileRevalidate(event.request));
        return;
    }

    // Everything else: network only.
    event.respondWith(
        fetch(event.request)
    );
});
