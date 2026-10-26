import { afterAll, describe, expect, it } from 'vitest';
import { saveTaxSettings } from '@/lib/meals/service';
import { runSpendingChecks } from '@/lib/spending/checks';
import { loadSpending, saveOwnNames } from '@/lib/spending/service';
import { loadStatement, receiptForLink } from '../../service';
import type { DecidedVerdict, ModelCounterparty } from '../classify';
import { classifyCounterparties } from '../classify-service';
import type { CounterpartyClassifierPort } from '../counterparty-classifier';
import { loadRoutedPayments, shareAccount } from '../routing';
import { markCounterpartyOwnAccount, unmarkCounterpartyOwnAccount, SpendingServiceError } from '@/lib/spending/service';
import { createAccount, importPayments, linkPayment, loadPayments, setAccountPrivate, setCounterpartyTreatment } from '../service';
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
function fakeModel(answers: Record<string, DecidedVerdict>, options: { fail?: boolean; failFor?: string } = {}) {
  const asked: string[][] = [];
  const port: CounterpartyClassifierPort = {
    model: 'fake-model',
    async classify(counterparties: readonly ModelCounterparty[]) {
      asked.push(counterparties.map((c) => c.name));
      if (options.fail || counterparties.some((c) => c.name === options.failFor)) throw new Error('the model is down');
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
    // One batch, asked in two calls: the business-looking name (with search) and the other (without).
    // Neither the rent (own data) nor the own name went to the model.
    expect(model.asked).toEqual([['Werkzeug Abo Beispiel GmbH'], ['Laden Beispiel']]);
    expect(run).toEqual({ pending: 3, byEvidence: 1, byModel: 2, applied: 2, unavailable: false, failedBatches: 0, unanswered: 0, removed: 0, stoppedEarly: false });

    const view = await paymentsView(ctx.workspaceId);
    expect(await appList(ctx.workspaceId)).toEqual([
      ['Erika Beispiel', 'own_account', 'own_name'],
      ['Vermieter Beispiel', 'business', 'app'],
      ['Werkzeug Abo Beispiel GmbH', 'business', 'app'],
    ]);
    expect(view.appTreatments.find((t) => t.label === 'Vermieter Beispiel')?.reason).toBe('Der zugeordnete Beleg ist betrieblich.');
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
    expect(await classifyCounterparties(db, ctx, null)).toEqual({ pending: 3, byEvidence: 1, byModel: 0, applied: 1, unavailable: true, failedBatches: 0, unanswered: 0, removed: 0, stoppedEarly: false });
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
    expect(model.asked).toHaveLength(2);

    // New evidence: a private receipt linked to the shop decides it from the company's own data, without the model.
    const shopping = await ws.addReceipt({ Name: 'Einkauf', Vendor: 'Laden Beispiel', Gross: 45, Date: '2026-10-05', Category: 'Bürobedarf', Zuordnung: 'Privat', Currency: 'EUR', 'FX Rate': 1 });
    await linkPayment(db, ctx, { paymentId: ids.get('Laden Beispiel'), rowId: shopping }, receiptForLink(db, ctx.workspaceId));
    expect(await classifyCounterparties(db, ctx, model.port)).toMatchObject({ pending: 1, byEvidence: 1, byModel: 0 });
    expect(model.asked).toHaveLength(2);
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
    expect(await classifyCounterparties(db, ctx, model.port)).toMatchObject({ byEvidence: 1, byModel: 0, failedBatches: 2 });
    expect(await db.taxCounterpartyVerdict.count({ where: { authWorkspaceId: ctx.workspaceId, source: 'model' } })).toBe(0);
    const checks = await runSpendingChecks(db, ctx, { today: '2026-10-23', channels: [], classifier: model.port });
    expect(checks.classify).toMatchObject({ failedBatches: 2 });
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

describe('the app classifies counterparties: what it must never do on its own', () => {
  it("an account said to be private stays private: its payments are not sent to the model and a business verdict does not lift it", async () => {
    const ws = await createWorkspace();
    const ctx = { workspaceId: ws.workspaceId, tenantId: ws.tenantId };
    const privateAccount = await createAccount(db, ctx, { label: 'Privatkonto', kind: 'bank' });
    const businessAccount = await createAccount(db, ctx, { label: 'Geschäftskonto', kind: 'bank' });
    await importPayments(db, ctx, privateAccount, file(line('2026-10-03', 'Werkzeug Abo Beispiel GmbH', 'Abo privat', '-20'), line('2026-10-04', 'Laden Beispiel', 'Einkauf', '-45')));
    await importPayments(db, ctx, businessAccount, file(line('2026-10-05', 'Werkzeug Abo Beispiel GmbH', 'Abo Firma', '-20')));
    await setAccountPrivate(db, ctx, privateAccount, true);
    const model = fakeModel(ANSWERS);
    await classifyCounterparties(db, ctx, model.port);
    // The shop only has payments on the private account: never asked about.
    expect(model.asked).toEqual([['Werkzeug Abo Beispiel GmbH']]);
    const kinds = (await loadPayments(db, ctx.workspaceId)).payments.map((p) => [p.reference, p.kind]);
    expect(kinds).toEqual(expect.arrayContaining([['Abo privat', 'private'], ['Abo Firma', 'spend']]));
    // The spending side and the routing read it the same way: the private-account payment stays private.
    const spending = await loadSpending(db, ctx.workspaceId, 2026, null);
    expect(spending.overview.payments.filter((p) => p.counterparty === 'Werkzeug Abo Beispiel GmbH').map((p) => p.purpose).sort()).toEqual(['business', 'private']);
    const receiverWs = await createWorkspace();
    const receiver = { workspaceId: receiverWs.workspaceId, tenantId: receiverWs.tenantId };
    await shareAccount(db, ctx, privateAccount, receiver, 'user-owner');
    expect((await loadRoutedPayments(db, receiver.workspaceId)).payments.map((p) => p.reference).sort()).toEqual(['Abo privat', 'Einkauf']);
  });

  it('the model never makes an own account, nor anything but business of someone who paid money in', async () => {
    const ws = await createWorkspace();
    const ctx = { workspaceId: ws.workspaceId, tenantId: ws.tenantId };
    const accountId = await createAccount(db, ctx, { label: 'Girokonto', kind: 'bank' });
    await importPayments(db, ctx, accountId, file(line('2026-10-03', 'Sparkonto Beispiel', 'Sparen', '-100', 'Debit Transfer'), line('2026-10-04', 'Kunde Beispiel GmbH', 'Rechnung 12', '500', 'Credit Transfer')));
    await classifyCounterparties(
      db,
      ctx,
      fakeModel({
        'Sparkonto Beispiel': { treatment: 'own_account', category: 'transfers', confidence: 'certain', reason: 'Sparkonto' },
        'Kunde Beispiel GmbH': { treatment: 'private', category: 'transfers', confidence: 'certain', reason: 'Person' },
      }).port,
    );
    const view = await paymentsView(ctx.workspaceId);
    expect(view.appTreatments).toEqual([]);
    expect(view.unclassified.map((c) => [c.label, c.proposal?.treatment, c.proposal?.confidence]).sort()).toEqual([
      ['Kunde Beispiel GmbH', 'private', 'likely'],
      ['Sparkonto Beispiel', 'own_account', 'likely'],
    ]);
  });

  it('a verdict the receipts made changes as soon as they say something else, also without a model', async () => {
    const { ws, ctx } = await setup();
    await classifyCounterparties(db, ctx, null);
    expect(await appList(ctx.workspaceId)).toContainEqual(['Vermieter Beispiel', 'business', 'app']);
    // A private receipt linked to the landlord as well: the receipts no longer agree.
    const second = await ws.addReceipt({ Name: 'Miete Wohnung', Vendor: 'Vermieter Beispiel', Gross: 650, Date: '2026-10-02', Category: 'Miete & Nebenkosten', Zuordnung: 'Privat', Currency: 'EUR', 'FX Rate': 1 });
    const accountId = (await loadPayments(db, ctx.workspaceId)).accounts[0].id;
    await importPayments(db, ctx, accountId, file(line('2026-10-08', 'Vermieter Beispiel', 'Miete Wohnung', '-650', 'Debit Transfer')));
    const flat = (await loadPayments(db, ctx.workspaceId)).payments.find((p) => p.reference === 'Miete Wohnung')!;
    await linkPayment(db, ctx, { paymentId: flat.id, rowId: second }, receiptForLink(db, ctx.workspaceId));
    await classifyCounterparties(db, ctx, null);
    // A business and a private receipt of the same counterparty: it is used for both, "Teils, teils" (plan 2026-10-25-filed-year-decides-counterparties, decision 2).
    expect(await appList(ctx.workspaceId)).toContainEqual(['Vermieter Beispiel', 'mixed', 'app']);
    expect((await appList(ctx.workspaceId)).filter(([label]) => label === 'Vermieter Beispiel')).toHaveLength(1);
  });
});

describe('the app classifies counterparties: what the model is asked, and how often', () => {
  it('a counterparty left out of an otherwise readable answer is stored as unanswered and not paid for again', async () => {
    const ws = await createWorkspace();
    const ctx = { workspaceId: ws.workspaceId, tenantId: ws.tenantId };
    const accountId = await createAccount(db, ctx, { label: 'Girokonto', kind: 'bank' });
    await importPayments(db, ctx, accountId, file(line('2026-10-03', 'Laden Beispiel', 'Einkauf', '-45'), line('2026-10-04', 'Kiosk Beispiel', 'Zeitung', '-3')));
    const model = fakeModel({ 'Laden Beispiel': ANSWERS['Laden Beispiel'] });
    expect(await classifyCounterparties(db, ctx, model.port)).toMatchObject({ byModel: 1, unanswered: 1, failedBatches: 0 });
    expect((await paymentsView(ctx.workspaceId)).unclassified.find((c) => c.label === 'Kiosk Beispiel')?.proposal).toBeNull();
    expect(await classifyCounterparties(db, ctx, model.port)).toMatchObject({ pending: 0 });
    expect(model.asked).toHaveLength(1);
  });

  it('a run asks at most its limit, in batches, largest sums first; the rest follows on the next run', async () => {
    const ws = await createWorkspace();
    const ctx = { workspaceId: ws.workspaceId, tenantId: ws.tenantId };
    const accountId = await createAccount(db, ctx, { label: 'Girokonto', kind: 'bank' });
    await importPayments(db, ctx, accountId, file(...Array.from({ length: 5 }, (_, i) => line(`2026-10-1${i}`, `Händler ${String.fromCharCode(65 + i)} Beispiel`, 'Kauf', `-${(i + 1) * 10}`))));
    const model = fakeModel(Object.fromEntries(['A', 'B', 'C', 'D', 'E'].map((c) => [`Händler ${c} Beispiel`, ANSWERS['Laden Beispiel']])));
    expect(await classifyCounterparties(db, ctx, model.port, { limit: 3, batch: 2 })).toMatchObject({ pending: 5 });
    expect(model.asked).toEqual([['Händler E Beispiel', 'Händler D Beispiel'], ['Händler C Beispiel']]);
    await classifyCounterparties(db, ctx, model.port, { limit: 3, batch: 2 });
    expect(model.asked.at(-1)).toEqual(['Händler B Beispiel', 'Händler A Beispiel']);
  });

  it('adding an own name takes the counterparty from the app at once', async () => {
    const { ctx } = await setup();
    await classifyCounterparties(db, ctx, fakeModel(ANSWERS).port);
    await saveOwnNames(db, ctx, { add: 'Laden Beispiel' });
    const view = await paymentsView(ctx.workspaceId);
    expect(view.appTreatments.find((t) => t.label === 'Laden Beispiel')).toMatchObject({ treatment: 'own_account', source: 'own_name' });
    expect(view.unclassified.map((c) => c.label)).not.toContain('Laden Beispiel');
  });
});

describe('the app classifies counterparties: with the spending side and other companies', () => {
  it('an own account can be marked over an app verdict and taken back; an app verdict is no answer to take back', async () => {
    const { ctx } = await setup();
    await classifyCounterparties(db, ctx, fakeModel(ANSWERS).port);
    await markCounterpartyOwnAccount(db, ctx, 'Werkzeug Abo Beispiel GmbH');
    expect((await paymentsView(ctx.workspaceId)).treatments.map((t) => [t.label, t.treatment])).toEqual([['Werkzeug Abo Beispiel GmbH', 'own_account']]);
    await unmarkCounterpartyOwnAccount(db, ctx, 'werkzeug abo beispiel');
    expect((await paymentsView(ctx.workspaceId)).appTreatments.find((t) => t.label === 'Werkzeug Abo Beispiel GmbH')).toMatchObject({ treatment: 'business', source: 'app' });
    const refused = await unmarkCounterpartyOwnAccount(db, ctx, 'erika beispiel').catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(SpendingServiceError);
  });

  it('a certain private verdict moves the payments of a shared account to the receiving company, like an answer', async () => {
    const { ctx: holder } = await setup();
    const receiverWs = await createWorkspace();
    const receiver = { workspaceId: receiverWs.workspaceId, tenantId: receiverWs.tenantId };
    const accountId = (await loadPayments(db, holder.workspaceId)).accounts[0].id;
    await shareAccount(db, holder, accountId, receiver, 'user-owner');
    await classifyCounterparties(db, holder, fakeModel({ ...ANSWERS, 'Laden Beispiel': { ...ANSWERS['Laden Beispiel'], confidence: 'certain' } }).port);
    const routed = await loadRoutedPayments(db, receiver.workspaceId);
    expect(routed.payments.map((p) => p.counterparty)).toEqual(['Laden Beispiel']);
    // The business one stays with the holder.
    expect((await loadRoutedPayments(db, holder.workspaceId)).payments.map((p) => p.counterparty)).toContain('Werkzeug Abo Beispiel GmbH');
  });
});

describe('the app classifies counterparties: limits and partial failures', () => {
  it("the company's own data decides every counterparty, beyond the model's limit, also without a model", async () => {
    const { ctx } = await setup();
    const model = fakeModel(ANSWERS);
    expect(await classifyCounterparties(db, ctx, model.port, { limit: 0 })).toMatchObject({ byEvidence: 1, byModel: 0 });
    expect(model.asked).toEqual([]);
    expect(await appList(ctx.workspaceId)).toContainEqual(['Vermieter Beispiel', 'business', 'app']);
  });

  it('one failing call keeps the answer of the other call of the batch', async () => {
    const { ctx } = await setup();
    const run = await classifyCounterparties(db, ctx, fakeModel(ANSWERS, { failFor: 'Laden Beispiel' }).port);
    expect(run).toMatchObject({ byModel: 1, failedBatches: 1 });
    expect((await paymentsView(ctx.workspaceId)).appTreatments.map((t) => t.label)).toContain('Werkzeug Abo Beispiel GmbH');
    // The failed one is asked again next time.
    const retry = fakeModel(ANSWERS);
    await classifyCounterparties(db, ctx, retry.port);
    expect(retry.asked).toEqual([['Laden Beispiel']]);
  });

  it('an answer with nothing readable is a failed call: nothing stored, asked again', async () => {
    const { ctx } = await setup();
    const run = await classifyCounterparties(db, ctx, fakeModel({}).port);
    expect(run).toMatchObject({ byModel: 0, unanswered: 0, failedBatches: 2 });
    expect(await db.taxCounterpartyVerdict.count({ where: { authWorkspaceId: ctx.workspaceId, source: 'model' } })).toBe(0);
  });

  it("a payment routed in takes the holder's category; the receiver's own payments of the same name never do", async () => {
    const { ctx: holder } = await setup();
    const receiverWs = await createWorkspace();
    const receiver = { workspaceId: receiverWs.workspaceId, tenantId: receiverWs.tenantId };
    const own = await createAccount(db, receiver, { label: 'Privatgiro', kind: 'bank' });
    await importPayments(db, receiver, own, file(line('2026-10-09', 'Laden Beispiel', 'Einkauf eigenes Konto', '-12')));
    const accountId = (await loadPayments(db, holder.workspaceId)).accounts[0].id;
    await shareAccount(db, holder, accountId, receiver, 'user-owner');
    await classifyCounterparties(db, holder, fakeModel({ ...ANSWERS, 'Laden Beispiel': { ...ANSWERS['Laden Beispiel'], confidence: 'certain' } }).port);
    const spending = await loadSpending(db, receiver.workspaceId, 2026, null);
    const shop = spending.overview.payments.filter((p) => p.counterparty === 'Laden Beispiel').map((p) => [p.routed, p.category, p.basis]);
    expect(shop.sort()).toEqual([
      [false, 'unclear', 'none'],
      [true, 'shopping_household', 'app'],
    ]);
  });
});
