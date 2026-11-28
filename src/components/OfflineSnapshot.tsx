'use client';

import { useEffect } from 'react';
import { syncOfflineSnapshot, type SyncDeps } from '@/lib/offline/sync';

/** How long after the page opened the list is saved: never while the page itself still loads. */
export const OFFLINE_SAVE_DELAY_MS = 5000;

/**
 * Keeps the receipts list of the offline page current on this device (plan
 * docs/plans/2026-11-28-offline-receipts.md). Mounted once inside the store provider of the
 * `/app` layout, which is keyed by the company: a switch unmounts it, which stops a save still
 * on its way, and mounts it again for the new company. Renders nothing.
 */
export function OfflineSnapshot({ workspaceId, deps }: { workspaceId: string; deps?: SyncDeps }) {
  useEffect(() => {
    if (typeof indexedDB === 'undefined' && !deps) return;
    const controller = new AbortController();
    let busy = false;
    const save = () => {
      if (busy || controller.signal.aborted || !navigator.onLine) return;
      busy = true;
      // A save that fails is tried again on the next page or when the app returns to the foreground.
      void syncOfflineSnapshot(workspaceId, controller.signal, deps)
        .catch(() => 'failed')
        .finally(() => {
          busy = false;
        });
    };
    const timer = setTimeout(save, OFFLINE_SAVE_DELAY_MS);
    const onVisible = () => {
      if (document.visibilityState === 'visible') save();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
      controller.abort();
    };
  }, [workspaceId, deps]);
  return null;
}
