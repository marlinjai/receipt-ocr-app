import { afterAll, describe, expect, it } from 'vitest';
import { saveTaxSettings } from '@/lib/meals/service';
import { saveFiledOn } from '../../income-tax/service';
import { loadStatement, saveInvoice, saveItemDecision } from '../../service';
import type { DecidedVerdict, ModelCounterparty } from '../classify';
import { classifyCounterparties } from '../classify-service';
import type { CounterpartyClassifierPort } from '../counterparty-classifier';
import { ensureMerchantKeys, forgetMerchantKeys } from '../rekey';
import { loadRoutedPayments, shareAccount } from '../routing';
import { createAccount, importPayments, linkPayment, loadPayments, setCounterpartyTreatment, unlinkPayment } from '../service';
import { receiptForLink } from '../../service';
import { createWorkspace, db, type TestWorkspace } from '../../../../../test/db-helpers';

/**
 * The company's own data deciding counterparties before the model (plan
 * docs/plans/2026-10-25-filed-year-decides-counterparties.md): receipts that
 * pay a payment without a link, split receipts, the company's own invoices, a
 * filed year, and one merchant per shop. Forward, backtrack and revise,
 * resume from what is stored, re-entry. The model is a fake that records what
 * it was asked. Run with `pnpm test:db`. Every name and amount is invented.
 */

const HEADER = '"Booking Date","Value Date","Partner Name","Partner Iban",Type,"Payment Reference","Account Name","Amount (EUR)","Original Amount","Original Currency","Exchange Rate"';
const line = (day: string, partner: string, reference: string, amount: string, type = 'Presentment') => `${day},${day},"${partner}",,${type},"${reference}",Hauptkonto,${amount},,,`;
const file = (...lines: string[]) => [HEADER, ...lines].join('\n') + '\n';

const HALF_AND_STUDY = { allocations: [{ purpose: 'business', shareBp: 5000 }, { purpose: 'study', shareBp: 3000 }], formLineKey: 'euer.telecom', employmentLineKey: 'employment.study_costs' };

function fakeModel(answers: Record<string, DecidedVerdict> = {}) {
  const asked: string[] = [];
  const port: CounterpartyClassifierPort = {
    model: 'fake-model',
    async classify(counterparties: readonly ModelCounterparty[]) {
      asked.push(...counterparties.map((c) => c.name));
      return new Map(counterparties.map((c) => [c.key, answers[c.name] ?? { treatment: 'private', category: null, confidence: 'unsure', reason: 'Unklar.' }] as const));
    },
  };
  return { port, asked };
}

async function company(lines: string[]): Promise<{ ws: TestWorkspace; ctx: { workspaceId: string; tenantId: string | null } }> {
  const ws = await createWorkspace();
  const ctx = { workspaceId: ws.workspaceId, tenantId: ws.tenantId };
  await saveTaxSettings(db, ctx, { smallBusiness: true });
  const accountId = await createAccount(db, ctx, { label: 'Girokonto', kind: 'bank' });
  await importPayments(db, ctx, accountId, file(...lines));
  return { ws, ctx };
}

const verdictOf = (workspaceId: string, key: string) => db.taxCounterpartyVerdict.findUnique({ where: { authWorkspaceId_counterpartyKey: { authWorkspaceId: workspaceId, counterpartyKey: key } } });
const filed = (ctx: { workspaceId: string; tenantId: string | null }, year: number, filedOn: string | null) => saveFiledOn(db, ctx, { year, filedOn }, '2026-10-26');

afterAll(async () => {
  await db.$disconnect();
});

describe('receipts decide without a link and without the model', () => {
  it('a monthly bill with its split receipts is "Teils, teils", and nothing is linked by it', async () => {
    const { ws, ctx } = await company([
      line('2025-01-02', 'Netzwerk Nord GmbH', 'Festnetz RG 1/16.12.2024', '-39.95', 'Debit Transfer'),
      line('2025-01-31', 'Netzwerk Nord GmbH', 'Festnetz RG 2/22.01.2025', '-39.95', 'Debit Transfer'),
      line('2025-02-28', 'Netzwerk Nord GmbH', 'Festnetz RG 3/19.02.2025', '-39.95', 'Debit Transfer'),
    ]);
    for (const day of ['2024-12-16', '2025-01-22', '2025-02-19']) {
      const rowId = await ws.addReceipt({ Name: 'Festnetz', Vendor: 'Netzwerk Nord GmbH', Gross: 39.95, Date: day, Category: 'Miete & Nebenkosten', Zuordnung: 'Geschäftlich', Currency: 'EUR', 'FX Rate': 1 });
      await saveItemDecision(db, ctx, rowId, HALF_AND_STUDY);
    }
    const model = fakeModel();
    const run = await classifyCounterparties(db, ctx, model.port);
    expect(model.asked).toEqual([]);
    expect(run).toMatchObject({ pending: 1, byEvidence: 1, byModel: 0, applied: 1 });
    expect(await verdictOf(ctx.workspaceId, 'netzwerk nord')).toMatchObject({ treatment: 'mixed', confidence: 'certain', source: 'evidence', reason: 'Die 3 Belege sind zwischen Betrieb und privat geteilt.' });
    expect((await loadPayments(db, ctx.workspaceId)).payments.every((p) => p.links.length === 0)).toBe(true);
    // Re-entry: nothing changed, nothing is decided again.
    expect(await classifyCounterparties(db, ctx, model.port)).toMatchObject({ pending: 0, byEvidence: 0 });
  });

  it('money in for the company\'s own invoices makes the payer business', async () => {
    const ws = await createWorkspace();
    const ctx = { workspaceId: ws.workspaceId, tenantId: ws.tenantId };
    await saveTaxSettings(db, ctx, { smallBusiness: true });
    await saveInvoice(db, ctx, null, { number: 'R-2026-001', issueDate: '2026-01-10', grossCents: 100_000, treatment: 'small_business', payments: [] });
    const accountId = await createAccount(db, ctx, { label: 'Girokonto', kind: 'bank' });
    await importPayments(db, ctx, accountId, file(line('2026-01-20', 'Kunde Beispiel AG', 'Rechnung R-2026-001', '1000', 'Credit Transfer')));
    const model = fakeModel();
    await classifyCounterparties(db, ctx, model.port);
    expect(model.asked).toEqual([]);
    expect(await verdictOf(ctx.workspaceId, 'kunde beispiel')).toMatchObject({ treatment: 'business', confidence: 'certain', reason: 'Der Eingang bezahlt eine eigene Rechnung.' });
  });
});

describe('a filed year asks nothing', () => {
  const LINES = [
    line('2025-03-04', 'Markt Beispiel', 'Einkauf', '-23.40'),
    line('2025-05-06', 'Markt Beispiel', 'Einkauf', '-31.10'),
    line('2025-06-01', 'Sparkasse Beispiel', 'Sparen', '-500', 'Debit Transfer'),
  ];
  const ANSWERS: Record<string, DecidedVerdict> = { 'Sparkasse Beispiel': { treatment: 'own_account', category: 'transfers', confidence: 'likely', reason: 'Eine Bank, wohl ein eigenes Sparkonto.' } };

  it('forward: what the return did not claim is private; the own-account proposal stays; the year asks nothing', async () => {
    const { ctx } = await company(LINES);
    const model = fakeModel(ANSWERS);
    await classifyCounterparties(db, ctx, model.port);
    expect(model.asked.sort()).toEqual(['Markt Beispiel', 'Sparkasse Beispiel']);
    let view = (await loadStatement(db, ctx.workspaceId, 2025)).payments;
    expect(view.unclassified.map((c) => c.label).sort()).toEqual(['Markt Beispiel', 'Sparkasse Beispiel']);
    expect(view.filedOn).toBeNull();

    await filed(ctx, 2025, '2026-10-17');
    const run = await classifyCounterparties(db, ctx, model.port);
    // Both were decided again on the new evidence, without the model.
    expect(run).toMatchObject({ pending: 2, byModel: 0 });
    expect(model.asked).toHaveLength(2);
    expect(await verdictOf(ctx.workspaceId, 'markt beispiel')).toMatchObject({ treatment: 'private', confidence: 'certain', reason: 'In der abgegebenen Erklärung 2025 nicht als Betriebsausgabe abgesetzt.' });
    expect(await verdictOf(ctx.workspaceId, 'sparkasse beispiel')).toMatchObject({ treatment: 'own_account', confidence: 'likely', source: 'model' });
    view = (await loadStatement(db, ctx.workspaceId, 2025)).payments;
    expect(view.filedOn).toBe('2026-10-17');
    expect(view.unclassified).toEqual([]);
    expect(view.open).toEqual([]);
    // Resume and re-entry: a second run with nothing new decides nothing and asks nobody.
    expect(await classifyCounterparties(db, ctx, model.port)).toMatchObject({ pending: 0 });
  });

  it('backtrack: clearing the filing day brings the questions back and the year is decided again', async () => {
    const { ctx } = await company(LINES);
    const model = fakeModel(ANSWERS);
    await filed(ctx, 2025, '2026-10-17');
    await classifyCounterparties(db, ctx, model.port);
    expect(await verdictOf(ctx.workspaceId, 'markt beispiel')).toMatchObject({ treatment: 'private', source: 'evidence' });
    await filed(ctx, 2025, null);
    await classifyCounterparties(db, ctx, model.port);
    expect(await verdictOf(ctx.workspaceId, 'markt beispiel')).toMatchObject({ source: 'model', confidence: 'unsure' });
    expect((await loadStatement(db, ctx.workspaceId, 2025)).payments.unclassified.map((c) => c.label)).toContain('Markt Beispiel');
  });

  it("a person's answer still wins over the filed year", async () => {
    const { ctx } = await company(LINES);
    await filed(ctx, 2025, '2026-10-17');
    await setCounterpartyTreatment(db, ctx, { counterparty: 'Markt Beispiel', treatment: 'business' });
    await classifyCounterparties(db, ctx, fakeModel(ANSWERS).port);
    expect((await loadPayments(db, ctx.workspaceId)).treatmentSources.get('markt beispiel')).toBe('person');
    // Its payments show as receipts to add, though the year asks nothing else.
    const view = (await loadStatement(db, ctx.workspaceId, 2025)).payments;
    expect(view.open.map((o) => o.counterparty)).toEqual(['Markt Beispiel', 'Markt Beispiel']);
    expect(view.unclassified).toEqual([]);
  });
});

describe('one merchant, one counterparty', () => {
  const oldKey = (label: string) => label.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  /** Puts a company's payments back on the keys made before the merchant key, and forgets that keys were carried. */
  async function asBefore(workspaceId: string) {
    for (const p of await db.taxPayment.findMany({ where: { authWorkspaceId: workspaceId } })) await db.taxPayment.update({ where: { id: p.id }, data: { counterpartyKey: oldKey(p.counterparty) } });
    await db.taxKeyVersion.deleteMany({});
    forgetMerchantKeys();
  }
  const LINES = [
    line('2026-02-01', 'AMAZON* KT2PC3H85', 'Bestellung', '-12.99'),
    line('2026-02-03', 'AMAZON* B05ZJ4F54', 'Bestellung', '-8.50'),
    line('2026-02-04', 'Amazon', 'Bestellung', '-20.00'),
    line('2026-02-05', 'SumUp *Cafe Beispiel', 'Kaffee', '-3.20'),
    line('2026-02-07', 'SumUp *Laden Beispiel', 'Kaffee', '-4.10'),
  ];

  it('carries keys, answers, budgets and verdicts to the merchant, once, for every company', async () => {
    const { ctx } = await company(LINES);
    const other = await company([line('2026-03-01', 'AMAZON* 7S69H2CM5', 'Bestellung', '-5.00')]);
    await asBefore(ctx.workspaceId);
    await asBefore(other.ctx.workspaceId);
    const rule = (c: typeof ctx, label: string, treatment: string) => db.taxCounterpartyRule.create({ data: { authWorkspaceId: c.workspaceId, authTenantId: c.tenantId, counterpartyKey: oldKey(label), label, treatment } });
    // A row already on the merchant's key next to coded ones that say the same, and a shop behind a terminal.
    await rule(ctx, 'Amazon', 'mixed');
    await rule(ctx, 'AMAZON* KT2PC3H85', 'mixed');
    await rule(ctx, 'AMAZON* B05ZJ4F54', 'mixed');
    await rule(ctx, 'SumUp *Cafe Beispiel', 'private');
    await rule(other.ctx, 'AMAZON* 7S69H2CM5', 'private');
    const category = (label: string, value: string) => db.spendingCategoryAnswer.create({ data: { authWorkspaceId: ctx.workspaceId, authTenantId: ctx.tenantId, counterpartyKey: oldKey(label), label, category: value } });
    await category('AMAZON* KT2PC3H85', 'shopping_household');
    await category('AMAZON* B05ZJ4F54', 'software_ai_hosting');
    await db.spendingBudget.create({ data: { authWorkspaceId: ctx.workspaceId, authTenantId: ctx.tenantId, scope: 'vendor', key: oldKey('SumUp *Laden Beispiel'), label: 'SumUp *Laden Beispiel', limitCents: 5_000 } });
    // A verdict on the merchant's key, made when it had one payment: it covers more payments now and is made again.
    await db.taxCounterpartyVerdict.create({ data: { authWorkspaceId: ctx.workspaceId, authTenantId: ctx.tenantId, counterpartyKey: 'amazon', label: 'Amazon', treatment: 'business', confidence: 'certain', reason: 'Alt.', source: 'evidence', fingerprint: 'alt' } });

    const first = await ensureMerchantKeys(db);
    expect(first).toMatchObject({ conflicting: 2, verdicts: 1 });
    expect((await db.taxPayment.findMany({ where: { authWorkspaceId: ctx.workspaceId } })).map((p) => p.counterpartyKey).sort()).toEqual(['amazon', 'amazon', 'amazon', 'cafe beispiel', 'laden beispiel']);
    const rules = await db.taxCounterpartyRule.findMany({ where: { authWorkspaceId: ctx.workspaceId }, orderBy: { counterpartyKey: 'asc' } });
    expect(rules.map((r) => [r.counterpartyKey, r.label, r.treatment])).toEqual([['amazon', 'Amazon', 'mixed'], ['cafe beispiel', 'Cafe Beispiel', 'private']]);
    // Two different categories: neither is carried, the merchant is asked again.
    expect(await db.spendingCategoryAnswer.count({ where: { authWorkspaceId: ctx.workspaceId } })).toBe(0);
    expect(await db.spendingBudget.findMany({ where: { authWorkspaceId: ctx.workspaceId } })).toMatchObject([{ key: 'laden beispiel', label: 'Laden Beispiel', limitCents: 5_000 }]);
    expect(await verdictOf(ctx.workspaceId, 'amazon')).toBeNull();
    // The other company was carried in the same run.
    expect(await db.taxCounterpartyRule.findMany({ where: { authWorkspaceId: other.ctx.workspaceId } })).toMatchObject([{ counterpartyKey: 'amazon', treatment: 'private' }]);
    expect((await loadPayments(db, ctx.workspaceId)).treatments.get('amazon')).toBe('mixed');

    // Re-entry: the marker says it is done, in this process and in a fresh one.
    expect(await ensureMerchantKeys(db)).toBeNull();
    forgetMerchantKeys();
    expect(await ensureMerchantKeys(db)).toBeNull();
  });

  it('an import or an answer before anything else carries the keys first', async () => {
    const { ctx } = await company(LINES);
    await asBefore(ctx.workspaceId);
    await setCounterpartyTreatment(db, ctx, { counterparty: 'AMAZON* 9QQQ11115', treatment: 'mixed' });
    expect((await loadPayments(db, ctx.workspaceId)).treatments.get('amazon')).toBe('mixed');
    expect((await loadStatement(db, ctx.workspaceId, 2026)).payments.unclassified.map((c) => c.label)).not.toContain('AMAZON* KT2PC3H85');

    await asBefore(ctx.workspaceId);
    const accountId = (await loadPayments(db, ctx.workspaceId)).accounts[0].id;
    await asBefore(ctx.workspaceId);
    // The same file again: every row is known, though the stored keys were the old ones when it started.
    const again = await importPayments(db, ctx, accountId, file(...LINES), {}).catch((e: Error) => e);
    expect(await db.taxPayment.count({ where: { authWorkspaceId: ctx.workspaceId } })).toBe(5);
    expect(again).toBeInstanceOf(Error);
  });

  it('two orders of one shop on one day stay two movements', async () => {
    const { ctx } = await company([line('2026-02-01', 'AMAZON* KT2PC3H85', 'Bestellung', '-12.99'), line('2026-02-01', 'AMAZON* B05ZJ4F54', 'Bestellung', '-12.99')]);
    expect(await db.taxPayment.count({ where: { authWorkspaceId: ctx.workspaceId } })).toBe(2);
  });
});

describe('the app\'s own "Teils, teils" moves nothing to the receiving company', () => {
  it('payments of a shared account whose split receipts the holder has stay with the holder', async () => {
    const { ws, ctx } = await company([
      line('2025-01-02', 'Netzwerk Nord GmbH', 'Festnetz', '-39.95', 'Debit Transfer'),
      line('2025-01-31', 'Netzwerk Nord GmbH', 'Festnetz', '-39.95', 'Debit Transfer'),
    ]);
    for (const day of ['2024-12-16', '2025-01-22']) {
      const rowId = await ws.addReceipt({ Name: 'Festnetz', Vendor: 'Netzwerk Nord GmbH', Gross: 39.95, Date: day, Category: 'Miete & Nebenkosten', Zuordnung: 'Geschäftlich', Currency: 'EUR', 'FX Rate': 1 });
      await saveItemDecision(db, ctx, rowId, HALF_AND_STUDY);
    }
    const receiverWs = await createWorkspace();
    const receiver = { workspaceId: receiverWs.workspaceId, tenantId: receiverWs.tenantId };
    await shareAccount(db, ctx, (await loadPayments(db, ctx.workspaceId)).accounts[0].id, receiver, 'user-owner');
    await classifyCounterparties(db, ctx, fakeModel().port);
    expect((await loadPayments(db, ctx.workspaceId)).treatments.get('netzwerk nord')).toBe('mixed');
    expect((await loadRoutedPayments(db, receiver.workspaceId)).payments).toEqual([]);
    // A person's "Teils, teils" still moves what no receipt is linked to, as before.
    await setCounterpartyTreatment(db, ctx, { counterparty: 'Netzwerk Nord GmbH', treatment: 'mixed' });
    expect((await loadRoutedPayments(db, receiver.workspaceId)).payments).toHaveLength(2);
  });
});

describe('evidence that changes is decided again, once', () => {
  it('unlinking a receipt or an invoice payment changes the verdict exactly once', async () => {
    const ws = await createWorkspace();
    const ctx = { workspaceId: ws.workspaceId, tenantId: ws.tenantId };
    await saveTaxSettings(db, ctx, { smallBusiness: true });
    await saveInvoice(db, ctx, null, { number: 'R-2026-001', issueDate: '2026-01-10', grossCents: 100_000, treatment: 'small_business', payments: [] });
    const accountId = await createAccount(db, ctx, { label: 'Girokonto', kind: 'bank' });
    await importPayments(db, ctx, accountId, file(line('2026-01-20', 'Kunde Beispiel AG', 'Rechnung R-2026-001', '1000', 'Credit Transfer'), line('2026-03-01', 'Werkstatt Beispiel', 'Reparatur', '-80')));
    const shop = await ws.addReceipt({ Name: 'Reparatur', Vendor: 'Werkstatt Beispiel', Gross: 80, Date: '2026-04-20', Category: 'Miete & Nebenkosten', Zuordnung: 'Geschäftlich', Currency: 'EUR', 'FX Rate': 1 });
    const payments = (await loadPayments(db, ctx.workspaceId)).payments;
    await linkPayment(db, ctx, { paymentId: payments.find((p) => p.counterparty === 'Werkstatt Beispiel')!.id, rowId: shop }, receiptForLink(db, ctx.workspaceId));
    const model = fakeModel();
    await classifyCounterparties(db, ctx, model.port);
    expect(await verdictOf(ctx.workspaceId, 'werkstatt beispiel')).toMatchObject({ treatment: 'business', source: 'evidence' });
    expect(await verdictOf(ctx.workspaceId, 'kunde beispiel')).toMatchObject({ treatment: 'business', source: 'evidence' });

    for (const p of (await loadPayments(db, ctx.workspaceId)).payments) for (const l of p.links) await unlinkPayment(db, ctx, l.id);
    const run = await classifyCounterparties(db, ctx, model.port);
    // Both lost their evidence: the receipt's verdict is removed and the model asked, once each.
    expect(run).toMatchObject({ pending: 2, removed: 2, byModel: 2 });
    expect(model.asked.sort()).toEqual(['Kunde Beispiel AG', 'Werkstatt Beispiel']);
    expect(await classifyCounterparties(db, ctx, model.port)).toMatchObject({ pending: 0 });
    expect(model.asked).toHaveLength(2);
  });

  it('a filed year with a business receipt of the vendor that matching missed decides nothing', async () => {
    const { ws, ctx } = await company([line('2025-03-04', 'Werkzeug Abo Beispiel', 'Abo', '-18.30')]);
    // The receipt in another currency, months away: no match, but the vendor is the same, so the return may have claimed it.
    await ws.addReceipt({ Name: 'Abo', Vendor: 'Werkzeug Abo Beispiel', Gross: 20, Date: '2025-07-01', Category: 'Miete & Nebenkosten', Zuordnung: 'Geschäftlich', Currency: 'USD', 'FX Rate': 0.92 });
    await filed(ctx, 2025, '2026-10-17');
    const model = fakeModel();
    await classifyCounterparties(db, ctx, model.port);
    expect(model.asked).toEqual(['Werkzeug Abo Beispiel']);
    expect(await verdictOf(ctx.workspaceId, 'werkzeug abo beispiel')).toMatchObject({ source: 'model' });
  });

  it('a one-off payment at the turn into an open year is no filed-year payment', async () => {
    const { ctx } = await company([line('2025-12-28', 'Markt Beispiel', 'Einkauf', '-23.40')]);
    await filed(ctx, 2025, '2026-10-17');
    const model = fakeModel();
    await classifyCounterparties(db, ctx, model.port);
    expect(model.asked).toEqual(['Markt Beispiel']);
  });
});

describe('the second review: carrying, invoice payers and a fresh filed year', () => {
  it('a refused link as the first call after a deploy still leaves the keys carried', async () => {
    const { ws, ctx } = await company([line('2026-02-01', 'AMAZON* KT2PC3H85', 'Bestellung', '-12.99')]);
    for (const p of await db.taxPayment.findMany({ where: { authWorkspaceId: ctx.workspaceId } })) await db.taxPayment.update({ where: { id: p.id }, data: { counterpartyKey: 'amazon kt2pc3h85' } });
    await db.taxKeyVersion.deleteMany({});
    forgetMerchantKeys();
    const rowId = await ws.addReceipt({ Name: 'Kabel', Vendor: 'Amazon', Gross: 12.99, Date: '2026-02-01', Category: 'Miete & Nebenkosten', Zuordnung: 'Geschäftlich', Currency: 'EUR', 'FX Rate': 1 });
    const [payment] = await db.taxPayment.findMany({ where: { authWorkspaceId: ctx.workspaceId } });
    // More than the payment holds: the link is refused, its transaction rolls back.
    await expect(linkPayment(db, ctx, { paymentId: payment.id, rowId, cents: 99_999 }, receiptForLink(db, ctx.workspaceId))).rejects.toThrow();
    expect(await db.taxKeyVersion.count()).toBe(1);
    expect((await db.taxPayment.findUnique({ where: { id: payment.id } }))?.counterpartyKey).toBe('amazon');
  });

  it('an invoice payer is decided again once money goes out to it, and not for every new invoice payment', async () => {
    const ws = await createWorkspace();
    const ctx = { workspaceId: ws.workspaceId, tenantId: ws.tenantId };
    await saveTaxSettings(db, ctx, { smallBusiness: true });
    await saveInvoice(db, ctx, null, { number: 'R-2026-001', issueDate: '2026-01-10', grossCents: 100_000, treatment: 'small_business', payments: [] });
    await saveInvoice(db, ctx, null, { number: 'R-2026-002', issueDate: '2026-02-10', grossCents: 50_000, treatment: 'small_business', payments: [] });
    const accountId = await createAccount(db, ctx, { label: 'Girokonto', kind: 'bank' });
    await importPayments(db, ctx, accountId, file(line('2026-01-20', 'Kunde Beispiel AG', 'Rechnung R-2026-001', '1000', 'Credit Transfer')));
    const model = fakeModel({ 'Kunde Beispiel AG': { treatment: 'mixed', category: null, confidence: 'likely', reason: 'Kunde, der auch ein Laden ist.' } });
    await classifyCounterparties(db, ctx, model.port);
    expect(await verdictOf(ctx.workspaceId, 'kunde beispiel')).toMatchObject({ treatment: 'business', confidence: 'certain', source: 'evidence' });
    // A purchase in the client's shop: the invoices alone no longer decide it, the model is asked, once.
    await importPayments(db, ctx, accountId, file(line('2026-02-15', 'Kunde Beispiel AG', 'Schuhe', '-171', 'Presentment')));
    await classifyCounterparties(db, ctx, model.port);
    expect(model.asked).toEqual(['Kunde Beispiel AG']);
    expect(await verdictOf(ctx.workspaceId, 'kunde beispiel')).toMatchObject({ source: 'model' });
    // The next invoice payment changes no class of the evidence: nobody is asked again.
    await importPayments(db, ctx, accountId, file(line('2026-02-25', 'Kunde Beispiel AG', 'Rechnung R-2026-002', '500', 'Credit Transfer')));
    expect(await classifyCounterparties(db, ctx, model.port)).toMatchObject({ pending: 0 });
    expect(model.asked).toHaveLength(1);
  });

  it('a counterparty of a filed year never asked before is asked first: own account stays a proposal, anything else is private', async () => {
    const { ctx } = await company([line('2025-06-01', 'Tagesgeld Beispiel', 'Sparen', '-500', 'Debit Transfer'), line('2025-06-02', 'Kiosk Beispiel', 'Zeitung', '-3', 'Presentment')]);
    await filed(ctx, 2025, '2026-10-17');
    const model = fakeModel({
      'Tagesgeld Beispiel': { treatment: 'own_account', category: 'transfers', confidence: 'likely', reason: 'Wohl ein eigenes Sparkonto.' },
      'Kiosk Beispiel': { treatment: 'private', category: null, confidence: 'unsure', reason: 'Kiosk.' },
    });
    const run = await classifyCounterparties(db, ctx, model.port);
    expect(model.asked.sort()).toEqual(['Kiosk Beispiel', 'Tagesgeld Beispiel']);
    expect(await verdictOf(ctx.workspaceId, 'tagesgeld beispiel')).toMatchObject({ treatment: 'own_account', confidence: 'likely', source: 'model' });
    expect(await verdictOf(ctx.workspaceId, 'kiosk beispiel')).toMatchObject({ treatment: 'private', confidence: 'certain', source: 'evidence' });
    expect(run).toMatchObject({ byEvidence: 1, byModel: 1 });
    // Re-entry: nothing asked again.
    expect(await classifyCounterparties(db, ctx, model.port)).toMatchObject({ pending: 0 });
  });

  it('without a model the filed year decides alone', async () => {
    const { ctx } = await company([line('2025-06-02', 'Kiosk Beispiel', 'Zeitung', '-3', 'Presentment')]);
    await filed(ctx, 2025, '2026-10-17');
    await classifyCounterparties(db, ctx, null);
    expect(await verdictOf(ctx.workspaceId, 'kiosk beispiel')).toMatchObject({ treatment: 'private', confidence: 'certain' });
  });
});
