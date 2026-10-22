import { describe, expect, it } from 'vitest';
import { SPENDING_CATEGORIES, SPENDING_CATEGORY_LABELS } from '../categories';
import { averages, budgetLevel, budgetSubject, computeBudgets, daysInMonth, parseEuroInput, previousTwelveMonths, projectMonth, type StoredLimit } from '../budgets';
import type { OverviewPayment } from '../overview';

let n = 0;
const pay = (bookingDay: string, cents: number, category: OverviewPayment['category'] = 'groceries_drugstore', extra: Partial<OverviewPayment> = {}): OverviewPayment => ({
  id: `p${++n}`,
  accountId: 'a',
  bookingDay,
  amountCents: -cents,
  counterparty: 'Rewe',
  counterpartyKey: 'rewe',
  reference: '',
  kind: 'spend',
  category,
  basis: 'keyword',
  purpose: 'unanswered',
  spendingCents: cents,
  businessCents: 0,
  hasReceipt: false,
  routed: false,
  ...extra,
});

const run = (payments: OverviewPayment[], today: string, limits: StoredLimit[] = []) =>
  computeBudgets({ payments, limits, categories: SPENDING_CATEGORIES.filter((c) => c !== 'transfers'), categoryLabels: SPENDING_CATEGORY_LABELS, today });

describe('calendar', () => {
  it('lists the twelve full months before this one, also across New Year', () => {
    expect(previousTwelveMonths(2026, 3)[0]).toBe('2025-03');
    expect(previousTwelveMonths(2026, 3)[11]).toBe('2026-02');
    expect(previousTwelveMonths(2026, 1)[11]).toBe('2025-12');
    expect(previousTwelveMonths(2026, 1)[0]).toBe('2025-01');
  });
  it('knows the length of February in a leap year and in another', () => {
    expect(daysInMonth(2028, 2)).toBe(29);
    expect(daysInMonth(2026, 2)).toBe(28);
    expect(daysInMonth(2026, 12)).toBe(31);
  });
});

describe('averages', () => {
  it('averages over the months with payments, leaving this month and business payments out', () => {
    const payments = [pay('2026-01-02', 30_000), pay('2026-02-10', 10_000), pay('2026-03-02', 99_000), pay('2026-02-11', 50_000, 'groceries_drugstore', { purpose: 'business', businessCents: 50_000 })];
    const a = averages(payments, 2026, 3, 5);
    expect(a.months).toBe(2);
    expect(a.byCategory.get('groceries_drugstore')).toEqual({ averageCents: 20_000, byThisDayCents: 15_000 });
    expect(a.byVendor.get('rewe')?.averageCents).toBe(20_000);
  });

  it('leaves out a partly covered first month and months without any payment', () => {
    // Data starts on 25 November; December has no import at all.
    const payments = [pay('2025-11-25', 5_000), pay('2026-01-05', 20_000), pay('2026-02-05', 20_000)];
    expect(averages(payments, 2026, 3, 10).months).toBe(2);
    expect(averages(payments, 2026, 3, 10).byCategory.get('groceries_drugstore')?.averageCents).toBe(20_000);
    // A first month that starts in its first days counts.
    expect(averages([pay('2025-11-02', 5_000), pay('2026-01-05', 20_000)], 2026, 3, 10).months).toBe(2);
  });

  it('has no average without any data, and none for a category whose refunds outweigh its spending', () => {
    expect(averages([], 2026, 3, 1)).toEqual({ months: 0, byCategory: new Map(), byVendor: new Map() });
    const back = averages([pay('2026-02-01', 1000), pay('2026-02-03', -3000, 'groceries_drugstore', { kind: 'refund' })], 2026, 3, 1);
    expect(back.byCategory.has('groceries_drugstore')).toBe(false);
  });
});

describe('projectMonth and budgetLevel', () => {
  it('does not take rent on the first for the pace of the month', () => {
    const history = { averageCents: 100_000, byThisDayCents: 100_000 };
    const projected = projectMonth(100_000, history, 7, 31);
    expect(projected).toBe(100_000);
    expect(budgetLevel(100_000, 100_000, projected, 7)).toBe('ok');
  });

  it('adds what earlier months still spent after this day', () => {
    expect(projectMonth(10_000, { averageCents: 20_000, byThisDayCents: 5_000 }, 10, 31)).toBe(25_000);
  });

  it('carries the spending so far forward evenly without history, and projects nothing after the last day', () => {
    expect(projectMonth(5000, null, 10, 30)).toBe(15_000);
    expect(projectMonth(9000, null, 30, 30)).toBe(9000);
  });

  it('is passed above the limit, and on pace only from day 7 and only beyond the margin', () => {
    expect(budgetLevel(10_100, 10_000, 10_100, 3)).toBe('passed');
    expect(budgetLevel(5000, 10_000, 15_000, 6)).toBe('ok');
    expect(budgetLevel(5000, 10_000, 15_000, 7)).toBe('on_pace');
    expect(budgetLevel(5000, 10_000, 11_000, 7)).toBe('ok');
    expect(budgetLevel(5000, 10_000, 11_001, 7)).toBe('on_pace');
  });
});

describe('computeBudgets', () => {
  const history = [pay('2026-01-02', 20_000), pay('2026-02-05', 20_000)];

  it('uses the average as the default limit and judges this month against it', () => {
    const [line] = run([...history, pay('2026-03-05', 25_000)], '2026-03-10');
    expect(line).toMatchObject({ scope: 'category', key: 'groceries_drugstore', limitCents: 20_000, basis: 'average', averageMonths: 2, spentCents: 25_000, level: 'passed' });
  });

  it('follows a limit the owner set, and a budget he switched off', () => {
    const set = run([...history, pay('2026-03-05', 25_000)], '2026-03-10', [{ scope: 'category', key: 'groceries_drugstore', label: 'x', limitCents: 50_000 }]);
    expect(set[0]).toMatchObject({ limitCents: 50_000, basis: 'set', averageCents: 20_000, level: 'ok' });
    const off = run([...history, pay('2026-03-05', 25_000)], '2026-03-10', [{ scope: 'category', key: 'groceries_drugstore', label: 'x', limitCents: null }]);
    expect(off[0]).toMatchObject({ limitCents: null, basis: 'off', level: 'ok' });
  });

  it('adds a counterparty budget and counts only its payments, never payments after today', () => {
    const lines = run([pay('2026-03-02', 4000, 'leisure_sport', { counterparty: 'Kino Beispiel', counterpartyKey: 'kino beispiel' }), pay('2026-03-20', 9000, 'leisure_sport', { counterpartyKey: 'kino beispiel' })], '2026-03-10', [
      { scope: 'vendor', key: 'kino beispiel', label: 'Kino Beispiel', limitCents: 3000 },
    ]);
    expect(lines.find((l) => l.scope === 'vendor')).toMatchObject({ spentCents: 4000, limitCents: 3000, basis: 'set', level: 'passed' });
  });

  it('counts only the private part of a mixed payment', () => {
    const [line] = run([...history, pay('2026-03-05', 10_000, 'groceries_drugstore', { businessCents: 4000 })], '2026-03-10');
    expect(line.spentCents).toBe(6000);
  });

  it('marks a counterparty budget whose payments this month all count as business', () => {
    const lines = run([pay('2026-03-02', 5000, 'shopping_household', { counterpartyKey: 'zyx', purpose: 'business', businessCents: 5000 })], '2026-03-10', [{ scope: 'vendor', key: 'zyx', label: 'Zyx', limitCents: 1000 }]);
    expect(lines.find((l) => l.scope === 'vendor')).toMatchObject({ spentCents: 0, allBusiness: true });
  });

  it('gives a counterparty no default limit from its history', () => {
    const lines = run([...history, pay('2026-03-02', 100)], '2026-03-10', [{ scope: 'vendor', key: 'zyx', label: 'Zyx', limitCents: null }]);
    expect(lines.find((l) => l.scope === 'vendor')).toMatchObject({ limitCents: null, basis: 'off' });
  });

  it('leaves out categories with neither spending nor an average nor a limit', () => {
    expect(run([], '2026-03-10')).toEqual([]);
  });

  it('lets a month whose refunds outweigh its spending stay within the budget', () => {
    const [line] = run([...history, pay('2026-03-02', 1000), pay('2026-03-04', -5000, 'groceries_drugstore', { kind: 'refund' })], '2026-03-10');
    expect(line).toMatchObject({ spentCents: -4000, level: 'ok' });
  });
});

describe('budgetSubject', () => {
  it('is one per budget, month, level and limit', () => {
    expect(budgetSubject({ scope: 'category', key: 'cash', basis: 'set', limitCents: 20_000 }, '2026-03', 'on_pace')).toBe('budget:category:cash:2026-03:on_pace:20000');
    // An average moves with every import: it is no part of the key.
    expect(budgetSubject({ scope: 'category', key: 'cash', basis: 'average', limitCents: 20_017 }, '2026-03', 'passed')).toBe('budget:category:cash:2026-03:passed:avg');
  });
});

describe('parseEuroInput', () => {
  it.each([
    ['120', 12_000],
    ['120,50', 12_050],
    ['120.5', 12_050],
    ['1.200', 120_000],
    ['1.200,50', 120_050],
    [' 80 € ', 8000],
  ])('reads %s', (text, cents) => {
    expect(parseEuroInput(text)).toBe(cents);
  });
  it.each(['', '0', '-5', 'abc', '1,2,3', '12,345'])('refuses %s', (text) => {
    expect(parseEuroInput(text)).toBeNull();
  });
});
