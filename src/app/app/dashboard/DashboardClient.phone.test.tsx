// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Row } from '@marlinjai/data-table-core';
import { TABLE_ID, allRows, columnId, fakeAdapter } from '@/lib/groups/__tests__/fixture';
import type { YearCounts } from '@/lib/receipt-year-counts';

/**
 * The dashboard at phone width, with the real table package and a fake data
 * source (the fixture's receipts plus one of 2025). It proves what the plan
 * claims for the page as a whole: the card list and the view picker take the
 * table's place, the search and the year in the address narrow the cards, a
 * card opens the detail panel, and a failed load is not shown as an empty list.
 * Plan: docs/plans/2026-10-24-phone-layout.md.
 */

const state = vi.hoisted(() => ({ adapter: {} as Record<string, unknown> }));

vi.mock('./server-actions-adapter', () => ({
  // Every call goes to the adapter the running test set up; anything it does not answer resolves to nothing.
  createServerActionsAdapter: () =>
    new Proxy({}, { get: (_target, key: string) => state.adapter[key] ?? (async () => null) }),
}));
vi.mock('./actions', () => ({
  getYearCounts: vi.fn(async () => COUNTS),
  searchReceiptText: vi.fn(async () => ({ ids: [], truncated: false })),
  getReceiptYear: vi.fn(async () => null),
  getReceiptText: vi.fn(async () => ''),
  deleteReceiptsForGood: vi.fn(),
  setFieldOnRows: vi.fn(),
}));
vi.mock('../actions', () => ({ rereadReceipt: vi.fn(), recomputeFxRates: vi.fn() }));
vi.mock('./review-actions', () => ({ getReviewQueue: vi.fn(), confirmReceiptChecked: vi.fn(), keepBothLookAlikes: vi.fn(), takeNewReading: vi.fn() }));
vi.mock('./group-actions', () => ({ createReceiptGroup: vi.fn(), moveReceiptsIntoGroup: vi.fn(), removeReceiptsFromGroup: vi.fn() }));
vi.mock('@/lib/presigned-file-adapter', () => ({ PresignedStorageBrainAdapter: class {} }));
vi.mock('@/components/ReceiptDetailPanel', () => ({
  default: ({ row }: { row: Row }) => (
    <div role="dialog" aria-label="Beleg">
      {row.id}
    </div>
  ),
}));
vi.mock('@/components/AiChatSidebar', () => ({ default: () => null }));
vi.mock('@/components/review/ReviewPanel', () => ({ default: () => null }));

const COUNTS: YearCounts = { years: [{ year: 2026, count: 4 }, { year: 2025, count: 1 }], undated: 0 };

/** A receipt of 2025, beside the fixture's receipts of 2026. Invented. */
const conference = {
  id: 'conference',
  tableId: TABLE_ID,
  archived: false,
  cells: { [columnId('Name')]: 'Konferenz', [columnId('Vendor')]: 'Conference Example Inc.', [columnId('Gross')]: 250, [columnId('Date')]: '2025-11-02T00:00:00.000Z' },
} as unknown as Row;

const views = [
  { id: 'v-table', tableId: TABLE_ID, name: 'Table', type: 'table', isDefault: true, position: 0, config: {} },
  { id: 'v-board', tableId: TABLE_ID, name: 'Board', type: 'board', isDefault: false, position: 1, config: {} },
];

function setAdapter(options: { failRows?: boolean } = {}) {
  const base = fakeAdapter([...allRows, conference]);
  state.adapter = {
    ...base,
    getTable: async () => ({ id: TABLE_ID, name: 'Receipts' }),
    getViews: async () => views,
    ...(options.failRows ? { getRows: async () => Promise.reject(new Error('down')) } : {}),
  };
}

function phoneWidth(matches: boolean) {
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => ({ matches, media: query, addEventListener: () => {}, removeEventListener: () => {} })),
  );
}

async function open(initialYears: string | null) {
  const { default: DashboardClient } = await import('./DashboardClient');
  render(
    <DashboardClient tableId={TABLE_ID} workspaceId="ws_1" openMealCount={0} initialReview={[]} openRowId={null} initialYears={initialYears} yearCounts={COUNTS} />,
  );
}

const cardLabels = () => within(screen.getByRole('list', { name: 'Belege' })).getAllByRole('button').map((b) => b.getAttribute('aria-label'));

beforeEach(() => {
  window.history.replaceState(null, '', '/app/dashboard');
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('the dashboard on a phone', () => {
  it('shows the receipts of the newest year as cards, with the view picker in place of the tab row', async () => {
    phoneWidth(true);
    setAdapter();
    await open(null);
    await waitFor(() => expect(cardLabels()).toHaveLength(3));
    expect(cardLabels()).toEqual(['Beleg Taxi Beispiel vom 13.03.2026 öffnen', 'Beleg Softwarehaus Beispiel vom 12.03.2026 öffnen', 'Gruppe Messe öffnen']);
    const picker = screen.getByLabelText('Ansicht') as HTMLSelectElement;
    expect([...picker.options].map((o) => o.textContent)).toEqual(['Table', 'Board']);
    expect(document.querySelector('.dt-table-view')).toBeNull();
  });

  it('opens the detail panel of the receipt a card names', async () => {
    const user = userEvent.setup();
    phoneWidth(true);
    setAdapter();
    await open(null);
    await user.click(await screen.findByRole('button', { name: 'Beleg Softwarehaus Beispiel vom 12.03.2026 öffnen' }));
    expect(screen.getByRole('dialog', { name: 'Beleg' }).textContent).toBe('licence');
  });

  it('resumes the years the address names: a link to 2025 shows the 2025 receipt only', async () => {
    phoneWidth(true);
    setAdapter();
    await open('2025');
    await waitFor(() => expect(cardLabels()).toEqual(['Beleg Conference Example Inc. vom 02.11.2025 öffnen']));
  });

  it('narrows the cards as the search is typed, says why when nothing is left, and comes back when it is cleared', async () => {
    const user = userEvent.setup();
    phoneWidth(true);
    setAdapter();
    await open(null);
    await waitFor(() => expect(cardLabels()).toHaveLength(3));
    const search = screen.getByRole('textbox', { name: /durchsuchen/i });
    await user.type(search, 'Softwarehaus');
    await waitFor(() => expect(cardLabels()).toEqual(['Beleg Softwarehaus Beispiel vom 12.03.2026 öffnen']));
    await user.clear(search);
    await user.type(search, 'nichts dergleichen');
    expect(await screen.findByText('Keine Belege für diese Auswahl.')).toBeTruthy();
    await user.clear(search);
    await waitFor(() => expect(cardLabels()).toHaveLength(3));
  });

  it('does not call the list empty when the receipts could not be loaded', async () => {
    phoneWidth(true);
    setAdapter({ failRows: true });
    await open(null);
    expect(await screen.findByText(/Die Belege konnten nicht vollständig geladen werden/)).toBeTruthy();
    expect(screen.queryByText('Noch keine Belege.')).toBeNull();
    expect(screen.queryByText('Keine Belege für diese Auswahl.')).toBeNull();
  });
});

describe('the dashboard on a wide screen', () => {
  it('keeps the table and the tab row, and draws no cards', async () => {
    phoneWidth(false);
    setAdapter();
    await open(null);
    await waitFor(() => expect(document.querySelector('.dt-table-view')).not.toBeNull());
    expect(screen.queryByRole('list', { name: 'Belege' })).toBeNull();
    expect(screen.queryByLabelText('Ansicht')).toBeNull();
  });
});
