import { MEAL_CATEGORY, PRIVATE_ZUORDNUNG } from '@/lib/receipts-constants';
import type { ConsumptionKey } from '@/lib/receipts-constants';
import type { MealRecord, MealTaxSettings, TaxLine } from './types';

/**
 * The rules of the business-meal register, in one place.
 *
 * Section 4 paragraph 5 number 2 of the German income tax act allows 70 percent
 * of a business meal as an expense only when date, place, the persons hosted,
 * the occasion and the amount are recorded. Whether a row is a register entry,
 * whether it is complete, and what is deductible are all DERIVED here from the
 * row's current facts and never stored, so they cannot go stale when a
 * category, a guest or an amount changes.
 */

export const DEDUCTIBLE_SHARE = 0.7;

/** From this receipt date on, restaurant and catering food is taxed at 7 percent. */
export const REDUCED_RESTAURANT_RATE_FROM = '2026-01-01';

export type MissingField =
  | 'mealType'
  | 'date'
  | 'place'
  | 'gross'
  | 'fxRate'
  | 'occasion'
  | 'occasionTooGeneric'
  | 'host'
  | 'guests';

export type ExclusionReason = 'private' | 'staff_meal_internal' | 'travel_meal';

export type MealStatus =
  | { kind: 'not_a_meal' }
  | { kind: 'excluded'; reason: ExclusionReason }
  | { kind: 'incomplete'; missing: MissingField[] }
  | { kind: 'complete' };

/** Occasions that say nothing about the business reason. Compared after normalizing. */
const GENERIC_OCCASIONS = new Set([
  'geschaeftsessen',
  'geschaeftstermin',
  'geschaeftlich',
  'arbeitsessen',
  'bewirtung',
  'besprechung',
  'meeting',
  'termin',
  'kundentermin',
  'kundengespraech',
  'essen',
  'mittagessen',
  'abendessen',
  'lunch',
  'dinner',
  'business lunch',
  'business dinner',
  'business meal',
  'businesslunch',
]);

function normalizeOccasion(text: string): string {
  return text
    .toLowerCase()
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/ß/g, 'ss')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 'empty', 'generic' (names no topic) or 'ok'. */
export function occasionQuality(text: string | null | undefined): 'empty' | 'generic' | 'ok' {
  const normalized = normalizeOccasion(text ?? '');
  if (!normalized) return 'empty';
  if (GENERIC_OCCASIONS.has(normalized)) return 'generic';
  return 'ok';
}

function isPositive(n: number | null | undefined): n is number {
  return typeof n === 'number' && Number.isFinite(n) && n > 0;
}

/**
 * Where a row stands with respect to the register.
 *
 * - `not_a_meal`: not category "Bewirtung", or explicitly marked "Keine Bewirtung".
 * - `excluded`: a meal, but not one for the 70 percent register (private, a
 *   staff meal, a meal on a trip). Recorded and counted separately.
 * - `incomplete`: would be a register entry, but facts are missing. A
 *   "Bewirtung" row without a meal type is incomplete too: that is what puts
 *   the receipts from before this feature into the queue.
 * - `complete`: a register entry with everything the law asks for.
 */
export function mealStatus(record: MealRecord): MealStatus {
  if (record.category !== MEAL_CATEGORY) return { kind: 'not_a_meal' };
  if (record.mealType === 'not_a_meal') return { kind: 'not_a_meal' };
  if (record.zuordnung === PRIVATE_ZUORDNUNG) return { kind: 'excluded', reason: 'private' };
  if (record.mealType === 'staff_meal_internal' || record.mealType === 'travel_meal') {
    return { kind: 'excluded', reason: record.mealType };
  }

  const missing: MissingField[] = [];
  if (record.mealType === null) missing.push('mealType');
  if (!record.date) missing.push('date');
  if (!record.place.trim()) missing.push('place');
  if (!isPositive(record.gross)) missing.push('gross');
  if (record.currency !== 'EUR' && !isPositive(record.fxRate)) missing.push('fxRate');
  const occasion = occasionQuality(record.occasion);
  if (occasion === 'empty') missing.push('occasion');
  if (occasion === 'generic') missing.push('occasionTooGeneric');
  if (!record.host.trim()) missing.push('host');
  // The host does not count as a guest: a meal eaten alone is not a business meal.
  if (record.guests.length === 0) missing.push('guests');

  return missing.length === 0 ? { kind: 'complete' } : { kind: 'incomplete', missing };
}

/** True when the row belongs on the register page at all (queue, register or the separate count). */
export function isMealRelated(record: MealRecord): boolean {
  return mealStatus(record).kind !== 'not_a_meal';
}

/**
 * True for a "Bewirtung" receipt that was explicitly marked "Keine Bewirtung".
 * It is out of the queue and the register, its details stay stored, and the
 * meals page lists it so it can be taken back.
 */
export function isDismissedMeal(record: MealRecord): boolean {
  return record.category === MEAL_CATEGORY && record.mealType === 'not_a_meal';
}

// ── Money ───────────────────────────────────────────────────────────────────

/** Round half away from zero to whole cents. */
export function toCents(amount: number): number {
  return Math.sign(amount) * Math.round(Math.abs(amount) * 100 + 1e-7);
}

export function fromCents(cents: number): number {
  return cents / 100;
}

/**
 * The rate used when a receipt has no recorded tax lines. Until 31 December
 * 2025 food eaten in a restaurant is taxed at 19 percent (takeaway at 7); from
 * 1 January 2026 restaurant food is 7 percent while drinks stay at 19. Without
 * tax lines the food and drink split is unknown, so this is an ESTIMATE and
 * every amount derived from it is flagged as such.
 */
export function estimatedVatRate(date: string | null, consumption: ConsumptionKey | null): number {
  if (date && date >= REDUCED_RESTAURANT_RATE_FROM) return 7;
  return consumption === 'takeaway' ? 7 : 19;
}

/** Keep only well-formed lines; null when nothing usable remains. */
export function sanitizeTaxLines(lines: unknown): TaxLine[] | null {
  if (!Array.isArray(lines)) return null;
  const out: TaxLine[] = [];
  for (const line of lines) {
    if (!line || typeof line !== 'object') continue;
    const { rate, net, tax } = line as Record<string, unknown>;
    if (
      typeof rate === 'number' && Number.isFinite(rate) && rate >= 0 && rate <= 100 &&
      typeof net === 'number' && Number.isFinite(net) && net >= 0 &&
      typeof tax === 'number' && Number.isFinite(tax) && tax >= 0
    ) {
      out.push({ rate, net, tax });
    }
  }
  return out.length > 0 ? out : null;
}

/** Parse the Tax Lines cell (a JSON string). Anything malformed reads as "no tax lines". */
export function parseTaxLines(cell: unknown): TaxLine[] | null {
  if (typeof cell !== 'string' || !cell.trim()) return null;
  try {
    return sanitizeTaxLines(JSON.parse(cell));
  } catch {
    return null;
  }
}

export function serializeTaxLines(lines: TaxLine[] | null): string {
  const clean = sanitizeTaxLines(lines);
  return clean ? JSON.stringify(clean) : '';
}

export interface VatSplit {
  /** Net and tax in cents of the receipt currency. */
  netCents: number;
  taxCents: number;
  /** True when the split comes from the date-based default, not from the receipt. */
  estimated: boolean;
  /** True when recorded tax lines do not add up to the receipt total (more than 2 cents off). */
  linesMismatch: boolean;
  lines: TaxLine[];
}

/** Split the receipt total into net and tax: from the receipt's own tax lines, else estimated. */
export function vatSplit(record: Pick<MealRecord, 'gross' | 'taxLines' | 'date' | 'consumption'>): VatSplit {
  const grossCents = toCents(record.gross ?? 0);
  const lines = sanitizeTaxLines(record.taxLines);
  if (lines) {
    const netCents = lines.reduce((sum, l) => sum + toCents(l.net), 0);
    const taxCents = lines.reduce((sum, l) => sum + toCents(l.tax), 0);
    return {
      netCents,
      taxCents,
      estimated: false,
      linesMismatch: Math.abs(netCents + taxCents - grossCents) > 2,
      lines,
    };
  }
  const rate = estimatedVatRate(record.date, record.consumption);
  const netCents = Math.round(grossCents / (1 + rate / 100));
  const taxCents = grossCents - netCents;
  return {
    netCents,
    taxCents,
    estimated: true,
    linesMismatch: false,
    lines: [{ rate, net: fromCents(netCents), tax: fromCents(taxCents) }],
  };
}

export type MealDeduction =
  /** The section 19 question is unanswered: no base can be chosen, nothing is shown. */
  | { kind: 'setting_missing' }
  /** No usable amount (no total, or a foreign-currency receipt without an exchange rate). */
  | { kind: 'no_amount' }
  | {
      kind: 'ok';
      /** 'gross' for a small business under section 19, else 'net'. */
      basis: 'gross' | 'net';
      /** All amounts in euro. */
      gross: number;
      tip: number;
      /** Null on the gross basis, where net and input tax play no role. */
      net: number | null;
      inputVat: number | null;
      base: number;
      deductible: number;
      nonDeductible: number;
      vatEstimated: boolean;
      vatLinesMismatch: boolean;
    };

/**
 * The deductible amount of one meal.
 *
 * Small business under section 19 (no input tax deduction): base = gross + tip.
 * Otherwise: base = net + tip, and the input tax is listed in full beside it
 * (it stays fully deductible; the 70 percent limit applies to the expense).
 * The tip carries no tax and counts only when entered. Foreign-currency
 * receipts are converted with the row's exchange rate. The Business Share
 * column is deliberately not applied on top.
 */
/**
 * The section 19 status on a day: the first answer, replaced by the latest
 * change that starts on or before that day. A receipt without a date is judged
 * by the first answer. null while the question is unanswered.
 */
export function smallBusinessOn(settings: MealTaxSettings, isoDay: string | null): boolean | null {
  if (settings.smallBusiness === null) return null;
  let status = settings.smallBusiness;
  let from = '';
  for (const change of settings.statusChanges ?? []) {
    if (isoDay !== null && change.effectiveFrom <= isoDay && change.effectiveFrom >= from) {
      status = change.smallBusiness;
      from = change.effectiveFrom;
    }
  }
  return status;
}

export function mealDeduction(record: MealRecord, settings: MealTaxSettings): MealDeduction {
  const smallBusiness = smallBusinessOn(settings, record.date);
  if (smallBusiness === null) return { kind: 'setting_missing' };
  if (!isPositive(record.gross)) return { kind: 'no_amount' };
  const fx = record.currency === 'EUR' ? 1 : record.fxRate;
  if (!isPositive(fx)) return { kind: 'no_amount' };

  const toEurCents = (cents: number) => Math.round(cents * fx);
  const grossCents = toEurCents(toCents(record.gross));
  const tipCents = isPositive(record.tip) ? toEurCents(toCents(record.tip)) : 0;

  if (smallBusiness) {
    const baseCents = grossCents + tipCents;
    const deductibleCents = Math.round(baseCents * DEDUCTIBLE_SHARE);
    return {
      kind: 'ok',
      basis: 'gross',
      gross: fromCents(grossCents),
      tip: fromCents(tipCents),
      net: null,
      inputVat: null,
      base: fromCents(baseCents),
      deductible: fromCents(deductibleCents),
      nonDeductible: fromCents(baseCents - deductibleCents),
      vatEstimated: false,
      vatLinesMismatch: false,
    };
  }

  const split = vatSplit(record);
  const netCents = toEurCents(split.netCents);
  const taxCents = toEurCents(split.taxCents);
  const baseCents = netCents + tipCents;
  const deductibleCents = Math.round(baseCents * DEDUCTIBLE_SHARE);
  return {
    kind: 'ok',
    basis: 'net',
    gross: fromCents(grossCents),
    tip: fromCents(tipCents),
    net: fromCents(netCents),
    inputVat: fromCents(taxCents),
    base: fromCents(baseCents),
    deductible: fromCents(deductibleCents),
    nonDeductible: fromCents(baseCents - deductibleCents),
    vatEstimated: split.estimated,
    vatLinesMismatch: split.linesMismatch,
  };
}

/** Whether the receipt must name the host (total above the configured threshold). */
export function hostMustBeNamedOnReceipt(record: MealRecord, settings: MealTaxSettings): boolean {
  if (!isPositive(record.gross)) return false;
  const fx = record.currency === 'EUR' ? 1 : record.fxRate;
  if (!isPositive(fx)) return false;
  return record.gross * fx > settings.hostAddressThresholdEur;
}

/** Human wording for a missing field, in the app's language for this feature (German). */
export const MISSING_FIELD_LABELS: Record<MissingField, string> = {
  mealType: 'Art der Bewirtung',
  date: 'Datum',
  place: 'Ort',
  gross: 'Rechnungsbetrag',
  fxRate: 'Wechselkurs',
  occasion: 'Anlass',
  occasionTooGeneric: 'Anlass (zu allgemein)',
  host: 'Gastgeber',
  guests: 'Teilnehmer',
};
