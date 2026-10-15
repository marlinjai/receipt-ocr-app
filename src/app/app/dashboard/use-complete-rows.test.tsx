// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { useEffect } from 'react';
import { DataTableProvider, useTable } from '@marlinjai/data-table-react';
import type { DatabaseAdapter, QueryOptions, QueryResult, Row } from '@marlinjai/data-table-core';
import { MAX_REPAIRS, uniqueRows, useCompleteRows } from './use-complete-rows';

/**
 * The receipts table's loader against the REAL table package, with a fake
 * database whose answers the test releases one by one, in any order. This is
 * how the doubled rows of 2026-10-11 came about: a reload that starts while a
 * page is on its way.
 */

afterEach(cleanup);

const PAGE = 2;
const row = (n: number): Row => ({ id: `r${n}`, tableId: 't', cells: { name: `r${n}` }, archived: false, createdAt: new Date(0), updatedAt: new Date(0) });
const ALL = [1, 2, 3, 4, 5, 6].map(row);

interface Call {
  offset: number;
  resolve: () => void;
  reject: (error: Error) => void;
}

/** A database whose list answers wait until the test releases them. */
function fakeDatabase(options: { claimTotal?: number } = {}) {
  const calls: Call[] = [];
  // What the database holds; a test may add a receipt while the pages come in.
  const data = [...ALL];
  const adapter = {
    getTable: async () => ({ id: 't', workspaceId: 'w', name: 'Receipts', createdAt: new Date(0), updatedAt: new Date(0) }),
    getColumns: async () => [{ id: 'name', tableId: 't', name: 'Name', type: 'text', position: 0, width: 200, isPrimary: true, config: {}, createdAt: new Date(0) }],
    getSelectOptions: async () => [],
    getRows: (_tableId: string, query?: QueryOptions) =>
      new Promise<QueryResult<Row>>((resolve, reject) => {
        const offset = query?.offset ?? 0;
        const limit = query?.limit ?? PAGE;
        calls.push({
          offset,
          // The page as the database holds it at the moment it answers.
          resolve: () => {
            const items = data.slice(offset, offset + limit);
            resolve({ items, total: options.claimTotal ?? data.length, hasMore: offset + items.length < data.length });
          },
          reject,
        });
      }),
  } as unknown as DatabaseAdapter;
  return { adapter, calls, data };
}

interface Handle {
  shown: Row[];
  loaded: Row[];
  reload: () => Promise<void>;
  refresh: () => Promise<void>;
  isLoading: boolean;
  hasMore: boolean;
  error: Error | null;
  settled: boolean;
}
type Report = (handle: Handle) => void;

/** The dashboard's way of loading: the package's table plus `useCompleteRows`. */
function Guarded({ report }: { report: Report }) {
  const table = useTable({ tableId: 't', pageSize: PAGE });
  const { rows, reload, settled } = useCompleteRows({
    rows: table.rows,
    total: table.total,
    hasMore: table.hasMore,
    isLoading: table.isRowsLoading,
    error: table.rowsError,
    loadMore: table.loadMore,
    refresh: table.refresh,
  });
  useEffect(() => {
    report({ shown: rows, loaded: table.rows, reload, refresh: table.refresh, isLoading: table.isRowsLoading, hasMore: table.hasMore, error: table.rowsError, settled });
  });
  return null;
}

/** The loader as it was before: the next page as soon as nothing loads, and reloads straight to the package. */
function Unguarded({ report }: { report: Report }) {
  const table = useTable({ tableId: 't', pageSize: PAGE });
  const { hasMore, isRowsLoading, loadMore } = table;
  useEffect(() => {
    if (hasMore && !isRowsLoading) void loadMore();
  }, [hasMore, isRowsLoading, loadMore]);
  useEffect(() => {
    report({ shown: table.rows, loaded: table.rows, reload: table.refresh, refresh: table.refresh, isLoading: table.isRowsLoading, hasMore: table.hasMore, error: table.rowsError, settled: false });
  });
  return null;
}

function mount(Loader: typeof Guarded, adapter: DatabaseAdapter) {
  const handle: { current: Handle | null } = { current: null };
  return mountWith(Loader, adapter, handle);
}
function mountWith(Loader: typeof Guarded, adapter: DatabaseAdapter, handle: { current: Handle | null }) {
  render(
    <DataTableProvider dbAdapter={adapter} workspaceId="w">
      <Loader report={(h) => (handle.current = h)} />
    </DataTableProvider>,
  );
  return handle;
}

const ids = (rows: Row[] | undefined) => (rows ?? []).map((r) => r.id);
const release = async (call: Call | undefined) => {
  if (!call) throw new Error('no such call');
  await act(async () => call.resolve());
};
const nthCall = async (calls: Call[], n: number) => {
  await waitFor(() => expect(calls.length).toBeGreaterThanOrEqual(n));
  return calls[n - 1];
};
/** Answers every list request as it comes, until the list has settled. */
async function settle(handle: { current: Handle | null }, calls: Call[]) {
  await waitFor(
    async () => {
      for (const call of calls.splice(0)) await release(call);
      expect(handle.current?.isLoading).toBe(false);
      expect(handle.current?.hasMore).toBe(false);
      expect(calls.length).toBe(0);
    },
    { timeout: 3000 },
  );
}

/** A reload asked for while the third page is on its way, released in the order that broke the table. */
async function reloadWhileAPageLoads(handle: { current: Handle | null }, calls: Call[]) {
  await release(await nthCall(calls, 1)); // r1 r2
  await release(await nthCall(calls, 2)); // r3 r4
  const third = await nthCall(calls, 3); // r5 r6 on its way
  expect(third.offset).toBe(4);
  let reloading: Promise<void> | undefined;
  act(() => {
    reloading = handle.current!.reload();
  });
  return { third, reloading: () => reloading };
}

describe('the rows of the receipts table', () => {
  it('without the guard, a reload during a page doubles rows and loses others (the defect of 2026-10-11)', async () => {
    const { adapter, calls } = fakeDatabase();
    const handle = mount(Unguarded, adapter);
    const { third } = await reloadWhileAPageLoads(handle, calls);
    // The reload goes out at once, beside the page, and its answer arrives first.
    const reload = await nthCall(calls, 4);
    expect(reload.offset).toBe(0);
    await release(reload);
    // The table thinks nothing loads any more and goes on from the reload: offset 2, then offset 4 again.
    const second = await nthCall(calls, 5);
    expect(second.offset).toBe(2);
    await release(second);
    const again = await nthCall(calls, 6);
    expect(again.offset).toBe(4);
    // Now the late page arrives, and the page asked again after it.
    await release(third);
    await release(again);
    await settle(handle, calls);
    const shown = ids(handle.current?.shown);
    expect(shown).toEqual(['r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'r5', 'r6']);
  });

  it('with the guard, the reload waits for the page and the list is complete and each row once', async () => {
    const { adapter, calls } = fakeDatabase();
    const handle = mount(Guarded, adapter);
    const { third, reloading } = await reloadWhileAPageLoads(handle, calls);
    // Nothing else goes out while the page is on its way.
    await new Promise((r) => setTimeout(r, 20));
    expect(calls.length).toBe(3);
    await release(third);
    const reload = await nthCall(calls, 4);
    expect(reload.offset).toBe(0);
    await settle(handle, calls);
    await act(async () => reloading());
    expect(ids(handle.current?.shown)).toEqual(ids(ALL));
    expect(ids(handle.current?.loaded)).toEqual(ids(ALL));
  });

  it('shows a row once when the pages overlap, and loads the list again once it is in', async () => {
    const { adapter, calls, data } = fakeDatabase();
    const handle = mount(Guarded, adapter);
    await release(await nthCall(calls, 1)); // r1 r2
    // A receipt arrives elsewhere (an upload in another tab) and moves every row by one.
    data.unshift(row(0));
    await release(await nthCall(calls, 2)); // r2 again, r3
    expect(ids(handle.current?.loaded)).toEqual(['r1', 'r2', 'r2', 'r3']);
    expect(ids(handle.current?.shown)).toEqual(['r1', 'r2', 'r3']);
    expect(handle.current?.settled).toBe(false);
    await settle(handle, calls);
    // Once in, it did not add up and was loaded again: now complete, with the new receipt, each once.
    await waitFor(
      async () => {
        for (const call of calls.splice(0)) await release(call);
        expect(ids(handle.current?.loaded)).toEqual(['r0', ...ids(ALL)]);
        expect(handle.current?.settled).toBe(true);
      },
      { timeout: 3000 },
    );
    expect(ids(handle.current?.shown)).toEqual(['r0', ...ids(ALL)]);
  });

  it('loads the list again when a load beside the queue left rows out', async () => {
    const { adapter, calls } = fakeDatabase();
    const handle = mount(Guarded, adapter);
    await release(await nthCall(calls, 1));
    await release(await nthCall(calls, 2));
    const third = await nthCall(calls, 3);
    // A load beside the queue (the package's own, as on a filter change), released in the bad order.
    act(() => {
      void handle.current!.refresh();
    });
    const beside = await nthCall(calls, 4);
    await release(beside);
    await release(third);
    await settle(handle, calls);
    // The list was found not to add up and was loaded again, complete; only then is it settled.
    await waitFor(
      async () => {
        for (const call of calls.splice(0)) await release(call);
        expect(ids(handle.current?.loaded)).toEqual(ids(ALL));
        expect(handle.current?.settled).toBe(true);
      },
      { timeout: 3000 },
    );
    expect(ids(handle.current?.shown)).toEqual(ids(ALL));
  });

  it('a reload waiting for a load lets go when the page is left', async () => {
    const { adapter, calls } = fakeDatabase();
    const handle = mount(Guarded, adapter);
    await nthCall(calls, 1); // the first page never answers
    let waiting: Promise<void> | undefined;
    act(() => {
      waiting = handle.current!.reload();
    });
    cleanup();
    await expect(waiting).resolves.toBeUndefined();
    expect(calls.length).toBe(1);
  });

  it('a failed reload is kept as the error, is not asked again by itself, and the next reload still runs', async () => {
    const { adapter, calls } = fakeDatabase();
    const failing = adapter.getRows;
    let fail = false;
    let asked = 0;
    adapter.getRows = (tableId, query) => {
      asked++;
      return fail ? Promise.reject(new Error('offline')) : failing(tableId, query);
    };
    const handle = mount(Guarded, adapter);
    await settle(handle, calls);
    fail = true;
    const before = asked;
    // The reload resolves; the failure is the error the page shows.
    await act(async () => handle.current!.reload());
    await waitFor(() => expect(handle.current?.error?.message).toBe('offline'));
    expect(handle.current?.settled).toBe(true);
    // The list as it was stays, and nothing is asked again while the server fails.
    expect(ids(handle.current?.shown)).toEqual(ids(ALL));
    await new Promise((r) => setTimeout(r, 50));
    expect(asked).toBe(before + 1);
    fail = false;
    let again: Promise<void> | undefined;
    act(() => {
      again = handle.current!.reload();
    });
    expect((await nthCall(calls, 1)).offset).toBe(0);
    await settle(handle, calls);
    await act(async () => again);
    expect(ids(handle.current?.shown)).toEqual(ids(ALL));
    expect(handle.current?.error).toBeNull();
  });

  it('a page that fails mid-load is not asked again without end', async () => {
    const { adapter, calls } = fakeDatabase();
    const handle = mount(Guarded, adapter);
    await release(await nthCall(calls, 1));
    const second = await nthCall(calls, 2);
    await act(async () => second.reject(new Error('offline')));
    await waitFor(() => expect(handle.current?.error?.message).toBe('offline'));
    // Settled on the failure: a linked receipt is not waited for without end.
    expect(handle.current?.settled).toBe(true);
    await new Promise((r) => setTimeout(r, 50));
    expect(calls.length).toBe(2);
    expect(ids(handle.current?.shown)).toEqual(['r1', 'r2']);
    // A reload starts over and loads everything.
    calls.splice(0);
    let again: Promise<void> | undefined;
    act(() => {
      again = handle.current!.reload();
    });
    expect((await nthCall(calls, 1)).offset).toBe(0);
    await settle(handle, calls);
    await act(async () => again);
    expect(ids(handle.current?.shown)).toEqual(ids(ALL));
  });

  it('reloads a list that never adds up only a bounded number of times', async () => {
    // The server says there are seven rows; only six ever come.
    const { adapter, calls } = fakeDatabase({ claimTotal: 7 });
    const handle = mount(Guarded, adapter);
    let firstPages = 0;
    await waitFor(
      async () => {
        for (const call of calls.splice(0)) {
          if (call.offset === 0) firstPages++;
          await release(call);
        }
        expect(firstPages).toBe(1 + MAX_REPAIRS);
        expect(handle.current?.isLoading).toBe(false);
      },
      { timeout: 3000 },
    );
    await new Promise((r) => setTimeout(r, 50));
    expect(calls.length).toBe(0);
    expect(ids(handle.current?.shown)).toEqual(ids(ALL));
  });
});

describe('each row once', () => {
  it('keeps the first place of a row and drops its copies', () => {
    const a = row(1);
    const b = row(2);
    const later = { ...a, cells: { name: 'copy' } };
    expect(uniqueRows([a, b, later, b])).toEqual([a, b]);
    expect(uniqueRows([])).toEqual([]);
  });
});
