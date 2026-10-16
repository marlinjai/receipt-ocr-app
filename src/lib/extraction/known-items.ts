/**
 * What was bought, worded once per vendor.
 *
 * The model words the item afresh on every receipt, so the monthly invoices
 * of one subscription read "PocketTube Abo" one month and
 * "PocketTube-Mitgliedschaft" the next. The automatic groups key on vendor,
 * item and year, so one subscription then falls into two groups. The model is
 * therefore given the items the vendor's earlier receipts already carry, and
 * an answer that is one of them in other words takes the stored wording.
 *
 * Pure: no database, no network.
 */

import { sameVendor } from '@/lib/extraction/vendor';

/** How many earlier wordings the model is shown: the most used ones. */
export const KNOWN_ITEMS_LIMIT = 12;

/**
 * Words that say the purchase is a subscription without saying what it is
 * of. "PocketTube Abo" and "PocketTube-Mitgliedschaft" are the same item.
 */
const SUBSCRIPTION_WORDS = new Set([
  'abo',
  'abos',
  'abonnement',
  'monatsabo',
  'jahresabo',
  'mitgliedschaft',
  'membership',
  'subscription',
  'monatlich',
  'jährlich',
  'monthly',
  'yearly',
  'annual',
]);

/** An item reduced to what tells it from another: lower case, letters and digits, no subscription word. */
export function itemKey(item: string): string {
  const words = item
    .toLocaleLowerCase('de-DE')
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w !== '' && !SUBSCRIPTION_WORDS.has(w));
  return words.join('');
}

/**
 * The stored wording of the model's item where it is one of the known ones in
 * other words, else the model's item as it is. Of several known wordings with
 * the same key, the first (the most used, see `rankItems`) wins.
 */
export function pickKnownItem(modelItem: string | null, known: readonly string[]): string | null {
  if (!modelItem) return modelItem;
  const key = itemKey(modelItem);
  if (!key) return modelItem;
  return known.find((k) => itemKey(k) === key) ?? modelItem;
}

/** One stored receipt, as far as its vendor and item go. */
export interface StoredItem {
  vendor: string | null;
  item: string | null;
}

/**
 * The items the receipts of one vendor carry, the most used first (ties in
 * the order first seen), each wording once, at most `KNOWN_ITEMS_LIMIT`. A
 * receipt counts where its vendor is the same vendor written in any way
 * (`sameVendor`: with or without the legal form).
 */
export function rankItems(vendor: string | null, stored: readonly StoredItem[]): string[] {
  if (!vendor?.trim()) return [];
  const counts = new Map<string, number>();
  for (const row of stored) {
    const item = row.item?.trim();
    if (!item || !row.vendor || !sameVendor(row.vendor, vendor)) continue;
    counts.set(item, (counts.get(item) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([item, count], order) => ({ item, count, order }))
    .sort((a, b) => b.count - a.count || a.order - b.order)
    .map((e) => e.item)
    .slice(0, KNOWN_ITEMS_LIMIT);
}

/**
 * The word a vendor's receipts are first looked up by in the database: the
 * longest word of its name without the legal form, at least three letters.
 * The exact test is `sameVendor` afterwards. Null when there is none.
 */
export function vendorSearchWord(vendor: string | null): string | null {
  if (!vendor) return null;
  const words = vendor
    .replace(/\b(?:gmbh|ug|ag|kg|ohg|gbr|ltd|limited|inc|llc|corp|co)\b\.?/giu, ' ')
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length >= 3);
  if (words.length === 0) return null;
  return words.reduce((a, b) => (b.length > a.length ? b : a));
}
