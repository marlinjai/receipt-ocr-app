/**
 * Proposing which payment belongs to which document. Pure.
 *
 * A link is only ever made on a reference: the invoice number (or a receipt's
 * own number) appearing in the payment's text. Amount and date alone are never
 * enough to link by themselves, because payment services relabel merchants and
 * add fees; they only produce a candidate a person has to confirm.
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
