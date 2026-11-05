import { describe, expect, it } from 'vitest';
import { INCOME_TAX_RULE_YEARS, INCOME_TAX_RULES_2025, INCOME_TAX_RULES_2026, INCOME_TAX_RULES_2027, incomeTaxRulesForYear } from '../rules';
import { tariffTaxEuros, tariffZone } from '../tariff';

const z25 = INCOME_TAX_RULES_2025.tariff.value;
const z26 = INCOME_TAX_RULES_2026.tariff.value;

describe('tariffTaxEuros', () => {
  it('is 0 up to and at the basic allowance', () => {
    expect(tariffTaxEuros(0, z25)).toBe(0);
    expect(tariffTaxEuros(12_096, z25)).toBe(0);
    expect(tariffTaxEuros(12_348, z26)).toBe(0);
    expect(tariffTaxEuros(-5_000, z26)).toBe(0);
  });

  it('reproduces the tax office: 28,287 euros in 2025 are 3,822 euros (provisional calculation of a filed return)', () => {
    expect(tariffTaxEuros(28_287, z25)).toBe(3_822);
    expect(tariffZone(28_287, z25)).toBe(3);
  });

  it('computes 2026 from the statute (zone 3: (173.10 z + 2,397) z + 1,034.87)', () => {
    // z = (20,000 - 17,799) / 10,000 = 0.2201 -> 1,570.84, rounded down.
    expect(tariffTaxEuros(20_000, z26)).toBe(1_570);
    // Zone 4: 0.42 * 100,000 - 11,135.63 = 30,864.37.
    expect(tariffTaxEuros(100_000, z26)).toBe(30_864);
    // Zone 5: 0.45 * 300,000 - 19,470.38 = 115,529.62.
    expect(tariffTaxEuros(300_000, z26)).toBe(115_529);
  });

  it('rounds the taxable income down to the euro first', () => {
    expect(tariffTaxEuros(28_287.99, z25)).toBe(tariffTaxEuros(28_287, z25));
  });

  // The zones are published as separate formulas; a mistyped coefficient
  // shows as a jump at a boundary. The statute's formulas meet within a euro.
  it.each([
    ['2025', z25],
    ['2026', z26],
  ])('is continuous at every zone boundary in %s', (_year, zones) => {
    for (const boundary of [zones.basicAllowance, zones.zone2Upper, zones.zone3Upper, zones.zone4Upper]) {
      const below = tariffTaxEuros(boundary, zones);
      const above = tariffTaxEuros(boundary + 1, zones);
      expect(above - below).toBeGreaterThanOrEqual(0);
      expect(above - below).toBeLessThanOrEqual(1);
    }
  });

  it('never falls when income rises', () => {
    for (const zones of [z25, z26]) {
      let previous = 0;
      for (let x = 0; x <= 300_000; x += 97) {
        const tax = tariffTaxEuros(x, zones);
        expect(tax).toBeGreaterThanOrEqual(previous);
        previous = tax;
      }
    }
  });
});

describe('incomeTaxRulesForYear', () => {
  it('returns the year itself when it exists', () => {
    expect(incomeTaxRulesForYear(2025)).toEqual({ rules: INCOME_TAX_RULES_2025, exact: true });
    expect(incomeTaxRulesForYear(2026).exact).toBe(true);
  });

  it('falls back to the nearest year and says so', () => {
    expect(incomeTaxRulesForYear(2028)).toEqual({ rules: INCOME_TAX_RULES_2027, exact: false });
    expect(incomeTaxRulesForYear(2024)).toEqual({ rules: INCOME_TAX_RULES_2025, exact: false });
  });

  // The forcing function for the yearly review, as for the year rule sets:
  // from 1 December the values of the coming year have to exist.
  it('has the coming year by 1 December', () => {
    const now = new Date();
    if (now.getUTCMonth() === 11) {
      expect(INCOME_TAX_RULE_YEARS, `add INCOME_TAX_RULES_${now.getUTCFullYear() + 1} to src/lib/tax/income-tax/rules.ts`).toContain(now.getUTCFullYear() + 1);
    }
    expect(INCOME_TAX_RULE_YEARS).toContain(now.getUTCFullYear());
  });

  it('gives every value a source with a check date', () => {
    for (const r of INCOME_TAX_RULE_YEARS.map((y) => incomeTaxRulesForYear(y).rules)) {
      for (const [key, value] of Object.entries(r)) {
        if (typeof value === 'object' && value !== null && 'value' in value) {
          const source = (value as { source: { citation: string; url: string; checkedOn: string } }).source;
          expect(source.citation, key).toBeTruthy();
          expect(source.url, key).toMatch(/^https:\/\//);
          expect(source.checkedOn, key).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        }
      }
    }
  });
});

describe('the provisional income tax values of 2027', () => {
  const r2027 = INCOME_TAX_RULES_2027;
  const r2026 = INCOME_TAX_RULES_2026;

  it('exist as their own year and say they are provisional, carried from 2026', () => {
    expect(incomeTaxRulesForYear(2027)).toEqual({ rules: r2027, exact: true });
    expect(r2027.year).toBe(2027);
    expect(r2027.provisional).toMatchObject({ carriedFromYear: 2026 });
  });

  it('name the pending acts a reader would check', () => {
    expect(r2027.provisional?.reason).toMatch(/Einkommensteuerreformgesetz 2027/);
    expect(r2027.provisional?.reason).toMatch(/21\/8235/);
    expect(r2027.provisional?.reason).toMatch(/Rechengrößen der Sozialversicherung 2027/);
  });

  // This test fails on purpose once the review replaces a 2027 value with an
  // enacted one: then delete it together with `provisional`.
  it('carry every value of 2026 unchanged, each named, so the review knows exactly what to replace', () => {
    expect(r2027.tariff).toEqual(r2026.tariff);
    expect(r2027.solidarity).toEqual(r2026.solidarity);
    expect(r2027.employeeFlatAllowanceCents).toEqual(r2026.employeeFlatAllowanceCents);
    expect(r2027.unionDuesBesideFlatAllowance).toEqual(r2026.unionDuesBesideFlatAllowance);
    expect(r2027.specialExpensesFlatCents).toEqual(r2026.specialExpensesFlatCents);
    expect(r2027.commute).toEqual(r2026.commute);
    expect(r2027.homeOfficeDay).toEqual(r2026.homeOfficeDay);
    expect(r2027.vocationalTrainingCapCents).toEqual(r2026.vocationalTrainingCapCents);
    expect(r2027.donationsCapBp).toEqual(r2026.donationsCapBp);
    expect(r2027.pension).toEqual(r2026.pension);
    expect(r2027.sickPayReductionBp).toEqual(r2026.sickPayReductionBp);
    expect(r2027.otherInsuranceCapCents).toEqual(r2026.otherInsuranceCapCents);
    expect(r2027.churchTaxRateBp).toEqual(r2026.churchTaxRateBp);
  });

  it('cover every value field, so a new field cannot be carried silently', () => {
    const named = [
      'tariff', 'solidarity', 'employeeFlatAllowanceCents', 'unionDuesBesideFlatAllowance', 'specialExpensesFlatCents', 'commute',
      'homeOfficeDay', 'vocationalTrainingCapCents', 'donationsCapBp', 'pension', 'sickPayReductionBp', 'otherInsuranceCapCents', 'churchTaxRateBp',
    ];
    const sourced = Object.entries(r2027).filter(([, v]) => typeof v === 'object' && v !== null && 'source' in v).map(([k]) => k);
    expect(sourced.sort()).toEqual([...named].sort());
  });

  it('the years with enacted values are not provisional', () => {
    expect(INCOME_TAX_RULES_2025.provisional).toBeUndefined();
    expect(r2026.provisional).toBeUndefined();
  });
});
