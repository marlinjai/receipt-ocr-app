import { autorun } from 'mobx';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CellValue, Column, FileReference, QueryOptions, QueryResult, Row, UploadedFile } from '@marlinjai/data-table-core';
import { ROW_KIND_COLUMN, GROUP_KIND } from '@/lib/receipts-kind';
import { NO_YEARS, type YearScope, type YearSelection } from '@/lib/receipt-years';
import type { ReviewEntry } from '@/lib/review/service';
import { AppStore } from '../AppStore';
import { COUNTS_DELAY_MS, MAX_REPAIRS, PAGE_SIZE, ReceiptsStore, uniqueRows, type ReceiptsApi, type ReceiptsSeed } from '../ReceiptsStore';

type Query = QueryOptions & YearScope;

const NAME = 'col_name';
const KIND = 'col_kind';
const columns = [
  { id: NAME, name: 'Name' },
  { id: KIND, name: ROW_KIND_COLUMN },
] as unknown as Column[];

const row = (id: string, name = id, o: Partial<Row> = {}): Row => ({ id, tableId: 't', cells: { [NAME]: name }, ...o }) as unknown as Row;
const groupRow = (id: string) => row(id, id, { cells: { [NAME]: id, [KIND]: GROUP_KIND } });
const rowsOf = (n: number, from = 0) => Array.from({ length: n }, (_, i) => row(`r${from + i}`));
const entry = (rowId: string, duplicates: string[] = []) => ({ rowId, duplicates: duplicates.map((d) => ({ rowId: d })) }) as unknown as ReviewEntry;
const ids = (store: ReceiptsStore) => store.rows.map((r) => r.id);

/** A server that holds `rows` and answers page by page, like the real one. */
function server(rows: Row[]) {
  const held = { rows };
  const getRows = vi.fn(async (_tableId: string, query: Query): Promise<QueryResult<Row>> => {
    const offset = query.offset ?? 0;
    const limit = query.limit ?? PAGE_SIZE;
    return { items: held.rows.slice(offset, offset + limit), total: held.rows.length, hasMore: offset + limit < held.rows.length };
  });
  return { held, getRows };
}

/** A server whose answers wait until the test lets them through. */
function heldBack() {
  const answers: Array<{ query: Query; answer: (result: QueryResult<Row>) => void; refuse: (e: Error) => void }> = [];
  const getRows = vi.fn(
    (_tableId: string, query: Query) =>
      new Promise<QueryResult<Row>>((answer, refuse) => {
        answers.push({ query, answer, refuse });
      }),
  );
  return { answers, getRows };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

function storeWith(api: Partial<ReceiptsApi>, seed: Partial<ReceiptsSeed> = {}) {
  const full: ReceiptsApi = {
    getRows: vi.fn(async () => ({ items: [], total: 0, hasMore: false })),
    createRow: vi.fn(),
    updateRow: vi.fn(),
    getYearCounts: vi.fn(async () => ({ years: [], undated: 0 })),
    getNavCounts: vi.fn(async () => ({ ok: true as const, value: { review: 0, meals: 0 } })),
    uploadFile: vi.fn(),
    deleteStoredFile: vi.fn(),
    addFileReference: vi.fn(),
    removeFileReference: vi.fn(),
    ...api,
  };
  const store = new ReceiptsStore({ tableId: 't', years: NO_YEARS, yearCounts: { years: [], undated: 0 }, review: [], openMeals: 0, ...seed }, full);
  store.columnsChanged(columns);
  return { store, api: full };
}

describe('loading the receipts', () => {
  it('reads every page once, asks for the chosen years, and is settled when all are in', async () => {
    const { getRows } = server(rowsOf(450));
    const years: YearSelection = { years: new Set([2026, 2025]), undated: false };
    const { store } = storeWith({ getRows }, { years });
    expect(store.loading).toBe(true);
    await store.load();
    expect(store.rows).toHaveLength(450);
    expect(store.loading).toBe(false);
    expect(getRows.mock.calls.map(([, q]) => q.offset)).toEqual([0, 200, 400]);
    expect(getRows.mock.calls[0][1]).toMatchObject({ limit: PAGE_SIZE, includeArchived: false, include: ['files'], years: [2025, 2026] });
  });

  it('asks for everything when the undated receipts are chosen or nothing is', async () => {
    const { getRows } = server(rowsOf(1));
    const { store } = storeWith({ getRows }, { years: { years: new Set([2026]), undated: true } });
    await store.load();
    expect(getRows.mock.calls[0][1].years).toBeNull();
  });

  it('keeps the old list until a reload is complete: it never falls back to its first page', async () => {
    const first = server(rowsOf(300));
    const { store, api } = storeWith({ getRows: first.getRows });
    await store.load();
    const held = heldBack();
    api.getRows = held.getRows;
    const reload = store.load();
    held.answers[0].answer({ items: rowsOf(200), total: 300, hasMore: true });
    await flush();
    expect(store.rows).toHaveLength(300);
    expect(store.loading).toBe(true);
    held.answers[1].answer({ items: rowsOf(100, 200), total: 300, hasMore: false });
    await reload;
    expect(store.rows).toHaveLength(300);
    expect(store.loading).toBe(false);
  });

  it('shows a new question page by page, so the first receipts are there at once', async () => {
    const { answers, getRows } = heldBack();
    const { store } = storeWith({ getRows });
    store.filtersChanged([{ columnId: NAME, operator: 'contains', value: 'r' }]);
    answers[0].answer({ items: rowsOf(200), total: 250, hasMore: true });
    await flush();
    expect(store.rows).toHaveLength(200);
    expect(store.loading).toBe(true);
    answers[1].answer({ items: rowsOf(50, 200), total: 250, hasMore: false });
    await flush();
    expect(store.rows).toHaveLength(250);
    expect(store.loading).toBe(false);
  });

  it('shows a row once when the pages overlap, and reads the list again once it is in', async () => {
    const { answers, getRows } = heldBack();
    const { store } = storeWith({ getRows });
    const load = store.load();
    // A receipt added while the pages came moved the rest by one: the last row of the first page comes again.
    answers[0].answer({ items: rowsOf(200), total: 301, hasMore: true });
    await flush();
    answers[1].answer({ items: rowsOf(101, 199), total: 301, hasMore: false });
    await flush();
    expect(answers).toHaveLength(3);
    answers[2].answer({ items: rowsOf(1, 500), total: 1, hasMore: false });
    await load;
    expect(ids(store)).toEqual(['r500']);
  });

  it('reads a list that never adds up only a bounded number of times, then shows it', async () => {
    const getRows = vi.fn(async () => ({ items: rowsOf(2), total: 5, hasMore: false }));
    const { store } = storeWith({ getRows });
    await store.load();
    expect(getRows).toHaveBeenCalledTimes(1 + MAX_REPAIRS);
    expect(store.rows).toHaveLength(2);
    expect(store.loading).toBe(false);
  });

  it('stops at an empty page instead of asking without end', async () => {
    const getRows = vi.fn(async () => ({ items: [], total: 0, hasMore: true }));
    const { store } = storeWith({ getRows });
    await store.load();
    expect(getRows).toHaveBeenCalledTimes(1);
  });

  it('keeps the first place of a row and drops its copies', () => {
    const a = row('a');
    expect(uniqueRows([a, row('b'), { ...a }]).map((r) => r.id)).toEqual(['a', 'b']);
  });
});

describe('a load that a newer one replaced', () => {
  it('drops its late pages: a defect of 2026-10-11 said 917 items for 267 receipts', async () => {
    const { answers, getRows } = heldBack();
    const { store } = storeWith({ getRows });
    const old = store.load();
    const fresh = store.load();
    answers[1].answer({ items: rowsOf(2), total: 2, hasMore: false });
    await fresh;
    answers[0].answer({ items: rowsOf(2, 100), total: 2, hasMore: false });
    await old;
    expect(ids(store)).toEqual(['r0', 'r1']);
  });

  it('lets whoever waits for it wait for the newer one', async () => {
    const { answers, getRows } = heldBack();
    const { store } = storeWith({ getRows });
    let oldDone = false;
    void store.load().then(() => (oldDone = true));
    void store.load();
    answers[0].answer({ items: [], total: 0, hasMore: false });
    await flush();
    expect(oldDone).toBe(false);
    answers[1].answer({ items: rowsOf(1), total: 1, hasMore: false });
    await flush();
    expect(oldDone).toBe(true);
    expect(store.rows).toHaveLength(1);
  });

  it('does not fail the page when only the old one failed', async () => {
    const { answers, getRows } = heldBack();
    const { store } = storeWith({ getRows });
    void store.load();
    const fresh = store.load();
    answers[0].refuse(new Error('down'));
    answers[1].answer({ items: rowsOf(1), total: 1, hasMore: false });
    await fresh;
    expect(store.loadFailed).toBe(false);
  });
});

describe('backtracking: another choice replaces what the last one brought', () => {
  it('a new year drops the pages of the year before, also when they arrive after it', async () => {
    const { answers, getRows } = heldBack();
    const { store } = storeWith({ getRows }, { years: { years: new Set([2026]), undated: false } });
    void store.load();
    store.yearsChanged({ years: new Set([2025]), undated: false });
    expect(answers[1].query.years).toEqual([2025]);
    answers[1].answer({ items: [row('of-2025')], total: 1, hasMore: false });
    await flush();
    answers[0].answer({ items: [row('of-2026')], total: 1, hasMore: false });
    await flush();
    expect(ids(store)).toEqual(['of-2025']);
  });

  it('going back to the same list keeps the objects of its rows, so nothing has to redraw', async () => {
    const { held, getRows } = server([row('a'), row('b')]);
    const { store } = storeWith({ getRows });
    await store.load();
    const before = store.rows;
    held.rows = held.rows.map((r) => ({ ...r }));
    await store.load();
    expect(store.rows[0]).toBe(before[0]);
    expect(store.rows[1]).toBe(before[1]);
  });

  it('a reload replaces only the row that changed, and a watcher of the list sees one change', async () => {
    const { held, getRows } = server([row('a'), row('b')]);
    const { store } = storeWith({ getRows });
    await store.load();
    const [a, b] = store.rows;
    const seen: Row[][] = [];
    const stop = autorun(() => seen.push(store.rows));
    held.rows = [{ ...a }, row('b', 'corrected')];
    await store.load();
    expect(store.rows[0]).toBe(a);
    expect(store.rows[1]).not.toBe(b);
    expect(seen).toHaveLength(2);
    await store.load();
    expect(seen).toHaveLength(2);
    stop();
  });

  it('a row saved while a load is on its way stays: that read may be older', async () => {
    const updateRow = vi.fn(async () => row('a', 'saved'));
    const first = server([row('a')]);
    const { store, api } = storeWith({ getRows: first.getRows, updateRow });
    await store.load();
    const held = heldBack();
    api.getRows = held.getRows;
    const reload = store.load();
    await store.updateCell('a', NAME, 'saved');
    held.answers[0].answer({ items: [row('a', 'read before the save')], total: 1, hasMore: false });
    await reload;
    expect(store.row('a')?.cells[NAME]).toBe('saved');
    // The next load read after the save, and its word counts again.
    api.getRows = first.getRows;
    first.held.rows = [row('a', 'later')];
    await store.load();
    expect(store.row('a')?.cells[NAME]).toBe('later');
  });

  it('a save that arrives after the delete of its row does not bring the row back', async () => {
    let answer: (r: Row) => void = () => {};
    const updateRow = vi.fn(() => new Promise<Row>((resolve) => (answer = resolve)));
    const { store } = storeWith({ getRows: server([row('a')]).getRows, updateRow });
    await store.load();
    const saving = store.updateCell('a', NAME, 'x');
    store.rowsRemoved(['a']);
    answer(row('a', 'x'));
    await saving;
    expect(store.rows).toEqual([]);
  });
});

describe('resuming: a new visit is a new store', () => {
  it('starts from what the server sent and holds nothing of the last visit', async () => {
    const { getRows } = server([row('a')]);
    const first = storeWith({ getRows }).store;
    await first.load();
    first.orderPlaced({ groupId: 'g', order: ['a'] });
    const next = storeWith({ getRows }, { years: { years: new Set([2024]), undated: false }, review: [entry('b')], openMeals: 3 }).store;
    expect(next.rows).toEqual([]);
    expect(next.placedOrder).toBeNull();
    expect(next.years.years.has(2024)).toBe(true);
    expect(next.reviewCount).toBe(1);
    expect(next.openMeals).toBe(3);
  });

  it('does not call a review list that failed to load empty, until one arrives', () => {
    const { store } = storeWith({}, { review: null });
    expect(store.review).toEqual([]);
    expect(store.reviewCount).toBeNull();
    store.reviewReplaced([]);
    expect(store.reviewCount).toBe(0);
  });
});

describe('re-entry after a failure or after leaving', () => {
  it('a failed load keeps what is shown, says so, is not asked again by itself, and the next one starts clean', async () => {
    const getRows = vi.fn(async () => ({ items: [row('a')], total: 1, hasMore: false }));
    const { store } = storeWith({ getRows });
    await store.load();
    getRows.mockRejectedValueOnce(new Error('down'));
    await store.load();
    expect(store.loadFailed).toBe(true);
    expect(store.loading).toBe(false);
    expect(ids(store)).toEqual(['a']);
    expect(getRows).toHaveBeenCalledTimes(2);
    await store.load();
    expect(store.loadFailed).toBe(false);
  });

  it('a page that fails while a new question fills the list keeps the rows that came, and says so', async () => {
    const { answers, getRows } = heldBack();
    const { store } = storeWith({ getRows });
    store.sortsChanged([{ columnId: NAME, direction: 'asc' }]);
    answers[0].answer({ items: rowsOf(200), total: 300, hasMore: true });
    await flush();
    answers[1].refuse(new Error('down'));
    await flush();
    expect(store.rows).toHaveLength(200);
    expect(store.loadFailed).toBe(true);
  });

  it('after the page is left, nothing on its way lands in the store and a waiter lets go', async () => {
    const { answers, getRows } = heldBack();
    const { store } = storeWith({ getRows });
    const close = store.open();
    const waiting = store.load();
    close();
    answers[0].answer({ items: rowsOf(1), total: 1, hasMore: false });
    answers[1].answer({ items: rowsOf(1), total: 1, hasMore: false });
    await waiting;
    expect(store.rows).toEqual([]);
  });

  it('opens again after closing, as a strict render does', async () => {
    const { getRows } = server([row('a')]);
    const { store } = storeWith({ getRows });
    const close = store.open();
    close();
    const closeAgain = store.open();
    await flush();
    await flush();
    expect(ids(store)).toEqual(['a']);
    closeAgain();
  });
});

describe('what the store works out', () => {
  it('tells receipts from groups by the columns, and follows them', async () => {
    const { getRows } = server([groupRow('g'), row('a', 'a', { parentRowId: 'g' }), row('b')]);
    const { store } = storeWith({ getRows });
    await store.load();
    expect(store.receipts.map((r) => r.id)).toEqual(['a', 'b']);
    expect(store.groups.map((g) => g.id)).toEqual(['g']);
    expect(store.receiptsInGroup('g').map((r) => r.id)).toEqual(['a']);
    store.columnsChanged([columns[0]]);
    expect(store.groups).toEqual([]);
  });

  it('counts every receipt of every year, the undated too', () => {
    const { store } = storeWith({}, { yearCounts: { years: [{ year: 2026, count: 4 }, { year: 2025, count: 1 }], undated: 2 } });
    expect(store.totalReceipts).toBe(7);
  });

  it('takes deleted rows out of the list and the review list, also as a duplicate of another', async () => {
    const { getRows } = server([row('a'), row('b')]);
    const { store } = storeWith({ getRows }, { review: [entry('a'), entry('b', ['a', 'c'])] });
    await store.load();
    store.rowsRemoved(['a']);
    expect(ids(store)).toEqual(['b']);
    expect(store.reviewCount).toBe(1);
    expect(store.review[0].duplicates.map((d) => d.rowId)).toEqual(['c']);
  });

  it('puts a new row first and sends what the page gave', async () => {
    const createRow = vi.fn(async () => row('new'));
    const { store } = storeWith({ getRows: server([row('a')]).getRows, createRow });
    await store.load();
    const cells: Record<string, CellValue> = { [NAME]: 'x' };
    await store.addRow(cells);
    expect(createRow).toHaveBeenCalledWith({ tableId: 't', cells });
    expect(ids(store)).toEqual(['new', 'a']);
  });
});

describe('the numbers that follow a change', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const settle = async (ms = COUNTS_DELAY_MS) => {
    await vi.advanceTimersByTimeAsync(ms);
  };

  it('are not asked for the first list beyond the year chips, which the page may have failed to count', async () => {
    const { getRows } = server([row('a')]);
    const { store, api } = storeWith({ getRows });
    const close = store.open();
    await settle(COUNTS_DELAY_MS * 2);
    expect(api.getYearCounts).toHaveBeenCalledTimes(1);
    expect(api.getNavCounts).not.toHaveBeenCalled();
    close();
  });

  it('are asked once for a run of edits, and the navigation follows', async () => {
    const updateRow = vi.fn(async (rowId: string) => row(rowId, 'edited'));
    const getNavCounts = vi.fn(async () => ({ ok: true as const, value: { review: 9, meals: 4 } }));
    const getYearCounts = vi.fn(async () => ({ years: [{ year: 2026, count: 2 }], undated: 0 }));
    const { store } = storeWith({ getRows: server([row('a'), row('b')]).getRows, updateRow, getNavCounts, getYearCounts }, { openMeals: 1, review: [entry('a')] });
    const app = new AppStore();
    const leave = app.openReceipts(store);
    const close = store.open();
    await settle();
    getYearCounts.mockClear();
    await store.updateCell('a', NAME, 'x');
    await store.updateCell('b', NAME, 'y');
    await settle();
    expect(getNavCounts).toHaveBeenCalledTimes(1);
    expect(getYearCounts).toHaveBeenCalledTimes(1);
    expect(store.totalReceipts).toBe(2);
    // The meal count is the server's; the review count stays the list's, which the answer does not change.
    expect(app.counts).toEqual({ review: 1, meals: 4 });
    close();
    leave();
  });

  it('are not asked when a reload finds nothing changed, and are when it does', async () => {
    const { held, getRows } = server([row('a')]);
    const { store, api } = storeWith({ getRows });
    const close = store.open();
    await settle();
    await store.load();
    await settle();
    expect(api.getNavCounts).not.toHaveBeenCalled();
    held.rows = [row('a', 'changed elsewhere')];
    await store.load();
    await settle();
    expect(api.getNavCounts).toHaveBeenCalledTimes(1);
    close();
  });

  it('keep the last number when the answer fails, and ignore an answer after the page closed', async () => {
    const getNavCounts = vi.fn(async () => ({ ok: false as const }));
    const getYearCounts = vi.fn().mockRejectedValue(new Error('down'));
    const { store } = storeWith({ getRows: server([row('a')]).getRows, updateRow: async () => row('a', 'x'), getNavCounts, getYearCounts }, { openMeals: 2, yearCounts: { years: [{ year: 2026, count: 1 }], undated: 0 } });
    const close = store.open();
    await settle();
    await store.updateCell('a', NAME, 'x');
    await settle();
    expect(store.openMeals).toBe(2);
    expect(store.totalReceipts).toBe(1);

    let answer: (v: { ok: true; value: { review: number; meals: number } }) => void = () => {};
    getNavCounts.mockReturnValueOnce(new Promise((resolve) => (answer = resolve)) as never);
    await store.updateCell('a', NAME, 'y');
    await settle();
    close();
    answer({ ok: true, value: { review: 0, meals: 8 } });
    await settle(0);
    expect(store.openMeals).toBe(2);
  });
});

describe('files of a receipt', () => {
  const uploaded = { id: 'f2', url: '/f2', originalName: 'b.pdf', mimeType: 'application/pdf', sizeBytes: 3, metadata: {} } as unknown as UploadedFile;
  const FILES = 'col_files';
  const existing = { id: 'ref1', rowId: 'a', columnId: FILES, fileId: 'f1', fileUrl: '/f1', originalName: 'a.pdf', mimeType: 'application/pdf', position: 0 } as FileReference;
  const withFile = () => row('a', 'a', { cells: { [FILES]: [existing] as unknown as CellValue } });

  it('adds an upload to the files the row has, in the place after them, in the order of the package', async () => {
    const calls: string[] = [];
    const updateRow = vi.fn(async (_id: string, cells: Record<string, CellValue>) => {
      calls.push('cell');
      return row('a', 'a', { cells });
    });
    const uploadFile = vi.fn(async () => {
      calls.push('upload');
      return uploaded;
    });
    const addFileReference = vi.fn(async () => {
      calls.push('reference');
    });
    const { store } = storeWith({ getRows: server([withFile()]).getRows, updateRow, uploadFile, addFileReference });
    await store.load();
    const ref = await store.uploadFile('a', FILES, new File(['x'], 'b.pdf'));
    expect(calls).toEqual(['upload', 'cell', 'reference']);
    expect(ref.position).toBe(1);
    expect((updateRow.mock.calls[0][1][FILES] as unknown as FileReference[]).map((f) => f.fileId)).toEqual(['f1', 'f2']);
    expect(addFileReference).toHaveBeenCalledWith(expect.objectContaining({ rowId: 'a', columnId: FILES, fileId: 'f2', position: 1 }));
  });

  it('deletes a file of the row and leaves the others', async () => {
    const updateRow = vi.fn(async (_id: string, cells: Record<string, CellValue>) => row('a', 'a', { cells }));
    const { store, api } = storeWith({ getRows: server([withFile()]).getRows, updateRow });
    await store.load();
    await store.deleteFile('a', FILES, 'f1');
    expect(api.deleteStoredFile).toHaveBeenCalledWith('f1');
    expect(api.removeFileReference).toHaveBeenCalledWith('ref1');
    expect(updateRow.mock.calls[0][1][FILES]).toEqual([]);
  });

  it('does nothing for a file the row does not have', async () => {
    const { store, api } = storeWith({ getRows: server([withFile()]).getRows });
    await store.load();
    await store.deleteFile('a', FILES, 'other');
    expect(api.deleteStoredFile).not.toHaveBeenCalled();
    expect(api.updateRow).not.toHaveBeenCalled();
  });
});
