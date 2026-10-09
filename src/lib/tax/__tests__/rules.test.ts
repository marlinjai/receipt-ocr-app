import { describe, expect, it } from 'vitest';
import { FORM_LINE_KEYS, RULE_YEARS, formLine, rulesForYear } from '../rules';
import type { FormLineKey } from '../rules/types';

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const line = (year: number, key: FormLineKey) => formLine(rulesForYear(year).rules, key);

describe.each(RULE_YEARS)('rule set %i', (year) => {
  const { rules, exact } = rulesForYear(year);

  it('is the exact rule set for its year', () => {
    expect(exact).toBe(true);
    expect(rules.year).toBe(year);
  });

  it('has a catalog entry for every form line key, each key once', () => {
    const keys = rules.formLines.map((l) => l.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect([...keys].sort()).toEqual([...FORM_LINE_KEYS].sort());
  });

  it('never prints the same line number twice on one form', () => {
    for (const form of ['euer', 'employment'] as const) {
      const numbers = rules.formLines.filter((l) => l.form === form && l.line !== null).map((l) => l.line);
      expect(new Set(numbers).size).toBe(numbers.length);
    }
  });

  it('carries a number exactly on verified lines', () => {
    for (const l of rules.formLines) {
      if (l.numbering === 'verified') expect(l.line, l.key).toEqual(expect.any(Number));
      else expect(l.line, l.key).toBeNull();
      if (l.numbering === 'structured') expect(l.structuredNote, l.key).toBeTruthy();
    }
  });

  it('a form with numbered lines names its source, a form without a source has none', () => {
    for (const form of ['euer', 'employment'] as const) {
      const verified = rules.formLines.filter((l) => l.form === form && l.numbering === 'verified');
      const source = rules.formSources[form];
      if (source === null) expect(verified, `${form} has numbers but no source`).toEqual([]);
      else {
        expect(verified.length).toBeGreaterThan(0);
        expect(source.citation.length).toBeGreaterThan(10);
        expect(source.url).toMatch(/^https:\/\//);
        expect(source.checkedOn).toMatch(ISO_DAY);
      }
    }
    expect(rules.reviewedOn).toMatch(ISO_DAY);
  });

  it('names a source and a check date for every legal value', () => {
    const sources = [
      rules.mealDeductibleShareBp.source,
      rules.assets.lowValueNetLimitCents.source,
      rules.assets.pool.source,
      rules.assets.computer.source,
      rules.assets.declining.source,
      rules.assets.highestVatRateBp.source,
    ];
    for (const source of sources) {
      expect(source.url).toMatch(/^https:\/\//);
      expect(source.checkedOn).toMatch(ISO_DAY);
    }
  });

  it('the income-surplus statement is cited from the ministry itself', () => {
    expect(rules.formSources.euer?.url).toMatch(/^https:\/\/www\.bundesfinanzministerium\.de\//);
    expect(rules.formSources.euer?.url).toContain(String(year));
  });
});

describe('the years keep their own line numbers', () => {
  // The numbers the two official forms print, key by key. 2026 is not 2025
  // plus one: goods moved by two, revenue lines not at all.
  const official: Array<[FormLineKey, number, number]> = [
    ['euer.revenue_small_business', 12, 12],
    ['euer.revenue_taxable', 15, 15],
    ['euer.revenue_not_taxable', 16, 16],
    ['euer.vat_received', 17, 17],
    ['euer.vat_refunded', 18, 18],
    ['euer.asset_disposal', 19, 19],
    ['euer.goods', 27, 29],
    ['euer.external_services', 29, 30],
    ['euer.depreciation_intangible', 32, 33],
    ['euer.depreciation_movable', 33, 34],
    ['euer.low_value_assets', 36, 37],
    ['euer.pool_release', 37, 38],
    ['euer.remaining_book_value', 38, 39],
    ['euer.rent_business_premises', 39, 40],
    ['euer.telecom', 43, 44],
    ['euer.travel_lodging', 44, 45],
    ['euer.training', 45, 46],
    ['euer.legal_tax_advice', 46, 47],
    ['euer.leasing_movable', 47, 48],
    ['euer.maintenance', 48, 49],
    ['euer.fees_insurance', 49, 50],
    ['euer.it_running', 50, 51],
    ['euer.work_equipment', 51, 52],
    ['euer.packaging_transport', 53, 54],
    ['euer.advertising', 54, 55],
    ['euer.input_vat', 57, 58],
    ['euer.vat_paid', 58, 59],
    ['euer.other_unlimited', 60, 61],
    ['euer.gifts', 62, 63],
    ['euer.meals', 63, 64],
    ['euer.travel_meal_allowance', 64, 65],
    ['euer.home_office_flat', 66, 67],
    ['euer.other_travel', 70, 71],
  ];

  it.each(official)('%s is line %i in 2025 and line %i in 2026', (key, in2025, in2026) => {
    expect(line(2025, key)).toMatchObject({ line: in2025, numbering: 'verified' });
    expect(line(2026, key)).toMatchObject({ line: in2026, numbering: 'verified' });
  });

  it('covers every income-surplus key, so a new key cannot slip in without both numbers', () => {
    expect(official.map(([key]) => key).sort()).toEqual(FORM_LINE_KEYS.filter((k) => k.startsWith('euer.')).sort());
  });

  it('goods did not simply move by one', () => {
    expect(line(2026, 'euer.goods').line).toBe(29);
    expect(line(2026, 'euer.goods').line).not.toBe((line(2025, 'euer.goods').line as number) + 1);
  });

  it('the employment annex of 2025 has its two amount lines, 2026 inherits none of them', () => {
    expect(line(2025, 'employment.work_equipment')).toMatchObject({ line: 56, numbering: 'verified' });
    expect(line(2025, 'employment.study_costs')).toMatchObject({ line: 60, numbering: 'verified' });
    expect(line(2026, 'employment.work_equipment')).toMatchObject({ line: null, numbering: 'unverified' });
    expect(line(2026, 'employment.study_costs')).toMatchObject({ line: null, numbering: 'unverified' });
    expect(rulesForYear(2026).rules.formSources.employment).toBeNull();
  });

  it.each([2025, 2026])('in %i days and distances have no amount line at all', (year) => {
    for (const key of ['employment.home_office', 'employment.commute'] as const) {
      expect(line(year, key)).toMatchObject({ line: null, numbering: 'structured' });
    }
  });
});

describe('rulesForYear', () => {
  it('falls back to the nearest rule set and says so', () => {
    const newest = Math.max(...RULE_YEARS);
    const oldest = Math.min(...RULE_YEARS);
    expect(rulesForYear(newest + 3)).toMatchObject({ exact: false, rules: { year: newest } });
    expect(rulesForYear(oldest - 3)).toMatchObject({ exact: false, rules: { year: oldest } });
  });

  // The forcing function for the yearly review: from 1 December the rule set
  // of the coming year has to exist, or every build says so.
  it('has the coming year by 1 December', () => {
    const now = new Date();
    if (now.getUTCMonth() === 11) {
      expect(RULE_YEARS, `add src/lib/tax/rules/${now.getUTCFullYear() + 1}.ts`).toContain(now.getUTCFullYear() + 1);
    }
    expect(RULE_YEARS).toContain(now.getUTCFullYear());
  });
});
