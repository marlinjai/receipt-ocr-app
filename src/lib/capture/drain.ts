import { uploadFailureKind } from '@/lib/upload/errors';
import type { PipelineOutcome } from '@/lib/upload/pipeline';
import { queuedFile, type CaptureStore, type QueuedCapture } from './offline-queue';

/**
 * Send what is waiting in the capture queue, oldest first.
 *
 * Rules, each of which exists because the alternative loses a receipt or sends
 * it twice:
 *  - an entry leaves the queue ONLY after the server has it (saved, or
 *    recognised as a file that is already there);
 *  - a dead connection or an expired session stops the run and keeps
 *    everything: retrying the rest would fail the same way;
 *  - any other failure keeps that entry with its error and moves on, so one
 *    bad file does not block the photos behind it;
 *  - a photo the server has is never sent again, even when the browser could
 *    not remove its entry. Sending and removing are two separate steps with
 *    two separate outcomes: a failed removal marks the entry as sent
 *    (`sentAt`), and every later run only tries the removal again. The upload
 *    pipeline would recognise the same file as a duplicate, but that check
 *    stops helping once the receipt was deleted on purpose, and it would still
 *    report a saved photo as a failure.
 */

/** Stored as `lastError` on an entry that was sent but could not be removed. Translated in messages.ts. */
export const SENT_NOT_CLEARED = 'Sent, but could not be cleared from the queue';

export interface DrainedEntry {
  entry: QueuedCapture;
  outcome: PipelineOutcome;
}

export interface DrainResult {
  /** Photos the server took in THIS run (saved, or already there). */
  sent: DrainedEntry[];
  /** Entries still in the queue after this run, sent-but-stuck ones included. */
  remaining: number;
  /** Why the run ended early, if it did. */
  stopped: 'offline' | 'auth' | null;
  /** Entries that could not be sent for another reason and stay queued with their error. */
  failed: number;
  /** Entries the server has (from this run or an earlier one) that could not be removed. They are not sent again. */
  stuck: number;
  /** Entries sent in an earlier run whose removal succeeded now. */
  cleared: number;
}

export interface DrainOptions {
  isOnline?: () => boolean;
  onProgress?: (done: number, total: number) => void;
  now?: () => number;
}

/**
 * Entries sent through a store that could neither remove nor mark them (a
 * browser whose storage stopped accepting writes). Kept per store object, so
 * at least the open page does not send them again; after a reload the
 * pipeline's duplicate check is the remaining guard.
 */
const sentWithoutMarker = new WeakMap<CaptureStore, Set<string>>();

function unmarked(store: CaptureStore): Set<string> {
  let ids = sentWithoutMarker.get(store);
  if (!ids) {
    ids = new Set();
    sentWithoutMarker.set(store, ids);
  }
  return ids;
}

/** Remove an entry the server already has. Returns false, and marks it as sent, when the removal fails. */
async function clearSent(store: CaptureStore, entry: QueuedCapture, now: number): Promise<boolean> {
  try {
    await store.remove(entry.id);
    unmarked(store).delete(entry.id);
    return true;
  } catch {
    try {
      await store.update(entry.id, { sentAt: entry.sentAt ?? now, lastError: SENT_NOT_CLEARED });
    } catch {
      unmarked(store).add(entry.id);
    }
    return false;
  }
}

export async function drainQueue(
  store: CaptureStore,
  send: (file: File, entry: QueuedCapture) => Promise<PipelineOutcome>,
  options: DrainOptions = {},
): Promise<DrainResult> {
  const isOnline = options.isOnline ?? (() => true);
  const now = options.now ?? (() => Date.now());
  const entries = await store.list();
  const sent: DrainedEntry[] = [];
  let stopped: DrainResult['stopped'] = null;
  let failed = 0;
  let stuck = 0;
  let cleared = 0;

  for (const [index, entry] of entries.entries()) {
    // Sent in an earlier run: only the removal is left. That needs no
    // connection, so it happens before the online check and after a stop.
    if (entry.sentAt !== null || unmarked(store).has(entry.id)) {
      if (await clearSent(store, entry, now())) cleared += 1;
      else stuck += 1;
      continue;
    }
    if (stopped) continue;
    if (!isOnline()) {
      stopped = 'offline';
      continue;
    }
    options.onProgress?.(index, entries.length);
    let outcome: PipelineOutcome;
    try {
      outcome = await send(queuedFile(entry), entry);
    } catch (err) {
      const kind = uploadFailureKind(err);
      const message = err instanceof Error ? err.message : 'Sending failed';
      if (kind === 'network') {
        await store.update(entry.id, { lastError: message });
        stopped = 'offline';
        continue;
      }
      if (kind === 'auth') {
        stopped = 'auth';
        continue;
      }
      failed += 1;
      await store.update(entry.id, { attempts: entry.attempts + 1, lastError: message });
      continue;
    }
    // Saved, or already there: either way the server has this file now. What
    // happens to the queue entry from here on cannot turn that into a failure.
    sent.push({ entry, outcome });
    if (!(await clearSent(store, entry, now()))) stuck += 1;
  }

  return { sent, remaining: (await store.list()).length, stopped, failed, stuck, cleared };
}

/** Run at most one drain at a time; a second caller gets the run already in flight. */
export function singleFlight<T>(work: () => Promise<T>): () => Promise<T> {
  let inFlight: Promise<T> | null = null;
  return () => {
    if (!inFlight) {
      inFlight = work().finally(() => {
        inFlight = null;
      });
    }
    return inFlight;
  };
}
