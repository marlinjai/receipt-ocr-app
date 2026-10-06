import type { ConsumptionKey, MealTypeKey } from '@/lib/receipts-constants';

/** One tax line as printed on a receipt: the rate and the net and tax amount at that rate. */
export interface TaxLine {
  /** Percent, e.g. 7 or 19. */
  rate: number;
  net: number;
  tax: number;
}

/** A guest as it is printed on the register. */
export interface MealGuestEntry {
  contactId: string;
  name: string;
  /** Company or role; empty string when unknown. */
  company: string;
}

export interface MealFile {
  fileId: string;
  fileUrl: string;
  mimeType: string;
  originalName: string;
}

/**
 * A receipt row reduced to the facts the meal rules need, with select options
 * already resolved to their NAMES. Every surface (form, queue, register, both
 * exports) builds this through `rowToMealRecord` and then calls the pure
 * functions in `rules.ts`, so the rules exist exactly once.
 */
export interface MealRecord {
  rowId: string;
  name: string | null;
  vendor: string | null;
  /** ISO day, `YYYY-MM-DD`. */
  date: string | null;
  category: string | null;
  zuordnung: string | null;
  mealType: MealTypeKey | null;
  /** Receipt total in the receipt currency, without the tip. */
  gross: number | null;
  net: number | null;
  taxRate: number | null;
  currency: string;
  /** Receipt currency to euro. 1 for euro receipts, null when the lookup failed. */
  fxRate: number | null;
  occasion: string;
  place: string;
  host: string;
  tip: number | null;
  consumption: ConsumptionKey | null;
  /** Null when no tax lines are recorded for the receipt. */
  taxLines: TaxLine[] | null;
  /** ISO timestamp of the last time the meal details were saved. */
  detailsAt: string | null;
  confidence: number | null;
  guests: MealGuestEntry[];
  files: MealFile[];
}

/** The per-workspace tax facts (see the WorkspaceTaxSettings model). */
export interface MealTaxSettings {
  /** null = the section 19 question has not been answered yet. */
  smallBusiness: boolean | null;
  hostAddressThresholdEur: number;
}

export const DEFAULT_TAX_SETTINGS: MealTaxSettings = {
  smallBusiness: null,
  hostAddressThresholdEur: 250,
};
