/**
 * A receipt read from an electronic invoice (XRechnung, or ZUGFeRD and
 * Factur-X: a PDF with the same XML inside, see src/lib/einvoice).
 *
 * The structured data is the invoice; the page is only its picture. So its
 * date, total, net, tax groups and currency stand over whatever the text
 * reader and the model read from the page, and the doubts those two recorded
 * about them are moot. What the XML does not say stays as read: the category,
 * what was bought, the assignment, and the vendor's name as a customer uses it
 * (the XML names the legal entity: "Example Hosting LLC", where the row says
 * "Example Hosting"; it is taken only where the reading found no name).
 *
 * Pure: no database, no network.
 */

import type { StructuredReceiptFields } from '@/lib/einvoice';
import type { SettledReading } from '@/lib/receipt-reading';
import type { ReadFlag } from '@/lib/review/reasons';

/** Doubts about figures the structured data settles. */
const SETTLED_BY_STRUCTURE: readonly ReadFlag[] = ['total_unconfirmed', 'total_conflict', 'date_conflict', 'page_not_read'];

export function withStructuredInvoice(settled: SettledReading, fields: StructuredReceiptFields): SettledReading {
  const flags = settled.flags.filter((f) => !SETTLED_BY_STRUCTURE.includes(f));
  // Figures in the XML that do not add up, and a credit note (money back, which the row cannot say by itself): a person looks.
  if (fields.problems.length > 0) flags.push('einvoice_problem');
  if (fields.creditNote) flags.push('credit_note');
  const taxGroups = fields.taxGroups.length > 0 ? fields.taxGroups : settled.amounts.taxGroups;
  const meal = settled.meal && fields.taxGroups.length > 0 ? { ...settled.meal, taxLines: fields.taxGroups.map((g) => ({ rate: g.rate, net: g.net, tax: g.tax })) } : settled.meal;
  const gross = fields.gross ?? settled.gross;
  return {
    ...settled,
    vendor: settled.vendor ?? fields.vendor,
    date: fields.date ?? settled.date,
    currency: fields.currency ?? settled.currency,
    gross,
    // The net the XML states; else the nets of its tax groups; else, where the XML names no total either, the reading's.
    net: fields.net ?? (fields.taxGroups.length > 0 ? Math.round(fields.taxGroups.reduce((sum, g) => sum + g.net, 0) * 100) / 100 : fields.gross !== null ? null : settled.net),
    taxRate: fields.taxRate ?? settled.taxRate,
    amounts: { ...settled.amounts, gross, taxGroups, taxRate: fields.taxRate ?? settled.amounts.taxRate, taxPrinted: fields.taxGroups.length > 0 || settled.amounts.taxPrinted, checks: [] },
    meal,
    flags: [...new Set(flags)],
  };
}
