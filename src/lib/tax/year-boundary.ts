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
 * the window, is decided per payment, in this order (`decideBoundary`):
 *
 * 1. A filed year fixes its turn. A payment whose paid year or other year has
 *    a filed return was declared in the year it was paid, so it stays there.
 *    A person's answer saved up to the filing day was filed that way and
 *    applies; one saved after it, that would move the payment across the filed
 *    year, is reported and never applied, so a filed year never changes.
 * 2. A person's answer for the payment day.
 * 3. A rule worked out from the payment data, on every read, never stored:
 *    an advance payment or refund of value-added tax paid 1 to 10 January
 *    belongs to the year before (the advance return for December or the
 *    fourth quarter is due on 10 January, section 18 (1) of the value-added
 *    tax act, Umsatzsteuergesetz), one paid 22 to 31 December pays an earlier
 *    period and stays; a receipt of a counterparty that recurs is billed at
 *    the start of the period it pays for and stays; a receipt that does not
 *    recur is no regularly recurring payment and stays. A service period on
 *    the receipt (rent for January paid on 28 December) would be the one case
 *    that moves, but receipts do not carry one yet, so no rule moves a receipt.
 * 4. Anything else (a receipt without a vendor, whose recurrence cannot be
 *    told) is asked.
 */

export const YEAR_BOUNDARY_DAYS = 10;

/** The ISO day of a moment in the business's time zone (Europe/Berlin); by default today. */
export function berlinDay(at: Date = new Date()): string {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Berlin' }).format(at);
}

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

/** Where the answer that applies to a payment comes from. */
export type BoundarySource = 'person' | 'filed' | 'rule';

/** A person's stored answer, with the day (Europe/Berlin) it was last saved. */
export interface StoredBoundaryAnswer {
  cashDay: string;
  belongsToOtherYear: boolean;
  savedOn: string;
}

export interface BoundaryFacts {
  kind: BoundarySubjectKind;
  /** The payment day; must lie in the window. */
  cashDay: string;
  stored: StoredBoundaryAnswer | undefined;
  /** The filing day of every year whose return is filed. */
  filedOn: ReadonlyMap<number, string>;
  /** Receipts: whether the counterparty recurs (`recursMonthly`); null when it cannot be told. Ignored for settlements. */
  recurring: boolean | null;
}

export interface BoundaryDecision {
  /** True: counts in the other year. False: stays. Null: open, nobody and no rule answered. */
  answer: boolean | null;
  source: BoundarySource | null;
  /** Why, in German, as the year-change list shows it. */
  reason: string;
  /** The person's answer for this payment day, applied or not (it can be taken back). */
  storedAnswer: boolean | null;
  /** The filed year that fixes this payment (the paid year first); null while both years are open. */
  filedYear: number | null;
  /** Set when the person's answer would move the payment across this filed year and is therefore not applied. */
  departsFromFiled: number | null;
}

/** At least this many months with a payment or receipt of a counterparty in the twelve before make it recurring. */
export const RECURRING_MIN_MONTHS = 3;

const monthIndex = (isoDay: string) => Number(isoDay.slice(0, 4)) * 12 + Number(isoDay.slice(5, 7)) - 1;

/**
 * Whether a counterparty recurs at `cashDay`: at least three distinct months
 * with a payment or receipt of it among the twelve calendar months before the
 * month of `cashDay`. The payment's own month does not count, so the payment
 * cannot vouch for itself, and neither can a second receipt of the same month.
 */
export function recursMonthly(cashDay: string, days: readonly string[]): boolean {
  const own = monthIndex(cashDay);
  const months = new Set<number>();
  for (const day of days) {
    if (!ISO_DAY.test(day)) continue;
    const m = monthIndex(day);
    if (m >= own - 12 && m < own) months.add(m);
  }
  return months.size >= RECURRING_MIN_MONTHS;
}

export const BOUNDARY_REASONS = {
  person: 'Antwort von Hand',
  vatJanuary: 'Umsatzsteuer für Dezember oder das vierte Quartal: die Voranmeldung ist am 10. Januar fällig',
  vatDecember: 'Umsatzsteuer für einen früheren Zeitraum desselben Jahres',
  recurring: 'Abo, Zeitraum beginnt am Zahltag',
  once: 'einmalige Zahlung',
  noVendor: 'Ohne Lieferant lässt sich nicht erkennen, ob die Zahlung regelmäßig wiederkehrt',
} as const;
export const filedReason = (year: number) => `Festgelegt durch die abgegebene Erklärung ${year}`;
export const filedBeforeReason = (year: number) => `Antwort von Hand, vor der Abgabe der Erklärung ${year} gegeben und so erklärt`;
export const departsReason = (year: number) => `Weicht von der abgegebenen Erklärung ${year} ab`;

/**
 * The answer that applies to one payment in the window, and why. Pure: the
 * caller gives the stored answer, the filed years and the recurrence. "Saved
 * after the filing day" means a later day; an answer saved on the filing day
 * itself counts as filed with it, since the return cannot be told apart from
 * the answer on that day and changing a filed year is the worse mistake.
 */
export function decideBoundary(facts: BoundaryFacts): BoundaryDecision {
  const { kind, cashDay, stored, filedOn } = facts;
  const paidYear = Number(cashDay.slice(0, 4));
  const otherYear = otherYearOf(cashDay);
  const storedAnswer = answerFor(stored, cashDay);
  const filed = [paidYear, ...(otherYear === null ? [] : [otherYear])].filter((y) => filedOn.has(y));
  const decision = (answer: boolean | null, source: BoundarySource | null, reason: string, departsFromFiled: number | null = null): BoundaryDecision => ({
    answer,
    source,
    reason,
    storedAnswer,
    filedYear: filed[0] ?? null,
    departsFromFiled,
  });

  if (filed.length > 0) {
    if (storedAnswer === null) return decision(false, 'filed', filedReason(filed[0]));
    const savedAfter = filed.find((y) => (stored as StoredBoundaryAnswer).savedOn > (filedOn.get(y) as string));
    if (savedAfter === undefined) return decision(storedAnswer, 'person', filedBeforeReason(filed[0]));
    // Staying is what the filed return says anyway.
    if (!storedAnswer) return decision(false, 'person', BOUNDARY_REASONS.person);
    return decision(false, 'filed', departsReason(savedAfter), savedAfter);
  }
  if (storedAnswer !== null) return decision(storedAnswer, 'person', BOUNDARY_REASONS.person);
  if (kind === 'vat_settlement') {
    return cashDay.slice(5, 7) === '01' ? decision(true, 'rule', BOUNDARY_REASONS.vatJanuary) : decision(false, 'rule', BOUNDARY_REASONS.vatDecember);
  }
  if (facts.recurring === null) return decision(null, null, BOUNDARY_REASONS.noVendor);
  return decision(false, 'rule', facts.recurring ? BOUNDARY_REASONS.recurring : BOUNDARY_REASONS.once);
}
