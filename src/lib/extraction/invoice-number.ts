/**
 * A receipt's invoice number (Rechnungsnummer): the identifier that decides
 * whether two receipts are one invoice (plan
 * docs/plans/2026-10-29-invoice-number-duplicates.md).
 *
 * Three things live here, all pure:
 *  - `cleanInvoiceNumber`: the printed form, as the "Rechnungsnummer" cell holds it;
 *  - `invoiceNumberKey`: the form two numbers are compared in, derived from the
 *    printed one wherever receipts are compared (never stored apart, so it can
 *    never disagree with the cell a person sees and edits). A weak number
 *    (short, or a few digits only) has no key: it repeats across tills and
 *    days and must not decide anything;
 *  - `parseInvoiceNumber`: the number the text labels as the document's own
 *    invoice or receipt number. Order, customer, contract, transaction and
 *    till numbers are never taken, and two different numbers under the same
 *    kind of label give none. Never a guess.
 *
 * No server-only import: the receipt view shows the cell in the browser.
 */

import { carriesInvoiceNumber } from '@/lib/receipt-references';

/** The column of the receipts table that holds the printed number. */
export const INVOICE_NUMBER_COLUMN = 'Rechnungsnummer';

/** Longer than any invoice number: a cell holding more is a sentence, not a number. */
const MAX_PRINTED = 60;

/** A label in front of the number itself ("#", "Nr.", "No.", "Nº"), as a person or a document writes it. */
const LEADING_LABEL = /^(?:#|n[°º]\.?|(?:nr|no|num)(?:[.:]|\s)|nummer\b|number\b)[\s:.#]*/iu;

function stripLeadingLabels(value: string): string {
  let out = value.trim();
  for (let i = 0; i < 3; i++) {
    const next = out.replace(LEADING_LABEL, '').trim();
    if (next === out) break;
    out = next;
  }
  return out;
}

/** The printed form for the cell: trimmed, whitespace collapsed, a leading "#" or "Nr." dropped. Null when nothing is left. */
export function cleanInvoiceNumber(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const cleaned = stripLeadingLabels(value.normalize('NFKC').replace(/\s+/g, ' ')).replace(/^[:.\s]+|[:.,;\s]+$/g, '');
  if (!cleaned || cleaned.length > MAX_PRINTED) return null;
  return cleaned;
}

/**
 * The form two invoice numbers are compared in: case folded, without spaces,
 * without a leading "#", "Nr." or "No.", and without the separators optical
 * character recognition varies (dashes, slashes, dots, underscores). Null for
 * an empty or weak number: fewer than four letters and digits, none of them a
 * digit, or digits only and fewer than five of them.
 */
export function invoiceNumberKey(printed: unknown): string | null {
  const cleaned = cleanInvoiceNumber(printed);
  if (!cleaned) return null;
  const key = cleaned.toLocaleUpperCase('de-DE').replace(/[^\p{L}\p{N}]+/gu, '');
  if (key.length < 4 || !/\p{N}/u.test(key)) return null;
  if (/^\p{N}+$/u.test(key) && key.length < 5) return null;
  return key;
}

/**
 * The labels of a document's own number, strongest kind first. A number is
 * taken from the strongest kind the text labels at all.
 */
const INVOICE_LABEL = String.raw`(?:rechnungs?\s*-?\s*(?:nummer|nr|no|num)\.?|re(?:ch)?\.?\s*-\s*nr\.?|re\.\s*nr\.?|invoice\s*(?:number|num\.?|no\.?|nr\.?|id|#)|inv\.?\s*(?:no\.?|#)|facture\s*(?:n[°º]|no\.?|num[ée]ro)|fattura\s*(?:n[°º.r]?|numero))`;
const RECEIPT_LABEL = String.raw`(?:receipt\s*(?:number|no\.?|#))`;
/** On a credit note, its own number; the invoice labels on it name the invoice it corrects. */
const CREDIT_NOTE_LABEL = String.raw`(?:gutschrifts?\s*-?\s*(?:nummer|nr|no)\.?|credit\s*note\s*(?:number|no\.?|#))`;

/** Words just before a label that make it the number of ANOTHER document ("zu Rechnung Nr. 17"). */
const REFERENCE_BEFORE = /(?:\bzu(?:r)?|\bauf|\bfür|\bbezug|\bstorno|\bkorrektur|\boriginal|\bursprüngliche[nr]?|\breferenz|\bto|\bfor|\bof|\bagainst)\s*(?:der|die|das|the)?\s*$/iu;

/** The value after a label: one token that holds a digit, not a date and not an amount. */
// Never cut out of an amount: "1.234,56" is no number "1.234".
const VALUE = String.raw`([\p{L}\p{N}][\p{L}\p{N}\-/._]*[\p{L}\p{N}]|\p{N})(?![\p{L}\p{N}]|,\p{N})`;
const DATE_LIKE = /^\d{1,4}[./-]\d{1,2}[./-]\d{1,4}$/u;
const AMOUNT_LIKE = /^\d{1,3}(?:[.,]\d{3})*[.,]\d{2}$/u;

function acceptable(value: string): boolean {
  return /\p{N}/u.test(value) && value.length >= 3 && value.length <= 40 && !DATE_LIKE.test(value) && !AMOUNT_LIKE.test(value);
}

/** Every value the text puts after one kind of label, on the same line or, where the label ends its line, on the next. */
function labelled(text: string, label: string): string[] {
  const out: string[] = [];
  const pattern = new RegExp(`(?<![\\p{L}\\p{N}])${label}[ \\t:#.]*(?:(?:nr|no)\\.?[ \\t:#]*)?(?:${VALUE}|\\r?\\n[ \\t]*${VALUE})`, 'giu');
  for (const match of text.matchAll(pattern)) {
    const before = text.slice(Math.max(0, match.index - 40), match.index).split('\n').pop() ?? '';
    if (REFERENCE_BEFORE.test(before)) continue;
    const value = match[1] ?? match[2];
    if (value && acceptable(value)) out.push(value);
  }
  return out;
}

export interface ParseOptions {
  /** True for a credit note: its own number is read from a credit note label only. */
  creditNote?: boolean;
}

/**
 * The document's own invoice number as printed, from its recognized text;
 * null when the text labels none, or labels two different ones under the
 * strongest kind of label it has.
 */
export function parseInvoiceNumber(text: string, options: ParseOptions = {}): string | null {
  if (!text.trim()) return null;
  const kinds = options.creditNote ? [CREDIT_NOTE_LABEL] : [INVOICE_LABEL, RECEIPT_LABEL];
  for (const label of kinds) {
    const values = labelled(text, label);
    if (values.length === 0) continue;
    // One number, however often it is printed; two different ones say nothing about which is this document's.
    const distinct = new Map<string, string>();
    for (const value of values) distinct.set(value.toLocaleUpperCase('de-DE').replace(/[^\p{L}\p{N}]+/gu, ''), value);
    return distinct.size === 1 ? cleanInvoiceNumber([...distinct.values()][0]) : null;
  }
  return null;
}

export interface InvoiceNumberSources {
  /** The number an electronic invoice's XML states (BT-1). */
  structured: string | null;
  /** The recognized text the receipt was read from. */
  text: string;
  /** The model's answer. Taken only where the text carries it. */
  model: string | null;
  /** True when no text was recognized and the figures were read from the page image alone. */
  fromImageOnly: boolean;
  creditNote: boolean;
}

/**
 * The number a reading stores: the XML's; else the one the text labels; else
 * the model's, where the recognized text carries it as a whole token. A
 * reading from the image alone gives none: nothing can confirm it.
 */
export function settleInvoiceNumber(sources: InvoiceNumberSources): string | null {
  const structured = cleanInvoiceNumber(sources.structured);
  if (structured) return structured;
  if (sources.fromImageOnly || !sources.text.trim()) return null;
  const parsed = parseInvoiceNumber(sources.text, { creditNote: sources.creditNote });
  if (parsed) return parsed;
  const model = cleanInvoiceNumber(sources.model);
  return model && carriesInvoiceNumber(sources.text, model) ? model : null;
}
