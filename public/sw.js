/*
 * Receipts service worker.
 *
 * THE RULE: this worker never stores or serves application pages or /_next/
 * files. The worker it replaces (removed in March 2026) cached the app pages
 * and every script file and served scripts cache-first; after a deployment
 * browsers kept running old scripts that no longer matched the server. Nothing
 * here can repeat that, because the only thing ever cached is one small,
 * self-contained page.
 *
 * It does exactly one thing: when a page navigation fails because there is no
 * connection, it answers with /offline.html, where a photo can still be taken
 * into the capture queue. Every other request goes to the network untouched.
 *
 * Kill switch: the app asks /api/client-config on load and unregisters this
 * worker when the server says so (see ServiceWorkerRegistrar).
 */

const VERSION = 'v3';
const CACHE_NAME = 'receipts-offline-' + VERSION;
const OFFLINE_URL = '/offline.html';

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      // `reload`: always from the network, never a stale copy from the HTTP cache.
      .then((cache) => cache.add(new Request(OFFLINE_URL, { cache: 'reload' })))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      // Every cache but ours goes, including anything left by the 2026 worker.
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // A page navigation: always the network. Only when the network itself fails
  // (offline), the offline page. A server error is passed through as it is.
  if (request.method === 'GET' && request.mode === 'navigate') {
    event.respondWith(
      fetch(request).catch(() => caches.match(OFFLINE_URL).then((cached) => cached || Response.error())),
    );
    return;
  }

  // Everything else (scripts, styles, API calls, uploads): not handled here.
});
