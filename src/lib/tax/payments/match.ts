/**
 * Proposing which payment belongs to which document. Pure.
 *
 * A link is only ever made on a reference: the invoice number (or a receipt's
 * own number) appearing in the payment's text. Amount and date alone are never
 * enough to link by themselves, because payment services relabel merchants and
 * add fees; they only produce a candidate a person has to confirm. The same
 * holds for the proposals for receipts on an estimated amount at the end of
 * this file.
 */

export interface MatchPayment {
  id: string;
  bookingDay: string;
  /** Signed cents: negative is money out. */
  amountCents: number;
  reference: string;
  counterparty: string;
  /** The counterparty and the text as vendor keys; given, a candidate by amount and date says whether the vendor is named. */
  counterpartyKey?: string;
  referenceKey?: string;
}

export interface MatchDocument {
  id: string;
  /** The document's own number as printed (an invoice number). Null when it has none. */
  number: string | null;
  /** ISO day of the document. */
  day: string | null;
  /** The amount that is still unpaid, in cents, as a positive number. */
  openCents: number;
  /** The receipt's vendor as a key; null or absent: none known. */
  vendorKey?: string | null;
}

export type MatchStrength =
  /** The document's number appears in the payment's text and the amount fits what is open. */
  | 'reference'
  /** The number appears, but the amount differs (a part payment, a fee kept on the way). */
  | 'reference_amount_differs'
  /** Amount and date fit and the payment names the receipt's vendor. A candidate to confirm, never linked on its own. */
  | 'amount_date_vendor'
  /** Only amount and date fit. A candidate to confirm, never linked on its own. */
  | 'amount_and_date';

export interface MatchProposal {
  paymentId: string;
  documentId: string;
  strength: MatchStrength;
}

/** Letters and digits only, lower case: "RE-2026/001" and "re 2026 001" are the same number. */
export function normalizeNumber(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Words that announce an invoice number in a transfer text: "Rechnung 61",
 * "RE 61", "Rechnungsnummer 61", "Invoice 61", "Rechnungs-Nr. 61". The number
 * must follow one of them directly (glued is fine: "RE61", "Rechnung-61").
 */
export const INVOICE_WORDS: ReadonlySet<string> = new Set([
  'rechnung',
  'rechnungen',
  'rechnungs',
  'rechnungsnr',
  'rechnungsnummer',
  'rg',
  'rgnr',
  're',
  'renr',
  'invoice',
  'inv',
]);

/**
 * "Nr", "No" and "Nummer" announce an invoice number only after an invoice
 * word ("Rechnung Nr. 61", "Rg.-Nr. 61") or at the very start of the text
 * ("Nr. 61"). After anything else they belong to another number: "Kunden-Nr.
 * 12", "Auftrags-Nr 7", "Steuer-Nr. 5" name no invoice.
 */
const NUMBER_WORDS: ReadonlySet<string> = new Set(['nr', 'no', 'nummer']);

/** Words that continue a list of invoice numbers: "Rechnung 61 und 62". */
const LIST_JOINERS: ReadonlySet<string> = new Set(['und', 'u', 'and', 'sowie']);

/**
 * A purely numeric number up to this many digits says too little on its own
 * (the plain invoice series, and a postal code or a quantity look the same),
 * so it counts only next to an invoice word. Longer ones count wherever they
 * stand as a whole figure.
 */
export const DIGITS_NEEDING_INVOICE_WORD = 5;

/**
 * An account number in international form (IBAN), with or without spaces:
 * never an invoice number. Country, check digits, one group that may hold a
 * bank code in letters ("GB29 NWBK ..."), then groups of digits.
 */
const IBAN_CANDIDATE = /\b[a-z]{2}\d{2} ?[a-z0-9]{4}(?: ?\d{4}){2,6}(?: ?\d{1,3})?\b/gi;

/** The IBAN check digits (mod 97 equals 1): "RE61 1234 5678 9012" looks like one but is not. */
export function isValidIban(text: string): boolean {
  const compact = text.replace(/ /g, '').toUpperCase();
  if (compact.length < 15 || compact.length > 34) return false;
  const rearranged = compact.slice(4) + compact.slice(0, 4);
  let remainder = 0;
  for (const char of rearranged) {
    const value = char >= 'A' && char <= 'Z' ? String(char.charCodeAt(0) - 55) : char;
    for (const digit of value) remainder = (remainder * 10 + Number(digit)) % 97;
  }
  return remainder === 1;
}

/** A word or a figure of the transfer text, with the text between it and the token before. */
interface Token {
  text: string;
  gapBefore: string;
}

/**
 * The transfer text as words and figures, account numbers removed. A figure
 * keeps its inner separators ("12.10.2026", "61,00", "1.001", "61/62" are one
 * figure each), so a number inside a date, an amount or a longer figure never
 * stands as a figure of its own. Letters and digits glued together are
 * separate tokens ("RE61" is "re", "61").
 */
function figureTokens(reference: string): Token[] {
  const text = reference.toLowerCase().replace(IBAN_CANDIDATE, (match) => (isValidIban(match) ? ' '.repeat(match.length) : match));
  const tokens: Token[] = [];
  let end = 0;
  for (const match of text.matchAll(/[a-zäöüß]+|\d+(?:[.,/:-]\d+)*/g)) {
    tokens.push({ text: match[0], gapBefore: text.slice(end, match.index) });
    end = match.index + match[0].length;
  }
  return tokens;
}

/** "061" and "61" are the same number. */
const stripLeadingZeros = (digits: string) => digits.replace(/^0+(?=\d)/, '');
const isDigits = (token: string) => /^\d+$/.test(token);
/** Between two numbers of a list: "61, 62", "61 + 62", "61 & 62". A bare space is not enough. */
const isListGap = (gap: string) => /^\s*[,+&]\s*$/.test(gap);

/**
 * Is "<number> <three digits>[,<cents>]" an amount written with a space as the
 * thousands separator ("1 500,00")? Only when it equals the payment's amount;
 * without a known amount it is taken as one, the safe side.
 */
function isAmountWithSpace(number: string, next: Token | undefined, amountCents: number | undefined): boolean {
  if (!next || !/^\s+$/.test(next.gapBefore)) return false;
  const group = /^(\d{3})(?:[.,](\d{1,2}))?$/.exec(next.text);
  if (!group) return false;
  if (amountCents === undefined) return true;
  const cents = (Number(number) * 1000 + Number(group[1])) * 100 + Number((group[2] ?? '0').padEnd(2, '0'));
  return cents === Math.abs(amountCents);
}

/**
 * Is a short purely numeric invoice number named in the text? Only as a whole
 * figure, and only where it cannot be anything else: the whole text is that
 * number, or the number follows an invoice word directly, or continues such a
 * list ("Rechnung 61 und 62", "Rechnung 61, 62", "RE 61 + 62"). A bare
 * second number closes the list ("Rechnung 61 500 EUR" names 61 only), and a
 * number that forms the payment's amount with the group after it is an amount
 * ("Rechnung 1 500,00 EUR" for a payment of 1,500.00 names no invoice).
 * Invoice 5 is never found in "52", "Rechnung 52", "12.05.2026", an amount
 * of "5,00" or an account number. Lists written without spaces ("61,62",
 * "61-62", "61/62") are one figure and name neither invoice: the safe side,
 * the payment is then proposed by amount for a person to confirm.
 */
function numberNextToInvoiceWord(tokens: readonly Token[], needle: string, amountCents: number | undefined): boolean {
  if (tokens.length === 1 && isDigits(tokens[0].text)) return stripLeadingZeros(tokens[0].text) === needle;
  let state: 'none' | 'word' | 'number' | 'joiner' = 'none';
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index].text;
    const listContinues = state === 'number' && isListGap(tokens[index].gapBefore);
    if (INVOICE_WORDS.has(token) || (NUMBER_WORDS.has(token) && (state === 'word' || index === 0))) {
      state = 'word';
    } else if (isDigits(token) && (state === 'word' || state === 'joiner' || listContinues)) {
      // "19 %" is a rate ("Rechnung 61 + 19% MwSt"), and "1 500,00" may be the payment's amount.
      if (/^\s*%/.test(tokens[index + 1]?.gapBefore ?? '') || isAmountWithSpace(token, tokens[index + 1], amountCents)) state = 'none';
      else {
        if (stripLeadingZeros(token) === needle) return true;
        state = 'number';
      }
    } else if (LIST_JOINERS.has(token) && state === 'number') {
      state = 'joiner';
    } else {
      state = 'none';
    }
  }
  return false;
}

/** "2026-10-01" is a date, not the number 20261001. */
const isIsoDate = (figure: string) => /^\d{4}-\d{2}-\d{2}$/.test(figure) && !Number.isNaN(Date.parse(`${figure}T00:00:00Z`));

/**
 * Is a long purely numeric number named in the text? As a whole run of
 * neighbouring figures (separated by spaces only): one figure ("2026001", or
 * with a dash or a slash, "2026-001", but not a date) or groups spelled with
 * spaces ("2026 001"). Never part of a longer run: "Kunde 123 4567" does not
 * name 1234567 and "Tel 030 2026001" does not name 2026001. Never inside a
 * date, an amount or an account number.
 */
function longNumberMentioned(tokens: readonly Token[], needle: string): boolean {
  const asDigits = (token: string) => (/^\d+(?:[-/]\d+)*$/.test(token) && !isIsoDate(token) ? token.replace(/[-/]/g, '') : null);
  let run: string[] = [];
  // A lone group of zeros in front ("Kd 0 2026001") is another figure, not leading zeros of the number.
  const runMatches = () => run.length > 0 && !(run.length > 1 && /^0+$/.test(run[0])) && stripLeadingZeros(run.join('')) === needle;
  for (const token of tokens) {
    const digits = asDigits(token.text);
    if (digits !== null && run.length > 0 && /^\s+$/.test(token.gapBefore)) {
      run.push(digits);
      continue;
    }
    if (runMatches()) return true;
    run = digits === null ? [] : [digits];
  }
  return runMatches();
}

/**
 * Does the payment's text carry the document's number? Always as a whole
 * token, never as a stretch of digits inside a longer figure (decision D5 of
 * the invoicing plan).
 *
 * - A purely numeric number of up to five digits (the plain invoice series,
 *   invoice 61) counts only when it is the whole text or follows an invoice
 *   word: "Rechnung 61", "RE61", "Rechnung Nr. 61". Leading zeros do not
 *   matter.
 * - A longer purely numeric number counts as a whole figure anywhere.
 * - A number with letters ("RE-2026/001") counts wherever it stands as its own
 *   word or spelled with spaces or dashes ("re 2026 001"), from four
 *   characters on; a shorter one ("RE-5") says too little and never counts.
 *
 * `amountCents` is the payment's amount (signed or not), used to tell an
 * amount written with a space ("1 500,00") from an invoice number followed by
 * an amount ("Rechnung 61 150,00").
 */
export function referenceMentions(reference: string, number: string | null, amountCents?: number): boolean {
  if (!number) return false;
  const needle = normalizeNumber(number);
  if (isDigits(needle)) {
    const digits = stripLeadingZeros(needle);
    if (digits === '0') return false;
    const tokens = figureTokens(reference);
    return digits.length <= DIGITS_NEEDING_INVOICE_WORD ? numberNextToInvoiceWord(tokens, digits, amountCents) : longNumberMentioned(tokens, digits);
  }
  if (needle.length < 4 || !/\d/.test(needle)) return false;
  // Compare token-wise first (the number as its own word), then glued spellings.
  const tokens = reference.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  for (let start = 0; start < tokens.length; start++) {
    let joined = '';
    for (let end = start; end < tokens.length && joined.length < needle.length; end++) {
      joined += tokens[end];
      if (joined === needle) return true;
    }
  }
  return false;
}

function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

/**
 * Proposals for payments and documents of one direction (payments for
 * purchases against receipts, or money received against issued invoices).
 * `payments` must already be reduced to that direction; their amounts are
 * compared by magnitude.
 *
 * A reference proposal is exclusive when it is unambiguous. Amount-and-date
 * candidates are offered only for payments and documents that have no
 * reference proposal, and only within the window: a payment from 5 days before
 * the document to 60 days after it.
 */
export function proposeMatches(payments: readonly MatchPayment[], documents: readonly MatchDocument[]): MatchProposal[] {
  const proposals: MatchProposal[] = [];
  const paymentHasReference = new Set<string>();
  const documentHasReference = new Set<string>();

  for (const payment of payments) {
    for (const document of documents) {
      if (document.openCents <= 0 || !referenceMentions(payment.reference, document.number, payment.amountCents)) continue;
      const exact = Math.abs(payment.amountCents) === document.openCents;
      proposals.push({ paymentId: payment.id, documentId: document.id, strength: exact ? 'reference' : 'reference_amount_differs' });
      paymentHasReference.add(payment.id);
      documentHasReference.add(document.id);
    }
  }

  for (const payment of payments) {
    if (paymentHasReference.has(payment.id)) continue;
    for (const document of documents) {
      if (documentHasReference.has(document.id) || document.openCents <= 0 || document.day === null) continue;
      if (Math.abs(payment.amountCents) !== document.openCents) continue;
      const gap = daysBetween(document.day, payment.bookingDay);
      if (gap < -5 || gap > 60) continue;
      const named = payment.counterpartyKey !== undefined && vendorNamed(document.vendorKey ?? null, payment.counterpartyKey, payment.referenceKey ?? '');
      proposals.push({ paymentId: payment.id, documentId: document.id, strength: named ? 'amount_date_vendor' : 'amount_and_date' });
    }
  }
  // The vendor named first: of several receipts of the same amount, the one of this vendor is the likely one.
  return proposals.sort((a, b) => (a.paymentId === b.paymentId ? Number(b.strength === 'amount_date_vendor') - Number(a.strength === 'amount_date_vendor') : 0));
}

/**
 * The proposals that may be linked without asking: a reference match with the
 * exact amount where the payment points at exactly one document and the
 * document is pointed at by exactly one payment.
 */
export function unambiguousReferenceMatches(proposals: readonly MatchProposal[]): MatchProposal[] {
  const strong = proposals.filter((p) => p.strength === 'reference');
  const perPayment = new Map<string, number>();
  const perDocument = new Map<string, number>();
  for (const p of proposals.filter((x) => x.strength !== 'amount_and_date' && x.strength !== 'amount_date_vendor')) {
    perPayment.set(p.paymentId, (perPayment.get(p.paymentId) ?? 0) + 1);
    perDocument.set(p.documentId, (perDocument.get(p.documentId) ?? 0) + 1);
  }
  return strong.filter((p) => perPayment.get(p.paymentId) === 1 && perDocument.get(p.documentId) === 1);
}

// ── Receipts whose euro amount is an estimate ────────────────────────────────

/** A receipt as the estimate proposal sees it. */
export interface EstimateDocument {
  id: string;
  /** The normalized vendor (lower case words, single spaces); null when the receipt names none. */
  vendorKey: string | null;
  day: string | null;
  /** Euro cents: the reference-rate estimate when `estimated`, otherwise the document's own amount. */
  amountCents: number;
  /** True for a foreign-currency receipt converted at a reference rate. */
  estimated: boolean;
}

/** A payment out that is linked to nothing yet. Names are normalized like `vendorKey`. */
export interface EstimatePayment {
  id: string;
  bookingDay: string;
  /** Signed cents; compared by magnitude. */
  amountCents: number;
  counterpartyKey: string;
  referenceKey: string;
  /**
   * Vendors this counterparty is known to stand for: the vendors of receipts
   * its payments are linked to. A service lists the product ("editor") where
   * the invoice names the company behind it; one link by hand teaches the pairing.
   */
  vendorAliases?: readonly string[];
}

export interface EstimateProposal {
  paymentId: string;
  documentId: string;
  /** The receipt has exactly this one payment, and the payment fits no other receipt. */
  unambiguous: boolean;
  /**
   * The payment fits this receipt together with another estimated receipt of
   * the vendor better than it fits this one alone: two invoices charged in
   * one sum. Never unambiguous; a person splits the payment by hand.
   */
  severalReceipts: boolean;
}

/** The window a payment may lie in around the receipt's day, and how far it may be from the estimate. */
export const ESTIMATE_DAYS_BEFORE = 3;
export const ESTIMATE_DAYS_AFTER = 10;
export const ESTIMATE_TOLERANCE_PERCENT = 8;

const hasWords = (text: string, words: string) => ` ${text} `.includes(` ${words} `);

/**
 * Is the receipt's vendor the payment's other side? The vendor's name must
 * stand as whole words in the counterparty or in the payment's text ("webflow"
 * in "webflow com"), or the counterparty's name in the vendor's ("notion" in
 * "notion labs"). A counterparty of one or two letters says nothing.
 */
export function vendorNamed(vendorKey: string | null, counterpartyKey: string, referenceKey: string): boolean {
  if (!vendorKey) return false;
  if (hasWords(counterpartyKey, vendorKey) || hasWords(referenceKey, vendorKey)) return true;
  return counterpartyKey.length >= 3 && hasWords(vendorKey, counterpartyKey);
}

/**
 * Proposals for receipts on an estimated euro amount: a foreign-currency
 * receipt never equals what the bank charged, so the exact-amount candidates
 * above cannot find its payment. Here the vendor has to be named, the payment
 * booked from 3 days before to 10 days after the receipt, and the amount within
 * 8 percent of the estimate. The vendor is named by its words in the payment,
 * or by a pairing a person made before (`vendorAliases`). A payment that pays
 * two receipts of the vendor in one sum is offered for both and marked.
 *
 * `documents` are all receipts no payment is linked to, the euro ones too:
 * they receive no proposal here, but a payment that also fits one of them
 * (same vendor, same window, the exact amount) is not unambiguous.
 * Nothing is linked by this function; a person accepts a proposal.
 */
export function proposeEstimateMatches(payments: readonly EstimatePayment[], documents: readonly EstimateDocument[]): EstimateProposal[] {
  const dayNumber = (day: string) => Math.round(Date.parse(`${day}T00:00:00Z`) / 86_400_000);
  const paid = payments.map((p) => ({ p, day: dayNumber(p.bookingDay), cents: Math.abs(p.amountCents) }));
  const within = (cents: number, estimate: number) => Math.abs(cents - estimate) * 100 <= ESTIMATE_TOLERANCE_PERCENT * estimate;
  const pairs: Array<{ paymentId: string; document: EstimateDocument }> = [];
  // Per payment, the estimated receipts of its vendor in the window, whatever their amount: the parts one sum may pay.
  const near = new Map<string, { cents: number; documents: EstimateDocument[] }>();
  for (const document of documents) {
    if (document.day === null || document.vendorKey === null || document.amountCents <= 0) continue;
    const day = dayNumber(document.day);
    for (const { p, day: booked, cents } of paid) {
      const gap = booked - day;
      if (gap < -ESTIMATE_DAYS_BEFORE || gap > ESTIMATE_DAYS_AFTER) continue;
      if (!vendorNamed(document.vendorKey, p.counterpartyKey, p.referenceKey) && !(p.vendorAliases ?? []).includes(document.vendorKey)) continue;
      if (document.estimated) {
        const entry = near.get(p.id) ?? { cents, documents: [] };
        entry.documents.push(document);
        near.set(p.id, entry);
      }
      if (document.estimated ? within(cents, document.amountCents) : cents === document.amountCents) pairs.push({ paymentId: p.id, document });
    }
  }
  // One payment for two receipts: the sum of two fits, and fits better than either does alone.
  const several = new Set<string>();
  for (const [paymentId, { cents, documents: parts }] of near) {
    for (let a = 0; a < parts.length; a++) {
      for (let b = a + 1; b < parts.length; b++) {
        const sum = parts[a].amountCents + parts[b].amountCents;
        // Better than EITHER alone: a receipt that fits by itself to the cent is not made part of a sum.
        if (!within(cents, sum) || Math.abs(cents - sum) >= Math.min(Math.abs(cents - parts[a].amountCents), Math.abs(cents - parts[b].amountCents))) continue;
        for (const part of [parts[a], parts[b]]) {
          several.add(`${paymentId}|${part.id}`);
          if (!pairs.some((pair) => pair.paymentId === paymentId && pair.document.id === part.id)) pairs.push({ paymentId, document: part });
        }
      }
    }
  }
  const perPayment = new Map<string, number>();
  const perDocument = new Map<string, number>();
  for (const pair of pairs) {
    perPayment.set(pair.paymentId, (perPayment.get(pair.paymentId) ?? 0) + 1);
    perDocument.set(pair.document.id, (perDocument.get(pair.document.id) ?? 0) + 1);
  }
  return pairs
    .filter((pair) => pair.document.estimated)
    .map((pair) => ({
      paymentId: pair.paymentId,
      documentId: pair.document.id,
      unambiguous: perPayment.get(pair.paymentId) === 1 && perDocument.get(pair.document.id) === 1 && !several.has(`${pair.paymentId}|${pair.document.id}`),
      severalReceipts: several.has(`${pair.paymentId}|${pair.document.id}`),
    }));
}
