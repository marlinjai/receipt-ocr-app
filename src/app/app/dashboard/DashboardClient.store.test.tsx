// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, createEvent, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useEffect } from 'react';
import type { Row } from '@marlinjai/data-table-core';
import { TABLE_ID, allRows, columnId, fakeAdapter, licence } from '@/lib/groups/__tests__/fixture';
import type { YearCounts } from '@/lib/receipt-year-counts';
import type { ReviewEntry } from '@/lib/review/service';
import type { AppStore } from '@/stores/AppStore';
import { AppStoreProvider, useAppStore } from '@/stores/provider';

/**
 * The dashboard on a wide screen, with the real table package over a fake data
 * source and the page's store: the table, the navigation's numbers and the
 * address all follow the one list. Plan: docs/plans/2026-11-01-client-state.md.
 */

const state = vi.hoisted(() => ({
  adapter: {} as Record<string, unknown>,
  app: null as unknown,
  exported: [] as Array<{ rows: Array<{ id: string }> }>,
  drawn: new Set<string>(),
}));
const mocks = vi.hoisted(() => ({
  getYearCounts: vi.fn(),
  getNavCounts: vi.fn(),
  deleteReceiptsForGood: vi.fn(),
  confirmReceiptChecked: vi.fn(),
  getReviewQueue: vi.fn(),
  moveReceiptsIntoGroup: vi.fn(),
  removeReceiptsFromGroup: vi.fn(),
}));

// The table asks this for every cell of a row it draws, so it tells which rows were drawn.
vi.mock('@/lib/groups/view', async (original) => {
  const real = await original<typeof import('@/lib/groups/view')>();
  return {
    ...real,
    groupCellValue: (...args: Parameters<typeof real.groupCellValue>) => {
      state.drawn.add(args[0].id);
      return real.groupCellValue(...args);
    },
  };
});
vi.mock('next/navigation', () => ({ usePathname: () => '/app/dashboard' }));
vi.mock('@/app/app/nav-actions', () => ({ getNavCounts: mocks.getNavCounts }));
vi.mock('./server-actions-adapter', () => ({
  createServerActionsAdapter: () => new Proxy({}, { get: (_target, key: string) => state.adapter[key] ?? (async () => null) }),
}));
vi.mock('./actions', () => ({
  getYearCounts: mocks.getYearCounts,
  searchReceiptText: vi.fn(async () => ({ ids: [], truncated: false })),
  getReceiptYear: vi.fn(async () => null),
  getReceiptText: vi.fn(async () => ''),
  deleteReceiptsForGood: mocks.deleteReceiptsForGood,
  setFieldOnRows: vi.fn(),
}));
vi.mock('../actions', () => ({ rereadReceipt: vi.fn(), recomputeFxRates: vi.fn() }));
vi.mock('./review-actions', () => ({ getReviewQueue: mocks.getReviewQueue, confirmReceiptChecked: mocks.confirmReceiptChecked, keepBothLookAlikes: vi.fn(), takeNewReading: vi.fn() }));
vi.mock('./group-actions', () => ({ createReceiptGroup: vi.fn(), moveReceiptsIntoGroup: mocks.moveReceiptsIntoGroup, removeReceiptsFromGroup: mocks.removeReceiptsFromGroup }));
vi.mock('@/lib/presigned-file-adapter', () => ({ PresignedStorageBrainAdapter: class {} }));
vi.mock('@/lib/export-csv', () => ({ exportCSV: (args: { rows: Array<{ id: string }> }) => state.exported.push(args) }));
vi.mock('@/components/ReceiptDetailPanel', () => ({ default: ({ row }: { row: Row }) => <div role="dialog" aria-label="Beleg">{row.id}</div> }));
vi.mock('@/components/AiChatSidebar', () => ({ default: () => null }));
vi.mock('@/components/review/ReviewPanel', () => ({
  default: ({ entries, onConfirm }: { entries: ReviewEntry[]; onConfirm: (rowId: string) => void }) => (
    <ul aria-label="Prüfliste">
      {entries.map((e) => (
        <li key={e.rowId}>
          <button type="button" onClick={() => onConfirm(e.rowId)}>{`prüfen ${e.rowId}`}</button>
        </li>
      ))}
    </ul>
  ),
}));

// The whole page with the real table: slow to query when the machine is busy, not stuck.
vi.setConfig({ testTimeout: 30_000 });

const COUNTS: YearCounts = { years: [{ year: 2026, count: 4 }, { year: 2025, count: 1 }], undated: 0 };
const review = (...ids: string[]) => ids.map((rowId) => ({ rowId, duplicates: [] })) as unknown as ReviewEntry[];

/** A receipt of 2025, beside the fixture's receipts of 2026. Invented. */
const conference = {
  id: 'conference',
  tableId: TABLE_ID,
  archived: false,
  cells: { [columnId('Name')]: 'Konferenz', [columnId('Vendor')]: 'Conference Example Inc.', [columnId('Gross')]: 250, [columnId('Date')]: '2025-11-02T00:00:00.000Z' },
} as unknown as Row;

const views = [{ id: 'v-table', tableId: TABLE_ID, name: 'Table', type: 'table', isDefault: true, position: 0, config: {} }];

function setAdapter() {
  const base = fakeAdapter([...allRows, conference]);
  const getRows = vi.fn(base.getRows);
  const updateRow = vi.fn(async (rowId: string, cells: Record<string, unknown>) => {
    const row = [...allRows, conference].find((r) => r.id === rowId) as Row;
    return { ...row, cells: { ...row.cells, ...cells } };
  });
  state.adapter = { ...base, getRows, updateRow, getTable: async () => ({ id: TABLE_ID, name: 'Receipts' }), getViews: async () => views };
  return { getRows, updateRow };
}

function CaptureApp() {
  const app = useAppStore();
  useEffect(() => {
    state.app = app;
  }, [app]);
  return null;
}
const app = () => state.app as AppStore;

async function open({ initialYears = null, initialReview = [] as ReviewEntry[] | null, openMealCount = 0 } = {}) {
  const { default: DashboardClient } = await import('./DashboardClient');
  const view = render(
    <AppStoreProvider>
      <CaptureApp />
      <DashboardClient tableId={TABLE_ID} workspaceId="ws_1" openMealCount={openMealCount} initialReview={initialReview} openRowId={null} initialYears={initialYears} yearCounts={COUNTS} />
    </AppStoreProvider>,
  );
  await waitFor(() => expect(document.querySelector('tr[data-row-id="licence"]')).not.toBeNull());
  return view;
}

function dataTransfer() {
  const data = new Map<string, string>();
  return { effectAllowed: '', dropEffect: '', setData: (k: string, v: string) => data.set(k, v), getData: (k: string) => data.get(k) ?? '', types: [] as string[] };
}

const shownRowIds = () => [...document.querySelectorAll('tr[data-row-id]')].map((tr) => tr.getAttribute('data-row-id'));

beforeEach(() => {
  window.history.replaceState(null, '', '/app/dashboard');
  Element.prototype.scrollIntoView = () => {};
  vi.stubGlobal('matchMedia', vi.fn((query: string) => ({ matches: false, media: query, addEventListener: () => {}, removeEventListener: () => {} })));
  state.exported.length = 0;
  mocks.getYearCounts.mockReset().mockResolvedValue(COUNTS);
  mocks.getNavCounts.mockReset().mockResolvedValue({ ok: true, value: { review: 0, meals: 0 } });
  mocks.getReviewQueue.mockReset().mockResolvedValue({ ok: true, value: [] });
  mocks.confirmReceiptChecked.mockReset();
  mocks.deleteReceiptsForGood.mockReset();
  mocks.moveReceiptsIntoGroup.mockReset();
  mocks.removeReceiptsFromGroup.mockReset();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('the list', () => {
  it('asks the server for the year the page opens on, and never through the table package', async () => {
    const { getRows } = setAdapter();
    await open();
    expect(getRows.mock.calls.every(([, q]) => (q as { years?: number[] }).years?.[0] === 2026)).toBe(true);
    expect(shownRowIds()).not.toContain('conference');
  });

  it('a year chosen goes into the address, asks for that year, and the table follows', async () => {
    const user = userEvent.setup();
    const { getRows } = setAdapter();
    await open();
    await user.click(screen.getByRole('button', { name: /2025/ }));
    await waitFor(() => expect(shownRowIds()).toContain('conference'));
    expect(window.location.search).toContain('2025');
    expect(getRows.mock.calls.at(-1)?.[1]).toMatchObject({ years: [2025, 2026] });
  });

  it('exports what is shown: the year and the search narrow it', async () => {
    const user = userEvent.setup();
    setAdapter();
    await open();
    await user.type(screen.getByRole('textbox', { name: /durchsuchen/i }), 'Softwarehaus');
    await waitFor(() => expect(shownRowIds()).toEqual(['licence']));
    await user.click(screen.getAllByRole('button', { name: 'Als CSV exportieren' })[0]);
    expect(state.exported.at(-1)?.rows.map((r) => r.id)).toEqual(['licence']);
  });
});

describe('the wide table, on the published package', () => {
  it('draws the row of a saved cell and no other', async () => {
    const user = userEvent.setup();
    const { updateRow } = setAdapter();
    await open();
    await user.click(within(document.querySelector('tr[data-row-id="licence"]') as HTMLElement).getByText('Lizenz'));
    const input = await screen.findByDisplayValue('Lizenz');
    await user.clear(input);
    await user.type(input, 'Neu');
    state.drawn.clear();
    // By leaving the field: Enter would also move the keyboard highlight, which redraws the next row, rightly.
    fireEvent.blur(input);
    await waitFor(() => expect(updateRow).toHaveBeenCalled());
    await waitFor(() => expect(document.querySelector('tr[data-row-id="licence"]')?.textContent).toContain('Neu'));
    expect(state.drawn).toEqual(new Set(['licence']));
  });
});

describe('the export', () => {
  it('is refused with the reason while the list fills, on both buttons, and works once it is in', async () => {
    const user = userEvent.setup();
    const { getRows } = setAdapter();
    await open();
    const answers: Array<() => void> = [];
    const real = getRows.getMockImplementation() as NonNullable<ReturnType<typeof getRows.getMockImplementation>>;
    getRows.mockImplementation(async (...args) => {
      await new Promise<void>((resolve) => answers.push(resolve));
      return real(...args);
    });
    await user.click(screen.getByRole('button', { name: /2025/ }));
    for (const button of screen.getAllByRole('button', { name: 'Als CSV exportieren' })) {
      await user.click(button);
      expect(state.exported).toHaveLength(0);
      expect(screen.getByRole('alert').textContent).toMatch(/noch geladen/);
      await user.click(screen.getByRole('button', { name: 'Schließen' }));
    }
    getRows.mockImplementation(real);
    await act(async () => answers.forEach((go) => go()));
    await waitFor(() => expect(shownRowIds()).toContain('conference'));
    await user.click(screen.getAllByRole('button', { name: 'Als CSV exportieren' })[0]);
    expect(state.exported).toHaveLength(1);
  });

  it('is refused with the reason after a failed load, on both buttons', async () => {
    const user = userEvent.setup();
    const { getRows } = setAdapter();
    await open();
    getRows.mockRejectedValue(new Error('down'));
    await user.click(screen.getByRole('button', { name: /2025/ }));
    await screen.findByText(/Die Belege konnten nicht vollständig geladen werden/);
    for (const button of screen.getAllByRole('button', { name: 'Als CSV exportieren' })) {
      await user.click(button);
      expect(state.exported).toHaveLength(0);
      expect(screen.getByText(/Exportiert wird nichts/)).toBeTruthy();
      await user.click(screen.getByRole('button', { name: 'Schließen' }));
    }
  });
});

describe('the numbers of the navigation', () => {
  it('come from the store, without asking the server, and keep following it', async () => {
    const user = userEvent.setup();
    setAdapter();
    mocks.confirmReceiptChecked.mockResolvedValue({ ok: true, value: review('dinner') });
    await open({ initialReview: review('licence', 'dinner'), openMealCount: 3 });
    expect(app().counts).toEqual({ review: 2, meals: 3 });
    await user.click(screen.getByRole('button', { name: 'prüfen licence' }));
    await waitFor(() => expect(app().counts).toEqual({ review: 1, meals: 3 }));
    expect(within(screen.getByRole('list', { name: 'Prüfliste' })).getAllByRole('button')).toHaveLength(1);
    expect(mocks.getNavCounts).not.toHaveBeenCalled();
  });

  it('stay as the last word when the page is left', async () => {
    setAdapter();
    const view = await open({ initialReview: review('licence'), openMealCount: 3 });
    const shell = app();
    view.unmount();
    expect(shell.receipts).toBeNull();
    expect(shell.counts).toEqual({ review: 1, meals: 3 });
  });

  it('do not turn a review list that failed to load into a zero', async () => {
    setAdapter();
    await open({ initialReview: null, openMealCount: 3 });
    act(() => app().serverCounts({ review: 6, meals: 3 }));
    expect(app().counts?.review).toBe(6);
  });

  it('count a meal again a moment after a cell changed', async () => {
    const user = userEvent.setup();
    const { updateRow } = setAdapter();
    mocks.getNavCounts.mockResolvedValue({ ok: true, value: { review: 0, meals: 5 } });
    await open({ openMealCount: 3 });
    const cell = within(document.querySelector('tr[data-row-id="licence"]') as HTMLElement).getByText('Lizenz');
    await user.click(cell);
    const input = await screen.findByDisplayValue('Lizenz');
    await user.clear(input);
    await user.type(input, 'Neu{Enter}');
    await waitFor(() => expect(updateRow).toHaveBeenCalled());
    await waitFor(() => expect(app().counts?.meals).toBe(5), { timeout: 2000 });
  });
});

describe('deleting', () => {
  it('takes the selected row out at once, from the list and the review list, and clears the selection', async () => {
    setAdapter();
    let answer: (o: unknown) => void = () => {};
    mocks.deleteReceiptsForGood.mockReturnValue(new Promise((resolve) => (answer = resolve)));
    await open({ initialReview: review('licence') });
    fireEvent.click(within(document.querySelector('tr[data-row-id="licence"]') as HTMLElement).getByRole('checkbox'));
    fireEvent.keyDown(document.body, { key: 'Backspace' });
    await userEvent.click(await screen.findByRole('button', { name: /löschen/i }));
    await act(async () => answer({ deleted: ['licence'], kept: [] }));
    await waitFor(() => expect(app().counts?.review).toBe(0));
    expect(mocks.deleteReceiptsForGood).toHaveBeenCalledWith(['licence']);
    // Nothing of it is selected any more: the button that said so is gone.
    expect(screen.queryByText(/selected/)).toBeNull();
  });
});

describe('a group', () => {
  const row = (id: string) => document.querySelector(`tr[data-row-id="${id}"]`) as HTMLElement;

  /** Dinner dropped on the upper half of the hotel, and what the page shows until the server has answered. */
  async function placeDinnerFirst(place: () => void) {
    const { getRows } = setAdapter();
    let answer: (o: unknown) => void = () => {};
    mocks.moveReceiptsIntoGroup.mockReturnValue(new Promise((resolve) => (answer = resolve)));
    await open();
    expect(shownRowIds().indexOf('hotel')).toBeLessThan(shownRowIds().indexOf('dinner'));
    place();
    await waitFor(() => expect(shownRowIds().indexOf('dinner')).toBeLessThan(shownRowIds().indexOf('hotel')));
    expect(mocks.moveReceiptsIntoGroup).toHaveBeenCalledWith('group', ['dinner'], ['dinner', 'hotel']);
    const loads = getRows.mock.calls.length;
    await act(async () => answer({ ok: true, value: { moved: 0 } }));
    await waitFor(() => expect(getRows.mock.calls.length).toBeGreaterThan(loads));
    // This fake stored nothing: what the server has comes back, and nothing of the placing stays.
    await waitFor(() => expect(shownRowIds().indexOf('hotel')).toBeLessThan(shownRowIds().indexOf('dinner')));
  }

  it('shows an order placed by drag while the server works, and what is stored after', async () => {
    await placeDinnerFirst(() => {
      const drag = dataTransfer();
      const target = row('hotel');
      target.getBoundingClientRect = () => ({ top: 100, height: 40 }) as DOMRect;
      fireEvent.mouseDown(row('dinner').querySelector('.dt-row-grip') as HTMLElement);
      fireEvent.dragStart(row('dinner'), { dataTransfer: drag });
      // jsdom's drag events carry no pointer position.
      const atUpperHalf = (event: Event) => {
        Object.defineProperty(event, 'clientY', { value: 110 });
        return fireEvent(target, event);
      };
      atUpperHalf(createEvent.dragOver(target, { dataTransfer: drag }));
      atUpperHalf(createEvent.drop(target, { dataTransfer: drag }));
    });
  });

  it('places by keyboard the same way', async () => {
    await placeDinnerFirst(() => {
      fireEvent.click(row('dinner').querySelectorAll('td')[1]);
      fireEvent.keyDown(document.querySelector('.dt-table-view') as HTMLElement, { key: 'ArrowUp', altKey: true });
    });
  });
});

describe('opening a receipt', () => {
  it('opens the receipt of the row it is asked for', async () => {
    const user = userEvent.setup();
    setAdapter();
    await open();
    await user.click(within(document.querySelector('tr[data-row-id="licence"]') as HTMLElement).getByText('OPEN'));
    expect(screen.getByRole('dialog', { name: 'Beleg' }).textContent).toBe(licence.id);
  });
});
