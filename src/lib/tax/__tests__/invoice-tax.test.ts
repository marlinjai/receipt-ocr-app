import { describe, expect, it } from 'vitest';
import { computeYear } from '../compute';
import { invoiceTaxGroups, splitPayment, taxAt, taxDeviationAllowed } from '../invoice-tax';
import { RevenueInputError, parseTaxGroups, validateInvoiceInput } from '../revenue-input';
import { rulesForYear } from '../rules';
import type { InvoiceFact, TaxGroup, YearFacts } from '../types';
import { vatYear } from '../vat';

const run = (facts: Partial<YearFacts>, year = 2026) => computeYear({ year, items: [], ...facts }, rulesForYear(year));
const cents = (result: ReturnType<typeof run>, key: string) => result.lines.find((l) => l.key === key)?.cents ?? 0;

/**
 * An invented invoice under regular taxation with a 19 percent and a 7 percent
 * part: 1,000.00 net at 19 percent (190.00 tax) and 500.00 net at 7 percent
 * (35.00 tax), 1,725.00 in total.
 */
const GROUPS: TaxGroup[] = [
  { rateBp: 1900, netCents: 100_000, vatCents: 19_000 },
  { rateBp: 700, netCents: 50_000, vatCents: 3_500 },
];
function mixed(overrides: Partial<InvoiceFact> = {}): InvoiceFact {
  return {
    id: 'inv-m',
    number: '2026-010',
    issueDate: '2026-02-20',
    grossCents: 172_500,
    vatCents: 22_500,
    treatment: 'mixed',
    taxGroups: GROUPS,
    payments: [{ date: '2026-04-05', cents: 172_500 }],
    declaredInYear: null,
    smallBusinessOnIssue: false,
    ...overrides,
  };
}

describe('invoiceTaxGroups', () => {
  it('an invoice at one rate has one group from its own total and tax, nothing stored', () => {
    expect(invoiceTaxGroups({ treatment: 'standard', grossCents: 11_900, vatCents: 1_900, issueDate: '2026-01-01', taxGroups: null })).toEqual([
      { rateBp: 1900, netCents: 10_000, vatCents: 1_900 },
    ]);
    expect(invoiceTaxGroups({ treatment: 'reduced', grossCents: 10_700, vatCents: 700, issueDate: '2026-01-01' })).toEqual([
      { rateBp: 700, netCents: 10_000, vatCents: 700 },
    ]);
  });

  it('names the lowered rates of the second half of 2020 for an invoice of that time', () => {
    expect(invoiceTaxGroups({ treatment: 'standard', grossCents: 11_600, vatCents: 1_600, issueDate: '2020-09-01' })[0].rateBp).toBe(1600);
    expect(invoiceTaxGroups({ treatment: 'reduced', grossCents: 10_500, vatCents: 500, issueDate: '2020-12-31' })[0].rateBp).toBe(500);
    expect(invoiceTaxGroups({ treatment: 'standard', grossCents: 11_900, vatCents: 1_900, issueDate: '2021-01-01' })[0].rateBp).toBe(1900);
  });

  it('an invoice without tax has no group', () => {
    for (const treatment of ['small_business', 'not_taxable'] as const) {
      expect(invoiceTaxGroups({ treatment, grossCents: 10_000, vatCents: 0, issueDate: '2026-01-01' })).toEqual([]);
    }
  });

  it('a mixed invoice keeps its groups, highest rate first', () => {
    const reversed = [...GROUPS].reverse();
    expect(invoiceTaxGroups(mixed({ taxGroups: reversed })).map((g) => g.rateBp)).toEqual([1900, 700]);
  });

  it('a mixed invoice without readable groups keeps its stated tax under no rate', () => {
    expect(invoiceTaxGroups(mixed({ taxGroups: null }))).toEqual([{ rateBp: 0, netCents: 150_000, vatCents: 22_500 }]);
  });
});

describe('splitPayment', () => {
  it('a full payment is exactly the groups', () => {
    expect(splitPayment(GROUPS, 172_500, 0, 172_500)).toEqual({
      parts: [
        { rateBp: 1900, netCents: 100_000, vatCents: 19_000 },
        { rateBp: 700, netCents: 50_000, vatCents: 3_500 },
      ],
      excessCents: 0,
    });
  });

  it('partial payments of odd amounts add up to exactly the groups, cent for cent', () => {
    const payments = [33_333, 77_777, 1, 61_389];
    let paid = 0;
    const sums = new Map<number, { net: number; vat: number }>();
    for (const p of payments) {
      const { parts, excessCents } = splitPayment(GROUPS, 172_500, paid, p);
      for (const part of parts) {
        const s = sums.get(part.rateBp) ?? { net: 0, vat: 0 };
        sums.set(part.rateBp, { net: s.net + part.netCents, vat: s.vat + part.vatCents });
        // Never more tax than money in a group's share of one payment.
        expect(part.netCents).toBeGreaterThanOrEqual(0);
      }
      expect(excessCents).toBe(0);
      expect(parts.reduce((s, x) => s + x.netCents + x.vatCents, 0)).toBe(p);
      paid += p;
    }
    expect(paid).toBe(172_500);
    expect(sums.get(1900)).toEqual({ net: 100_000, vat: 19_000 });
    expect(sums.get(700)).toEqual({ net: 50_000, vat: 3_500 });
  });

  it('money above the total belongs to no rate', () => {
    expect(splitPayment(GROUPS, 172_500, 0, 180_000)).toEqual({
      parts: [
        { rateBp: 1900, netCents: 100_000, vatCents: 19_000 },
        { rateBp: 700, netCents: 50_000, vatCents: 3_500 },
      ],
      excessCents: 7_500,
    });
    // A payment entirely after the invoice was paid in full.
    expect(splitPayment(GROUPS, 172_500, 172_500, 1_000)).toEqual({
      parts: [
        { rateBp: 1900, netCents: 0, vatCents: 0 },
        { rateBp: 700, netCents: 0, vatCents: 0 },
      ],
      excessCents: 1_000,
    });
  });

  it('one-cent payments: a group never holds more tax than money so far, and a single cent may move between net and tax', () => {
    // Rounding the tax and the gross share each to the cent can give one tiny
    // payment -0.01 turnover against +0.01 tax in a group; the running totals
    // stay exact and never show more tax than money.
    let paid = 0;
    const sum = new Map<number, { net: number; vat: number }>();
    for (let i = 0; i < 50; i++) {
      const { parts } = splitPayment(GROUPS, 172_500, paid, 1);
      for (const part of parts) {
        expect(Math.abs(part.netCents), `payment ${i}`).toBeLessThanOrEqual(1);
        const s = sum.get(part.rateBp) ?? { net: 0, vat: 0 };
        sum.set(part.rateBp, { net: s.net + part.netCents, vat: s.vat + part.vatCents });
        expect(sum.get(part.rateBp)!.net, `payment ${i}`).toBeGreaterThanOrEqual(0);
      }
      paid += 1;
    }
  });

  it('for an invoice at one rate it gives the same tax per payment as before groups existed', () => {
    // The formula the statement used before: the tax share of what was paid so
    // far, capped at the tax, as differences of cumulative figures.
    const before = (vat: number, gross: number, paidBefore: number, payment: number) => {
      const share = (paid: number) => Math.min(vat, Math.round((vat * Math.min(paid, gross)) / gross));
      return share(paidBefore + payment) - share(paidBefore);
    };
    for (const [gross, vat] of [[11_900, 1_900], [10_700, 700], [99_999, 15_966], [1, 0]]) {
      const groups = [{ rateBp: 1900, netCents: gross - vat, vatCents: vat }];
      let paid = 0;
      for (const payment of [Math.floor(gross / 3), Math.floor(gross / 7), gross]) {
        const { parts, excessCents } = splitPayment(groups, gross, paid, payment);
        expect(parts[0].vatCents).toBe(before(vat, gross, paid, payment));
        expect(parts[0].netCents + parts[0].vatCents + excessCents).toBe(payment);
        paid += payment;
      }
    }
  });
});

describe('validating a mixed invoice', () => {
  const base = { number: '2026-010', issueDate: '2026-02-20', grossCents: 172_500, vatCents: 22_500, treatment: 'mixed', taxGroups: GROUPS, payments: [] };
  const code = (raw: unknown) => {
    try {
      validateInvoiceInput(raw);
      return null;
    } catch (e) {
      return (e as RevenueInputError).code;
    }
  };

  it('accepts groups that add up to the total and the tax', () => {
    expect(validateInvoiceInput(base)).toMatchObject({ treatment: 'mixed', taxGroups: GROUPS, vatCents: 22_500 });
  });

  it('refuses groups that do not add up, a tax that does not fit its rate, a repeated or unknown rate, or one group', () => {
    expect(code({ ...base, grossCents: 172_501 })).toBe('invalid_tax_groups');
    expect(code({ ...base, vatCents: 22_400 })).toBe('invalid_tax_groups');
    expect(code({ ...base, taxGroups: [GROUPS[0], { rateBp: 700, netCents: 50_000, vatCents: 3_600 }], grossCents: 172_600, vatCents: 22_600 })).toBe('invalid_tax_groups');
    expect(code({ ...base, taxGroups: [GROUPS[0], GROUPS[0]], grossCents: 238_000, vatCents: 38_000 })).toBe('invalid_tax_groups');
    expect(code({ ...base, taxGroups: [GROUPS[0], { rateBp: 1600, netCents: 50_000, vatCents: 8_000 }], grossCents: 177_000, vatCents: 27_000 })).toBe('invalid_tax_groups');
    expect(code({ ...base, taxGroups: [GROUPS[0]], grossCents: 119_000, vatCents: 19_000 })).toBe('invalid_tax_groups');
    expect(code({ ...base, taxGroups: null })).toBe('invalid_tax_groups');
  });

  it('accepts the stated tax of a group within one percent of net times rate, at least a cent, and refuses more', () => {
    expect(taxAt(33_333, 700)).toBe(2_333);
    expect(taxDeviationAllowed(100_000, 1900)).toBe(190);
    expect(taxDeviationAllowed(10, 700)).toBe(1);
    const second = { rateBp: 700, netCents: 50_000, vatCents: 3_500 };
    // Per-line rounding on a long invoice: a few cents off is accepted as stated.
    expect(parseTaxGroups([{ rateBp: 1900, netCents: 100_000, vatCents: 19_004 }, second])).not.toBeNull();
    expect(parseTaxGroups([{ rateBp: 1900, netCents: 100_000, vatCents: 19_190 }, second])).not.toBeNull();
    // A typing error is not.
    expect(parseTaxGroups([{ rateBp: 1900, netCents: 100_000, vatCents: 19_191 }, second])).toBeNull();
    expect(parseTaxGroups([{ rateBp: 1900, netCents: 100_000, vatCents: 1_900 }, second])).toBeNull();
  });

  it('an invoice at one rate carries no groups', () => {
    expect(code({ ...base, treatment: 'standard' })).toBe('invalid_tax_groups');
    expect(validateInvoiceInput({ ...base, treatment: 'standard', taxGroups: null }).taxGroups).toBeNull();
  });
});

describe('a mixed invoice in the statement and the advance return', () => {
  it('counts its net turnover and its tax on the statement like any taxed invoice', () => {
    const result = run({ invoices: [mixed()] });
    expect(cents(result, 'euer.revenue_taxable')).toBe(150_000);
    expect(cents(result, 'euer.vat_received')).toBe(22_500);
    expect(result.revenue.turnoverCents).toBe(150_000);
  });

  it('by issue date: each rate on its own in the period the invoice was written', () => {
    const result = run({ invoices: [mixed()] });
    expect(result.outputVatByIssue).toEqual([
      { date: '2026-02-20', cents: 19_000, source: 'invoice', id: 'inv-m', rateBp: 1900, netCents: 100_000 },
      { date: '2026-02-20', cents: 3_500, source: 'invoice', id: 'inv-m', rateBp: 700, netCents: 50_000 },
    ]);
    const year = vatYear(2026, 'quarterly', 'issued', { inputVat: [], outputVatByIssue: result.outputVatByIssue, outputVatByPayment: result.outputVatByPayment });
    expect(year.periods[0].outputByRate).toEqual([
      { rateBp: 1900, netCents: 100_000, vatCents: 19_000 },
      { rateBp: 700, netCents: 50_000, vatCents: 3_500 },
    ]);
    expect(year.periods[0].outputVatCents).toBe(22_500);
    expect(year.periods[1].outputByRate).toEqual([]);
  });

  it('by payment date: two partial payments in two quarters split per rate and add up to the invoice', () => {
    const result = run({ invoices: [mixed({ payments: [{ date: '2026-03-10', cents: 69_000 }, { date: '2026-05-10', cents: 103_500 }] })] });
    const year = vatYear(2026, 'quarterly', 'received', { inputVat: [], outputVatByIssue: result.outputVatByIssue, outputVatByPayment: result.outputVatByPayment });
    // 69,000 is 40 percent of the invoice.
    expect(year.periods[0].outputByRate).toEqual([
      { rateBp: 1900, netCents: 40_000, vatCents: 7_600 },
      { rateBp: 700, netCents: 20_000, vatCents: 1_400 },
    ]);
    expect(year.outputByRate).toEqual([
      { rateBp: 1900, netCents: 100_000, vatCents: 19_000 },
      { rateBp: 700, netCents: 50_000, vatCents: 3_500 },
    ]);
    expect(year.outputVatCents).toBe(22_500);
  });

  it('an invoice at one rate reports its whole turnover under that rate, with the same tax as before', () => {
    const single: InvoiceFact = { ...mixed(), id: 'inv-s', treatment: 'standard', taxGroups: null, grossCents: 119_000, vatCents: 19_000, payments: [{ date: '2026-04-05', cents: 119_000 }] };
    const result = run({ invoices: [single] });
    expect(result.outputVatByIssue).toEqual([{ date: '2026-02-20', cents: 19_000, source: 'invoice', id: 'inv-s', rateBp: 1900, netCents: 100_000 }]);
    expect(result.outputVatByPayment).toEqual([{ date: '2026-04-05', cents: 19_000, source: 'invoice', id: 'inv-s', rateBp: 1900, netCents: 100_000 }]);
    expect(cents(result, 'euer.revenue_taxable')).toBe(100_000);
    expect(cents(result, 'euer.vat_received')).toBe(19_000);
  });

  it('paid across two years: each year reports its own share per rate, together exactly the groups', () => {
    const across = mixed({ issueDate: '2025-12-15', payments: [{ date: '2025-12-30', cents: 50_000 }, { date: '2026-01-20', cents: 122_500 }] });
    const totals = new Map<number, { net: number; vat: number }>();
    for (const year of [2025, 2026]) {
      const result = run({ invoices: [across] }, year);
      for (const event of result.outputVatByPayment) {
        const t = totals.get(event.rateBp as number) ?? { net: 0, vat: 0 };
        totals.set(event.rateBp as number, { net: t.net + (event.netCents as number), vat: t.vat + event.cents });
      }
    }
    expect(totals.get(1900)).toEqual({ net: 100_000, vat: 19_000 });
    expect(totals.get(700)).toEqual({ net: 50_000, vat: 3_500 });
    // 50,000 of 172,500 in 2025.
    expect(run({ invoices: [across] }, 2025).outputVatByPayment.map((e) => [e.rateBp, e.netCents, e.cents])).toEqual([
      [1900, 28_986, 5_507],
      [700, 14_493, 1_014],
    ]);
  });

  it('an overpayment adds no turnover to any rate, and one-rate invoices behave the same', () => {
    const over = run({ invoices: [mixed({ payments: [{ date: '2026-04-05', cents: 180_000 }] })] });
    const year = vatYear(2026, 'quarterly', 'received', { inputVat: [], outputVatByIssue: [], outputVatByPayment: over.outputVatByPayment });
    expect(year.outputByRate).toEqual([
      { rateBp: 1900, netCents: 100_000, vatCents: 19_000 },
      { rateBp: 700, netCents: 50_000, vatCents: 3_500 },
    ]);
    expect(over.revenue.invoices[0].checks).toContain('invoice_overpaid');
    // The statement still counts the money received (as before).
    expect(cents(over, 'euer.revenue_taxable')).toBe(157_500);
    const single: InvoiceFact = { ...mixed(), treatment: 'standard', taxGroups: null, grossCents: 119_000, vatCents: 19_000, payments: [{ date: '2026-04-05', cents: 119_000 }, { date: '2026-05-05', cents: 1_000 }] };
    const result = run({ invoices: [single] });
    expect(result.outputVatByPayment).toEqual([{ date: '2026-04-05', cents: 19_000, source: 'invoice', id: 'inv-m', rateBp: 1900, netCents: 100_000 }]);
  });

  it('stored groups that no longer read: the tax still counts, under no rate, and the invoice says so', () => {
    const result = run({ invoices: [mixed({ taxGroups: null })] });
    expect(cents(result, 'euer.revenue_taxable')).toBe(150_000);
    expect(cents(result, 'euer.vat_received')).toBe(22_500);
    expect(cents(result, 'euer.revenue_not_taxable')).toBe(0);
    expect(result.revenue.invoices[0].checks).toContain('invoice_tax_groups_unreadable');
    const year = vatYear(2026, 'quarterly', 'issued', { inputVat: [], outputVatByIssue: result.outputVatByIssue, outputVatByPayment: [] });
    expect(year.periods[0].outputVatCents).toBe(22_500);
    expect(year.periods[0].outputByRate).toEqual([]);
  });

  it('a stated tax a few cents off net times rate is used as stated and noted', () => {
    const groups = [
      { rateBp: 1900, netCents: 100_000, vatCents: 19_004 },
      { rateBp: 700, netCents: 50_000, vatCents: 3_500 },
    ];
    const result = run({ invoices: [mixed({ taxGroups: groups, grossCents: 172_504, vatCents: 22_504, payments: [{ date: '2026-04-05', cents: 172_504 }] })] });
    expect(cents(result, 'euer.vat_received')).toBe(22_504);
    expect(result.revenue.invoices[0].checks).toEqual(['invoice_tax_group_deviates']);
    expect(run({ invoices: [mixed()] }).revenue.invoices[0].checks).toEqual([]);
  });

  it('a mixed invoice issued under the small-business rule is reported as a mismatch, like any taxed invoice', () => {
    expect(run({ invoices: [mixed({ smallBusinessOnIssue: true })] }).revenue.invoices[0].checks).toContain('invoice_treatment_mismatch');
  });
});
