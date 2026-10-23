import type { BudgetLevel, BudgetLine } from './budgets';
import { SPENDING_CATEGORIES, type SpendingCategory } from './categories';
import type { OverviewPayment, SpendingOverview } from './overview';

/**
 * What the three charts of the spending overview show, worked out from the
 * overview and the budget lines (plan docs/plans/2026-10-23-budget-overview.md,
 * decision 3). Pure: the page draws, this adds up.
 */

/**
 * The colour of each category in the charts, by the category and never by its
 * rank, so a filter or another month never repaints one. Seven categories
 * take the seven slots of the validated palette (dataviz method, checked
 * against the app's dark surface); the four smallest share "Weitere"; "Unklar"
 * is neutral grey, because it is the absence of a category.
 */
export type ChartGroup = 'c1' | 'c2' | 'c3' | 'c4' | 'c5' | 'c6' | 'c7' | 'other' | 'unclear';

export const CATEGORY_GROUP: Record<SpendingCategory, ChartGroup> = {
  housing_utilities: 'c1',
  groceries_drugstore: 'c2',
  transport: 'c3',
  eating_out_coffee: 'c4',
  shopping_household: 'c5',
  leisure_sport: 'c6',
  software_ai_hosting: 'c7',
  loans_leasing_credit: 'other',
  fees_interest: 'other',
  transfers: 'other',
  cash: 'other',
  unclear: 'unclear',
};

/** The groups bottom to top in a stacked bar, and left to right in the legend. */
export const CHART_GROUPS: readonly ChartGroup[] = ['c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7', 'other', 'unclear'];

/** The name of a group: its category's, or "Weitere" for the shared one. */
export function groupLabel(group: ChartGroup, categoryLabels: Record<SpendingCategory, string>): string {
  if (group === 'other') return 'Weitere';
  const category = SPENDING_CATEGORIES.find((c) => CATEGORY_GROUP[c] === group) as SpendingCategory;
  return categoryLabels[category];
}

export interface MonthStack {
  month: number;
  cents: number;
  /** Spending per group, refunds deducted; a group below zero (more back than spent) draws nothing. */
  groups: Record<ChartGroup, number>;
}

export function monthStacks(overview: Pick<SpendingOverview, 'byMonth'>): MonthStack[] {
  return overview.byMonth.map((m) => {
    const groups = Object.fromEntries(CHART_GROUPS.map((g) => [g, 0])) as Record<ChartGroup, number>;
    for (const category of SPENDING_CATEGORIES) groups[CATEGORY_GROUP[category]] += m.byCategory[category];
    return { month: m.month, cents: m.cents, groups };
  });
}

/** The sum of the monthly category budgets: the line over the months. Null without any. */
export function monthlyBudgetSum(lines: readonly BudgetLine[]): number | null {
  const limits = lines.filter((l) => l.scope === 'category' && l.limitCents !== null).map((l) => l.limitCents as number);
  return limits.length === 0 ? null : limits.reduce((s, c) => s + c, 0);
}

export interface BudgetBar {
  category: SpendingCategory;
  label: string;
  /** The private part spent in the period, refunds deducted (what the budgets count). */
  spentCents: number;
  /** The limit for the period: the monthly limit times the months of the period; null without a budget. */
  limitCents: number | null;
  /** Where the month is heading; only when the period is the current month. */
  projectedCents: number | null;
  level: BudgetLevel;
}

/**
 * Budget against spent per category for the period shown. A budget is a
 * monthly limit, so a month compares against it once, a past year against
 * twelve times it, and the current year against it once per month begun.
 * Only the private part of a payment counts, as in the budgets. The current
 * month adds the projection of the budget lines.
 */
export function budgetBars(
  overview: Pick<SpendingOverview, 'year' | 'month' | 'payments'>,
  lines: readonly BudgetLine[],
  today: string,
  categoryLabels: Record<SpendingCategory, string>,
): BudgetBar[] {
  const currentYear = Number(today.slice(0, 4));
  const currentMonth = Number(today.slice(5, 7));
  const months = overview.month !== null ? 1 : overview.year < currentYear ? 12 : overview.year === currentYear ? currentMonth : 0;
  const isCurrentMonth = overview.month !== null && overview.year === currentYear && overview.month === currentMonth;
  const spent = new Map<SpendingCategory, number>();
  for (const p of overview.payments) {
    if (p.spendingCents === null) continue;
    spent.set(p.category, (spent.get(p.category) ?? 0) + (p.spendingCents - p.businessCents));
  }
  const byCategory = new Map(lines.filter((l) => l.scope === 'category').map((l) => [l.key as SpendingCategory, l]));
  const bars: BudgetBar[] = [];
  for (const category of SPENDING_CATEGORIES) {
    // Money moved between own accounts has no budget (see the budgets).
    if (category === 'transfers') continue;
    const line = byCategory.get(category);
    const spentCents = spent.get(category) ?? 0;
    const limitCents = line?.limitCents != null && months > 0 ? line.limitCents * months : null;
    if (spentCents <= 0 && limitCents === null) continue;
    const projectedCents = isCurrentMonth && line ? line.projectedCents : null;
    const level: BudgetLevel = limitCents === null ? 'ok' : spentCents > limitCents ? 'passed' : isCurrentMonth && line ? line.level : 'ok';
    bars.push({ category, label: categoryLabels[category], spentCents, limitCents, projectedCents, level });
  }
  return bars.sort((a, b) => b.spentCents - a.spentCents);
}

export interface TopCounterparty {
  /** The counterparty key; for a payment without a name, `payment:<id>`. */
  key: string;
  name: string;
  cents: number;
  count: number;
  /** The category most of its money went to. */
  category: SpendingCategory;
  /** Of all spending in the period, in percent (one decimal). */
  share: number;
}

/** The biggest counterparties of the period by spending, refunds deducted, at most `limit`. */
export function topCounterparties(payments: readonly OverviewPayment[], totalCents: number, limit = 10): TopCounterparty[] {
  const byKey = new Map<string, { name: string; cents: number; count: number; byCategory: Map<SpendingCategory, number> }>();
  for (const p of payments) {
    if (p.spendingCents === null) continue;
    const key = p.counterpartyKey || `payment:${p.id}`;
    const entry = byKey.get(key) ?? { name: p.counterparty || p.reference || 'ohne Namen', cents: 0, count: 0, byCategory: new Map() };
    entry.cents += p.spendingCents;
    entry.count += 1;
    entry.byCategory.set(p.category, (entry.byCategory.get(p.category) ?? 0) + p.spendingCents);
    byKey.set(key, entry);
  }
  return [...byKey.entries()]
    .filter(([, e]) => e.cents > 0)
    .sort((a, b) => b[1].cents - a[1].cents || (a[0] < b[0] ? -1 : 1))
    .slice(0, limit)
    .map(([key, e]) => ({
      key,
      name: e.name,
      cents: e.cents,
      count: e.count,
      category: [...e.byCategory.entries()].sort((a, b) => b[1] - a[1])[0][0],
      share: totalCents > 0 ? Math.round((e.cents / totalCents) * 1000) / 10 : 0,
    }));
}

/** A round step for the value axis: 1, 2 or 5 times a power of ten, so about four lines fit under `max`. */
export function axisStep(maxCents: number): number {
  if (maxCents <= 0) return 100;
  const raw = maxCents / 4;
  const power = 10 ** Math.floor(Math.log10(raw));
  const factor = raw / power;
  return (factor <= 1 ? 1 : factor <= 2 ? 2 : factor <= 5 ? 5 : 10) * power;
}
