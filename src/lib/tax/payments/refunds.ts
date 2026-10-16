/**
 * Proposing the receipt a refund belongs to. Pure.
 *
 * Money back for a purchase belongs on the purchase's receipt, where it is
 * taken off (`linkedByRow`): a purchase refunded in full then costs nothing,
 * and one refunded in part costs the rest. Before, a refund was asked about
 * with no proposal at all, so every refunded purchase had to be found and
 * linked by hand (or kept out of the year by hand).
 *
 * A refund is proposed for a receipt only through its counterparty: the
 * receipt carries a purchase from the same counterparty (a linked payment out),
 * or, without one, names that counterparty as its vendor. Never by amount
 * alone, and never linked without a person's click. Only within one year: under
 * cash-basis accounting money back counts in the year it arrives, and linking
 * it to last year's receipt would change that year.
 */

import { vendorNamed } from './match';

export type RefundStrength =
  /** The refund's text and the purchase's text share an order or transaction number no other purchase carries. */
  | 'refund_reference'
  /** The refund is exactly what the purchase on the receipt cost: refunded in full. */
  | 'refund_full'
  /** The refund is less than what the receipt still costs: a part refund, or one of several. */
  | 'refund_part';

export interface RefundMoney {
  id: string;
  bookingDay: string;
  /** Positive: money in. */
  amountCents: number;
  counterpartyKey: string;
  reference: string;
  /** What the file says it is: money back, or money in it calls income (then only a strong match is proposed). */
  kind: 'refund' | 'income';
  /** True when the counterparty is a payment service or marketplace that stands for many shops (PayPal): only a shared number counts. */
  intermediary?: boolean;
}

/** A receipt that can take money back, with what it still costs and the purchases on it. */
export interface RefundTarget {
  rowId: string;
  /** The receipt's day: a refund comes after the purchase. */
  day: string | null;
  /** The receipt's vendor, normalized like a counterparty key; null without one. */
  vendorKey: string | null;
  /** What the receipt costs today: linked payments out less money back already on it, or its own amount. */
  remainingCents: number;
  /** Payments out linked to the receipt (the purchase), with their part. */
  purchases: Array<{ bookingDay: string; cents: number; counterpartyKey: string; reference: string }>;
}

export interface RefundProposal {
  paymentId: string;
  rowId: string;
  strength: RefundStrength;
}

/** How long after a purchase money back is still looked for: returns and disputes take months. */
export const REFUND_WINDOW_DAYS = 180;
/** At most this many proposals per refund, best first. */
export const REFUND_PROPOSALS_PER_PAYMENT = 3;

const RANK: Record<RefundStrength, number> = { refund_reference: 0, refund_full: 1, refund_part: 2 };

function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

/** A run of digits that reads as a day: 20250320, 200325, 2025-03-20, 20-03-25. */
const DATE_LIKE = /^(\d{4}-\d{2}-\d{2}|\d{2}-\d{2}-\d{2,4}|(19|20)\d{2}(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])|(0[1-9]|[12]\d|3[01])(0[1-9]|1[0-2])\d{2})$/;

/**
 * Numbers that may identify an order or a transaction: a run of letters and
 * digits at least six long with at least four digits, lower case, separators
 * removed ("302-1234567-1234567" is one). Left out are what banks print on
 * every line of a shop: a day, a masked card ("XXXX1234"), an account number
 * (IBAN, International Bank Account Number), a direct-debit creditor id (with
 * "ZZZ"). Whether a number really names one order is judged against the other
 * purchases (`proposeRefunds`).
 */
export function orderNumbers(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of text.toLowerCase().match(/[a-z0-9][a-z0-9-]{4,}[a-z0-9]/g) ?? []) {
    if (DATE_LIKE.test(raw)) continue;
    const token = raw.replace(/-/g, '');
    if (DATE_LIKE.test(token)) continue;
    if (/^x+\d+$/.test(token) || /^[a-z]{2}\d{2}[a-z0-9]{10,30}$/.test(token) || token.includes('zzz')) continue;
    if (token.length >= 6 && (token.match(/\d/g)?.length ?? 0) >= 4) out.add(token);
  }
  return out;
}

/**
 * For each refund, the receipts it can belong to, best first: same
 * counterparty, the purchase (or the receipt) before the refund, in the same
 * year and not more than `REFUND_WINDOW_DAYS` earlier, and never more money
 * back than the receipt still costs. A shared number counts only when no other
 * purchase of that counterparty carries it (a customer or mandate number is on
 * all of them). Money in the file calls income is proposed only on a shared
 * number or as a refund in full; from a payment service or marketplace only on
 * a shared number.
 */
export function proposeRefunds(refunds: readonly RefundMoney[], targets: readonly RefundTarget[]): RefundProposal[] {
  // Indexed once: the purchases by counterparty with their numbers, and how many purchases carry each number.
  const byCounterparty = new Map<string, Array<{ target: RefundTarget; bookingDay: string; cents: number; numbers: Set<string> }>>();
  const numberCount = new Map<string, number>();
  const withoutPurchase: RefundTarget[] = [];
  for (const target of targets) {
    if (target.purchases.length === 0) withoutPurchase.push(target);
    for (const purchase of target.purchases) {
      const numbers = orderNumbers(purchase.reference);
      const list = byCounterparty.get(purchase.counterpartyKey) ?? [];
      list.push({ target, bookingDay: purchase.bookingDay, cents: purchase.cents, numbers });
      byCounterparty.set(purchase.counterpartyKey, list);
      for (const n of numbers) numberCount.set(`${purchase.counterpartyKey}|${n}`, (numberCount.get(`${purchase.counterpartyKey}|${n}`) ?? 0) + 1);
    }
  }

  const proposals: RefundProposal[] = [];
  for (const refund of refunds) {
    if (!refund.counterpartyKey || refund.amountCents <= 0) continue;
    const year = refund.bookingDay.slice(0, 4);
    const refundNumbers = orderNumbers(refund.reference);
    const allowed = (strength: RefundStrength) =>
      strength === 'refund_reference' || (!refund.intermediary && (refund.kind === 'refund' || strength === 'refund_full'));
    const best = new Map<string, { strength: RefundStrength; gap: number }>();
    const offer = (target: RefundTarget, strength: RefundStrength, gap: number) => {
      if (!allowed(strength) || target.remainingCents < refund.amountCents) return;
      const current = best.get(target.rowId);
      if (!current || RANK[strength] < RANK[current.strength] || (RANK[strength] === RANK[current.strength] && gap < current.gap)) best.set(target.rowId, { strength, gap });
    };
    for (const purchase of byCounterparty.get(refund.counterpartyKey) ?? []) {
      const gap = daysBetween(purchase.bookingDay, refund.bookingDay);
      if (gap < 0 || gap > REFUND_WINDOW_DAYS || !purchase.bookingDay.startsWith(year)) continue;
      const shared = [...purchase.numbers].some((n) => refundNumbers.has(n) && numberCount.get(`${refund.counterpartyKey}|${n}`) === 1);
      offer(purchase.target, shared ? 'refund_reference' : purchase.cents === refund.amountCents ? 'refund_full' : 'refund_part', gap);
    }
    // A receipt without a linked purchase (paid in cash, or its payment is not imported) by its vendor.
    for (const target of withoutPurchase) {
      if (target.day === null || !target.day.startsWith(year) || !vendorNamed(target.vendorKey, refund.counterpartyKey, '')) continue;
      const gap = daysBetween(target.day, refund.bookingDay);
      if (gap < 0 || gap > REFUND_WINDOW_DAYS) continue;
      offer(target, target.remainingCents === refund.amountCents ? 'refund_full' : 'refund_part', gap);
    }
    [...best.entries()]
      .sort(([, a], [, b]) => RANK[a.strength] - RANK[b.strength] || a.gap - b.gap)
      .slice(0, REFUND_PROPOSALS_PER_PAYMENT)
      .forEach(([rowId, { strength }]) => proposals.push({ paymentId: refund.id, rowId, strength }));
  }
  return proposals;
}
