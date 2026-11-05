/**
 * A receipt's invoice number (Rechnungsnummer): the identifier that decides
 * whether two receipts are one invoice (plan
 * docs/plans/2026-10-29-invoice-number-duplicates.md).
 *
 * What lives here, all pure:
 *  - `cleanInvoiceNumber`: the printed form, as the "Rechnungsnummer" cell holds it;
 *  - `invoiceNumberKey`: the form two numbers are compared in, derived from the
 *    printed one wherever receipts are compared (never stored apart, so it can
 *    never disagree with the cell a person sees and edits). A weak number
 *    (short, or a few digits only) has no key: it repeats across tills and
 *    days and must not decide anything;
 *  - `parseInvoiceNumber`: the number the text labels as the document's own
 *    invoice or receipt number, after its label on the same line, on the next
 *    line, or in the column of values below a block of labels (an invoice
 *    information box whose text came out label column first, value column
 *    second). Order, customer, contract, transaction and till numbers are
 *    never taken, and two different numbers under the same kind of label give
 *    none. Never a guess;
 *  - `invoiceNumberFromFileName`: the number a stored file's name labels
 *    ("Adobe-Invoice-2026-01-20-IEN2026004022987.pdf"), taken only where the
 *    recognized text carries it as a whole token (plan
 *    docs/plans/2026-11-05-duplicates-without-asking.md).
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
/** A date with the month as a word or its abbreviation: "20-JAN-2026", "8.March.2025", "Jan-20-2026". */
const MONTH_DATE_LIKE = /^(?:\d{1,2}[./-]?\p{L}{3,9}[./-]?\d{2,4}|\p{L}{3,9}[./-]\d{1,2}[./-]\d{2,4})$/u;
/** A date written without separators, year first: "20260120" (the stamp in a file name, a camera's). */
const COMPACT_DATE_LIKE = /^(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])$/u;
const AMOUNT_LIKE = /^\d{1,3}(?:[.,]\d{3})*[.,]\d{2}$/u;
const TIME_LIKE = /^\d{1,2}:\d{2}(?::\d{2})?$/u;

function acceptable(value: string): boolean {
  return /\p{N}/u.test(value) && value.length >= 3 && value.length <= 40 && !DATE_LIKE.test(value) && !MONTH_DATE_LIKE.test(value) && !AMOUNT_LIKE.test(value);
}

/**
 * A token that can only be an identifier: acceptable, with a key, not a date
 * or a time in any form, and either letters and digits mixed or six digits at
 * least. Used where no label stands right before the value (a column of
 * values, a file name), so a postcode, a house number or a quantity is never one.
 */
function strongToken(value: string): boolean {
  if (!acceptable(value) || TIME_LIKE.test(value) || COMPACT_DATE_LIKE.test(value)) return false;
  const key = invoiceNumberKey(value);
  if (!key) return false;
  return /\p{L}/u.test(key) ? /\p{N}/u.test(key) : key.length >= 6;
}

/** The tokens of a line, without the punctuation that closes a sentence or a list around them. */
function tokensOf(line: string): string[] {
  return line
    .split(/\s+/u)
    .map((t) => t.replace(/^[(\[{"'„“]+|[)\]}"'“”,;:.]+$/gu, ''))
    .filter(Boolean);
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

/** How many lines below a label its column of values is looked for. */
const COLUMN_LOOKAHEAD = 6;

/**
 * The values of a label that ends its line without one, read from the column
 * below it: the text of an invoice information box often comes out with its
 * labels first ("Invoice Number", "Invoice Date", "Payment Terms") and their
 * values after them, or as a row of labels above a row of values. Only an
 * unmistakable identifier (`strongToken`) in the next few lines counts, and
 * only where those lines hold exactly one: two candidates there (a customer
 * number in the same box) give none, because which value stands under which
 * label cannot be told.
 */
function columnar(text: string, label: string): string[] {
  const out: string[] = [];
  const lines = text.split(/\r?\n/u);
  const atStart = new RegExp(`^([ \\t]*)${label}[ \\t:#.]*(?:(?:nr|no)\\.?[ \\t:#]*)?(.*)$`, 'iu');
  for (let i = 0; i < lines.length; i++) {
    const match = atStart.exec(lines[i]);
    // The rest of the line holds other labels at most ("INVOICE NUMBER   INVOICE DATE"), never a value.
    if (!match || /\p{N}/u.test(match[2] ?? '')) continue;
    const window: string[] = [];
    for (let j = i + 1; j < lines.length && window.length < COLUMN_LOOKAHEAD; j++) if (lines[j].trim()) window.push(lines[j]);
    const found = new Map<string, string>();
    for (const line of window) for (const token of tokensOf(line)) if (strongToken(token)) found.set(invoiceNumberKey(token)!, token);
    if (found.size === 1) out.push([...found.values()][0]);
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
    // The value next to or right below its label first; only a label without one there looks at the column below.
    const inline = labelled(text, label);
    const values = inline.length > 0 ? inline : columnar(text, label);
    if (values.length === 0) continue;
    // One number, however often it is printed; two different ones say nothing about which is this document's.
    const distinct = new Map<string, string>();
    for (const value of values) distinct.set(value.toLocaleUpperCase('de-DE').replace(/[^\p{L}\p{N}]+/gu, ''), value);
    return distinct.size === 1 ? cleanInvoiceNumber([...distinct.values()][0]) : null;
  }
  return null;
}

/** Words of a file name that say it holds an invoice or a receipt, and so label the number next to it. */
const FILE_INVOICE_WORD = /^(?:invoice|invoices|inv|rechnung|rechnungen|rechnungsnummer|receipt|facture|fattura|quittung)$/iu;
/** The same for a credit note: on a credit note an invoice word names the invoice it corrects. */
const FILE_CREDIT_WORD = /^(?:gutschrift|credit|creditnote|storno)$/iu;
/** Words that make a number in the name another document's: an order, a customer, a contract. */
const FILE_OTHER_WORD = /^(?:order|orders|bestellung|bestellnummer|kunde|kundennummer|customer|vertrag|contract|auftrag)$/iu;

/**
 * The number a stored file's name labels, as the recognized text prints it:
 * the name says it is an invoice or a receipt ("Adobe-Invoice-...",
 * "Rechnung_..."), or a credit note for a credit note, and names no order,
 * customer or contract; the candidate is an unmistakable identifier
 * (`strongToken`, so the date stamp of "Invoice-2026-01-20" is none) that the
 * recognized text carries as a whole token. Exactly one such candidate, else
 * none: a file name is a person's or a portal's, and only the text confirms it.
 */
export function invoiceNumberFromFileName(fileName: string | null | undefined, text: string, options: ParseOptions = {}): string | null {
  if (!fileName || !text.trim()) return null;
  const stem = fileName.normalize('NFKC').replace(/\.[A-Za-z0-9]{1,5}$/u, '');
  const words = stem.split(/[\s_.,()[\]{}+-]+/u).filter(Boolean);
  if (words.some((w) => FILE_OTHER_WORD.test(w))) return null;
  if (!words.some((w) => (options.creditNote ? FILE_CREDIT_WORD : FILE_INVOICE_WORD).test(w))) return null;
  // Candidates: each part between separators, and every run of its dash-joined pieces ("RE-2026-0042").
  const candidates = new Set<string>();
  for (const part of stem.split(/[\s_.,()[\]{}+]+/u).filter(Boolean)) {
    const pieces = part.split('-').filter(Boolean);
    for (let a = 0; a < pieces.length; a++) for (let b = a + 1; b <= pieces.length; b++) candidates.add(pieces.slice(a, b).join('-'));
  }
  const carried = [...candidates].filter((c) => strongToken(c) && carriesInvoiceNumber(text, c));
  // A candidate inside a longer carried one is the same number cut short.
  const kept = carried.filter((c) => !carried.some((other) => other.length > c.length && invoiceNumberKey(other)!.includes(invoiceNumberKey(c)!)));
  const distinct = new Map(kept.map((c) => [invoiceNumberKey(c)!, c]));
  return distinct.size === 1 ? cleanInvoiceNumber([...distinct.values()][0]) : null;
}

/** Where a number read again from what a receipt has stored came from. */
export type StoredNumberSource = 'text' | 'file_name';

/**
 * The number of a stored receipt read again from what is stored, no model
 * asked: the label in its text first, else a file name the text bears out.
 * Null without text: nothing could confirm a number.
 */
export function rereadStoredInvoiceNumber(stored: { text: string; fileNames: readonly string[]; creditNote: boolean }): { number: string; source: StoredNumberSource } | null {
  if (!stored.text.trim()) return null;
  const parsed = parseInvoiceNumber(stored.text, { creditNote: stored.creditNote });
  if (parsed) return { number: parsed, source: 'text' };
  const fromNames = new Map<string, string>();
  for (const name of stored.fileNames) {
    const found = invoiceNumberFromFileName(name, stored.text, { creditNote: stored.creditNote });
    if (found) fromNames.set(invoiceNumberKey(found) ?? found, found);
  }
  // Two files naming two different numbers say nothing about which is this receipt's.
  return fromNames.size === 1 ? { number: [...fromNames.values()][0], source: 'file_name' } : null;
}

export interface InvoiceNumberSources {
  /** The number an electronic invoice's XML states (BT-1). */
  structured: string | null;
  /** The recognized text the receipt was read from. */
  text: string;
  /** The uploaded file's name: a number it labels counts where the text carries it (`invoiceNumberFromFileName`). */
  fileName?: string | null;
  /** The model's answer. Taken only where the text carries it. */
  model: string | null;
  /** True when no text was recognized and the figures were read from the page image alone. */
  fromImageOnly: boolean;
  creditNote: boolean;
}

/**
 * The number a reading stores: the XML's; else the one the text labels; else
 * the one the file name labels, where the text carries it; else the model's,
 * where the recognized text carries it as a whole token. A reading from the
 * image alone gives none: nothing can confirm it.
 */
export function settleInvoiceNumber(sources: InvoiceNumberSources): string | null {
  const structured = cleanInvoiceNumber(sources.structured);
  if (structured) return structured;
  if (sources.fromImageOnly || !sources.text.trim()) return null;
  const parsed = parseInvoiceNumber(sources.text, { creditNote: sources.creditNote });
  if (parsed) return parsed;
  const named = invoiceNumberFromFileName(sources.fileName, sources.text, { creditNote: sources.creditNote });
  if (named) return named;
  const model = cleanInvoiceNumber(sources.model);
  return model && carriesInvoiceNumber(sources.text, model) ? model : null;
}
