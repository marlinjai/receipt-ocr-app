import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getTaxSettings, loadMealRecord, saveTaxSettings } from '@/lib/meals/service';
import { mealDeduction } from '@/lib/meals/rules';
import { RevenueInputError } from '../revenue-input';
import {
  TaxServiceError,
  deleteInvoice,
  deleteStatusChange,
  deleteVatSettlement,
  loadStatement,
  saveInvoice,
  saveRevenueExpectation,
  saveStatusChange,
  saveVatSettings,
  saveVatSettlement,
  type TaxContext,
} from '../service';
import { createWorkspace, db, type TestWorkspace } from '../../../../test/db-helpers';

/**
 * Revenue, the status over time and regular value-added taxation against a
 * real database (migration 0012). Run with `pnpm test:db`.
 */

let other: TestWorkspace;
let otherCtx: TaxContext;

async function workspace(smallBusiness: boolean | null = true): Promise<{ ws: TestWorkspace; ctx: TaxContext }> {
  const ws = await createWorkspace();
  const ctx = { workspaceId: ws.workspaceId, tenantId: ws.tenantId };
  if (smallBusiness !== null) await saveTaxSettings(db, ctx, { smallBusiness });
  return { ws, ctx };
}

const invoice = (overrides: Record<string, unknown> = {}) => ({
  number: 'R-2026-001',
  issueDate: '2026-03-01',
  grossCents: 100_000,
  vatCents: 0,
  treatment: 'small_business',
  declaredInYear: null,
  payments: [{ date: '2026-03-20', cents: 100_000 }],
  ...overrides,
});

const receipt = (overrides: Record<string, string | number> = {}) => ({
  Name: 'Rechnung Software',
  Vendor: 'Werkzeug Beispiel',
  Gross: 119,
  Net: 100,
  Date: '2026-02-10',
  Category: 'Software & Lizenzen',
  Zuordnung: 'Geschäftlich',
  Currency: 'EUR',
  'FX Rate': 1,
  ...overrides,
});

const code = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    if (e instanceof TaxServiceError || e instanceof RevenueInputError) return e.code;
    throw e;
  }
  return 'no error';
};

beforeAll(async () => {
  ({ ws: other, ctx: otherCtx } = await workspace());
});

afterAll(async () => {
  await db.$disconnect();
});

type View = Awaited<ReturnType<typeof loadStatement>>;
const line = (view: View, key: string) => view.lines.find((l) => l.key === key)?.cents ?? 0;

describe('revenue: forward, change, re-entry', () => {
  it('without any invoice revenue and profit are unknown, not zero', async () => {
    const { ws } = await workspace();
    await ws.addReceipt(receipt());
    const view = await loadStatement(db, ws.workspaceId, 2026);
    expect(view.revenue.recorded).toBe(false);
    expect(view.profitCents).toBeNull();
    expect(view.forecast.previousYearWithinLimit).toBeNull();
  });

  it('an invoice counts when its money arrives, and profit follows', async () => {
    const { ws, ctx } = await workspace();
    await ws.addReceipt(receipt());
    const id = await saveInvoice(db, ctx, null, invoice({ payments: [] }));
    let view = await loadStatement(db, ws.workspaceId, 2026);
    expect(view.revenue).toMatchObject({ recorded: true, receivedCents: 0, outstandingCents: 100_000 });
    expect(view.profitCents).toBe(-11_900);
    expect(view.revenue.invoices[0]).toMatchObject({ id, number: 'R-2026-001', outstandingCents: 100_000, checks: [] });

    await saveInvoice(db, ctx, id, invoice());
    view = await loadStatement(db, ws.workspaceId, 2026);
    expect(line(view, 'euer.revenue_small_business')).toBe(100_000);
    expect(view.revenue).toMatchObject({ receivedCents: 100_000, outstandingCents: 0 });
    expect(view.profitCents).toBe(100_000 - 11_900);
    const stored = await db.taxIssuedInvoice.findUnique({ where: { id }, include: { payments: true } });
    expect(stored).toMatchObject({ authWorkspaceId: ws.workspaceId, authTenantId: ws.tenantId });
    expect(stored?.payments[0]).toMatchObject({ authWorkspaceId: ws.workspaceId, authTenantId: ws.tenantId });
  });

  it('changing the payments replaces them as one set; changing back restores the figures', async () => {
    const { ws, ctx } = await workspace();
    const id = await saveInvoice(db, ctx, null, invoice());
    const before = await loadStatement(db, ws.workspaceId, 2026);
    await saveInvoice(db, ctx, id, invoice({ payments: [{ date: '2026-03-20', cents: 40_000 }, { date: '2027-01-10', cents: 60_000 }] }));
    const split = await loadStatement(db, ws.workspaceId, 2026);
    expect(line(split, 'euer.revenue_small_business')).toBe(40_000);
    expect(split.revenue.outstandingCents).toBe(60_000);
    expect(line(await loadStatement(db, ws.workspaceId, 2027), 'euer.revenue_small_business')).toBe(60_000);
    expect(await db.taxInvoicePayment.count({ where: { invoiceId: id } })).toBe(2);

    await saveInvoice(db, ctx, id, invoice());
    const after = await loadStatement(db, ws.workspaceId, 2026);
    expect(after.lines).toEqual(before.lines);
    expect(await db.taxInvoicePayment.count({ where: { invoiceId: id } })).toBe(1);
  });

  it('an invoice another return declared is no revenue again, and deleting an invoice takes its payments along', async () => {
    const { ws, ctx } = await workspace();
    const id = await saveInvoice(db, ctx, null, invoice({ declaredInYear: 2025 }));
    const view = await loadStatement(db, ws.workspaceId, 2026);
    expect(view.businessRevenueCents).toBe(0);
    expect(view.revenue.turnoverCents).toBe(100_000);
    expect(view.revenue.invoices[0]).toMatchObject({ excludedCents: 100_000 });
    await deleteInvoice(db, ctx, id);
    expect(await db.taxInvoicePayment.count({ where: { invoiceId: id } })).toBe(0);
    expect((await loadStatement(db, ws.workspaceId, 2026)).revenue.recorded).toBe(false);
  });

  it('rejects malformed invoices and a number that is taken, and writes nothing', async () => {
    const { ws, ctx } = await workspace();
    await saveInvoice(db, ctx, null, invoice());
    expect(await code(saveInvoice(db, ctx, null, invoice()))).toBe('invoice_number_taken');
    expect(await code(saveInvoice(db, ctx, null, invoice({ number: ' ' })))).toBe('number_required');
    expect(await code(saveInvoice(db, ctx, null, invoice({ number: 'B', grossCents: 0 })))).toBe('invalid_amount');
    expect(await code(saveInvoice(db, ctx, null, invoice({ number: 'B', treatment: 'standard' })))).toBe('invalid_vat');
    expect(await code(saveInvoice(db, ctx, null, invoice({ number: 'B', vatCents: 1900 })))).toBe('vat_without_treatment');
    expect(await code(saveInvoice(db, ctx, null, invoice({ number: 'B', payments: [{ date: '2026-02-30', cents: 1 }] })))).toBe('invalid_payment');
    expect(await db.taxIssuedInvoice.count({ where: { authWorkspaceId: ws.workspaceId } })).toBe(1);
  });
});

describe('the forecast of the small-business limits', () => {
  it('uses the previous year from the invoices and the owner\'s own expectation when stated', async () => {
    const { ws, ctx } = await workspace();
    await saveInvoice(db, ctx, null, invoice({ number: 'A', issueDate: '2025-06-01', grossCents: 2_600_000, payments: [{ date: '2025-06-20', cents: 2_600_000 }] }));
    await saveInvoice(db, ctx, null, invoice({ number: 'B' }));
    let view = await loadStatement(db, ws.workspaceId, 2026);
    // 26,000.00 in 2025 is above the limit that decides 2026.
    expect(view.forecast.previousYearWithinLimit).toBe(false);
    expect(view.limits).toMatchObject({ previousYearLimitCents: 2_500_000, currentYearLimitCents: 10_000_000 });

    await saveRevenueExpectation(db, ctx, 500_000);
    view = await loadStatement(db, ws.workspaceId, 2026);
    expect(view.expectedMonthlyRevenueCents).toBe(500_000);
    expect(view.forecast).toMatchObject({ rateBasis: 'stated', monthlyRateCents: 500_000 });
    await saveRevenueExpectation(db, ctx, null);
    expect((await loadStatement(db, ws.workspaceId, 2026)).expectedMonthlyRevenueCents).toBeNull();
    expect(await code(saveRevenueExpectation(db, ctx, -1))).toBe('invalid_expectation');
  });
});

describe('status over time and regular taxation', () => {
  it('a change from a day on leaves earlier receipts on their basis and computes later ones net with input tax', async () => {
    const { ws, ctx } = await workspace();
    const before = await ws.addReceipt(receipt({ Date: '2026-02-10' }));
    const after = await ws.addReceipt(receipt({ Date: '2026-09-10' }));
    const base = await loadStatement(db, ws.workspaceId, 2026);
    expect(line(base, 'euer.work_equipment')).toBe(23_800);
    expect(base.vat).toMatchObject({ applies: false, undeductedInputVatCents: 3_800 });

    await saveStatusChange(db, ctx, { effectiveFrom: '2026-07-01', smallBusiness: false });
    const view = await loadStatement(db, ws.workspaceId, 2026);
    expect(view.items.find((i) => i.rowId === before)?.parts.map((p) => [p.lineKey, p.cents])).toEqual([['euer.work_equipment', 11_900]]);
    expect(view.items.find((i) => i.rowId === after)?.parts.map((p) => [p.lineKey, p.cents])).toEqual([
      ['euer.work_equipment', 10_000],
      ['euer.input_vat', 1_900],
    ]);
    expect(view).toMatchObject({ smallBusinessAtYearEnd: false, smallBusiness: true });
    expect(view.vat.applies).toBe(true);
    expect(view.statusChanges).toHaveLength(1);

    // Taking the change back restores the year exactly.
    await deleteStatusChange(db, ctx, view.statusChanges[0].id);
    expect((await loadStatement(db, ws.workspaceId, 2026)).lines).toEqual(base.lines);
  });

  it('a receipt without a net amount under regular taxation waits in the queue', async () => {
    const { ws } = await workspace(false);
    const rowId = await ws.addReceipt(receipt({ Net: 0 }));
    const view = await loadStatement(db, ws.workspaceId, 2026);
    expect(view.items.find((i) => i.rowId === rowId)?.checks.map((c) => c.kind)).toEqual(['net_amount_missing']);
    expect(view.businessExpenseCents).toBe(0);
  });

  it('periods are computed only once frequency and method are set, by either method', async () => {
    const { ws, ctx } = await workspace(false);
    await ws.addReceipt(receipt({ Date: '2026-01-15' }));
    await saveInvoice(db, ctx, null, invoice({ treatment: 'standard', grossCents: 119_000, vatCents: 19_000, issueDate: '2026-03-30', payments: [{ date: '2026-04-10', cents: 119_000 }] }));
    let view = await loadStatement(db, ws.workspaceId, 2026);
    expect(view.vat).toMatchObject({ applies: true, frequency: null, method: null, year: null });
    expect(line(view, 'euer.revenue_taxable')).toBe(100_000);
    expect(line(view, 'euer.vat_received')).toBe(19_000);

    await saveVatSettings(db, ctx, { frequency: 'quarterly', method: 'issued' });
    view = await loadStatement(db, ws.workspaceId, 2026);
    expect(view.vat.year?.periods.map((p) => p.dueCents)).toEqual([19_000 - 1_900, 0, 0, 0]);
    await saveVatSettings(db, ctx, { frequency: 'quarterly', method: 'received' });
    view = await loadStatement(db, ws.workspaceId, 2026);
    expect(view.vat.year?.periods.map((p) => p.dueCents)).toEqual([-1_900, 19_000, 0, 0]);
    expect(await code(saveVatSettings(db, ctx, { frequency: 'weekly', method: 'issued' }))).toBe('invalid_vat_settings');
    // Setting the frequency did not touch the section 19 answer.
    expect((await getTaxSettings(db, ws.workspaceId)).smallBusiness).toBe(false);
  });

  it('tax paid to the tax office and refunds are lines of their year, and can be removed', async () => {
    const { ws, ctx } = await workspace(false);
    await saveInvoice(db, ctx, null, invoice({ treatment: 'standard', grossCents: 119_000, vatCents: 19_000 }));
    const paid = await saveVatSettlement(db, ctx, { date: '2026-05-10', cents: 17_100, direction: 'paid' });
    await saveVatSettlement(db, ctx, { date: '2026-08-10', cents: 500, direction: 'refunded' });
    let view = await loadStatement(db, ws.workspaceId, 2026);
    expect(line(view, 'euer.vat_paid')).toBe(17_100);
    expect(line(view, 'euer.vat_refunded')).toBe(500);
    expect(view.vat.settlements).toHaveLength(2);
    await deleteVatSettlement(db, ctx, paid);
    view = await loadStatement(db, ws.workspaceId, 2026);
    expect(line(view, 'euer.vat_paid')).toBe(0);
    expect(await code(saveVatSettlement(db, ctx, { date: '2026-05-10', cents: 0, direction: 'paid' }))).toBe('invalid_settlement');
  });

  it('the meal register follows the same dated status as the statement', async () => {
    const { ws, ctx } = await workspace();
    const rowId = await ws.addReceipt({ Name: 'Essen', Vendor: 'Testlokal', Gross: 119, Net: 100, 'Tax Rate': 19, Date: '2026-09-10', Category: 'Bewirtung', Zuordnung: 'Geschäftlich', Currency: 'EUR', 'FX Rate': 1 });
    await saveStatusChange(db, ctx, { effectiveFrom: '2026-07-01', smallBusiness: false });
    const settings = await getTaxSettings(db, ws.workspaceId);
    expect(settings.statusChanges).toEqual([{ effectiveFrom: '2026-07-01', smallBusiness: false }]);
    const record = await loadMealRecord(db, ws.workspaceId, rowId);
    expect(mealDeduction(record!, settings)).toMatchObject({ kind: 'ok', basis: 'net' });
    expect(mealDeduction({ ...record!, date: '2026-03-10' }, settings)).toMatchObject({ kind: 'ok', basis: 'gross' });
  });

  it('a change needs the first answer, a real date, and corrects an entry on the same day', async () => {
    const { ws, ctx } = await workspace(null);
    expect(await code(saveStatusChange(db, ctx, { effectiveFrom: '2026-07-01', smallBusiness: false }))).toBe('status_unanswered');
    await saveTaxSettings(db, ctx, { smallBusiness: true });
    expect(await code(saveStatusChange(db, ctx, { effectiveFrom: '2026-02-30', smallBusiness: false }))).toBe('invalid_status');
    await saveStatusChange(db, ctx, { effectiveFrom: '2026-07-01', smallBusiness: false });
    await saveStatusChange(db, ctx, { effectiveFrom: '2026-07-01', smallBusiness: true });
    expect(await db.taxStatusChange.count({ where: { authWorkspaceId: ws.workspaceId } })).toBe(1);
    expect((await loadStatement(db, ws.workspaceId, 2026)).smallBusinessAtYearEnd).toBe(true);
  });
});

describe('workspace isolation', () => {
  it('invoices, status changes and settlements of another workspace do not exist here', async () => {
    const { ws, ctx } = await workspace();
    const foreignInvoice = await saveInvoice(db, otherCtx, null, invoice({ number: 'FREMD-1' }));
    await saveStatusChange(db, otherCtx, { effectiveFrom: '2026-07-01', smallBusiness: false });
    const foreignSettlement = await saveVatSettlement(db, otherCtx, { date: '2026-05-10', cents: 100, direction: 'paid' });
    const foreignChange = (await loadStatement(db, other.workspaceId, 2026)).statusChanges[0].id;

    const mine = await loadStatement(db, ws.workspaceId, 2026);
    expect(mine.revenue.recorded).toBe(false);
    expect(mine.statusChanges).toEqual([]);
    expect(mine.smallBusinessAtYearEnd).toBe(true);
    expect(mine.vat.settlements).toEqual([]);

    expect(await code(saveInvoice(db, ctx, foreignInvoice, invoice({ number: 'FREMD-1' })))).toBe('invoice_not_found');
    expect(await code(deleteInvoice(db, ctx, foreignInvoice))).toBe('invoice_not_found');
    expect(await code(deleteStatusChange(db, ctx, foreignChange))).toBe('status_not_found');
    expect(await code(deleteVatSettlement(db, ctx, foreignSettlement))).toBe('settlement_not_found');
    // The same invoice number may exist in two workspaces. Counted over these two only:
    // the test database is not emptied between runs, so earlier runs left the number behind.
    await saveInvoice(db, ctx, null, invoice({ number: 'FREMD-1' }));
    expect(
      await db.taxIssuedInvoice.count({
        where: { number: 'FREMD-1', authWorkspaceId: { in: [ws.workspaceId, other.workspaceId] } },
      }),
    ).toBe(2);
  });
});
