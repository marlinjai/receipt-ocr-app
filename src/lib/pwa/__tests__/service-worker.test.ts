import { readFileSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CAPTURE_DB_NAME, CAPTURE_DB_VERSION, CAPTURE_STORE_NAME } from '@/lib/capture/offline-queue';
import { syncServiceWorker } from '../service-worker';

const PUBLIC = path.resolve(__dirname, '../../../../public');
const SW_SOURCE = readFileSync(path.join(PUBLIC, 'sw.js'), 'utf8');
const OFFLINE_SOURCE = readFileSync(path.join(PUBLIC, 'offline.html'), 'utf8');

/** Run public/sw.js itself inside a fake worker scope. */
function loadWorker(options: { online?: boolean; existingCaches?: string[] } = {}) {
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
    clients: { claim: vi.fn(async () => {}) },
  };

  // In a worker a relative URL resolves against the worker's origin; under node it does not.
  class ScopedRequest extends Request {
    constructor(input: string, init?: RequestInit) {
      super(new URL(input, scope.location.origin).toString(), init);
    }
  }

  new Function('self', 'caches', 'fetch', 'Request', SW_SOURCE)(scope, caches, network, ScopedRequest);

  async function lifecycle(type: 'install' | 'activate') {
    let pending: Promise<unknown> = Promise.resolve();
    listeners.get(type)!({ waitUntil: (p: Promise<unknown>) => (pending = p) });
    await pending;
  }

  /** Dispatch a fetch event; resolves to the worker's response, or null when it did not handle the request. */
  async function request(pathname: string, init: { method?: string; mode?: string; origin?: string } = {}) {
    let responded: Promise<Response> | null = null;
    const req = {
      url: `${init.origin ?? scope.location.origin}${pathname}`,
      method: init.method ?? 'GET',
      mode: init.mode ?? 'no-cors',
    };
    listeners.get('fetch')!({ request: req, respondWith: (p: Promise<Response>) => (responded = p) });
    return responded ? await (responded as Promise<Response>) : null;
  }

  return { scope, caches, stores, network, lifecycle, request, setOnline: (v: boolean) => (online = v) };
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
    expect(SW_SOURCE).not.toMatch(/\.put\(/);
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
