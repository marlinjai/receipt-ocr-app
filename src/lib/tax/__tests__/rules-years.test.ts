import { describe, expect, it } from 'vitest';
import { assetChecks, maxDecliningRateBp, type AssetFact } from '../assets';
import { forecastYear } from '../forecast';
import { FORM_LINE_KEYS, formLine, rulesForYear } from '../rules';
import type { FormLineKey } from '../rules/types';

/**
 * The rule sets of 2021 to 2024, each against the official form of its year
 * (Anlage EÜR from the finance ministry's letters, Anlage N from the federal
 * form portal), read on 2026-10-15.
 */

const line = (year: number, key: FormLineKey) => formLine(rulesForYear(year).rules, key);

describe('income-surplus statement line numbers, 2021 to 2025', () => {
  // key, 2021, 2022, 2023, 2024, 2025
  const official: Array<[FormLineKey, number, number, number, number, number]> = [
    ['euer.revenue_small_business', 11, 11, 11, 12, 12],
    ['euer.revenue_taxable', 14, 14, 14, 15, 15],
    ['euer.revenue_not_taxable', 15, 15, 15, 16, 16],
    ['euer.vat_received', 16, 16, 16, 17, 17],
    ['euer.vat_refunded', 17, 17, 17, 18, 18],
    ['euer.asset_disposal', 18, 18, 18, 19, 19],
    ['euer.goods', 26, 26, 26, 27, 27],
    ['euer.external_services', 27, 27, 27, 29, 29],
    ['euer.depreciation_intangible', 30, 30, 31, 32, 32],
    ['euer.depreciation_movable', 31, 31, 32, 33, 33],
    ['euer.low_value_assets', 43, 43, 35, 36, 36],
    ['euer.pool_release', 44, 44, 36, 37, 37],
    ['euer.remaining_book_value', 45, 45, 37, 38, 38],
    ['euer.rent_business_premises', 46, 46, 38, 39, 39],
    ['euer.telecom', 49, 49, 41, 43, 43],
    ['euer.travel_lodging', 50, 50, 42, 44, 44],
    ['euer.training', 51, 51, 43, 45, 45],
    ['euer.legal_tax_advice', 52, 52, 44, 46, 46],
    ['euer.leasing_movable', 53, 53, 45, 47, 47],
    ['euer.maintenance', 54, 54, 46, 48, 48],
    ['euer.fees_insurance', 55, 55, 47, 49, 49],
    ['euer.it_running', 56, 56, 48, 50, 50],
    ['euer.work_equipment', 57, 57, 49, 51, 51],
    ['euer.packaging_transport', 59, 59, 51, 53, 53],
    ['euer.advertising', 60, 60, 52, 54, 54],
    ['euer.input_vat', 63, 63, 55, 57, 57],
    ['euer.vat_paid', 64, 64, 56, 58, 58],
    ['euer.other_unlimited', 66, 66, 58, 60, 60],
    ['euer.gifts', 67, 67, 60, 62, 62],
    ['euer.meals', 68, 68, 61, 63, 63],
    ['euer.travel_meal_allowance', 69, 69, 62, 64, 64],
    ['euer.home_office_flat', 70, 70, 63, 66, 66],
    ['euer.other_travel', 83, 83, 67, 70, 70],
  ];

  it.each(official)('%s: 2021 line %i, 2022 %i, 2023 %i, 2024 %i, 2025 %i', (key, ...numbers) => {
    [2021, 2022, 2023, 2024, 2025].forEach((year, i) => {
      expect(line(year, key), `${key} in ${year}`).toMatchObject({ line: numbers[i], numbering: 'verified' });
    });
  });

  it('covers every income-surplus key', () => {
    expect(official.map(([key]) => key).sort()).toEqual(FORM_LINE_KEYS.filter((k) => k.startsWith('euer.')).sort());
  });

  it('2024 prints the numbers of 2025 for every income-surplus line, and its labels except the section 4 reference 2025 added', () => {
    for (const key of FORM_LINE_KEYS.filter((k) => k.startsWith('euer.'))) {
      expect(line(2024, key).line).toBe(line(2025, key).line);
      if (key !== 'euer.revenue_not_taxable') expect(line(2024, key)).toEqual(line(2025, key));
    }
    expect(line(2025, 'euer.revenue_not_taxable').label).toMatch(/umsatzsteuerfrei \(§ 4 UStG\)/);
    expect(line(2024, 'euer.revenue_not_taxable').label).not.toMatch(/§ 4 UStG/);
  });

  it('2023 to 2025 print the zero-rate clause on both revenue lines, 2021 to 2025 the corona note on other expenses', () => {
    for (const year of [2023, 2024, 2025]) {
      expect(line(year, 'euer.revenue_taxable').label).toMatch(/ermäßigten Steuersatz von 0 %/);
      expect(line(year, 'euer.revenue_not_taxable').label).toMatch(/§ 12 Abs. 3 UStG dem ermäßigten Steuersatz von 0 %/);
    }
    for (const year of [2021, 2022, 2023, 2024, 2025]) {
      expect(line(year, 'euer.other_unlimited').label).toMatch(/zurückgezahlte Hilfen\/Zuschüsse aufgrund der Corona-Pandemie/);
    }
  });

  it('before 2024 the home-office line has a not-deductible column and says which column the flat rate goes in', () => {
    for (const year of [2021, 2022, 2023]) {
      expect(line(year, 'euer.home_office_flat')).toMatchObject({ limited: true });
      expect(line(year, 'euer.home_office_flat').label).toMatch(/Spalte „abziehbar“ \(Kennzahl 172\)/);
    }
    expect(line(2024, 'euer.home_office_flat').limited).toBeUndefined();
  });

  it('before 2024 the home-office day rate had no line of its own and is shown on the line it was entered on', () => {
    expect(line(2021, 'euer.home_office_flat').label).toMatch(/^Aufwendungen für ein häusliches Arbeitszimmer/);
    expect(line(2021, 'euer.home_office_flat').label).toMatch(/Home-Office-Pauschale/);
    expect(line(2023, 'euer.home_office_flat').label).toMatch(/^Aufwendungen für die Tätigkeit in der häuslichen Wohnung/);
    expect(line(2024, 'euer.home_office_flat').label).toBe('Tagespauschale für die Tätigkeit in der häuslichen Wohnung');
  });

  it('keeps the labels each older form printed', () => {
    expect(line(2021, 'euer.input_vat').label).toBe('Gezahlte Vorsteuerbeträge');
    expect(line(2023, 'euer.input_vat').label).toBe('Gezahlte Vorsteuerbeträge');
    expect(line(2024, 'euer.input_vat').label).toMatch(/nach § 15 UStG abziehbare/);
    expect(line(2022, 'euer.revenue_not_taxable').label).toMatch(/Corona-Pandemie/);
    expect(line(2023, 'euer.revenue_taxable').label).toMatch(/0 %/);
    expect(line(2023, 'euer.maintenance').label).toMatch(/Kraftfahrzeuge/);
  });
});

describe('employment annex line numbers, 2021 to 2025', () => {
  // key, 2021, 2022, 2023, 2024, 2025
  const official: Array<[FormLineKey, number, number, number, number, number]> = [
    ['employment.work_equipment', 43, 43, 59, 59, 56],
    ['employment.study_costs', 46, 46, 63, 63, 60],
    ['employment.further_costs', 49, 49, 67, 67, 64],
  ];

  it.each(official)('%s: 2021 line %i, 2022 %i, 2023 %i, 2024 %i, 2025 %i', (key, ...numbers) => {
    [2021, 2022, 2023, 2024, 2025].forEach((year, i) => {
      expect(line(year, key), `${key} in ${year}`).toMatchObject({ line: numbers[i], numbering: 'verified', form: 'employment' });
    });
  });

  it('the further costs say per year where their entries go', () => {
    expect(line(2021, 'employment.further_costs').entryNote).toMatch(/Zeilen 48 und 49.*Zeile 47/);
    expect(line(2023, 'employment.further_costs').entryNote).toMatch(/Zeilen 65 und 66.*Zeile 67.*Zeile 64/);
  });

  it('2021 and 2022 name the home-office day count as their form does', () => {
    for (const year of [2021, 2022]) expect(line(year, 'employment.home_office').label).toMatch(/^Homeoffice-Pauschale/);
    expect(line(2023, 'employment.home_office').label).toBe('Tagespauschale für die Tätigkeit in der häuslichen Wohnung');
  });

  it.each([2021, 2022, 2023, 2024])('in %i days and distances have no amount line', (year) => {
    for (const key of ['employment.home_office', 'employment.commute'] as const) {
      expect(line(year, key)).toMatchObject({ line: null, numbering: 'structured' });
    }
  });

  it.each([2021, 2022, 2023, 2024])('%i cites the official employment annex of its own year', (year) => {
    const source = rulesForYear(year).rules.formSources.employment;
    expect(source?.url).toContain(`est${String(year).slice(2)}%2F034027_${String(year).slice(2)}`);
    expect(source?.citation).toContain(`Anlage N ${year}`);
  });
});

describe('legal values of 2021 to 2024', () => {
  it('the small-business limits before 2025 were 22,000 and 50,000 euros, the 50,000 a forecast at the start of the year', () => {
    for (const year of [2021, 2022, 2023, 2024]) {
      expect(rulesForYear(year).rules.smallBusinessLimits.value).toEqual({
        previousYearLimitCents: 2_200_000,
        currentYearLimitCents: 5_000_000,
        currentYearLimit: 'forecast_at_start',
      });
    }
    // From 2025 crossing the running-year limit ends the rule at once (the default).
    expect(rulesForYear(2025).rules.smallBusinessLimits.value).toEqual({ previousYearLimitCents: 2_500_000, currentYearLimitCents: 10_000_000 });
  });

  it('2024 turnover is measured for 2025 against the 25,000 of 2025, not the 22,000 of 2024', () => {
    // 23,000 received in 2024: above the old limit, within the new one.
    const received = Array.from({ length: 12 }, (_, i) => (i === 0 ? 2_300_000 : 0));
    const input = { year: 2024, today: '2026-10-16', receivedByMonthCents: received, previousYearReceivedCents: null, outstandingCents: 0, expectedMonthlyCents: null };
    const limits = rulesForYear(2024).rules.smallBusinessLimits.value;
    const nextYearLimitCents = rulesForYear(2025).rules.smallBusinessLimits.value.previousYearLimitCents;
    expect(forecastYear(input, { ...limits, nextYearLimitCents }).nextYear).toEqual({ state: 'not_reached' });
    // Without the next year's limit the old one would warn wrongly.
    expect(forecastYear(input, limits).nextYear).toMatchObject({ state: 'crossed' });
  });

  it('the low-value limit, the register limit, the pool and the meal share held unchanged', () => {
    for (const year of [2021, 2022, 2023, 2024]) {
      const { rules } = rulesForYear(year);
      expect(rules.assets.lowValueNetLimitCents.value).toBe(80_000);
      expect(rules.assets.lowValueRegisterAboveNetCents.value).toBe(25_000);
      expect(rules.assets.pool.value).toEqual({ minExclusiveNetCents: 25_000, maxNetCents: 100_000, years: 5 });
      expect(rules.mealDeductibleShareBp.value).toBe(7000);
    }
  });

  it('the one-year life of computers is cited from the letter in force in each year', () => {
    expect(rulesForYear(2021).rules.assets.computer.source.citation).toMatch(/26\. Februar 2021/);
    for (const year of [2022, 2023, 2024]) expect(rulesForYear(year).rules.assets.computer.source.citation).toMatch(/22\. Februar 2022/);
  });
});

describe('the declining method by year of purchase', () => {
  const asset = (acquisitionDate: string, decliningRateBp: number, usefulLifeMonths = 84): AssetFact => ({
    id: 'a',
    label: 'Kamera',
    kind: 'movable',
    acquisitionDate,
    costCents: 200_000,
    netCostCents: null,
    method: 'declining',
    usefulLifeMonths,
    decliningRateBp,
    businessShareBp: 10_000,
    reminderCents: 0,
    opening: null,
    disposal: null,
    smallBusiness: true,
  });
  const checks = (a: AssetFact) => assetChecks(a, rulesForYear(Number((a.acquisitionDate as string).slice(0, 4))).rules.assets).map((c) => c.kind);

  it('2021 and 2022: open at up to two and a half times the straight-line rate, at most 25 percent', () => {
    // Seven years: straight line 14.28 percent, two and a half times that is 35.7, capped at 25.
    expect(maxDecliningRateBp(84, rulesForYear(2021).rules.assets)).toBe(2500);
    // Thirteen years: 2.5 / 13 is 19.23 percent, rounded down once to whole basis points.
    expect(maxDecliningRateBp(156, rulesForYear(2022).rules.assets)).toBe(1923);
    // Twelve years: 2.5 / 12 is 20.83 percent.
    expect(maxDecliningRateBp(144, rulesForYear(2021).rules.assets)).toBe(2083);
    // 2025, twelve years at three times: exactly 25 percent, not 24.99.
    expect(maxDecliningRateBp(144, rulesForYear(2025).rules.assets)).toBe(2500);
    expect(checks(asset('2021-06-01', 2500))).toEqual([]);
    expect(checks(asset('2022-11-30', 2500))).toEqual([]);
    expect(checks(asset('2021-06-01', 2501))).toEqual(['asset_declining_rate_too_high']);
    expect(checks(asset('2022-11-30', 1923, 156))).toEqual([]);
    expect(checks(asset('2022-11-30', 1924, 156))).toEqual(['asset_declining_rate_too_high']);
    expect(checks(asset('2025-07-01', 2500, 144))).toEqual([]);
  });

  it('2023 and the first quarter of 2024: closed', () => {
    expect(checks(asset('2023-05-01', 2000))).toEqual(['asset_declining_not_allowed']);
    expect(checks(asset('2024-03-31', 2000))).toEqual(['asset_declining_not_allowed']);
  });

  it('from 1 April 2024: open at up to twice the straight-line rate, at most 20 percent', () => {
    expect(checks(asset('2024-04-01', 2000))).toEqual([]);
    expect(checks(asset('2024-12-31', 2001))).toEqual(['asset_declining_rate_too_high']);
    expect(maxDecliningRateBp(84, rulesForYear(2024).rules.assets)).toBe(2000);
  });

  it('2025 is unchanged: open from 1 July 2025 at 30 percent', () => {
    expect(checks(asset('2025-06-30', 2000))).toEqual(['asset_declining_not_allowed']);
    expect(checks(asset('2025-07-01', 3000))).toEqual([]);
  });
});

describe('rulesForYear before 2021', () => {
  it('falls back to 2021 and says so', () => {
    expect(rulesForYear(2020)).toMatchObject({ exact: false, rules: { year: 2021 } });
    for (const year of [2021, 2022, 2023, 2024]) expect(rulesForYear(year).exact).toBe(true);
  });
});
