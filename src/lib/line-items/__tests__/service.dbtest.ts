import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { confirmReceipt, loadReviewQueue } from '@/lib/review/service';
import { createWorkspace, db, type TestWorkspace } from '../../../../test/db-helpers';
import type { ReceiptLine } from '../lines';
import { loadPurchases, loadReceiptLines } from '../service';
import { answerLineKind, replaceReceiptLines, type LineItemsContext } from '../store';

/**
 * What the pages read of the lines, against a real database: the receipt
 * view, the review list's "Positionen prüfen" and "Was gekauft". Run with
 * `pnpm test:db`.
 */

let ws: TestWorkspace;
let ctx: LineItemsContext;
const line = (text: string, grossCents: number, kind: ReceiptLine['kind'] = 'groceries', quantity = 1): ReceiptLine => ({ text, quantity, unitPriceCents: null, grossCents, netCents: null, taxRate: 7, kind });
const complete = { Category: 'Software & Lizenzen', Zuordnung: 'Geschäftlich', Currency: 'EUR', 'FX Rate': 1, 'OCR Text': 'Text', 'Tax Rate': 7, Net: 1 };

beforeAll(async () => {
  ws = await createWorkspace();
  ctx = { workspaceId: ws.workspaceId, tenantId: ws.tenantId };
});
afterAll(async () => {
  await db.$disconnect();
});

describe('the receipt view', () => {
  it('shows the stored lines with the kinds a person gave, and checks them against the total the row holds now', async () => {
    const rowId = await ws.addReceipt({ ...complete, Name: 'Einkauf', Vendor: 'Markt Eins', Gross: 5, Date: '2026-10-01' });
    await replaceReceiptLines(db, ctx, rowId, { lines: [line('Äpfel', 300), line('Kaffee', 200, 'coffee_tea')], source: 'reading' });
    const view = (await loadReceiptLines(db, ws.workspaceId, rowId))!;
    expect(view).toMatchObject({ currency: 'EUR', reading: { outcome: 'lines', source: 'reading', textCut: false }, check: { addsUp: true, differenceCents: 0 } });
    await answerLineKind(db, ctx, view.lines[1].id, 'drink_out', 'Markt Eins', { rowId });
    expect((await loadReceiptLines(db, ws.workspaceId, rowId))!.lines.map((l) => [l.text, l.kind, l.answered])).toEqual([
      ['Äpfel', 'groceries', false],
      ['Kaffee', 'drink_out', true],
    ]);
    // Another company never sees the receipt; a line of another receipt is not answered through this one.
    const other = await createWorkspace();
    expect(await loadReceiptLines(db, other.workspaceId, rowId)).toBeNull();
    const second = await ws.addReceipt({ ...complete, Name: 'Zweiter', Vendor: 'Markt Eins', Gross: 1, Date: '2026-10-01' });
    await expect(answerLineKind(db, ctx, view.lines[0].id, 'alcohol', 'Markt Eins', { rowId: second })).rejects.toMatchObject({ code: 'line_not_found' });
  });
});

describe('the review list', () => {
  it('asks to check a receipt whose lines miss its total, ends when the total is corrected, and a confirmation settles it', async () => {
    const rowId = await ws.addReceipt({ ...complete, Name: 'Kassenbon', Vendor: 'Markt Zwei', Gross: 42.1, Date: '2026-10-02' });
    await replaceReceiptLines(db, ctx, rowId, { lines: [line('Wocheneinkauf', 4120)], source: 'reading' });
    const entry = (await loadReviewQueue(db, ws.workspaceId)).find((e) => e.rowId === rowId)!;
    expect(entry.reasons).toEqual(['lines_differ']);
    expect(entry.linesCheck).toMatchObject({ sumCents: 4120, totalCents: 4210, differenceCents: -90 });
    expect(entry.canConfirm).toBe(true);

    // A corrected total shows the difference at once: here it ends it.
    const gross = (await ws.adapter.getColumns(ws.tableId)).find((c) => c.name === 'Gross')!;
    await ws.adapter.updateRow(rowId, { [gross.id]: 41.2 });
    expect((await loadReviewQueue(db, ws.workspaceId)).find((e) => e.rowId === rowId)).toBeUndefined();
    await ws.adapter.updateRow(rowId, { [gross.id]: 45 });
    expect((await loadReviewQueue(db, ws.workspaceId)).find((e) => e.rowId === rowId)!.reasons).toEqual(['lines_differ']);

    await confirmReceipt(db, ctx, rowId);
    expect((await loadReviewQueue(db, ws.workspaceId)).find((e) => e.rowId === rowId)).toBeUndefined();
  });
});

describe('Was gekauft', () => {
  it('sums the company\'s receipts of the period by kind, item and shop, with what the lines do not explain', async () => {
    const w = await createWorkspace();
    const c = { workspaceId: w.workspaceId, tenantId: w.tenantId };
    const a = await w.addReceipt({ ...complete, Name: 'A', Vendor: 'Markt', Gross: 6.5, Date: '2026-09-03' });
    const b = await w.addReceipt({ ...complete, Name: 'B', Vendor: 'Café', Gross: 7.8, Date: '2026-09-04' });
    await w.addReceipt({ ...complete, Name: 'C', Vendor: 'Tankstelle', Gross: 20, Date: '2026-09-05' });
    await w.addReceipt({ ...complete, Name: 'D', Vendor: 'Markt', Gross: 99, Date: '2026-08-30' });
    await replaceReceiptLines(db, c, a, { lines: [line('Hafermilch', 358, 'groceries', 2), line('Bier', 292, 'alcohol')], source: 'reading' });
    await replaceReceiptLines(db, c, b, { lines: [line('Cappuccino', 780, 'drink_out', 2)], source: 'backfill' });
    const beer = (await loadReceiptLines(db, w.workspaceId, a))!.lines[1];
    await answerLineKind(db, c, beer.id, 'soft_drinks', 'Markt', { rowId: a });

    const o = await loadPurchases(db, w.workspaceId, { year: 2026, month: 9 });
    expect(o).toMatchObject({ totalCents: 3430, linesCents: 1430, unexplainedCents: 2000, receipts: 3, receiptsWithLines: 2 });
    expect(o.kinds.map((k) => [k.kind, k.cents])).toEqual([
      ['drink_out', 780],
      ['groceries', 358],
      ['soft_drinks', 292],
    ]);
    expect(o.topItems.map((i) => [i.text, i.count, i.cents])).toEqual([
      ['Cappuccino', 2, 780],
      ['Hafermilch', 2, 358],
      ['Bier', 1, 292],
    ]);
    expect(o.shops.map((s) => s.vendor)).toEqual(['Café', 'Markt']);
    expect((await loadPurchases(db, w.workspaceId, { year: 2026, month: null })).months.map((m) => m.month)).toEqual([8, 9]);
    // Another company's lines never count here.
    expect((await loadPurchases(db, ws.workspaceId, { year: 2026, month: 9 })).linesCents).toBe(0);
  });
});
