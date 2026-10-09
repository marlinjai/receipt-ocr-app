/**
 * Where revenue is heading against the small-business limits of section 19
 * of the value-added tax act, and when a limit would be reached.
 *
 * Pure, and deliberately modest: it projects from what was actually received
 * and what the owner states, shows a range instead of one number, and says
 * when it has too little to go on. It never changes a status; it prepares the
 * owner for a change he then records himself.
 *
 * The limits count money received (the law measures turnover by payments
 * received), which is the same basis the income-surplus statement uses.
 */

export interface LimitRules {
  /** Turnover of the previous calendar year must not have exceeded this. */
  previousYearLimitCents: number;
  /** Turnover of the running year must not exceed this; crossing it ends the status at once. */
  currentYearLimitCents: number;
}

export interface ForecastInput {
  year: number;
  /** ISO day the forecast is made on. Months after it are projected. */
  today: string;
  /** Money received for invoices per month of `year`, index 0 = January, in cents. */
  receivedByMonthCents: number[];
  /** Turnover of the previous year, or null when the app does not know it. */
  previousYearReceivedCents: number | null;
  /** Invoiced and not yet paid. Assumed to arrive within the year in both scenarios. */
  outstandingCents: number;
  /** What the owner expects to receive per month from now on, if he said so. Replaces the run rate. */
  expectedMonthlyCents: number | null;
}

export type LimitOutlook =
  /** Already above the limit with money actually received. */
  | { state: 'crossed'; month: number }
  /** Reached within the year even without new business (received plus outstanding). */
  | { state: 'expected'; monthFrom: number; monthTo: number }
  /** Reached only if business continues at the projected rate. */
  | { state: 'possible'; month: number }
  | { state: 'not_reached' };

export interface Forecast {
  year: number;
  /** Months of the year that are complete or running, 1 to 12. 0 before the year starts. */
  monthsElapsed: number;
  receivedCents: number;
  outstandingCents: number;
  /** Received plus outstanding: the year if nothing new is invoiced. */
  lowCents: number;
  /** Low plus the projected monthly rate for the remaining months. */
  highCents: number;
  /** The monthly rate used for the high figure, and where it comes from. */
  monthlyRateCents: number;
  rateBasis: 'stated' | 'run_rate' | 'none';
  /** Months with money received that the run rate was averaged over. */
  basisMonths: number;
  /** True when a run rate rests on fewer than three months: say so, do not lean on it. */
  thinBasis: boolean;
  /** The limit of the running year. Crossing it changes the status at once. */
  currentYear: LimitOutlook;
  /**
   * The limit that decides NEXT year: when this year ends above it, the
   * small-business status ends on 1 January of the following year.
   */
  nextYear: LimitOutlook;
  /**
   * Whether this year's status stands on the previous year: false when the
   * previous year was above its limit, null when the app does not know that year.
   */
  previousYearWithinLimit: boolean | null;
}

function monthOf(isoDay: string): number {
  return Number(isoDay.slice(5, 7));
}

/** The first month (1 to 12) in which a cumulative series reaches a limit, or null. */
function firstMonthAbove(cumulative: number[], limit: number): number | null {
  const index = cumulative.findIndex((c) => c > limit);
  return index === -1 ? null : index + 1;
}

export function forecastYear(input: ForecastInput, rules: LimitRules): Forecast {
  const todayYear = Number(input.today.slice(0, 4));
  const monthsElapsed = todayYear > input.year ? 12 : todayYear < input.year ? 0 : monthOf(input.today);
  const received = Array.from({ length: 12 }, (_, i) => Math.max(0, input.receivedByMonthCents[i] ?? 0));
  const receivedCents = received.reduce((s, c) => s + c, 0);

  // Run rate: the average over the elapsed months that are complete. The
  // running month is left out, it would drag the average down.
  const completeMonths = todayYear > input.year ? 12 : Math.max(0, monthsElapsed - 1);
  const completeSum = received.slice(0, completeMonths).reduce((s, c) => s + c, 0);
  const runRate = completeMonths > 0 ? Math.round(completeSum / completeMonths) : 0;

  let monthlyRateCents = 0;
  let rateBasis: Forecast['rateBasis'] = 'none';
  if (input.expectedMonthlyCents !== null && input.expectedMonthlyCents >= 0) {
    monthlyRateCents = input.expectedMonthlyCents;
    rateBasis = 'stated';
  } else if (completeMonths > 0) {
    monthlyRateCents = runRate;
    rateBasis = 'run_rate';
  }
  const remainingMonths = 12 - monthsElapsed;
  const outstanding = Math.max(0, input.outstandingCents);
  const lowCents = receivedCents + outstanding;
  const highCents = lowCents + monthlyRateCents * remainingMonths;

  // Cumulative series per month. Actual: what was received. Low: outstanding
  // invoices assumed to arrive in the next month. High: plus the monthly rate.
  const actual: number[] = [];
  const low: number[] = [];
  const high: number[] = [];
  let a = 0;
  for (let m = 1; m <= 12; m++) {
    a += received[m - 1];
    actual.push(a);
    const future = m > monthsElapsed;
    const arrived = future || monthsElapsed === 12 ? outstanding : 0;
    low.push(a + (m >= Math.min(12, monthsElapsed + 1) ? arrived : 0));
    high.push(low[m - 1] + (future ? monthlyRateCents * (m - monthsElapsed) : 0));
  }

  const outlook = (limit: number): LimitOutlook => {
    const crossed = firstMonthAbove(actual.slice(0, Math.max(monthsElapsed, 0)), limit);
    if (crossed !== null) return { state: 'crossed', month: crossed };
    const lowMonth = firstMonthAbove(low, limit);
    const highMonth = firstMonthAbove(high, limit);
    if (lowMonth !== null) return { state: 'expected', monthFrom: highMonth ?? lowMonth, monthTo: lowMonth };
    if (highMonth !== null) return { state: 'possible', month: highMonth };
    return { state: 'not_reached' };
  };

  return {
    year: input.year,
    monthsElapsed,
    receivedCents,
    outstandingCents: outstanding,
    lowCents,
    highCents,
    monthlyRateCents,
    rateBasis,
    basisMonths: rateBasis === 'run_rate' ? completeMonths : 0,
    thinBasis: rateBasis === 'run_rate' && completeMonths < 3,
    currentYear: outlook(rules.currentYearLimitCents),
    nextYear: outlook(rules.previousYearLimitCents),
    previousYearWithinLimit:
      input.previousYearReceivedCents === null ? null : input.previousYearReceivedCents <= rules.previousYearLimitCents,
  };
}
