import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { saveTaxSettings } from '@/lib/meals/service';
import { saveChurchMonths, saveFiledOn } from '../income-tax/service';
import { IncomeTaxInputError } from '../income-tax/input';
import { createAccount, importPayments, linkPayment, unlinkPayment } from '../payments/service';
import {
  TaxServiceError,
  createAsset,
  declineOpenYearBoundary,
  deleteDecisionsForRows,
  deleteVatSettlement,
  receiptForLink,
  loadStatement,
  saveStatusChange,
  saveVatSettings,
  saveVatSettlement,
  saveYearBoundaryAnswer,
  type TaxContext,
} from '../service';
import { createWorkspace, db, plainMealReceipt, type TestWorkspace } from '../../../../test/db-helpers';

/**
 * The ten-day rule against a real database (migrations 0016 and 0036, the
 * filing day). Run with `pnpm test:db`. Every name and amount is invented.
 */

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
    if (e instanceof TaxServiceError || e instanceof IncomeTaxInputError) return e.code;
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

/** Regular taxation with quarterly advance returns, so payments to the tax office recur. */
const regular = async (ctx: TaxContext) => {
  await saveTaxSettings(db, ctx, { smallBusiness: false });
  await saveVatSettings(db, ctx, { frequency: 'quarterly', method: 'issued' });
};

const expense = async (ws: TestWorkspace, year: number) => (await loadStatement(db, ws.workspaceId, year)).businessExpenseCents;
const entryOf = async (ws: TestWorkspace, year: number, subjectId: string) => (await loadStatement(db, ws.workspaceId, year)).yearBoundary.find((e) => e.subjectId === subjectId);

describe('the ten-day rule: forward', () => {
  it('lists a payment in the window in both years it touches; confirming it moves it, once', async () => {
    const { ws, ctx } = await workspace();
    const rowId = await ws.addReceipt(rent());
    const outside = await ws.addReceipt(rent({ Name: 'Miete Dezember', Date: '2025-12-01' }));
    for (const year of [2025, 2026]) {
      const view = await loadStatement(db, ws.workspaceId, year);
      // One rent receipt of this landlord in the year before: a one-off by the data, so it stays by rule.
      expect(view.yearBoundary.map((e) => [e.subjectId, e.cashDay, e.dayBasis, e.cents, e.otherYear, e.answer, e.source, e.reason, e.storedAnswer])).toEqual([
        [rowId, '2025-12-29', 'document', 65_000, 2026, false, 'rule', 'einmalige Zahlung', null],
      ]);
    }
    expect((await loadStatement(db, ws.workspaceId, 2024)).yearBoundary).toEqual([]);
    // The rule writes nothing and moves nothing.
    expect([await expense(ws, 2025), await expense(ws, 2026)]).toEqual([130_000, 0]);
    expect(await db.taxYearBoundaryAnswer.count({ where: { authWorkspaceId: ws.workspaceId } })).toBe(0);

    await saveYearBoundaryAnswer(db, ctx, { kind: 'receipt', subjectId: rowId, cashDay: '2025-12-29', belongsToOtherYear: true });
    expect([await expense(ws, 2025), await expense(ws, 2026)]).toEqual([65_000, 65_000]);
    const moved = (await loadStatement(db, ws.workspaceId, 2026)).items.find((i) => i.rowId === rowId)!;
    // It counts on the first day of 2026 and still says when it was really paid.
    expect(moved).toMatchObject({ date: '2026-01-01', paidOn: '2025-12-29', amountCents: 65_000, counted: true });
    expect(await entryOf(ws, 2026, rowId)).toMatchObject({ answer: true, source: 'person', storedAnswer: true });
    expect(await code(saveYearBoundaryAnswer(db, ctx, { kind: 'receipt', subjectId: outside, cashDay: '2025-12-01', belongsToOtherYear: true }))).toBe('not_in_year_boundary');
    // A day inside the window that is not this receipt's day: the screen was stale.
    expect(await code(saveYearBoundaryAnswer(db, ctx, { kind: 'receipt', subjectId: outside, cashDay: '2025-12-29', belongsToOtherYear: true }))).toBe('not_in_year_boundary');
    expect(await code(saveYearBoundaryAnswer(db, ctx, { kind: 'receipt', subjectId: rowId, cashDay: '2025-12-30', belongsToOtherYear: false }))).toBe('year_boundary_changed');
    expect((await entryOf(ws, 2026, rowId))?.answer).toBe(true);
  });

  it('regular taxation: an advance payment of value-added tax paid in January counts in the old year by rule; a person can override it and take that back', async () => {
    const { ws, ctx } = await workspace();
    await regular(ctx);
    const id = await saveVatSettlement(db, ctx, { date: '2026-01-08', cents: 19_000, direction: 'paid' });
    const december = await saveVatSettlement(db, ctx, { date: '2025-12-23', cents: 7_700, direction: 'paid' });
    const paid = async (year: number) => (await loadStatement(db, ws.workspaceId, year)).lines.find((l) => l.key === 'euer.vat_paid')?.cents ?? 0;
    // Nobody answered: the December one stays, the January one belongs to the year before.
    expect([await paid(2025), await paid(2026)]).toEqual([26_700, 0]);
    expect(await entryOf(ws, 2025, id)).toMatchObject({ answer: true, source: 'rule', storedAnswer: null });
    expect(await entryOf(ws, 2025, december)).toMatchObject({ answer: false, source: 'rule' });
    const view = await loadStatement(db, ws.workspaceId, 2025);
    // Listed in the year it counts in, with the day it was really paid.
    expect(view.vat.settlements).toEqual([
      { id: december, date: '2025-12-23', cents: 7_700, direction: 'paid' },
      { id, date: '2026-01-08', cents: 19_000, direction: 'paid', countsOn: '2025-12-31' },
    ]);
    expect((await loadStatement(db, ws.workspaceId, 2026)).vat.settlements).toEqual([]);
    // Nothing is open, so "none of these" has nothing to answer.
    expect(await code(declineOpenYearBoundary(db, ctx, 2026, [{ kind: 'vat_settlement', subjectId: id, cashDay: '2026-01-08' }]))).toBe('year_boundary_changed');

    // A person says it pays a period of 2026 after all: that overrides the rule.
    await saveYearBoundaryAnswer(db, ctx, { kind: 'vat_settlement', subjectId: id, cashDay: '2026-01-08', belongsToOtherYear: false });
    expect([await paid(2025), await paid(2026)]).toEqual([7_700, 19_000]);
    expect(await entryOf(ws, 2026, id)).toMatchObject({ answer: false, source: 'person', storedAnswer: false });
    // Taking the answer back returns the rule.
    await saveYearBoundaryAnswer(db, ctx, { kind: 'vat_settlement', subjectId: id, cashDay: '', belongsToOtherYear: null });
    expect([await paid(2025), await paid(2026)]).toEqual([26_700, 0]);
    expect(await entryOf(ws, 2026, id)).toMatchObject({ answer: true, source: 'rule', storedAnswer: null });

    await saveYearBoundaryAnswer(db, ctx, { kind: 'vat_settlement', subjectId: id, cashDay: '2026-01-08', belongsToOtherYear: true });
    await deleteVatSettlement(db, ctx, id);
    expect(await db.taxYearBoundaryAnswer.count({ where: { authWorkspaceId: ws.workspaceId } })).toBe(0);
  });
});

describe('the ten-day rule: value-added tax by the status on the payment day', () => {
  const paid = async (ws: TestWorkspace, year: number) => (await loadStatement(db, ws.workspaceId, year)).lines.find((l) => l.key === 'euer.vat_paid')?.cents ?? 0;

  it('a small business has no recurring advance payments: a payment to the tax office in January stays in the year it was paid', async () => {
    const { ws, ctx } = await workspace();
    const id = await saveVatSettlement(db, ctx, { date: '2026-01-08', cents: 4_200, direction: 'paid' });
    expect(await entryOf(ws, 2026, id)).toMatchObject({ answer: false, source: 'rule', reason: 'Kleinunternehmer: keine regelmäßige Vorauszahlung' });
    expect([await paid(ws, 2025), await paid(ws, 2026)]).toEqual([0, 4_200]);
    expect((await loadStatement(db, ws.workspaceId, 2026)).yearBoundary.filter((e) => e.source === null)).toEqual([]);
  });

  it('unanswered status or advance return period: the settlement stays open as a question and is not moved', async () => {
    // The small-business question was never answered.
    const ws = await createWorkspace();
    const ctx = { workspaceId: ws.workspaceId, tenantId: ws.tenantId };
    const id = await saveVatSettlement(db, ctx, { date: '2026-01-08', cents: 4_200, direction: 'paid' });
    expect(await entryOf(ws, 2026, id)).toMatchObject({ answer: null, source: null, reason: 'Ob an diesem Tag die Kleinunternehmerregelung galt, ist noch nicht beantwortet' });
    await saveTaxSettings(db, ctx, { smallBusiness: false });
    expect(await entryOf(ws, 2026, id)).toMatchObject({ answer: null, source: null, reason: 'Der Abgabezeitraum der Umsatzsteuer-Voranmeldung ist noch nicht gewählt' });
    expect([await paid(ws, 2025), await paid(ws, 2026)]).toEqual([0, 4_200]);
    // "None of these" answers it: it stays, by the person's answer.
    expect(await declineOpenYearBoundary(db, ctx, 2026, [{ kind: 'vat_settlement', subjectId: id, cashDay: '2026-01-08' }])).toBe(1);
    expect(await entryOf(ws, 2026, id)).toMatchObject({ answer: false, source: 'person' });
    // Backtrack: the period is chosen later; the person's answer still overrides the rule.
    await saveVatSettings(db, ctx, { frequency: 'monthly', method: 'issued' });
    expect(await entryOf(ws, 2026, id)).toMatchObject({ answer: false, source: 'person' });
  });

  it('a change of the small-business status during the year is read on the payment day', async () => {
    const { ws, ctx } = await workspace();
    await saveVatSettings(db, ctx, { frequency: 'quarterly', method: 'issued' });
    // A small business until the end of 2025, regularly taxed from 2026 on.
    await saveStatusChange(db, ctx, { effectiveFrom: '2026-01-01', smallBusiness: false });
    const december = await saveVatSettlement(db, ctx, { date: '2025-12-23', cents: 1_300, direction: 'paid' });
    const january = await saveVatSettlement(db, ctx, { date: '2026-01-09', cents: 5_100, direction: 'paid' });
    expect(await entryOf(ws, 2025, december)).toMatchObject({ answer: false, source: 'rule', reason: 'Kleinunternehmer: keine regelmäßige Vorauszahlung' });
    expect(await entryOf(ws, 2025, january)).toMatchObject({ answer: true, source: 'rule' });
    expect([await paid(ws, 2025), await paid(ws, 2026)]).toEqual([6_400, 0]);
  });
});

describe('the ten-day rule: change, resume, re-entry', () => {
  it('an answer belongs to the payment day: another day asks again, the same day keeps it', async () => {
    const { ws, ctx } = await workspace();
    const rowId = await ws.addReceipt(rent({ Date: '2025-12-15' }));
    const accountId = await createAccount(db, ctx, { label: 'Geschäftskonto', kind: 'bank' });
    await importPayments(db, ctx, accountId, bankFile(['2025-12-30', '-650'], ['2026-01-20', '-650']));
    const [inWindow, later] = await db.taxPayment.findMany({ where: { accountId }, orderBy: { bookingDay: 'asc' } });
    const check = receiptForLink(db, ctx.workspaceId);

    // The receipt's own day is outside the window; the linked payment's day is inside.
    expect(await entryOf(ws, 2025, rowId)).toBeUndefined();
    const { linkId } = await linkPayment(db, ctx, { paymentId: inWindow.id, rowId }, check);
    expect(await entryOf(ws, 2025, rowId)).toMatchObject({ cashDay: '2025-12-30', dayBasis: 'payment', answer: false, source: 'rule', storedAnswer: null });
    await saveYearBoundaryAnswer(db, ctx, { kind: 'receipt', subjectId: rowId, cashDay: '2025-12-30', belongsToOtherYear: true });
    expect([await expense(ws, 2025), await expense(ws, 2026)]).toEqual([0, 65_000]);

    // Resume: nothing but the database holds the answer.
    expect(await entryOf(ws, 2026, rowId)).toMatchObject({ answer: true, source: 'person' });

    // Backtrack: the receipt turns out to be paid by the later payment. The answer no longer applies.
    await unlinkPayment(db, ctx, linkId);
    await linkPayment(db, ctx, { paymentId: later.id, rowId }, check);
    expect(await entryOf(ws, 2026, rowId)).toBeUndefined();
    expect((await loadStatement(db, ws.workspaceId, 2026)).items.find((i) => i.rowId === rowId)).toMatchObject({ date: '2026-01-20' });

    // Back to the same payment day: the answer given for it holds again.
    const links = await db.taxPaymentLink.findMany({ where: { rowId } });
    await unlinkPayment(db, ctx, links[0].id);
    await linkPayment(db, ctx, { paymentId: inWindow.id, rowId }, check);
    expect(await entryOf(ws, 2026, rowId)).toMatchObject({ answer: true, source: 'person' });
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
    await linkPayment(db, ctx, { paymentId: payment.id, rowId }, receiptForLink(db, ctx.workspaceId));
    // The payment day is another day than the one the answer was given for.
    expect(await entryOf(ws, 2025, rowId)).toMatchObject({ cashDay: '2025-12-30', storedAnswer: null, source: 'rule', answer: false });
    expect([await expense(ws, 2025), await expense(ws, 2026)]).toEqual([65_000, 0]);
  });

  it('an answer can be changed and taken back; "none of these" answers only what no rule settles', async () => {
    const { ws, ctx } = await workspace();
    const a = await ws.addReceipt(rent());
    // Without a vendor nobody can tell whether it recurs: the one entry that stays open.
    const b = await ws.addReceipt(rent({ Name: 'Versicherung', Vendor: '', Gross: 120, Date: '2026-01-04', Category: 'Versicherungen' }));
    expect(await entryOf(ws, 2026, b)).toMatchObject({ answer: null, source: null, storedAnswer: null });
    await saveYearBoundaryAnswer(db, ctx, { kind: 'receipt', subjectId: a, cashDay: '2025-12-29', belongsToOtherYear: true });
    const seenB = { kind: 'receipt', subjectId: b, cashDay: '2026-01-04' };
    // An entry that is already answered (by a person or a rule), or shown on another day, was changed elsewhere: nothing is written.
    expect(await code(declineOpenYearBoundary(db, ctx, 2026, [seenB, { kind: 'receipt', subjectId: a, cashDay: '2025-12-29' }]))).toBe('year_boundary_changed');
    expect(await code(declineOpenYearBoundary(db, ctx, 2026, [{ ...seenB, cashDay: '2026-01-05' }]))).toBe('year_boundary_changed');
    expect((await entryOf(ws, 2026, b))?.answer).toBeNull();
    expect(await declineOpenYearBoundary(db, ctx, 2026, [seenB])).toBe(1);
    expect((await loadStatement(db, ws.workspaceId, 2026)).yearBoundary.map((e) => [e.subjectId, e.answer, e.source])).toEqual([
      [a, true, 'person'],
      [b, false, 'person'],
    ]);
    expect(await declineOpenYearBoundary(db, ctx, 2026, [])).toBe(0);

    await saveYearBoundaryAnswer(db, ctx, { kind: 'receipt', subjectId: a, cashDay: '2025-12-29', belongsToOtherYear: false });
    expect([await expense(ws, 2025), await expense(ws, 2026)]).toEqual([65_000, 12_000]);
    await saveYearBoundaryAnswer(db, ctx, { kind: 'receipt', subjectId: b, cashDay: '2026-01-04', belongsToOtherYear: true });
    expect([await expense(ws, 2025), await expense(ws, 2026)]).toEqual([77_000, 0]);
    await saveYearBoundaryAnswer(db, ctx, { kind: 'receipt', subjectId: b, cashDay: '', belongsToOtherYear: null });
    expect((await entryOf(ws, 2026, b))?.answer).toBeNull();
    expect([await expense(ws, 2025), await expense(ws, 2026)]).toEqual([65_000, 12_000]);
    // Taking back the answer for the landlord returns its rule.
    await saveYearBoundaryAnswer(db, ctx, { kind: 'receipt', subjectId: a, cashDay: '', belongsToOtherYear: null });
    expect(await entryOf(ws, 2026, a)).toMatchObject({ answer: false, source: 'rule', reason: 'einmalige Zahlung' });
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

describe('the ten-day rule: rules from the payment data', () => {
  const subscription = (Date: string, overrides: Record<string, string | number> = {}) =>
    rent({ Name: 'Abo Werkzeug', Vendor: 'Werkzeug Abo Beispiel', Gross: 20, Date, Category: 'Software & Lizenzen', ...overrides });

  it('a vendor billed in three earlier months is a subscription that stays; when it stops recurring its reason changes', async () => {
    const { ws } = await workspace();
    const earlier = [];
    for (const day of ['2025-09-26', '2025-10-26', '2025-11-26']) earlier.push(await ws.addReceipt(subscription(day)));
    const december = await ws.addReceipt(subscription('2025-12-26'));
    expect(await entryOf(ws, 2025, december)).toMatchObject({ answer: false, source: 'rule', reason: 'Abo, Zeitraum beginnt am Zahltag' });
    expect([await expense(ws, 2025), await expense(ws, 2026)]).toEqual([8_000, 0]);
    // Backtrack: one of the earlier receipts goes; two months are no pattern, so it is a one-off now.
    await ws.adapter.deleteRow(earlier[0]);
    expect(await entryOf(ws, 2025, december)).toMatchObject({ answer: false, source: 'rule', reason: 'einmalige Zahlung' });
    // The open count of the year stays zero either way.
    expect((await loadStatement(db, ws.workspaceId, 2025)).yearBoundary.filter((e) => e.source === null)).toEqual([]);
  });

  it('payments out that name the vendor count as months too, without any receipt for them', async () => {
    const { ws, ctx } = await workspace();
    const january = await ws.addReceipt(rent({ Date: '2026-01-05' }));
    expect(await entryOf(ws, 2026, january)).toMatchObject({ reason: 'einmalige Zahlung' });
    const accountId = await createAccount(db, ctx, { label: 'Geschäftskonto', kind: 'bank' });
    await importPayments(db, ctx, accountId, bankFile(['2025-10-01', '-650'], ['2025-11-01', '-650'], ['2025-12-01', '-650']));
    expect(await entryOf(ws, 2026, january)).toMatchObject({ answer: false, source: 'rule', reason: 'Abo, Zeitraum beginnt am Zahltag' });
  });
});

describe('the ten-day rule: filed years', () => {
  /** Every figure of a year that the ten-day rule can change. */
  const totals = async (ws: TestWorkspace, year: number) => {
    const view = await loadStatement(db, ws.workspaceId, year);
    return { expense: view.businessExpenseCents, profit: view.profitCents, lines: view.lines, settlements: view.vat.settlements };
  };
  const backdate = (ws: TestWorkspace, subjectId: string, day: string) =>
    db.taxYearBoundaryAnswer.updateMany({ where: { authWorkspaceId: ws.workspaceId, subjectId }, data: { updatedAt: new Date(`${day}T12:00:00Z`) } });

  it('a filed year fixes its turn; an answer after the filing day is refused or reported, never applied, and the filed totals do not change', async () => {
    const { ws, ctx } = await workspace();
    await regular(ctx);
    // Under regular taxation the expense is the net amount; the rent carries no value-added tax.
    const rowId = await ws.addReceipt(rent({ Net: 650 }));
    const settlement = await saveVatSettlement(db, ctx, { date: '2026-01-08', cents: 19_000, direction: 'paid' });
    // While open the January settlement belongs to 2025 by rule.
    expect(await entryOf(ws, 2025, settlement)).toMatchObject({ answer: true, source: 'rule' });

    await saveFiledOn(db, ctx, { year: 2025, filedOn: '2026-10-17' });
    expect((await loadStatement(db, ws.workspaceId, 2025)).incomeTax.filedOn).toBe('2026-10-17');
    // Filed with every payment on the day it was paid: both stay, by the filed year, not by a rule.
    expect(await entryOf(ws, 2025, rowId)).toMatchObject({ answer: false, source: 'filed', reason: 'Festgelegt durch die abgegebene Erklärung 2025', filedYear: 2025 });
    expect(await entryOf(ws, 2026, settlement)).toMatchObject({ answer: false, source: 'filed', filedYear: 2025 });
    const filed2025 = await totals(ws, 2025);
    const open2026 = await totals(ws, 2026);
    expect(filed2025.expense).toBe(65_000);
    expect(filed2025.settlements).toEqual([]);
    expect(open2026.settlements).toEqual([{ id: settlement, date: '2026-01-08', cents: 19_000, direction: 'paid' }]);
    expect((await loadStatement(db, ws.workspaceId, 2025)).yearBoundary.filter((e) => e.source === null)).toEqual([]);

    // Re-entry: the same filing day again changes nothing.
    await saveFiledOn(db, ctx, { year: 2025, filedOn: '2026-10-17' });
    expect(await db.taxYearSettings.count({ where: { authWorkspaceId: ws.workspaceId } })).toBe(1);
    expect(await totals(ws, 2025)).toEqual(filed2025);

    // Moving a payment across the filed year is refused; "stays" agrees with the return and is kept.
    expect(await code(saveYearBoundaryAnswer(db, ctx, { kind: 'receipt', subjectId: rowId, cashDay: '2025-12-29', belongsToOtherYear: true }))).toBe('year_boundary_filed');
    expect(await code(saveYearBoundaryAnswer(db, ctx, { kind: 'vat_settlement', subjectId: settlement, cashDay: '2026-01-08', belongsToOtherYear: true }))).toBe('year_boundary_filed');
    await saveYearBoundaryAnswer(db, ctx, { kind: 'vat_settlement', subjectId: settlement, cashDay: '2026-01-08', belongsToOtherYear: false });
    expect(await entryOf(ws, 2026, settlement)).toMatchObject({ answer: false, source: 'person', storedAnswer: false });
    expect(await totals(ws, 2025)).toEqual(filed2025);

    // An answer to move it, given while the year was open and dated after the filing day (the day was
    // recorded later): it is reported with the year it departs from, and not applied.
    await saveFiledOn(db, ctx, { year: 2025, filedOn: null });
    await saveYearBoundaryAnswer(db, ctx, { kind: 'receipt', subjectId: rowId, cashDay: '2025-12-29', belongsToOtherYear: true });
    await backdate(ws, rowId, '2026-10-20');
    await saveFiledOn(db, ctx, { year: 2025, filedOn: '2026-10-17' });
    expect(await entryOf(ws, 2025, rowId)).toMatchObject({
      answer: false,
      source: 'filed',
      storedAnswer: true,
      departsFromFiled: 2025,
      reason: 'Weicht von der abgegebenen Erklärung 2025 ab',
    });
    expect(await totals(ws, 2025)).toEqual(filed2025);
    expect(await totals(ws, 2026)).toEqual(open2026);

    // Taking that answer back leaves the filed year as it was.
    await saveYearBoundaryAnswer(db, ctx, { kind: 'receipt', subjectId: rowId, cashDay: '', belongsToOtherYear: null });
    expect(await entryOf(ws, 2025, rowId)).toMatchObject({ source: 'filed', storedAnswer: null, departsFromFiled: null });
    expect(await totals(ws, 2025)).toEqual(filed2025);
  });

  it('backtrack: clearing the filing day unlocks the turn, so rules and answers apply again; resume reads the same', async () => {
    const { ws, ctx } = await workspace();
    await regular(ctx);
    // Under regular taxation the expense is the net amount; the rent carries no value-added tax.
    const rowId = await ws.addReceipt(rent({ Net: 650 }));
    const settlement = await saveVatSettlement(db, ctx, { date: '2026-01-08', cents: 19_000, direction: 'paid' });
    await saveYearBoundaryAnswer(db, ctx, { kind: 'receipt', subjectId: rowId, cashDay: '2025-12-29', belongsToOtherYear: true });
    await backdate(ws, rowId, '2026-10-20');
    await saveFiledOn(db, ctx, { year: 2025, filedOn: '2026-10-17' });
    // The rent and the value-added tax payment each in the year it was paid.
    expect([await expense(ws, 2025), await expense(ws, 2026)]).toEqual([65_000, 19_000]);

    // Resume: a reload works out the same answers, and nothing but the filing day and the person's answer is stored.
    const before = (await loadStatement(db, ws.workspaceId, 2025)).yearBoundary;
    expect((await loadStatement(db, ws.workspaceId, 2025)).yearBoundary).toEqual(before);
    expect(await db.taxYearBoundaryAnswer.count({ where: { authWorkspaceId: ws.workspaceId } })).toBe(1);

    await saveFiledOn(db, ctx, { year: 2025, filedOn: null });
    expect(await entryOf(ws, 2025, rowId)).toMatchObject({ answer: true, source: 'person', filedYear: null, departsFromFiled: null });
    expect(await entryOf(ws, 2025, settlement)).toMatchObject({ answer: true, source: 'rule', filedYear: null });
    // The rent moves to 2026 by the answer, the value-added tax payment to 2025 by the rule.
    expect([await expense(ws, 2025), await expense(ws, 2026)]).toEqual([19_000, 65_000]);
    expect((await loadStatement(db, ws.workspaceId, 2025)).vat.settlements).toEqual([{ id: settlement, date: '2026-01-08', cents: 19_000, direction: 'paid', countsOn: '2025-12-31' }]);
  });

  it('an answer saved up to the filing day was filed that way and still applies', async () => {
    const { ws, ctx } = await workspace();
    const rowId = await ws.addReceipt(rent());
    await saveYearBoundaryAnswer(db, ctx, { kind: 'receipt', subjectId: rowId, cashDay: '2025-12-29', belongsToOtherYear: true });
    await backdate(ws, rowId, '2026-10-17');
    await saveFiledOn(db, ctx, { year: 2025, filedOn: '2026-10-17' });
    expect(await entryOf(ws, 2026, rowId)).toMatchObject({
      answer: true,
      source: 'person',
      filedYear: 2025,
      reason: 'Antwort von Hand, vor der Abgabe der Erklärung 2025 gegeben und so erklärt',
    });
    expect([await expense(ws, 2025), await expense(ws, 2026)]).toEqual([0, 65_000]);
    // Moved back to the first filing day it still counts as filed with the return; one day later it departs.
    await saveFiledOn(db, ctx, { year: 2025, filedOn: '2026-10-16' });
    expect(await entryOf(ws, 2026, rowId)).toMatchObject({ answer: false, departsFromFiled: 2025 });
    expect([await expense(ws, 2025), await expense(ws, 2026)]).toEqual([65_000, 0]);
  });

  it('an answer that went into the return can neither be changed nor taken back while the year is filed; saving it again changes nothing', async () => {
    const { ws, ctx } = await workspace();
    const rowId = await ws.addReceipt(rent());
    await saveYearBoundaryAnswer(db, ctx, { kind: 'receipt', subjectId: rowId, cashDay: '2025-12-29', belongsToOtherYear: true });
    await backdate(ws, rowId, '2026-10-01');
    await saveFiledOn(db, ctx, { year: 2025, filedOn: '2026-10-17' });
    expect([await expense(ws, 2025), await expense(ws, 2026)]).toEqual([0, 65_000]);
    expect(await code(saveYearBoundaryAnswer(db, ctx, { kind: 'receipt', subjectId: rowId, cashDay: '', belongsToOtherYear: null }))).toBe('year_boundary_filed');
    expect(await code(saveYearBoundaryAnswer(db, ctx, { kind: 'receipt', subjectId: rowId, cashDay: '2025-12-29', belongsToOtherYear: false }))).toBe('year_boundary_filed');
    // Re-entry: the same answer again is a no-op and keeps the day it was given.
    await saveYearBoundaryAnswer(db, ctx, { kind: 'receipt', subjectId: rowId, cashDay: '2025-12-29', belongsToOtherYear: true });
    expect(await entryOf(ws, 2026, rowId)).toMatchObject({ answer: true, source: 'person', filedYear: 2025, departsFromFiled: null });
    expect([await expense(ws, 2025), await expense(ws, 2026)]).toEqual([0, 65_000]);
    // Opening the year again lets it be changed.
    await saveFiledOn(db, ctx, { year: 2025, filedOn: null });
    await saveYearBoundaryAnswer(db, ctx, { kind: 'receipt', subjectId: rowId, cashDay: '', belongsToOtherYear: null });
    expect(await entryOf(ws, 2026, rowId)).toMatchObject({ source: 'rule', storedAnswer: null });
  });

  it('a "stays" answer given after the filing day agrees with the return: kept as a person\'s answer after a reload', async () => {
    const { ws, ctx } = await workspace();
    const rowId = await ws.addReceipt(rent());
    await saveFiledOn(db, ctx, { year: 2025, filedOn: '2026-10-17' });
    await saveYearBoundaryAnswer(db, ctx, { kind: 'receipt', subjectId: rowId, cashDay: '2025-12-29', belongsToOtherYear: false });
    const first = await entryOf(ws, 2025, rowId);
    expect(first).toMatchObject({ answer: false, source: 'person', storedAnswer: false, filedYear: 2025, departsFromFiled: null });
    expect(await entryOf(ws, 2025, rowId)).toEqual(first);
    // Given after the filing day, it is not part of the return and may go again.
    await saveYearBoundaryAnswer(db, ctx, { kind: 'receipt', subjectId: rowId, cashDay: '', belongsToOtherYear: null });
    expect(await entryOf(ws, 2025, rowId)).toMatchObject({ source: 'filed', storedAnswer: null });
  });

  it('a receipt relinked to another payment day in a filed year is fixed by the filed year, and its old answer may go', async () => {
    const { ws, ctx } = await workspace();
    const rowId = await ws.addReceipt(rent({ Date: '2025-12-15' }));
    const accountId = await createAccount(db, ctx, { label: 'Geschäftskonto', kind: 'bank' });
    await importPayments(db, ctx, accountId, bankFile(['2025-12-30', '-650'], ['2026-01-03', '-650']));
    const [first, second] = await db.taxPayment.findMany({ where: { accountId }, orderBy: { bookingDay: 'asc' } });
    const check = receiptForLink(db, ctx.workspaceId);
    const { linkId } = await linkPayment(db, ctx, { paymentId: first.id, rowId }, check);
    await saveYearBoundaryAnswer(db, ctx, { kind: 'receipt', subjectId: rowId, cashDay: '2025-12-30', belongsToOtherYear: true });
    await backdate(ws, rowId, '2026-10-01');
    await saveFiledOn(db, ctx, { year: 2025, filedOn: '2026-10-17' });
    await unlinkPayment(db, ctx, linkId);
    await linkPayment(db, ctx, { paymentId: second.id, rowId }, check);
    expect(await entryOf(ws, 2026, rowId)).toMatchObject({ cashDay: '2026-01-03', answer: false, source: 'filed', storedAnswer: null });
    expect([await expense(ws, 2025), await expense(ws, 2026)]).toEqual([0, 65_000]);
    // The old answer was for another day: it has no effect, so it may be taken back.
    await saveYearBoundaryAnswer(db, ctx, { kind: 'receipt', subjectId: rowId, cashDay: '', belongsToOtherYear: null });
    expect(await db.taxYearBoundaryAnswer.count({ where: { authWorkspaceId: ws.workspaceId } })).toBe(0);
  });

  it('both years filed: the payment stays; an answer saved between the two filing days departs from the earlier return', async () => {
    const { ws, ctx } = await workspace();
    const rowId = await ws.addReceipt(rent({ Date: '2025-01-04' }));
    await saveYearBoundaryAnswer(db, ctx, { kind: 'receipt', subjectId: rowId, cashDay: '2025-01-04', belongsToOtherYear: true });
    await backdate(ws, rowId, '2026-10-14');
    await saveFiledOn(db, ctx, { year: 2024, filedOn: '2026-10-11' });
    await saveFiledOn(db, ctx, { year: 2025, filedOn: '2026-10-17' });
    expect(await entryOf(ws, 2025, rowId)).toMatchObject({ answer: false, source: 'filed', filedYear: 2025, departsFromFiled: 2024, reason: 'Weicht von der abgegebenen Erklärung 2024 ab' });
    expect([await expense(ws, 2024), await expense(ws, 2025)]).toEqual([0, 65_000]);
    // Saved before both filing days, it went into both returns and applies.
    await backdate(ws, rowId, '2026-10-01');
    expect(await entryOf(ws, 2025, rowId)).toMatchObject({ answer: true, source: 'person', filedYear: 2025, departsFromFiled: null });
    expect([await expense(ws, 2024), await expense(ws, 2025)]).toEqual([65_000, 0]);
  });

  it('a meal or an asset in a filed year keeps its earlier answer shown, not applied, and it can still be taken back', async () => {
    const { ws, ctx } = await workspace();
    const camera = await ws.addReceipt(rent({ Name: 'Kamera', Vendor: 'Foto Beispiel', Gross: 1500, Category: 'Hardware & IT' }));
    await saveYearBoundaryAnswer(db, ctx, { kind: 'receipt', subjectId: camera, cashDay: '2025-12-29', belongsToOtherYear: true });
    await backdate(ws, camera, '2026-10-01');
    await createAsset(db, ctx, { label: 'Kamera', kind: 'movable', acquisitionDate: '2025-12-29', method: 'linear', usefulLifeMonths: 84, itemIds: [camera] });
    await saveFiledOn(db, ctx, { year: 2025, filedOn: '2026-10-17' });
    expect(await entryOf(ws, 2025, camera)).toMatchObject({ answer: true, inactive: 'asset', filedYear: null });
    expect((await loadStatement(db, ws.workspaceId, 2025)).assets[0]).toMatchObject({ counted: true, costCents: 150_000 });
    await saveYearBoundaryAnswer(db, ctx, { kind: 'receipt', subjectId: camera, cashDay: '', belongsToOtherYear: null });
    expect(await db.taxYearBoundaryAnswer.count({ where: { authWorkspaceId: ws.workspaceId } })).toBe(0);
  });

  it("another company's filing day does not fix this company's turn", async () => {
    const { ws, ctx } = await workspace();
    const rowId = await ws.addReceipt(rent());
    await saveFiledOn(db, otherCtx, { year: 2025, filedOn: '2026-10-17' });
    expect(await entryOf(ws, 2025, rowId)).toMatchObject({ source: 'rule', filedYear: null });
    await saveYearBoundaryAnswer(db, ctx, { kind: 'receipt', subjectId: rowId, cashDay: '2025-12-29', belongsToOtherYear: true });
    expect([await expense(ws, 2025), await expense(ws, 2026)]).toEqual([0, 65_000]);
    await saveFiledOn(db, otherCtx, { year: 2025, filedOn: null });
  });

  it('the filing day is a real day after the year ended and not in the future, and leaves the church months alone', async () => {
    const { ws, ctx } = await workspace();
    expect(await code(saveFiledOn(db, ctx, { year: 2025, filedOn: '2025-12-31' }))).toBe('filed_on_before_year_end');
    expect(await code(saveFiledOn(db, ctx, { year: 2025, filedOn: '2026-02-30' }))).toBe('invalid_filed_on');
    expect(await code(saveFiledOn(db, ctx, { year: 2025, filedOn: '2026-10-18' }, '2026-10-17'))).toBe('filed_on_in_future');
    expect(await db.taxYearSettings.count({ where: { authWorkspaceId: ws.workspaceId } })).toBe(0);
    const months = Array.from({ length: 12 }, (_, i) => i < 6);
    await saveChurchMonths(db, ctx, { year: 2025, churchMonths: months });
    await saveFiledOn(db, ctx, { year: 2025, filedOn: '2026-10-17' });
    await saveChurchMonths(db, ctx, { year: 2025, churchMonths: months.map((m) => !m) });
    const view = await loadStatement(db, ws.workspaceId, 2025);
    expect(view.incomeTax.filedOn).toBe('2026-10-17');
    expect(view.incomeTax.churchMonths).toEqual(months.map((m) => !m));
    // Another company's filing is not this one's.
    expect((await loadStatement(db, other.workspaceId, 2025)).incomeTax.filedOn).toBeNull();
  });
});
