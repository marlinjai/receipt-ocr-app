import { shareOf } from './money';
import type { AssetRules, FormLineKey } from './rules/types';

/**
 * The asset register: what an asset costs, how it is written off, and what it
 * is worth at the start and end of each year. Pure. A schedule is never
 * stored; it is computed from the asset's facts every time, so a corrected
 * cost or method changes every year that follows without anything to update.
 */

export type AssetMethod =
  /** Expensed in full in the year it is bought (net cost within the low-value limit). */
  | 'low_value'
  /** Put into the year's pool and released in equal parts over several years. */
  | 'pool'
  /** Equal amounts over the useful life, by month in the first year. */
  | 'linear'
  /** Computer hardware or software with the one-year useful life the finance ministry accepts. */
  | 'computer_one_year'
  /** A fixed percentage of the remaining value each year, switching to equal amounts when those are higher. */
  | 'declining';

export const ASSET_METHODS: readonly AssetMethod[] = ['low_value', 'pool', 'linear', 'computer_one_year', 'declining'];

export type AssetKind = 'movable' | 'intangible';

export type DisposalKind = 'sold' | 'scrapped' | 'private';

export interface AssetFact {
  id: string;
  label: string;
  kind: AssetKind;
  /** ISO day the asset was delivered or made ready. Depreciation starts here, not at payment. */
  acquisitionDate: string | null;
  /**
   * What the asset cost, shipping and customs included. Under section 19 this
   * is the gross amount. Null when a linked receipt has no usable amount.
   */
  costCents: number | null;
  /** The same cost without value-added tax, for the limits, which are net. Null when unknown. */
  netCostCents: number | null;
  method: AssetMethod;
  /** For `linear` and `declining`. */
  usefulLifeMonths: number | null;
  /** For `declining`, in basis points per year. */
  decliningRateBp: number | null;
  businessShareBp: number;
  /**
   * A reminder value the asset is never written below while it is still in
   * use (commonly one euro), in cents. 0 writes it off completely.
   */
  reminderCents: number;
  /**
   * An asset from before the app: its book value on 1 January of `year` and
   * the months of useful life left from then. Limits and methods of the
   * purchase year are not re-examined for such an asset.
   */
  opening: { year: number; bookValueCents: number; remainingMonths: number } | null;
  disposal: { date: string; kind: DisposalKind; proceedsCents: number } | null;
  /** The section 19 status on the acquisition date; see `LedgerItem.smallBusiness`. */
  smallBusiness: boolean | null;
}

export type AssetCheckKind =
  | 'asset_no_date'
  | 'asset_no_cost'
  | 'asset_small_business_unanswered'
  /** Bought under one value-added tax status, used under the other: an input tax correction may be due. */
  | 'asset_input_tax_correction_review'
  | 'asset_net_unknown'
  | 'asset_low_value_over_limit'
  | 'asset_pool_out_of_range'
  | 'asset_no_useful_life'
  | 'asset_declining_not_allowed'
  | 'asset_declining_rate_too_high'
  | 'asset_opening_method'
  | 'asset_disposal_before_acquisition';

export interface AssetCheck {
  assetId: string;
  kind: AssetCheckKind;
  /** A blocking check keeps the asset out of every total until it is resolved; a note does not. */
  blocking: boolean;
}

/** One year of an asset, before the business share is applied. */
export interface AssetYearRow {
  year: number;
  bookValueStartCents: number;
  /** The cost, in the year the asset was bought. */
  additionCents: number;
  depreciationCents: number;
  /** The value left when the asset was disposed of in this year (it leaves the register). */
  disposalBookValueCents: number;
  bookValueEndCents: number;
}

export interface AssetLinePart {
  lineKey: FormLineKey;
  cents: number;
}

const year = (isoDay: string) => Number(isoDay.slice(0, 4));
const month = (isoDay: string) => Number(isoDay.slice(5, 7));

/**
 * Is the net cost within `limit`? Decided from the net amount when it is
 * known. Otherwise from the gross amount where that is conclusive: a gross
 * amount within the limit is certainly within it, a gross amount above the
 * limit plus the highest tax rate is certainly above it. In between nobody can
 * tell without the net amount: 'unknown'.
 */
function withinNetLimit(asset: AssetFact, limitCents: number, rules: AssetRules): boolean | 'unknown' {
  if (asset.netCostCents !== null) return asset.netCostCents <= limitCents;
  const gross = asset.costCents as number;
  if (gross <= limitCents) return true;
  if (gross > limitCents + shareOf(limitCents, rules.highestVatRateBp.value)) return false;
  return 'unknown';
}

/** The checks an asset has to pass before it contributes anything. `rules` are those of its acquisition year. */
export function assetChecks(asset: AssetFact, rules: AssetRules): AssetCheck[] {
  const checks: AssetCheck[] = [];
  const add = (kind: AssetCheckKind) => checks.push({ assetId: asset.id, kind, blocking: true });

  if (asset.smallBusiness === null) add('asset_small_business_unanswered');
  // Under regular taxation the cost is the net amount, which must be known.
  if (asset.smallBusiness === false && asset.opening === null && asset.costCents !== null && asset.netCostCents === null) {
    add('asset_net_unknown');
  }
  if (asset.acquisitionDate === null && asset.opening === null) add('asset_no_date');
  if (asset.costCents === null && asset.opening === null) add('asset_no_cost');
  if (asset.disposal) {
    const start = asset.opening ? `${asset.opening.year}-01-01` : asset.acquisitionDate;
    if (start && asset.disposal.date < start) add('asset_disposal_before_acquisition');
  }

  if (asset.opening) {
    // A carried-in asset runs out its remaining life in equal amounts; the
    // one-off methods make no sense for something bought in an earlier year.
    if (asset.method !== 'linear') add('asset_opening_method');
    return checks;
  }
  if (asset.costCents === null || asset.acquisitionDate === null) return checks;

  const has = (kind: AssetCheckKind) => checks.some((c) => c.kind === kind);
  if (asset.method === 'low_value') {
    const within = withinNetLimit(asset, rules.lowValueNetLimitCents.value, rules);
    if (within === 'unknown') {
      if (!has('asset_net_unknown')) add('asset_net_unknown');
    }
    else if (!within) add('asset_low_value_over_limit');
  }
  if (asset.method === 'pool') {
    const { minExclusiveNetCents, maxNetCents } = rules.pool.value;
    const belowMax = withinNetLimit(asset, maxNetCents, rules);
    const belowMin = withinNetLimit(asset, minExclusiveNetCents, rules);
    if (belowMax === 'unknown' || belowMin === 'unknown') {
      if (!has('asset_net_unknown')) add('asset_net_unknown');
    }
    else if (!belowMax || belowMin) add('asset_pool_out_of_range');
  }
  if (asset.method === 'linear' || asset.method === 'declining') {
    // "More than one year" is what makes something an asset with a schedule.
    if (asset.usefulLifeMonths === null || !Number.isInteger(asset.usefulLifeMonths) || asset.usefulLifeMonths <= 12) {
      add('asset_no_useful_life');
    }
  }
  if (asset.method === 'declining') {
    const { acquiredFrom, acquiredTo, maxRateBp, maxMultipleOfLinear } = rules.declining.value;
    if (asset.kind !== 'movable' || asset.acquisitionDate < acquiredFrom || asset.acquisitionDate > acquiredTo) {
      add('asset_declining_not_allowed');
    } else if (asset.usefulLifeMonths !== null && asset.usefulLifeMonths > 12) {
      const linearRateBp = Math.floor((12 * 10_000) / asset.usefulLifeMonths);
      const cap = Math.min(maxRateBp, linearRateBp * maxMultipleOfLinear);
      if (asset.decliningRateBp === null || !Number.isInteger(asset.decliningRateBp) || asset.decliningRateBp <= 0) {
        add('asset_declining_rate_too_high');
      } else if (asset.decliningRateBp > cap) {
        add('asset_declining_rate_too_high');
      }
    }
  }
  return checks;
}

/** The highest declining rate the rules allow for a useful life, in basis points. */
export function maxDecliningRateBp(usefulLifeMonths: number, rules: AssetRules): number {
  const { maxRateBp, maxMultipleOfLinear } = rules.declining.value;
  return Math.min(maxRateBp, Math.floor((12 * 10_000) / usefulLifeMonths) * maxMultipleOfLinear);
}

/**
 * The schedule of an asset from its first year in the register up to and
 * including `throughYear`. Call only for an asset that passed `assetChecks`.
 *
 * Rounding: equal-amount depreciation is taken as the difference of two
 * cumulative figures (cost times months elapsed over useful life, rounded), so
 * the yearly amounts always add up to exactly the depreciable cost.
 */
export function assetSchedule(asset: AssetFact, rules: AssetRules, throughYear: number): AssetYearRow[] {
  const rows: AssetYearRow[] = [];
  const firstYear = asset.opening ? asset.opening.year : year(asset.acquisitionDate as string);
  const disposalYear = asset.disposal ? year(asset.disposal.date) : null;
  const floor = Math.max(0, asset.reminderCents);

  const cost = asset.opening ? asset.opening.bookValueCents : (asset.costCents as number);
  // Months of the first year the asset is in use: from the month of purchase on.
  const firstYearMonths = asset.opening ? 12 : 13 - month(asset.acquisitionDate as string);
  const life = asset.opening ? asset.opening.remainingMonths : asset.usefulLifeMonths ?? 0;
  const depreciable = Math.max(0, cost - floor);
  const pool = rules.pool.value;

  let value = cost;
  let monthsUsed = 0;
  let linearBase: { value: number; monthsLeft: number; taken: number; months: number } | null = null;

  for (let y = firstYear; y <= throughYear; y++) {
    const start = y === firstYear ? (asset.opening ? cost : 0) : value;
    const addition = y === firstYear && !asset.opening ? cost : 0;
    if (y === firstYear) value = cost;
    const disposedThisYear = disposalYear === y;
    // In the year of disposal the asset is written off for the full months
    // before the month it left; the rest is the remaining book value.
    const monthsThisYear = disposedThisYear
      ? Math.max(0, month((asset.disposal as NonNullable<AssetFact['disposal']>).date) - 1 - (y === firstYear ? 12 - firstYearMonths : 0))
      : y === firstYear
        ? firstYearMonths
        : 12;

    let depreciation = 0;
    switch (asset.method) {
      case 'low_value':
      case 'computer_one_year':
        // The whole cost in the first year; a disposal later finds nothing left.
        depreciation = y === firstYear ? value - Math.min(value, asset.method === 'computer_one_year' ? floor : 0) : 0;
        break;
      case 'pool': {
        // Released in equal parts whatever happens to the asset: a pooled
        // asset that is sold or scrapped stays in the pool.
        const k = y - firstYear + 1;
        const cum = (n: number) => Math.round((cost * Math.min(n, pool.years)) / pool.years);
        depreciation = cum(k) - cum(k - 1);
        break;
      }
      case 'linear': {
        if (life > 0) {
          const before = Math.min(monthsUsed, life);
          const after = Math.min(monthsUsed + monthsThisYear, life);
          depreciation = Math.round((depreciable * after) / life) - Math.round((depreciable * before) / life);
        }
        monthsUsed += monthsThisYear;
        break;
      }
      case 'declining': {
        const monthsLeft = Math.max(0, life - monthsUsed);
        const room = Math.max(0, value - floor);
        if (linearBase === null) {
          const declining = Math.round((value * (asset.decliningRateBp ?? 0) * monthsThisYear) / (10_000 * 12));
          const linear = monthsLeft > 0 ? Math.round((room * Math.min(monthsThisYear, monthsLeft)) / monthsLeft) : room;
          // The switch to equal amounts, once made, is kept for the rest of the life.
          if (linear >= declining && monthsThisYear > 0) linearBase = { value: room, monthsLeft, taken: 0, months: 0 };
          else depreciation = Math.min(room, declining);
        }
        if (linearBase !== null) {
          const b = linearBase;
          const after = Math.min(b.months + monthsThisYear, b.monthsLeft);
          const cumAfter = b.monthsLeft > 0 ? Math.round((b.value * after) / b.monthsLeft) : b.value;
          depreciation = cumAfter - b.taken;
          b.taken = cumAfter;
          b.months = after;
        }
        monthsUsed += monthsThisYear;
        break;
      }
    }

    const afterDepreciation = asset.method === 'pool' ? start + addition - depreciation : value - depreciation;
    let disposalBookValue = 0;
    let end = afterDepreciation;
    if (disposedThisYear && asset.method !== 'pool') {
      disposalBookValue = afterDepreciation;
      end = 0;
    }
    rows.push({
      year: y,
      bookValueStartCents: start,
      additionCents: addition,
      depreciationCents: depreciation,
      disposalBookValueCents: disposalBookValue,
      bookValueEndCents: end,
    });
    value = end;
    // Nothing happens after an asset has left the register (the pool keeps releasing).
    if (disposedThisYear && asset.method !== 'pool') break;
  }
  return rows;
}

function depreciationLine(asset: AssetFact): FormLineKey {
  if (asset.method === 'low_value') return 'euer.low_value_assets';
  if (asset.method === 'pool') return 'euer.pool_release';
  return asset.kind === 'intangible' ? 'euer.depreciation_intangible' : 'euer.depreciation_movable';
}

/**
 * What an asset contributes to the statement in one year: its depreciation,
 * the remaining book value when it left, and what was received for it, each
 * at the business share.
 */
export function assetYearParts(asset: AssetFact, row: AssetYearRow): AssetLinePart[] {
  const parts: AssetLinePart[] = [];
  const share = (cents: number) => shareOf(cents, asset.businessShareBp);
  if (row.depreciationCents > 0) parts.push({ lineKey: depreciationLine(asset), cents: share(row.depreciationCents) });
  if (row.disposalBookValueCents > 0) {
    parts.push({ lineKey: 'euer.remaining_book_value', cents: share(row.disposalBookValueCents) });
  }
  if (asset.disposal && year(asset.disposal.date) === row.year && asset.disposal.proceedsCents > 0) {
    parts.push({ lineKey: 'euer.asset_disposal', cents: share(asset.disposal.proceedsCents) });
  }
  return parts.filter((p) => p.cents !== 0);
}
