/**
 * Registering (or withdrawing) the service worker, as one testable function.
 *
 * The kill switch: the server decides. `GET /api/client-config` answers
 * `{ serviceWorker: boolean }`; false makes every client unregister the worker
 * and delete its caches on its next page load, so a faulty worker can be
 * withdrawn by setting one environment variable and restarting the app,
 * without shipping new code. When the answer cannot be fetched (offline), the
 * current state is left alone: being offline must not remove the very thing
 * that helps offline.
 */

export interface ServiceWorkerEnvironment {
  /** Null when the browser has no service workers. */
  container: Pick<ServiceWorkerContainer, 'register' | 'getRegistrations'> | null;
  caches: Pick<CacheStorage, 'keys' | 'delete'> | null;
  fetchConfig: () => Promise<{ serviceWorker: boolean }>;
}

export type ServiceWorkerSync = 'unsupported' | 'registered' | 'withdrawn' | 'unchanged' | 'failed';

export async function syncServiceWorker(env: ServiceWorkerEnvironment): Promise<ServiceWorkerSync> {
  if (!env.container) return 'unsupported';
  let enabled: boolean;
  try {
    enabled = (await env.fetchConfig()).serviceWorker === true;
  } catch {
    return 'unchanged';
  }
  try {
    if (enabled) {
      await env.container.register('/sw.js', { scope: '/' });
      return 'registered';
    }
    const registrations = await env.container.getRegistrations();
    await Promise.all(registrations.map((r) => r.unregister()));
    if (env.caches) {
      const keys = await env.caches.keys();
      await Promise.all(keys.map((key) => env.caches!.delete(key)));
    }
    return 'withdrawn';
  } catch {
    return 'failed';
  }
}
