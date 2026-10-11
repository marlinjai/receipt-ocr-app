/**
 * One receipt, settled from its two readings.
 *
 * The text reader (src/lib/extract-receipt-fields.ts) works on the recognized
 * text alone: it can prove a total from the receipt's arithmetic and rank a
 * date by its label, but it cannot see which amount stands next to "Total".
 * The language model sees the page, and can be wrong. This module is the one
 * place that decides between them, for the upload, for a new reading of a
 * stored receipt and for the evaluation script alike:
 *
 *  - what the text proves stands, and a differing answer of the model is a
 *    doubt recorded for a person;
 *  - where the text proves nothing, the model's answer is taken if it is
 *    printed in the recognized text, never otherwise;
 *  - nothing is stored on the model's word alone.
 *
 * Pure: no database, no network, no server-only import.
 */

import type { TextExtraction } from '@/lib/extract-receipt-fields';
import { readAmounts, type AmountReading } from '@/lib/extraction/amounts';
import { readDateDetail } from '@/lib/extraction/date';
import { chooseVendor } from '@/lib/extraction/vendor';
import { defaultTaxRate, mealFactsFromClassification, type MealClassification } from '@/lib/meals/classify';
import { CURRENCY_OPTIONS, MEAL_CATEGORY } from '@/lib/receipts-constants';
import type { ReadFlag } from '@/lib/review/reasons';

/** What the language model answered, as far as the reading uses it. */
export interface ModelReading {
  name: string | null;
  category: string | null;
  konto: string | null;
  zuordnung: string | null;
  taxRate: number | null;
  vendor: string | null;
  gross: number | null;
  net: number | null;
  /** ISO 8601 instant of the invoice day. */
  date: string | null;
  /** ISO 4217 code. */
  currency: string | null;
  /** The model says the document states no total to pay. */
  noTotal: boolean;
  /** True when the model was given the page; false when it read the recognized text alone. */
  sawPage: boolean;
  meal: MealClassification | null;
}

export interface SettledReading {
  category: string | null;
  vendor: string | null;
  /** ISO 8601 instant of the invoice day, or null. */
  date: string | null;
  currency: string;
  amounts: AmountReading;
  gross: number | null;
  net: number | null;
  taxRate: number;
  /** The meal facts, for a receipt filed as a business meal; null otherwise. */
  meal: MealClassification | null;
  /** What could not be settled, for the review list. */
  flags: ReadFlag[];
}

const CURRENCY_SIGN: Record<string, string> = { EUR: '€', USD: '$', GBP: '£' };

/** True when the text itself shows the currency: its code as a word, or its sign. */
function currencyInText(text: string, code: string): boolean {
  if (new RegExp(`(?<![\\p{L}])${code}(?![\\p{L}])`, 'u').test(text)) return true;
  const sign = CURRENCY_SIGN[code];
  return sign !== undefined && text.includes(sign);
}

/**
 * The currency: one the text settles stands. Where the text shows none, or
 * signs of several, the model's answer decides among what the text shows.
 */
export function settleCurrency(fullText: string, extracted: Pick<TextExtraction, 'currency' | 'currencyShown'>, ai: ModelReading | null): string {
  const page = ai?.sawPage ? ai.currency : null;
  if (extracted.currencyShown || !page || page === extracted.currency) return extracted.currency;
  return CURRENCY_OPTIONS.includes(page) && currencyInText(fullText, page) ? page : extracted.currency;
}

/**
 * The invoice date, from the text's reading and that of a model that saw the
 * page. Whatever the two do not agree on is a conflict recorded for a person;
 * no date is ever replaced or filled in silently.
 *
 *  - A date the text calls the invoice date, or a plain "Datum", stands.
 *  - A date nothing names (it can be a service period) gives way to the day
 *    the page reading names, if the text prints that day: no conflict, the
 *    page only says which of the printed days it is.
 *  - An order or payment date gives way the same way, as a conflict: the page
 *    shows another day next to "Rechnungsdatum".
 *  - A gap (the text found no date, as on a scanned till slip) is filled by
 *    the page reading; where the text does not print that day, as a conflict.
 *  - The page reading names no date at all and the text's is not one it calls
 *    the invoice date: the text's date stays, as a conflict (a ticket that
 *    prints the day of the event, not of the sale).
 */
export function settleDate(fullText: string, ai: ModelReading | null): { date: string | null; conflict: boolean } {
  const text = readDateDetail(fullText);
  if (!ai?.sawPage) return { date: text.iso, conflict: false };
  const named = text.kind === 'invoice' || text.kind === 'plain';
  const page = ai.date;
  if (!page) return { date: text.iso, conflict: text.iso !== null && !named };
  if (text.iso?.slice(0, 10) === page.slice(0, 10)) return { date: text.iso, conflict: false };
  if (named) return { date: text.iso, conflict: true };
  const printed = text.printedDays.includes(page.slice(0, 10));
  if (text.iso === null) return { date: page, conflict: !printed };
  if (printed) return { date: page, conflict: text.kind === 'order' };
  return { date: text.iso, conflict: true };
}

/**
 * Settle one receipt. `ai` is null when no model answer could be had; the
 * receipt is then read from the text alone and says so.
 */
export function settleReading(fullText: string, extracted: TextExtraction, ai: ModelReading | null): SettledReading {
  const flags: ReadFlag[] = [];
  if (!ai) flags.push('not_classified');
  // The model answered, but from the text alone: the file was missing, unreadable, over a limit or refused.
  else if (!ai.sawPage) flags.push('page_not_read');

  // Category: the model's answer, else what the text itself shows. A receipt
  // with a table, a waiter and a tip line that the model filed elsewhere is
  // kept as the model said and put up for a look.
  const category = ai?.category || extracted.category || null;
  if (ai && extracted.mealEvidence.strong && category !== MEAL_CATEGORY) flags.push('category_doubt');

  const vendor = chooseVendor({ vendor: extracted.vendor, confidence: extracted.vendorConfidence }, ai?.vendor, fullText).vendor;
  const meal = category === MEAL_CATEGORY ? mealFactsFromClassification(ai, fullText, vendor) : null;
  const { date, conflict: dateConflict } = settleDate(fullText, ai);
  if (dateConflict) flags.push('date_conflict');
  const currency = settleCurrency(fullText, extracted, ai);

  // Amounts: read again with the model's figures as a second opinion. The
  // receipt's own arithmetic decides; what it cannot confirm is recorded for
  // a look instead of stored as fact.
  const amounts = readAmounts(fullText, {
    date,
    currency,
    modelGross: ai?.gross ?? null,
    modelNet: ai?.net ?? null,
    modelTaxLines: ai?.meal?.taxLines ?? null,
    modelSawPage: ai?.sawPage ?? false,
    modelNoTotal: ai?.noTotal ?? false,
  });
  if (amounts.checks.includes('total_conflict')) flags.push('total_conflict');
  else if (amounts.checks.includes('total_unconfirmed')) flags.push('total_unconfirmed');

  const taxRate = amounts.taxRate ?? ai?.taxRate ?? defaultTaxRate(category, date, meal?.consumption ?? null);
  let net = amounts.net;
  if (amounts.gross !== null && net === null) net = Math.round((amounts.gross / (1 + taxRate / 100)) * 100) / 100;
  if (meal) {
    // The printed tax groups and a printed tip, where the model reported none.
    if (!meal.taxLines?.length && amounts.taxGroups.length > 0) {
      meal.taxLines = amounts.taxGroups.map((g) => ({ rate: g.rate, net: g.net, tax: g.tax }));
    }
    if (amounts.tip != null) meal.tip = amounts.tip;
  }
  return { category, vendor, date, currency, amounts, gross: amounts.gross, net, taxRate, meal, flags };
}
