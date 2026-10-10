import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { saveTaxSettings } from '@/lib/meals/service';
import { createAccount, importPayments, linkPayment, unlinkPayment } from '../payments/service';
import {
  TaxServiceError,
  createAsset,
  declineOpenYearBoundary,
  deleteDecisionsForRows,
  deleteVatSettlement,
  isWorkspaceReceipt,
  loadStatement,
  saveVatSettlement,
  saveYearBoundaryAnswer,
  type TaxContext,
} from '../service';
import { createWorkspace, db, plainMealReceipt, type TestWorkspace } from '../../../../test/db-helpers';

/** The ten-day rule against a real database (migration 0016). Run with `pnpm test:db`. Every name and amount is invented. */

let other: TestWorkspace;
let otherCtx: TaxContext;

async function workspace(): Promise<{ ws: TestWorkspace; ctx: TaxContext }> {
  const ws = await createWorkspace();
  const ctx = { workspaceId: ws.workspaceId, tenantId: ws.tenantId };
  await saveTaxSettings(db, ctx, { smallBusiness: true });
  return { ws, ctx };
}

const rent = (overrides: Record<string, string | number> = {}) => ({
  Name: 'Miete Januar',
  Vendor: 'Vermieter Beispiel',
  Gross: 650,
  Date: '2025-12-29',
  Category: 'Miete & Nebenkosten',
  Zuordnung: 'Geschäftlich',
  Currency: 'EUR',
  'FX Rate': 1,
  ...overrides,
});

const code = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    if (e instanceof TaxServiceError) return e.code;
    throw e;
  }
  return 'no error';
};

const HEADER = '"Booking Date","Value Date","Partner Name","Partner Iban",Type,"Payment Reference","Account Name","Amount (EUR)","Original Amount","Original Currency","Exchange Rate"';
const bankFile = (...rows: Array<[string, string]>) => [HEADER, ...rows.map(([day, amount]) => `${day},${day},"Vermieter Beispiel",,Debit Transfer,"Miete",Hauptkonto,${amount},,,`)].join('\n') + '\n';

beforeAll(async () => {
  ({ ws: other, ctx: otherCtx } = await workspace());
});

afterAll(async () => {
  await db.$disconnect();
});

const expense = async (ws: TestWorkspace, year: number) => (await loadStatement(db, ws.workspaceId, year)).businessExpenseCents;
const entryOf = async (ws: TestWorkspace, year: number, subjectId: string) => (await loadStatement(db, ws.workspaceId, year)).yearBoundary.find((e) => e.subjectId === subjectId);

describe('the ten-day rule: forward', () => {
  it('lists a payment in the window in both years it touches; confirming it moves it, once', async () => {
    const { ws, ctx } = await workspace();
    const rowId = await ws.addReceipt(rent());
    const outside = await ws.addReceipt(rent({ Name: 'Miete Dezember', Date: '2025-12-01' }));
    for (const year of [2025, 2026]) {
      const view = await loadStatement(db, ws.workspaceId, year);
      expect(view.yearBoundary.map((e) => [e.subjectId, e.cashDay, e.dayBasis, e.cents, e.otherYear, e.answer])).toEqual([[rowId, '2025-12-29', 'document', 65_000, 2026, null]]);
    }
    expect((await loadStatement(db, ws.workspaceId, 2024)).yearBoundary).toEqual([]);
    // Without an answer nothing is moved.
    expect([await expense(ws, 2025), await expense(ws, 2026)]).toEqual([130_000, 0]);

    await saveYearBoundaryAnswer(db, ctx, { kind: 'receipt', subjectId: rowId, cashDay: '2025-12-29', belongsToOtherYear: true });
    expect([await expense(ws, 2025), await expense(ws, 2026)]).toEqual([65_000, 65_000]);
    const moved = (await loadStatement(db, ws.workspaceId, 2026)).items.find((i) => i.rowId === rowId)!;
    // It counts on the first day of 2026 and still says when it was really paid.
    expect(moved).toMatchObject({ date: '2026-01-01', paidOn: '2025-12-29', amountCents: 65_000, counted: true });
    expect((await entryOf(ws, 2026, rowId))?.answer).toBe(true);
    expect(await code(saveYearBoundaryAnswer(db, ctx, { kind: 'receipt', subjectId: outside, cashDay: '2025-12-01', belongsToOtherYear: true }))).toBe('not_in_year_boundary');
    // A day inside the window that is not this receipt's day: the screen was stale.
    expect(await code(saveYearBoundaryAnswer(db, ctx, { kind: 'receipt', subjectId: outside, cashDay: '2025-12-29', belongsToOtherYear: true }))).toBe('not_in_year_boundary');
    expect(await code(saveYearBoundaryAnswer(db, ctx, { kind: 'receipt', subjectId: rowId, cashDay: '2025-12-30', belongsToOtherYear: false }))).toBe('year_boundary_changed');
    expect((await entryOf(ws, 2026, rowId))?.answer).toBe(true);
  });

  it('an advance payment of value-added tax paid in January counts in the old year when confirmed', async () => {
    const { ws, ctx } = await workspace();
    await saveTaxSettings(db, ctx, { smallBusiness: false });
    const id = await saveVatSettlement(db, ctx, { date: '2026-01-08', cents: 19_000, direction: 'paid' });
    const paid = async (year: number) => (await loadStatement(db, ws.workspaceId, year)).lines.find((l) => l.key === 'euer.vat_paid')?.cents ?? 0;
    expect([await paid(2025), await paid(2026)]).toEqual([0, 19_000]);
    await saveYearBoundaryAnswer(db, ctx, { kind: 'vat_settlement', subjectId: id, cashDay: '2026-01-08', belongsToOtherYear: true });
    expect([await paid(2025), await paid(2026)]).toEqual([19_000, 0]);
    const view = await loadStatement(db, ws.workspaceId, 2025);
    // Listed in the year it counts in, with the day it was really paid.
    expect(view.vat.settlements).toEqual([{ id, date: '2026-01-08', cents: 19_000, direction: 'paid', countsOn: '2025-12-31' }]);
    expect((await loadStatement(db, ws.workspaceId, 2026)).vat.settlements).toEqual([]);
    await deleteVatSettlement(db, ctx, id);
    expect(await db.taxYearBoundaryAnswer.count({ where: { authWorkspaceId: ws.workspaceId } })).toBe(0);
  });
});

describe('the ten-day rule: change, resume, re-entry', () => {
  it('an answer belongs to the payment day: another day asks again, the same day keeps it', async () => {
    const { ws, ctx } = await workspace();
    const rowId = await ws.addReceipt(rent({ Date: '2025-12-15' }));
    const accountId = await createAccount(db, ctx, { label: 'Geschäftskonto', kind: 'bank' });
    await importPayments(db, ctx, accountId, bankFile(['2025-12-30', '-650'], ['2026-01-20', '-650']));
    const [inWindow, later] = await db.taxPayment.findMany({ where: { accountId }, orderBy: { bookingDay: 'asc' } });
    const check = (id: string) => isWorkspaceReceipt(db, ctx.workspaceId, id);

    // The receipt's own day is outside the window; the linked payment's day is inside.
    expect(await entryOf(ws, 2025, rowId)).toBeUndefined();
    const linkId = await linkPayment(db, ctx, { paymentId: inWindow.id, rowId }, check);
    expect(await entryOf(ws, 2025, rowId)).toMatchObject({ cashDay: '2025-12-30', dayBasis: 'payment', answer: null });
    await saveYearBoundaryAnswer(db, ctx, { kind: 'receipt', subjectId: rowId, cashDay: '2025-12-30', belongsToOtherYear: true });
    expect([await expense(ws, 2025), await expense(ws, 2026)]).toEqual([0, 65_000]);

    // Resume: nothing but the database holds the answer.
    expect((await entryOf(ws, 2026, rowId))?.answer).toBe(true);

    // Backtrack: the receipt turns out to be paid by the later payment. The answer no longer applies.
    await unlinkPayment(db, ctx, linkId);
    await linkPayment(db, ctx, { paymentId: later.id, rowId }, check);
    expect(await entryOf(ws, 2026, rowId)).toBeUndefined();
    expect((await loadStatement(db, ws.workspaceId, 2026)).items.find((i) => i.rowId === rowId)).toMatchObject({ date: '2026-01-20' });

    // Back to the same payment day: the answer given for it holds again.
    const links = await db.taxPaymentLink.findMany({ where: { rowId } });
    await unlinkPayment(db, ctx, links[0].id);
    await linkPayment(db, ctx, { paymentId: inWindow.id, rowId }, check);
    expect((await entryOf(ws, 2026, rowId))?.answer).toBe(true);
    expect([await expense(ws, 2025), await expense(ws, 2026)]).toEqual([0, 65_000]);
  });

  it('a moved receipt without a payment can still be linked to the payment that later arrives, and the answer then asks again', async () => {
    const { ws, ctx } = await workspace();
    const rowId = await ws.addReceipt(rent({ Date: '2025-12-28' }));
    await saveYearBoundaryAnswer(db, ctx, { kind: 'receipt', subjectId: rowId, cashDay: '2025-12-28', belongsToOtherYear: true });
    const accountId = await createAccount(db, ctx, { label: 'Geschäftskonto', kind: 'bank' });
    await importPayments(db, ctx, accountId, bankFile(['2025-12-30', '-650']));
    const view = await loadStatement(db, ws.workspaceId, 2025);
    // Matched by the receipt's real day, although it counts in 2026.
    expect(view.payments.receiptTargets.find((r) => r.id === rowId)).toMatchObject({ day: '2025-12-28' });
    const payment = (await db.taxPayment.findFirst({ where: { accountId } }))!;
    await linkPayment(db, ctx, { paymentId: payment.id, rowId }, (id) => isWorkspaceReceipt(db, ctx.workspaceId, id));
    // The payment day is another day than the one the answer was given for.
    expect(await entryOf(ws, 2025, rowId)).toMatchObject({ cashDay: '2025-12-30', answer: null });
    expect([await expense(ws, 2025), await expense(ws, 2026)]).toEqual([65_000, 0]);
  });

  it('an answer can be changed and taken back; "none of these" answers only what is open', async () => {
    const { ws, ctx } = await workspace();
    const a = await ws.addReceipt(rent());
    const b = await ws.addReceipt(rent({ Name: 'Versicherung', Vendor: 'Versicherung Beispiel', Gross: 120, Date: '2026-01-04', Category: 'Versicherungen' }));
    await saveYearBoundaryAnswer(db, ctx, { kind: 'receipt', subjectId: a, cashDay: '2025-12-29', belongsToOtherYear: true });
    const seenB = { kind: 'receipt', subjectId: b, cashDay: '2026-01-04' };
    // An entry that is already answered, or shown on another day, was changed elsewhere: nothing is written.
    expect(await code(declineOpenYearBoundary(db, ctx, 2026, [seenB, { kind: 'receipt', subjectId: a, cashDay: '2025-12-29' }]))).toBe('year_boundary_changed');
    expect(await code(declineOpenYearBoundary(db, ctx, 2026, [{ ...seenB, cashDay: '2026-01-05' }]))).toBe('year_boundary_changed');
    expect((await entryOf(ws, 2026, b))?.answer).toBeNull();
    expect(await declineOpenYearBoundary(db, ctx, 2026, [seenB])).toBe(1);
    expect((await loadStatement(db, ws.workspaceId, 2026)).yearBoundary.map((e) => [e.subjectId, e.answer])).toEqual([[a, true], [b, false]]);
    expect(await declineOpenYearBoundary(db, ctx, 2026, [])).toBe(0);

    await saveYearBoundaryAnswer(db, ctx, { kind: 'receipt', subjectId: a, cashDay: '2025-12-29', belongsToOtherYear: false });
    expect([await expense(ws, 2025), await expense(ws, 2026)]).toEqual([65_000, 12_000]);
    await saveYearBoundaryAnswer(db, ctx, { kind: 'receipt', subjectId: b, cashDay: '2026-01-04', belongsToOtherYear: true });
    expect([await expense(ws, 2025), await expense(ws, 2026)]).toEqual([77_000, 0]);
    await saveYearBoundaryAnswer(db, ctx, { kind: 'receipt', subjectId: b, cashDay: '', belongsToOtherYear: null });
    expect((await entryOf(ws, 2026, b))?.answer).toBeNull();
    expect([await expense(ws, 2025), await expense(ws, 2026)]).toEqual([65_000, 12_000]);
  });

  it('deleting a receipt takes its answer along', async () => {
    const { ws, ctx } = await workspace();
    const rowId = await ws.addReceipt(rent());
    await saveYearBoundaryAnswer(db, ctx, { kind: 'receipt', subjectId: rowId, cashDay: '2025-12-29', belongsToOtherYear: true });
    await ws.adapter.deleteRow(rowId);
    await deleteDecisionsForRows(db, [rowId]);
    expect(await db.taxYearBoundaryAnswer.count({ where: { authWorkspaceId: ws.workspaceId } })).toBe(0);
  });
});

describe('the ten-day rule: what is never moved, and isolation', () => {
  it('a meal and a receipt in an asset are not asked about and cannot be answered', async () => {
    const { ws, ctx } = await workspace();
    const mealRow = await ws.addReceipt({ ...plainMealReceipt(), Date: '2025-12-30' });
    const camera = await ws.addReceipt(rent({ Name: 'Kamera', Vendor: 'Foto Beispiel', Gross: 1500, Category: 'Hardware & IT' }));
    await saveYearBoundaryAnswer(db, ctx, { kind: 'receipt', subjectId: camera, cashDay: '2025-12-29', belongsToOtherYear: true });
    await createAsset(db, ctx, { label: 'Kamera', kind: 'movable', acquisitionDate: '2025-12-29', method: 'linear', usefulLifeMonths: 84, itemIds: [camera] });
    let view = await loadStatement(db, ws.workspaceId, 2025);
    // The meal is not asked about at all. The earlier answer for the camera has no effect on an
    // asset (it is depreciated from December 2025), and stays listed so it can be taken back.
    expect(view.yearBoundary.map((e) => [e.subjectId, e.answer, e.inactive])).toEqual([[camera, true, 'asset']]);
    expect(view.assets[0]).toMatchObject({ counted: true, costCents: 150_000 });
    expect(await code(saveYearBoundaryAnswer(db, ctx, { kind: 'receipt', subjectId: mealRow, cashDay: '2025-12-30', belongsToOtherYear: true }))).toBe('meal_row');
    expect(await code(saveYearBoundaryAnswer(db, ctx, { kind: 'receipt', subjectId: camera, cashDay: '2025-12-29', belongsToOtherYear: false }))).toBe('asset_row');
    // "None of these" never touches an answer without effect.
    expect(await code(declineOpenYearBoundary(db, ctx, 2025, [{ kind: 'receipt', subjectId: camera, cashDay: '2025-12-29' }]))).toBe('year_boundary_changed');
    await saveYearBoundaryAnswer(db, ctx, { kind: 'receipt', subjectId: camera, cashDay: '', belongsToOtherYear: null });
    view = await loadStatement(db, ws.workspaceId, 2025);
    expect(view.yearBoundary).toEqual([]);
    expect(await db.taxYearBoundaryAnswer.count({ where: { authWorkspaceId: ws.workspaceId } })).toBe(0);
  });

  it('rejects malformed answers, and subjects of another workspace do not exist here', async () => {
    const { ws, ctx } = await workspace();
    const foreignRow = await other.addReceipt(rent());
    const foreignSettlement = await saveVatSettlement(db, otherCtx, { date: '2026-01-08', cents: 19_000, direction: 'paid' });
    expect(await code(saveYearBoundaryAnswer(db, ctx, { kind: 'receipt', subjectId: foreignRow, cashDay: '2025-12-29', belongsToOtherYear: true }))).toBe('boundary_subject_not_found');
    expect(await code(declineOpenYearBoundary(db, ctx, 2025, [{ kind: 'receipt', subjectId: foreignRow, cashDay: '2025-12-29' }]))).toBe('year_boundary_changed');
    expect(await code(saveYearBoundaryAnswer(db, ctx, { kind: 'vat_settlement', subjectId: foreignSettlement, cashDay: '2026-01-08', belongsToOtherYear: true }))).toBe('boundary_subject_not_found');
    expect(await code(saveYearBoundaryAnswer(db, ctx, { kind: 'invoice', subjectId: 'x', cashDay: '2025-12-29', belongsToOtherYear: true }))).toBe('boundary_subject_not_found');
    expect(await code(saveYearBoundaryAnswer(db, ctx, { kind: 'receipt', subjectId: foreignRow, cashDay: '2025-12-29', belongsToOtherYear: 'yes' }))).toBe('boundary_subject_not_found');
    expect(await db.taxYearBoundaryAnswer.count({ where: { authWorkspaceId: ws.workspaceId } })).toBe(0);
    // An answer in the other workspace is untouched by taking "the same" answer back here.
    await saveYearBoundaryAnswer(db, otherCtx, { kind: 'receipt', subjectId: foreignRow, cashDay: '2025-12-29', belongsToOtherYear: true });
    await saveYearBoundaryAnswer(db, ctx, { kind: 'receipt', subjectId: foreignRow, cashDay: '', belongsToOtherYear: null });
    expect(await db.taxYearBoundaryAnswer.count({ where: { authWorkspaceId: other.workspaceId, subjectId: foreignRow } })).toBe(1);
  });
});
