import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CellValue } from '@marlinjai/data-table-core';
import type { NumberAnswer, NumberInput, PairAnswer, PairSide } from '@/lib/receipt-classifier';
import { ClassifierUnavailableError } from '@/lib/receipt-classifier';
import type { PreparedPage } from '@/lib/receipt-page';
import { createWorkspace, db, plainMealReceipt, type TestWorkspace } from '../../../../test/db-helpers';
import { MAX_JUDGE_ATTEMPTS, settleLookAlikes, type LookAlikeDeps } from '../look-alikes';
import { mergeAfterChange, mergedInto, restoreMergedReceipt, type MergeContext } from '../merge';
import { loadReviewQueue } from '../service';

/**
 * Look-alike receipts settled without asking, against a real database (plan
 * docs/plans/2026-11-05-duplicates-without-asking.md), through the four paths
 * of the flow. Forward: a missing number is read again (text, file name,
 * model) and the rule merges or separates the pair; where no number decides,
 * the model's "same" merges, "different" keeps both, "unsure" or a failure
 * leaves the pair asked with its reason. Backtrack: a pair the model kept
 * apart is merged when a person types the same number on both; a decision on
 * facts that changed counts for nothing. Resume: a bounded run leaves the rest
 * for the next one, and a finished pass asks nothing again. Re-entry: a
 * restored model merge is never merged again; a pair the model kept failing on
 * stops being asked. Every model call is faked. Run with `pnpm test:db`.
 */

let ws: TestWorkspace;
let ctx: MergeContext;
let col: (name: string) => string;

const PHOTO: PreparedPage = { page: { mediaType: 'image/jpeg', base64: 'SlBFRw==' } };

const readNumber = vi.fn<(input: NumberInput) => Promise<NumberAnswer>>();
const judgePair = vi.fn<(a: PairSide, b: PairSide) => Promise<PairAnswer>>();
const loadPage = vi.fn<(fileId: string) => Promise<PreparedPage>>();
const deps: LookAlikeDeps = { readNumber, judgePair, loadPage };

const numberAnswer = (invoiceNumber: string | null): NumberAnswer => ({ invoiceNumber, sawPage: true, model: 'test/small-model', usage: { inputTokens: 1, outputTokens: 1, cost: null } });
const verdict = (v: PairAnswer['verdict'], confidence: number, reason: string): PairAnswer => ({ verdict: v, confidence, reason, model: 'test/strong-model', usage: { inputTokens: 1, outputTokens: 1, cost: null } });

const receipt = (overrides: Record<string, CellValue> = {}) =>
  plainMealReceipt({ Vendor: 'Kiosk Beispiel', Category: 'Software & Lizenzen', 'OCR Text': 'Kiosk Beispiel\nSumme 119,00', Date: '2026-01-20', Gross: 119, 'Tax Rate': 19, ...overrides });

async function attach(rowId: string, originalName = 'beleg.jpg'): Promise<string> {
  const fileId = randomUUID();
  await ws.adapter.addFileReference({
    rowId,
    columnId: col('Receipt Image'),
    fileId,
    fileUrl: `/api/files/${fileId}`,
    originalName,
    mimeType: 'image/jpeg',
    metadata: { source: 'ocr-upload', sha256: randomUUID().replace(/-/g, '') },
  });
  return fileId;
}

/** A receipt with a file, as an upload stores it. */
async function stored(cells: Record<string, CellValue> = {}, fileName?: string): Promise<string> {
  const rowId = await ws.addReceipt(receipt(cells));
  await attach(rowId, fileName);
  return rowId;
}

const archived = async (rowId: string) => (await ws.adapter.getRow(rowId))!.archived;
const cell = async (rowId: string, name: string) => (await ws.adapter.getRow(rowId))!.cells[col(name)] ?? null;
const entryFor = async (rowId: string) => (await loadReviewQueue(db, ws.workspaceId)).find((e) => e.rowId === rowId);
const asked = async (rowId: string) => ((await entryFor(rowId))?.reasons ?? []).includes('possible_duplicate');
const decisionOf = (a: string, b: string) => db.receiptPairDecision.findFirst({ where: { OR: [{ rowIdA: a, rowIdB: b }, { rowIdA: b, rowIdB: a }] } });
const run = (options: Parameters<typeof settleLookAlikes>[3] = {}) => settleLookAlikes(db, ctx, deps, { numberLimit: 10, pairLimit: 10, ...options });

beforeEach(async () => {
  // A company of its own per test: a run without `only` looks at every pair of the company.
  ws = await createWorkspace();
  ctx = { workspaceId: ws.workspaceId, tenantId: ws.tenantId };
  const columns = await ws.adapter.getColumns(ws.tableId);
  col = (name) => columns.find((c) => c.name === name)!.id;
  readNumber.mockReset();
  judgePair.mockReset();
  loadPage.mockReset();
  loadPage.mockResolvedValue(PHOTO);
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterAll(async () => {
  vi.restoreAllMocks();
  await db.$disconnect();
});

describe('forward: a missing number is read again, then the rule decides', () => {
  it('the Adobe receipt: the number its file name labels and its text carries makes the pair one invoice, merged without a model', async () => {
    const numbered = await stored({ Vendor: 'Adobe', Rechnungsnummer: 'IEN2026004022987', 'OCR Text': 'Adobe\nInvoice Number IEN2026004022987' });
    // Its text names two identifiers below the labels, so the text alone settles nothing; the file name does.
    const bare = await stored({ Vendor: 'Adobe', 'OCR Text': 'Adobe\nInvoice Number\nCustomer ID\nIEN2026004022987\nCUST4711X' }, 'Adobe-Invoice-2026-01-20-IEN2026004022987.pdf');
    expect(await asked(bare)).toBe(true);

    const result = await run();
    expect(result).toMatchObject({ pairs: 1, numbersFound: 1, mergedByNumber: 1, judged: 0, remaining: 0 });
    expect(readNumber).not.toHaveBeenCalled();
    expect(judgePair).not.toHaveBeenCalled();
    expect(await cell(bare, 'Rechnungsnummer')).toBe('IEN2026004022987');
    expect(await db.receiptReview.findUnique({ where: { rowId: bare } })).toMatchObject({ invoiceNumberSource: 'file_name' });
    const gone = (await archived(bare)) ? bare : numbered;
    const kept = gone === bare ? numbered : bare;
    expect(await archived(kept)).toBe(false);
    expect(await mergedInto(db, ws.workspaceId, kept)).toEqual([expect.objectContaining({ rowId: gone, reason: 'same_invoice', decidedBy: 'number_reread' })]);
    expect(await decisionOf(bare, numbered)).toMatchObject({ outcome: 'same_number', decidedBy: 'number_reread' });
    expect(await asked(kept)).toBe(false);
  });

  it('the small model reads a number the text carries: two different numbers are two invoices, and the question is gone', async () => {
    const a = await stored({ Rechnungsnummer: 'R-7788992', 'OCR Text': 'Kiosk Beispiel R-7788992' });
    const b = await stored({ 'OCR Text': 'Kiosk Beispiel\nBeleg R-7788991\nSumme 119,00' });
    readNumber.mockResolvedValue(numberAnswer('R-7788991'));

    const result = await run();
    expect(readNumber).toHaveBeenCalledTimes(1);
    expect(readNumber.mock.calls[0][0]).toMatchObject({ vendor: 'Kiosk Beispiel', page: PHOTO.page });
    expect(result).toMatchObject({ numbersFound: 1, mergedByNumber: 0, keptApartByNumber: 1, judged: 0 });
    expect(await cell(b, 'Rechnungsnummer')).toBe('R-7788991');
    expect(await db.receiptReview.findUnique({ where: { rowId: b } })).toMatchObject({ invoiceNumberSource: 'model' });
    expect(await decisionOf(a, b)).toMatchObject({ outcome: 'different_numbers' });
    expect(await asked(a)).toBe(false);
    expect(await asked(b)).toBe(false);
    expect(judgePair).not.toHaveBeenCalled();
  });

  it("a number the model reads that the text does not carry is never stored: the pair goes on to the comparison", async () => {
    const a = await stored();
    const b = await stored();
    readNumber.mockResolvedValue(numberAnswer('R-0000001'));
    judgePair.mockResolvedValue(verdict('unsure', 0.4, 'Beide Bons zeigen nur den Betrag.'));
    await run();
    expect(await cell(a, 'Rechnungsnummer')).toBeNull();
    expect(await cell(b, 'Rechnungsnummer')).toBeNull();
    expect(await db.receiptReview.findUnique({ where: { rowId: a } })).toMatchObject({ invoiceNumberSource: null });
    expect(judgePair).toHaveBeenCalledTimes(1);
  });

  it('a number a person typed is never overwritten, a weak one included', async () => {
    const a = await stored({ Rechnungsnummer: '17', 'OCR Text': 'Rechnungsnummer: R-9988776' });
    const b = await stored();
    readNumber.mockResolvedValue(numberAnswer(null));
    judgePair.mockResolvedValue(verdict('unsure', 0.5, 'Unklar.'));
    await run();
    expect(await cell(a, 'Rechnungsnummer')).toBe('17');
    // Only the receipt without any number was read again.
    expect(readNumber).toHaveBeenCalledTimes(1);
    expect(await db.receiptReview.findUnique({ where: { rowId: a } })).toBeNull();
    expect(await db.receiptReview.findUnique({ where: { rowId: b } })).toMatchObject({ invoiceNumberRereadAt: expect.any(Date) });
  });
});

describe('forward: where no number decides, the model compares both pages', () => {
  beforeEach(() => readNumber.mockResolvedValue(numberAnswer(null)));

  it('"same" with high confidence merges reversibly, with the model and its sentence on the record', async () => {
    const a = await stored();
    const b = await stored({ Zuordnung: null });
    judgePair.mockResolvedValue(verdict('same', 0.96, 'Beide zeigen denselben Bon um 12:04.'));

    const result = await run();
    expect(result).toMatchObject({ judged: 1, mergedByModel: 1 });
    const [sideA, sideB] = judgePair.mock.calls[0];
    expect(sideA.page).toEqual(PHOTO.page);
    expect(sideB).toMatchObject({ vendor: 'Kiosk Beispiel', gross: 119, date: '2026-01-20', currency: 'EUR' });
    // The one with the assignment stays.
    expect(await archived(b)).toBe(true);
    expect(await archived(a)).toBe(false);
    expect(await db.receiptMerge.findUnique({ where: { rowId: b } })).toMatchObject({ keptRowId: a, reason: 'same_purchase', decidedBy: 'model', decisionNote: 'Beide zeigen denselben Bon um 12:04.', decisionModel: 'test/strong-model' });
    expect(await mergedInto(db, ws.workspaceId, a)).toEqual([expect.objectContaining({ rowId: b, reason: 'same_purchase', decidedBy: 'model' })]);
    expect(await decisionOf(a, b)).toMatchObject({ outcome: 'same', confidence: 0.96 });
    expect(await asked(a)).toBe(false);
  });

  it('"different" keeps both and the pair is not asked again', async () => {
    const a = await stored();
    const b = await stored();
    judgePair.mockResolvedValue(verdict('different', 0.9, 'A ist um 12:04, B um 18:30.'));
    expect(await run()).toMatchObject({ judged: 1, keptApartByModel: 1, mergedByModel: 0 });
    expect(await archived(a)).toBe(false);
    expect(await archived(b)).toBe(false);
    expect(await asked(a)).toBe(false);
    expect(await asked(b)).toBe(false);
    // Not a person's word: nothing is stored as "Beide behalten".
    expect((await db.receiptReview.findUnique({ where: { rowId: a } }))?.distinctFrom ?? []).toEqual([]);
  });

  it('"unsure", and a "same" without enough confidence, leave the pair asked with the reason next to it', async () => {
    const a = await stored();
    const b = await stored();
    judgePair.mockResolvedValue(verdict('same', 0.6, 'Vermutlich derselbe Bon, aber B ist unscharf.'));
    expect(await run()).toMatchObject({ judged: 1, unsure: 1, mergedByModel: 0 });
    expect(await archived(a)).toBe(false);
    expect(await archived(b)).toBe(false);
    const entry = await entryFor(a);
    expect(entry?.reasons).toContain('possible_duplicate');
    expect(entry?.duplicates).toEqual([expect.objectContaining({ rowId: b, note: { outcome: 'unsure', reason: 'Vermutlich derselbe Bon, aber B ist unscharf.' } })]);
  });

  it('a failed call never merges: the pair stays asked, the failure is counted', async () => {
    const a = await stored();
    const b = await stored();
    judgePair.mockRejectedValue(Object.assign(new Error('upstream'), { status: 503 }));
    expect(await run()).toMatchObject({ failed: 1, mergedByModel: 0 });
    expect(await archived(a)).toBe(false);
    expect(await archived(b)).toBe(false);
    expect(await decisionOf(a, b)).toMatchObject({ outcome: 'failed', attempts: 1 });
    expect((await entryFor(a))?.duplicates[0].note).toEqual({ outcome: 'failed', reason: expect.stringContaining('versucht es erneut') });
  });

  it('a receipt without a file, or a page the model cannot be shown, is unsure without a call', async () => {
    const a = await ws.addReceipt(receipt());
    const b = await stored();
    expect(await run()).toMatchObject({ unsure: 1, judged: 0 });
    expect(judgePair).not.toHaveBeenCalled();
    expect((await decisionOf(a, b))?.reason).toContain('keine Datei');

    const c = await stored({ Vendor: 'Anderer Laden', Date: '2026-02-02' });
    const d = await stored({ Vendor: 'Anderer Laden', Date: '2026-02-02' });
    loadPage.mockResolvedValue({ skipped: 'too_large' });
    await run();
    expect(judgePair).not.toHaveBeenCalled();
    expect(await decisionOf(c, d)).toMatchObject({ outcome: 'unsure', reason: expect.stringContaining('nicht zeigen') });
  });

  it('without any model configured nothing is counted against a receipt or a pair', async () => {
    const a = await stored();
    await stored();
    let calls = 0;
    const unavailable = async (): Promise<never> => {
      calls++;
      throw new ClassifierUnavailableError();
    };
    const result = await settleLookAlikes(db, ctx, { readNumber: unavailable, judgePair: unavailable, loadPage }, { numberLimit: 10, pairLimit: 10 });
    expect(result).toMatchObject({ unavailable: true, failed: 0, judged: 0 });
    // The first call says there is no model: nothing more is asked in this run.
    expect(calls).toBe(1);
    expect(await db.receiptReview.findUnique({ where: { rowId: a } })).toBeNull();
    expect(await db.receiptPairDecision.count({ where: { authWorkspaceId: ws.workspaceId } })).toBe(0);
    expect(await asked(a)).toBe(true);
  });
});

describe('backtrack: what the person changes decides again', () => {
  beforeEach(() => readNumber.mockResolvedValue(numberAnswer(null)));

  it('a pair the model kept apart is merged when a person types the same number on both', async () => {
    const a = await stored();
    const b = await stored({ Zuordnung: null });
    judgePair.mockResolvedValue(verdict('different', 0.8, 'Zwei Besuche.'));
    await run();
    expect(await asked(a)).toBe(false);

    await ws.adapter.updateRow(a, { [col('Rechnungsnummer')]: 'BON-2026-4711' });
    await ws.adapter.updateRow(b, { [col('Rechnungsnummer')]: 'BON-2026-4711' });
    const merges = await mergeAfterChange(db, ctx, [b]);
    expect([...merges.values()].map((m) => [m.rowId, m.keptRowId, m.reason])).toEqual([[b, a, 'same_invoice']]);
  });

  it('a corrected vendor makes the earlier decision count for nothing: the pair is compared again', async () => {
    const a = await stored({ Vendor: 'Kiosk' });
    const b = await stored({ Vendor: 'Kiosk' });
    judgePair.mockResolvedValueOnce(verdict('different', 0.9, 'Zwei Besuche.'));
    await run();
    expect(await asked(a)).toBe(false);

    await ws.adapter.updateRow(b, { [col('Vendor')]: 'Kiosk Beispiel' });
    expect(await asked(a)).toBe(true);
    judgePair.mockResolvedValueOnce(verdict('unsure', 0.5, 'Jetzt unklar.'));
    await run();
    expect(judgePair).toHaveBeenCalledTimes(2);
    expect(await decisionOf(a, b)).toMatchObject({ outcome: 'unsure' });
  });
});

describe('resume: bounded runs go on where they stopped, a finished pass asks nothing', () => {
  beforeEach(() => readNumber.mockResolvedValue(numberAnswer(null)));

  it('three pairs, one comparison per run: each run takes the next, the fourth calls nothing', async () => {
    for (const day of ['2026-01-05', '2026-01-06', '2026-01-07']) {
      await stored({ Date: day });
      await stored({ Date: day });
    }
    judgePair.mockResolvedValue(verdict('unsure', 0.3, 'Unklar.'));
    expect(await run({ pairLimit: 1 })).toMatchObject({ pairs: 3, judged: 1, remaining: 2 });
    expect(await run({ pairLimit: 1 })).toMatchObject({ judged: 1, remaining: 1 });
    expect(await run({ pairLimit: 1 })).toMatchObject({ judged: 1, remaining: 0 });
    judgePair.mockClear();
    readNumber.mockClear();
    expect(await run({ pairLimit: 1 })).toMatchObject({ judged: 0, remaining: 0 });
    expect(judgePair).not.toHaveBeenCalled();
    expect(readNumber).not.toHaveBeenCalled();
  });

  it('a number reading that did not get through is tried again on the next run; one that answered is not', async () => {
    const a = await stored();
    const b = await stored();
    const marked = async () => db.receiptReview.count({ where: { rowId: { in: [a, b] }, invoiceNumberRereadAt: { not: null } } });
    readNumber.mockRejectedValueOnce(Object.assign(new Error('timeout'), { status: 408 }));
    judgePair.mockResolvedValue(verdict('unsure', 0.3, 'Unklar.'));
    // One model call allowed: it does not get through, and the other receipt waits for the limit. Both remain.
    expect(await run({ numberLimit: 1 })).toMatchObject({ failed: 1, remaining: 2 });
    expect(readNumber).toHaveBeenCalledTimes(1);
    expect(await marked()).toBe(0);
    readNumber.mockClear();
    await run();
    expect(readNumber).toHaveBeenCalledTimes(2);
    expect(await marked()).toBe(2);
    readNumber.mockClear();
    await run();
    expect(readNumber).not.toHaveBeenCalled();
  });

  it('with `only`, a run settles the pairs of those receipts and leaves the others', async () => {
    const a = await stored();
    await stored();
    const c = await stored({ Date: '2026-03-03' });
    const d = await stored({ Date: '2026-03-03' });
    judgePair.mockResolvedValue(verdict('different', 0.9, 'Zwei Käufe.'));
    expect(await run({ only: [a] })).toMatchObject({ pairs: 1, keptApartByModel: 1 });
    expect(await asked(c)).toBe(true);
    expect(await decisionOf(c, d)).toBeNull();
  });
});

describe('re-entry: after a restore or repeated failures', () => {
  beforeEach(() => readNumber.mockResolvedValue(numberAnswer(null)));

  it("a restored model merge is the person's word: never merged or asked about again", async () => {
    const a = await stored();
    const b = await stored({ Zuordnung: null });
    judgePair.mockResolvedValue(verdict('same', 0.95, 'Derselbe Bon.'));
    await run();
    expect(await archived(b)).toBe(true);

    expect(await restoreMergedReceipt(db, ctx, b)).toBe(a);
    expect(await archived(b)).toBe(false);
    expect(await decisionOf(a, b)).toBeNull();
    judgePair.mockClear();
    expect(await run()).toMatchObject({ pairs: 0 });
    expect(judgePair).not.toHaveBeenCalled();
    expect(await archived(b)).toBe(false);
    expect(await asked(a)).toBe(false);
  });

  it(`a pair the model failed on ${MAX_JUDGE_ATTEMPTS} times is asked about no more, and stays for a person with that reason`, async () => {
    const a = await stored();
    const b = await stored();
    judgePair.mockRejectedValue(new Error('upstream'));
    for (let i = 0; i < MAX_JUDGE_ATTEMPTS; i++) await run();
    expect(judgePair).toHaveBeenCalledTimes(MAX_JUDGE_ATTEMPTS);
    expect(await decisionOf(a, b)).toMatchObject({ outcome: 'failed', attempts: MAX_JUDGE_ATTEMPTS, reason: expect.stringContaining('selbst entscheiden') });
    await run();
    expect(judgePair).toHaveBeenCalledTimes(MAX_JUDGE_ATTEMPTS);
    expect(await asked(a)).toBe(true);
  });

  it('a pass run twice changes nothing the second time', async () => {
    const a = await stored();
    const b = await stored();
    judgePair.mockResolvedValue(verdict('different', 0.9, 'Zwei Käufe.'));
    await run();
    const before = await decisionOf(a, b);
    judgePair.mockClear();
    expect(await run()).toMatchObject({ pairs: 0, judged: 0 });
    expect(judgePair).not.toHaveBeenCalled();
    expect((await decisionOf(a, b))?.decidedAt).toEqual(before?.decidedAt);
  });
});
