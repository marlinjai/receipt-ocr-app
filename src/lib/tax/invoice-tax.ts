import type { InvoiceFact, TaxGroup } from './types';

/**
 * The tax groups of an issued invoice: per rate the net amount and the tax on
 * it. The advance return reports turnover per rate, so an invoice with lines at
 * 19 and at 7 percent has to keep both groups instead of one total. Pure.
 *
 * An invoice taxed at one rate stores no groups: its one group follows from its
 * treatment, its total and its tax, so nothing stored before groups existed has
 * to be rewritten.
 */

/** The rates an issued invoice can carry, in basis points (section 12 paragraphs 1 and 2 of the value-added tax act). */
export const STANDARD_RATE_BP = 1900;
export const REDUCED_RATE_BP = 700;
export const INVOICE_RATES_BP: readonly number[] = [STANDARD_RATE_BP, REDUCED_RATE_BP];

/**
 * The second half of 2020 had lower rates (16 and 5 percent, section 28
 * paragraphs 1 and 2 of the value-added tax act as it read then). Only the
 * label of the rate depends on it; the amounts are the invoice's own.
 */
function rateOn(treatment: 'standard' | 'reduced', issueDate: string | null): number {
  const lowered = issueDate !== null && issueDate >= '2020-07-01' && issueDate <= '2020-12-31';
  if (treatment === 'standard') return lowered ? 1600 : STANDARD_RATE_BP;
  return lowered ? 500 : REDUCED_RATE_BP;
}

/**
 * The rate of a group whose rate is not known: a mixed invoice whose stored
 * groups no longer read. Its tax still counts; it is reported under no rate.
 */
export const UNKNOWN_RATE_BP = 0;

/**
 * The groups of an invoice, highest rate first; none for an invoice without
 * tax. A mixed invoice without readable groups keeps its stated tax as one group
 * of unknown rate, so it is never booked as untaxed (it carries a check).
 */
export function invoiceTaxGroups(invoice: Pick<InvoiceFact, 'treatment' | 'grossCents' | 'vatCents' | 'issueDate' | 'taxGroups'>): TaxGroup[] {
  if (invoice.treatment === 'mixed') {
    if (invoice.taxGroups && invoice.taxGroups.length > 0) return [...invoice.taxGroups].sort((a, b) => b.rateBp - a.rateBp);
    const vat = Math.max(0, Math.min(invoice.vatCents, invoice.grossCents));
    return [{ rateBp: UNKNOWN_RATE_BP, netCents: invoice.grossCents - vat, vatCents: vat }];
  }
  if (invoice.treatment !== 'standard' && invoice.treatment !== 'reduced') return [];
  const vat = Math.max(0, Math.min(invoice.vatCents, invoice.grossCents));
  return [{ rateBp: rateOn(invoice.treatment, invoice.issueDate), netCents: invoice.grossCents - vat, vatCents: vat }];
}

/** The tax a net amount carries at a rate, rounded to the cent. */
export function taxAt(netCents: number, rateBp: number): number {
  return Math.round((netCents * rateBp) / 10_000);
}

/**
 * How far the stated tax of a group may be from its net amount times the rate.
 * Invoicing software that rounds per line and then adds the lines can be a few
 * cents off; the invoice's own figure is what is owed (section 14c of the
 * value-added tax act), so it is accepted within one percent of the tax (at
 * least one cent) and reported when it is more than a cent off. Beyond that it
 * is taken for a typing error.
 */
export function taxDeviationAllowed(netCents: number, rateBp: number): number {
  return Math.max(1, Math.round(taxAt(netCents, rateBp) / 100));
}

export interface PaymentGroupPart {
  rateBp: number;
  /** The turnover (without tax) at this rate the payment contains. */
  netCents: number;
  vatCents: number;
}

export interface PaymentSplit {
  parts: PaymentGroupPart[];
  /** Money above the invoice total: no tax, no rate (the invoice is reported as overpaid). */
  excessCents: number;
}

/**
 * Split one payment of an invoice into its groups. `paidBefore` is what the
 * invoice received before this payment. Every figure is the difference of two
 * cumulative figures, so all payments of an invoice add up to exactly its
 * groups. The tax of a group never exceeds the group's tax nor the group's share
 * paid so far; money above the invoice total belongs to no group.
 */
export function splitPayment(groups: readonly TaxGroup[], grossCents: number, paidBefore: number, paymentCents: number): PaymentSplit {
  if (groups.length === 0 || grossCents <= 0) return { parts: [], excessCents: 0 };
  const paidAfter = paidBefore + paymentCents;
  const capped = (paid: number) => Math.min(Math.max(paid, 0), grossCents);
  // The gross share of the groups up to and including group k, for an amount paid so far.
  const grossUpTo = (paid: number, k: number) => {
    const upTo = groups.slice(0, k + 1).reduce((s, g) => s + g.netCents + g.vatCents, 0);
    return Math.round((capped(paid) * upTo) / grossCents);
  };
  const grossOf = (paid: number, k: number) => grossUpTo(paid, k) - grossUpTo(paid, k - 1);
  // Capped at the group's gross share paid so far, so a small payment never
  // gives a group more tax than money (both figures are cumulative, so the
  // payments still add up to exactly the group).
  const vatOf = (group: TaxGroup, paid: number, k: number) =>
    Math.min(group.vatCents, Math.round((group.vatCents * capped(paid)) / grossCents), grossOf(paid, k));
  const parts = groups.map((group, k) => {
    const grossPart = grossOf(paidAfter, k) - grossOf(paidBefore, k);
    const vatPart = vatOf(group, paidAfter, k) - vatOf(group, paidBefore, k);
    return { rateBp: group.rateBp, netCents: grossPart - vatPart, vatCents: vatPart };
  });
  const allocated = parts.reduce((s, p) => s + p.netCents + p.vatCents, 0);
  return { parts, excessCents: paymentCents - allocated };
}
