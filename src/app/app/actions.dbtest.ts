import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createWorkspace, db, type TestWorkspace } from '../../../test/db-helpers';

/**
 * processReceipt and retakeReceipt against a real database: the real rows,
 * file references and the real meal service. Auth, the classifier and the
 * exchange-rate lookup are replaced. Run with `pnpm test:db`.
 */

const session = { current: null as null | { memberships: unknown[]; activeWorkspace: { id: string; tenantId: string } } };
const classify = vi.fn();

vi.mock('@/lib/prisma', async () => ({ prisma: (await import('../../../test/db-helpers')).db }));
vi.mock('@/lib/auth', () => ({
  auth: {
    requireAction: vi.fn(async () => session.current),
    getSession: vi.fn(async () => session.current),
  },
}));
vi.mock('@/lib/web-search', () => ({ classifyWithWebSearch: (...a: unknown[]) => classify(...a) }));
vi.mock('@/lib/fx-rates', () => ({ getFxRate: vi.fn(async () => 0.9) }));

import { contactStore, loadMealRecord, saveMealDetails } from '@/lib/meals/service';
import { mealStatus } from '@/lib/meals/rules';
import { processReceipt, recomputeFxRates, retakeReceipt } from './actions';

let ws: TestWorkspace;
let other: TestWorkspace;

const HASH = (c: string) => c.repeat(64);
const file = (n: number) => ({ id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`, originalName: `foto-${n}.jpg`, fileType: 'image/jpeg' });
const ocr = (fullText: string, confidence = 0.95) => ({ fullText, blocks: [], confidence });

const RESTAURANT = 'Ristorante Beispiel\nPizza Margherita 12,00\nSumme 48,50\n14.03.2025';
const MEAL_ANSWER = {
  name: 'Abendessen, Ristorante Beispiel', category: 'Bewirtung', konto: '4650', zuordnung: 'Geschäftlich',
  taxRate: 19, confidence: 0.9, reasoning: '',
  meal: { mealType: 'business_meal_external', consumption: 'dine_in', tip: 5, taxLines: [{ rate: 19, net: 40.76, tax: 7.74 }], place: 'Ristorante Beispiel, Musterstraße 1, 12345 Musterstadt' },
};

async function use(workspace: TestWorkspace) {
  session.current = { memberships: [], activeWorkspace: { id: workspace.workspaceId, tenantId: workspace.tenantId } };
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
  await use(ws);
});
afterAll(async () => {
  await db.$disconnect();
});

describe('processReceipt', () => {
  it('a restaurant receipt is filed as a meal with what the classifier read, and waits for guests and occasion', async () => {
    const result = await processReceipt(file(1), ocr(RESTAURANT), { sha256: HASH('1') });
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
    const result = await processReceipt(file(2), null, { sha256: HASH('2') });
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
    const result = await processReceipt(file(3), ocr(RESTAURANT, 0.4), {});
    expect(result.attention).toBe('low_quality');
  });

  it('the classifier failing does not lose the receipt: fallback rules file it', async () => {
    classify.mockRejectedValue(new Error('model unavailable'));
    const result = await processReceipt(file(4), ocr('Ristorante Beispiel\nPasta 14,00\nSumme 14,00\n02.02.2026'), {});
    expect(result).toMatchObject({ category: 'Bewirtung', isMeal: true });
    // 2026 restaurant food without printed tax lines: 7 percent by date.
    expect((await loadMealRecord(db, ws.workspaceId, result.rowId))!.taxRate).toBe(7);
  });

  it('a supermarket receipt is not a meal even without the classifier', async () => {
    classify.mockRejectedValue(new Error('model unavailable'));
    const result = await processReceipt(file(5), ocr('REWE Markt GmbH\nBananen 1,99\nSumme 1,99\n02.03.2025'), {});
    expect(result.isMeal).toBe(false);
  });

  it('the same receipt photographed twice is saved and reported as a look-alike', async () => {
    const fresh = await createWorkspace();
    await use(fresh);
    const first = await processReceipt(file(6), ocr(RESTAURANT), { sha256: HASH('6') });
    const second = await processReceipt(file(7), ocr(RESTAURANT), { sha256: HASH('7') });
    expect(first.possibleDuplicateOf).toBeNull();
    expect(second.possibleDuplicateOf).toMatchObject({ rowId: first.rowId });
  });

  it('a malformed hash from the browser is not stored', async () => {
    const result = await processReceipt(file(8), ocr(RESTAURANT), { sha256: 'not-a-hash' });
    expect((await files(ws, result.rowId))[0].metadata).toEqual({ source: 'ocr-upload' });
  });
});

describe('retakeReceipt: never a second row', () => {
  it('replaces the photo and re-reads the receipt on the same row', async () => {
    const first = await processReceipt(file(10), ocr('unscharf', 0.2), { sha256: HASH('a') });
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
    const first = await processReceipt(file(12), ocr(RESTAURANT, 0.4), {});
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
    const foreign = await processReceipt(file(15), ocr(RESTAURANT), {});
    await use(ws);
    await expect(retakeReceipt(foreign.rowId, file(16), ocr(RESTAURANT), {})).rejects.toThrow('Receipt not found');
    expect((await files(other, foreign.rowId)).map((f) => f.fileId)).toEqual([file(15).id]);
  });

  it('a retake whose recognition fails again keeps the row and says so', async () => {
    const first = await processReceipt(file(17), ocr('unscharf', 0.2), {});
    const again = await retakeReceipt(first.rowId, file(18), null, {});
    expect(again).toMatchObject({ rowId: first.rowId, attention: 'ocr_failed' });
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
