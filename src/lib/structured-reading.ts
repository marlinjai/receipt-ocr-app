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
import { CURRENCY_OPTIONS } from '@/lib/receipts-constants';

/** Doubts about figures the structured data settles. */
const SETTLED_BY_STRUCTURE: readonly ReadFlag[] = ['total_unconfirmed', 'total_conflict', 'date_conflict', 'page_not_read'];

export interface StructuredOptions {
  /** True when the text the reading was made from is the XML's own text (an XRechnung has no page to recognize). */
  textFromStructure?: boolean;
  /** The vendor the model answered, if any. */
  modelVendor?: string | null;
}

export function withStructuredInvoice(settled: SettledReading, fields: StructuredReceiptFields, options: StructuredOptions = {}): SettledReading {
  const flags = settled.flags.filter((f) => !SETTLED_BY_STRUCTURE.includes(f));
  if (fields.problems.length > 0) flags.push('einvoice_problem');
  // The vendor: the name the reading found, as a customer uses it. Where the
  // reading was made from the XML's own text, the text reader takes its
  // heading for a name; only the model's answer counts there, else the seller.
  const key = (name: string | null | undefined) => (name ?? '').toLocaleLowerCase('de-DE').replace(/[^\p{L}\p{N}]+/gu, '');
  const modelNamed = Boolean(options.modelVendor) && key(settled.vendor) === key(options.modelVendor);
  const vendor = options.textFromStructure ? (modelNamed ? settled.vendor : fields.vendor) : (settled.vendor ?? fields.vendor);
  // A currency the app has no option for cannot be stored: the amounts would
  // be counted as euros. They stay empty, like a credit note's, until a
  // person enters them; the figures are in the text.
  const unknownCurrency = fields.currency !== null && !CURRENCY_OPTIONS.includes(fields.currency);
  if (unknownCurrency) flags.push('currency_unknown');
  const currency = fields.currency !== null && !unknownCurrency ? fields.currency : settled.currency;
  if (unknownCurrency) {
    // Its amounts stay empty until a person enters them; the figures are in its text. A credit
    // note says so here too, so that a person does not enter money back as a purchase.
    if (fields.creditNote) flags.push('credit_note');
    const amounts = { ...settled.amounts, gross: null, net: null, taxGroups: [], checks: [] };
    return { ...settled, vendor, date: fields.date ?? settled.date, currency, gross: null, net: null, amounts, meal: settled.meal ? { ...settled.meal, taxLines: null } : null, flags: [...new Set(flags)] };
  }
  if (fields.creditNote) {
    // A credit note is money back: a receipt with a negative amount on the
    // day of the credit note (under the cash basis the money counts when it
    // comes back). Its tax groups are not kept as lines (a line is never
    // negative); its rate is the rate of its largest group. Which invoice it
    // corrects is linked by the caller (`linkCreditNote`).
    const negative = (value: number | null) => (value === null ? null : -Math.abs(value));
    const groupNet = fields.taxGroups.length > 0 ? Math.round(fields.taxGroups.reduce((sum, g) => sum + g.net, 0) * 100) / 100 : null;
    const gross = negative(fields.gross ?? settled.gross);
    const net = negative(fields.net ?? groupNet ?? (fields.gross === null ? settled.net : null));
    const taxRate = fields.taxRate ?? settled.taxRate;
    const amounts = { ...settled.amounts, gross, net, taxRate, taxGroups: [], taxPrinted: fields.taxGroups.length > 0, checks: [] };
    return { ...settled, vendor, date: fields.date ?? settled.date, currency, gross, net, taxRate, amounts, meal: settled.meal ? { ...settled.meal, taxLines: null } : null, flags: [...new Set(flags)] };
  }
  const taxGroups = fields.taxGroups.length > 0 ? fields.taxGroups : settled.amounts.taxGroups;
  const meal = settled.meal && fields.taxGroups.length > 0 ? { ...settled.meal, taxLines: fields.taxGroups.map((g) => ({ rate: g.rate, net: g.net, tax: g.tax })) } : settled.meal;
  const gross = fields.gross ?? settled.gross;
  return {
    ...settled,
    vendor,
    date: fields.date ?? settled.date,
    currency,
    gross,
    // The net the XML states; else the nets of its tax groups; else, where the XML names no total either, the reading's.
    net: fields.net ?? (fields.taxGroups.length > 0 ? Math.round(fields.taxGroups.reduce((sum, g) => sum + g.net, 0) * 100) / 100 : fields.gross !== null ? null : settled.net),
    taxRate: fields.taxRate ?? settled.taxRate,
    amounts: { ...settled.amounts, gross, taxGroups, taxRate: fields.taxRate ?? settled.amounts.taxRate, taxPrinted: fields.taxGroups.length > 0 || settled.amounts.taxPrinted, checks: [] },
    meal,
    flags: [...new Set(flags)],
  };
}
