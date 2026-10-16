import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createWorkspace, db, plainMealReceipt, type TestWorkspace } from '../../../test/db-helpers';

/**
 * processReceipt, retakeReceipt and rereadReceipt against a real database: the
 * real rows, file references and the real meal service. Auth, the classifier,
 * the file store and the exchange-rate lookup are replaced. Run with `pnpm test:db`.
 */

type Membership = { id: string; slug: string; role: string; tenantId: string };
const session = { current: null as null | { memberships: Membership[]; activeWorkspace: Membership } };
const classify = vi.fn();
const loadPage = vi.fn();
/** The structured invoice data the stored file holds: none for an ordinary receipt. */
const loadStructured = vi.fn();

vi.mock('@/lib/prisma', async () => ({ prisma: (await import('../../../test/db-helpers')).db }));
vi.mock('@/lib/auth', () => ({
  auth: {
    requireAction: vi.fn(async () => session.current),
    getSession: vi.fn(async () => session.current),
  },
}));
vi.mock('@/lib/receipt-classifier', async (original) => ({
  ...(await original<typeof import('@/lib/receipt-classifier')>()),
  classifyReceiptText: (...a: unknown[]) => classify(...a),
}));
vi.mock('@/lib/fx-rates', () => ({ getFxRate: vi.fn(async () => 0.9) }));
vi.mock('@/lib/receipt-page-source', () => ({
  loadReceiptPage: (...a: unknown[]) => loadPage(...a),
  loadReceiptSource: async (...a: unknown[]) => ({ page: () => loadPage(...a), structured: await loadStructured(...a) }),
}));

import { contactStore, loadMealRecord, saveMealDetails } from '@/lib/meals/service';
import { mealStatus } from '@/lib/meals/rules';
import { createGroup } from '@/lib/groups/service';
import { saveRule } from '@/lib/classification-rules-store';
import { processReceipt, recomputeFxRates, rereadReceipt, retakeReceipt } from './actions';

let ws: TestWorkspace;
let other: TestWorkspace;

const HASH = (c: string) => c.repeat(64);
// A file id of this run only: the store hands out a fresh id per upload, and a file another workspace holds is refused.
const RUN = randomUUID().slice(0, 24);
const file = (n: number) => ({ id: `${RUN}${String(n).padStart(12, '0')}`, originalName: `foto-${n}.jpg`, fileType: 'image/jpeg' });
const ocr = (fullText: string, confidence = 0.95) => ({ fullText, blocks: [], confidence });

const RESTAURANT = 'Ristorante Beispiel\nPizza Margherita 12,00\nSumme 48,50\n14.03.2025';
/** The page the loader prepares from a stored file. */
const PAGE = { mediaType: 'image/jpeg', base64: 'SlBFRw==' };
// The layout that produced a total of 916,752.88: receipt numbers with a decimal point, a tip on top.
const CAFE = [
  'Cafe Morgenrot', 'Laufkunde', '* RECHNUNG *', 'Duplikat C916752.448', 'A916752.8837', '19.02.25, 17:04:11',
  'Co Working, Tisch 30', 'Rechnung für Quittung R916752.8746', 'Kräutertee', '3.50 3.50', '€ 58.70', 'Summe',
  'Trinkgeld', '| Bezahlter Betrag', 'MwSt. 19% auf 49.33: € 9.37 (58.70)', '€ 61.40', '€ 2.70', '€ 58.70',
].join('\n');

/** The day the cafe receipt prints, as the model answers it. A model that names no date leaves an unlabelled one in doubt. */
const CAFE_DAY = '2025-02-19T00:00:00.000Z';

/** The value of a cell by column name; a select as the name of its option. */
async function cellOf(workspace: TestWorkspace, rowId: string, name: string) {
  const column = (await workspace.adapter.getColumns(workspace.tableId)).find((c) => c.name === name)!;
  const value = (await workspace.adapter.getRow(rowId))!.cells[column.id];
  if (column.type !== 'select' || typeof value !== 'string') return value ?? null;
  return (await workspace.adapter.getSelectOptions(column.id)).find((o) => o.id === value)?.name ?? value;
}
const MEAL_ANSWER = {
  name: 'Abendessen, Ristorante Beispiel', category: 'Bewirtung', konto: '4650', zuordnung: 'Geschäftlich',
  taxRate: 19, confidence: 0.9, reasoning: '', sawPage: true,
  meal: { mealType: 'business_meal_external', consumption: 'dine_in', tip: 5, taxLines: [{ rate: 19, net: 40.76, tax: 7.74 }], place: 'Ristorante Beispiel, Musterstraße 1, 12345 Musterstadt' },
};

const membership = (workspace: TestWorkspace): Membership => ({ id: workspace.workspaceId, slug: 'test', role: 'member', tenantId: workspace.tenantId });

/** A session that is a member of `workspace` only, with it active. */
async function use(workspace: TestWorkspace) {
  session.current = { memberships: [membership(workspace)], activeWorkspace: membership(workspace) };
}

/** An upload from a page that names the session's active workspace, as the upload page does by default. */
function upload(f: Parameters<typeof processReceipt>[0], o: Parameters<typeof processReceipt>[1], options: { sha256?: string } = {}) {
  return processReceipt(f, o, { ...options, workspaceId: session.current!.activeWorkspace.id });
}

async function rowCount(workspace: TestWorkspace) {
  return (await workspace.adapter.getRows(workspace.tableId, { limit: 500 })).items.length;
}

async function files(workspace: TestWorkspace, rowId: string) {
  const columns = await workspace.adapter.getColumns(workspace.tableId);
  const imageCol = columns.find((c) => c.name === 'Receipt Image')!;
  return workspace.adapter.getFileReferences(rowId, imageCol.id);
}

beforeAll(async () => {
  ws = await createWorkspace();
  other = await createWorkspace();
});
beforeEach(async () => {
  classify.mockReset();
  classify.mockResolvedValue(MEAL_ANSWER);
  loadPage.mockReset();
  loadPage.mockResolvedValue({ page: PAGE });
  loadStructured.mockReset();
  loadStructured.mockResolvedValue(null);
  await use(ws);
});
afterAll(async () => {
  await db.$disconnect();
});

describe('processReceipt', () => {
  it('a restaurant receipt is filed as a meal with what the classifier read, and waits for guests and occasion', async () => {
    const result = await upload(file(1), ocr(RESTAURANT), { sha256: HASH('1') });
    expect(result).toMatchObject({ category: 'Bewirtung', isMeal: true, attention: null, possibleDuplicateOf: null });
    const record = await loadMealRecord(db, ws.workspaceId, result.rowId);
    expect(record).toMatchObject({
      mealType: 'business_meal_external',
      consumption: 'dine_in',
      tip: 5,
      place: 'Ristorante Beispiel, Musterstraße 1, 12345 Musterstadt',
      taxLines: [{ rate: 19, net: 40.76, tax: 7.74 }],
      gross: 48.5,
      net: 40.76,
      taxRate: 19,
      // Never guessed:
      occasion: '',
      host: '',
      guests: [],
    });
    expect(mealStatus(record!)).toEqual({ kind: 'incomplete', missing: ['occasion', 'host', 'guests'] });
    expect((await files(ws, result.rowId))[0].metadata).toMatchObject({ source: 'ocr-upload', sha256: HASH('1') });
  });

  it('text recognition failed: there is still a row, Pending, with the file attached', async () => {
    const before = await rowCount(ws);
    const result = await upload(file(2), null, { sha256: HASH('2') });
    expect(result).toMatchObject({ category: null, isMeal: false, attention: 'ocr_failed' });
    expect(await rowCount(ws)).toBe(before + 1);
    expect(await files(ws, result.rowId)).toHaveLength(1);
    expect(classify).not.toHaveBeenCalled();
    const row = await ws.adapter.getRow(result.rowId);
    const columns = await ws.adapter.getColumns(ws.tableId);
    const statusCol = columns.find((c) => c.name === 'Status')!;
    const pending = (await ws.adapter.getSelectOptions(statusCol.id)).find((o) => o.name === 'Pending')!.id;
    expect(row!.cells[statusCol.id]).toBe(pending);
  });

  it('a blurry photo (low confidence) is saved and flagged for a retake', async () => {
    const result = await upload(file(3), ocr(RESTAURANT, 0.4), {});
    expect(result.attention).toBe('low_quality');
  });

  it('the classifier failing does not lose the receipt: fallback rules file it', async () => {
    classify.mockRejectedValue(new Error('model unavailable'));
    const result = await upload(file(4), ocr('Ristorante Beispiel\nPasta 14,00\nSumme 14,00\n02.02.2026'), {});
    expect(result).toMatchObject({ category: 'Bewirtung', isMeal: true });
    // 2026 restaurant food without printed tax lines: 7 percent by date.
    expect((await loadMealRecord(db, ws.workspaceId, result.rowId))!.taxRate).toBe(7);
  });

  it('a supermarket receipt is not a meal even without the classifier', async () => {
    classify.mockRejectedValue(new Error('model unavailable'));
    const result = await upload(file(5), ocr('REWE Markt GmbH\nBananen 1,99\nSumme 1,99\n02.03.2025'), {});
    expect(result.isMeal).toBe(false);
  });

  it('the same receipt photographed twice is saved and reported as a look-alike', async () => {
    const fresh = await createWorkspace();
    await use(fresh);
    const first = await upload(file(6), ocr(RESTAURANT), { sha256: HASH('6') });
    const second = await upload(file(7), ocr(RESTAURANT), { sha256: HASH('7') });
    expect(first.possibleDuplicateOf).toBeNull();
    expect(second.possibleDuplicateOf).toMatchObject({ rowId: first.rowId });
  });

  it('a malformed hash from the browser is not stored', async () => {
    const result = await upload(file(8), ocr(RESTAURANT), { sha256: 'not-a-hash' });
    expect((await files(ws, result.rowId))[0].metadata).toEqual({ source: 'ocr-upload' });
  });
});

describe('processReceipt: what the reader cannot settle is recorded, never silent', () => {
  const cell = async (rowId: string, name: string) => {
    const columns = await ws.adapter.getColumns(ws.tableId);
    return (await ws.adapter.getRow(rowId))!.cells[columns.find((c) => c.name === name)!.id];
  };
  const stored = async (rowId: string) => (await db.receiptReview.findUnique({ where: { rowId } }))?.flags ?? [];

  it('a failed classification is on the receipt and in the review list, and the receipt is still filed from its text', async () => {
    classify.mockRejectedValue(new Error('model unavailable'));
    const result = await upload(file(20), ocr(CAFE), {});

    expect(result.reviewFlags).toEqual(['not_classified']);
    expect(await stored(result.rowId)).toEqual(['not_classified']);
    // The text alone: the right total (not the receipt number), the tip apart, a restaurant.
    expect(result).toMatchObject({ category: 'Bewirtung', isMeal: true });
    const record = await loadMealRecord(db, ws.workspaceId, result.rowId);
    expect(record).toMatchObject({ gross: 58.7, net: 49.33, taxRate: 19, tip: 2.7, vendor: 'Cafe Morgenrot' });
    expect(record!.taxLines).toEqual([{ rate: 19, net: 49.33, tax: 9.37 }]);
  });

  it('a clean reading records nothing', async () => {
    classify.mockResolvedValue({ ...MEAL_ANSWER, date: CAFE_DAY });
    const result = await upload(file(21), ocr(CAFE), {});
    expect(result.reviewFlags).toEqual([]);
    expect(await db.receiptReview.count({ where: { rowId: result.rowId } })).toBe(0);
  });

  it("the model's total never overrules the receipt's own arithmetic, and the disagreement is recorded", async () => {
    classify.mockResolvedValue({ ...MEAL_ANSWER, date: CAFE_DAY, gross: 916752.88, meal: { ...MEAL_ANSWER.meal, taxLines: null, tip: null } });
    const result = await upload(file(22), ocr(CAFE), {});
    expect(await cell(result.rowId, 'Gross')).toBe(58.7);
    expect(result.reviewFlags).toEqual(['total_conflict']);
    expect(await stored(result.rowId)).toEqual(['total_conflict']);
  });

  it("the model's vendor is taken when the receipt shows it, and refused when it does not", async () => {
    const text = ['Since 2016', 'Fantastic Foodbar Inh.', 'Beispielallee 126, 10437 Musterstadt', 'Rechnung Nr.2-42883', 'Summe 11,90', 'Netto 10,00', 'MwSt 19% 1,90', '21.03.2025'].join('\n');
    classify.mockResolvedValue({ ...MEAL_ANSWER, vendor: 'Fantastic Foodbar', gross: 11.9, meal: { ...MEAL_ANSWER.meal, taxLines: null, tip: null } });
    const taken = await upload(file(23), ocr(text), {});
    expect(await cell(taken.rowId, 'Vendor')).toBe('Fantastic Foodbar');

    classify.mockResolvedValue({ ...MEAL_ANSWER, vendor: 'Some Other Chain', gross: 11.9, meal: { ...MEAL_ANSWER.meal, taxLines: null, tip: null } });
    const refused = await upload(file(24), ocr(text), {});
    expect(await cell(refused.rowId, 'Vendor')).toBe('Fantastic Foodbar');
  });

  it('a restaurant receipt the model filed elsewhere keeps the model\'s category and is put up for a look', async () => {
    classify.mockResolvedValue({ ...MEAL_ANSWER, category: 'Software & Lizenzen', konto: '4806', meal: { mealType: null, consumption: null, tip: null, taxLines: null, place: null } });
    const result = await upload(file(25), ocr(CAFE), {});
    expect(result.category).toBe('Software & Lizenzen');
    expect(result.reviewFlags).toContain('category_doubt');
  });

  it('a page nothing could be read from says so in its name and is not named "Receipt"', async () => {
    const empty = await upload(file(26), ocr(''), {});
    const failed = await upload(file(27), null, {});
    expect(await cell(empty.rowId, 'Name')).toBe('Nicht lesbar: foto-26.jpg');
    expect(await cell(failed.rowId, 'Name')).toBe('Nicht lesbar: foto-27.jpg');
    expect(empty.attention).toBe('ocr_failed');
    expect(classify).not.toHaveBeenCalled();
  });

  it('a retake replaces the recorded doubts with those of the new reading', async () => {
    classify.mockRejectedValue(new Error('model unavailable'));
    const first = await upload(file(28), ocr(CAFE), {});
    expect(await stored(first.rowId)).toEqual(['not_classified']);

    classify.mockResolvedValue({ ...MEAL_ANSWER, date: CAFE_DAY, gross: 58.7, meal: { ...MEAL_ANSWER.meal, taxLines: null, tip: null } });
    const again = await retakeReceipt(first.rowId, file(29), ocr(CAFE), {});
    expect(again.rowId).toBe(first.rowId);
    expect(again.reviewFlags).toEqual([]);
    expect(await stored(first.rowId)).toEqual([]);
  });
});

describe('retakeReceipt: never a second row', () => {
  it('replaces the photo and re-reads the receipt on the same row', async () => {
    const first = await upload(file(10), ocr('unscharf', 0.2), { sha256: HASH('a') });
    expect(first.attention).toBe('low_quality');
    const before = await rowCount(ws);

    const retaken = await retakeReceipt(first.rowId, file(11), ocr(RESTAURANT), { sha256: HASH('b') });
    expect(retaken).toMatchObject({ rowId: first.rowId, category: 'Bewirtung', isMeal: true, attention: null });
    expect(await rowCount(ws)).toBe(before);

    const refs = await files(ws, first.rowId);
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({ fileId: file(11).id });
    expect(refs[0].metadata).toMatchObject({ sha256: HASH('b') });
    expect((await loadMealRecord(db, ws.workspaceId, first.rowId))!.gross).toBe(48.5);
  });

  it('keeps meal details the user already entered, and files attached by hand', async () => {
    const first = await upload(file(12), ocr(RESTAURANT, 0.4), {});
    const ctx = { workspaceId: ws.workspaceId, tenantId: ws.tenantId };
    const guest = await contactStore(db, ctx).create({ name: 'Rita Retake', companyOrRole: 'Probe GmbH' });
    await saveMealDetails(db, ctx, first.rowId, {
      mealType: 'business_meal_external', occasion: 'Abnahme Fotoproduktion', place: 'Eigener Ort', host: 'Inhaber Beispiel',
      tip: 7, consumption: 'takeaway', taxLines: null, guestContactIds: [guest.id], date: null, gross: null,
    });
    const columns = await ws.adapter.getColumns(ws.tableId);
    const imageCol = columns.find((c) => c.name === 'Receipt Image')!;
    await ws.adapter.addFileReference({
      rowId: first.rowId, columnId: imageCol.id, fileId: file(13).id, fileUrl: `/api/files/${file(13).id}`,
      originalName: 'von-hand.pdf', mimeType: 'application/pdf', metadata: { source: 'row-attach' },
    });

    await retakeReceipt(first.rowId, file(14), ocr(RESTAURANT), {});
    const record = await loadMealRecord(db, ws.workspaceId, first.rowId);
    // What the user typed stays, even though the classifier read other values
    // (tip 5, eaten in, the restaurant's address) on the retake.
    expect(record).toMatchObject({
      occasion: 'Abnahme Fotoproduktion',
      host: 'Inhaber Beispiel',
      place: 'Eigener Ort',
      tip: 7,
      consumption: 'takeaway',
      mealType: 'business_meal_external',
    });
    // What was blank is filled from the new reading.
    expect(record!.taxLines).toEqual([{ rate: 19, net: 40.76, tax: 7.74 }]);
    expect(record!.gross).toBe(48.5);
    expect(record!.guests).toEqual([{ contactId: guest.id, name: 'Rita Retake', company: 'Probe GmbH' }]);
    const names = (await files(ws, first.rowId)).map((f) => f.originalName).sort();
    expect(names).toEqual(['foto-14.jpg', 'von-hand.pdf']);
  });

  it('a receipt of another workspace cannot be retaken', async () => {
    await use(other);
    const foreign = await upload(file(15), ocr(RESTAURANT), {});
    await use(ws);
    // The session is not a member of the workspace that owns the row: refused before anything is read.
    await expect(retakeReceipt(foreign.rowId, file(16), ocr(RESTAURANT), {})).rejects.toMatchObject({ status: 403 });
    expect((await files(other, foreign.rowId)).map((f) => f.fileId)).toEqual([file(15).id]);
  });

  it('a retake whose recognition fails again keeps the row and says so', async () => {
    const first = await upload(file(17), ocr('unscharf', 0.2), {});
    const again = await retakeReceipt(first.rowId, file(18), null, {});
    expect(again).toMatchObject({ rowId: first.rowId, attention: 'ocr_failed' });
  });
});

describe('processReceipt: the model is shown the page, and the upload never depends on it', () => {
  const stored = async (rowId: string) => (await db.receiptReview.findUnique({ where: { rowId } }))?.flags ?? [];

  it('hands the model the page of the uploaded file', async () => {
    await upload(file(40), ocr(CAFE), {});
    expect(loadPage).toHaveBeenCalledWith(file(40).id);
    expect(classify.mock.calls[0][0]).toMatchObject({ page: PAGE });
  });

  it('a file that cannot be fetched: the receipt is stored from its text and says the page was not read', async () => {
    loadPage.mockResolvedValue({ skipped: 'missing' });
    classify.mockResolvedValue({ ...MEAL_ANSWER, sawPage: false });
    const result = await upload(file(41), ocr(CAFE), {});
    expect(classify.mock.calls[0][0]).toMatchObject({ page: null });
    expect(result.reviewFlags).toEqual(['page_not_read']);
    expect(await stored(result.rowId)).toEqual(['page_not_read']);
    expect(await cellOf(ws, result.rowId, 'Gross')).toBe(58.7);
    expect(await files(ws, result.rowId)).toHaveLength(1);
  });

  it('the provider is down: the upload completes with the text reading and a visible note', async () => {
    classify.mockRejectedValue(Object.assign(new Error('Request timed out.'), { name: 'APIConnectionTimeoutError' }));
    const result = await upload(file(42), ocr(CAFE), {});
    expect(result.reviewFlags).toEqual(['not_classified']);
    expect(await cellOf(ws, result.rowId, 'Gross')).toBe(58.7);
    expect(await cellOf(ws, result.rowId, 'Status')).toBe('Pending');
  });

  it('no recognized text and no structured data: the model is not asked', async () => {
    // The file is fetched: an XRechnung has no text to recognize, and only its bytes say it is one.
    await upload(file(43), null, {});
    expect(loadStructured).toHaveBeenCalledWith(file(43).id);
    expect(classify).not.toHaveBeenCalled();
  });

  it('an electronic invoice: its structured figures stand over the page reading, and its text is stored where nothing was recognized', async () => {
    const { readStructuredInvoice } = await import('@/lib/einvoice');
    const { UBL_INVOICE } = await import('@/lib/einvoice/__tests__/samples');
    loadStructured.mockResolvedValue(await readStructuredInvoice(new TextEncoder().encode(UBL_INVOICE)));
    classify.mockResolvedValue({ ...MEAL_ANSWER, category: 'Software & Lizenzen', konto: '4806', vendor: 'Muster Software', gross: 150, date: '2026-09-15T00:00:00.000Z', meal: { ...MEAL_ANSWER.meal, taxLines: null, tip: null, place: null } });
    // A ZUGFeRD PDF: the page was recognized, and read wrong.
    const pdf = await upload(file(90), ocr('Muster Software\nRechnung\nDatum 15.09.2026\nGesamt 150,00 €'), {});
    expect(await cellOf(ws, pdf.rowId, 'Gross')).toBe(172.5);
    expect(await cellOf(ws, pdf.rowId, 'Net')).toBe(150);
    expect(await cellOf(ws, pdf.rowId, 'Tax Rate')).toBe(19);
    expect(new Date((await cellOf(ws, pdf.rowId, 'Date')) as string).toISOString().slice(0, 10)).toBe('2026-09-14');
    expect(await cellOf(ws, pdf.rowId, 'Vendor')).toBe('Muster Software');
    expect(pdf.reviewFlags).not.toContain('total_conflict');
    // An XRechnung: no text was recognized, its figures as text are stored and read.
    const xml = await upload(file(91), null, {});
    expect(await cellOf(ws, xml.rowId, 'Gross')).toBe(172.5);
    expect(String(await cellOf(ws, xml.rowId, 'OCR Text'))).toContain('Rechnung (elektronisch)');
    expect(await cellOf(ws, xml.rowId, 'Status')).toBe('Processed');
    // Without a model answer, the vendor is the seller the XML names, never the heading of its text.
    classify.mockRejectedValue(new Error('provider down'));
    const unclassified = await upload(file(92), null, {});
    expect(await cellOf(ws, unclassified.rowId, 'Vendor')).toBe('Muster Software GmbH');
  });

  it('an electronic credit note keeps no amount until a person books it', async () => {
    const { readStructuredInvoice } = await import('@/lib/einvoice');
    const { UBL_CREDIT_NOTE } = await import('@/lib/einvoice/__tests__/samples');
    loadStructured.mockResolvedValue(await readStructuredInvoice(new TextEncoder().encode(UBL_CREDIT_NOTE)));
    const credit = await upload(file(93), null, {});
    expect(await cellOf(ws, credit.rowId, 'Gross')).toBeNull();
    expect(credit.reviewFlags).toContain('credit_note');
    // A person books it; "Seite neu lesen" leaves what they entered.
    const columns = await ws.adapter.getColumns(ws.tableId);
    const id = (name: string) => columns.find((c) => c.name === name)!.id;
    await ws.adapter.updateRow(credit.rowId, { [id('Gross')]: 11.9, [id('Net')]: 10 });
    const imageColumnId = id('Receipt Image');
    await ws.adapter.addFileReference({ rowId: credit.rowId, columnId: imageColumnId, fileId: file(94).id, fileUrl: `/api/files/${file(94).id}`, originalName: 'gutschrift.xml', mimeType: 'application/xml', metadata: { source: 'ocr-upload' } });
    const reread = await rereadReceipt(credit.rowId);
    expect(reread.ok).toBe(true);
    expect(await cellOf(ws, credit.rowId, 'Gross')).toBe(11.9);
    expect(await cellOf(ws, credit.rowId, 'Net')).toBe(10);
  });

  it('a document with no total stores none, however a label could be read', async () => {
    const text = 'Musterleasing AG\nLeasingantrag\nAntragsdatum 02.04.2025\nLaufzeit 24 Monate\nMonatlicher Betrag 49,90 EUR';
    classify.mockResolvedValue({ ...MEAL_ANSWER, category: 'Hardware & IT', konto: '4855', gross: null, noTotal: true, date: '2025-04-02T00:00:00.000Z', meal: null });
    const result = await upload(file(44), ocr(text), {});
    expect(await cellOf(ws, result.rowId, 'Gross')).toBeNull();
    expect(await cellOf(ws, result.rowId, 'Net')).toBeNull();
    // Nothing to doubt about a total that is not there; the missing amount itself asks for the look.
    expect(result.reviewFlags).toEqual([]);
    expect(result.attention).toBe('low_quality');
  });

  it('a page date that contradicts the labelled one is recorded, and the labelled one is stored', async () => {
    const text = 'Example Cloud Inc.\nInvoice date: 5 Jan 2025\nDue date: 4 Feb 2025\nTotal $20.00\nAmount due $20.00';
    classify.mockResolvedValue({ ...MEAL_ANSWER, category: 'Software & Lizenzen', konto: '4806', gross: 20, currency: 'USD', date: '2025-02-04T00:00:00.000Z', meal: null });
    const result = await upload(file(45), ocr(text), {});
    expect(result.reviewFlags).toEqual(['date_conflict']);
    expect(new Date((await cellOf(ws, result.rowId, 'Date')) as string).toISOString().slice(0, 10)).toBe('2025-01-05');
    expect(await cellOf(ws, result.rowId, 'Currency')).toBe('USD');
  });

  it('a file that another workspace holds is refused: its page is never read into a row here', async () => {
    await use(other);
    await upload(file(46), ocr(CAFE), {});
    await use(ws);
    loadPage.mockClear();
    const before = await rowCount(ws);
    await expect(upload(file(46), ocr(CAFE), {})).rejects.toThrow('File not found');
    expect(loadPage).not.toHaveBeenCalled();
    expect(await rowCount(ws)).toBe(before);
    const own = await upload(file(47), ocr(CAFE), {});
    await expect(retakeReceipt(own.rowId, file(46), ocr(CAFE), {})).rejects.toThrow('File not found');
    expect((await files(ws, own.rowId)).map((f) => f.fileId)).toEqual([file(47).id]);
  });
});

describe('the company an upload names', () => {
  /** A session that belongs to both workspaces, with `active` the active one. */
  function both(active: TestWorkspace) {
    session.current = { memberships: [membership(ws), membership(other)], activeWorkspace: membership(active) };
  }

  it('is where the receipt lands, even when the session has another company active (another tab switched)', async () => {
    both(other);
    const beforeOther = await rowCount(other);
    const result = await processReceipt(file(60), ocr(CAFE), { workspaceId: ws.workspaceId });
    expect((await ws.adapter.getRow(result.rowId))?.tableId).toBe(ws.tableId);
    expect(await rowCount(other)).toBe(beforeOther);
  });

  it('a company the session is not a member of is refused, and nothing is written anywhere', async () => {
    await use(ws);
    const before = [await rowCount(ws), await rowCount(other)];
    await expect(processReceipt(file(61), ocr(CAFE), { workspaceId: other.workspaceId })).rejects.toMatchObject({ status: 403 });
    expect([await rowCount(ws), await rowCount(other)]).toEqual(before);
  });

  it('an upload that names no company, or a malformed one, is refused instead of falling back to the active company', async () => {
    await use(ws);
    const before = await rowCount(ws);
    for (const workspaceId of [undefined, '', ` ${ws.workspaceId}`, 42]) {
      await expect(processReceipt(file(62), ocr(CAFE), { workspaceId } as never)).rejects.toMatchObject({ status: 403 });
    }
    expect(await rowCount(ws)).toBe(before);
  });

  it('a group of the company is never read from a new photo', async () => {
    await use(ws);
    const receipt = await ws.addReceipt(plainMealReceipt());
    const groupId = await createGroup(db, ws.workspaceId, 'Reise', [receipt]);
    await expect(retakeReceipt(groupId, file(65), ocr(CAFE), {})).rejects.toThrow('Receipt not found');
  });

  it('a retake stays with the receipt\'s own company, whatever company is active now', async () => {
    both(ws);
    const first = await processReceipt(file(63), ocr('unscharf', 0.2), { workspaceId: ws.workspaceId });
    both(other);
    const again = await retakeReceipt(first.rowId, file(64), ocr(CAFE), {});
    expect(again.rowId).toBe(first.rowId);
    expect((await files(ws, first.rowId)).map((f) => f.fileId)).toEqual([file(64).id]);
  });
});

describe('classification rules of the company apply when a receipt is read', () => {
  it('a keyword rule sets the assignment and the category (with its account) over the model\'s guess', async () => {
    const fresh = await createWorkspace();
    await use(fresh);
    await saveRule(db, { workspaceId: fresh.workspaceId, tenantId: fresh.tenantId }, { type: 'keyword', matchValue: 'Kräutertee', zuordnung: 'Privat', categoryOverride: 'Sonstige Ausgaben' });
    const result = await upload(file(70), ocr(CAFE));
    expect(await cellOf(fresh, result.rowId, 'Zuordnung')).toBe('Privat');
    expect(await cellOf(fresh, result.rowId, 'Category')).toBe('Sonstige Ausgaben');
    expect(await cellOf(fresh, result.rowId, 'Konto')).toBe('4900');
    expect(result).toMatchObject({ category: 'Sonstige Ausgaben', isMeal: false });
  });

  it('a rule of another company does not apply (company isolation)', async () => {
    const mine = await createWorkspace();
    const theirs = await createWorkspace();
    await saveRule(db, { workspaceId: theirs.workspaceId, tenantId: theirs.tenantId }, { type: 'keyword', matchValue: 'Kräutertee', zuordnung: 'Privat' });
    await use(mine);
    const result = await upload(file(71), ocr(CAFE));
    expect(await cellOf(mine, result.rowId, 'Zuordnung')).toBe('Geschäftlich');
  });

  it('without a rule the model\'s reading stands, and a new receipt carries the full share whatever the vendor', async () => {
    const fresh = await createWorkspace();
    await use(fresh);
    classify.mockResolvedValue({ ...MEAL_ANSWER, category: 'Software & Lizenzen', konto: '4806', meal: null, zuordnung: 'Geschäftlich' });
    const result = await upload(file(72), ocr('Anthropic, PBC\nClaude Pro\nTotal 18,00\n03.03.2026'));
    expect(await cellOf(fresh, result.rowId, 'Zuordnung')).toBe('Geschäftlich');
    expect(await cellOf(fresh, result.rowId, 'Business Share %')).toBe(100);
  });
});

describe('retakeReceipt: what a person decided stays', () => {
  it('keeps an assignment that is set and a business share that was changed', async () => {
    const first = await upload(file(50), ocr(CAFE), {});
    const columns = await ws.adapter.getColumns(ws.tableId);
    const id = (name: string) => columns.find((c) => c.name === name)!.id;
    const privat = (await ws.adapter.getSelectOptions(id('Zuordnung'))).find((o) => o.name === 'Privat')!.id;
    await ws.adapter.updateRow(first.rowId, { [id('Zuordnung')]: privat, [id('Business Share %')]: 40 });

    classify.mockResolvedValue({ ...MEAL_ANSWER, zuordnung: 'Geschäftlich' });
    await retakeReceipt(first.rowId, file(51), ocr(CAFE), {});
    expect(await cellOf(ws, first.rowId, 'Zuordnung')).toBe('Privat');
    expect(await cellOf(ws, first.rowId, 'Business Share %')).toBe(40);
  });

  it('an assignment nobody gave is filled by the retake, and the share stays the full one', async () => {
    classify.mockResolvedValue({ ...MEAL_ANSWER, zuordnung: null });
    const first = await upload(file(52), ocr('unscharf', 0.2), {});
    expect(await cellOf(ws, first.rowId, 'Zuordnung')).toBeNull();
    classify.mockResolvedValue({ ...MEAL_ANSWER, zuordnung: 'Geschäftlich' });
    await retakeReceipt(first.rowId, file(53), ocr(CAFE), {});
    expect(await cellOf(ws, first.rowId, 'Zuordnung')).toBe('Geschäftlich');
    expect(await cellOf(ws, first.rowId, 'Business Share %')).toBe(100);
  });
});

describe('rereadReceipt: a stored receipt read again with the page', () => {
  const stored = async (rowId: string) => (await db.receiptReview.findUnique({ where: { rowId } }))?.flags ?? null;
  const READ = { ...MEAL_ANSWER, name: 'Kräutertee, Cafe Morgenrot, €58.70, 19.02.2025', vendor: 'Cafe Morgenrot', gross: 58.7, date: '2025-02-19T00:00:00.000Z', zuordnung: 'Geschäftlich', meal: { ...MEAL_ANSWER.meal, taxLines: null, tip: null, place: null } };

  /** A receipt as the import of 2025 left some: a wrong total and date, and decisions a person made since. */
  async function wrongRow(cells: Record<string, unknown> = {}, workspace: TestWorkspace = ws, fileNumber = 60) {
    const rowId = await workspace.addReceipt({
      Name: 'Kräutertee, Cafe Morgenrot, €916752.88, 19.02.2025', Vendor: 'Laufkunde', Gross: 916752.88, Net: 770380.57, 'Tax Rate': 19,
      Date: '2025-02-20', Category: 'Software & Lizenzen', Konto: '4806', Zuordnung: 'Privat', 'Business Share %': 40, Status: 'Rejected',
      Confidence: 95, 'OCR Text': CAFE, ...cells,
    } as Parameters<TestWorkspace['addReceipt']>[0]);
    const columns = await workspace.adapter.getColumns(workspace.tableId);
    await workspace.adapter.addFileReference({
      rowId, columnId: columns.find((c) => c.name === 'Receipt Image')!.id, fileId: file(fileNumber).id, fileUrl: `/api/files/${file(fileNumber).id}`,
      originalName: `foto-${fileNumber}.jpg`, mimeType: 'image/jpeg', metadata: { source: 'ocr-upload' },
    });
    return rowId;
  }
  const snapshot = async (rowId: string) => JSON.stringify((await ws.adapter.getRow(rowId))!.cells);

  beforeEach(() => {
    classify.mockResolvedValue(READ);
  });

  it('writes what the page prints and leaves every decision alone', async () => {
    const rowId = await wrongRow();
    const result = await rereadReceipt(rowId);
    expect(result).toEqual({ ok: true, reviewFlags: [] });
    expect(loadPage).toHaveBeenCalledWith(file(60).id);
    expect(classify.mock.calls[0][0]).toMatchObject({ page: PAGE, fullText: CAFE });

    expect(await cellOf(ws, rowId, 'Gross')).toBe(58.7);
    expect(await cellOf(ws, rowId, 'Net')).toBe(49.33);
    // A vendor that is set stays on a receipt that is no restaurant's till receipt.
    expect(await cellOf(ws, rowId, 'Vendor')).toBe('Laufkunde');
    expect(new Date((await cellOf(ws, rowId, 'Date')) as string).toISOString().slice(0, 10)).toBe('2025-02-19');
    expect(await cellOf(ws, rowId, 'Currency')).toBe('EUR');
    // The name stated the total that is now read differently: the reader built it, so it is built again, with the vendor the row keeps.
    expect(await cellOf(ws, rowId, 'Name')).toBe('Laufkunde, 58,70 €, 19.02.2025');
    // The printed tax group replaces whatever the old reading left.
    expect(JSON.parse((await cellOf(ws, rowId, 'Tax Lines')) as string)).toEqual([{ rate: 19, net: 49.33, tax: 9.37 }]);

    // A person's decisions: the model answered "Bewirtung" and "Geschäftlich" and neither is written.
    expect(await cellOf(ws, rowId, 'Category')).toBe('Software & Lizenzen');
    expect(await cellOf(ws, rowId, 'Konto')).toBe('4806');
    expect(await cellOf(ws, rowId, 'Zuordnung')).toBe('Privat');
    expect(await cellOf(ws, rowId, 'Business Share %')).toBe(40);
    expect(await cellOf(ws, rowId, 'Status')).toBe('Rejected');
    expect(await rowCount(ws)).toBeGreaterThan(0);
    expect(await files(ws, rowId)).toHaveLength(1);
  });

  it('fills category, account and assignment where they are empty, and moves a waiting receipt on', async () => {
    const rowId = await wrongRow({ Category: null, Konto: null, Zuordnung: null, Status: 'Pending' }, ws, 61);
    await rereadReceipt(rowId);
    expect(await cellOf(ws, rowId, 'Category')).toBe('Bewirtung');
    expect(await cellOf(ws, rowId, 'Konto')).toBe('4650');
    expect(await cellOf(ws, rowId, 'Zuordnung')).toBe('Geschäftlich');
    expect(await cellOf(ws, rowId, 'Status')).toBe('Processed');
  });

  it('keeps a vendor that is set, and corrects a wrong one only on a restaurant\'s till receipt', async () => {
    const sameName = await wrongRow({ Vendor: 'CAFE MORGENROT', Category: 'Bewirtung' }, ws, 63);
    await rereadReceipt(sameName);
    // The page reads "Cafe Morgenrot": the same vendor, so the stored spelling stands and its rows stay in one group.
    expect(await cellOf(ws, sameName, 'Vendor')).toBe('CAFE MORGENROT');
    expect(await cellOf(ws, sameName, 'Gross')).toBe(58.7);
    // A till receipt prints the restaurant's own name at the top: a heading stored as the vendor is replaced.
    const otherName = await wrongRow({ Vendor: 'Laufkunde', Category: 'Bewirtung' }, ws, 64);
    await rereadReceipt(otherName);
    expect(await cellOf(ws, otherName, 'Vendor')).toBe('Cafe Morgenrot');
    // On an invoice the stored name is the one a customer uses; the page's legal name does not replace it.
    classify.mockResolvedValue({ ...READ, vendor: 'Musterhosting Holdings LLC' });
    const invoice = await wrongRow({ Vendor: 'Musterhosting' }, ws, 65);
    await rereadReceipt(invoice);
    expect(await cellOf(ws, invoice, 'Vendor')).toBe('Musterhosting');
    // An empty vendor is filled.
    classify.mockResolvedValue(READ);
    const empty = await wrongRow({ Vendor: null }, ws, 66);
    await rereadReceipt(empty);
    expect(await cellOf(ws, empty, 'Vendor')).toBe('Cafe Morgenrot');
  });

  it('keeps a name a person typed', async () => {
    const rowId = await wrongRow({ Name: 'Teamfrühstück im Februar' }, ws, 62);
    await rereadReceipt(rowId);
    expect(await cellOf(ws, rowId, 'Name')).toBe('Teamfrühstück im Februar');
    expect(await cellOf(ws, rowId, 'Gross')).toBe(58.7);
  });

  it('records the doubts of the new reading and reopens a receipt that was confirmed', async () => {
    const rowId = await wrongRow({}, ws, 63);
    await db.receiptReview.create({ data: { rowId, authWorkspaceId: ws.workspaceId, authTenantId: ws.tenantId, flags: ['total_unconfirmed'], checkedAt: new Date() } });
    classify.mockResolvedValue({ ...READ, gross: 61.4 });
    const result = await rereadReceipt(rowId);
    // The arithmetic proves 58.70; the model named the amount with the tip.
    expect(await cellOf(ws, rowId, 'Gross')).toBe(58.7);
    expect(result).toEqual({ ok: true, reviewFlags: [] });
    expect(await stored(rowId)).toEqual([]);
    expect((await db.receiptReview.findUnique({ where: { rowId } }))!.checkedAt).toBeNull();
  });

  it('the model does not answer: nothing is written', async () => {
    const rowId = await wrongRow({}, ws, 64);
    const before = await snapshot(rowId);
    classify.mockRejectedValue(new Error('model unavailable'));
    expect(await rereadReceipt(rowId)).toEqual({ ok: false, error: 'model_unavailable' });
    expect(await snapshot(rowId)).toBe(before);
    expect(await stored(rowId)).toBeNull();
  });

  it('the page cannot be read: nothing is written, even though the model answered from the text', async () => {
    const rowId = await wrongRow({}, ws, 65);
    const before = await snapshot(rowId);
    loadPage.mockResolvedValue({ skipped: 'too_large' });
    classify.mockResolvedValue({ ...READ, sawPage: false });
    expect(await rereadReceipt(rowId)).toEqual({ ok: false, error: 'page_unavailable' });
    expect(await snapshot(rowId)).toBe(before);
  });

  it('a row without a file, and one without recognized text, say so and ask no model', async () => {
    const noFile = await ws.addReceipt({ Name: 'Von Hand', Gross: 10, 'OCR Text': CAFE });
    expect(await rereadReceipt(noFile)).toEqual({ ok: false, error: 'no_file' });
    const noText = await wrongRow({ 'OCR Text': '' }, ws, 66);
    expect(await rereadReceipt(noText)).toEqual({ ok: false, error: 'no_text' });
    expect(classify).not.toHaveBeenCalled();
    expect(loadPage).not.toHaveBeenCalled();
  });

  it('a group is never read, and neither is a receipt of another workspace', async () => {
    const receipt = await wrongRow({}, ws, 67);
    const groupId = await createGroup(db, ws.workspaceId, 'Messe', [receipt]);
    expect(await rereadReceipt(groupId)).toEqual({ ok: false, error: 'not_found' });
    const foreign = await wrongRow({}, other, 68);
    const before = JSON.stringify((await other.adapter.getRow(foreign))!.cells);
    expect(await rereadReceipt(foreign)).toEqual({ ok: false, error: 'not_found' });
    expect(JSON.stringify((await other.adapter.getRow(foreign))!.cells)).toBe(before);
    expect(await rereadReceipt('')).toEqual({ ok: false, error: 'not_found' });
    expect(classify).not.toHaveBeenCalled();
  });
});

describe('recomputeFxRates', () => {
  it('filters by receipt date against the real timestamp column (string bounds used to fail the query)', async () => {
    const fresh = await createWorkspace();
    await use(fresh);
    await fresh.addReceipt({ Name: 'USD im Zeitraum', Gross: 10, Date: '2025-05-05', Currency: 'USD', 'FX Rate': null });
    await fresh.addReceipt({ Name: 'USD außerhalb', Gross: 10, Date: '2024-05-05', Currency: 'USD', 'FX Rate': null });
    await fresh.addReceipt({ Name: 'EUR im Zeitraum', Gross: 10, Date: '2025-06-06', Currency: 'EUR', 'FX Rate': 1 });
    expect(await recomputeFxRates('2025-01-01', '2025-12-31')).toEqual({ updated: 1, failed: 0, skippedEur: 1 });
    await expect(recomputeFxRates('gestern', 'heute')).rejects.toThrow(/YYYY-MM-DD/);
  });
});

describe('the item: one subscription keeps one wording', () => {
  const INVOICE = 'Example Video Tools\nInvoice\nInvoice date: 5 Jan 2026\nPlan monthly\nTotal $4.99';
  const ANSWER = { ...MEAL_ANSWER, category: 'Software & Lizenzen', konto: '4806', vendor: 'Example Video Tools', gross: 4.99, currency: 'USD', date: '2026-01-05T00:00:00.000Z', meal: { ...MEAL_ANSWER.meal, taxLines: null, tip: null, place: null } };

  it('the model is shown the wordings the vendor already has, and an answer in other words takes the stored one', async () => {
    const own = await createWorkspace();
    await use(own);
    await own.addReceipt({ Vendor: 'Example Video Tools', Item: 'Example Video Abo' } as Parameters<TestWorkspace['addReceipt']>[0]);
    await own.addReceipt({ Vendor: 'Example Video Tools Inc.', Item: 'Example Video Abo' } as Parameters<TestWorkspace['addReceipt']>[0]);
    await own.addReceipt({ Vendor: 'Example Video Tools', Item: 'Kanal-Paket' } as Parameters<TestWorkspace['addReceipt']>[0]);
    // Another vendor's items are never shown.
    await own.addReceipt({ Vendor: 'Other Shop', Item: 'Example Video Abo Pro' } as Parameters<TestWorkspace['addReceipt']>[0]);

    classify.mockResolvedValue({ ...ANSWER, item: 'Example Video Mitgliedschaft' });
    const result = await upload(file(80), ocr(INVOICE));
    expect(classify.mock.calls[0][0].knownItems).toEqual(['Example Video Abo', 'Kanal-Paket']);
    expect(await cellOf(own, result.rowId, 'Item')).toBe('Example Video Abo');

    // Something else bought from the same vendor is worded anew.
    classify.mockResolvedValue({ ...ANSWER, item: 'Speicher-Erweiterung' });
    const other = await upload(file(81), ocr(INVOICE.replace('4.99', '9.99')));
    expect(await cellOf(own, other.rowId, 'Item')).toBe('Speicher-Erweiterung');
  });

  it('a vendor without earlier receipts reads as before', async () => {
    const own = await createWorkspace();
    await use(own);
    classify.mockResolvedValue({ ...ANSWER, item: 'Example Video Abo' });
    const result = await upload(file(82), ocr(INVOICE));
    expect(classify.mock.calls[0][0].knownItems).toEqual([]);
    expect(await cellOf(own, result.rowId, 'Item')).toBe('Example Video Abo');
  });
});
