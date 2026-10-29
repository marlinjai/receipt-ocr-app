import { afterAll, describe, expect, it } from 'vitest';
import { loadReviewQueue } from '@/lib/review/service';
import { createWorkspace, db, type TestWorkspace } from '../../../../test/db-helpers';
import type { ReceiptLine } from '../lines';
import { repriceCompanyLines } from '../reprice';
import { loadPurchases, loadReceiptLines } from '../service';
import { replaceReceiptLines, repriceStoredLines, type LineItemsContext } from '../store';

/**
 * Re-deriving stored lines priced before tax, against a real database: the
 * four paths of the standard. Forward (lines stored with an invoice's net
 * amounts as gross get their gross), re-entry (a run again changes nothing; a
 * receipt read again keeps its new reading), backtrack (a total corrected
 * after the lines were stored is checked and priced as it is now). Run with
 * `pnpm test:db`.
 */

afterAll(async () => {
  await db.$disconnect();
});

const line = (text: string, cents: number, extra: Partial<ReceiptLine> = {}): ReceiptLine => ({ text, quantity: 1, unitPriceCents: cents, grossCents: cents, netCents: null, taxRate: null, kind: 'software_services', ...extra });
const complete = { Category: 'Software & Lizenzen', Zuordnung: 'Geschäftlich', Currency: 'EUR', 'FX Rate': 1, 'OCR Text': 'Text', Date: '2026-09-10' };

async function company() {
  const w = await createWorkspace();
  const ctx: LineItemsContext = { workspaceId: w.workspaceId, tenantId: w.tenantId };
  const columns = await w.adapter.getColumns(w.tableId);
  const set = (rowId: string, cells: Record<string, number>) => w.adapter.updateRow(rowId, Object.fromEntries(Object.entries(cells).map(([name, v]) => [columns.find((c) => c.name === name)!.id, v])));
  const items = (rowId: string) => db.receiptItem.findMany({ where: { rowId }, orderBy: { position: 'asc' }, select: { grossCents: true, netCents: true } });
  return { w, ctx, set, items };
}

/** A subscription invoice: one line of 22.00 before tax, 19 % added once, total 26.18; stored the way the reading stored it before. */
async function storedNetInvoice(w: TestWorkspace, ctx: LineItemsContext) {
  const rowId = await w.addReceipt({ ...complete, Name: 'Abo', Vendor: 'Beispiel Software', Gross: 26.18, Net: 22, 'Tax Rate': 19 });
  await replaceReceiptLines(db, ctx, rowId, { lines: [line('Plus plan', 2200)], source: 'backfill', model: 'test-small' });
  return rowId;
}

describe('re-deriving stored lines priced before tax', () => {
  it('gives an invoice\'s net lines their gross, keeps how and when they were read, and leaves till receipts and electronic invoices alone (forward)', async () => {
    const { w, ctx, items } = await company();
    const invoice = await storedNetInvoice(w, ctx);
    const till = await w.addReceipt({ ...complete, Name: 'Kasse', Vendor: 'Markt', Gross: 3.68, Net: 3.33, 'Tax Rate': 7 });
    await replaceReceiptLines(db, ctx, till, { lines: [line('Brot', 249, { kind: 'groceries' }), line('Wasser', 119, { kind: 'soft_drinks' })], source: 'reading' });
    const einvoice = await w.addReceipt({ ...complete, Name: 'XRechnung', Vendor: 'Beispiel GmbH', Gross: 119, Net: 100, 'Tax Rate': 19 });
    await replaceReceiptLines(db, ctx, einvoice, { lines: [line('Beratung', 11900, { netCents: 10000, taxRate: 19 })], source: 'einvoice', linesNetCents: 10000, totalNetCents: 10000 });
    const before = await db.receiptItemReading.findUnique({ where: { rowId: invoice } });
    // Before: the review list asks, though the lines add up on net; "Was gekauft" counts the kind short by the tax.
    expect((await loadReceiptLines(db, w.workspaceId, invoice))!.check).toMatchObject({ addsUp: true, basis: 'net' });
    expect((await loadPurchases(db, w.workspaceId, { year: 2026, month: 9 })).kinds.find((k) => k.kind === 'software_services')!.cents).toBe(2200 + 11900);

    expect(await repriceCompanyLines(db, ctx)).toEqual({ lookedAt: 2, rederived: 1, unchanged: 1, failed: 0 });
    expect(await items(invoice)).toEqual([{ grossCents: 2618, netCents: 2200 }]);
    const after = await db.receiptItemReading.findUnique({ where: { rowId: invoice } });
    expect(after).toMatchObject({ linesSumCents: 2618, linesNetCents: 2200, totalNetCents: null, source: 'backfill', model: 'test-small' });
    expect(after!.readAt).toEqual(before!.readAt);
    expect(await items(till)).toEqual([
      { grossCents: 249, netCents: null },
      { grossCents: 119, netCents: null },
    ]);
    expect(await items(einvoice)).toEqual([{ grossCents: 11900, netCents: 10000 }]);

    expect((await loadReceiptLines(db, w.workspaceId, invoice))!.check).toMatchObject({ addsUp: true, basis: 'net', sumCents: 2200, totalCents: 2200 });
    expect((await loadReviewQueue(db, w.workspaceId)).find((e) => e.rowId === invoice)?.reasons ?? []).not.toContain('lines_differ');
    const o = await loadPurchases(db, w.workspaceId, { year: 2026, month: 9 });
    expect(o.kinds.find((k) => k.kind === 'software_services')!.cents).toBe(2618 + 11900);
    expect(o.unexplainedCents).toBe(0);
  });

  it('changes nothing when run again (re-entry)', async () => {
    const { w, ctx, items } = await company();
    const invoice = await storedNetInvoice(w, ctx);
    await repriceCompanyLines(db, ctx);
    const first = await db.receiptItemReading.findUnique({ where: { rowId: invoice } });
    expect(await repriceCompanyLines(db, ctx)).toEqual({ lookedAt: 1, rederived: 0, unchanged: 1, failed: 0 });
    expect(await items(invoice)).toEqual([{ grossCents: 2618, netCents: 2200 }]);
    expect((await db.receiptItemReading.findUnique({ where: { rowId: invoice } }))!.updatedAt).toEqual(first!.updatedAt);
  });

  it('checks and prices a receipt whose total was corrected after its lines were stored against the new total (backtrack)', async () => {
    const { w, ctx, set, items } = await company();
    const invoice = await storedNetInvoice(w, ctx);
    await repriceCompanyLines(db, ctx);
    // The invoice was at 7 %, not 19 %: a person corrects gross and rate, the net stays.
    await set(invoice, { Gross: 23.54, 'Tax Rate': 7 });
    expect((await loadReceiptLines(db, w.workspaceId, invoice))!.check).toMatchObject({ addsUp: true, basis: 'net' });
    expect(await repriceStoredLines(db, ctx, invoice, { gross: 23.54, net: 22, taxRate: 7, tip: null })).toBe('rederived');
    expect(await items(invoice)).toEqual([{ grossCents: 2354, netCents: 2200 }]);
    // A corrected net the lines miss shows the difference at once, and pricing again hides nothing.
    await set(invoice, { Gross: 35.7, Net: 30, 'Tax Rate': 19 });
    expect((await loadReceiptLines(db, w.workspaceId, invoice))!.check).toMatchObject({ addsUp: false, basis: 'net', differenceCents: -800 });
    expect(await repriceCompanyLines(db, ctx)).toMatchObject({ rederived: 1 });
    expect(await items(invoice)).toEqual([{ grossCents: 2618, netCents: 2200 }]);
    expect((await loadReviewQueue(db, w.workspaceId)).find((e) => e.rowId === invoice)!.reasons).toContain('lines_differ');
  });

  it('a receipt read again after the re-derivation keeps its new reading, and is priced as it now stands (re-entry)', async () => {
    const { w, ctx, items } = await company();
    const invoice = await storedNetInvoice(w, ctx);
    await repriceCompanyLines(db, ctx);
    // "Seite neu lesen": the new reading prints the plan with its tax as two gross lines that add up.
    await replaceReceiptLines(db, ctx, invoice, { lines: [line('Plus plan', 2000), line('Add-on', 618)], source: 'reading', model: 'test-large' });
    expect(await repriceCompanyLines(db, ctx)).toEqual({ lookedAt: 1, rederived: 0, unchanged: 1, failed: 0 });
    expect(await items(invoice)).toEqual([
      { grossCents: 2000, netCents: null },
      { grossCents: 618, netCents: null },
    ]);
    expect(await db.receiptItemReading.findUnique({ where: { rowId: invoice } })).toMatchObject({ source: 'reading', model: 'test-large', linesSumCents: 2618, linesNetCents: null });
  });

  it('never touches a receipt of another company, nor one without lines', async () => {
    const { w, ctx } = await company();
    const invoice = await storedNetInvoice(w, ctx);
    const other = await company();
    expect(await repriceStoredLines(db, other.ctx, invoice, { gross: 26.18, net: 22, taxRate: 19, tip: null })).toBe('skipped');
    expect(await repriceCompanyLines(db, other.ctx)).toEqual({ lookedAt: 0, rederived: 0, unchanged: 0, failed: 0 });
    const empty = await w.addReceipt({ ...complete, Name: 'Leer', Vendor: 'Beispiel', Gross: 5 });
    await replaceReceiptLines(db, ctx, empty, { lines: [], source: 'reading' });
    expect(await repriceStoredLines(db, ctx, empty, { gross: 5, net: null, taxRate: 19, tip: null })).toBe('skipped');
    expect((await db.receiptItem.findMany({ where: { rowId: invoice } }))[0]).toMatchObject({ grossCents: 2200, netCents: null });
  });
});

describe('Was gekauft with a tip line', () => {
  it('counts a meal whose lines include the tip with the tip, so nothing shows as more than the receipt', async () => {
    const { w, ctx } = await company();
    const meal = await w.addReceipt({ ...complete, Category: 'Bewirtung', Name: 'Essen', Vendor: 'Trattoria Beispiel', Gross: 44, Net: 41.12, 'Tax Rate': 7, Tip: 4.4 });
    await replaceReceiptLines(db, ctx, meal, { lines: [line('Pasta', 4400, { kind: 'meal_out' }), line('Trinkgeld', 440, { kind: 'meal_out' })], source: 'reading' });
    expect((await loadReceiptLines(db, w.workspaceId, meal))!.check).toMatchObject({ addsUp: true, tipCents: 440, totalCents: 4840 });
    expect(await loadPurchases(db, w.workspaceId, { year: 2026, month: 9 })).toMatchObject({ totalCents: 4840, linesCents: 4840, unexplainedCents: 0 });
  });
});
