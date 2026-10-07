import { describe, expect, it } from 'vitest';
import { computeYear } from '../compute';
import { rulesForYear } from '../rules';
import type { LedgerItem, OpenCheckKind } from '../types';
import { SYNTHETIC_YEAR, business, item } from './fixtures';

const rules2025 = rulesForYear(2025);
const run = (items: LedgerItem[], year = 2025) => computeYear({ year, items }, rulesForYear(year));
const line = (result: ReturnType<typeof run>, key: string) => result.lines.find((l) => l.key === key);
const kinds = (result: ReturnType<typeof run>, id: string): OpenCheckKind[] =>
  result.checks.filter((c) => c.itemId === id).map((c) => c.kind);

describe('computeYear: the synthetic year', () => {
  const result = run(SYNTHETIC_YEAR);

  it('produces the statement line by line', () => {
    expect(result.lines.map((l) => [l.line, l.key, l.cents])).toEqual([
      [29, 'euer.external_services', 21420],
      [33, 'euer.depreciation_movable', 239900],
      [36, 'euer.low_value_assets', 28950 + 31299],
      [43, 'euer.telecom', 20994],
      [51, 'euer.work_equipment', 6173 + 8437],
      [63, 'euer.meals', 4060],
      [null, 'employment.study_costs', 12596 + 3704 + 31200],
    ]);
  });

  it('adds the lines up to the totals', () => {
    const euer = result.lines.filter((l) => l.form === 'euer').reduce((s, l) => s + l.cents, 0);
    expect(result.businessExpenseCents).toBe(euer);
    expect(result.businessExpenseCents).toBe(361233);
    expect(result.employmentCostCents).toBe(47500);
  });

  it('keeps the not deductible part of a meal beside the deductible one', () => {
    expect(line(result, 'euer.meals')).toMatchObject({ cents: 4060, nonDeductibleCents: 1740, itemIds: ['meal-complete'] });
  });

  it('leaves undecided and incomplete items out and names why', () => {
    expect(kinds(result, 'undecided')).toEqual(['no_allocation']);
    expect(kinds(result, 'meal-open')).toEqual(['meal_incomplete']);
    expect(result.blockedItems).toBe(2);
    for (const l of result.lines) {
      expect(l.itemIds).not.toContain('undecided');
      expect(l.itemIds).not.toContain('meal-open');
    }
  });

  it('counts an estimated amount and says it is estimated', () => {
    expect(kinds(result, 'hosting-usd')).toEqual(['amount_estimated']);
    expect(result.checks.find((c) => c.itemId === 'hosting-usd')?.blocking).toBe(false);
    expect(line(result, 'euer.work_equipment')?.itemIds).toContain('hosting-usd');
  });

  it('ignores other years', () => {
    const ids = result.items.map((i) => i.itemId);
    expect(ids).not.toContain('previous-year');
    expect(ids).not.toContain('next-year');
  });

  it('tracks what nobody deducts', () => {
    const internet = result.items.find((i) => i.itemId === 'internet');
    // 419.88 minus 209.94 business minus 125.96 study.
    expect(internet?.privateCents).toBe(41988 - 20994 - 12596);
    expect(result.items.find((i) => i.itemId === 'private-music')?.privateCents).toBe(999);
  });
});

describe('computeYear: open checks', () => {
  const blocked: [string, Partial<LedgerItem>, OpenCheckKind][] = [
    ['no amount', { amountCents: null, missingAmount: 'no_amount' }, 'no_amount'],
    ['foreign currency without a rate', { amountCents: null, missingAmount: 'no_exchange_rate' }, 'no_exchange_rate'],
    ['section 19 unanswered', { smallBusiness: null }, 'small_business_unanswered'],
    ['regular taxation', { smallBusiness: false }, 'regular_taxation_not_computed'],
    ['no allocation', { allocations: null }, 'no_allocation'],
    ['shares above the whole', { allocations: [{ purpose: 'business', shareBp: 7000 }, { purpose: 'study', shareBp: 4000 }], employmentLineKey: 'employment.study_costs' }, 'allocation_exceeds_whole'],
    ['business share without a form line', { formLineKey: null }, 'no_form_line'],
    ['study share without an annex line', { allocations: [{ purpose: 'study', shareBp: 3000 }] }, 'no_employment_line'],
    ['meal line without register facts', { formLineKey: 'euer.meals', meal: null }, 'meal_without_register_facts'],
    ['meal without a total', { formLineKey: 'euer.meals', meal: { status: 'no_amount' } }, 'no_amount'],
  ];

  it.each(blocked)('%s keeps the item out of the totals', (_name, overrides, kind) => {
    const result = run([item({ id: 'x', ...overrides })]);
    expect(kinds(result, 'x')).toContain(kind);
    expect(result.items[0].counted).toBe(false);
    expect(result.lines).toEqual([]);
    expect(result.businessExpenseCents).toBe(0);
  });

  it('puts an item without a date into the queue of every year', () => {
    for (const year of [2025, 2026]) {
      const result = run([item({ id: 'x', date: null })], year);
      expect(kinds(result, 'x')).toEqual(['no_date']);
      expect(result.lines).toEqual([]);
    }
  });

  it('a private item needs no form line and no section 19 answer is still required', () => {
    const result = run([item({ id: 'x', formLineKey: null, allocations: [{ purpose: 'private', shareBp: 10000 }] })]);
    expect(result.checks).toEqual([]);
    expect(result.items[0]).toMatchObject({ counted: true, parts: [], privateCents: 10000 });
  });

  it('a meal the register excludes contributes nothing and is not an open check', () => {
    const result = run([item({ id: 'x', formLineKey: 'euer.meals', meal: { status: 'excluded' } })]);
    expect(result.checks).toEqual([]);
    expect(result.lines).toEqual([]);
    expect(result.items[0].privateCents).toBe(10000);
  });
});

describe('computeYear: properties', () => {
  it('a higher share never lowers the deduction', () => {
    let previous = -1;
    for (let bp = 0; bp <= 10000; bp += 250) {
      const cents = run([item({ id: 'x', amountCents: 12345, allocations: business(bp) })]).businessExpenseCents;
      expect(cents).toBeGreaterThanOrEqual(previous);
      previous = cents;
    }
  });

  it('never deducts more than an item cost, up to one cent of rounding per share', () => {
    for (const cents of [1, 99, 12345, 41988]) {
      const result = run([
        item({
          id: 'x',
          amountCents: cents,
          employmentLineKey: 'employment.study_costs',
          allocations: [{ purpose: 'business', shareBp: 5000 }, { purpose: 'study', shareBp: 5000 }],
        }),
      ]);
      expect(result.businessExpenseCents + result.employmentCostCents).toBeLessThanOrEqual(cents + 1);
    }
  });

  it('is independent of the order of items', () => {
    const forward = run(SYNTHETIC_YEAR);
    const backward = run([...SYNTHETIC_YEAR].reverse());
    expect(backward.lines.map((l) => [l.key, l.cents])).toEqual(forward.lines.map((l) => [l.key, l.cents]));
    expect(backward.businessExpenseCents).toBe(forward.businessExpenseCents);
  });

  it('changing a share back restores the figure exactly', () => {
    const base = run(SYNTHETIC_YEAR).businessExpenseCents;
    const changed = SYNTHETIC_YEAR.map((i) => (i.id === 'drive' ? { ...i, allocations: business(5000) } : i));
    expect(run(changed).businessExpenseCents).toBe(base - 28950 + 14475);
    expect(run(SYNTHETIC_YEAR).businessExpenseCents).toBe(base);
  });
});

describe('computeYear: rule sets', () => {
  it('prints no line numbers for a year whose form is not verified', () => {
    const result = run([item({ id: 'x', date: '2026-03-01' })], 2026);
    expect(result.formLinesVerified).toBe(false);
    expect(result.lines[0]).toMatchObject({ key: 'euer.work_equipment', line: null, cents: 10000 });
  });

  it('says which rules a year without its own rule set was computed with', () => {
    const result = run([item({ id: 'x', date: '2031-03-01' })], 2031);
    expect(result).toMatchObject({ year: 2031, rulesExact: false });
    expect(result.rulesYear).not.toBe(2031);
    expect(rules2025.exact).toBe(true);
  });
});
