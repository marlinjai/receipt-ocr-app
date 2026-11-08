import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CellValue } from '@marlinjai/data-table-core';
import { saveTaxSettings } from '@/lib/meals/service';
import { listRules, saveSubjectStatement } from '@/lib/classification-rules-store';
import { loadSpending } from '@/lib/spending/service';
import { loadStatement, receiptForLink } from '@/lib/tax/service';
import type { DecidedVerdict, ModelCounterparty } from '@/lib/tax/payments/classify';
import { classifyCounterparties } from '@/lib/tax/payments/classify-service';
import type { CounterpartyClassifierPort } from '@/lib/tax/payments/counterparty-classifier';
import { createAccount, importPayments, linkPayment, loadPayments, setCounterpartyTreatment } from '@/lib/tax/payments/service';
import type { AssignmentAnswer } from '@/lib/receipt-classifier';
import { createWorkspace, db, type TestWorkspace } from '../../../../test/db-helpers';
import { NO_LINES_NOTE, decideAssignments, decideVendorAfterStatement, type AssignmentDeps } from '../pass';
import type { AssignmentContext, AssignmentReceipt } from '../prompt';

/**
 * "Was ist das?" and "Teils, teils" per payment against a real database (plan
 * docs/plans/2026-11-07-learned-assignment.md, decision 8), through the four
 * paths: forward (an answer saved reaches both models, a mixed payment follows
 * its receipt), backtrack (an edited answer replaces, an emptied one removes,
 * a person's treatment and cell never change), resume (a classifier failure
 * keeps the old verdict) and re-entry (the same answer twice is one statement,
 * deciding again changes nothing decided). Every model is a fake; every name
 * and amount is invented. Run with `pnpm test:db`.
 */

let ws: TestWorkspace;
let ctx: { workspaceId: string; tenantId: string | null };

const decide = vi.fn<(receipt: AssignmentReceipt, context: AssignmentContext, options: readonly string[]) => Promise<AssignmentAnswer>>();
const deps: AssignmentDeps = { decide };
const answer = (assignment: string | null, confidence: number, reason = 'Begründung.'): AssignmentAnswer => ({ assignment, confidence, reason, model: 'test/m', usage: { inputTokens: 1, outputTokens: 1, cost: null } });

const HEADER = '"Booking Date","Value Date","Partner Name","Partner Iban",Type,"Payment Reference","Account Name","Amount (EUR)","Original Amount","Original Currency","Exchange Rate"';
const line = (day: string, partner: string, reference: string, amount: string) => `${day},${day},"${partner}",,Presentment,"${reference}",Hauptkonto,${amount},,,`;

function fakeModel(answers: Record<string, DecidedVerdict>, options: { fail?: boolean } = {}) {
  const asked: ModelCounterparty[][] = [];
  const port: CounterpartyClassifierPort = {
    model: 'fake-model',
    async classify(counterparties) {
      asked.push([...counterparties]);
      if (options.fail) throw new Error('the model is down');
      return new Map(counterparties.flatMap((c) => (answers[c.name] ? [[c.key, answers[c.name]] as const] : [])));
    },
  };
  return { port, asked };
}

const receipt = (cells: Record<string, CellValue>) => ws.addReceipt({ Name: 'Beleg', Gross: 30, Date: '2026-10-02', Category: 'Sonstige Ausgaben', Currency: 'EUR', 'FX Rate': 1, 'OCR Text': 'Text', ...cells });
const assignmentOf = async (rowId: string) => {
  const columns = await ws.adapter.getColumns(ws.tableId);
  const col = columns.find((c) => c.name === 'Zuordnung')!;
  const id = (await ws.adapter.getRow(rowId))!.cells[col.id];
  return typeof id === 'string' && id ? ((await ws.adapter.getSelectOptions(col.id)).find((o) => o.id === id)?.name ?? null) : null;
};

beforeEach(async () => {
  ws = await createWorkspace();
  ctx = { workspaceId: ws.workspaceId, tenantId: ws.tenantId };
  await saveTaxSettings(db, ctx, { smallBusiness: true });
  decide.mockReset();
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterAll(async () => {
  vi.restoreAllMocks();
  await db.$disconnect();
});

describe('the answer is one statement per vendor', () => {
  it('saved, replaced, saved again unchanged as one row, and removed when emptied', async () => {
    await saveSubjectStatement(db, ctx, { name: 'flaschenpost SE', answer: 'Getränkelieferdienst' });
    await saveSubjectStatement(db, ctx, { name: 'Flaschenpost SE', answer: 'Getränkelieferdienst, Wasser' });
    await saveSubjectStatement(db, ctx, { name: 'Flaschenpost SE', answer: 'Getränkelieferdienst, Wasser' });
    const rules = await listRules(db, ctx.workspaceId);
    expect(rules).toEqual([expect.objectContaining({ type: 'freetext', subject: 'flaschenpostse', label: 'Getränkelieferdienst, Wasser', matchValue: 'Flaschenpost SE: Getränkelieferdienst, Wasser', zuordnung: null })]);
    expect(await saveSubjectStatement(db, ctx, { name: 'flaschenpost SE', answer: '  ' })).toBeNull();
    expect(await listRules(db, ctx.workspaceId)).toEqual([]);
  });

  it('refuses a vendor without a name and an answer that is too long', async () => {
    await expect(saveSubjectStatement(db, ctx, { name: ' ', answer: 'x' })).rejects.toThrow();
    await expect(saveSubjectStatement(db, ctx, { name: 'eBay', answer: 'x'.repeat(121) })).rejects.toThrow();
  });
});

describe('the receipt assignment and the answer', () => {
  it('the vendor\'s open receipts are decided again with it; set and answered ones are left as they are', async () => {
    const open = await receipt({ Vendor: 'Flaschenpost' });
    const answered = await receipt({ Vendor: 'Flaschenpost', Zuordnung: 'Geschäftlich', Date: '2026-09-01' });
    const other = await receipt({ Vendor: 'Rossmann' });
    decide.mockResolvedValue(answer(null, 0));
    await decideAssignments(db, ctx, deps, { limit: 10 });
    decide.mockClear();

    await saveSubjectStatement(db, ctx, { name: 'flaschenpost SE', answer: 'Getränkelieferdienst, Wasser' });
    decide.mockResolvedValue(answer('Privat', 0.97, 'Wasser für den Haushalt.'));
    await decideVendorAfterStatement(db, ctx, 'flaschenpost SE', deps);
    expect(decide).toHaveBeenCalledTimes(1);
    const [seen, context] = decide.mock.calls[0];
    expect(seen.vendor).toBe('Flaschenpost');
    expect(context.statements.map((s) => s.text)).toEqual(['flaschenpost SE: Getränkelieferdienst, Wasser']);
    expect(await assignmentOf(open)).toBe('Privat');
    expect(await assignmentOf(answered)).toBe('Geschäftlich');
    expect(await assignmentOf(other)).toBeNull();

    // Re-entry: nothing open is left for the vendor, so nothing is asked.
    decide.mockClear();
    expect(await decideVendorAfterStatement(db, ctx, 'flaschenpost SE', deps)).toBeNull();
    expect(decide).not.toHaveBeenCalled();
  });

  it('where no positions were read, the reason says so; with positions it does not', async () => {
    const bare = await receipt({ Vendor: 'eBay', Date: '2026-10-01' });
    const withLines = await receipt({ Vendor: 'eBay', Date: '2026-10-02' });
    await db.receiptItem.create({ data: { authWorkspaceId: ctx.workspaceId, rowId: withLines, position: 0, text: 'USB-Kabel', grossCents: 3000, kind: 'electronics' } });
    decide.mockResolvedValue(answer('Geschäftlich', 0.5, 'Technik.'));
    await decideAssignments(db, ctx, deps, { limit: 10 });
    expect((await db.receiptAssignmentDecision.findUnique({ where: { rowId: bare } }))!.reason).toBe(`${NO_LINES_NOTE} Technik.`);
    expect((await db.receiptAssignmentDecision.findUnique({ where: { rowId: withLines } }))!.reason).toBe('Technik.');
  });
});

async function payments(lines: string[]) {
  const accountId = await createAccount(db, ctx, { label: 'Girokonto', kind: 'bank' });
  await importPayments(db, ctx, accountId, [HEADER, ...lines].join('\n') + '\n');
  return new Map((await loadPayments(db, ctx.workspaceId)).payments.map((p) => [`${p.counterparty}|${p.bookingDay}`, p.id]));
}

describe('the counterparty classifier and the answer', () => {
  it('the model is given the answer and says what it takes the counterparty to be; a new answer decides it again', async () => {
    await payments([line('2026-10-03', 'Getränke Beispiel GmbH', 'Bestellung', '-30')]);
    const first = fakeModel({ 'Getränke Beispiel GmbH': { treatment: 'business', category: null, confidence: 'unsure', reason: 'Unklar.', what: 'Lieferdienst' } });
    await classifyCounterparties(db, ctx, first.port);
    expect(first.asked[0][0].personSays).toBeNull();
    expect((await loadStatement(db, ctx.workspaceId, 2026)).payments.unclassified[0].proposal).toMatchObject({ what: 'Lieferdienst' });

    await saveSubjectStatement(db, ctx, { name: 'Getränke Beispiel GmbH', answer: 'Getränkelieferdienst, Wasser' });
    const second = fakeModel({ 'Getränke Beispiel GmbH': { treatment: 'private', category: 'groceries_drugstore', confidence: 'certain', reason: 'Wasser für zu Hause.', what: 'Getränkelieferdienst' } });
    await classifyCounterparties(db, ctx, second.port, { only: [(await loadPayments(db, ctx.workspaceId)).payments[0].counterpartyKey] });
    expect(second.asked[0][0].personSays).toBe('Getränkelieferdienst, Wasser');
    const view = (await loadStatement(db, ctx.workspaceId, 2026)).payments;
    expect(view.appTreatments).toEqual([expect.objectContaining({ label: 'Getränke Beispiel GmbH', treatment: 'private', what: 'Getränkelieferdienst', personWhat: 'Getränkelieferdienst, Wasser' })]);
  });

  it('a counterparty a person answered keeps its treatment: an answer about it decides nothing anew', async () => {
    await payments([line('2026-10-03', 'flaschenpost SE', 'Bestellung', '-30')]);
    await setCounterpartyTreatment(db, ctx, { counterparty: 'flaschenpost SE', treatment: 'private' });
    await saveSubjectStatement(db, ctx, { name: 'flaschenpost SE', answer: 'Getränkelieferdienst, Wasser' });
    const model = fakeModel({ 'flaschenpost SE': { treatment: 'business', category: null, confidence: 'certain', reason: 'x', what: 'x' } });
    await classifyCounterparties(db, ctx, model.port);
    expect(model.asked).toEqual([]);
    const view = (await loadStatement(db, ctx.workspaceId, 2026)).payments;
    expect(view.treatments).toEqual([expect.objectContaining({ label: 'flaschenpost SE', treatment: 'private' })]);
  });

  it('resume: a failing classifier keeps the verdict there was', async () => {
    await payments([line('2026-10-03', 'Getränke Beispiel GmbH', 'Bestellung', '-30')]);
    await classifyCounterparties(db, ctx, fakeModel({ 'Getränke Beispiel GmbH': { treatment: 'private', category: null, confidence: 'likely', reason: 'Lieferdienst.', what: 'Lieferdienst' } }).port);
    await saveSubjectStatement(db, ctx, { name: 'Getränke Beispiel GmbH', answer: 'Wasser' });
    const run = await classifyCounterparties(db, ctx, fakeModel({}, { fail: true }).port);
    expect(run.failedBatches).toBe(1);
    expect((await loadStatement(db, ctx.workspaceId, 2026)).payments.unclassified[0].proposal).toMatchObject({ treatment: 'private', what: 'Lieferdienst' });
  });
});

describe('"Teils, teils": each payment is decided by its receipt', () => {
  it('a payment without a receipt is a question, grouped under its counterparty; one with a receipt follows it', async () => {
    const ids = await payments([line('2026-10-03', 'eBay S.a.r.l.', 'Kauf 1', '-40'), line('2026-10-04', 'eBay S.a.r.l.', 'Kauf 2', '-25'), line('2026-10-05', 'eBay S.a.r.l.', 'Kauf 3', '-10')]);
    await setCounterpartyTreatment(db, ctx, { counterparty: 'eBay S.a.r.l.', treatment: 'mixed' });
    const privateReceipt = await receipt({ Vendor: 'eBay', Gross: 40, Zuordnung: 'Privat', Date: '2026-10-03' });
    const businessReceipt = await receipt({ Vendor: 'eBay', Gross: 25, Zuordnung: 'Geschäftlich', Date: '2026-10-04' });
    await linkPayment(db, ctx, { paymentId: ids.get('eBay S.a.r.l.|2026-10-03'), rowId: privateReceipt }, receiptForLink(db, ctx.workspaceId));
    await linkPayment(db, ctx, { paymentId: ids.get('eBay S.a.r.l.|2026-10-04'), rowId: businessReceipt }, receiptForLink(db, ctx.workspaceId));

    const view = (await loadStatement(db, ctx.workspaceId, 2026)).payments;
    expect(view.mixedOpen).toEqual([expect.objectContaining({ label: 'eBay', count: 1, outCents: 1000 })]);

    const spending = await loadSpending(db, ctx.workspaceId, 2026, null);
    // 40 private by its receipt, 25 business by its receipt, 10 without a receipt still a question.
    expect(spending.overview.split).toEqual({ private: 4000, business: 2500, unanswered: 1000 });
  });

  it('in a filed year nothing is asked', async () => {
    await payments([line('2026-10-03', 'eBay S.a.r.l.', 'Kauf', '-40')]);
    await setCounterpartyTreatment(db, ctx, { counterparty: 'eBay S.a.r.l.', treatment: 'mixed' });
    await db.taxYearSettings.upsert({ where: { authWorkspaceId_year: { authWorkspaceId: ctx.workspaceId, year: 2026 } }, create: { authWorkspaceId: ctx.workspaceId, year: 2026, filedOn: '2027-03-01' }, update: { filedOn: '2027-03-01' } });
    expect((await loadStatement(db, ctx.workspaceId, 2026)).payments.mixedOpen).toEqual([]);
  });
});
