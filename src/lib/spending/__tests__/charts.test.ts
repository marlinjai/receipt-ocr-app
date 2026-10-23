import { describe, expect, it } from 'vitest';
import { SPENDING_CATEGORIES, SPENDING_CATEGORY_LABELS } from '../categories';
import { CATEGORY_GROUP, axisStep, budgetBars, monthStacks, monthlyBudgetSum, topCounterparties } from '../charts';
import { buildOverview, type OverviewPaymentInput } from '../overview';
import type { BudgetLine } from '../budgets';

let n = 0;
const pay = (bookingDay: string, amountCents: number, counterpartyKey: string, extra: Partial<OverviewPaymentInput> = {}): OverviewPaymentInput => ({
  id: `p${++n}`,
  accountId: 'a1',
  bookingDay,
  amountCents,
  counterparty: counterpartyKey,
  counterpartyKey,
  reference: '',
  kind: 'spend',
  linkCount: 0,
  ...extra,
});
const none = { treatments: new Map(), answers: new Map() };

const line = (key: string, limitCents: number | null, extra: Partial<BudgetLine> = {}): BudgetLine => ({
  scope: 'category',
  key,
  label: key,
  limitCents,
  basis: limitCents === null ? 'none' : 'set',
  averageCents: null,
  averageMonths: 0,
  allBusiness: false,
  spentCents: 0,
  projectedCents: 0,
  level: 'ok',
  ...extra,
});

describe('chart colours', () => {
  it('give every category a fixed group, at most seven colours plus "Weitere" and "Unklar"', () => {
    for (const c of SPENDING_CATEGORIES) expect(CATEGORY_GROUP[c]).toBeTruthy();
    expect(new Set(Object.values(CATEGORY_GROUP)).size).toBe(9);
    expect(CATEGORY_GROUP.unclear).toBe('unclear');
  });
});

describe('monthStacks', () => {
  it('adds the categories of a month into their groups', () => {
    const o = buildOverview([pay('2026-03-02', -5000, 'rewe'), pay('2026-03-04', -2000, 'zyx'), pay('2026-03-05', -700, 'bargeld automat', { reference: 'Bargeld' })], none, 2026, null);
    const march = monthStacks(o)[2];
    expect(march.cents).toBe(7700);
    expect(march.groups[CATEGORY_GROUP.groceries_drugstore]).toBe(5000);
    expect(march.groups.unclear).toBe(2000);
    expect(march.groups.other).toBe(700);
  });
});

describe('monthlyBudgetSum', () => {
  it('adds the category limits and ignores counterparty budgets and budgets switched off', () => {
    expect(monthlyBudgetSum([line('groceries_drugstore', 30_000), line('transport', null), { ...line('zyx', 5000), scope: 'vendor' }])).toBe(30_000);
    expect(monthlyBudgetSum([line('transport', null)])).toBeNull();
  });
});

describe('budgetBars', () => {
  const payments = [
    pay('2026-10-02', -40_000, 'rewe'),
    pay('2026-10-03', -5000, 'hetzner', {}),
    pay('2026-09-03', -10_000, 'rewe'),
    pay('2025-05-03', -12_000, 'rewe'),
  ];
  const business = new Map([['hetzner', 'business' as const]]);

  it('compares a month against the monthly limit, with the projection only in the current month', () => {
    const october = buildOverview(payments, { treatments: business, answers: new Map() }, 2026, 10);
    const bars = budgetBars(october, [line('groceries_drugstore', 30_000, { projectedCents: 55_000, level: 'passed' }), line('transport', 8000)], '2026-10-23', SPENDING_CATEGORY_LABELS);
    expect(bars.find((b) => b.category === 'groceries_drugstore')).toMatchObject({ spentCents: 40_000, limitCents: 30_000, projectedCents: 55_000, level: 'passed' });
    // A budget without spending still shows; the business payment counts nowhere in the budgets.
    expect(bars.find((b) => b.category === 'transport')).toMatchObject({ spentCents: 0, limitCents: 8000, level: 'ok' });
    expect(bars.find((b) => b.category === 'software_ai_hosting')).toBeUndefined();

    const september = buildOverview(payments, { treatments: business, answers: new Map() }, 2026, 9);
    expect(budgetBars(september, [line('groceries_drugstore', 30_000, { projectedCents: 55_000, level: 'passed' })], '2026-10-23', SPENDING_CATEGORY_LABELS)[0]).toMatchObject({
      spentCents: 10_000,
      limitCents: 30_000,
      projectedCents: null,
      level: 'ok',
    });
  });

  it('compares a year against the limit once per month: twelve for a past year, the months begun for this one', () => {
    const lines = [line('groceries_drugstore', 10_000)];
    expect(budgetBars(buildOverview(payments, none, 2026, null), lines, '2026-10-23', SPENDING_CATEGORY_LABELS)[0]).toMatchObject({ limitCents: 100_000, spentCents: 50_000 });
    expect(budgetBars(buildOverview(payments, none, 2025, null), lines, '2026-10-23', SPENDING_CATEGORY_LABELS)[0]).toMatchObject({ limitCents: 120_000, spentCents: 12_000 });
  });
});

describe('topCounterparties', () => {
  it('lists the biggest by spending with their main category and share, refunds deducted, nameless ones apart', () => {
    const o = buildOverview(
      [
        pay('2026-04-01', -6000, 'rewe'),
        pay('2026-04-02', 1000, 'rewe', { kind: 'refund' }),
        pay('2026-04-03', -3000, 'zyx'),
        pay('2026-04-04', -1000, '', { counterparty: '', reference: 'Kartenzahlung' }),
        pay('2026-04-05', -500, '', { counterparty: '', reference: 'Kartenzahlung' }),
      ],
      none,
      2026,
      4,
    );
    const top = topCounterparties(o.payments, o.totalCents);
    expect(top.map((t) => [t.name, t.cents, t.count])).toEqual([
      ['rewe', 5000, 2],
      ['zyx', 3000, 1],
      ['Kartenzahlung', 1000, 1],
      ['Kartenzahlung', 500, 1],
    ]);
    expect(top[0]).toMatchObject({ category: 'groceries_drugstore', share: 52.6 });
    expect(topCounterparties(o.payments, o.totalCents, 2)).toHaveLength(2);
  });
});

describe('axisStep', () => {
  it('picks a round step', () => {
    expect(axisStep(100_000)).toBe(50_000);
    expect(axisStep(830_000)).toBe(500_000);
    expect(axisStep(0)).toBe(100);
  });
});
