/**
 * The one order of a receipt's tax rates.
 *
 * A receipt with two rates has a number column "Tax Rate" (one rate) and a
 * text column "Tax Rates" ("19 % + 7 %"). Both follow this order: the rate
 * that carries most of the bill (net plus tax, in cents) first; of two that
 * carry the same, the higher rate. Ordered by net, a 7 percent line of 100.00
 * came before a 19 percent line of 99.00 that carries more of the bill
 * (117.81 against 107.00), and the two columns named a different first rate.
 *
 * Pure: the amount reader, the reading of a receipt and the rates text all
 * use it.
 */

/** One tax line as far as the order needs it. Without a tax amount, the tax is worked out from the rate. */
export interface RateLine {
  rate: number;
  net?: number | null;
  tax?: number | null;
}

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

/** The part of the bill a line carries, in cents: net plus tax. */
function shareInCents(line: RateLine): number {
  const net = finite(line.net) ? line.net : 0;
  const tax = finite(line.tax) ? line.tax : (net * line.rate) / 100;
  return Math.round((net + tax) * 100);
}

/**
 * The rates of the lines, each once, in the one order. The lines of one rate
 * are added up first, so a refund at a rate is set against that rate's sale;
 * a rate that carries nothing or less in all, and a line without a usable
 * rate, do not take part.
 */
export function orderedRates(lines: ReadonlyArray<RateLine> | null | undefined): number[] {
  const byRate = new Map<number, number>();
  for (const line of lines ?? []) {
    if (!finite(line.rate)) continue;
    byRate.set(line.rate, (byRate.get(line.rate) ?? 0) + shareInCents(line));
  }
  return [...byRate.entries()]
    .filter(([, share]) => share > 0)
    .sort((a, b) => b[1] - a[1] || b[0] - a[0])
    .map(([rate]) => rate);
}

/** The lines themselves in the one order: by the share their rate carries, then the larger line first. */
export function orderLines<T extends RateLine>(lines: readonly T[]): T[] {
  const rank = new Map(orderedRates(lines).map((rate, i) => [rate, i]));
  const at = (line: T) => rank.get(line.rate) ?? Number.MAX_SAFE_INTEGER;
  return [...lines].sort((a, b) => at(a) - at(b) || shareInCents(b) - shareInCents(a));
}
