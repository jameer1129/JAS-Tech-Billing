/* =========================================================
JAS TECH BILLING — service-worker.js
Fresh-First With Timeout Fallback + Stale-While-Revalidate
Safe Activation Handoff (avoids interrupting in-flight requests)
========================================================= */

const CACHE_NAME = "jas-tech-assets-v2.1.4";

// How long we wait for the network before falling back to whatever's cached.
// Without this, a slow/flaky connection makes fetch() hang indefinitely on
// reopen — that's what caused the occasional "stuck loading" reports.
const NETWORK_TIMEOUT_MS = 5000;

// How long to wait after activation before this worker takes control of
// already-open pages. See the note on self.clients.claim() below for why
// this exists — it's the fix for the ERR_CONNECTION_CLOSED issue.
const CLAIM_DELAY_MS = 2000;

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
    caches.open(CACHE_NAME).then((cache) =>
      // cache.addAll() is all-or-nothing: if a single asset 404s or fails,
      // the whole call rejects and the install "succeeds" with an empty
      // cache (since the failure was only logged, not surfaced) — meaning
      // nothing is actually available offline. Cache each asset on its own
      // so one bad path can't take the rest down with it.
      Promise.allSettled(
        STATIC_ASSETS.map((asset) =>
          cache.add(asset).catch((error) => {
            console.warn(`Service worker failed to cache "${asset}":`, error);
          }),
        ),
      ),
    ),
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
            .map((key) => caches.delete(key)),
        ),
      )
      .then(
        () =>
          // Taking control of already-open pages the instant we activate
          // (self.clients.claim()) can tear down requests those pages
          // already have in flight — the browser sees the controller
          // change mid-request and kills the connection, which is what
          // produced the intermittent Supabase
          // "net::ERR_CONNECTION_CLOSED" errors. A brand new page load has
          // no controller yet regardless, so this delay costs it nothing;
          // it only protects pages that were already open and mid-request
          // when the update landed.
          new Promise((resolve) => setTimeout(resolve, CLAIM_DELAY_MS)),
      )
      .then(() => self.clients.claim()),
  );
});

/**
 * Always prefers a fresh network response (so users get the latest app/config
 * quickly under normal conditions), but never lets a slow network hang the
 * page forever: if the network hasn't answered within NETWORK_TIMEOUT_MS, or
 * it fails outright, we fall back to the last good cached copy instead.
 * A successful network response always refreshes the cache for next time.
 * A network response that comes back but isn't ok (e.g. a 500) is treated
 * the same as a failure, so a flaky-but-connected network still prefers a
 * good cached copy over showing the user an error page.
 */
async function networkFirstWithTimeout(
  request,
  timeoutMs = NETWORK_TIMEOUT_MS,
) {
  const cache = await caches.open(CACHE_NAME);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(request, { signal: controller.signal });
    clearTimeout(timeout);

    if (response && response.ok) {
      cache.put(request, response.clone()).catch(() => {});
      return response;
    }

    // Server responded, but with an error (5xx/4xx) — prefer a cached copy
    // over surfacing that error to the user, if we have one.
    const cached = await cache.match(request);
    if (cached) return cached;
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
 * Good for assets that rarely change (CDN libraries, fonts, images) where a
 * few minutes of staleness is a non-issue but a network stall is.
 */
function staleWhileRevalidate(request) {
  return caches.open(CACHE_NAME).then((cache) =>
    cache.match(request).then((cached) => {
      const network = fetch(request)
        .then((response) => {
          // response.ok is only meaningful for same-origin/CORS responses.
          // Cross-origin requests without a `crossorigin` attribute (e.g.
          // our <script src="https://cdn.jsdelivr.net/..."> tags) come
          // back as "opaque" responses: status is always 0 and .ok is
          // always false, even on a successful download, because the
          // browser hides the details for no-cors requests. Treating
          // opaque as "cacheable" is the only way to actually get these
          // CDN scripts into the cache — a rejected fetch (thrown error)
          // is still caught separately below and skips caching.
          const isCacheable =
            response && (response.ok || response.type === "opaque");
          if (isCacheable) {
            cache.put(request, response.clone()).catch((error) => {
              console.warn("Cache update failed:", error);
            });
          }
          return response;
        })
        .catch(() => cached);

      // Return the cached copy immediately when we have one — this is the
      // whole point of stale-while-revalidate: don't make the caller wait
      // on the network at all. Only fall through to the network promise
      // when there's nothing cached yet.
      return cached || network.then((res) => res || Response.error());
    }),
  );
}

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;

  const url = new URL(event.request.url);

  // Never intercept Supabase requests
  if (url.hostname === "supabase.co" || url.hostname.endsWith(".supabase.co")) {
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
    event.respondWith(
      networkFirstWithTimeout(event.request).catch(async () => {
        const isNavigationOrHtml =
          event.request.mode === "navigate" || url.pathname.endsWith(".html");
        if (!isNavigationOrHtml) return Response.error();

        const cache = await caches.open(CACHE_NAME);
        return (await cache.match("./index.html")) || Response.error();
      })
    );
    return;
  }

  // JS/CSS (CDN libraries — Font Awesome, PDF/Excel generation, Supabase
  // SDK, etc.): serve from cache instantly if we have it, refreshing in
  // the background. These are effectively version-pinned CDN URLs, so a
  // stale-for-a-few-minutes copy is harmless — but re-downloading all of
  // them from scratch on every reopen is a common source of slow loads.
  //
  // Matched by BOTH file extension and request.destination: some CDN
  // URLs (e.g. jsDelivr's "@2" version-pinned Supabase SDK URL) have no
  // literal ".js" extension in the path, so extension-only matching let
  // them fall through to the network-only branch below — which has no
  // cache fallback, so a single transient network blip on that one
  // request produced a hard failure instead of degrading gracefully.
  if (
    url.pathname.endsWith(".js") ||
    url.pathname.endsWith(".css") ||
    event.request.destination === "script" ||
    event.request.destination === "style"
  ) {
    event.respondWith(staleWhileRevalidate(event.request));
    return;
  }

  // Fonts (e.g. Font Awesome's .woff2/.woff/.ttf, used by the offline UI
  // icons): same stale-while-revalidate strategy. These were previously
  // uncached and fell through to network-only, which meant icons could
  // fail to render on the very screen meant to work offline.
  if (
    event.request.destination === "font" ||
    /\.(woff2?|ttf|otf|eot)$/i.test(url.pathname)
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

  // Everything else: network only. Catch and return a proper error Response
  // instead of letting a rejected fetch() surface as an unhandled promise
  // rejection in the console (this is expected when actually offline with
  // nothing cached for this URL — there's nothing to serve — but it should
  // fail quietly rather than throwing).
  event.respondWith(
    fetch(event.request).catch(() => Response.error()),
  );
});