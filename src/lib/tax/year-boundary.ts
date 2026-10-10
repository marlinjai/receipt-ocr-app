/**
 * The ten-day rule at the turn of the year.
 *
 * Cash basis has one exception (section 11 (1) sentence 2 and (2) sentence 2
 * of the income tax act, Einkommensteuergesetz): regularly recurring income
 * and expenses that fall due and are paid within a short time before or after
 * the end of the year they belong to count in THAT year. "A short time" is ten
 * days by settled case law (income tax guidelines, H 11 "Kurze Zeit"), so the
 * window is 22 December to 10 January. Rent, insurance premiums and advance
 * payments of value-added tax are the usual cases.
 *
 * Whether a payment is regularly recurring, and whether it was also DUE inside
 * the window, cannot be read off a receipt. So nothing is moved by itself: the
 * payments inside the window are listed, and a person answers for each.
 */

export const YEAR_BOUNDARY_DAYS = 10;

export type BoundarySubjectKind = 'receipt' | 'vat_settlement';
export const BOUNDARY_SUBJECT_KINDS: readonly BoundarySubjectKind[] = ['receipt', 'vat_settlement'];

const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * The other year a payment of this day can belong to: the next year for the
 * last ten days of December, the year before for the first ten of January.
 * Null outside the window, and for anything that is not a day.
 */
export function otherYearOf(isoDay: string | null | undefined): number | null {
  const m = ISO_DAY.exec(isoDay ?? '');
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month === 12 && day > 31 - YEAR_BOUNDARY_DAYS && day <= 31) return year + 1;
  if (month === 1 && day >= 1 && day <= YEAR_BOUNDARY_DAYS) return year - 1;
  return null;
}

/**
 * The day a payment counts on when it belongs to the other year: the first day
 * of the next year, or the last day of the year before. Null outside the window.
 */
export function boundaryDay(cashDay: string | null | undefined): string | null {
  const other = otherYearOf(cashDay);
  if (other === null) return null;
  return Number((cashDay as string).slice(0, 4)) < other ? `${other}-01-01` : `${other}-12-31`;
}

/** A stored answer applies only to the payment day it was given for. */
export function answerFor(stored: { cashDay: string; belongsToOtherYear: boolean } | undefined, cashDay: string | null): boolean | null {
  if (!stored || cashDay === null || stored.cashDay !== cashDay) return null;
  return stored.belongsToOtherYear;
}

/** Whether a payment of this day is of interest when looking at `year`: paid in it, or possibly belonging to it. */
export function touchesYear(cashDay: string, year: number): boolean {
  const other = otherYearOf(cashDay);
  return other !== null && (other === year || Number(cashDay.slice(0, 4)) === year);
}
