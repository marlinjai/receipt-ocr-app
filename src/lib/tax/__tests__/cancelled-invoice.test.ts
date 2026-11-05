import { describe, expect, it } from 'vitest';
import { computeYear } from '../compute';
import { overdueInvoices } from '../overdue';
import { rulesForYear } from '../rules';
import type { InvoiceFact, YearFacts } from '../types';
import { vatYear } from '../vat';

/**
 * An invoice cancelled by a credit note (a Books document mirrored here, see
 * `books-mirror.ts`): from the credit note's day on it is no claim, its tax
 * taken on issue goes back in the credit note's period, and money still
 * booked on it is a question for a person.
 */

const run = (facts: Partial<YearFacts>, year = 2026) => computeYear({ year, items: [], ...facts }, rulesForYear(year));

const invoice = (o: Partial<InvoiceFact> = {}): InvoiceFact => ({
  id: 'inv-62',
  number: '62',
  issueDate: '2026-10-28',
  grossCents: 75_000,
  vatCents: 0,
  treatment: 'small_business',
  payments: [],
  declaredInYear: null,
  smallBusinessOnIssue: true,
  ...o,
});

describe('a cancelled invoice in the year', () => {
  it('is no claim from the day of its credit note on', () => {
    expect(run({ invoices: [invoice()] }).revenue.outstandingCents).toBe(75_000);
    const result = run({ invoices: [invoice({ cancelledOn: '2026-11-02' })] });
    expect(result.revenue.outstandingCents).toBe(0);
    expect(result.revenue.invoices[0].checks).toEqual([]);
  });

  it('is still a claim at the end of a year before its credit note', () => {
    const result = run({ invoices: [invoice({ issueDate: '2025-12-20', cancelledOn: '2026-01-10' })] }, 2025);
    expect(result.revenue.outstandingCents).toBe(75_000);
  });

  it('keeps money that arrived as received, and asks about it', () => {
    const result = run({ invoices: [invoice({ cancelledOn: '2026-11-02', payments: [{ date: '2026-10-30', cents: 75_000 }] })] });
    expect(result.revenue.receivedCents).toBe(75_000);
    expect(result.revenue.invoices[0].checks).toContain('invoice_cancelled_with_payments');
  });

  it('takes the tax charged on issue back in the period of the credit note, rate by rate', () => {
    const taxed = invoice({ issueDate: '2026-02-20', grossCents: 11_900, vatCents: 1_900, treatment: 'standard', smallBusinessOnIssue: false, cancelledOn: '2026-05-04' });
    const result = run({ invoices: [taxed] });
    const year = vatYear(2026, 'quarterly', 'issued', { inputVat: [], outputVatByIssue: result.outputVatByIssue, outputVatByPayment: result.outputVatByPayment });
    expect(year.periods[0].outputVatCents).toBe(1_900);
    expect(year.periods[1].outputVatCents).toBe(-1_900);
    expect(year.periods[1].outputByRate).toEqual([expect.objectContaining({ rateBp: 1900, netCents: -10_000, vatCents: -1_900 })]);
  });
});

describe('a cancelled invoice of an earlier year', () => {
  it('is listed in the year of its credit note, where its tax goes back', () => {
    const taxed = invoice({ issueDate: '2025-12-15', grossCents: 11_900, vatCents: 1_900, treatment: 'standard', smallBusinessOnIssue: false, cancelledOn: '2026-01-12' });
    const result = run({ invoices: [taxed] });
    expect(result.revenue.invoices.map((i) => i.invoiceId)).toEqual(['inv-62']);
    expect(result.revenue.outstandingCents).toBe(0);
    expect(result.outputVatByIssue).toEqual([expect.objectContaining({ date: '2026-01-12', cents: -1_900, id: 'inv-62' })]);
    // A year later it no longer touches the books.
    expect(run({ invoices: [taxed] }, 2027).revenue.invoices).toEqual([]);
  });
});

describe('a cancelled invoice is never overdue', () => {
  it('from the day of its credit note on', () => {
    const open = { id: 'a', number: '62', issueDate: '2026-09-01', grossCents: 100_000, payments: [] };
    expect(overdueInvoices([open], '2026-10-20')).toHaveLength(1);
    expect(overdueInvoices([{ ...open, cancelledOn: '2026-10-01' }], '2026-10-20')).toEqual([]);
    expect(overdueInvoices([{ ...open, cancelledOn: '2026-10-25' }], '2026-10-20')).toHaveLength(1);
  });

  it('takes the due day the Books document states', () => {
    const open = { id: 'a', number: '62', issueDate: '2026-09-01', dueDate: '2026-10-01', grossCents: 100_000, payments: [] };
    expect(overdueInvoices([open], '2026-10-14')).toEqual([]);
    expect(overdueInvoices([open], '2026-10-15')[0].dueDate).toBe('2026-10-01');
  });
});
