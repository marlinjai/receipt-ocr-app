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
}

export interface MatchDocument {
  id: string;
  /** The document's own number as printed (an invoice number). Null when it has none. */
  number: string | null;
  /** ISO day of the document. */
  day: string | null;
  /** The amount that is still unpaid, in cents, as a positive number. */
  openCents: number;
}

export type MatchStrength =
  /** The document's number appears in the payment's text and the amount fits what is open. */
  | 'reference'
  /** The number appears, but the amount differs (a part payment, a fee kept on the way). */
  | 'reference_amount_differs'
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
 * Does the payment's text carry the document's number? The number must be
 * long enough to mean something (four characters with at least one digit),
 * and must not merely be a stretch of digits inside a longer number.
 */
export function referenceMentions(reference: string, number: string | null): boolean {
  if (!number) return false;
  const needle = normalizeNumber(number);
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
      if (document.openCents <= 0 || !referenceMentions(payment.reference, document.number)) continue;
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
      if (gap >= -5 && gap <= 60) proposals.push({ paymentId: payment.id, documentId: document.id, strength: 'amount_and_date' });
    }
  }
  return proposals;
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
  for (const p of proposals.filter((x) => x.strength !== 'amount_and_date')) {
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
