'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Row } from '@marlinjai/data-table-core';

/**
 * The rows of the receipts table, complete and each once.
 *
 * The table package loads its rows in pages and appends every answer at the
 * offset it counted itself, with no guard against two loads at once: a reload
 * that starts while a page is still on its way resets the count, and the late
 * page is then appended to the fresh list and counted on top. The next page is
 * asked at the wrong place, the same rows come again and others never come.
 * Seen on production on 2026-10-11: after a few dozen cell edits (some of which
 * failed and reloaded the table while it was still loading) the header said 917
 * items for 267 receipts.
 *
 * Three things here keep that from reaching the page:
 *
 * - **One load at a time.** Every next page and every reload of the dashboard
 *   goes through one queue, and each waits until the table has no load in
 *   flight. A reload asked for while a page is loading runs after it.
 * - **Each row once.** Should a row arrive twice anyway (a load the queue does
 *   not see, such as the one the package starts itself when a filter or a sort
 *   changes), the page shows it once: the first place it was drawn, with what
 *   the latest edit stored there (an edit replaces every copy).
 * - **A list that does not add up is loaded again.** Once nothing is loading,
 *   a list with a row twice, or with another number of rows than the server
 *   counted, cannot be trusted for counts and sums: it is reloaded, at most
 *   twice in a row, so a list that never adds up cannot reload forever.
 *
 * A load that fails is not asked again by itself (that would ask the server
 * without end while it is down): the list stays as it was and the failure is
 * the package's `rowsError`, which the page says. The next reload starts over.
 */

export interface RowsSource {
  rows: Row[];
  /** How many rows the server counted for the list, as of its last answer. */
  total: number;
  hasMore: boolean;
  isLoading: boolean;
  /** The failure of the last load, or null. */
  error: Error | null;
  loadMore: () => Promise<void>;
  refresh: () => Promise<void>;
}

/** The most reloads in a row for a list that does not add up. */
export const MAX_REPAIRS = 2;

/** The rows, each once, in the place it was first drawn. */
export function uniqueRows(rows: readonly Row[]): Row[] {
  const seen = new Set<string>();
  const out: Row[] = [];
  for (const row of rows) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    out.push(row);
  }
  return out;
}

export function useCompleteRows(source: RowsSource): {
  rows: Row[];
  /**
   * Load the list again, after whatever load is on its way. Resolves when it is done; a failed load
   * is not a rejection (the package keeps it as `rowsError`).
   */
  reload: () => Promise<void>;
} {
  const { rows: loaded, total, hasMore, isLoading, error } = source;
  const rows = useMemo(() => uniqueRows(loaded), [loaded]);

  // The package hands out new functions on every render; the queue always calls the latest.
  const latest = useRef(source);
  const idleWaiters = useRef<Array<() => void>>([]);
  useEffect(() => {
    latest.current = source;
    if (!source.isLoading) {
      const waiting = idleWaiters.current;
      idleWaiters.current = [];
      for (const resume of waiting) resume();
    }
  });

  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const [pending, setPending] = useState(0);
  const enqueue = useCallback((op: () => Promise<void>): Promise<void> => {
    setPending((n) => n + 1);
    const whenIdle = () =>
      latest.current.isLoading ? new Promise<void>((resume) => idleWaiters.current.push(resume)) : Promise.resolve();
    const run = queue.current.then(async () => {
      await whenIdle();
      await op();
    });
    // A failed load does not stop the loads after it.
    queue.current = run.catch(() => undefined);
    return run.finally(() => setPending((n) => n - 1));
  }, []);

  const reload = useCallback(() => enqueue(() => latest.current.refresh()), [enqueue]);

  // The table shows every receipt of the years it was asked for: sums, groups and the review of a year are
  // wrong on a partial list. The next page is asked for as soon as the previous one is in, until nothing is left.
  useEffect(() => {
    if (hasMore && !isLoading && !error && pending === 0) {
      void enqueue(() => latest.current.loadMore()).catch(() => undefined);
    }
  }, [hasMore, isLoading, error, pending, enqueue]);

  const repairs = useRef(0);
  useEffect(() => {
    if (hasMore || isLoading || error || pending > 0) return;
    if (rows.length === loaded.length && rows.length === total) {
      repairs.current = 0;
      return;
    }
    if (repairs.current >= MAX_REPAIRS) return;
    repairs.current += 1;
    void enqueue(() => latest.current.refresh()).catch(() => undefined);
  }, [rows, loaded, total, hasMore, isLoading, error, pending, enqueue]);

  return { rows, reload };
}
