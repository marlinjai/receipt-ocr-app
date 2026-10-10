import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Row } from '@marlinjai/data-table-core';

/**
 * Every place that counts or sums receipts, run against the same table: a
 * group with two receipts, a receipt outside, an empty group, and a receipt
 * whose group is gone. Each must leave both groups out and take every receipt
 * exactly once. The group in the fixture carries an amount, a vendor, a date
 * and the meal category of its own, so a site that let it through would show.
 *
 * The table adapter and the database client are stand-ins that serve the
 * fixture; the code under test is the real one.
 */

const state = vi.hoisted(() => ({ adapter: null as unknown, session: { memberships: [{ id: 'ws_1' }], activeWorkspace: { id: 'ws_1', tenantId: 'tenant_1' } } }));

vi.mock('@marlinjai/data-table-adapter-prisma', () => ({
  PrismaAdapter: class {
    constructor() {
      return state.adapter as object;
    }
  },
}));
vi.mock('@/lib/prisma', async () => ({ prisma: (await import('./fixture')).emptyDb() }));
vi.mock('@/lib/auth', () => ({ auth: { requireAction: vi.fn(async () => state.session), getSession: vi.fn(async () => state.session) } }));
vi.mock('@/lib/fx-rates', () => ({ getFxRate: vi.fn(async () => 0.9) }));

import { RECEIPT_IDS, RECEIPT_TOTAL, TABLE_ID, WORKSPACE_ID, allRows, columnId, columns, dinner, emptyDb, fakeAdapter, group, hotel } from './fixture';
import { allReceiptRows, loadMealRecord, loadMealRecords } from '@/lib/meals/service';
import { incompleteQueue } from '@/lib/meals/register';
import { applyNewReading, confirmReceipt, loadReviewQueue } from '@/lib/review/service';
import { isWorkspaceReceipt, loadStatement } from '@/lib/tax/service';
import { loadInvoices } from '@/lib/overview/data';
import { applyAttributionToLedger } from '@/lib/overview/attribution';
import { findSimilarReceipt } from '@/lib/upload/duplicates';
import { generateCSV } from '@/lib/export-csv';
import { recomputeFxRates, retakeReceipt } from '@/app/app/actions';

const db = emptyDb();
let adapter: ReturnType<typeof fakeAdapter>;

beforeEach(() => {
  adapter = fakeAdapter();
  state.adapter = adapter;
});

const sorted = (ids: string[]) => [...ids].sort();
const once = (ids: string[]) => expect(sorted(ids)).toEqual(sorted(RECEIPT_IDS));

describe('the shared loader of the tax module, the review queue and the meal register', () => {
  it('returns every receipt once and no group', async () => {
    once((await allReceiptRows(adapter, TABLE_ID, columns)).map((r) => r.id));
  });

  it('also when the table arrives in pages that split a group from its receipts', async () => {
    const paged = { getRows: async (_t: string, q?: { offset?: number }) => {
      const offset = q?.offset ?? 0;
      return { items: allRows.slice(offset, offset + 2), total: allRows.length, hasMore: offset + 2 < allRows.length };
    } };
    once((await allReceiptRows(paged as never, TABLE_ID, columns)).map((r) => r.id));
  });
});

describe('tax module', () => {
  it('the statement of the year lists every receipt once and never a group', async () => {
    const statement = await loadStatement(db, WORKSPACE_ID, 2026);
    const rowIds = statement.items.map((i) => i.rowId);
    expect(rowIds).not.toContain('group');
    expect(rowIds).not.toContain('emptyGroup');
    once([...new Set(rowIds)]);
    expect(rowIds).toHaveLength(RECEIPT_IDS.length);
  });

  it('a group is no receipt a payment or an asset could be linked to; its receipts are', async () => {
    expect(await isWorkspaceReceipt(db, WORKSPACE_ID, 'group')).toBe(false);
    expect(await isWorkspaceReceipt(db, WORKSPACE_ID, 'emptyGroup')).toBe(false);
    expect(await isWorkspaceReceipt(db, WORKSPACE_ID, 'hotel')).toBe(true);
    expect(await isWorkspaceReceipt(db, WORKSPACE_ID, 'orphan')).toBe(true);
  });
});

describe('meal register', () => {
  it('lists the meal that lies in the group once, and not the group, although the group sits in the meal category', async () => {
    const records = await loadMealRecords(db, WORKSPACE_ID);
    expect(records.map((r) => r.rowId)).toEqual(['dinner']);
  });

  it('the open meal count of the dashboard does not count the group', async () => {
    expect(incompleteQueue(await loadMealRecords(db, WORKSPACE_ID))).toHaveLength(1);
  });

  it('a group cannot be opened as a meal', async () => {
    expect(await loadMealRecord(db, WORKSPACE_ID, 'group')).toBeNull();
    expect((await loadMealRecord(db, WORKSPACE_ID, 'dinner'))?.rowId).toBe('dinner');
  });
});

describe('review queue', () => {
  it('never lists a group, as an entry or as a look-alike of a receipt', async () => {
    // The group has the vendor, the day and (here) the amount of the hotel receipt.
    const twin = { ...group, cells: { ...group.cells, [columnId('Gross')]: 100 } } as Row;
    state.adapter = fakeAdapter(allRows.map((r) => (r.id === 'group' ? twin : r)));
    const queue = await loadReviewQueue(db, WORKSPACE_ID);
    const ids = queue.map((e) => e.rowId);
    expect(ids).not.toContain('group');
    expect(ids).not.toContain('emptyGroup');
    expect(new Set(ids).size).toBe(ids.length);
    expect(queue.flatMap((e) => e.duplicates.map((d) => d.rowId))).not.toContain('group');
  });

  it('a group cannot be confirmed or given a new reading', async () => {
    await expect(confirmReceipt(db, { workspaceId: WORKSPACE_ID, tenantId: null }, 'group')).rejects.toMatchObject({ code: 'row_not_found' });
    await expect(applyNewReading(db, { workspaceId: WORKSPACE_ID, tenantId: null }, 'group', ['gross'])).rejects.toMatchObject({ code: 'row_not_found' });
    expect(adapter.updated).toEqual([]);
  });
});

describe('overview charts', () => {
  it('chart every receipt once and no group', async () => {
    const invoices = await loadInvoices(WORKSPACE_ID);
    once(invoices.map((i) => i.id));
    expect(invoices.reduce((sum, i) => sum + i.amountNative, 0)).toBe(RECEIPT_TOTAL);
  });
});

describe('business share by vendor rule', () => {
  it('writes a share on receipts only', async () => {
    // No rule and no default stored: every receipt would get 100, which it has. Make them differ.
    const stale = allRows.map((r) => ({ ...r, cells: { ...r.cells, [columnId('Business Share %')]: 50 } }) as Row);
    adapter = fakeAdapter(stale);
    state.adapter = adapter;
    expect(await applyAttributionToLedger(WORKSPACE_ID)).toBe(RECEIPT_IDS.length);
    once(adapter.updated.map((u) => u.rowId));
  });
});

describe('exchange rate recomputation', () => {
  it('converts receipts only, also when a group says a foreign currency', async () => {
    const dollars = (r: Row) => ({ ...r, cells: { ...r.cells, [columnId('Currency')]: 'opt_usd' } }) as Row;
    adapter = fakeAdapter(allRows.map((r) => (r.id === 'group' || r.id === 'hotel' ? dollars(r) : r)));
    state.adapter = adapter;
    const result = await recomputeFxRates('2026-01-01', '2026-12-31');
    expect(adapter.updated.map((u) => u.rowId)).toEqual(['hotel']);
    expect(result).toEqual({ updated: 1, failed: 0, skippedEur: 3 });
  });
});

describe('duplicate check on upload', () => {
  it('a new receipt is not a look-alike of a group with the same vendor, day and amount', async () => {
    const identity = { date: '2026-03-10', vendor: 'Hotel Nordlicht', gross: 999 };
    expect(await findSimilarReceipt(db, WORKSPACE_ID, identity, 'new-upload')).toBeNull();
  });

  it('it still is one of the receipt that lies in the group', async () => {
    const identity = { date: '2026-03-10', vendor: 'Hotel Nordlicht', gross: 100 };
    expect((await findSimilarReceipt(db, WORKSPACE_ID, identity, 'new-upload'))?.rowId).toBe('hotel');
  });
});

describe('export in the DATEV layout', () => {
  it('has one line per receipt and none for a group', () => {
    const lines = generateCSV(columns, allRows).split('\r\n');
    expect(lines).toHaveLength(1 + RECEIPT_IDS.length);
    const numbers = lines.slice(1).map((line) => line.split(';')[1]);
    once(numbers);
    expect(lines.join('\n')).not.toContain('999');
  });

  it('a list of receipts only is exported unchanged', () => {
    expect(generateCSV(columns, [hotel, dinner])).toBe(generateCSV(columns, [group, hotel, dinner]));
  });
});

describe('reader', () => {
  it('a group is never read again from a new photo', async () => {
    await expect(retakeReceipt('group', { id: 'f1', originalName: 'foto.jpg' }, null)).rejects.toThrow('Receipt not found');
    expect(adapter.updated).toEqual([]);
  });
});
