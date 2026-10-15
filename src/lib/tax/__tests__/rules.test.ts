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

  it.skipIf(rules.provisional !== undefined)('the income-surplus statement is cited from the ministry itself', () => {
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

  it('the employment annex of 2025 has its three amount lines, 2026 inherits none of them', () => {
    // Read off the official Anlage N 2025: the total of work equipment on line 56,
    // training costs on 60, the total of the further costs on 64.
    expect(line(2025, 'employment.work_equipment')).toMatchObject({ line: 56, numbering: 'verified' });
    expect(line(2025, 'employment.study_costs')).toMatchObject({ line: 60, numbering: 'verified' });
    expect(line(2025, 'employment.further_costs')).toMatchObject({ line: 64, numbering: 'verified', form: 'employment', kind: 'expense' });
    // The Anlage N 2026 is not public on the check day (2026-10-15): no number, never 2025's.
    for (const key of ['employment.work_equipment', 'employment.study_costs', 'employment.further_costs'] as const) {
      expect(line(2026, key)).toMatchObject({ line: null, numbering: 'unverified' });
    }
    expect(rulesForYear(2026).rules.formSources.employment).toBeNull();
  });

  it('the further employment costs are a line of their own, not training costs', () => {
    expect(line(2025, 'employment.further_costs').label).toMatch(/Weitere Werbungskosten/);
    expect(line(2025, 'employment.further_costs').label).toMatch(/Bewerbungskosten/);
    expect(line(2025, 'employment.further_costs').line).not.toBe(line(2025, 'employment.study_costs').line);
  });

  it('says where the further costs are entered, because their printed total holds more than the app records', () => {
    expect(line(2025, 'employment.further_costs').entryNote).toMatch(/Zeilen 62 und 63/);
    expect(line(2025, 'employment.further_costs').entryNote).toMatch(/Fähr- und Flugkosten aus Zeile 61/);
    // Without a number there is nothing to point at.
    expect(line(2026, 'employment.further_costs').entryNote).toBeUndefined();
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

describe('the provisional rule set of 2027', () => {
  const { rules: r2027, exact } = rulesForYear(2027);
  const r2026 = rulesForYear(2026).rules;

  it('exists as its own year and says it is provisional, carried from 2026', () => {
    expect(exact).toBe(true);
    expect(r2027.provisional).toMatchObject({ carriedFromYear: 2026 });
    expect(r2027.provisional?.reason).toMatch(/2027/);
  });

  // This test fails on purpose once the review replaces a 2027 value with a
  // published one: then delete it together with `provisional`.
  it('carries every legal value of 2026 unchanged, so the review knows exactly what to replace', () => {
    expect(r2027.mealDeductibleShareBp).toEqual(r2026.mealDeductibleShareBp);
    expect(r2027.assets).toEqual(r2026.assets);
    expect(r2027.smallBusinessLimits).toEqual(r2026.smallBusinessLimits);
  });

  it('prints no line number of another year and cites no form', () => {
    expect(r2027.formSources).toEqual({ euer: null, employment: null });
    for (const l of r2027.formLines) {
      expect(l.line, l.key).toBeNull();
      expect(l.numbering, l.key).not.toBe('verified');
    }
  });

  it('the declining method is still open for purchases of 2027', () => {
    expect(r2027.assets.declining.value.acquiredFrom <= '2027-01-01').toBe(true);
    expect(r2027.assets.declining.value.acquiredTo >= '2027-12-31').toBe(true);
  });

  it('the years with their own published figures are not provisional', () => {
    expect(rulesForYear(2025).rules.provisional).toBeUndefined();
    expect(r2026.provisional).toBeUndefined();
  });
});
