'use client';

import { useEffect } from 'react';
import { syncServiceWorker } from '@/lib/pwa/service-worker';

/** Registers the service worker, or withdraws it when the server's kill switch says so. */
export function ServiceWorkerRegistrar() {
  useEffect(() => {
    void syncServiceWorker({
      container: 'serviceWorker' in navigator ? navigator.serviceWorker : null,
      caches: 'caches' in window ? window.caches : null,
      fetchConfig: async () => {
        const res = await fetch('/api/client-config', { cache: 'no-store' });
        if (!res.ok) throw new Error(`client-config ${res.status}`);
        return (await res.json()) as { serviceWorker: boolean };
      },
    }).then((result) => {
      // The worker is a convenience (offline capture); the app works without it.
      if (result === 'failed') console.warn('[service worker] could not be registered or withdrawn');
    });
  }, []);

  return null;
}
