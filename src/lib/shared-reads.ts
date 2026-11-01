import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * One read per thing per page (plan docs/plans/2026-10-26-fast-dashboard-and-spending.md,
 * decision 1). A page render opens a scope with `withSharedReads`; inside it,
 * `sharedRead` reads each key once and hands every later caller the same
 * answer, also callers running side by side. Outside a scope it only reads.
 *
 * Only page renders open a scope: they read and never write, so nothing read
 * here can be outdated by a write in the same scope. An action that writes and
 * then reads runs outside any scope and always reads afresh. A read that fails
 * is not kept: the next caller tries again.
 */

const current = new AsyncLocalStorage<{ reads: Map<string, Promise<unknown>>; startedAt: number }>();

export function withSharedReads<T>(run: () => Promise<T>): Promise<T> {
  return current.run({ reads: new Map(), startedAt: Date.now() }, run);
}

/**
 * When what is about to be read was read: the start of the scope, as another
 * caller may have started a shared read long before this one asks. Outside a
 * scope, now.
 */
export function readsStartedAt(): number {
  return current.getStore()?.startedAt ?? Date.now();
}

export function sharedRead<T>(key: string, read: () => Promise<T>): Promise<T> {
  const reads = current.getStore()?.reads;
  if (!reads) return read();
  const kept = reads.get(key);
  if (kept) return kept as Promise<T>;
  const reading = read();
  reads.set(key, reading);
  reading.catch(() => {
    if (reads.get(key) === reading) reads.delete(key);
  });
  return reading;
}
