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
