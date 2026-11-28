import { openOfflineStore, type OfflineReceiptsResponse, type OfflineStore } from './receipts-db';

/** How long a saved list counts as current: one read of all receipts per hour at most. */
export const OFFLINE_FRESH_MS = 60 * 60 * 1000;

export const OFFLINE_RECEIPTS_URL = '/api/receipts/offline';

export type SyncResult = 'fresh' | 'saved' | 'signed-out' | 'failed' | 'stopped';

/** Every save on its way, so a sign-out can stop them before it deletes the list. */
const running = new Set<AbortController>();

export interface SyncDeps {
  store: OfflineStore;
  fetch: typeof fetch;
  now: () => number;
}

function browserDeps(): SyncDeps {
  return { store: openOfflineStore(), fetch: (input, init) => fetch(input, init), now: Date.now };
}

/**
 * Saves the active company's receipts on this device when the saved list is older than an
 * hour or belongs to another company. A session the server no longer knows (401, 403) deletes
 * the list; a network failure or server error keeps it. An answer for another company than
 * the one asked for, or one that arrives after `signal` stopped it (the company switched, the
 * person signed out), is never written.
 */
export async function syncOfflineSnapshot(workspaceId: string, signal: AbortSignal, deps: SyncDeps = browserDeps()): Promise<SyncResult> {
  const stopped = () => signal.aborted;
  const kept = await deps.store.read().catch(() => null);
  if (kept && kept.workspaceId === workspaceId && deps.now() - kept.savedAt < OFFLINE_FRESH_MS) return 'fresh';
  const controller = new AbortController();
  const stop = () => controller.abort();
  signal.addEventListener('abort', stop);
  running.add(controller);
  try {
    let response: Response;
    try {
      response = await deps.fetch(OFFLINE_RECEIPTS_URL, { credentials: 'same-origin', cache: 'no-store', signal: controller.signal });
    } catch {
      return controller.signal.aborted ? 'stopped' : 'failed';
    }
    if (response.status === 401 || response.status === 403) {
      await deps.store.clear();
      return 'signed-out';
    }
    if (!response.ok) return 'failed';
    let body: OfflineReceiptsResponse;
    try {
      body = (await response.json()) as OfflineReceiptsResponse;
    } catch {
      return controller.signal.aborted ? 'stopped' : 'failed';
    }
    if (body.workspaceId !== workspaceId || !Array.isArray(body.receipts)) return 'failed';
    const saved = await deps.store.write({ ...body, savedAt: deps.now() }, () => !controller.signal.aborted && !stopped());
    return saved ? 'saved' : 'stopped';
  } finally {
    running.delete(controller);
    signal.removeEventListener('abort', stop);
  }
}

/** Signing out: stops every save on its way, then deletes the list. */
export async function clearOfflineSnapshot(store: OfflineStore = openOfflineStore()): Promise<void> {
  for (const controller of running) controller.abort();
  await store.clear();
}
