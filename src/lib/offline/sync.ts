import { openOfflineStore, type OfflineReceiptsResponse, type OfflineStore } from './receipts-db';

/** How long a saved list of the same company counts as current. A company switch reads again at once. */
export const OFFLINE_FRESH_MS = 60 * 60 * 1000;

export const OFFLINE_RECEIPTS_URL = '/api/receipts/offline';

export type SyncResult = 'fresh' | 'saved' | 'signed-out' | 'failed' | 'stopped';

/** Every save on its way, so a sign-out can stop them before it deletes the list. */
const running = new Set<AbortController>();
/** Set by a sign-out in this tab: no save starts or writes after it (the tab leaves for the sign-out page). */
let signingOut = false;

export interface SyncDeps {
  store: OfflineStore;
  fetch: typeof fetch;
  now: () => number;
}

function browserDeps(): SyncDeps {
  return { store: openOfflineStore(), fetch: (input, init) => fetch(input, init), now: Date.now };
}

/**
 * Saves the active company's receipts on this device when there is no saved list, or it is an
 * hour old or older, belongs to another company, or carries a time ahead of the clock. A session the server no longer knows (401, 403) deletes
 * the list; a network failure or server error keeps it. An answer for another company than
 * the one asked for, or one that arrives after `signal` stopped it (the company switched, the
 * person signed out), is never written.
 */
export async function syncOfflineSnapshot(workspaceId: string, signal: AbortSignal, deps: SyncDeps = browserDeps()): Promise<SyncResult> {
  // Registered before the first read, so a sign-out in this tab stops the save in any phase. A
  // sign-out in another tab is caught by the deletion count the write compares (`OfflineStore.write`).
  const controller = new AbortController();
  const stop = () => controller.abort();
  if (signal.aborted || signingOut) return 'stopped';
  signal.addEventListener('abort', stop);
  running.add(controller);
  try {
    let kept: Awaited<ReturnType<OfflineStore['read']>>;
    try {
      kept = await deps.store.read();
    } catch {
      return 'failed';
    }
    const age = deps.now() - (kept.snapshot?.savedAt ?? 0);
    // A clock set back (age below zero) does not make an old list look new.
    if (kept.snapshot && kept.snapshot.workspaceId === workspaceId && age >= 0 && age < OFFLINE_FRESH_MS) return 'fresh';
    if (controller.signal.aborted) return 'stopped';
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
    if (!Array.isArray(body.receipts)) return 'failed';
    if (body.workspaceId !== workspaceId) {
      // The session has another company open than this page (access to this one was removed, or
      // another tab switched): the list of the company this page shows may no longer be wanted here.
      await deps.store.clear();
      return 'failed';
    }
    const saved = await deps.store.write({ ...body, savedAt: deps.now() }, kept.deletions, () => !controller.signal.aborted && !signingOut);
    return saved ? 'saved' : 'stopped';
  } finally {
    running.delete(controller);
    signal.removeEventListener('abort', stop);
  }
}

/** Signing out: stops every save on its way and every later one in this tab, then deletes the list. */
export async function clearOfflineSnapshot(store: OfflineStore = openOfflineStore()): Promise<void> {
  signingOut = true;
  for (const controller of running) controller.abort();
  await store.clear();
}

/** Tests only: a fresh tab. */
export function resetOfflineSyncForTests(): void {
  signingOut = false;
  running.clear();
}
