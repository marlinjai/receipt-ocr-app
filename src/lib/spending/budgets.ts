import type { SpendingCategory } from './categories';
import type { OverviewPayment } from './overview';

/**
 * Budgets: a monthly limit per category (and per counterparty where wanted),
 * the spending so far this month, and a warning when a limit is passed or is
 * certain to be passed at this pace (plan
 * docs/plans/2026-10-14-personal-spending-and-bank-feed.md, "What the budgets
 * are", build order 4). Pure.
 *
 * Decided by the coordinator: a category's default limit is the owner's own
 * average over the last twelve full months, computed from the payments in the
 * app; a limit he sets himself replaces it. A counterparty has no default: its
 * limit exists only when he sets one.
 *
 * Budgets are about the owner's own money: only the private part of a
 * payment counts (a business counterparty's payments not at all, a mixed
 * one's linked business part not), for the budgets and for the averages.
 */

/** The highest monthly limit accepted, in cents (a million euros): anything above is a typing slip. */
export const MAX_LIMIT_CENTS = 100_000_000;

/** The private part of a payment's spending: all of it, less what is business (a business counterparty, the linked part of a mixed one). */
const privateCents = (p: OverviewPayment) => (p.spendingCents === null ? 0 : p.spendingCents - p.businessCents);
const counts = (p: OverviewPayment) => p.spendingCents !== null && privateCents(p) !== 0;

export type BudgetScope = 'category' | 'vendor';

export interface StoredLimit {
  scope: BudgetScope;
  /** A category key, or a counterparty key. */
  key: string;
  label: string;
  /** Null: the owner switched this budget off (no default either). */
  limitCents: number | null;
}

export type LimitBasis = 'set' | 'average' | 'off' | 'none';

export type BudgetLevel =
  /** Within the limit and on a pace that stays within it. */
  | 'ok'
  /** Not passed yet, but at this pace the month ends above the limit. */
  | 'on_pace'
  /** Passed. */
  | 'passed';

export interface BudgetLine {
  scope: BudgetScope;
  key: string;
  label: string;
  limitCents: number | null;
  basis: LimitBasis;
  /** The monthly average of earlier months: the default limit of a category, and the base of the projection. */
  averageCents: number | null;
  /** How many months the average is over (up to twelve). */
  averageMonths: number;
  /** A counterparty budget whose payments this month all count as business: shown, so 0 euros is not a puzzle. */
  allBusiness: boolean;
  spentCents: number;
  /** Spending at this pace by the end of the month. */
  projectedCents: number;
  level: BudgetLevel;
}

/** The pace is judged only from this day of the month on: in the first days one purchase says nothing about a month. */
export const PACE_FROM_DAY = 7;
/** The pace has to end this far above the limit to warn, in percent: "certain", not "maybe". */
export const PACE_MARGIN_PERCENT = 10;

export const daysInMonth = (year: number, month: number) => new Date(Date.UTC(year, month, 0)).getUTCDate();

/** The twelve full months before `month` of `year`, as "YYYY-MM" prefixes, oldest first. */
export function previousTwelveMonths(year: number, month: number): string[] {
  const out: string[] = [];
  for (let i = 12; i >= 1; i--) {
    const d = new Date(Date.UTC(year, month - 1 - i, 1));
    out.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`);
  }
  return out;
}

/** What earlier months say about one budget: the monthly average, and how much of it was spent by this day of the month. */
export interface History {
  /** Average spending of a whole month, in cents. */
  averageCents: number;
  /** Average spending up to and including this day of the month, in cents. */
  byThisDayCents: number;
}

export interface Averages {
  /** The months the averages are over: those of the last twelve with payments, a partly covered first month left out. */
  months: number;
  byCategory: Map<SpendingCategory, History>;
  byVendor: Map<string, History>;
}

/** A first month counts only when its first payment falls on one of these first days: otherwise it is only partly covered. */
export const FULL_FIRST_MONTH_BY_DAY = 3;

/**
 * Averages over the twelve full months before this one, per category and per
 * counterparty, in whole cents. Only months that hold payments count (a month
 * without any import is no month of zero spending), and the first month of
 * data only when it starts in its first days (an import that begins on the
 * 25th would otherwise halve that month). `day` is today's day of the month,
 * for what is usually spent by now.
 */
export function averages(payments: readonly OverviewPayment[], year: number, month: number, day: number): Averages {
  const window = previousTwelveMonths(year, month);
  const firstDay = payments.reduce<string | null>((min, p) => (min === null || p.bookingDay < min ? p.bookingDay : min), null);
  const withData = new Set(payments.map((p) => p.bookingDay.slice(0, 7)));
  const months = window.filter((m) => {
    if (!withData.has(m) || firstDay === null) return false;
    return !(m === firstDay.slice(0, 7) && Number(firstDay.slice(8, 10)) > FULL_FIRST_MONTH_BY_DAY);
  });
  const counted = new Set(months);
  const whole = { category: new Map<string, number>(), vendor: new Map<string, number>() };
  const early = { category: new Map<string, number>(), vendor: new Map<string, number>() };
  const add = (map: Map<string, number>, key: string, cents: number) => map.set(key, (map.get(key) ?? 0) + cents);
  for (const p of payments) {
    if (!counts(p) || !counted.has(p.bookingDay.slice(0, 7))) continue;
    const cents = privateCents(p);
    const byNow = Number(p.bookingDay.slice(8, 10)) <= day;
    add(whole.category, p.category, cents);
    if (byNow) add(early.category, p.category, cents);
    if (p.counterpartyKey) {
      add(whole.vendor, p.counterpartyKey, cents);
      if (byNow) add(early.vendor, p.counterpartyKey, cents);
    }
  }
  const histories = (all: Map<string, number>, soFar: Map<string, number>) => {
    const out = new Map<string, History>();
    if (months.length === 0) return out;
    for (const [key, cents] of all) {
      if (cents <= 0) continue;
      out.set(key, { averageCents: Math.round(cents / months.length), byThisDayCents: Math.round(Math.max(0, soFar.get(key) ?? 0) / months.length) });
    }
    return out;
  };
  return {
    months: months.length,
    byCategory: histories(whole.category, early.category) as Map<SpendingCategory, History>,
    byVendor: histories(whole.vendor, early.vendor),
  };
}

/**
 * Where the month is heading. With a history, the projection is what is spent
 * so far plus what earlier months still spent after this day: rent booked on
 * the first does not make the rest of the month look expensive. Without one,
 * the spending so far is carried forward evenly.
 */
export function projectMonth(spentCents: number, history: History | null, day: number, monthDays: number): number {
  if (day >= monthDays) return spentCents;
  if (history) return spentCents + Math.max(0, history.averageCents - history.byThisDayCents);
  return Math.round((spentCents / day) * monthDays);
}

/**
 * Passed when spending is above the limit; on pace when, from the seventh day
 * on, the projection lies more than ten percent above it (certain, not maybe).
 */
export function budgetLevel(spentCents: number, limitCents: number, projectedCents: number, day: number): BudgetLevel {
  if (spentCents > limitCents) return 'passed';
  if (day >= PACE_FROM_DAY && projectedCents * 100 > limitCents * (100 + PACE_MARGIN_PERCENT)) return 'on_pace';
  return 'ok';
}

export interface BudgetInput {
  /** All payments as the overview classifies them (any year: the average needs the last twelve months). */
  payments: readonly OverviewPayment[];
  limits: readonly StoredLimit[];
  categories: readonly SpendingCategory[];
  categoryLabels: Record<SpendingCategory, string>;
  /** Today as an ISO (international standard) day in the owner's time zone. */
  today: string;
}

/** Every budget of the current month: one line per category with spending or a limit, and one per counterparty limit. */
export function computeBudgets(input: BudgetInput): BudgetLine[] {
  const year = Number(input.today.slice(0, 4));
  const month = Number(input.today.slice(5, 7));
  const day = Number(input.today.slice(8, 10));
  const monthDays = daysInMonth(year, month);
  const prefix = input.today.slice(0, 8);
  const thisMonth = input.payments.filter((p) => counts(p) && p.bookingDay.startsWith(prefix) && p.bookingDay <= input.today);
  const spentByCategory = new Map<string, number>();
  const spentByVendor = new Map<string, number>();
  const vendorPaidThisMonth = new Set(input.payments.filter((p) => p.spendingCents !== null && p.bookingDay.startsWith(prefix) && p.bookingDay <= input.today).map((p) => p.counterpartyKey));
  for (const p of thisMonth) {
    spentByCategory.set(p.category, (spentByCategory.get(p.category) ?? 0) + privateCents(p));
    if (p.counterpartyKey) spentByVendor.set(p.counterpartyKey, (spentByVendor.get(p.counterpartyKey) ?? 0) + privateCents(p));
  }
  const history = averages(input.payments, year, month, day);
  const stored = new Map(input.limits.map((l) => [`${l.scope}:${l.key}`, l]));

  const line = (scope: BudgetScope, key: string, label: string, spent: number, past: History | null): BudgetLine => {
    const own = stored.get(`${scope}:${key}`);
    // Only a category takes its average as a default limit; a counterparty budget exists only when set.
    const average = scope === 'category' ? (past?.averageCents ?? null) : null;
    const limitCents = own ? own.limitCents : average;
    const basis: LimitBasis = own ? (own.limitCents === null ? 'off' : 'set') : average !== null ? 'average' : 'none';
    const projectedCents = projectMonth(spent, past, day, monthDays);
    const allBusiness = scope === 'vendor' && spent === 0 && vendorPaidThisMonth.has(key);
    const base = { scope, key, label, averageCents: past?.averageCents ?? null, averageMonths: history.months, allBusiness, spentCents: spent, projectedCents };
    if (limitCents === null || limitCents <= 0) return { ...base, limitCents: null, basis: basis === 'average' ? 'none' : basis, level: 'ok' };
    return { ...base, limitCents, basis, level: budgetLevel(spent, limitCents, projectedCents, day) };
  };

  const lines: BudgetLine[] = [];
  for (const category of input.categories) {
    const spent = spentByCategory.get(category) ?? 0;
    const past = history.byCategory.get(category) ?? null;
    if (spent === 0 && past === null && !stored.has(`category:${category}`)) continue;
    lines.push(line('category', category, input.categoryLabels[category], spent, past));
  }
  for (const limit of input.limits.filter((l) => l.scope === 'vendor')) {
    lines.push(line('vendor', limit.key, limit.label, spentByVendor.get(limit.key) ?? 0, history.byVendor.get(limit.key) ?? null));
  }
  return lines;
}

/**
 * The key that makes a budget warning happen once per budget, month, level and
 * limit: "on pace" once, "passed" once more if it comes to that, and again
 * when the owner set a new limit and that one is reached too.
 */
export const budgetSubject = (line: Pick<BudgetLine, 'scope' | 'key' | 'basis' | 'limitCents'>, month: string, level: Exclude<BudgetLevel, 'ok'>) =>
  // Only a limit the owner set is part of the key: an average moves by cents with every import and must not warn anew.
  `budget:${line.scope}:${line.key}:${month}:${level}:${line.basis === 'set' ? String(line.limitCents) : 'avg'}`;

/** An amount typed in euros ("120", "120,50", "1.200,50", "120.5") as cents, or null when it is no positive amount. */
export function parseEuroInput(text: string): number | null {
  const t = text.trim().replace(/\s|€/g, '');
  if (!/^\d{1,3}(\.\d{3})*(,\d{1,2})?$|^\d+([.,]\d{1,2})?$/.test(t)) return null;
  // A comma is the decimal mark; without one, dots before groups of three digits separate thousands ("1.200").
  const normalized = t.includes(',') ? t.replace(/\./g, '').replace(',', '.') : /^\d{1,3}(\.\d{3})+$/.test(t) ? t.replace(/\./g, '') : t;
  const cents = Math.round(Number(normalized) * 100);
  return Number.isFinite(cents) && cents > 0 ? cents : null;
}
