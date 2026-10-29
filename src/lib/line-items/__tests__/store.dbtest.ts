import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { deleteReceiptRows } from '@/lib/meals/service';
import type { LinesAnswer, LinesInput } from '@/lib/receipt-classifier';
import { ClassifierUnavailableError, UnusableAnswerError } from '@/lib/receipt-classifier';
import { createWorkspace, db, type TestWorkspace } from '../../../../test/db-helpers';
import { backfillReceiptLines, companiesWithReceipts, dailyLinesBackfill, type LinesReader } from '../backfill';
import { structuredReceiptFields } from '@/lib/einvoice';
import { readInvoiceXml } from '@/lib/einvoice/parse';
import { UBL_INVOICE_WITH_LINES } from '@/lib/einvoice/__tests__/samples';
import { parseModelLines, type ReceiptLine } from '../lines';
import { MAX_ATTEMPTS, MAX_TRANSIENT_FAILURES, answerLineKind, loadKindAnswers, replaceReceiptLines, withAnswers, type LineItemsContext } from '../store';

/**
 * Storing a receipt's lines and the backfill of stored receipts, against a
 * real database. Covers the four paths of the plan's test section: forward
 * (lines stored and adding up), backtrack (a receipt read again replaces its
 * lines and keeps a person's kind answers), resume (a reload shows the same
 * lines) and re-entry (the backfill run twice reads nothing twice, a failed
 * read is retried and never leaves half the lines). Run with `pnpm test:db`.
 */

let ws: TestWorkspace;
let other: TestWorkspace;
let ctx: LineItemsContext;

const line = (text: string, grossCents: number, kind: ReceiptLine['kind'] = 'groceries'): ReceiptLine => ({ text, quantity: 1, unitPriceCents: grossCents, grossCents, netCents: null, taxRate: 7, kind });
const supermarket = parseModelLines([
  { text: 'Hafermilch', quantity: 2, unitPrice: 1.79, gross: 3.58, taxRate: 7, kind: 'groceries' },
  { text: 'Kaffeebohnen', quantity: 1, unitPrice: 8.99, gross: 8.99, taxRate: 7, kind: 'coffee_tea' },
  { text: 'Pfand', quantity: 6, unitPrice: 0.25, gross: 1.5, taxRate: 19, kind: 'deposit_discount' },
  { text: 'Rabatt', gross: -0.5, kind: 'deposit_discount' },
])!;

const linesOf = async (rowId: string) => {
  const answers = await loadKindAnswers(db, ws.workspaceId);
  const items = await db.receiptItem.findMany({ where: { authWorkspaceId: ws.workspaceId, rowId }, orderBy: { position: 'asc' } });
  return items.map((i) => withAnswers(i, 'REWE Markt', answers));
};

const receipt = (overrides: Record<string, string | number | null> = {}) =>
  ws.addReceipt({ Name: 'Einkauf', Vendor: 'REWE Markt', Gross: 13.57, Date: '2026-10-01', Currency: 'EUR', 'FX Rate': 1, 'OCR Text': 'REWE\nHafermilch 3,58\nSUMME 13,57', ...overrides });

beforeAll(async () => {
  ws = await createWorkspace();
  other = await createWorkspace();
  ctx = { workspaceId: ws.workspaceId, tenantId: ws.tenantId };
});
afterAll(async () => {
  await db.$disconnect();
});

describe('storing the lines of a reading', () => {
  it('stores a supermarket receipt with deposit and discount, and records that it was read (forward)', async () => {
    const rowId = await receipt();
    expect(await replaceReceiptLines(db, ctx, rowId, { lines: supermarket, source: 'reading', model: 'test-model', usage: { inputTokens: 10, outputTokens: 20 } })).toBe(true);
    const stored = await linesOf(rowId);
    expect(stored.map((l) => [l.position, l.text, l.grossCents, l.kind])).toEqual([
      [0, 'Hafermilch', 358, 'groceries'],
      [1, 'Kaffeebohnen', 899, 'coffee_tea'],
      [2, 'Pfand', 150, 'deposit_discount'],
      [3, 'Rabatt', -50, 'deposit_discount'],
    ]);
    const reading = await db.receiptItemReading.findUnique({ where: { rowId } });
    expect(reading).toMatchObject({ outcome: 'lines', source: 'reading', lineCount: 4, linesSumCents: 1357, model: 'test-model', inputTokens: 10, outputTokens: 20 });
  });

  it('a receipt read again replaces its lines, and keeps a person\'s kind for the lines with the same text (backtrack)', async () => {
    const rowId = await receipt();
    await replaceReceiptLines(db, ctx, rowId, { lines: supermarket, source: 'reading' });
    const beans = (await linesOf(rowId)).find((l) => l.text === 'Kaffeebohnen')!;
    await answerLineKind(db, ctx, beans.id, 'drink_out', 'REWE Markt');
    expect((await linesOf(rowId)).find((l) => l.text === 'Kaffeebohnen')).toMatchObject({ kind: 'drink_out', readKind: 'coffee_tea', answered: true });

    await replaceReceiptLines(db, ctx, rowId, { lines: [line('kaffeebohnen', 899, 'coffee_tea'), line('Brot', 249)], source: 'reading' });
    const again = await linesOf(rowId);
    expect(again.map((l) => [l.text, l.kind])).toEqual([
      ['kaffeebohnen', 'drink_out'],
      ['Brot', 'groceries'],
    ]);
    expect(await db.receiptItem.count({ where: { rowId } })).toBe(2);
    expect((await db.receiptItemReading.findUnique({ where: { rowId } }))!.linesSumCents).toBe(1148);

    // Choosing the read kind again takes the answer back.
    await answerLineKind(db, ctx, again[0].id, 'coffee_tea', 'REWE Markt');
    expect((await linesOf(rowId))[0]).toMatchObject({ kind: 'coffee_tea', answered: false });
  });

  it('an empty list from a new reading of the page never replaces stored lines', async () => {
    const rowId = await receipt();
    await replaceReceiptLines(db, ctx, rowId, { lines: supermarket, source: 'reading' });
    expect(await replaceReceiptLines(db, ctx, rowId, { lines: [], source: 'reading' }, { keepOverEmpty: true })).toBe(false);
    expect(await db.receiptItem.count({ where: { rowId } })).toBe(4);
    const fresh = await receipt();
    expect(await replaceReceiptLines(db, ctx, fresh, { lines: [], source: 'reading' }, { keepOverEmpty: true })).toBe(true);
    expect((await db.receiptItemReading.findUnique({ where: { rowId: fresh } }))!.outcome).toBe('no_lines');
  });

  it('a reload shows the same lines, in the same order (resume)', async () => {
    const rowId = await receipt();
    await replaceReceiptLines(db, ctx, rowId, { lines: supermarket, source: 'reading' });
    const first = await linesOf(rowId);
    expect(await linesOf(rowId)).toEqual(first);
  });

  it('a kind answer is the company\'s, for that shop only, and refuses a kind outside the list', async () => {
    const rowId = await receipt();
    await replaceReceiptLines(db, ctx, rowId, { lines: [line('Spezi', 199, 'soft_drinks')], source: 'reading' });
    const [spezi] = await linesOf(rowId);
    await expect(answerLineKind(db, ctx, spezi.id, 'beer', 'REWE Markt')).rejects.toMatchObject({ code: 'invalid_kind' });
    // A receipt without a vendor names no shop to remember the answer for.
    await expect(answerLineKind(db, ctx, spezi.id, 'alcohol', '  ')).rejects.toMatchObject({ code: 'no_vendor' });
    await expect(answerLineKind(db, { workspaceId: other.workspaceId, tenantId: other.tenantId }, spezi.id, 'alcohol', 'REWE Markt')).rejects.toMatchObject({ code: 'line_not_found' });
    await answerLineKind(db, ctx, spezi.id, 'alcohol', 'REWE Markt');
    const answers = await loadKindAnswers(db, ws.workspaceId);
    expect(withAnswers({ ...spezi, kind: 'soft_drinks' }, 'Edeka', answers).kind).toBe('soft_drinks');
    expect(withAnswers({ ...spezi, kind: 'soft_drinks' }, 'rewe markt', answers).kind).toBe('alcohol');
    expect((await loadKindAnswers(db, other.workspaceId)).size).toBe(0);
  });

  it('a deleted receipt takes its lines and its reading with it', async () => {
    const rowId = await receipt();
    await replaceReceiptLines(db, ctx, rowId, { lines: supermarket, source: 'reading' });
    const result = await deleteReceiptRows(db, ctx, [rowId], { deleteStoredFile: async () => {} });
    expect(result.done).toEqual([rowId]);
    expect(await db.receiptItem.count({ where: { rowId } })).toBe(0);
    expect(await db.receiptItemReading.count({ where: { rowId } })).toBe(0);
  });
});

describe('the backfill of stored receipts', () => {
  const answer = (lines: ReceiptLine[] | null): LinesAnswer => ({ lines, pricesNet: null, textCut: false, model: 'test-small', usage: { inputTokens: 100, outputTokens: 50, cost: null } });

  it('reads every receipt once, lists the ones without text, and reads nothing a second time (re-entry)', async () => {
    const w = await createWorkspace();
    const c = { workspaceId: w.workspaceId, tenantId: w.tenantId };
    const base = { Vendor: 'Bäckerei', Date: '2026-09-01', Currency: 'EUR', 'FX Rate': 1 };
    const adds = await w.addReceipt({ ...base, Name: 'Brot', Gross: 4.98, 'OCR Text': 'Brot 2,49\nBrot 2,49\nSumme 4,98' });
    const differs = await w.addReceipt({ ...base, Name: 'Kuchen', Gross: 10, 'OCR Text': 'Kuchen 8,00\nSumme 10,00' });
    const empty = await w.addReceipt({ ...base, Name: 'Ohne Text', Gross: 3, 'OCR Text': '' });
    const none = await w.addReceipt({ ...base, Name: 'Keine Positionen', Gross: 3, 'OCR Text': 'Danke' });
    const reader = vi.fn(async (input: LinesInput) => {
      if (input.fullText.includes('Brot')) return answer([line('Brot', 249), line('Brot', 249)]);
      if (input.fullText.includes('Kuchen')) return answer([line('Kuchen', 800, 'sweets_snacks')]);
      return answer([]);
    });

    const first = await backfillReceiptLines(db, c, reader);
    expect(first).toMatchObject({ read: 2, addUp: 1, differ: 1, noLines: 1, failed: 0, remaining: 0, inputTokens: 300, outputTokens: 150 });
    expect(first.noText).toEqual([{ rowId: empty, name: 'Ohne Text' }]);
    expect(reader).toHaveBeenCalledTimes(3);
    // The model is told the stored totals, never more of the row than vendor, text, totals and currency.
    expect(reader.mock.calls.find(([i]) => i.fullText.includes('Kuchen'))![0]).toEqual({ vendor: 'Bäckerei', fullText: 'Kuchen 8,00\nSumme 10,00', gross: 10, net: null, currency: 'EUR' });
    expect(await db.receiptItem.count({ where: { rowId: adds } })).toBe(2);
    expect(await db.receiptItemReading.findUnique({ where: { rowId: differs } })).toMatchObject({ outcome: 'lines', source: 'backfill', linesSumCents: 800, model: 'test-small' });
    expect(await db.receiptItemReading.findUnique({ where: { rowId: none } })).toMatchObject({ outcome: 'no_lines', lineCount: 0 });

    reader.mockClear();
    const second = await backfillReceiptLines(db, c, reader);
    expect(reader).not.toHaveBeenCalled();
    expect(second).toMatchObject({ read: 0, failed: 0, remaining: 0 });
    expect(second.noText).toEqual([{ rowId: empty, name: 'Ohne Text' }]);
  });

  it('a failed read leaves no line and is tried on the next run; an unusable answer stops after the limit', async () => {
    const w = await createWorkspace();
    const c = { workspaceId: w.workspaceId, tenantId: w.tenantId };
    const rowId = await w.addReceipt({ Name: 'Kiosk', Vendor: 'Kiosk', Gross: 2, 'OCR Text': 'Cola 2,00', Currency: 'EUR' });

    // A call that did not get through counts nothing against the receipt.
    const down = vi.fn(async () => {
      throw Object.assign(new Error('overloaded'), { status: 529 });
    });
    expect(await backfillReceiptLines(db, c, down)).toMatchObject({ failed: 1, remaining: 1 });
    expect(await db.receiptItemReading.findUnique({ where: { rowId } })).toMatchObject({ outcome: 'failed', attempts: 0, transientFailures: 1 });
    expect(await db.receiptItem.count({ where: { rowId } })).toBe(0);

    // A malformed answer is counted, up to the limit; never a part of the list.
    const broken = vi.fn(async () => answer(null));
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const run = await backfillReceiptLines(db, c, broken);
      expect(run.failed).toBe(1);
      expect(await db.receiptItemReading.findUnique({ where: { rowId } })).toMatchObject({ outcome: 'failed', attempts: attempt });
      expect(await db.receiptItem.count({ where: { rowId } })).toBe(0);
    }
    const cut = vi.fn(async () => {
      throw new UnusableAnswerError('The answer was cut off.');
    });
    expect(await backfillReceiptLines(db, c, cut)).toMatchObject({ failed: 0, remaining: 0 });
    expect(cut).not.toHaveBeenCalled();
  });

  it('a failed read is retried and then stores all its lines at once', async () => {
    const w = await createWorkspace();
    const c = { workspaceId: w.workspaceId, tenantId: w.tenantId };
    const rowId = await w.addReceipt({ Name: 'Markt', Vendor: 'Markt', Gross: 5, 'OCR Text': 'Äpfel 3,00\nBirnen 2,00', Currency: 'EUR' });
    await backfillReceiptLines(db, c, async () => answer(null));
    expect((await db.receiptItemReading.findUnique({ where: { rowId } }))!.outcome).toBe('failed');
    const run = await backfillReceiptLines(db, c, async () => answer([line('Äpfel', 300), line('Birnen', 200)]));
    expect(run).toMatchObject({ read: 1, addUp: 1, remaining: 0 });
    expect(await db.receiptItemReading.findUnique({ where: { rowId } })).toMatchObject({ outcome: 'lines', lineCount: 2, attempts: 1 });
  });

  it('stops without counting anything when no model is configured', async () => {
    const w = await createWorkspace();
    const c = { workspaceId: w.workspaceId, tenantId: w.tenantId };
    const rowId = await w.addReceipt({ Name: 'Markt', Vendor: 'Markt', Gross: 5, 'OCR Text': 'Äpfel 5,00', Currency: 'EUR' });
    const run = await backfillReceiptLines(db, c, async () => {
      throw new ClassifierUnavailableError();
    });
    expect(run).toMatchObject({ unavailable: true, failed: 0, remaining: 1 });
    expect(await db.receiptItemReading.findUnique({ where: { rowId } })).toBeNull();
  });

  it('never overwrites lines a new reading stored while the model was answering', async () => {
    const w = await createWorkspace();
    const c = { workspaceId: w.workspaceId, tenantId: w.tenantId };
    const rowId = await w.addReceipt({ Name: 'Markt', Vendor: 'Markt', Gross: 5, 'OCR Text': 'Äpfel 5,00', Currency: 'EUR' });
    const run = await backfillReceiptLines(db, c, async () => {
      await replaceReceiptLines(db, c, rowId, { lines: [line('Äpfel (Seite)', 500)], source: 'reading' });
      return answer([line('Äpfel (Text)', 500)]);
    });
    expect(run.read).toBe(0);
    expect((await db.receiptItem.findMany({ where: { rowId } })).map((i) => i.text)).toEqual(['Äpfel (Seite)']);
  });

  it('reads at most the batch, newest first, and says how many are left', async () => {
    const w = await createWorkspace();
    const c = { workspaceId: w.workspaceId, tenantId: w.tenantId };
    for (let i = 0; i < 4; i++) {
      await w.addReceipt({ Name: `Beleg ${i}`, Vendor: 'Markt', Gross: 1, 'OCR Text': `Ware ${i} 1,00`, Currency: 'EUR' });
      await new Promise((resolve) => setTimeout(resolve, 15));
    }
    const reader = vi.fn<LinesReader>(async () => answer([line('Ware', 100)]));
    expect(await backfillReceiptLines(db, c, reader, { limit: 1 })).toMatchObject({ read: 1, remaining: 3 });
    expect(reader.mock.calls[0][0].fullText).toBe('Ware 3 1,00');
    expect(await backfillReceiptLines(db, c, reader, { limit: 3 })).toMatchObject({ read: 3, remaining: 0 });
    expect(reader).toHaveBeenCalledTimes(4);
  });

  it('counts a request the provider refused for the receipt itself, but not a rate limit', async () => {
    const w = await createWorkspace();
    const c = { workspaceId: w.workspaceId, tenantId: w.tenantId };
    const rowId = await w.addReceipt({ Name: 'Riesig', Vendor: 'Markt', Gross: 1, 'OCR Text': 'Ware 1,00', Currency: 'EUR' });
    await backfillReceiptLines(db, c, async () => {
      throw Object.assign(new Error('rate limited'), { status: 429 });
    });
    expect(await db.receiptItemReading.findUnique({ where: { rowId } })).toMatchObject({ attempts: 0, transientFailures: 1 });
    await backfillReceiptLines(db, c, async () => {
      throw Object.assign(new Error('request too large'), { status: 400 });
    });
    expect(await db.receiptItemReading.findUnique({ where: { rowId } })).toMatchObject({ outcome: 'failed', attempts: 1, transientFailures: 0 });
  });

  it('a receipt that times out on every run stops being asked after the limit, and never blocks fresh receipts', async () => {
    const w = await createWorkspace();
    const c = { workspaceId: w.workspaceId, tenantId: w.tenantId };
    const slow = await w.addReceipt({ Name: 'Langsam', Vendor: 'Markt', Gross: 1, 'OCR Text': 'LANGSAM 1,00', Currency: 'EUR' });
    const timeout = vi.fn<LinesReader>(async () => {
      throw new Error('Request timed out.');
    });
    for (let run = 1; run <= MAX_TRANSIENT_FAILURES; run++) await backfillReceiptLines(db, c, timeout);
    expect(await db.receiptItemReading.findUnique({ where: { rowId: slow } })).toMatchObject({ outcome: 'failed', transientFailures: MAX_TRANSIENT_FAILURES });
    timeout.mockClear();
    expect(await backfillReceiptLines(db, c, timeout)).toMatchObject({ remaining: 0 });
    expect(timeout).not.toHaveBeenCalled();

    // A fresh receipt goes before one that failed, even when it is older.
    const w2 = await createWorkspace();
    const c2 = { workspaceId: w2.workspaceId, tenantId: w2.tenantId };
    const older = await w2.addReceipt({ Name: 'Alt', Vendor: 'Markt', Gross: 1, 'OCR Text': 'ALT 1,00', Currency: 'EUR' });
    await new Promise((resolve) => setTimeout(resolve, 15));
    await w2.addReceipt({ Name: 'Neu', Vendor: 'Markt', Gross: 1, 'OCR Text': 'NEU 1,00', Currency: 'EUR' });
    const flaky = vi.fn<LinesReader>(async (input) => {
      if (input.fullText.startsWith('NEU')) throw new Error('Request timed out.');
      return answer([line('Alt', 100)]);
    });
    await backfillReceiptLines(db, c2, flaky, { limit: 1 });
    expect(flaky.mock.calls[0][0].fullText).toBe('NEU 1,00');
    await backfillReceiptLines(db, c2, flaky, { limit: 1 });
    expect(flaky.mock.calls[1][0].fullText).toBe('ALT 1,00');
    expect((await db.receiptItemReading.findUnique({ where: { rowId: older } }))!.outcome).toBe('lines');
  });

  it('an electronic invoice whose model call did not get through, or whose file could not be fetched, is tried again, never stored half-read', async () => {
    const w = await createWorkspace();
    const c = { workspaceId: w.workspaceId, tenantId: w.tenantId };
    const fields = structuredReceiptFields(readInvoiceXml(UBL_INVOICE_WITH_LINES)!);
    const rowId = await w.addReceipt({ Name: 'Rechnung', Vendor: 'Muster Software', Gross: 166.55, 'OCR Text': 'Rechnung (elektronisch)', Currency: 'EUR' });
    const imageColumn = (await w.adapter.getColumns(w.tableId)).find((col) => col.name === 'Receipt Image')!;
    await w.adapter.addFileReference({ rowId, columnId: imageColumn.id, fileId: `file-${rowId}`, fileUrl: '/api/files/x', originalName: 'r.pdf', mimeType: 'application/pdf', metadata: { source: 'ocr-upload' } });
    const reader = vi.fn<LinesReader>(async () => answer([]));

    expect(await backfillReceiptLines(db, c, reader, { structuredOf: async () => { throw new Error('storage down'); } })).toMatchObject({ failed: 1, noLines: 0, remaining: 1 });
    expect(reader).not.toHaveBeenCalled();
    expect(await backfillReceiptLines(db, c, async () => { throw new Error('Request timed out.'); }, { structuredOf: async () => fields })).toMatchObject({ failed: 1, read: 0, remaining: 1 });
    expect(await db.receiptItem.count({ where: { rowId } })).toBe(0);

    // An unusable answer stores the XML's lines as "Sonstiges".
    const run = await backfillReceiptLines(db, c, async () => { throw new UnusableAnswerError('The answer was cut off.'); }, { structuredOf: async () => fields });
    expect(run).toMatchObject({ read: 1, addUp: 1 });
    expect((await db.receiptItem.findMany({ where: { rowId }, orderBy: { position: 'asc' } })).map((i) => i.kind)).toEqual(['other', 'other', 'deposit_discount', 'shipping']);
  });

  it('a receipt deleted while its lines were being read gets none back', async () => {
    const w = await createWorkspace();
    const c = { workspaceId: w.workspaceId, tenantId: w.tenantId };
    const rowId = await w.addReceipt({ Name: 'Weg', Vendor: 'Markt', Gross: 1, 'OCR Text': 'Ware 1,00', Currency: 'EUR' });
    const run = await backfillReceiptLines(db, c, async () => {
      await deleteReceiptRows(db, c, [rowId], { deleteStoredFile: async () => {} });
      return answer([line('Ware', 100)]);
    });
    expect(run.read).toBe(0);
    expect(await db.receiptItem.count({ where: { rowId } })).toBe(0);
    expect(await db.receiptItemReading.count({ where: { rowId } })).toBe(0);
  });

  it('the daily run reads every company within its total budget, and goes on where it stopped the next day', async () => {
    const companies = await Promise.all([createWorkspace(), createWorkspace()]);
    for (const w of companies) for (let i = 0; i < 3; i++) await w.addReceipt({ Name: `Beleg ${i}`, Vendor: 'Markt', Gross: 1, 'OCR Text': `Ware ${i} 1,00`, Currency: 'EUR' });
    const reader = vi.fn<LinesReader>(async () => answer([line('Ware', 100)]));
    const ids = new Set(companies.map((w) => w.workspaceId));
    const only = async () => (await companiesWithReceipts(db)).filter((x) => ids.has(x.workspaceId));
    await dailyLinesBackfill(db, reader, { companies: await only(), totalLimit: 4 });
    expect(reader).toHaveBeenCalledTimes(4);
    await dailyLinesBackfill(db, reader, { companies: await only(), totalLimit: 4 });
    expect(reader).toHaveBeenCalledTimes(6);
    expect(await db.receiptItemReading.count({ where: { authWorkspaceId: { in: [...ids] }, outcome: 'lines' } })).toBe(6);
  });

  it('reads a receipt recorded without text again once it holds text', async () => {
    const w = await createWorkspace();
    const c = { workspaceId: w.workspaceId, tenantId: w.tenantId };
    const rowId = await w.addReceipt({ Name: 'Foto', Vendor: 'Markt', Gross: 2, 'OCR Text': '', Currency: 'EUR' });
    expect((await backfillReceiptLines(db, c, async () => answer([]))).noText).toHaveLength(1);
    const textColumn = (await w.adapter.getColumns(w.tableId)).find((col) => col.name === 'OCR Text')!;
    await w.adapter.updateRow(rowId, { [textColumn.id]: 'Brot 2,00' });
    const run = await backfillReceiptLines(db, c, async () => answer([line('Brot', 200)]));
    expect(run).toMatchObject({ read: 1, addUp: 1, noText: [] });
    expect(await db.receiptItemReading.findUnique({ where: { rowId } })).toMatchObject({ outcome: 'lines' });
  });

  it('an electronic invoice stored before lines were kept takes its lines from its XML, with the model\'s kinds', async () => {
    const w = await createWorkspace();
    const c = { workspaceId: w.workspaceId, tenantId: w.tenantId };
    const fields = structuredReceiptFields(readInvoiceXml(UBL_INVOICE_WITH_LINES)!);
    const rowId = await w.addReceipt({ Name: 'Rechnung', Vendor: 'Muster Software', Gross: 166.55, 'OCR Text': 'Rechnung (elektronisch)\nGesamt: 166.55 EUR', Currency: 'EUR' });
    const imageColumn = (await w.adapter.getColumns(w.tableId)).find((col) => col.name === 'Receipt Image')!;
    await w.adapter.addFileReference({ rowId, columnId: imageColumn.id, fileId: `file-${rowId}`, fileUrl: '/api/files/x', originalName: 'rechnung.xml', mimeType: 'application/xml', metadata: { source: 'ocr-upload' } });
    const reader = vi.fn<LinesReader>(async () => answer([line('Lizenz Pro', 11900, 'software_services'), line('Handbuch', 5350, 'other')]));
    const structuredOf = vi.fn(async () => fields);
    const run = await backfillReceiptLines(db, c, reader, { structuredOf });
    expect(structuredOf).toHaveBeenCalledWith(`file-${rowId}`);
    expect(reader.mock.calls[0][0].fullText).toContain('Lizenz Pro');
    expect(run).toMatchObject({ read: 1, addUp: 1 });
    expect((await db.receiptItem.findMany({ where: { rowId }, orderBy: { position: 'asc' } })).map((i) => [i.text, i.netCents, i.kind])).toEqual([
      ['Lizenz Pro', 10000, 'software_services'],
      ['Handbuch', 5000, 'other'],
      ['Treuerabatt', -1000, 'deposit_discount'],
      ['Versand', 500, 'shipping'],
    ]);
    expect(await db.receiptItemReading.findUnique({ where: { rowId } })).toMatchObject({ source: 'einvoice', linesNetCents: 14500, totalNetCents: 14500 });
  });

  it('stores an invoice printed before tax with its gross and its printed net, and a meal whose lines include the tip as adding up', async () => {
    const w = await createWorkspace();
    const c = { workspaceId: w.workspaceId, tenantId: w.tenantId };
    const base = { Date: '2026-09-01', Currency: 'EUR', 'FX Rate': 1 };
    const invoice = await w.addReceipt({ ...base, Name: 'Abo', Vendor: 'Beispiel Software', Gross: 26.18, Net: 22, 'Tax Rate': 19, 'OCR Text': 'Plus plan 22.00\nVAT 19 % 4.18\nTotal 26.18' });
    const meal = await w.addReceipt({ ...base, Name: 'Essen', Vendor: 'Trattoria Beispiel', Gross: 44, Net: 41.12, 'Tax Rate': 7, Tip: 4.4, 'OCR Text': 'Pasta 44,00\nTrinkgeld 4,40\nSumme 44,00' });
    const reader = vi.fn(async (input: LinesInput) =>
      input.fullText.includes('Plus plan')
        ? { ...answer(parseModelLines([{ text: 'Plus plan', gross: 22, kind: 'software_services' }])), pricesNet: true }
        : answer([line('Pasta', 4400, 'meal_out'), line('Trinkgeld', 440, 'meal_out')]),
    );
    expect(await backfillReceiptLines(db, c, reader)).toMatchObject({ read: 2, addUp: 2, differ: 0 });
    expect(reader.mock.calls.find(([i]) => i.fullText.includes('Plus plan'))![0]).toMatchObject({ gross: 26.18, net: 22 });
    expect(await db.receiptItem.findMany({ where: { rowId: invoice }, select: { grossCents: true, netCents: true } })).toEqual([{ grossCents: 2618, netCents: 2200 }]);
    expect(await db.receiptItemReading.findUnique({ where: { rowId: invoice } })).toMatchObject({ linesSumCents: 2618, linesNetCents: 2200, totalNetCents: null });
    // The tip line stays as printed: the lines add up to the gross plus the row's tip.
    expect(await db.receiptItemReading.findUnique({ where: { rowId: meal } })).toMatchObject({ linesSumCents: 4840, linesNetCents: null });
  });

  it('never reads a receipt of another company', async () => {
    const w = await createWorkspace();
    const rowId = await other.addReceipt({ Name: `Fremd ${randomUUID()}`, Vendor: 'Markt', Gross: 1, 'OCR Text': 'Ware 1,00', Currency: 'EUR' });
    const reader = vi.fn(async () => answer([line('Ware', 100)]));
    await backfillReceiptLines(db, { workspaceId: w.workspaceId, tenantId: w.tenantId }, reader);
    expect(reader).not.toHaveBeenCalled();
    expect(await db.receiptItemReading.findUnique({ where: { rowId } })).toBeNull();
  });
});
