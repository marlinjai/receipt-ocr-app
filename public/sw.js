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
 * It does exactly two things:
 *  1. When a page navigation fails because there is no connection, it answers
 *     with /offline.html, where a photo can still be taken into the capture queue.
 *  2. SHARE TARGET (Android only; iOS offers no share target to web apps): a
 *     file shared to the installed app arrives as a POST to /share-target. The
 *     worker puts it into the capture queue and sends the browser to /app,
 *     which processes it like a photo taken there.
 * Every other request goes to the network untouched.
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

// ── Share target ────────────────────────────────────────────────────────────
// The three names must match src/lib/capture/offline-queue.ts (a test compares them).
const DB_NAME = 'receipt-capture';
const DB_VERSION = 1;
const STORE_NAME = 'queue';
const SHARE_PATH = '/share-target';

function queueSharedFiles(files) {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(DB_NAME, DB_VERSION);
    open.onupgradeneeded = () => {
      if (!open.result.objectStoreNames.contains(STORE_NAME)) {
        open.result.createObjectStore(STORE_NAME, { keyPath: 'id' });
      }
    };
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const now = Date.now();
      files.forEach((file, index) => {
        store.put({
          id: now + index + '-' + Math.random().toString(36).slice(2, 10),
          name: file.name || 'geteilt-' + (now + index),
          type: file.type,
          blob: file,
          // Keep the order in which the files were shared.
          addedAt: now + index,
          source: 'share',
          attempts: 0,
          lastError: null,
        });
      });
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = tx.onabort = () => {
        db.close();
        reject(tx.error);
      };
    };
  });
}

function backToApp(result) {
  return Response.redirect(new URL('/app?shared=' + result, self.location.origin).toString(), 303);
}

async function handleShare(request) {
  try {
    const form = await request.formData();
    const files = form.getAll('files').filter((entry) => entry && typeof entry === 'object' && 'size' in entry);
    const usable = files.filter((file) => /^image\//.test(file.type) || file.type === 'application/pdf');
    // Nothing usable (a text snippet, a video): say so in the app instead of dropping it silently.
    if (usable.length === 0) return backToApp('unsupported');
    await queueSharedFiles(usable);
    return backToApp(String(usable.length));
  } catch {
    return backToApp('failed');
  }
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (request.method === 'POST' && url.pathname === SHARE_PATH) {
    event.respondWith(handleShare(request));
    return;
  }

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
