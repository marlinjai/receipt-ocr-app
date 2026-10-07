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
 *    bad file does not block the photos behind it.
 */

export interface DrainedEntry {
  entry: QueuedCapture;
  outcome: PipelineOutcome;
}

export interface DrainResult {
  sent: DrainedEntry[];
  /** Entries still in the queue after this run. */
  remaining: number;
  /** Why the run ended early, if it did. */
  stopped: 'offline' | 'auth' | null;
  /** Entries that failed for another reason and stay queued with their error. */
  failed: number;
}

export interface DrainOptions {
  isOnline?: () => boolean;
  onProgress?: (done: number, total: number) => void;
}

export async function drainQueue(
  store: CaptureStore,
  send: (file: File, entry: QueuedCapture) => Promise<PipelineOutcome>,
  options: DrainOptions = {},
): Promise<DrainResult> {
  const isOnline = options.isOnline ?? (() => true);
  const entries = await store.list();
  const sent: DrainedEntry[] = [];
  let stopped: DrainResult['stopped'] = null;
  let failed = 0;

  for (const [index, entry] of entries.entries()) {
    if (!isOnline()) {
      stopped = 'offline';
      break;
    }
    options.onProgress?.(index, entries.length);
    try {
      const outcome = await send(queuedFile(entry), entry);
      // Saved, or already there: either way the server has this file now.
      await store.remove(entry.id);
      sent.push({ entry, outcome });
    } catch (err) {
      const kind = uploadFailureKind(err);
      const message = err instanceof Error ? err.message : 'Sending failed';
      if (kind === 'network') {
        await store.update(entry.id, { lastError: message });
        stopped = 'offline';
        break;
      }
      if (kind === 'auth') {
        stopped = 'auth';
        break;
      }
      failed += 1;
      await store.update(entry.id, { attempts: entry.attempts + 1, lastError: message });
    }
  }

  return { sent, remaining: (await store.list()).length, stopped, failed };
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
