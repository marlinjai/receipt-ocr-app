import type { ConsumptionKey, MealTypeKey } from '@/lib/receipts-constants';
import type { Rotation } from './viewer-state';

/** One tax line as printed on a receipt: the rate and the net and tax amount at that rate. */
export interface TaxLine {
  /** Percent, e.g. 7 or 19. */
  rate: number;
  net: number;
  tax: number;
}

/** A guest as it is printed on the register. */
export interface MealGuestEntry {
  /** Null for a held printed copy whose contact was erased. */
  contactId: string | null;
  name: string;
  /** Company or role; empty string when unknown. */
  company: string;
}

export interface MealFile {
  /** Id of the file REFERENCE (the link between this row and the stored file); view settings hang on it. */
  refId: string;
  fileId: string;
  fileUrl: string;
  mimeType: string;
  originalName: string;
  /**
   * How far the receipt is turned for viewing and printing, clockwise. Null
   * when nothing was chosen yet. View metadata only: the stored file is never
   * rewritten.
   */
  rotation: Rotation | null;
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
  /**
   * Name and postal address of the place as read from the receipt's
   * recognized text, when a street and a postal code with town were found
   * there. Offered for the place field; never stored by itself.
   */
  placeSuggestion: string | null;
}

/** The per-workspace tax facts (see the WorkspaceTaxSettings model). */
/** A change of the section 19 status from a day on (ISO day). Earlier days keep what applied before. */
export interface TaxStatusChange {
  effectiveFrom: string;
  smallBusiness: boolean;
}

export interface MealTaxSettings {
  /** The first answer, valid from the beginning. null = the section 19 question has not been answered yet. */
  smallBusiness: boolean | null;
  /**
   * Later changes of the status, each from a day on (crossing a limit, or
   * choosing regular taxation). A receipt is judged by the status on its own
   * date, so earlier receipts keep their basis when the status changes.
   */
  statusChanges?: TaxStatusChange[];
  hostAddressThresholdEur: number;
}

export const DEFAULT_TAX_SETTINGS: MealTaxSettings = {
  smallBusiness: null,
  hostAddressThresholdEur: 250,
};
