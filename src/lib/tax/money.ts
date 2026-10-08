/**
 * Money in the tax module is integer cents, always. Table cells hold floating
 * point euros; they are converted once, at the boundary (`facts.ts`), and never
 * again.
 */

/** A share in basis points: 10000 is the whole, 5000 is 50 percent. */
export const WHOLE_BP = 10_000;

/** Euros (a table cell) to cents, rounded half away from zero. */
export function eurosToCents(amount: number): number {
  return Math.sign(amount) * Math.round(Math.abs(amount) * 100 + 1e-7);
}

export function centsToEuros(cents: number): number {
  return cents / 100;
}

/**
 * The part of an amount that a share covers, rounded half away from zero to
 * the cent. Integer arithmetic throughout, so 123.45 at 50 percent is 61.73
 * and never 61.72 through a floating point slip.
 *
 * The rounding is per item: a line total is the sum of rounded items, which is
 * how a return prepared by hand adds up and what a tax office recomputes.
 */
export function shareOf(cents: number, shareBp: number): number {
  if (!Number.isInteger(cents)) throw new RangeError(`shareOf: cents must be an integer, got ${cents}`);
  if (!Number.isInteger(shareBp) || shareBp < 0 || shareBp > WHOLE_BP) {
    throw new RangeError(`shareOf: share must be 0 to ${WHOLE_BP} basis points, got ${shareBp}`);
  }
  const product = Math.abs(cents) * shareBp;
  const quotient = Math.floor(product / WHOLE_BP);
  const remainder = product % WHOLE_BP;
  const rounded = remainder * 2 >= WHOLE_BP ? quotient + 1 : quotient;
  // Avoid a negative zero for a zero amount.
  return rounded === 0 ? 0 : Math.sign(cents) * rounded;
}

/** A percentage as entered by a person (50, 33.33) to basis points. */
export function percentToBp(percent: number): number {
  return Math.round(percent * 100);
}

/** German display of cents: `1.234,56`. */
export function formatCents(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  const whole = Math.floor(abs / 100)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${sign}${whole},${(abs % 100).toString().padStart(2, '0')}`;
}
