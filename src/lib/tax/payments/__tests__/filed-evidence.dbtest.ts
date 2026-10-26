import { afterAll, describe, expect, it } from 'vitest';
import { saveTaxSettings } from '@/lib/meals/service';
import { saveFiledOn } from '../../income-tax/service';
import { loadStatement, saveInvoice, saveItemDecision } from '../../service';
import type { DecidedVerdict, ModelCounterparty } from '../classify';
import { classifyCounterparties } from '../classify-service';
import type { CounterpartyClassifierPort } from '../counterparty-classifier';
import { rekeyCounterparties } from '../rekey';
import { createAccount, importPayments, loadPayments, setCounterpartyTreatment } from '../service';
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
  });
});

describe('one merchant, one counterparty', () => {
  it('carries stored keys and answers to the merchant, drops disagreeing answers, and is idempotent', async () => {
    const { ctx } = await company([
      line('2026-02-01', 'AMAZON* KT2PC3H85', 'Bestellung', '-12.99'),
      line('2026-02-03', 'AMAZON* B05ZJ4F54', 'Bestellung', '-8.50'),
      line('2026-02-05', 'SumUp *Cafe Beispiel', 'Kaffee', '-3.20'),
      line('2026-02-07', 'SumUp *Laden Beispiel', 'Kaffee', '-4.10'),
    ]);
    // As stored before the merchant key: each payment under its own coded key, and answers on those keys.
    const payments = await db.taxPayment.findMany({ where: { authWorkspaceId: ctx.workspaceId } });
    const oldKey = (label: string) => label.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    for (const p of payments) await db.taxPayment.update({ where: { id: p.id }, data: { counterpartyKey: oldKey(p.counterparty) } });
    const rule = (label: string, treatment: string) => db.taxCounterpartyRule.create({ data: { authWorkspaceId: ctx.workspaceId, authTenantId: ctx.tenantId, counterpartyKey: oldKey(label), label, treatment } });
    await rule('AMAZON* KT2PC3H85', 'mixed');
    await rule('AMAZON* B05ZJ4F54', 'mixed');
    await rule('SumUp *Cafe Beispiel', 'private');
    await db.spendingCategoryAnswer.create({ data: { authWorkspaceId: ctx.workspaceId, authTenantId: ctx.tenantId, counterpartyKey: oldKey('AMAZON* KT2PC3H85'), label: 'AMAZON* KT2PC3H85', category: 'shopping_household' } });
    await db.spendingCategoryAnswer.create({ data: { authWorkspaceId: ctx.workspaceId, authTenantId: ctx.tenantId, counterpartyKey: oldKey('AMAZON* B05ZJ4F54'), label: 'AMAZON* B05ZJ4F54', category: 'software_ai_hosting' } });

    const first = await rekeyCounterparties(db, ctx.tenantId, ctx.workspaceId);
    expect(first).toMatchObject({ payments: 4, conflicting: 2 });
    const keys = (await db.taxPayment.findMany({ where: { authWorkspaceId: ctx.workspaceId } })).map((p) => p.counterpartyKey).sort();
    expect(keys).toEqual(['amazon', 'amazon', 'cafe beispiel', 'laden beispiel']);
    // The same answer from both coded keys is one answer on the merchant; the shop behind the terminal keeps its own.
    const rules = await db.taxCounterpartyRule.findMany({ where: { authWorkspaceId: ctx.workspaceId }, orderBy: { counterpartyKey: 'asc' } });
    expect(rules.map((r) => [r.counterpartyKey, r.treatment])).toEqual([['amazon', 'mixed'], ['cafe beispiel', 'private']]);
    // Two different categories: neither is carried, the merchant is asked again.
    expect(await db.spendingCategoryAnswer.count({ where: { authWorkspaceId: ctx.workspaceId } })).toBe(0);
    expect((await loadPayments(db, ctx.workspaceId)).treatments.get('amazon')).toBe('mixed');

    expect(await rekeyCounterparties(db, ctx.tenantId, ctx.workspaceId)).toEqual({ payments: 0, carried: 0, conflicting: 0, verdicts: 0 });
  });
});
