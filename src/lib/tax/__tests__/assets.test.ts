import { describe, expect, it } from 'vitest';
import { assetChecks, assetSchedule, assetYearParts, maxDecliningRateBp, type AssetFact } from '../assets';
import { computeYear } from '../compute';
import { rulesForYear } from '../rules';
import { item } from './fixtures';

const rules = rulesForYear(2025).rules.assets;

/** A made-up camera bought in March 2025 for 1,500.00 gross, written off over five years. */
function asset(overrides: Partial<AssetFact> = {}): AssetFact {
  return {
    id: 'a-1',
    label: 'Kamera',
    kind: 'movable',
    acquisitionDate: '2025-03-10',
    costCents: 150_000,
    netCostCents: 126_050,
    method: 'linear',
    usefulLifeMonths: 60,
    decliningRateBp: null,
    businessShareBp: 10_000,
    reminderCents: 0,
    opening: null,
    disposal: null,
    smallBusiness: true,
    ...overrides,
  };
}

const kinds = (a: AssetFact) => assetChecks(a, rules).map((c) => c.kind);
const depreciation = (a: AssetFact, through: number) => assetSchedule(a, rules, through).map((r) => r.depreciationCents);

describe('assetSchedule: linear', () => {
  it('starts in the month of purchase and adds up to exactly the cost', () => {
    const rows = assetSchedule(asset(), rules, 2031);
    // March to December 2025 is 10 of 60 months.
    expect(rows.map((r) => r.depreciationCents)).toEqual([25_000, 30_000, 30_000, 30_000, 30_000, 5_000, 0]);
    expect(rows[0]).toMatchObject({ year: 2025, bookValueStartCents: 0, additionCents: 150_000, bookValueEndCents: 125_000 });
    expect(rows[5]).toMatchObject({ year: 2030, bookValueEndCents: 0 });
    expect(rows.reduce((s, r) => s + r.depreciationCents, 0)).toBe(150_000);
  });

  it('adds up to the cost for amounts and lives that do not divide evenly', () => {
    for (const cost of [100_001, 99_999, 123_457, 7]) {
      for (const life of [13, 36, 84, 100]) {
        for (const start of ['2025-01-15', '2025-06-30', '2025-12-31']) {
          const rows = assetSchedule(asset({ costCents: cost, usefulLifeMonths: life, acquisitionDate: start }), rules, 2040);
          expect(rows.reduce((s, r) => s + r.depreciationCents, 0)).toBe(cost);
          expect(rows.every((r) => r.depreciationCents >= 0)).toBe(true);
          expect(rows[rows.length - 1].bookValueEndCents).toBe(0);
        }
      }
    }
  });

  it('keeps a reminder value when asked to', () => {
    const rows = assetSchedule(asset({ reminderCents: 100 }), rules, 2032);
    expect(rows.reduce((s, r) => s + r.depreciationCents, 0)).toBe(149_900);
    expect(rows[rows.length - 1].bookValueEndCents).toBe(100);
  });
});

describe('assetSchedule: one-off methods', () => {
  it('a low-value asset is expensed in full in its first year', () => {
    expect(depreciation(asset({ method: 'low_value', costCents: 60_000, netCostCents: 50_420 }), 2026)).toEqual([60_000, 0]);
  });

  it('computer hardware is written off in full in the year of purchase, whatever the month', () => {
    const laptop = asset({ method: 'computer_one_year', acquisitionDate: '2025-11-25', costCents: 239_900, netCostCents: 201_597 });
    const rows = assetSchedule(laptop, rules, 2026);
    expect(rows.map((r) => r.depreciationCents)).toEqual([239_900, 0]);
    expect(rows[0].bookValueEndCents).toBe(0);
    expect(assetYearParts(laptop, rows[0])).toEqual([{ lineKey: 'euer.depreciation_movable', cents: 239_900 }]);
  });

  it('software goes to the line for intangible assets', () => {
    const software = asset({ kind: 'intangible', method: 'computer_one_year' });
    expect(assetYearParts(software, assetSchedule(software, rules, 2025)[0])[0].lineKey).toBe('euer.depreciation_intangible');
  });

  it('a pooled asset is released in fifths, sold or not', () => {
    const pooled = asset({ method: 'pool', costCents: 71_401, netCostCents: 60_001 });
    expect(depreciation(pooled, 2030)).toEqual([14_280, 14_280, 14_281, 14_280, 14_280, 0]);
    const sold = { ...pooled, disposal: { date: '2026-05-01', kind: 'sold' as const, proceedsCents: 30_000 } };
    const rows = assetSchedule(sold, rules, 2030);
    expect(rows.map((r) => r.depreciationCents)).toEqual([14_280, 14_280, 14_281, 14_280, 14_280, 0]);
    expect(rows.every((r) => r.disposalBookValueCents === 0)).toBe(true);
    // What was received is revenue all the same.
    expect(assetYearParts(sold, rows[1])).toContainEqual({ lineKey: 'euer.asset_disposal', cents: 30_000 });
  });
});

describe('assetSchedule: declining', () => {
  const declining = asset({ method: 'declining', acquisitionDate: '2025-07-10', decliningRateBp: 3000, usefulLifeMonths: 60, costCents: 100_000, netCostCents: 84_034 });

  it('takes the rate from the remaining value, by month in the first year, then switches to equal amounts', () => {
    const rows = assetSchedule(declining, rules, 2030);
    // 2025: 100,000 x 30 % x 6/12 = 15,000. 2026: 85,000 x 30 % = 25,500. 2027: 59,500 x 30 % = 17,850.
    expect(rows.slice(0, 3).map((r) => r.depreciationCents)).toEqual([15_000, 25_500, 17_850]);
    // 2028: 41,650 left with 30 months to go: equal amounts give 16,660 a year, more than 12,495 declining.
    expect(rows.slice(3).map((r) => r.depreciationCents)).toEqual([16_660, 16_660, 8_330]);
    expect(rows.reduce((s, r) => s + r.depreciationCents, 0)).toBe(100_000);
  });

  it('never writes below zero and always ends at zero', () => {
    for (const cost of [100_001, 55_555, 1_000_003]) {
      for (const life of [36, 60, 120]) {
        const a = asset({ ...declining, costCents: cost, usefulLifeMonths: life, decliningRateBp: maxDecliningRateBp(life, rules) });
        const rows = assetSchedule(a, rules, 2045);
        expect(rows.reduce((s, r) => s + r.depreciationCents, 0)).toBe(cost);
        expect(rows.every((r) => r.depreciationCents >= 0 && r.bookValueEndCents >= 0)).toBe(true);
      }
    }
  });

  it('caps the rate at three times the linear rate and at 30 percent', () => {
    expect(maxDecliningRateBp(60, rules)).toBe(3000);
    expect(maxDecliningRateBp(120, rules)).toBe(3000);
    expect(maxDecliningRateBp(180, rules)).toBe(1998);
  });
});

describe('assetSchedule: disposal and carried-in assets', () => {
  it('writes off the months before the asset left and reports the rest as remaining book value', () => {
    const sold = asset({ disposal: { date: '2027-09-15', kind: 'sold', proceedsCents: 70_000 } });
    const rows = assetSchedule(sold, rules, 2030);
    expect(rows.map((r) => r.year)).toEqual([2025, 2026, 2027]);
    // January to August 2027: 8 months of 2,500.
    expect(rows[2]).toMatchObject({ depreciationCents: 20_000, disposalBookValueCents: 75_000, bookValueEndCents: 0 });
    expect(assetYearParts(sold, rows[2])).toEqual([
      { lineKey: 'euer.depreciation_movable', cents: 20_000 },
      { lineKey: 'euer.remaining_book_value', cents: 75_000 },
      { lineKey: 'euer.asset_disposal', cents: 70_000 },
    ]);
  });

  it('an asset sold in the year it was bought counts only the months it was there', () => {
    const rows = assetSchedule(asset({ disposal: { date: '2025-08-20', kind: 'scrapped', proceedsCents: 0 } }), rules, 2026);
    // March to July: 5 months.
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ depreciationCents: 12_500, disposalBookValueCents: 137_500 });
  });

  it('an asset from before the app keeps its reminder value', () => {
    const old = asset({ acquisitionDate: null, costCents: null, netCostCents: null, reminderCents: 100, opening: { year: 2025, bookValueCents: 100, remainingMonths: 0 } });
    expect(kinds(old)).toEqual([]);
    const rows = assetSchedule(old, rules, 2026);
    expect(rows.map((r) => [r.bookValueStartCents, r.depreciationCents, r.bookValueEndCents])).toEqual([[100, 0, 100], [100, 0, 100]]);
  });

  it('an asset carried in with life left runs it out in equal amounts', () => {
    const carried = asset({ acquisitionDate: '2023-05-01', opening: { year: 2025, bookValueCents: 60_000, remainingMonths: 24 } });
    expect(depreciation(carried, 2027)).toEqual([30_000, 30_000, 0]);
  });

  it('applies the business share to every part', () => {
    const shared = asset({ businessShareBp: 6_000, disposal: { date: '2026-01-10', kind: 'private', proceedsCents: 50_001 } });
    const rows = assetSchedule(shared, rules, 2026);
    expect(assetYearParts(shared, rows[0])).toEqual([{ lineKey: 'euer.depreciation_movable', cents: 15_000 }]);
    expect(assetYearParts(shared, rows[1])).toEqual([
      { lineKey: 'euer.remaining_book_value', cents: 75_000 },
      { lineKey: 'euer.asset_disposal', cents: 30_001 },
    ]);
  });
});

describe('assetChecks', () => {
  it('passes a complete asset', () => {
    expect(kinds(asset())).toEqual([]);
  });

  it.each([
    ['no date', { acquisitionDate: null }, ['asset_no_date']],
    ['no cost', { costCents: null, netCostCents: null }, ['asset_no_cost']],
    ['section 19 unanswered', { smallBusiness: null }, ['asset_small_business_unanswered']],
    ['regular taxation', { smallBusiness: false }, ['asset_regular_taxation_not_computed']],
    ['a life of a year or less', { usefulLifeMonths: 12 }, ['asset_no_useful_life']],
    ['no life', { usefulLifeMonths: null }, ['asset_no_useful_life']],
    ['low-value above the net limit', { method: 'low_value' as const, netCostCents: 80_001 }, ['asset_low_value_over_limit']],
    ['pool below its range', { method: 'pool' as const, costCents: 20_000, netCostCents: 16_807 }, ['asset_pool_out_of_range']],
    ['pool above its range', { method: 'pool' as const, netCostCents: 100_001 }, ['asset_pool_out_of_range']],
    ['declining before the window', { method: 'declining' as const, decliningRateBp: 3000 }, ['asset_declining_not_allowed']],
    ['declining for software', { method: 'declining' as const, kind: 'intangible' as const, acquisitionDate: '2025-08-01', decliningRateBp: 3000 }, ['asset_declining_not_allowed']],
    ['declining above the cap', { method: 'declining' as const, acquisitionDate: '2025-08-01', decliningRateBp: 3001 }, ['asset_declining_rate_too_high']],
    ['declining without a rate', { method: 'declining' as const, acquisitionDate: '2025-08-01' }, ['asset_declining_rate_too_high']],
    ['disposal before purchase', { disposal: { date: '2025-01-01', kind: 'sold' as const, proceedsCents: 0 } }, ['asset_disposal_before_acquisition']],
    ['a carried-in asset with a one-off method', { method: 'low_value' as const, opening: { year: 2025, bookValueCents: 100, remainingMonths: 0 } }, ['asset_opening_method']],
  ])('%s', (_name, overrides, expected) => {
    expect(kinds(asset(overrides))).toEqual(expected);
  });

  it('decides the net limit from the gross amount only where that is conclusive', () => {
    const lowValue = (costCents: number, netCostCents: number | null) => kinds(asset({ method: 'low_value', costCents, netCostCents }));
    // Net exactly at the limit: allowed, although the gross amount is above it.
    expect(lowValue(95_200, 80_000)).toEqual([]);
    // Net unknown: within the limit gross is certain, above limit plus 19 percent is certain, in between nobody knows.
    expect(lowValue(80_000, null)).toEqual([]);
    expect(lowValue(95_201, null)).toEqual(['asset_low_value_over_limit']);
    expect(lowValue(90_000, null)).toEqual(['asset_net_unknown']);
  });
});

describe('computeYear with assets', () => {
  const run = (year: number, assets: AssetFact[], items = [item({ id: 'receipt', assetId: 'a-1', amountCents: 150_000 })]) =>
    computeYear({ year, items, assets }, rulesForYear(year));

  it('a receipt that is part of an asset is no expense of its own; the asset puts its depreciation on the statement', () => {
    const result = run(2025, [asset()]);
    expect(result.items[0]).toMatchObject({ counted: true, parts: [], checks: [] });
    expect(result.lines).toEqual([
      expect.objectContaining({ key: 'euer.depreciation_movable', line: 33, cents: 25_000, itemIds: [], assetIds: ['a-1'] }),
    ]);
    expect(result.businessExpenseCents).toBe(25_000);
    expect(result.assets[0].row).toMatchObject({ bookValueEndCents: 125_000 });
  });

  it('shows the asset in later years, with that year\'s rules for the form', () => {
    const result = run(2026, [asset()]);
    expect(result.businessExpenseCents).toBe(30_000);
    expect(result.assets[0].row).toMatchObject({ year: 2026, bookValueStartCents: 125_000, bookValueEndCents: 95_000 });
  });

  it('an asset bought later is not part of an earlier year', () => {
    expect(run(2025, [asset({ acquisitionDate: '2026-02-01' })]).assets).toEqual([]);
  });

  it('an asset that fails a check contributes nothing and says why', () => {
    const result = run(2025, [asset({ method: 'low_value' })]);
    expect(result.assetChecks.map((c) => c.kind)).toEqual(['asset_low_value_over_limit']);
    expect(result.lines).toEqual([]);
    expect(result.businessExpenseCents).toBe(0);
  });

  it('what was received for an asset is revenue, not a negative expense', () => {
    const result = run(2026, [asset({ disposal: { date: '2026-07-01', kind: 'sold', proceedsCents: 90_000 } })]);
    expect(result.businessRevenueCents).toBe(90_000);
    // Six months of depreciation plus the remaining book value.
    expect(result.businessExpenseCents).toBe(15_000 + 110_000);
  });

  it('a receipt on the low-value line that is too expensive must become an asset', () => {
    const over = (amountCents: number, netCents: number | null) =>
      run(2025, [], [item({ id: 'x', formLineKey: 'euer.low_value_assets', amountCents, netCents })]).checks.map((c) => c.kind);
    expect(over(60_000, null)).toEqual([]);
    expect(over(239_900, null)).toEqual(['needs_asset']);
    expect(over(90_000, null)).toEqual(['net_amount_needed']);
    expect(over(90_000, 75_630)).toEqual([]);
    expect(over(96_000, 80_672)).toEqual(['needs_asset']);
  });
});
