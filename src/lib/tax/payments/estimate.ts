/**
 * How far the euro amount charged may lie from a purchase's estimate (another
 * currency at the reference rate): PayPal converts with a margin of about 3 to
 * 4.5 percent over that rate, and the rate of the next day may apply.
 */
export const ESTIMATE_TOLERANCE_PERCENT = 6;

/** Whether `otherCents` (signed) can be what an estimate of `estimateCents` (signed) was charged: same sign, within the tolerance. */
export function withinEstimate(estimateCents: number, otherCents: number): boolean {
  if (Math.sign(estimateCents) !== Math.sign(otherCents)) return false;
  return Math.abs(otherCents - estimateCents) * 100 <= Math.abs(estimateCents) * ESTIMATE_TOLERANCE_PERCENT;
}

/**
 * Links of a payment of `from` cents scaled to `to` cents: together they come
 * to the scaled total (all of `to` when they covered the whole payment), each
 * gets its share rounded down and the cents left go one by one to the largest
 * remainders (earlier links first on a tie). Never below nothing; a link whose
 * share comes to nothing is 0 (the caller removes it). Pure.
 */
export function scaleLinks(links: ReadonlyArray<{ id: string; cents: number }>, from: number, to: number): Array<{ id: string; cents: number }> {
  const total = links.reduce((sum, l) => sum + l.cents, 0);
  const target = total >= from ? to : Math.min(to, Math.round((total * to) / from));
  const shares = links.map((l, index) => {
    const exact = (l.cents * to) / from;
    return { id: l.id, index, cents: Math.floor(exact), rest: exact - Math.floor(exact) };
  });
  let left = target - shares.reduce((sum, x) => sum + x.cents, 0);
  const byRest = [...shares].sort((a, b) => b.rest - a.rest || a.index - b.index);
  for (let i = 0; left > 0 && byRest.length > 0; i = (i + 1) % byRest.length, left--) byRest[i].cents += 1;
  // Links that together said more than the payment: the excess comes off the largest first.
  const bySize = [...shares].sort((a, b) => b.cents - a.cents || a.index - b.index);
  for (let i = 0; left < 0 && bySize.some((x) => x.cents > 0); i = (i + 1) % bySize.length) {
    if (bySize[i].cents > 0) {
      bySize[i].cents -= 1;
      left++;
    }
  }
  return shares.map(({ id, cents }) => ({ id, cents }));
}
