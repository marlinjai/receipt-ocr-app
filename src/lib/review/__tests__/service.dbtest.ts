import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { deleteReceiptRows } from '@/lib/meals/service';
import { ReviewError, confirmReceipt, keepBothReceipts, loadReviewQueue, recordReadFlags, type ReviewContext } from '../service';
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
