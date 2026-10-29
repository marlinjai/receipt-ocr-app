import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CellValue } from '@marlinjai/data-table-core';
import { deleteReceiptRows } from '@/lib/meals/service';
import { createAccount, importPayments, loadPayments } from '@/lib/tax/payments/service';
import { createWorkspace, db, plainMealReceipt, type TestWorkspace } from '../../../../test/db-helpers';
import { backfillInvoiceNumbers } from '../invoice-number-backfill';
import { mergeAfterChange, mergeDuplicates, mergedInto, restoreMergedReceipt, type MergeContext } from '../merge';
import { keepBothReceipts, loadReviewQueue } from '../service';

/**
 * The invoice number deciding duplicates, against a real database (plan
 * docs/plans/2026-10-29-invoice-number-duplicates.md): the automatic pass,
 * the backfill of stored receipts and the restore, through the four paths of
 * the flow. Forward: copies of one invoice or one file are archived into the
 * more complete receipt, with a record. Backtrack: a person correcting a number
 * changes what is a duplicate at once. Resume: a backfill cut off goes on where
 * it stopped and a finished one finds nothing left. Re-entry: a restored
 * receipt is not archived again, a pass run twice changes nothing.
 * Run with `pnpm test:db`.
 */

let ws: TestWorkspace;
let ctx: MergeContext;
let col: (name: string) => string;

const vendor = () => `Hosting ${randomUUID().slice(0, 8)}`;
const receipt = (overrides: Record<string, CellValue> = {}) =>
  plainMealReceipt({ Category: 'Software & Lizenzen', 'OCR Text': 'Beispieltext', 'Tax Rate': 19, ...overrides });

async function attach(rowId: string, sha256 = randomUUID().replace(/-/g, '')): Promise<string> {
  const fileId = randomUUID();
  const ref = await ws.adapter.addFileReference({
    rowId,
    columnId: col('Receipt Image'),
    fileId,
    fileUrl: `/api/files/${fileId}`,
    originalName: 'rechnung.pdf',
    mimeType: 'application/pdf',
    metadata: { source: 'ocr-upload', sha256 },
  });
  return ref.fileId;
}

const HEADER = '"Booking Date","Value Date","Partner Name","Partner Iban",Type,"Payment Reference","Account Name","Amount (EUR)","Original Amount","Original Currency","Exchange Rate"';
async function linkPayment(rowId: string): Promise<string> {
  const accountId = await createAccount(db, ctx, { label: `Konto ${randomUUID().slice(0, 6)}`, kind: 'bank' });
  await importPayments(db, ctx, accountId, `${HEADER}\n2026-03-02,2026-03-02,"Hosting",,Presentment,"Kauf",Hauptkonto,-119.00,,,\n`);
  const payment = (await loadPayments(db, ws.workspaceId)).payments.find((p) => p.accountId === accountId)!;
  const link = await db.taxPaymentLink.create({ data: { authWorkspaceId: ws.workspaceId, authTenantId: ws.tenantId, paymentId: payment.id, rowId, cents: 11900, method: 'manual' } });
  return link.id;
}

const archived = async (rowId: string) => (await ws.adapter.getRow(rowId))!.archived;
const cell = async (rowId: string, name: string) => (await ws.adapter.getRow(rowId))!.cells[col(name)] ?? null;
const entryFor = async (rowId: string) => (await loadReviewQueue(db, ws.workspaceId)).find((e) => e.rowId === rowId);
const filesOf = (rowId: string) => ws.adapter.getFileReferences(rowId, col('Receipt Image'));

beforeAll(async () => {
  ws = await createWorkspace();
  ctx = { workspaceId: ws.workspaceId, tenantId: ws.tenantId };
  const columns = await ws.adapter.getColumns(ws.tableId);
  col = (name) => columns.find((c) => c.name === name)!.id;
});
afterAll(async () => {
  await db.$disconnect();
});

describe('forward: the same invoice or the same file is one receipt', () => {
  it('two copies of one invoice: the one with the payment and the assignment stays, the other is archived with a record', async () => {
    const v = vendor();
    const photo = await ws.addReceipt(receipt({ Vendor: v, Rechnungsnummer: 'RE-2026-0042', Zuordnung: null, Date: '2026-03-01' }));
    const pdf = await ws.addReceipt(receipt({ Vendor: `${v} GmbH`, Rechnungsnummer: 're 2026 0042', Date: '2026-03-02' }));
    const linkId = await linkPayment(photo);
    await attach(photo);
    const pdfFile = await attach(pdf);

    const { merged } = await mergeDuplicates(db, ctx);
    // The photo has the payment: it stays, whatever the PDF has more of.
    expect(merged.filter((m) => [photo, pdf].includes(m.rowId))).toEqual([{ rowId: pdf, keptRowId: photo, reason: 'same_invoice', fileAdded: true }]);
    expect(await archived(pdf)).toBe(true);
    expect(await archived(photo)).toBe(false);
    // Its file is on the kept receipt too, not "ocr-upload" so a retake never swaps it; the archived one keeps its own.
    const keptFiles = await filesOf(photo);
    expect(keptFiles.map((f) => f.fileId)).toContain(pdfFile);
    expect(keptFiles.find((f) => f.fileId === pdfFile)!.metadata).toMatchObject({ source: 'merged-duplicate', mergedFromRowId: pdf });
    expect((await filesOf(pdf)).map((f) => f.fileId)).toEqual([pdfFile]);
    expect(await db.receiptMerge.findUnique({ where: { rowId: pdf } })).toMatchObject({ keptRowId: photo, reason: 'same_invoice', invoiceNumber: 're 2026 0042' });
    expect((await db.taxPaymentLink.findUnique({ where: { id: linkId } }))!.rowId).toBe(photo);
    expect(await mergedInto(db, ws.workspaceId, photo)).toEqual([expect.objectContaining({ rowId: pdf, reason: 'same_invoice', invoiceNumber: 're 2026 0042' })]);
    // Nobody is asked about it: the archived copy is no receipt of the list.
    expect((await entryFor(photo))?.reasons ?? []).not.toContain('possible_duplicate');
  });

  it("the archived copy's payment link moves to the kept one, and a payment linked to both stays as it is", async () => {
    const v = vendor();
    const kept = await ws.addReceipt(receipt({ Vendor: v, Rechnungsnummer: 'INV-55667788' }));
    const copy = await ws.addReceipt(receipt({ Vendor: v, Rechnungsnummer: 'INV-55667788', Zuordnung: null }));
    await linkPayment(kept);
    await linkPayment(kept);
    const moved = await linkPayment(copy);
    const { merged } = await mergeDuplicates(db, ctx, { only: [copy] });
    expect(merged).toEqual([{ rowId: copy, keptRowId: kept, reason: 'same_invoice', fileAdded: false }]);
    expect((await db.taxPaymentLink.findUnique({ where: { id: moved } }))!.rowId).toBe(kept);
    expect((await db.receiptMerge.findUnique({ where: { rowId: copy } }))!.movedPaymentLinkIds).toEqual([moved]);
  });

  it('the same file is one receipt whatever its fields and numbers say', async () => {
    const hash = randomUUID().replace(/-/g, '');
    const first = await ws.addReceipt(receipt({ Vendor: vendor(), Rechnungsnummer: 'R-111111' }));
    const second = await ws.addReceipt(receipt({ Vendor: vendor(), Rechnungsnummer: 'R-222222', Gross: 5, Zuordnung: null }));
    await attach(first, hash);
    await attach(second, hash);
    const { merged } = await mergeDuplicates(db, ctx, { only: [first, second] });
    expect(merged).toEqual([{ rowId: second, keptRowId: first, reason: 'same_file', fileAdded: false }]);
    // The kept receipt holds that very file already: nothing is added to it.
    expect(await filesOf(first)).toHaveLength(1);
  });

  it('two different numbers are never a question, nor a credit note and its invoice, nor another vendor', async () => {
    const v = vendor();
    const a = await ws.addReceipt(receipt({ Vendor: v, Rechnungsnummer: 'R-300001' }));
    const b = await ws.addReceipt(receipt({ Vendor: v, Rechnungsnummer: 'R-300002' }));
    const invoice = await ws.addReceipt(receipt({ Vendor: v, Rechnungsnummer: 'R-300003', Gross: 119 }));
    const credit = await ws.addReceipt(receipt({ Vendor: v, Rechnungsnummer: 'R-300003', Gross: -119 }));
    const elsewhere = await ws.addReceipt(receipt({ Vendor: vendor(), Rechnungsnummer: 'R-300001' }));
    expect((await mergeDuplicates(db, ctx, { only: [a, b, invoice, credit, elsewhere] })).merged).toEqual([]);
    for (const rowId of [a, b, invoice, credit, elsewhere]) expect((await entryFor(rowId))?.reasons ?? []).not.toContain('possible_duplicate');
  });

  it('a look-alike where one number is missing stays a question in the review list', async () => {
    const v = vendor();
    const numbered = await ws.addReceipt(receipt({ Vendor: v, Rechnungsnummer: 'R-400001', Date: '2026-04-01' }));
    const bare = await ws.addReceipt(receipt({ Vendor: v, Date: '2026-04-01' }));
    expect((await mergeDuplicates(db, ctx, { only: [numbered, bare] })).merged).toEqual([]);
    expect((await entryFor(bare))!.duplicates.map((d) => d.rowId)).toEqual([numbered]);
  });

  it('a weak number ("Nr. 4711") never merges: it falls to the look-alike question', async () => {
    const v = vendor();
    const a = await ws.addReceipt(receipt({ Vendor: v, Rechnungsnummer: '4711', Date: '2026-04-02' }));
    const b = await ws.addReceipt(receipt({ Vendor: v, Rechnungsnummer: '4711', Date: '2026-04-02' }));
    expect((await mergeDuplicates(db, ctx, { only: [a, b] })).merged).toEqual([]);
    expect((await entryFor(a))!.reasons).toContain('possible_duplicate');
  });
});

describe('backtrack: a person correcting a number changes what is a duplicate', () => {
  it('corrected to another number the question ends; corrected to the other receipt’s number they are merged; the same number kept changes nothing', async () => {
    const v = vendor();
    const a = await ws.addReceipt(receipt({ Vendor: v, Rechnungsnummer: 'R-500001', Date: '2026-05-01' }));
    const b = await ws.addReceipt(receipt({ Vendor: v, Date: '2026-05-01', Zuordnung: null }));
    expect((await entryFor(b))!.reasons).toContain('possible_duplicate');

    // The number B prints is another one: two invoices, nobody is asked.
    await ws.adapter.updateRow(b, { [col('Rechnungsnummer')]: 'R-500002' });
    expect((await mergeAfterChange(db, ctx, [b])).size).toBe(0);
    expect((await entryFor(b))?.reasons ?? []).not.toContain('possible_duplicate');

    // Corrected again, to A's number: the same invoice, merged at once into the more complete one.
    await ws.adapter.updateRow(b, { [col('Rechnungsnummer')]: 'r-500001' });
    expect([...(await mergeAfterChange(db, ctx, [b])).values()].map((m) => [m.rowId, m.keptRowId, m.reason])).toEqual([[b, a, 'same_invoice']]);
    expect(await archived(b)).toBe(true);

    // Run again with nothing changed: nothing moves.
    expect((await mergeAfterChange(db, ctx, [a])).size).toBe(0);
    expect(await archived(a)).toBe(false);
  });
});

describe('re-entry: what a person entered on the archived receipt, and a merge planned twice', () => {
  it('a meal guest and a tax decision move to the kept receipt, a restore moves them back, and a second run keeps the record whole', async () => {
    const v = vendor();
    const kept = await ws.addReceipt(receipt({ Vendor: v, Rechnungsnummer: 'RE-2026-0077', Date: '2026-04-01' }));
    const copy = await ws.addReceipt(receipt({ Vendor: v, Rechnungsnummer: 'RE-2026-0077', Date: '2026-04-01' }));
    await linkPayment(kept);
    const base = { authWorkspaceId: ws.workspaceId, authTenantId: ws.tenantId };
    const guest = await db.mealGuest.create({ data: { ...base, rowId: copy, contactId: randomUUID(), displayName: 'Gast' } });
    const decision = await db.taxItemDecision.create({ data: { ...base, rowId: copy, allocations: [] } });

    expect([...(await mergeAfterChange(db, ctx, [copy])).keys()]).toEqual([copy]);
    expect((await db.mealGuest.findUnique({ where: { id: guest.id } }))!.rowId).toBe(kept);
    expect((await db.taxItemDecision.findUnique({ where: { id: decision.id } }))!.rowId).toBe(kept);
    const record = (await db.receiptMerge.findUnique({ where: { rowId: copy } }))!;
    expect(record.movedMealGuestIds).toEqual([guest.id]);
    expect(record.movedTaxDecisionId).toBe(decision.id);

    // A pass planning the merge again (the first stopped before the archive) must not empty the record.
    await ws.adapter.unarchiveRow(copy);
    await mergeAfterChange(db, ctx, [copy]);
    const again = (await db.receiptMerge.findUnique({ where: { rowId: copy } }))!;
    expect(again.movedMealGuestIds).toEqual([guest.id]);
    expect(again.movedTaxDecisionId).toBe(decision.id);

    expect(await restoreMergedReceipt(db, ctx, copy)).toBe(kept);
    expect((await db.mealGuest.findUnique({ where: { id: guest.id } }))!.rowId).toBe(copy);
    expect((await db.taxItemDecision.findUnique({ where: { id: decision.id } }))!.rowId).toBe(copy);
  });
});

describe('resume: the backfill goes on where it stopped and ends with nothing left', () => {
  it('reads labelled numbers from the stored text, never guesses one, keeps a typed one, and a second run reads nothing', async () => {
    const own = await createWorkspace();
    const ownCtx = { workspaceId: own.workspaceId, tenantId: own.tenantId };
    const v = vendor();
    const first = await own.addReceipt(receipt({ Vendor: v, 'OCR Text': 'Rechnung\nRechnungsnummer: RE-2026-0777\nSumme 119,00', Date: '2026-06-01' }));
    const second = await own.addReceipt(receipt({ Vendor: v, 'OCR Text': 'Invoice number RE-2026-0777\nTotal 119.00', Date: '2026-06-03', Zuordnung: null }));
    const none = await own.addReceipt(receipt({ Vendor: vendor(), 'OCR Text': 'Bäckerei\nBrötchen 0,50\nBon-Nr. 4711' }));
    const typed = await own.addReceipt(receipt({ Vendor: vendor(), 'OCR Text': 'Rechnungsnummer: AB-999999', Rechnungsnummer: 'AB-999998' }));
    const numberId = (await own.adapter.getColumns(own.tableId)).find((c) => c.name === 'Rechnungsnummer')!.id;
    const ownCell = async (rowId: string) => (await own.adapter.getRow(rowId))!.cells[numberId] ?? null;

    // Cut off after two receipts (the newest first): the rest waits.
    const run1 = await backfillInvoiceNumbers(db, ownCtx, { limit: 2 });
    expect(run1).toMatchObject({ looked: 2, remaining: 2 });
    const run2 = await backfillInvoiceNumbers(db, ownCtx, { limit: 10 });
    expect(run2).toMatchObject({ looked: 2, remaining: 0 });
    expect(run1.found + run2.found).toBe(2);

    expect(await ownCell(none)).toBeNull();
    expect(await ownCell(typed)).toBe('AB-999998');
    // The two copies share a number now: the run merged them.
    expect(run1.merged + run2.merged).toBe(1);
    const merge = await db.receiptMerge.findFirst({ where: { authWorkspaceId: own.workspaceId } });
    expect(merge).toMatchObject({ rowId: second, keptRowId: first, reason: 'same_invoice' });

    // A third run finds nothing left and writes nothing; a number a person removed is not filled back.
    await own.adapter.updateRow(first, { [numberId]: null });
    expect(await backfillInvoiceNumbers(db, ownCtx)).toEqual({ looked: 0, found: 0, merged: 0, remaining: 0 });
    expect(await ownCell(first)).toBeNull();
  });
});

describe('re-entry: a restore is a person’s word, and a pass run again changes nothing', () => {
  it('a restored receipt is live again with its links and files back, is never archived again with that receipt, but merges with a third copy', async () => {
    const v = vendor();
    const kept = await ws.addReceipt(receipt({ Vendor: v, Rechnungsnummer: 'R-600001' }));
    const copy = await ws.addReceipt(receipt({ Vendor: v, Rechnungsnummer: 'R-600001', Zuordnung: null }));
    // Both paid: the one with assignment and category filled stays.
    await linkPayment(kept);
    const link = await linkPayment(copy);
    const copyFile = await attach(copy);
    expect((await mergeDuplicates(db, ctx, { only: [copy] })).merged).toHaveLength(1);
    expect((await db.taxPaymentLink.findUnique({ where: { id: link } }))!.rowId).toBe(kept);

    // Run twice: the second pass has nothing to do.
    expect((await mergeDuplicates(db, ctx, { only: [kept, copy] })).merged).toEqual([]);

    expect(await restoreMergedReceipt(db, ctx, copy)).toBe(kept);
    expect(await archived(copy)).toBe(false);
    expect((await db.taxPaymentLink.findUnique({ where: { id: link } }))!.rowId).toBe(copy);
    expect((await filesOf(kept)).map((f) => f.fileId)).not.toContain(copyFile);
    expect(await db.receiptMerge.findUnique({ where: { rowId: copy } })).toBeNull();
    expect((await db.receiptReview.findUnique({ where: { rowId: copy } }))!.distinctFrom).toContain(kept);
    expect(await mergedInto(db, ws.workspaceId, kept)).toEqual([]);

    // The next pass leaves the pair alone, and the review list does not ask about it either.
    expect((await mergeDuplicates(db, ctx, { only: [kept, copy] })).merged).toEqual([]);
    expect(await archived(copy)).toBe(false);
    expect((await entryFor(copy))?.reasons ?? []).not.toContain('possible_duplicate');

    // A third copy of the same invoice still goes into the more complete of the two.
    const third = await ws.addReceipt(receipt({ Vendor: v, Rechnungsnummer: 'R-600001', Zuordnung: null, Category: null }));
    const { merged } = await mergeDuplicates(db, ctx, { only: [third] });
    expect(merged).toEqual([{ rowId: third, keptRowId: kept, reason: 'same_invoice', fileAdded: false }]);
    expect(await archived(copy)).toBe(false);
  });

  it('"Beide behalten" said earlier holds: the pass never archives that pair', async () => {
    const v = vendor();
    const a = await ws.addReceipt(receipt({ Vendor: v, Rechnungsnummer: 'R-700001' }));
    const b = await ws.addReceipt(receipt({ Vendor: v, Rechnungsnummer: 'R-700001' }));
    await keepBothReceipts(db, ctx, a, b);
    expect((await mergeDuplicates(db, ctx, { only: [a, b] })).merged).toEqual([]);
  });

  it('a restore of a receipt that was never merged is refused, and deleting an archived copy takes its record along', async () => {
    const lone = await ws.addReceipt(receipt({ Vendor: vendor() }));
    await expect(restoreMergedReceipt(db, ctx, lone)).rejects.toMatchObject({ code: 'not_merged' });

    const v = vendor();
    const kept = await ws.addReceipt(receipt({ Vendor: v, Rechnungsnummer: 'R-800001' }));
    const copy = await ws.addReceipt(receipt({ Vendor: v, Rechnungsnummer: 'R-800001', Zuordnung: null }));
    await mergeDuplicates(db, ctx, { only: [copy] });
    await ws.adapter.unarchiveRow(copy);
    await deleteReceiptRows(db, ctx, [copy], { deleteStoredFile: async () => {} });
    expect(await db.receiptMerge.findUnique({ where: { rowId: copy } })).toBeNull();
    expect(await cell(kept, 'Rechnungsnummer')).toBe('R-800001');
  });
});
