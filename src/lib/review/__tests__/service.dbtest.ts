import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { deleteReceiptRows } from '@/lib/meals/service';
import * as F from '@/lib/extraction/__tests__/fixtures';
import { loadMealRecord } from '@/lib/meals/service';
import { ReviewError, applyNewReading, confirmReceipt, keepBothReceipts, loadReviewQueue, recordReadFlags, type ReviewContext } from '../service';
import { saveItemDecision } from '@/lib/tax/service';
import { createWorkspace, db, plainMealReceipt, type TestWorkspace } from '../../../../test/db-helpers';

/**
 * The review queue against a real database: what needs a look is found on
 * read, what the reader recorded is kept until a person settles it, and a
 * look-alike decision is stored instead of living on the upload page.
 * Covers the four paths of the flow: forward, going back (a new reading),
 * resuming from what is stored, and coming back after it was settled.
 * Run with `pnpm test:db`.
 */

let ws: TestWorkspace;
let other: TestWorkspace;
let ctx: ReviewContext;
let imageColumnId: string;

const clean = (overrides: Record<string, string | number | null> = {}) =>
  plainMealReceipt({ Vendor: `Lokal ${randomUUID().slice(0, 8)}`, 'OCR Text': 'Beispieltext', 'Tax Rate': 19, ...overrides });

async function attach(w: TestWorkspace, rowId: string, sha256?: string): Promise<void> {
  const fileId = randomUUID();
  await w.adapter.addFileReference({
    rowId,
    columnId: imageColumnId,
    fileId,
    fileUrl: `/api/files/${fileId}`,
    originalName: 'beleg.jpg',
    mimeType: 'image/jpeg',
    metadata: { source: 'ocr-upload', ...(sha256 ? { sha256 } : {}) },
  });
}

const entryFor = async (rowId: string) => (await loadReviewQueue(db, ws.workspaceId)).find((e) => e.rowId === rowId);

beforeAll(async () => {
  ws = await createWorkspace();
  other = await createWorkspace();
  ctx = { workspaceId: ws.workspaceId, tenantId: ws.tenantId };
  imageColumnId = (await ws.adapter.getColumns(ws.tableId)).find((c) => c.name === 'Receipt Image')!.id;
});
afterAll(async () => {
  await db.$disconnect();
});

describe('what needs a look is found on the receipt as it is stored', () => {
  it('a complete receipt is not in the queue', async () => {
    const rowId = await ws.addReceipt(clean());
    expect(await entryFor(rowId)).toBeUndefined();
  });

  it('an empty assignment asks who bears the cost, until the cell is filled', async () => {
    const rowId = await ws.addReceipt(clean({ Category: 'Software & Lizenzen', Zuordnung: null }));
    const entry = (await entryFor(rowId))!;
    expect(entry.reasons).toEqual(['assignment_missing']);
    expect(entry.canConfirm).toBe(false);

    const column = (await ws.adapter.getColumns(ws.tableId)).find((c) => c.name === 'Zuordnung')!;
    const business = (await ws.adapter.getSelectOptions(column.id)).find((o) => o.name === 'Geschäftlich')!;
    await ws.adapter.updateRow(rowId, { [column.id]: business.id });
    expect(await entryFor(rowId)).toBeUndefined();
  });

  it('is not asked of a meal, which the register judges, nor of a receipt the tax side has a decision for', async () => {
    const meal = await ws.addReceipt(clean({ Zuordnung: null }));
    expect(await entryFor(meal)).toBeUndefined();

    const decided = await ws.addReceipt(clean({ Category: 'Software & Lizenzen', Zuordnung: null }));
    expect((await entryFor(decided))!.reasons).toEqual(['assignment_missing']);
    await saveItemDecision(db, ctx, decided, {
      allocations: [{ purpose: 'business', shareBp: 5000 }, { purpose: 'study', shareBp: 3000 }],
      formLineKey: 'euer.telecom',
      employmentLineKey: 'employment.study_costs',
    });
    expect(await entryFor(decided)).toBeUndefined();
  });

  it('a page nothing could be read from is one finding, not three', async () => {
    const rowId = await ws.addReceipt({ Name: 'Nicht lesbar: scan-07.pdf' });
    await attach(ws, rowId);
    expect((await entryFor(rowId))!.reasons).toEqual(['read_failed']);
  });

  it('missing amount, date and vendor are named, and end when the receipt is completed', async () => {
    const rowId = await ws.addReceipt({ Name: 'Beleg', 'OCR Text': 'Beispieltext', Category: 'Bewirtung' });
    expect((await entryFor(rowId))!.reasons).toEqual(['amount_missing', 'date_missing', 'vendor_missing']);

    const columns = await ws.adapter.getColumns(ws.tableId);
    const id = (name: string) => columns.find((c) => c.name === name)!.id;
    await ws.adapter.updateRow(rowId, { [id('Gross')]: 42, [id('Date')]: '2025-06-01', [id('Vendor')]: `Lokal ${randomUUID()}` });
    expect(await entryFor(rowId)).toBeUndefined();
  });

  it('a tax rate no receipt carries is found on a receipt stored before the reader was fixed', async () => {
    const tooHigh = await ws.addReceipt(clean({ Gross: 34.2, Net: 5.46, 'Tax Rate': 526.37 }));
    const netAboveTotal = await ws.addReceipt(clean({ Gross: 61.4, Net: 916694.18, 'Tax Rate': 0.01 }));
    expect((await entryFor(tooHigh))!.reasons).toEqual(['tax_implausible']);
    expect((await entryFor(netAboveTotal))!.reasons).toEqual(['tax_implausible']);
    expect((await entryFor(tooHigh))!.canConfirm).toBe(false);
  });
});

describe('what the reader recorded', () => {
  it('forward: a recorded doubt is in the queue until a person confirms the receipt', async () => {
    const rowId = await ws.addReceipt(clean());
    await recordReadFlags(db, ctx, rowId, ['total_unconfirmed', 'not_classified']);

    const entry = (await entryFor(rowId))!;
    expect(entry.reasons).toEqual(['not_classified', 'total_unconfirmed']);
    expect(entry.canConfirm).toBe(true);

    await confirmReceipt(db, ctx, rowId);
    expect(await entryFor(rowId)).toBeUndefined();
  });

  it('resume: the doubt is still there on the next load, from the database alone', async () => {
    const rowId = await ws.addReceipt(clean());
    await recordReadFlags(db, ctx, rowId, ['total_conflict']);
    expect((await db.receiptReview.findUnique({ where: { rowId } }))!.flags).toEqual(['total_conflict']);
    expect((await entryFor(rowId))!.reasons).toEqual(['total_conflict']);
  });

  it('going back: a new reading reopens a confirmed receipt with the new doubts only', async () => {
    const rowId = await ws.addReceipt(clean());
    await recordReadFlags(db, ctx, rowId, ['total_unconfirmed']);
    await confirmReceipt(db, ctx, rowId);

    await recordReadFlags(db, ctx, rowId, ['category_doubt']);
    expect((await entryFor(rowId))!.reasons).toEqual(['category_doubt']);

    // A reading with nothing to doubt clears what an earlier reading recorded.
    await recordReadFlags(db, ctx, rowId, []);
    expect(await entryFor(rowId)).toBeUndefined();
  });

  it('coming back after it was settled: confirming again changes nothing', async () => {
    const rowId = await ws.addReceipt(clean());
    await recordReadFlags(db, ctx, rowId, ['not_classified']);
    await confirmReceipt(db, ctx, rowId, () => new Date('2026-10-10T08:00:00Z'));
    await confirmReceipt(db, ctx, rowId, () => new Date('2026-10-10T09:00:00Z'));
    expect(await entryFor(rowId)).toBeUndefined();
    expect(await db.receiptReview.count({ where: { rowId } })).toBe(1);
  });

  it('confirming does not hide a fact that is still wrong on the receipt', async () => {
    const rowId = await ws.addReceipt(clean({ Gross: null }));
    await recordReadFlags(db, ctx, rowId, ['not_classified']);
    await confirmReceipt(db, ctx, rowId);
    expect((await entryFor(rowId))!.reasons).toEqual(['amount_missing']);
  });

  it('a value that is not a known flag never reaches the queue', async () => {
    const rowId = await ws.addReceipt(clean());
    await recordReadFlags(db, ctx, rowId, ['total_unconfirmed', 'made_up' as never]);
    expect((await db.receiptReview.findUnique({ where: { rowId } }))!.flags).toEqual(['total_unconfirmed']);
  });
});

describe('look-alike receipts', () => {
  it('the same day, total and vendor are a possible duplicate on both receipts, found without the upload page', async () => {
    const vendor = `Grillhaus ${randomUUID().slice(0, 8)}`;
    const a = await ws.addReceipt(clean({ Vendor: vendor, Date: '2025-10-09', Gross: 48.4 }));
    const b = await ws.addReceipt(clean({ Vendor: vendor, Date: '2025-10-09', Gross: 48.4 }));

    expect((await entryFor(a))!.reasons).toEqual(['possible_duplicate']);
    expect((await entryFor(a))!.duplicates.map((d) => d.rowId)).toEqual([b]);
    expect((await entryFor(b))!.duplicates.map((d) => d.rowId)).toEqual([a]);
  });

  it('"keep both" settles it for good: it is stored, and it holds from either receipt', async () => {
    const vendor = `Cafe ${randomUUID().slice(0, 8)}`;
    const a = await ws.addReceipt(clean({ Vendor: vendor, Date: '2025-07-31', Gross: 24.4 }));
    const b = await ws.addReceipt(clean({ Vendor: vendor, Date: '2025-07-31', Gross: 24.4 }));

    await keepBothReceipts(db, ctx, a, b);
    expect(await entryFor(a)).toBeUndefined();
    expect(await entryFor(b)).toBeUndefined();

    // Deciding it again, from the other side, changes nothing.
    await keepBothReceipts(db, ctx, b, a);
    expect((await db.receiptReview.findUnique({ where: { rowId: a } }))!.distinctFrom).toEqual([b]);

    // A third receipt of the same kind is a new question; the settled pair stays settled.
    const c = await ws.addReceipt(clean({ Vendor: vendor, Date: '2025-07-31', Gross: 24.4 }));
    expect((await entryFor(c))!.duplicates.map((d) => d.rowId).sort()).toEqual([a, b].sort());
    expect((await entryFor(a))!.duplicates.map((d) => d.rowId)).toEqual([c]);
  });

  it('a new reading of a receipt keeps the look-alike decision', async () => {
    const vendor = `Bistro ${randomUUID().slice(0, 8)}`;
    const a = await ws.addReceipt(clean({ Vendor: vendor, Date: '2025-03-21', Gross: 37.7 }));
    const b = await ws.addReceipt(clean({ Vendor: vendor, Date: '2025-03-21', Gross: 37.7 }));
    await keepBothReceipts(db, ctx, a, b);
    await recordReadFlags(db, ctx, a, []);
    expect(await entryFor(a)).toBeUndefined();
  });

  it('the very same file on two receipts is a duplicate whatever their fields say', async () => {
    const hash = 'a'.repeat(64);
    const a = await ws.addReceipt(clean({ Date: '2025-01-05', Gross: 10 }));
    const b = await ws.addReceipt(clean({ Date: '2025-02-06', Gross: 20 }));
    await attach(ws, a, hash);
    await attach(ws, b, hash);
    expect((await entryFor(a))!.duplicates.map((d) => d.rowId)).toEqual([b]);
  });

  it('a different vendor on the same day with the same total is not a duplicate; a missing vendor may be', async () => {
    const a = await ws.addReceipt(clean({ Vendor: 'Taverna Beispiel', Date: '2025-05-02', Gross: 45.3 }));
    const b = await ws.addReceipt(clean({ Vendor: 'Buchhandlung Muster', Date: '2025-05-02', Gross: 45.3 }));
    expect(await entryFor(a)).toBeUndefined();
    expect(await entryFor(b)).toBeUndefined();

    const unnamed = await ws.addReceipt(clean({ Vendor: null, Date: '2025-05-02', Gross: 45.3 }));
    expect((await entryFor(unnamed))!.reasons).toEqual(['vendor_missing', 'possible_duplicate']);
  });

  it('deleting one of the two ends the question and removes its review state', async () => {
    const vendor = `Imbiss ${randomUUID().slice(0, 8)}`;
    const a = await ws.addReceipt(clean({ Vendor: vendor, Date: '2025-08-08', Gross: 18.2 }));
    const b = await ws.addReceipt(clean({ Vendor: vendor, Date: '2025-08-08', Gross: 18.2 }));
    await recordReadFlags(db, ctx, b, ['total_unconfirmed']);

    await deleteReceiptRows(db, ctx, [b], { deleteStoredFile: async () => {} });

    expect(await entryFor(a)).toBeUndefined();
    expect(await db.receiptReview.count({ where: { rowId: b } })).toBe(0);
  });
});

describe('a new reading of a receipt stored by the old reader', () => {
  // What the old reader left behind for the cafe receipt: a receipt number as the total, the tip inside it.
  const oldCafe = () => clean({ Vendor: 'Cafe Morgenrot', 'OCR Text': F.CAFE_WITH_RECEIPT_NUMBERS, Date: '2025-02-19', Gross: 61.4, Net: 916694.18, 'Tax Rate': 0.01 });

  it('forward: the difference is offered field by field, and nothing is written until it is taken', async () => {
    const rowId = await ws.addReceipt(oldCafe());
    const entry = (await entryFor(rowId))!;
    expect(entry.reasons).toEqual(['tax_implausible', 'reading_differs']);
    expect(entry.canConfirm).toBe(true);
    expect(Object.fromEntries(entry.proposal.map((c) => [c.field, [c.from, c.to]]))).toEqual({
      gross: [61.4, 58.7],
      net: [916694.18, 49.33],
      taxRate: [0.01, 19],
      tip: [null, 2.7],
    });
    expect((await loadMealRecord(db, ws.workspaceId, rowId))!.gross).toBe(61.4);
  });

  it('taking it writes the values read on the server, with the tax groups, and the receipt leaves the list', async () => {
    const rowId = await ws.addReceipt(oldCafe());
    const written = await applyNewReading(db, ctx, rowId, ['gross', 'net', 'taxRate', 'tip']);
    expect(written.sort()).toEqual(['gross', 'net', 'taxRate', 'tip']);

    const record = (await loadMealRecord(db, ws.workspaceId, rowId))!;
    expect(record).toMatchObject({ gross: 58.7, net: 49.33, taxRate: 19, tip: 2.7, vendor: 'Cafe Morgenrot' });
    expect(record.taxLines).toEqual([{ rate: 19, net: 49.33, tax: 9.37 }]);
    expect(await entryFor(rowId)).toBeUndefined();
  });

  it('only the fields that were chosen are written', async () => {
    const rowId = await ws.addReceipt(oldCafe());
    expect(await applyNewReading(db, ctx, rowId, ['tip'])).toEqual(['tip']);
    const record = (await loadMealRecord(db, ws.workspaceId, rowId))!;
    expect(record).toMatchObject({ gross: 61.4, tip: 2.7 });
    // The rest is still on offer.
    expect((await entryFor(rowId))!.proposal.map((c) => c.field)).toEqual(['gross', 'net', 'taxRate']);
  });

  it('coming back: taking it twice writes nothing the second time', async () => {
    const rowId = await ws.addReceipt(oldCafe());
    await applyNewReading(db, ctx, rowId, ['gross', 'net', 'taxRate', 'tip']);
    expect(await applyNewReading(db, ctx, rowId, ['gross', 'net', 'taxRate', 'tip'])).toEqual([]);
  });

  it('going back: a value changed by hand after the offer is simply compared again', async () => {
    const rowId = await ws.addReceipt(oldCafe());
    const columns = await ws.adapter.getColumns(ws.tableId);
    const id = (name: string) => columns.find((c) => c.name === name)!.id;
    // The person corrects the total by hand to what the reader reads: that field is no longer offered.
    await ws.adapter.updateRow(rowId, { [id('Gross')]: 58.7 });
    expect((await entryFor(rowId))!.proposal.map((c) => c.field)).toEqual(['net', 'taxRate', 'tip']);
    // And a field that no longer differs is not written even when it is asked for.
    expect(await applyNewReading(db, ctx, rowId, ['gross'])).toEqual([]);
  });

  it('"Geprüft" keeps what is stored and ends the offer; a field that is plainly wrong stays listed', async () => {
    const rowId = await ws.addReceipt(clean({ Vendor: 'Since 2016', 'OCR Text': F.FOODBAR_TWO_RATES, Date: '2025-03-21', Gross: 37.7, Net: 35.14, 'Tax Rate': 7 }));
    expect((await entryFor(rowId))!.proposal).toEqual([{ field: 'vendor', from: 'Since 2016', to: 'Fantastic Foodbar' }]);
    await confirmReceipt(db, ctx, rowId);
    expect(await entryFor(rowId)).toBeUndefined();

    // Its own day: the receipts of the tests above share day, total and vendor with
    // `oldCafe()` and would list this one as a possible duplicate as well.
    const wrong = await ws.addReceipt({ ...oldCafe(), Date: '2025-02-27' });
    await confirmReceipt(db, ctx, wrong);
    expect((await entryFor(wrong))!.reasons).toEqual(['tax_implausible']);
    expect((await entryFor(wrong))!.proposal).toEqual([]);
  });

  it('a bar stored as software is offered as a meal, and taking it files it with the account', async () => {
    const rowId = await ws.addReceipt(
      clean({ Vendor: 'Hopfen Retail Germany GmbH', 'OCR Text': F.BAR_WITH_SERVER, Date: '2025-12-05', Gross: 40.5, Net: 34.04, 'Tax Rate': 19, Category: 'Software & Lizenzen', Konto: '4806' }),
    );
    expect((await entryFor(rowId))!.proposal).toEqual([{ field: 'category', from: 'Software & Lizenzen', to: 'Bewirtung' }]);
    await applyNewReading(db, ctx, rowId, ['category']);

    const columns = await ws.adapter.getColumns(ws.tableId);
    const row = (await ws.adapter.getRow(rowId))!;
    expect(row.cells[columns.find((c) => c.name === 'Konto')!.id]).toBe('4650');
    // It is a meal now, so it waits in the meal queue for guests and occasion.
    expect(await loadMealRecord(db, ws.workspaceId, rowId)).not.toBeNull();
  });

  it("another workspace's receipt cannot be given a new reading", async () => {
    const foreign = await other.addReceipt(oldCafe());
    await expect(applyNewReading(db, ctx, foreign, ['gross'])).rejects.toBeInstanceOf(ReviewError);
    const columns = await other.adapter.getColumns(other.tableId);
    expect((await other.adapter.getRow(foreign))!.cells[columns.find((c) => c.name === 'Gross')!.id]).toBe(61.4);
  });
});

/**
 * The course invoice of 2026-10-10 as the old reader left it: the subtotal as
 * the total, 19 percent German tax, a euro sign in the name, no currency and
 * no exchange rate. 360 dollars were paid. Covers forward, taking part of it,
 * coming back, a value changed by hand in between, and the rate that cannot
 * be had.
 */
describe('a new reading in another currency', () => {
  const oldName = 'Example Courses \u2013 Premium Package \u2013 \u20ac450.00 \u2013 26.11.2025';
  // Its own day per receipt: same day, total and vendor would make them look-alikes of each other.
  let nextDay = 1;
  const oldDollarInvoice = (overrides: Record<string, string | number | null> = {}) => ({
    Name: oldName,
    Vendor: 'Example Courses',
    Gross: 450,
    Net: 378.15,
    'Tax Rate': 19,
    Date: `2025-11-${String(nextDay++).padStart(2, '0')}`,
    Category: 'Sonstige Ausgaben',
    Zuordnung: 'Geschäftlich',
    'OCR Text': F.DOLLAR_INVOICE_WITH_DISCOUNT,
    ...overrides,
  });
  // Stands in for the exchange-rate lookup (getFxRate): no day, no rate.
  const lookup = (rate: number | null = 0.8642) => vi.fn(async (_currency: string, isoDate: string | null) => (isoDate ? rate : null));

  /** The cells of a row by column name, a select cell as the name of its option. */
  async function cellsOf(w: TestWorkspace, rowId: string, names: string[]): Promise<Record<string, unknown>> {
    const columns = await w.adapter.getColumns(w.tableId);
    const row = (await w.adapter.getRow(rowId))!;
    const out: Record<string, unknown> = {};
    for (const name of names) {
      const column = columns.find((c) => c.name === name)!;
      const value = row.cells[column.id] ?? null;
      out[name] = column.type === 'select' && value !== null ? (await w.adapter.getSelectOptions(column.id)).find((o) => o.id === value)?.name : value;
    }
    return out;
  }
  const money = (rowId: string) => cellsOf(ws, rowId, ['Gross', 'Net', 'Tax Rate', 'Tax Rates', 'Currency', 'FX Rate']);
  const dayOf = async (rowId: string) => (await entryFor(rowId))?.date ?? null;

  it('forward: total, net, rate and currency are offered together, and nothing is written until they are taken', async () => {
    const rowId = await ws.addReceipt(oldDollarInvoice());
    const entry = (await entryFor(rowId))!;
    expect(entry.reasons).toEqual(['reading_differs']);
    // The stored amount is still shown in the currency the row holds: an empty cell is euros.
    expect(entry).toMatchObject({ gross: 450, currency: 'EUR' });
    expect(Object.fromEntries(entry.proposal.map((c) => [c.field, [c.from, c.to]]))).toEqual({
      name: [oldName, 'Example Courses, 360.00 USD, 26.11.2025'],
      gross: [450, 360],
      net: [378.15, 360],
      taxRate: [19, 0],
      currency: [null, 'USD'],
    });
    expect(await money(rowId)).toEqual({ Gross: 450, Net: 378.15, 'Tax Rate': 19, 'Tax Rates': null, Currency: null, 'FX Rate': null });
  });

  it('taking it writes 360 dollars with the rate of the receipt day and no tax, and the receipt leaves the list', async () => {
    const rowId = await ws.addReceipt(oldDollarInvoice());
    const day = await dayOf(rowId);
    const fxRateFor = lookup();
    const written = await applyNewReading(db, ctx, rowId, ['name', 'gross', 'net', 'taxRate', 'currency'], fxRateFor);
    expect(written.sort()).toEqual(['currency', 'gross', 'name', 'net', 'taxRate']);

    expect(await money(rowId)).toEqual({ Gross: 360, Net: 360, 'Tax Rate': 0, 'Tax Rates': '0 %', Currency: 'USD', 'FX Rate': 0.8642 });
    expect(await cellsOf(ws, rowId, ['Name'])).toEqual({ Name: 'Example Courses, 360.00 USD, 26.11.2025' });
    // One lookup, for the currency that was read and the day the row shows.
    expect(fxRateFor.mock.calls).toEqual([['USD', day]]);
    expect(await entryFor(rowId)).toBeUndefined();
  });

  it('an amount never comes without the currency it was read in', async () => {
    const rowId = await ws.addReceipt(oldDollarInvoice());
    // Only the total is asked for: 360 in a row that still says euros would be a wrong amount.
    const written = await applyNewReading(db, ctx, rowId, ['gross'], lookup());
    expect(written.sort()).toEqual(['currency', 'gross']);
    expect(await money(rowId)).toMatchObject({ Gross: 360, Currency: 'USD', 'FX Rate': 0.8642, Net: 378.15, 'Tax Rate': 19 });
    // The rest is still on offer.
    expect((await entryFor(rowId))!.proposal.map((c) => c.field)).toEqual(['net', 'taxRate']);
  });

  it('the currency can be taken on its own; the rate stays out of it', async () => {
    const rowId = await ws.addReceipt(oldDollarInvoice());
    expect(await applyNewReading(db, ctx, rowId, ['currency'], lookup())).toEqual(['currency']);
    expect(await money(rowId)).toMatchObject({ Gross: 450, Net: 378.15, 'Tax Rate': 19, Currency: 'USD', 'FX Rate': 0.8642 });
    expect((await entryFor(rowId))!.proposal.map((c) => c.field)).toEqual(['name', 'gross', 'net', 'taxRate']);
    // The tax rate alone brings no currency with it.
    const other = await ws.addReceipt(oldDollarInvoice());
    expect(await applyNewReading(db, ctx, other, ['taxRate'], lookup())).toEqual(['taxRate']);
    expect(await money(other)).toMatchObject({ 'Tax Rate': 0, 'Tax Rates': '0 %', Currency: null, 'FX Rate': null });
  });

  it('coming back: taking it twice writes nothing the second time and asks for no rate', async () => {
    const rowId = await ws.addReceipt(oldDollarInvoice());
    await applyNewReading(db, ctx, rowId, ['name', 'gross', 'net', 'taxRate', 'currency'], lookup());
    const again = lookup(0.5);
    expect(await applyNewReading(db, ctx, rowId, ['name', 'gross', 'net', 'taxRate', 'currency'], again)).toEqual([]);
    expect(again).not.toHaveBeenCalled();
    expect(await money(rowId)).toMatchObject({ Currency: 'USD', 'FX Rate': 0.8642 });
  });

  it('going back: a currency set by hand after the offer is no longer offered, and its rate is not written over', async () => {
    const rowId = await ws.addReceipt(oldDollarInvoice());
    expect((await entryFor(rowId))!.proposal.map((c) => c.field)).toContain('currency');
    // The person sets dollars and their own rate in the table.
    const columns = await ws.adapter.getColumns(ws.tableId);
    const currency = columns.find((c) => c.name === 'Currency')!;
    const usd = (await ws.adapter.getSelectOptions(currency.id)).find((o) => o.name === 'USD')!.id;
    await ws.adapter.updateRow(rowId, { [currency.id]: usd, [columns.find((c) => c.name === 'FX Rate')!.id]: 0.9 });

    expect((await entryFor(rowId))!.proposal.map((c) => c.field)).toEqual(['name', 'gross', 'net', 'taxRate']);
    const fxRateFor = lookup();
    expect((await applyNewReading(db, ctx, rowId, ['gross', 'currency'], fxRateFor)).sort()).toEqual(['gross']);
    expect(fxRateFor).not.toHaveBeenCalled();
    expect(await money(rowId)).toMatchObject({ Gross: 360, Currency: 'USD', 'FX Rate': 0.9 });
  });

  it('a receipt without a date gets the currency and a blank rate, never a guessed one', async () => {
    const rowId = await ws.addReceipt(oldDollarInvoice({ Date: null }));
    const fxRateFor = lookup();
    await applyNewReading(db, ctx, rowId, ['name', 'gross', 'net', 'taxRate', 'currency'], fxRateFor);
    expect(fxRateFor.mock.calls).toEqual([['USD', null]]);
    expect(await money(rowId)).toEqual({ Gross: 360, Net: 360, 'Tax Rate': 0, 'Tax Rates': '0 %', Currency: 'USD', 'FX Rate': null });
    // The missing date is what the list still asks for.
    expect((await entryFor(rowId))!.reasons).toEqual(['date_missing']);
  });

  it('a rate that cannot be looked up leaves the cell blank; the reading is written all the same', async () => {
    const rowId = await ws.addReceipt(oldDollarInvoice());
    await applyNewReading(db, ctx, rowId, ['gross', 'net', 'taxRate', 'currency'], lookup(null));
    expect(await money(rowId)).toEqual({ Gross: 360, Net: 360, 'Tax Rate': 0, 'Tax Rates': '0 %', Currency: 'USD', 'FX Rate': null });
  });

  it('a currency the table has no option for is not offered, and neither are the amounts read in it', async () => {
    const fresh = await createWorkspace();
    const columns = await fresh.adapter.getColumns(fresh.tableId);
    const currency = columns.find((c) => c.name === 'Currency')!;
    const usd = (await fresh.adapter.getSelectOptions(currency.id)).find((o) => o.name === 'USD')!;
    await fresh.adapter.updateSelectOption(usd.id, { name: 'Dollar' });

    const rowId = await fresh.addReceipt(oldDollarInvoice());
    const entry = (await loadReviewQueue(db, fresh.workspaceId)).find((e) => e.rowId === rowId)!;
    // What does not depend on the currency is still offered; 360 is not, it could only land in a row that says euros.
    expect(entry.proposal.map((c) => c.field)).toEqual(['taxRate']);
    const freshCtx = { workspaceId: fresh.workspaceId, tenantId: fresh.tenantId };
    expect(await applyNewReading(db, freshCtx, rowId, ['name', 'gross', 'net', 'taxRate', 'currency'], lookup())).toEqual(['taxRate']);
    expect(await cellsOf(fresh, rowId, ['Gross', 'Currency', 'FX Rate'])).toEqual({ Gross: 450, Currency: null, 'FX Rate': null });
  });

  it('a euro receipt of the old reader, its currency never filled in, is offered no currency', async () => {
    const rowId = await ws.addReceipt({ Name: 'Abendessen', Vendor: 'Bangkok Garten', Gross: 50, Net: 42.02, 'Tax Rate': 19, Date: '2025-04-02', Category: 'Bewirtung', 'OCR Text': F.THAI_TOTAL_TIP_GRAND_TOTAL });
    expect((await entryFor(rowId))!.proposal.map((c) => c.field)).toEqual(['gross', 'net', 'tip']);
    const fxRateFor = lookup();
    await applyNewReading(db, ctx, rowId, ['gross', 'net', 'tip'], fxRateFor);
    expect(fxRateFor).not.toHaveBeenCalled();
    expect(await money(rowId)).toMatchObject({ Gross: 45.2, Currency: null, 'FX Rate': null });
  });
});

describe('one workspace never sees or settles another one\'s receipts', () => {
  it('the queue holds only its own receipts, and a foreign row cannot be confirmed or paired', async () => {
    const mine = await ws.addReceipt(clean({ Gross: null }));
    const foreign = await other.addReceipt(clean({ Gross: null }));

    const queue = await loadReviewQueue(db, ws.workspaceId);
    expect(queue.some((e) => e.rowId === mine)).toBe(true);
    expect(queue.some((e) => e.rowId === foreign)).toBe(false);

    await expect(confirmReceipt(db, ctx, foreign)).rejects.toBeInstanceOf(ReviewError);
    await expect(keepBothReceipts(db, ctx, mine, foreign)).rejects.toBeInstanceOf(ReviewError);
    await expect(keepBothReceipts(db, ctx, mine, mine)).rejects.toBeInstanceOf(ReviewError);
    expect(await db.receiptReview.count({ where: { rowId: foreign } })).toBe(0);
  });

  it('a workspace without a table has an empty queue', async () => {
    expect(await loadReviewQueue(db, `test-ws-${randomUUID()}`)).toEqual([]);
  });
});
