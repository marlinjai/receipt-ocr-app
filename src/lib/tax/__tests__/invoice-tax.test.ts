import { describe, expect, it } from 'vitest';
import { computeYear } from '../compute';
import { invoiceTaxGroups, splitPayment, taxAt } from '../invoice-tax';
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
});

describe('splitPayment', () => {
  it('a full payment is exactly the groups', () => {
    expect(splitPayment(GROUPS, 172_500, 0, 172_500)).toEqual([
      { rateBp: 1900, netCents: 100_000, vatCents: 19_000 },
      { rateBp: 700, netCents: 50_000, vatCents: 3_500 },
    ]);
  });

  it('partial payments of odd amounts add up to exactly the groups, cent for cent', () => {
    const payments = [33_333, 77_777, 1, 61_389];
    let paid = 0;
    const sums = new Map<number, { net: number; vat: number }>();
    for (const p of payments) {
      for (const part of splitPayment(GROUPS, 172_500, paid, p)) {
        const s = sums.get(part.rateBp) ?? { net: 0, vat: 0 };
        sums.set(part.rateBp, { net: s.net + part.netCents, vat: s.vat + part.vatCents });
      }
      const parts = splitPayment(GROUPS, 172_500, paid, p);
      expect(parts.reduce((s, x) => s + x.netCents + x.vatCents, 0)).toBe(p);
      paid += p;
    }
    expect(paid).toBe(172_500);
    expect(sums.get(1900)).toEqual({ net: 100_000, vat: 19_000 });
    expect(sums.get(700)).toEqual({ net: 50_000, vat: 3_500 });
  });

  it('money above the total carries no tax and stays turnover of the first group', () => {
    const parts = splitPayment(GROUPS, 172_500, 0, 180_000);
    expect(parts).toEqual([
      { rateBp: 1900, netCents: 107_500, vatCents: 19_000 },
      { rateBp: 700, netCents: 50_000, vatCents: 3_500 },
    ]);
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
        const [part] = splitPayment(groups, gross, paid, payment);
        expect(part.vatCents).toBe(before(vat, gross, paid, payment));
        expect(part.netCents + part.vatCents).toBe(payment);
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

  it('allows a cent of rounding per group, not more', () => {
    const groups = [
      { rateBp: 1900, netCents: 100_000, vatCents: 19_001 },
      { rateBp: 700, netCents: 50_000, vatCents: 3_499 },
    ];
    expect(parseTaxGroups(groups)).not.toBeNull();
    expect(parseTaxGroups([{ ...groups[0], vatCents: 19_002 }, groups[1]])).toBeNull();
    expect(taxAt(33_333, 700)).toBe(2_333);
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

  it('a mixed invoice issued under the small-business rule is reported as a mismatch, like any taxed invoice', () => {
    expect(run({ invoices: [mixed({ smallBusinessOnIssue: true })] }).revenue.invoices[0].checks).toContain('invoice_treatment_mismatch');
  });
});
