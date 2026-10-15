import type { TariffZones } from './rules';

/**
 * The income tax of section 32a (1) of the income tax act for a single
 * assessment, in whole euros.
 *
 * The statute rounds the taxable income down to the euro, computes the zone
 * formula and rounds the tax down to the euro. The formulas carry decimals
 * (932.30 y squared), so they are evaluated in integers here: every
 * coefficient is turned into hundredths and the polynomial into units of
 * 1e-10 euro, which stays far below the largest exact integer for any income
 * the zones with a polynomial cover. No floating point rounding can move the
 * result by a euro at a zone boundary.
 */
export function tariffTaxEuros(taxableIncomeEuros: number, zones: TariffZones): number {
  if (!Number.isFinite(taxableIncomeEuros)) throw new RangeError('taxable income must be finite');
  const x = Math.floor(taxableIncomeEuros);
  if (x <= zones.basicAllowance) return 0;
  const hundredths = (v: number) => Math.round(v * 100);
  const E10 = 10_000_000_000;
  if (x <= zones.zone2Upper) {
    const d = x - zones.basicAllowance;
    // (a y + b) y with y = d / 10000, scaled by 1e10.
    const scaled = hundredths(zones.zone2.a) * d * d + zones.zone2.b * d * 1_000_000;
    return Math.floor(scaled / E10);
  }
  if (x <= zones.zone3Upper) {
    const d = x - zones.zone2Upper;
    const scaled = hundredths(zones.zone3.a) * d * d + zones.zone3.b * d * 1_000_000 + hundredths(zones.zone3.c) * 100_000_000;
    return Math.floor(scaled / E10);
  }
  if (x <= zones.zone4Upper) return Math.floor((42 * x - hundredths(zones.zone4Minus)) / 100);
  return Math.floor((45 * x - hundredths(zones.zone5Minus)) / 100);
}

/** Which zone a taxable income falls in, for the explanation next to the figure. */
export function tariffZone(taxableIncomeEuros: number, zones: TariffZones): 1 | 2 | 3 | 4 | 5 {
  const x = Math.floor(taxableIncomeEuros);
  if (x <= zones.basicAllowance) return 1;
  if (x <= zones.zone2Upper) return 2;
  if (x <= zones.zone3Upper) return 3;
  if (x <= zones.zone4Upper) return 4;
  return 5;
}
