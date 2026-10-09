import { describe, expect, it } from 'vitest';
import type { AssetFact } from '../assets';
import { computeYear } from '../compute';
import { rulesForYear } from '../rules';
import type { InvoiceFact, LedgerItem, VatSettlementFact, YearFacts } from '../types';
import { vatYear } from '../vat';
import { item } from './fixtures';

const run = (facts: Partial<YearFacts>, year = 2026) => computeYear({ year, items: [], ...facts }, rulesForYear(year));
const cents = (result: ReturnType<typeof run>, key: string) => result.lines.find((l) => l.key === key)?.cents ?? 0;

/** An invented invoice over 1,000.00 issued and paid in 2026 by a small business. */
function invoice(overrides: Partial<InvoiceFact> = {}): InvoiceFact {
  return {
    id: 'inv-1',
    number: '2026-001',
    issueDate: '2026-03-01',
    grossCents: 100_000,
    vatCents: 0,
    treatment: 'small_business',
    payments: [{ date: '2026-03-20', cents: 100_000 }],
    declaredInYear: null,
    smallBusinessOnIssue: true,
    ...overrides,
  };
}

describe('revenue: cash basis', () => {
  it('counts an invoice in the year its money arrived, on the small-business line', () => {
    const result = run({ invoices: [invoice()] });
    expect(result.lines).toEqual([expect.objectContaining({ key: 'euer.revenue_small_business', line: 12, cents: 100_000 })]);
    expect(result.revenue).toMatchObject({ recorded: true, receivedCents: 100_000, turnoverCents: 100_000, outstandingCents: 0 });
    expect(result.revenue.turnoverByMonthCents[2]).toBe(100_000);
    expect(result.profitCents).toBe(100_000);
  });

  it('an invoice issued in December and paid in January is revenue of the new year and outstanding in the old', () => {
    const late = invoice({ issueDate: '2025-12-10', payments: [{ date: '2026-01-08', cents: 100_000 }] });
    const old = run({ invoices: [late] }, 2025);
    expect(old.businessRevenueCents).toBe(0);
    expect(old.revenue.outstandingCents).toBe(100_000);
    const next = run({ invoices: [late] }, 2026);
    expect(next.businessRevenueCents).toBe(100_000);
    expect(next.revenue.outstandingCents).toBe(0);
  });

  it('an unpaid invoice is outstanding and no revenue', () => {
    const result = run({ invoices: [invoice({ payments: [] })] });
    expect(result.lines).toEqual([]);
    expect(result.revenue).toMatchObject({ receivedCents: 0, outstandingCents: 100_000 });
    expect(result.profitCents).toBe(0);
  });

  it('partial payments count as they arrive, also across years', () => {
    const partial = invoice({ payments: [{ date: '2026-11-30', cents: 40_000 }, { date: '2027-01-15', cents: 60_000 }] });
    expect(run({ invoices: [partial] }).businessRevenueCents).toBe(40_000);
    expect(run({ invoices: [partial] }).revenue.outstandingCents).toBe(60_000);
    expect(run({ invoices: [partial] }, 2027).businessRevenueCents).toBe(60_000);
  });

  it('an invoice another year\'s return already declared is no revenue again, but still turnover for the limits', () => {
    const declared = invoice({ declaredInYear: 2025 });
    const result = run({ invoices: [declared] });
    expect(result.businessRevenueCents).toBe(0);
    expect(result.revenue.turnoverCents).toBe(100_000);
    expect(result.revenue.invoices[0]).toMatchObject({ receivedCents: 100_000, excludedCents: 100_000, parts: [] });
  });

  it('says nothing about profit while invoices are not recorded at all', () => {
    const result = run({ items: [item({ id: 'x', date: '2026-02-01' })] });
    expect(result.revenue.recorded).toBe(false);
    expect(result.profitCents).toBeNull();
  });

  it('profit is revenue minus expenses, and can be a loss', () => {
    const result = run({ invoices: [invoice({ grossCents: 5_000, payments: [{ date: '2026-03-20', cents: 5_000 }] })], items: [item({ id: 'x', date: '2026-02-01' })] });
    expect(result.profitCents).toBe(5_000 - 10_000);
  });

  it('flags an overpaid invoice and an invoice without a date, and still counts the money', () => {
    const result = run({ invoices: [invoice({ issueDate: null, payments: [{ date: '2026-03-20', cents: 100_500 }] })] });
    expect(result.revenue.invoices[0].checks).toEqual(['invoice_no_date', 'invoice_overpaid']);
    expect(result.businessRevenueCents).toBe(100_500);
  });
});

describe('revenue: invoices with value-added tax', () => {
  const taxed = (overrides: Partial<InvoiceFact> = {}) =>
    invoice({ treatment: 'standard', grossCents: 119_000, vatCents: 19_000, smallBusinessOnIssue: false, payments: [{ date: '2026-03-20', cents: 119_000 }], ...overrides });

  it('splits the money into the net revenue and the tax received', () => {
    const result = run({ invoices: [taxed()] });
    expect(result.lines.map((l) => [l.line, l.key, l.cents])).toEqual([
      [15, 'euer.revenue_taxable', 100_000],
      [17, 'euer.vat_received', 19_000],
    ]);
    // The limits measure turnover without the tax in it.
    expect(result.revenue.turnoverCents).toBe(100_000);
    expect(result.revenue.receivedCents).toBe(119_000);
  });

  it('partial payments add up to exactly the tax on the invoice', () => {
    const thirds = taxed({ grossCents: 100_000, vatCents: 15_966, payments: [{ date: '2026-03-01', cents: 33_333 }, { date: '2026-04-01', cents: 33_333 }, { date: '2026-05-01', cents: 33_334 }] });
    const result = run({ invoices: [thirds] });
    expect(cents(result, 'euer.vat_received')).toBe(15_966);
    expect(cents(result, 'euer.revenue_taxable')).toBe(100_000 - 15_966);
    expect(result.outputVatByPayment.map((e) => e.cents).reduce((s, c) => s + c, 0)).toBe(15_966);
  });

  it('reports an invoice whose tax treatment does not fit the status on its date, and computes it as issued', () => {
    const noTaxUnderRegular = invoice({ smallBusinessOnIssue: false });
    const taxUnderSmallBusiness = taxed({ id: 'inv-2', smallBusinessOnIssue: true });
    const result = run({ invoices: [noTaxUnderRegular, taxUnderSmallBusiness] });
    expect(result.revenue.invoices.map((i) => i.checks)).toEqual([['invoice_treatment_mismatch'], ['invoice_treatment_mismatch']]);
    // Tax shown on an invoice is owed, also when it was shown in error.
    expect(cents(result, 'euer.vat_received')).toBe(19_000);
  });

  it('revenue the client owes the tax on goes to its own line', () => {
    const result = run({ invoices: [invoice({ treatment: 'not_taxable', smallBusinessOnIssue: false })] });
    expect(result.lines.map((l) => [l.line, l.key])).toEqual([[16, 'euer.revenue_not_taxable']]);
  });
});

describe('regular taxation: receipts', () => {
  const regular = (overrides: Partial<LedgerItem> = {}) =>
    item({ id: 'x', date: '2026-02-01', smallBusiness: false, amountCents: 11_900, netCents: 10_000, ...overrides });

  it('the net amount is the expense and the tax is input tax', () => {
    const result = run({ items: [regular()] });
    expect(result.lines.map((l) => [l.line, l.key, l.cents])).toEqual([
      [52, 'euer.work_equipment', 10_000],
      [58, 'euer.input_vat', 1_900],
    ]);
    expect(result.inputVatEvents).toEqual([{ date: '2026-02-01', cents: 1_900, source: 'item', id: 'x' }]);
  });

  it('only the business share of the tax is input tax; the study share keeps its tax as cost', () => {
    const result = run({
      items: [regular({ employmentLineKey: 'employment.study_costs', allocations: [{ purpose: 'business', shareBp: 5000 }, { purpose: 'study', shareBp: 3000 }] })],
    });
    expect(cents(result, 'euer.work_equipment')).toBe(5_000);
    expect(cents(result, 'euer.input_vat')).toBe(950);
    // 30 percent of the gross amount.
    expect(cents(result, 'employment.study_costs')).toBe(3_570);
    expect(result.items[0].privateCents).toBe(11_900 - 5_000 - 950 - 3_570);
  });

  it('without a net amount the receipt waits instead of being computed on the gross amount', () => {
    const result = run({ items: [regular({ netCents: null })] });
    expect(result.checks.map((c) => c.kind)).toEqual(['net_amount_missing']);
    expect(result.lines).toEqual([]);
  });

  it('a private receipt needs no net amount', () => {
    const result = run({ items: [regular({ netCents: null, formLineKey: null, allocations: [{ purpose: 'private', shareBp: 10000 }] })] });
    expect(result.checks).toEqual([]);
  });

  it('a meal takes the register\'s net figures and its input tax in full', () => {
    const result = run({
      items: [regular({ formLineKey: 'euer.meals', netCents: null, meal: { status: 'complete', deductibleCents: 7_000, nonDeductibleCents: 3_000, inputVatCents: 1_900 } })],
    });
    expect(cents(result, 'euer.meals')).toBe(7_000);
    expect(cents(result, 'euer.input_vat')).toBe(1_900);
  });

  it('a year with a status change computes each receipt on the basis of its own date', () => {
    const result = run({
      items: [
        item({ id: 'before', date: '2026-03-01', smallBusiness: true, amountCents: 11_900, netCents: 10_000 }),
        regular({ id: 'after', date: '2026-09-01' }),
      ],
    });
    expect(cents(result, 'euer.work_equipment')).toBe(11_900 + 10_000);
    expect(cents(result, 'euer.input_vat')).toBe(1_900);
  });

  it('the low-value limit is tested on the net amount', () => {
    const lowValue = (amountCents: number, netCents: number) =>
      run({ items: [regular({ formLineKey: 'euer.low_value_assets', amountCents, netCents })] }).checks.map((c) => c.kind);
    expect(lowValue(95_200, 80_000)).toEqual([]);
    expect(lowValue(95_201, 80_001)).toEqual(['needs_asset']);
  });
});

describe('regular taxation: assets and settlements', () => {
  const asset = (overrides: Partial<AssetFact> = {}): AssetFact => ({
    id: 'a-1',
    label: 'Kamera',
    kind: 'movable',
    acquisitionDate: '2026-03-10',
    costCents: 178_500,
    netCostCents: 150_000,
    method: 'linear',
    usefulLifeMonths: 60,
    decliningRateBp: null,
    businessShareBp: 10_000,
    reminderCents: 0,
    opening: null,
    disposal: null,
    smallBusiness: false,
    ...overrides,
  });

  it('an asset is written off from its net cost; the tax is input tax of the purchase year only', () => {
    const first = run({ assets: [asset()] });
    // March to December: 10 of 60 months of 1,500.00.
    expect(cents(first, 'euer.depreciation_movable')).toBe(25_000);
    expect(cents(first, 'euer.input_vat')).toBe(28_500);
    expect(first.inputVatEvents).toEqual([{ date: '2026-03-10', cents: 28_500, source: 'asset', id: 'a-1' }]);
    const second = run({ assets: [asset()] }, 2027);
    expect(cents(second, 'euer.depreciation_movable')).toBe(30_000);
    expect(cents(second, 'euer.input_vat')).toBe(0);
  });

  it('a partly private asset deducts the tax at its business share', () => {
    expect(cents(run({ assets: [asset({ businessShareBp: 6_000 })] }), 'euer.input_vat')).toBe(17_100);
  });

  it('an asset bought under the small-business rule and kept under regular taxation asks for a look at the input tax', () => {
    const bought = asset({ smallBusiness: true });
    const same = run({ assets: [bought], smallBusinessAtYearEnd: true });
    expect(same.assetChecks).toEqual([]);
    const changed = run({ assets: [bought], smallBusinessAtYearEnd: false });
    expect(changed.assetChecks).toEqual([{ assetId: 'a-1', kind: 'asset_input_tax_correction_review', blocking: false }]);
    // A note, not a block: the asset is still written off (from its gross cost, as bought).
    expect(changed.assets[0].counted).toBe(true);
    expect(cents(changed, 'euer.depreciation_movable')).toBe(29_750);
  });

  it('tax paid to the tax office is an expense, a refund is revenue, each in its year', () => {
    const settlements: VatSettlementFact[] = [
      { id: 's1', date: '2026-05-10', cents: 40_000, direction: 'paid' },
      { id: 's2', date: '2026-08-10', cents: 5_000, direction: 'refunded' },
      { id: 's3', date: '2027-01-10', cents: 99_999, direction: 'paid' },
    ];
    const result = run({ vatSettlements: settlements, invoices: [] });
    expect(result.lines.map((l) => [l.line, l.key, l.cents])).toEqual([
      [18, 'euer.vat_refunded', 5_000],
      [59, 'euer.vat_paid', 40_000],
    ]);
    expect(result.profitCents).toBe(5_000 - 40_000);
  });
});

describe('vatYear: advance return periods', () => {
  const events = {
    inputVat: [
      { date: '2026-01-15', cents: 1_900, source: 'item' as const, id: 'r1' },
      { date: '2026-04-02', cents: 28_500, source: 'asset' as const, id: 'a1' },
      { date: '2025-12-31', cents: 77_777, source: 'item' as const, id: 'other-year' },
    ],
    outputVatByIssue: [{ date: '2026-03-30', cents: 19_000, source: 'invoice' as const, id: 'i1' }],
    outputVatByPayment: [{ date: '2026-04-10', cents: 19_000, source: 'invoice' as const, id: 'i1' }],
  };

  it('by issue date the tax is owed in the quarter the invoice was written', () => {
    const year = vatYear(2026, 'quarterly', 'issued', events);
    expect(year.periods.map((p) => [p.index, p.from, p.to, p.outputVatCents, p.inputVatCents, p.dueCents])).toEqual([
      [1, '2026-01-01', '2026-03-31', 19_000, 1_900, 17_100],
      [2, '2026-04-01', '2026-06-30', 0, 28_500, -28_500],
      [3, '2026-07-01', '2026-09-30', 0, 0, 0],
      [4, '2026-10-01', '2026-12-31', 0, 0, 0],
    ]);
    expect(year).toMatchObject({ outputVatCents: 19_000, inputVatCents: 30_400, dueCents: -11_400 });
  });

  it('by payment date the same tax moves to the quarter the client paid', () => {
    const year = vatYear(2026, 'quarterly', 'received', events);
    expect(year.periods.map((p) => p.dueCents)).toEqual([-1_900, -9_500, 0, 0]);
    // The year total is the same either way when everything is paid within the year.
    expect(year.dueCents).toBe(-11_400);
  });

  it('monthly periods end on the last day of each month, leap years included', () => {
    const year = vatYear(2028, 'monthly', 'issued', { inputVat: [], outputVatByIssue: [], outputVatByPayment: [] });
    expect(year.periods).toHaveLength(12);
    expect(year.periods[1]).toMatchObject({ from: '2028-02-01', to: '2028-02-29' });
    expect(year.periods[11]).toMatchObject({ from: '2028-12-01', to: '2028-12-31' });
  });

  it('keeps the events behind each figure and ignores other years', () => {
    const year = vatYear(2026, 'monthly', 'issued', events);
    expect(year.periods[0].input.map((e) => e.id)).toEqual(['r1']);
    expect(year.periods[2].output.map((e) => e.id)).toEqual(['i1']);
    expect(year.inputVatCents).toBe(30_400);
  });
});
