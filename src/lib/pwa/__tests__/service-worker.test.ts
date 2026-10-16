import { readFileSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { openCaptureStore } from '@/lib/capture/offline-queue';
import { sharedNotice } from '@/lib/capture/shared-notice';
import { CAPTURE_DB_NAME, CAPTURE_DB_VERSION, CAPTURE_STORE_NAME } from '@/lib/capture/offline-queue';
import { syncServiceWorker } from '../service-worker';

const PUBLIC = path.resolve(__dirname, '../../../../public');
const SW_SOURCE = readFileSync(path.join(PUBLIC, 'sw.js'), 'utf8');
const OFFLINE_SOURCE = readFileSync(path.join(PUBLIC, 'offline.html'), 'utf8');

/** Run public/sw.js itself inside a fake worker scope. */
function loadWorker(options: { online?: boolean; existingCaches?: string[]; windows?: Array<Record<string, unknown>>; fetchImpl?: (...a: unknown[]) => unknown } = {}) {
  const listeners = new Map<string, (event: unknown) => void>();
  const stores = new Map<string, Map<string, Response>>();
  for (const name of options.existingCaches ?? []) stores.set(name, new Map());
  let online = options.online ?? true;

  const network = vi.fn(async (request: Request | string) => {
    if (!online) throw new TypeError('Failed to fetch');
    const url = typeof request === 'string' ? request : request.url;
    return new Response(`network:${new URL(url, 'https://receipts.example.invalid').pathname}`, { status: 200 });
  });

  const caches = {
    open: vi.fn(async (name: string) => {
      if (!stores.has(name)) stores.set(name, new Map());
      const store = stores.get(name)!;
      return {
        add: async (request: Request) => {
          const res = await network(request);
          if (!res.ok) throw new Error('add failed');
          store.set(new URL(request.url).pathname, res);
        },
        put: async (request: Request, response: Response) => {
          store.set(new URL(request.url).pathname, response);
        },
      };
    }),
    keys: vi.fn(async () => [...stores.keys()]),
    delete: vi.fn(async (name: string) => stores.delete(name)),
    match: vi.fn(async (key: string | Request) => {
      const pathname = typeof key === 'string' ? key : new URL(key.url).pathname;
      for (const store of stores.values()) {
        const hit = store.get(pathname);
        if (hit) return hit.clone();
      }
      return undefined;
    }),
  };

  const scope = {
    location: { origin: 'https://receipts.example.invalid' },
    addEventListener: (type: string, fn: (event: unknown) => void) => listeners.set(type, fn),
    skipWaiting: vi.fn(async () => {}),
    clients: {
      claim: vi.fn(async () => {}),
      matchAll: vi.fn(async () => options.windows ?? []),
      openWindow: vi.fn(async () => null),
    },
    registration: {
      showNotification: vi.fn(async () => {}),
      pushManager: { getSubscription: vi.fn(async () => null), subscribe: vi.fn(async () => ({})) },
    },
  };

  // In a worker a relative URL resolves against the worker's origin; under node it does not.
  class ScopedRequest extends Request {
    constructor(input: string, init?: RequestInit) {
      super(new URL(input, scope.location.origin).toString(), init);
    }
  }

  const idb = new IDBFactory();
  new Function('self', 'caches', 'fetch', 'Request', 'indexedDB', SW_SOURCE)(scope, caches, options.fetchImpl ?? network, ScopedRequest, idb);

  async function lifecycle(type: 'install' | 'activate') {
    let pending: Promise<unknown> = Promise.resolve();
    listeners.get(type)!({ waitUntil: (p: Promise<unknown>) => (pending = p) });
    await pending;
  }

  /** Dispatch a fetch event; resolves to the worker's response, or null when it did not handle the request. */
  async function request(
    pathname: string,
    init: { method?: string; mode?: string; origin?: string; formData?: () => Promise<FormData> } = {},
  ) {
    let responded: Promise<Response> | null = null;
    const req = {
      url: `${init.origin ?? scope.location.origin}${pathname}`,
      method: init.method ?? 'GET',
      mode: init.mode ?? 'no-cors',
      formData: init.formData,
    };
    listeners.get('fetch')!({ request: req, respondWith: (p: Promise<Response>) => (responded = p) });
    return responded ? await (responded as Promise<Response>) : null;
  }

  /** Dispatch any other event (push, notificationclick) and wait for what it handed to waitUntil. */
  async function dispatch(type: string, event: Record<string, unknown>) {
    let pending: Promise<unknown> = Promise.resolve();
    listeners.get(type)!({ ...event, waitUntil: (p: Promise<unknown>) => (pending = p) });
    await pending;
  }

  return { scope, caches, stores, network, lifecycle, request, dispatch, idb, setOnline: (v: boolean) => (online = v) };
}

describe('public/sw.js: it never serves application code', () => {
  it.each([
    '/_next/static/chunks/main-abc123.js',
    '/_next/static/css/app.css',
    '/_next/image?url=x',
    '/api/meals/register?year=2025&format=csv',
    '/api/files/11111111-2222-4333-8444-555555555555',
    '/icons/icon-192.svg',
    '/manifest.json',
  ])('does not answer %s (the browser goes to the network itself)', async (pathname) => {
    const worker = loadWorker();
    await worker.lifecycle('install');
    await worker.lifecycle('activate');
    expect(await worker.request(pathname)).toBeNull();
    expect(worker.caches.match).not.toHaveBeenCalled();
  });

  it('does not answer uploads or any other POST', async () => {
    const worker = loadWorker();
    expect(await worker.request('/api/upload/check', { method: 'POST' })).toBeNull();
    expect(await worker.request('/app', { method: 'POST', mode: 'navigate' })).toBeNull();
  });

  it('does not touch requests to other origins', async () => {
    const worker = loadWorker();
    expect(await worker.request('/app', { mode: 'navigate', origin: 'https://auth.example.invalid' })).toBeNull();
  });

  it('caches exactly one file: the offline page, nothing from /_next/ and no app page', async () => {
    const worker = loadWorker();
    await worker.lifecycle('install');
    await worker.lifecycle('activate');
    await worker.request('/app', { mode: 'navigate' });
    await worker.request('/app/meals', { mode: 'navigate' });
    const cached = [...worker.stores.values()].flatMap((store) => [...store.keys()]);
    expect(cached).toEqual(['/offline.html']);
  });

  it('the source contains no cache.put and no cache-first lookup for scripts', () => {
    // The only `.put(` is the IndexedDB write of a shared file into the capture queue.
    expect(SW_SOURCE.match(/\.put\(/g)).toHaveLength(1);
    expect(SW_SOURCE).toMatch(/store\.put\(/);
    expect(SW_SOURCE).not.toMatch(/addAll/);
    expect(SW_SOURCE.match(/caches\.match\(/g)).toHaveLength(1);
  });
});

describe('public/sw.js: navigation and lifecycle', () => {
  it('online: a page navigation is answered by the network, never by a cache', async () => {
    const worker = loadWorker();
    await worker.lifecycle('install');
    const res = await worker.request('/app/meals', { mode: 'navigate' });
    expect(await res!.text()).toBe('network:/app/meals');
  });

  it('offline: a page navigation gets the offline page', async () => {
    const worker = loadWorker();
    await worker.lifecycle('install');
    worker.setOnline(false);
    const res = await worker.request('/app', { mode: 'navigate' });
    expect(await res!.text()).toBe('network:/offline.html');
  });

  it('offline before the offline page was ever cached: a plain network error, not a hang', async () => {
    const worker = loadWorker({ online: false });
    const res = await worker.request('/app', { mode: 'navigate' });
    expect(res!.type).toBe('error');
  });

  it('activation deletes every other cache, including the one the 2026 worker left, and takes control', async () => {
    const worker = loadWorker({ existingCaches: ['receipt-ocr-v2', 'receipts-offline-v1', 'something-else'] });
    await worker.lifecycle('install');
    await worker.lifecycle('activate');
    expect([...worker.stores.keys()]).toEqual(['receipts-offline-v3']);
    expect(worker.scope.skipWaiting).toHaveBeenCalled();
    expect(worker.scope.clients.claim).toHaveBeenCalled();
  });

  it('installation fails loudly when the offline page cannot be fetched (no half-installed worker)', async () => {
    const worker = loadWorker({ online: false });
    await expect(worker.lifecycle('install')).rejects.toThrow();
    expect(worker.scope.skipWaiting).not.toHaveBeenCalled();
  });
});

describe('public/sw.js: share target', () => {
  function shared(...files: File[]) {
    return async () => {
      const form = new FormData();
      for (const f of files) form.append('files', f);
      return form;
    };
  }
  const image = (name: string) => new File([new Uint8Array([1, 2, 3])], name, { type: 'image/jpeg' });

  it('uses the same queue names as the app', () => {
    expect(SW_SOURCE).toContain("const DB_NAME = 'receipt-capture';");
    expect(SW_SOURCE).toContain('const DB_VERSION = 1;');
    expect(SW_SOURCE).toContain("const STORE_NAME = 'queue';");
  });

  it('a shared image and PDF become queue entries, in order, and the browser is sent to the app', async () => {
    const worker = loadWorker();
    const pdf = new File([new Uint8Array([4, 5])], 'scan.pdf', { type: 'application/pdf' });
    const res = await worker.request('/share-target', { method: 'POST', mode: 'navigate', formData: shared(image('foto.jpg'), pdf) });
    expect(res!.status).toBe(303);
    expect(res!.headers.get('location')).toBe('https://receipts.example.invalid/app?shared=2');
    // Read back through the APP's own queue code: the two sides agree on the shape.
    const entries = await openCaptureStore(worker.idb).list();
    expect(entries.map((e) => [e.name, e.type, e.source, e.attempts, e.lastError])).toEqual([
      ['foto.jpg', 'image/jpeg', 'share', 0, null],
      ['scan.pdf', 'application/pdf', 'share', 0, null],
    ]);
    expect(worker.network).not.toHaveBeenCalled();
  });

  it('a share with nothing usable is reported, not dropped silently, and queues nothing', async () => {
    const worker = loadWorker();
    const video = new File([new Uint8Array([1])], 'clip.mp4', { type: 'video/mp4' });
    const res = await worker.request('/share-target', { method: 'POST', formData: shared(video) });
    expect(res!.headers.get('location')).toBe('https://receipts.example.invalid/app?shared=unsupported');
    expect(await openCaptureStore(worker.idb).list()).toEqual([]);
    const empty = await worker.request('/share-target', { method: 'POST', formData: async () => new FormData() });
    expect(empty!.headers.get('location')).toContain('shared=unsupported');
  });

  it('a mixed share keeps the usable files and leaves out the rest', async () => {
    const worker = loadWorker();
    const text = new File(['hallo'], 'notiz.txt', { type: 'text/plain' });
    const res = await worker.request('/share-target', { method: 'POST', formData: shared(text, image('beleg.jpg')) });
    expect(res!.headers.get('location')).toContain('shared=1');
    expect((await openCaptureStore(worker.idb).list()).map((e) => e.name)).toEqual(['beleg.jpg']);
  });

  it('a share that cannot be read ends in the app with an error, never a blank page', async () => {
    const worker = loadWorker();
    const res = await worker.request('/share-target', {
      method: 'POST',
      formData: async () => {
        throw new Error('body unreadable');
      },
    });
    expect(res!.headers.get('location')).toBe('https://receipts.example.invalid/app?shared=failed');
  });

  it('only POST /share-target is taken: no other POST and no GET to that path', async () => {
    const worker = loadWorker();
    expect(await worker.request('/api/upload/request', { method: 'POST' })).toBeNull();
    expect(await worker.request('/share-target')).toBeNull();
  });

  it('every outcome has wording for the user', () => {
    expect(sharedNotice('2')).toEqual({ tone: 'info', text: '2 geteilte Dateien wurden übernommen und werden jetzt verarbeitet.' });
    expect(sharedNotice('1')!.text).toMatch(/1 geteilte Datei wurde übernommen/);
    for (const code of ['unsupported', 'unavailable', 'failed']) expect(sharedNotice(code)!.tone).toBe('error');
    for (const none of [null, '', '0', 'anything-else']) expect(sharedNotice(none)).toBeNull();
  });
});

describe('public/offline.html', () => {
  it('writes to the same queue as the app', () => {
    expect(OFFLINE_SOURCE).toContain(`var DB_NAME = '${CAPTURE_DB_NAME}';`);
    expect(OFFLINE_SOURCE).toContain(`var DB_VERSION = ${CAPTURE_DB_VERSION};`);
    expect(OFFLINE_SOURCE).toContain(`var STORE_NAME = '${CAPTURE_STORE_NAME}';`);
    expect(OFFLINE_SOURCE).toContain("source: 'offline-page'");
  });

  it('is self-contained: declares its charset first and loads no script, style or font from anywhere', () => {
    expect(OFFLINE_SOURCE).toMatch(/<head>\s*<meta charset="utf-8">/);
    expect(OFFLINE_SOURCE).not.toMatch(/<script[^>]+src=/);
    expect(OFFLINE_SOURCE).not.toMatch(/<link[^>]+href=/);
    expect(OFFLINE_SOURCE).not.toContain('/_next/');
    expect(OFFLINE_SOURCE).toContain('100svh');
  });
});

describe('syncServiceWorker (registration and kill switch)', () => {
  const registration = { unregister: vi.fn(async () => true) };
  const container = {
    register: vi.fn(async () => ({}) as ServiceWorkerRegistration),
    getRegistrations: vi.fn(async () => [registration] as unknown as ServiceWorkerRegistration[]),
  };
  const cacheStorage = { keys: vi.fn(async () => ['receipts-offline-v3', 'old']), delete: vi.fn(async () => true) };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('registers the worker when the server allows it', async () => {
    const result = await syncServiceWorker({ container, caches: cacheStorage, fetchConfig: async () => ({ serviceWorker: true }) });
    expect(result).toBe('registered');
    expect(container.register).toHaveBeenCalledWith('/sw.js', { scope: '/' });
    expect(registration.unregister).not.toHaveBeenCalled();
  });

  it('kill switch: unregisters every worker and deletes every cache', async () => {
    const result = await syncServiceWorker({ container, caches: cacheStorage, fetchConfig: async () => ({ serviceWorker: false }) });
    expect(result).toBe('withdrawn');
    expect(container.register).not.toHaveBeenCalled();
    expect(registration.unregister).toHaveBeenCalledTimes(1);
    expect((cacheStorage.delete.mock.calls as unknown as string[][]).map((c) => c[0])).toEqual(['receipts-offline-v3', 'old']);
  });

  it('leaves everything alone when the switch cannot be read (offline must not remove the offline help)', async () => {
    const result = await syncServiceWorker({
      container,
      caches: cacheStorage,
      fetchConfig: async () => {
        throw new TypeError('Failed to fetch');
      },
    });
    expect(result).toBe('unchanged');
    expect(container.register).not.toHaveBeenCalled();
    expect(registration.unregister).not.toHaveBeenCalled();
  });

  it('a browser without service workers is fine, and a failing registration is reported, not thrown', async () => {
    expect(await syncServiceWorker({ container: null, caches: null, fetchConfig: async () => ({ serviceWorker: true }) })).toBe('unsupported');
    container.register.mockRejectedValueOnce(new Error('SecurityError'));
    expect(await syncServiceWorker({ container, caches: null, fetchConfig: async () => ({ serviceWorker: true }) })).toBe('failed');
  });
});

describe('public/sw.js: push', () => {
  const ORIGIN = 'https://receipts.example.invalid';
  const pushEvent = (data: unknown) => ({ data: { json: () => (typeof data === 'string' ? JSON.parse(data) : data) } });

  it('shows the pushed message with its tag and the page it leads to', async () => {
    const worker = loadWorker();
    await worker.dispatch('push', pushEvent({ title: 'Beleg fehlt: Zyx', body: 'Bitte hochladen.', path: '/app/spending?pruefen=p1&firma=ws', tag: 'missing_receipt:p1' }));
    expect(worker.scope.registration.showNotification).toHaveBeenCalledWith('Beleg fehlt: Zyx', {
      body: 'Bitte hochladen.',
      tag: 'missing_receipt:p1',
      icon: '/icons/notification-192.png',
      badge: '/icons/notification-badge-96.png',
      data: { url: `${ORIGIN}/app/spending?pruefen=p1&firma=ws` },
    });
  });

  it('still shows something for a message without data or with broken data', async () => {
    const worker = loadWorker();
    await worker.dispatch('push', { data: null });
    await worker.dispatch('push', { data: { json: () => JSON.parse('{broken') } });
    expect(worker.scope.registration.showNotification).toHaveBeenCalledTimes(2);
    expect(worker.scope.registration.showNotification.mock.calls[1]).toEqual(['Receipt OCR', expect.objectContaining({ data: { url: `${ORIGIN}/app/spending` } })]);
  });

  it.each(['https://evil.example/x', '//evil.example/x', '/\\evil.example/x', 'javascript:alert(1)'])('never leads to another site (%s)', async (path) => {
    const worker = loadWorker();
    await worker.dispatch('push', pushEvent({ title: 't', path }));
    const url = (worker.scope.registration.showNotification.mock.calls[0] as unknown as [string, { data: { url: string } }])[1].data.url;
    expect(new URL(url).origin).toBe(ORIGIN);
  });

  it('a tap opens the page in an open window, or a new one when there is none or it cannot be steered', async () => {
    const notification = { close: vi.fn(), data: { url: `${ORIGIN}/app/spending?pruefen=p1` } };
    const navigate = vi.fn(async () => null);
    const window = { focus: vi.fn(async function (this: unknown) { return null; }), navigate };
    const withWindow = loadWorker({ windows: [window] });
    await withWindow.dispatch('notificationclick', { notification });
    expect(notification.close).toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledWith(`${ORIGIN}/app/spending?pruefen=p1`);

    const none = loadWorker();
    await none.dispatch('notificationclick', { notification });
    expect(none.scope.clients.openWindow).toHaveBeenCalledWith(`${ORIGIN}/app/spending?pruefen=p1`);

    const stubborn = loadWorker({ windows: [{ focus: vi.fn(async () => null), navigate: vi.fn(async () => { throw new TypeError('not controlled'); }) }] });
    await stubborn.dispatch('notificationclick', { notification });
    expect(stubborn.scope.clients.openWindow).toHaveBeenCalledWith(`${ORIGIN}/app/spending?pruefen=p1`);
  });

  it('a tap on a message carrying another site opens the app instead', async () => {
    const worker = loadWorker();
    await worker.dispatch('notificationclick', { notification: { close: vi.fn(), data: { url: 'https://evil.example/' } } });
    expect(worker.scope.clients.openWindow).toHaveBeenCalledWith(`${ORIGIN}/app/spending`);
  });
});

describe('public/sw.js: a new push address', () => {
  const sub = (endpoint: string) => ({ endpoint, toJSON: () => ({ endpoint, keys: { p256dh: 'p', auth: 'a' } }) });

  it('subscribes again with the old options and tells the server old and new', async () => {
    const fetchImpl = vi.fn(async () => new Response('{}'));
    const worker = loadWorker({ fetchImpl });
    worker.scope.registration.pushManager.subscribe.mockResolvedValue(sub('https://fcm.googleapis.com/fcm/send/new'));
    await worker.dispatch('pushsubscriptionchange', { oldSubscription: { endpoint: 'https://fcm.googleapis.com/fcm/send/old', options: { userVisibleOnly: true } } });
    expect(worker.scope.registration.pushManager.subscribe).toHaveBeenCalledWith({ userVisibleOnly: true });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/spending/push-renew');
    expect(init.credentials).toBe('same-origin');
    expect(JSON.parse(init.body as string)).toEqual({ oldEndpoint: 'https://fcm.googleapis.com/fcm/send/old', subscription: { endpoint: 'https://fcm.googleapis.com/fcm/send/new', keys: { p256dh: 'p', auth: 'a' } } });
  });

  it('uses a subscription the device already has instead of subscribing again', async () => {
    const fetchImpl = vi.fn(async () => new Response('{}'));
    const worker = loadWorker({ fetchImpl });
    worker.scope.registration.pushManager.getSubscription.mockResolvedValue(sub('https://fcm.googleapis.com/fcm/send/current') as never);
    await worker.dispatch('pushsubscriptionchange', { oldSubscription: { endpoint: 'https://fcm.googleapis.com/fcm/send/old', options: {} } });
    expect(worker.scope.registration.pushManager.subscribe).not.toHaveBeenCalled();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('swallows a failing subscription and tells nobody anything', async () => {
    const fetchImpl = vi.fn(async () => new Response('{}'));
    const worker = loadWorker({ fetchImpl });
    worker.scope.registration.pushManager.subscribe.mockRejectedValue(new Error('denied'));
    await worker.dispatch('pushsubscriptionchange', { oldSubscription: { endpoint: 'https://fcm.googleapis.com/fcm/send/old', options: {} } });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
