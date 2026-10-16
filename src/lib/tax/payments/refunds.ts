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
 * alone, and never linked without a person's click.
 */

export type RefundStrength =
  /** The refund's text and the purchase's text share an order or transaction number. */
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

/**
 * Numbers that identify an order or a transaction: a run of letters and digits
 * at least six long with at least four digits, lower case, separators removed
 * ("302-1234567-1234567" is one). A day written with dashes is left out;
 * amounts (with a decimal comma) and short numbers never qualify.
 */
export function orderNumbers(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of text.toLowerCase().match(/[a-z0-9][a-z0-9-]{4,}[a-z0-9]/g) ?? []) {
    // A day written with dashes is no number of an order.
    if (/^\d{4}-\d{2}-\d{2}$|^\d{2}-\d{2}-\d{4}$/.test(raw)) continue;
    const token = raw.replace(/-/g, '');
    if (token.length >= 6 && (token.match(/\d/g)?.length ?? 0) >= 4) out.add(token);
  }
  return out;
}

/**
 * For each refund, the receipts it can belong to, best first: same
 * counterparty, the purchase before the refund and not more than
 * `REFUND_WINDOW_DAYS` earlier, and never more money back than the receipt
 * still costs.
 */
export function proposeRefunds(refunds: readonly RefundMoney[], targets: readonly RefundTarget[]): RefundProposal[] {
  const proposals: RefundProposal[] = [];
  for (const refund of refunds) {
    if (!refund.counterpartyKey || refund.amountCents <= 0) continue;
    const refundNumbers = orderNumbers(refund.reference);
    const found: Array<RefundProposal & { gap: number }> = [];
    for (const target of targets) {
      if (target.remainingCents < refund.amountCents) continue;
      const purchases = target.purchases.filter((p) => p.counterpartyKey === refund.counterpartyKey);
      let strength: RefundStrength | null = null;
      let gap = Number.POSITIVE_INFINITY;
      if (purchases.length > 0) {
        for (const purchase of purchases) {
          const days = daysBetween(purchase.bookingDay, refund.bookingDay);
          if (days < 0 || days > REFUND_WINDOW_DAYS) continue;
          const shared = [...orderNumbers(purchase.reference)].some((n) => refundNumbers.has(n));
          const candidate: RefundStrength = shared ? 'refund_reference' : purchase.cents === refund.amountCents ? 'refund_full' : 'refund_part';
          if (strength === null || RANK[candidate] < RANK[strength] || (RANK[candidate] === RANK[strength] && days < gap)) {
            strength = candidate;
            gap = days;
          }
        }
      } else if (target.purchases.length === 0 && target.vendorKey && target.day !== null && sameName(target.vendorKey, refund.counterpartyKey)) {
        // A receipt without a linked purchase (paid in cash, or its payment is not imported) by its vendor.
        const days = daysBetween(target.day, refund.bookingDay);
        if (days >= 0 && days <= REFUND_WINDOW_DAYS) {
          strength = target.remainingCents === refund.amountCents ? 'refund_full' : 'refund_part';
          gap = days;
        }
      }
      if (strength !== null) found.push({ paymentId: refund.id, rowId: target.rowId, strength, gap });
    }
    found.sort((a, b) => RANK[a.strength] - RANK[b.strength] || a.gap - b.gap);
    for (const { paymentId, rowId, strength } of found.slice(0, REFUND_PROPOSALS_PER_PAYMENT)) proposals.push({ paymentId, rowId, strength });
  }
  return proposals;
}

/** The vendor on a receipt and the name on a bank line are the same business when one contains the other word by word. */
function sameName(vendorKey: string, counterpartyKey: string): boolean {
  const words = (key: string) => key.split(' ').filter(Boolean);
  const contains = (outer: string[], inner: string[]) => inner.length > 0 && ` ${outer.join(' ')} `.includes(` ${inner.join(' ')} `);
  return contains(words(counterpartyKey), words(vendorKey)) || contains(words(vendorKey), words(counterpartyKey));
}
