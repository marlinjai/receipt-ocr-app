import { extractReceiptFields } from '@/lib/extract-receipt-fields';
import { CATEGORY_TO_KONTO, MEAL_CATEGORY } from '@/lib/receipts-constants';

/**
 * A new reading of a receipt that is already stored.
 *
 * Receipts read before the reader was rebuilt keep what the old reader made
 * of them: a total that includes the tip, a slogan as the vendor, a tax
 * amount as the net. The recognized text is stored with each receipt, so the
 * current reader can read it again, at no cost and with the same result every
 * time (no language model is asked).
 *
 * This module only COMPARES. What differs is offered to a person as "stored /
 * new", field by field, and nothing is written until they take it. A value a
 * person typed in by hand is therefore never overwritten behind their back,
 * and a receipt they have confirmed is left alone.
 */

export type ReadingField = 'name' | 'vendor' | 'gross' | 'net' | 'taxRate' | 'tip' | 'category';

export interface ReadingChange {
  field: ReadingField;
  /** As stored now; null when empty. */
  from: string | number | null;
  /** What the current reader reads from the stored text. Never null: an empty reading is not a proposal. */
  to: string | number;
}

/** The stored receipt, as far as a new reading can touch it. */
export interface StoredReading {
  /** The receipt's name. Only a name the old reader built itself is ever offered a replacement. */
  name: string;
  vendor: string;
  gross: number | null;
  net: number | null;
  taxRate: number | null;
  /** Null for a receipt that is not a meal: the tip column belongs to the meal register. */
  tip: number | null;
  category: string | null;
  /** The recognized text stored with the receipt. */
  text: string;
}

const sameAmount = (a: number | null, b: number | null) => a !== null && b !== null && Math.abs(a - b) < 0.005;
const sameName = (a: string, b: string) =>
  a.toLocaleLowerCase('de-DE').replace(/[^\p{L}\p{N}]+/gu, '') === b.toLocaleLowerCase('de-DE').replace(/[^\p{L}\p{N}]+/gu, '');

export interface NewReading {
  changes: ReadingChange[];
  /** The tax groups the receipt prints, for the meal register, when the amounts are confirmed. */
  taxLines: Array<{ rate: number; net: number; tax: number }>;
}

/**
 * What the current reader would read differently. No changes when the stored
 * receipt agrees with it, when there is no stored text, or when the reader
 * itself is not sure (a total it could not confirm is never proposed over a
 * stored one).
 */
export function newReading(stored: StoredReading): NewReading {
  if (!stored.text.trim()) return { changes: [], taxLines: [] };
  const read = extractReceiptFields({ fullText: stored.text, blocks: [], confidence: 1 });
  const changes: ReadingChange[] = [];

  // Vendor: only a name the reader stands behind, and only when it really is another name.
  if (read.vendor && read.vendorConfidence === 'confirmed' && !sameName(read.vendor, stored.vendor)) {
    changes.push({ field: 'vendor', from: stored.vendor || null, to: read.vendor });
  }

  // Amounts: only what the receipt's own arithmetic confirms.
  const confirmed = read.gross !== null && read.taxRatePrinted && read.amountChecks.length === 0;
  if (confirmed) {
    if (!sameAmount(read.gross, stored.gross)) changes.push({ field: 'gross', from: stored.gross, to: read.gross! });
    if (read.net !== null && !sameAmount(read.net, stored.net)) changes.push({ field: 'net', from: stored.net, to: read.net });
    if (stored.taxRate === null || Math.abs(read.taxRate! - stored.taxRate) > 0.05) changes.push({ field: 'taxRate', from: stored.taxRate, to: read.taxRate! });
  }

  // Category: only towards "meal", and only on the text's own strong evidence.
  const becomesMeal = read.mealEvidence.strong && stored.category !== MEAL_CATEGORY;
  if (becomesMeal) changes.push({ field: 'category', from: stored.category, to: MEAL_CATEGORY });

  // A printed tip, for a receipt that is (or is about to be) a meal.
  const isMeal = stored.category === MEAL_CATEGORY || becomesMeal;
  if (confirmed && isMeal && read.tip !== null && !sameAmount(read.tip, stored.tip)) {
    changes.push({ field: 'tip', from: stored.tip, to: read.tip });
  }
  // The old reader built names as "vendor \u2013 items \u2013 total \u2013 date". Such a name repeats
  // the wrong vendor or total, so it is offered anew together with them. A name a
  // person typed (no such separators) is never offered a replacement.
  const builtByOldReader = stored.name.includes(' \u2013 ');
  if (builtByOldReader && changes.some((c) => c.field === 'vendor' || c.field === 'gross') && read.name && read.name !== stored.name) {
    changes.unshift({ field: 'name', from: stored.name, to: read.name });
  }
  return { changes, taxLines: confirmed ? read.taxGroups.map((g) => ({ rate: g.rate, net: g.net, tax: g.tax })) : [] };
}

/** The changes alone. */
export function proposeReading(stored: StoredReading): ReadingChange[] {
  return newReading(stored).changes;
}

/** The account that goes with a category (kept next to the reading so an applied category brings its account). */
export function kontoFor(category: string): string | null {
  return CATEGORY_TO_KONTO[category] ?? null;
}
