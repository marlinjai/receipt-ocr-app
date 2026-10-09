import type { ConsumptionKey, MealTypeKey } from '@/lib/receipts-constants';
import { CONSUMPTION_TYPES, MEAL_TYPES } from '@/lib/receipts-constants';
import { sanitizeTaxLines } from './rules';
import type { MealRecord, TaxLine } from './types';

/**
 * What the meal form saves. Saving is allowed at any degree of completeness
 * (that is what makes the flow resumable); completeness is judged by
 * `mealStatus`, not by the save.
 */
export interface MealDetailsInput {
  mealType: MealTypeKey | null;
  occasion: string;
  place: string;
  host: string;
  tip: number | null;
  consumption: ConsumptionKey | null;
  taxLines: TaxLine[] | null;
  /** Contact ids in the order the guests are printed. */
  guestContactIds: string[];
  /** `YYYY-MM-DD`, for receipts where the date was not read. */
  date: string | null;
  /** Receipt total without tip, for receipts where the amount was not read. */
  gross: number | null;
}

export type MealInputErrorCode =
  | 'invalid_meal_type'
  | 'invalid_consumption'
  | 'invalid_tip'
  | 'invalid_gross'
  | 'invalid_date'
  | 'text_too_long'
  | 'too_many_guests';

export class MealInputError extends Error {
  readonly code: MealInputErrorCode;
  constructor(code: MealInputErrorCode) {
    super(code);
    this.name = 'MealInputError';
    this.code = code;
  }
}

export const MEAL_TEXT_MAX = 500;
export const MEAL_GUESTS_MAX = 50;

function cleanText(value: unknown): string {
  const text = String(value ?? '').replace(/[ \t]+/g, ' ').trim();
  if (text.length > MEAL_TEXT_MAX) throw new MealInputError('text_too_long');
  return text;
}

function isRealIsoDay(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

/** Validate and normalize untrusted form input. Throws MealInputError. */
export function normalizeMealInput(raw: MealDetailsInput): MealDetailsInput {
  const mealType = raw.mealType ?? null;
  if (mealType !== null && !MEAL_TYPES.some((t) => t.key === mealType)) {
    throw new MealInputError('invalid_meal_type');
  }
  const consumption = raw.consumption ?? null;
  if (consumption !== null && !CONSUMPTION_TYPES.some((t) => t.key === consumption)) {
    throw new MealInputError('invalid_consumption');
  }

  let tip: number | null = null;
  if (raw.tip !== null && raw.tip !== undefined) {
    if (typeof raw.tip !== 'number' || !Number.isFinite(raw.tip) || raw.tip < 0 || raw.tip > 100_000) {
      throw new MealInputError('invalid_tip');
    }
    // A tip of zero is "no tip entered".
    tip = raw.tip === 0 ? null : Math.round(raw.tip * 100) / 100;
  }

  let gross: number | null = null;
  if (raw.gross !== null && raw.gross !== undefined) {
    if (typeof raw.gross !== 'number' || !Number.isFinite(raw.gross) || raw.gross <= 0 || raw.gross > 1_000_000) {
      throw new MealInputError('invalid_gross');
    }
    gross = Math.round(raw.gross * 100) / 100;
  }

  let date: string | null = null;
  if (raw.date) {
    if (typeof raw.date !== 'string' || !isRealIsoDay(raw.date)) throw new MealInputError('invalid_date');
    date = raw.date;
  }

  const guestContactIds = [...new Set((raw.guestContactIds ?? []).map(String).filter(Boolean))];
  if (guestContactIds.length > MEAL_GUESTS_MAX) throw new MealInputError('too_many_guests');

  return {
    mealType,
    occasion: cleanText(raw.occasion),
    place: cleanText(raw.place),
    host: cleanText(raw.host),
    tip,
    consumption,
    taxLines: sanitizeTaxLines(raw.taxLines),
    guestContactIds,
    date,
    gross,
  };
}

/** The input that would reproduce a record exactly as it is stored. */
export function inputFromRecord(record: MealRecord): MealDetailsInput {
  return {
    mealType: record.mealType,
    occasion: record.occasion.replace(/[ \t]+/g, ' ').trim(),
    place: record.place.replace(/[ \t]+/g, ' ').trim(),
    host: record.host.replace(/[ \t]+/g, ' ').trim(),
    tip: record.tip && record.tip > 0 ? Math.round(record.tip * 100) / 100 : null,
    consumption: record.consumption,
    taxLines: sanitizeTaxLines(record.taxLines),
    guestContactIds: record.guests.flatMap((g) => (g.contactId ? [g.contactId] : [])),
    date: record.date,
    gross: record.gross !== null && record.gross > 0 ? Math.round(record.gross * 100) / 100 : null,
  };
}

/** Structural equality of two normalized inputs (guest ORDER counts: it is the printed order). */
export function sameMealInput(a: MealDetailsInput, b: MealDetailsInput): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
