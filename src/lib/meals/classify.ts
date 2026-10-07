import {
  CONSUMPTION_TYPES,
  MEAL_CATEGORY,
  MEAL_TYPES,
  type ConsumptionKey,
  type MealTypeKey,
} from '@/lib/receipts-constants';
import { estimatedVatRate, sanitizeTaxLines } from './rules';
import type { TaxLine } from './types';

/**
 * What the classifier may say about a meal, and the fallbacks when it says
 * nothing. Only facts that can be READ from a receipt are in here (kind of
 * meal, eaten in or taken away, a printed tip, the tax lines, the address).
 * Guests, occasion and host are never guessed: they are asked.
 */

export interface MealClassification {
  mealType: MealTypeKey | null;
  consumption: ConsumptionKey | null;
  /** A tip printed or written on the receipt, in the receipt currency. */
  tip: number | null;
  taxLines: TaxLine[] | null;
  /** Restaurant name and address as one line. */
  place: string | null;
}

export const EMPTY_MEAL_CLASSIFICATION: MealClassification = {
  mealType: null,
  consumption: null,
  tip: null,
  taxLines: null,
  place: null,
};

/** Validate the meal part of a classifier answer. Anything malformed reads as "not said". */
export function parseMealClassification(raw: unknown): MealClassification {
  if (!raw || typeof raw !== 'object') return { ...EMPTY_MEAL_CLASSIFICATION };
  const r = raw as Record<string, unknown>;
  const mealType = MEAL_TYPES.find((t) => t.key === r.mealType)?.key ?? null;
  const consumption = CONSUMPTION_TYPES.find((t) => t.key === r.consumption)?.key ?? null;
  const tip =
    typeof r.tip === 'number' && Number.isFinite(r.tip) && r.tip > 0 && r.tip < 100_000
      ? Math.round(r.tip * 100) / 100
      : null;
  const place = typeof r.place === 'string' && r.place.trim() ? r.place.replace(/\s+/g, ' ').trim().slice(0, 300) : null;
  return { mealType, consumption, tip, taxLines: sanitizeTaxLines(r.taxLines), place };
}

const AMOUNT = String.raw`(\d{1,4}(?:[.,]\d{2}))`;
const TIP_LINE = new RegExp(String.raw`(?:trinkgeld|tip|gratuity|service\s*charge)\s*[:=]?\s*(?:€|eur)?\s*${AMOUNT}`, 'i');

/** A tip printed on the receipt ("Trinkgeld 5,00"), when the classifier did not report one. */
export function extractTipFromText(text: string): number | null {
  for (const line of text.split('\n')) {
    // "Tip is not included" and the like carry no amount to take.
    if (/nicht\s+enthalten|not\s+included|inkl|incl/i.test(line)) continue;
    const match = TIP_LINE.exec(line);
    if (!match) continue;
    const value = Number(match[1].replace(',', '.'));
    if (Number.isFinite(value) && value > 0) return value;
  }
  return null;
}

/** The meal facts to store for a receipt filed as a business meal. */
export function mealFactsFromClassification(
  classified: { meal?: MealClassification | null } | null | undefined,
  fullText: string,
): MealClassification {
  const meal = classified?.meal ?? EMPTY_MEAL_CLASSIFICATION;
  return {
    ...meal,
    tip: meal.tip ?? extractTipFromText(fullText),
  };
}

/**
 * The tax rate to assume when a receipt shows none. For a meal it depends on
 * the receipt date and on eating in or taking away (see `estimatedVatRate`);
 * books are 7 percent; everything else is the standard 19.
 */
export function defaultTaxRate(
  category: string | null,
  date: string | null,
  consumption: ConsumptionKey | null,
): number {
  if (category === MEAL_CATEGORY) return estimatedVatRate(date ? date.slice(0, 10) : null, consumption);
  if (category === 'Fachliteratur') return 7;
  return 19;
}
