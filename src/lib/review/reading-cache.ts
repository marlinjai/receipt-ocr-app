import 'server-only';
import { createHash } from 'node:crypto';
import { newReading, type NewReading, type StoredReading } from './reading';

/**
 * The new reading of a stored receipt, kept in memory by what it is read from
 * (plan docs/plans/2026-10-26-fast-dashboard-and-spending.md, decision 2).
 * `newReading` reads the whole stored text again, about 2 ms a receipt, and the
 * review list asks it for every receipt on each visit. Its answer depends on
 * the stored reading alone, so a changed text or field is a new key and is read
 * again; a new deploy starts empty. The oldest entries go first beyond the bound.
 */

const MAX_ENTRIES = 5_000;
const kept = new Map<string, NewReading>();

export function cachedReading(stored: StoredReading): NewReading {
  const key = createHash('sha1').update(JSON.stringify(stored)).digest('base64');
  let reading = kept.get(key);
  if (reading) {
    // Used again: it moves to the end, so the oldest unused entry is the first to go.
    kept.delete(key);
  } else {
    reading = newReading(stored);
    if (kept.size >= MAX_ENTRIES) kept.delete(kept.keys().next().value as string);
  }
  kept.set(key, reading);
  // A copy: a caller that changes what it got cannot change what the next caller gets.
  return structuredClone(reading);
}

/** For tests: how many readings are kept, and forget them all. */
export const readingCacheSize = () => kept.size;
export function forgetReadings(): void {
  kept.clear();
}
