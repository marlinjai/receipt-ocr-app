import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as F from '@/lib/extraction/__tests__/fixtures';
import { createWorkspace, db, type TestWorkspace } from '../../../../test/db-helpers';

/**
 * "Neue Lesart übernehmen" against a real database, next to a fresh upload of
 * the same receipt: both must leave the same amounts, currency and exchange
 * rate on the row. Auth, the classifier and the exchange-rate source are the
 * only things replaced; the lookup is the ONE module both paths import.
 * Run with `pnpm test:db`.
 */

const session = { current: null as null | { memberships: Array<{ id: string; tenantId: string }>; activeWorkspace: { id: string; tenantId: string } } };
const classify = vi.fn();
const fxRate = vi.fn();

vi.mock('@/lib/prisma', async () => ({ prisma: (await import('../../../../test/db-helpers')).db }));
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
vi.mock('@/lib/fx-rates', () => ({ getFxRate: (...a: unknown[]) => fxRate(...a) }));

import { processReceipt } from '../actions';
import { getReviewQueue, takeNewReading } from './review-actions';

let ws: TestWorkspace;

const file = (n: number) => ({ id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`, originalName: `rechnung-${n}.pdf`, fileType: 'application/pdf' });
const ocr = (fullText: string) => ({ fullText, blocks: [], confidence: 0.95 });

// The answer of a model that read the invoice well, and, as it is told to where a
// receipt prints no rate, inferred the German standard rate.
const MODEL_ANSWER = {
  name: 'Example Courses, 360.00 USD, 26.11.2025',
  vendor: 'Example Courses',
  gross: 360,
  category: 'Sonstige Ausgaben',
  konto: '4900',
  zuordnung: 'Geschäftlich',
  taxRate: 19,
  confidence: 0.9,
  reasoning: '',
  meal: { mealType: null, consumption: null, tip: null, taxLines: null, place: null },
};

// What the old reader left behind for the same invoice: the subtotal as the total,
// 19 percent German tax, a euro sign in the name, no currency, no exchange rate.
const OLD_ROW = {
  Name: 'Example Courses \u2013 Premium Package \u2013 \u20ac450.00 \u2013 26.11.2025',
  Vendor: 'Example Courses',
  Gross: 450,
  Net: 378.15,
  'Tax Rate': 19,
  Date: '2025-11-26',
  Category: 'Sonstige Ausgaben',
  'OCR Text': F.DOLLAR_INVOICE_WITH_DISCOUNT,
};

const COMPARED = ['Name', 'Vendor', 'Gross', 'Net', 'Tax Rate', 'Tax Rates', 'Currency', 'FX Rate'];

/** The compared cells of a row by column name; the date as its day. */
async function stateOf(rowId: string): Promise<Record<string, unknown>> {
  const columns = await ws.adapter.getColumns(ws.tableId);
  const row = (await ws.adapter.getRow(rowId))!;
  const out: Record<string, unknown> = {};
  for (const name of COMPARED) out[name] = row.cells[columns.find((c) => c.name === name)!.id] ?? null;
  const date = row.cells[columns.find((c) => c.name === 'Date')!.id];
  out.Date = date ? new Date(date as string).toISOString().slice(0, 10) : null;
  return out;
}

beforeEach(async () => {
  // A workspace of its own per test: two receipts of the same vendor, day and total are look-alikes of each other.
  ws = await createWorkspace();
  classify.mockReset();
  classify.mockResolvedValue(MODEL_ANSWER);
  fxRate.mockReset();
  // A rate that depends on what was asked: the same cells can only come from the same question.
  fxRate.mockImplementation(async (currency: string, isoDate: string | null) => {
    if (currency === 'EUR') return 1;
    if (!isoDate) return null;
    return currency === 'USD' && isoDate.slice(0, 10) === '2025-11-26' ? 0.8642 : 0.1111;
  });
  session.current = { memberships: [{ id: ws.workspaceId, tenantId: ws.tenantId }], activeWorkspace: { id: ws.workspaceId, tenantId: ws.tenantId } };
});
afterAll(async () => {
  await db.$disconnect();
});

describe('a dollar invoice, uploaded today and taken from the review list', () => {
  it('an upload stores 360 dollars with no German tax, whatever rate the model inferred', async () => {
    const uploaded = await processReceipt(file(1), ocr(F.DOLLAR_INVOICE_WITH_DISCOUNT), {});
    expect(uploaded.reviewFlags).toEqual([]);

    const columns = await ws.adapter.getColumns(ws.tableId);
    const currency = columns.find((c) => c.name === 'Currency')!;
    const usd = (await ws.adapter.getSelectOptions(currency.id)).find((o) => o.name === 'USD')!.id;
    expect(await stateOf(uploaded.rowId)).toEqual({
      Name: 'Example Courses, 360.00 USD, 26.11.2025',
      Vendor: 'Example Courses',
      Gross: 360,
      Net: 360,
      'Tax Rate': 0,
      'Tax Rates': '0 %',
      Currency: usd,
      'FX Rate': 0.8642,
      Date: '2025-11-26',
    });
  });

  it('without the model the upload reads the same amounts: the discount arithmetic confirms the total', async () => {
    classify.mockRejectedValue(new Error('model unavailable'));
    const uploaded = await processReceipt(file(2), ocr(F.DOLLAR_INVOICE_WITH_DISCOUNT), {});
    // Not classified, and nothing else: the total needs no look.
    expect(uploaded.reviewFlags).toEqual(['not_classified']);
    expect(await stateOf(uploaded.rowId)).toMatchObject({ Gross: 360, Net: 360, 'Tax Rate': 0, 'Tax Rates': '0 %', 'FX Rate': 0.8642 });
  });

  it('taking the new reading of the old row leaves it exactly as the upload of the same invoice', async () => {
    const uploaded = await processReceipt(file(3), ocr(F.DOLLAR_INVOICE_WITH_DISCOUNT), {});
    const old = await ws.addReceipt(OLD_ROW);

    const queue = await getReviewQueue();
    if (!queue.ok) throw new Error(queue.error);
    const offer = queue.value.find((e) => e.rowId === old)!;
    expect(offer.proposal.map((c) => c.field)).toEqual(['name', 'gross', 'net', 'taxRate', 'currency']);
    // The upload itself is settled: nothing about it is in the list.
    expect(queue.value.find((e) => e.rowId === uploaded.rowId)).toBeUndefined();

    // What the review panel sends: the field names of the offer, nothing else.
    const taken = await takeNewReading(old, offer.proposal.map((c) => c.field));
    expect(taken.ok).toBe(true);

    expect(await stateOf(old)).toEqual(await stateOf(uploaded.rowId));
    expect((await stateOf(old))['FX Rate']).toBe(0.8642);
    // Both paths asked the one lookup the same question: the currency read, for the receipt's day.
    expect(fxRate.mock.calls.map(([currency, isoDate]) => [currency, String(isoDate).slice(0, 10)])).toEqual([
      ['USD', '2025-11-26'],
      ['USD', '2025-11-26'],
    ]);
  });

  it('a value the browser sends is never written: only field names are taken', async () => {
    const old = await ws.addReceipt({ ...OLD_ROW, Date: '2025-11-27' });
    const taken = await takeNewReading(old, ['currency', 'gross: 1', 'Währung']);
    expect(taken.ok).toBe(true);
    expect(await stateOf(old)).toMatchObject({ Gross: 450, 'FX Rate': 0.1111 });
    // No field name at all is a refused request.
    expect(await takeNewReading(old, ['Währung'])).toEqual({ ok: false, error: 'not_found' });
  });
});
