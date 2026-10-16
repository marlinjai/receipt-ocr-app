/**
 * Wage data of a year: the annual wage statement an employer issues
 * (Lohnsteuerbescheinigung), or the monthly pay slips while the year is
 * running. Pure; the service maps stored rows into `WageEntry`.
 */

/** The figures a wage statement and a pay slip have in common, in cents. */
export interface WageFigures {
  grossCents: number;
  wageTaxCents: number;
  solidarityCents: number;
  churchTaxCents: number;
  pensionEmployeeCents: number;
  /** The employer's share of the pension contribution: it is part of the pension deduction and then taken off again. */
  pensionEmployerCents: number;
  healthEmployeeCents: number;
  careEmployeeCents: number;
  unemploymentEmployeeCents: number;
}

export const WAGE_FIELDS: ReadonlyArray<keyof WageFigures> = [
  'grossCents',
  'wageTaxCents',
  'solidarityCents',
  'churchTaxCents',
  'pensionEmployeeCents',
  'pensionEmployerCents',
  'healthEmployeeCents',
  'careEmployeeCents',
  'unemploymentEmployeeCents',
];

export interface WageEntry extends WageFigures {
  id: string;
  /** A label the owner chooses for the employer. */
  employer: string;
  /** 0: the annual wage statement; 1 to 12: the pay slip of that month. */
  month: number;
  /** The health insurance carries a claim to sick pay (an employee's usually does): the contribution then counts 4 percent less. */
  healthWithSickPay: boolean;
  /** For a pay slip: whether church tax was due in that month (null: not stated). */
  churchLiable: boolean | null;
}

export interface EmployerWages {
  employer: string;
  /** Where the figures come from. */
  basis: 'annual_statement' | 'pay_slips';
  /** The months with a pay slip (empty for an annual statement). */
  months: number[];
  /** Months between the first and the last pay slip that have none: a gap, most likely a slip not entered yet. */
  gaps: number[];
  /** Months added by projecting the last pay slip to December (empty unless projected). */
  projectedMonths: number[];
  figures: WageFigures;
  /** The part of the health contribution with a claim to sick pay. */
  healthWithSickPayCents: number;
  /** When the annual statement exists, the pay slips of the same employer are shown but not counted. */
  ignoredPaySlips: number;
}

export interface YearWages {
  employers: EmployerWages[];
  total: WageFigures;
  healthWithSickPayCents: number;
  /** True when any figure rests on a projection. */
  projected: boolean;
}

export function zeroFigures(): WageFigures {
  return Object.fromEntries(WAGE_FIELDS.map((f) => [f, 0])) as unknown as WageFigures;
}

function add(a: WageFigures, b: WageFigures, times = 1): WageFigures {
  const out = { ...a };
  for (const f of WAGE_FIELDS) out[f] += b[f] * times;
  return out;
}

/**
 * The wages of a year, per employer and in total.
 *
 * An employer's annual statement wins over its pay slips: it is the figure the
 * tax office receives and the one to use (the pay slip of December can differ
 * from it). Without one, the pay slips are added up. With `project`, the last
 * pay slip of an employer stands in for every month after it up to December:
 * the running year then shows a full year of wages, wage tax and
 * contributions, each projected month listed. Months before the first slip
 * are never filled in (a job may have started in the year).
 */
export function aggregateWages(entries: readonly WageEntry[], project: boolean): YearWages | null {
  if (entries.length === 0) return null;
  const byEmployer = new Map<string, WageEntry[]>();
  for (const e of entries) byEmployer.set(e.employer, [...(byEmployer.get(e.employer) ?? []), e]);
  const employers: EmployerWages[] = [];
  for (const [employer, list] of [...byEmployer.entries()].sort((a, b) => a[0].localeCompare(b[0], 'de'))) {
    const annual = list.find((e) => e.month === 0);
    const slips = list.filter((e) => e.month > 0).sort((a, b) => a.month - b.month);
    if (annual) {
      employers.push({
        employer,
        basis: 'annual_statement',
        months: [],
        gaps: [],
        projectedMonths: [],
        figures: add(zeroFigures(), annual),
        healthWithSickPayCents: annual.healthWithSickPay ? annual.healthEmployeeCents : 0,
        ignoredPaySlips: slips.length,
      });
      continue;
    }
    let figures = zeroFigures();
    let sickPay = 0;
    for (const s of slips) {
      figures = add(figures, s);
      if (s.healthWithSickPay) sickPay += s.healthEmployeeCents;
    }
    const months = slips.map((s) => s.month);
    const first = months[0];
    const last = months[months.length - 1];
    const gaps: number[] = [];
    for (let m = first; m <= last; m++) if (!months.includes(m)) gaps.push(m);
    const projectedMonths: number[] = [];
    if (project && last < 12) {
      const lastSlip = slips[slips.length - 1];
      for (let m = last + 1; m <= 12; m++) projectedMonths.push(m);
      figures = add(figures, lastSlip, projectedMonths.length);
      if (lastSlip.healthWithSickPay) sickPay += lastSlip.healthEmployeeCents * projectedMonths.length;
    }
    employers.push({ employer, basis: 'pay_slips', months, gaps, projectedMonths, figures, healthWithSickPayCents: sickPay, ignoredPaySlips: 0 });
  }
  let total = zeroFigures();
  let sickPay = 0;
  for (const e of employers) {
    total = add(total, e.figures);
    sickPay += e.healthWithSickPayCents;
  }
  return { employers, total, healthWithSickPayCents: sickPay, projected: employers.some((e) => e.projectedMonths.length > 0) };
}

/**
 * The months of a year in which church tax was due, as far as the pay slips
 * say: a slip with church tax withheld, or one marked liable. Used only when
 * the owner has not stated the months for the year; the estimate then names
 * this as an assumption.
 */
export function churchMonthsFromPaySlips(entries: readonly WageEntry[], project: boolean): boolean[] | null {
  const slips = entries.filter((e) => e.month > 0).sort((a, b) => a.month - b.month);
  if (slips.length === 0) return null;
  const liable = (s: WageEntry) => s.churchLiable === true || (s.churchLiable === null && s.churchTaxCents > 0);
  const months = Array.from({ length: 12 }, () => false);
  for (const s of slips) if (liable(s)) months[s.month - 1] = true;
  // A projected month follows the last pay slip, as its wages do.
  const last = slips[slips.length - 1];
  if (project && liable(last)) for (let m = last.month + 1; m <= 12; m++) months[m - 1] = true;
  return months;
}
