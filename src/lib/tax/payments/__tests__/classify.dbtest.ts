import { afterAll, describe, expect, it } from 'vitest';
import { saveTaxSettings } from '@/lib/meals/service';
import { runSpendingChecks } from '@/lib/spending/checks';
import { loadSpending, saveOwnNames } from '@/lib/spending/service';
import { loadStatement, receiptForLink } from '../../service';
import type { DecidedVerdict, ModelCounterparty } from '../classify';
import { classifyCounterparties } from '../classify-service';
import type { CounterpartyClassifierPort } from '../counterparty-classifier';
import { createAccount, importPayments, linkPayment, loadPayments, setCounterpartyTreatment } from '../service';
import { createWorkspace, db, type TestWorkspace } from '../../../../../test/db-helpers';

/**
 * The app classifying counterparties against a real database (migration
 * 0039), through the four paths: forward, backtrack and revise, resume from
 * what is stored, and re-entry. The model is a fake that records what it was
 * asked; no test calls a real one. Run with `pnpm test:db`. Every name and
 * amount is invented.
 */

const HEADER = '"Booking Date","Value Date","Partner Name","Partner Iban",Type,"Payment Reference","Account Name","Amount (EUR)","Original Amount","Original Currency","Exchange Rate"';
const line = (day: string, partner: string, reference: string, amount: string, type = 'Presentment') => `${day},${day},"${partner}",,${type},"${reference}",Hauptkonto,${amount},,,`;
const file = (...lines: string[]) => [HEADER, ...lines].join('\n') + '\n';

const LINES = [
  line('2026-09-03', 'Werkzeug Abo Beispiel GmbH', 'Abo September', '-20'),
  line('2026-10-03', 'Werkzeug Abo Beispiel GmbH', 'Abo Oktober', '-20'),
  line('2026-10-05', 'Laden Beispiel', 'Einkauf', '-45'),
  line('2026-10-06', 'Vermieter Beispiel', 'Miete Buero Oktober', '-650', 'Debit Transfer'),
  line('2026-10-07', 'Erika Beispiel', 'Umbuchung', '-300', 'Debit Transfer'),
];

/** The fake model: answers from a table, records every batch, or fails when told to. */
function fakeModel(answers: Record<string, DecidedVerdict>, options: { fail?: boolean } = {}) {
  const asked: string[][] = [];
  const port: CounterpartyClassifierPort = {
    model: 'fake-model',
    async classify(counterparties: readonly ModelCounterparty[]) {
      asked.push(counterparties.map((c) => c.name));
      if (options.fail) throw new Error('the model is down');
      return new Map(counterparties.flatMap((c) => (answers[c.name] ? [[c.key, answers[c.name]] as const] : [])));
    },
  };
  return { port, asked };
}

const ANSWERS: Record<string, DecidedVerdict> = {
  'Werkzeug Abo Beispiel GmbH': { treatment: 'business', category: 'software_ai_hosting', confidence: 'certain', reason: 'Software-Abo für die Arbeit' },
  'Laden Beispiel': { treatment: 'private', category: 'shopping_household', confidence: 'likely', reason: 'Kleiner Laden, wohl Einkauf für zu Hause' },
};

async function setup(): Promise<{ ws: TestWorkspace; ctx: { workspaceId: string; tenantId: string | null }; ids: Map<string, string> }> {
  const ws = await createWorkspace();
  const ctx = { workspaceId: ws.workspaceId, tenantId: ws.tenantId };
  await saveTaxSettings(db, ctx, { smallBusiness: true });
  const accountId = await createAccount(db, ctx, { label: 'Girokonto', kind: 'bank' });
  await importPayments(db, ctx, accountId, file(...LINES));
  await saveOwnNames(db, ctx, { add: 'Erika Beispiel' });
  // The office rent is linked to a business receipt: the company's own data decides it.
  const rent = await ws.addReceipt({ Name: 'Miete Büro Oktober', Vendor: 'Vermieter Beispiel', Gross: 650, Date: '2026-10-01', Category: 'Miete & Nebenkosten', Zuordnung: 'Geschäftlich', Currency: 'EUR', 'FX Rate': 1 });
  const { payments } = await loadPayments(db, ctx.workspaceId);
  const ids = new Map(payments.map((p) => [p.counterparty, p.id]));
  await linkPayment(db, ctx, { paymentId: ids.get('Vermieter Beispiel'), rowId: rent }, receiptForLink(db, ctx.workspaceId));
  return { ws, ctx, ids };
}

const paymentsView = async (workspaceId: string) => (await loadStatement(db, workspaceId, 2026)).payments;
const appList = async (workspaceId: string) => (await paymentsView(workspaceId)).appTreatments.map((t) => [t.label, t.treatment, t.source]);

afterAll(async () => {
  await db.$disconnect();
});

describe('the app classifies counterparties: forward', () => {
  it('own data and own names decide without the model; the model gets the rest; only certain verdicts count', async () => {
    const { ctx } = await setup();
    const model = fakeModel(ANSWERS);
    const run = await classifyCounterparties(db, ctx, model.port);
    // One batch, largest sums first; neither the rent (own data) nor the own name went to the model.
    expect(model.asked).toEqual([['Laden Beispiel', 'Werkzeug Abo Beispiel GmbH']]);
    expect(run).toEqual({ pending: 3, byEvidence: 1, byModel: 2, applied: 2, unavailable: false, failedBatches: 0 });

    const view = await paymentsView(ctx.workspaceId);
    expect(await appList(ctx.workspaceId)).toEqual([
      ['Erika Beispiel', 'own_account', 'own_name'],
      ['Vermieter Beispiel', 'business', 'app'],
      ['Werkzeug Abo Beispiel GmbH', 'business', 'app'],
    ]);
    expect(view.appTreatments.find((t) => t.label === 'Vermieter Beispiel')?.reason).toBe('Alle 1 zugeordneten Belege sind betrieblich.');
    // The likely one is still a question, with the proposal next to it; nobody answered anything.
    expect(view.unclassified.map((c) => [c.label, c.proposal?.treatment, c.proposal?.confidence])).toEqual([['Laden Beispiel', 'private', 'likely']]);
    expect(view.treatments).toEqual([]);
    // A business payment without a receipt now asks for one.
    expect(view.open.map((o) => o.counterparty)).toContain('Werkzeug Abo Beispiel GmbH');
    // The transfer to oneself is no payment of its own any more under Finanzen either.
    expect((await loadPayments(db, ctx.workspaceId)).payments.find((p) => p.counterparty === 'Erika Beispiel')?.kind).toBe('own_transfer');

    // The spending side uses the same answers and the app's category.
    const spending = await loadSpending(db, ctx.workspaceId, 2026, null);
    const tool = spending.overview.payments.find((p) => p.counterparty === 'Werkzeug Abo Beispiel GmbH');
    expect(tool).toMatchObject({ category: 'software_ai_hosting', basis: 'app', purpose: 'business' });
    expect(spending.overview.payments.find((p) => p.counterparty === 'Laden Beispiel')).toMatchObject({ purpose: 'unanswered' });
  });

  it('without a model only the own data decides, and the run says so', async () => {
    const { ctx } = await setup();
    expect(await classifyCounterparties(db, ctx, null)).toEqual({ pending: 3, byEvidence: 1, byModel: 0, applied: 1, unavailable: true, failedBatches: 0 });
    expect((await paymentsView(ctx.workspaceId)).unclassified.map((c) => [c.label, c.proposal])).toEqual([
      ['Laden Beispiel', null],
      ['Werkzeug Abo Beispiel GmbH', null],
    ]);
  });
});

describe('the app classifies counterparties: change, resume, re-entry', () => {
  it("a person's answer overrides a verdict, and taking it back returns the verdict", async () => {
    const { ctx } = await setup();
    await classifyCounterparties(db, ctx, fakeModel(ANSWERS).port);
    await setCounterpartyTreatment(db, ctx, { counterparty: 'Werkzeug Abo Beispiel GmbH', treatment: 'mixed' });
    let view = await paymentsView(ctx.workspaceId);
    expect(view.treatments.map((t) => [t.label, t.treatment])).toEqual([['Werkzeug Abo Beispiel GmbH', 'mixed']]);
    expect(view.appTreatments.map((t) => t.label)).not.toContain('Werkzeug Abo Beispiel GmbH');
    // Taking over the proposal is a person's answer like any other.
    await setCounterpartyTreatment(db, ctx, { counterparty: 'Laden Beispiel', treatment: 'private' });
    expect((await paymentsView(ctx.workspaceId)).unclassified).toEqual([]);

    await setCounterpartyTreatment(db, ctx, { counterparty: 'Werkzeug Abo Beispiel GmbH', treatment: null });
    view = await paymentsView(ctx.workspaceId);
    expect(view.appTreatments.find((t) => t.label === 'Werkzeug Abo Beispiel GmbH')).toMatchObject({ treatment: 'business', source: 'app' });
    // A person's answer is never written by the app, and the app's verdict was never removed.
    expect(await db.taxCounterpartyRule.count({ where: { authWorkspaceId: ctx.workspaceId } })).toBe(1);
  });

  it('resume and re-entry: a reload reads the same, a second run asks nothing, new evidence asks once', async () => {
    const { ws, ctx, ids } = await setup();
    const model = fakeModel(ANSWERS);
    await classifyCounterparties(db, ctx, model.port);
    const before = await paymentsView(ctx.workspaceId);
    expect(await paymentsView(ctx.workspaceId)).toEqual(before);
    // Re-entry: nothing is asked again, also not the unsure or likely ones.
    expect(await classifyCounterparties(db, ctx, model.port)).toMatchObject({ pending: 0, byModel: 0 });
    expect(model.asked).toHaveLength(1);

    // New evidence: a private receipt linked to the shop decides it from the company's own data, without the model.
    const shopping = await ws.addReceipt({ Name: 'Einkauf', Vendor: 'Laden Beispiel', Gross: 45, Date: '2026-10-05', Category: 'Bürobedarf', Zuordnung: 'Privat', Currency: 'EUR', 'FX Rate': 1 });
    await linkPayment(db, ctx, { paymentId: ids.get('Laden Beispiel'), rowId: shopping }, receiptForLink(db, ctx.workspaceId));
    expect(await classifyCounterparties(db, ctx, model.port)).toMatchObject({ pending: 1, byEvidence: 1, byModel: 0 });
    expect(model.asked).toHaveLength(1);
    expect((await paymentsView(ctx.workspaceId)).appTreatments.find((t) => t.label === 'Laden Beispiel')).toMatchObject({ treatment: 'private', source: 'app' });
  });

  it('removing the own name hands the counterparty to the app on the next run', async () => {
    const { ctx } = await setup();
    const model = fakeModel({ ...ANSWERS, 'Erika Beispiel': { treatment: 'private', category: 'transfers', confidence: 'likely', reason: 'Überweisung an eine Person' } });
    await classifyCounterparties(db, ctx, model.port);
    await saveOwnNames(db, ctx, { remove: 'Erika Beispiel' });
    expect((await paymentsView(ctx.workspaceId)).appTreatments.map((t) => t.label)).not.toContain('Erika Beispiel');
    await classifyCounterparties(db, ctx, model.port);
    expect(model.asked.at(-1)).toEqual(['Erika Beispiel']);
    expect((await paymentsView(ctx.workspaceId)).unclassified.find((c) => c.label === 'Erika Beispiel')?.proposal).toMatchObject({ treatment: 'private' });
  });
});

describe('the app classifies counterparties: failures and isolation', () => {
  it('a failing model leaves the counterparties open and stores nothing; the other checks still run', async () => {
    const { ctx } = await setup();
    const model = fakeModel(ANSWERS, { fail: true });
    expect(await classifyCounterparties(db, ctx, model.port)).toMatchObject({ byEvidence: 1, byModel: 0, failedBatches: 1 });
    expect(await db.taxCounterpartyVerdict.count({ where: { authWorkspaceId: ctx.workspaceId, source: 'model' } })).toBe(0);
    const checks = await runSpendingChecks(db, ctx, { today: '2026-10-23', channels: [], classifier: model.port });
    expect(checks.classify).toMatchObject({ failedBatches: 1 });
    expect(checks.loop).not.toBeNull();
    // Asked again on the next run, as nothing was stored.
    await classifyCounterparties(db, ctx, fakeModel(ANSWERS).port);
    expect((await paymentsView(ctx.workspaceId)).appTreatments.map((t) => t.label)).toContain('Werkzeug Abo Beispiel GmbH');
  });

  it("another company's verdicts never apply here", async () => {
    const mine = await setup();
    const theirs = await setup();
    await classifyCounterparties(db, theirs.ctx, fakeModel(ANSWERS).port);
    expect((await paymentsView(mine.ctx.workspaceId)).appTreatments.map((t) => t.label)).toEqual(['Erika Beispiel']);
    expect(await db.taxCounterpartyVerdict.count({ where: { authWorkspaceId: mine.ctx.workspaceId } })).toBe(0);
  });
});
