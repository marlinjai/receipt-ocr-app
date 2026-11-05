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

/** The legal forms a vendor's name may carry or leave out. */
const LEGAL_FORM_WORDS = /\b(?:gmbh|ug|ag|kg|ohg|gbr|ltd|limited|inc|llc|corp|co|pbc|plc)\b\.?/giu;

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

/**
 * Small words that join the parts of an item without telling it from
 * another: "iCloud+ mit 2 TB" and "iCloud+ 2 TB" are the same plan.
 */
const FILLER_WORDS = new Set(['mit', 'für', 'fuer', 'inkl', 'inklusive', 'with', 'for', 'incl']);

/** An item reduced to what tells it from another: lower case, letters and digits, no subscription or filler word. */
export function itemKey(item: string): string {
  const words = item
    .toLocaleLowerCase('de-DE')
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w !== '' && !SUBSCRIPTION_WORDS.has(w) && !FILLER_WORDS.has(w));
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
  /** True for a business meal: a restaurant's name is never the spelling of another vendor. */
  meal?: boolean;
}

/**
 * Words that name the company behind a brand rather than another business:
 * "Apple Distribution International Ltd." is Apple, "Telekom Deutschland
 * GmbH" is Telekom, "Adobe Systems Software Ireland Ltd" is Adobe, and
 * "amazon.de" is Amazon. A word that is not in here ("Notion Cafe", a
 * template shop, is not Notion) makes another vendor, unless the shorter
 * name's own receipts were bought as it ("Apple iCloud": Apple's receipts
 * are for "iCloud+ 2 TB").
 */
const COMPANY_WORDS = new Set([
  'distribution',
  'international',
  'global',
  'commerce',
  'services',
  'service',
  'systems',
  'software',
  'technologies',
  'technology',
  'holdings',
  'deutschland',
  'germany',
  'europe',
  'emea',
  'ireland',
  'uk',
  'us',
  'usa',
  'pte',
  'sarl',
  'bv',
  'se',
  'sa',
  'com',
  'de',
  'net',
  'io',
]);

/**
 * The words of a vendor's name without its legal form and without a reseller
 * it was sold through ("MTW via Paddle.com" is MTW), in lower case.
 */
function nameWords(vendor: string): string[] {
  return vendor
    .replace(/\s+(?:via|through|über)\s.*$/iu, '')
    .replace(LEGAL_FORM_WORDS, ' ')
    .toLocaleLowerCase('de-DE')
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

/** The words the items of one spelling's receipts carry, in lower case. */
function itemWords(spelling: string, stored: readonly StoredItem[]): Set<string> {
  const words = new Set<string>();
  for (const row of stored) {
    if (row.meal || !row.item || !row.vendor || !sameVendor(row.vendor, spelling)) continue;
    for (const w of row.item.toLocaleLowerCase('de-DE').split(/[^\p{L}\p{N}]+/u)) if (w) words.add(w);
  }
  return words;
}

/**
 * True when `read` is a spelling of the vendor `spelling` names: the same
 * name with or without the legal form (`sameVendor`), or the name followed by
 * words that only name the company behind it (COMPANY_WORDS) or what its
 * receipts were bought as (`boughtAs`, the words of the shorter name's items).
 * Never the other way round: a reading is brought to the shorter name a
 * customer uses, never lengthened.
 */
function spells(spelling: string, read: string, boughtAs: ReadonlySet<string>): boolean {
  if (sameVendor(spelling, read)) return true;
  const short = nameWords(spelling);
  const long = nameWords(read);
  if (short.length === 0 || short.length > long.length) return false;
  // A first word of one or two letters alone ("DB") says too little to make two names one vendor.
  if (short.length === 1 && short[0].length < 3) return false;
  if (!short.every((w, i) => long[i] === w)) return false;
  return long.slice(short.length).every((w) => COMPANY_WORDS.has(w) || boughtAs.has(w));
}

/**
 * The spelling a new reading of a vendor takes, among those the vendor's
 * stored receipts carry (`spells`): the shortest name, the one a customer
 * uses ("Apple", not "Apple Distribution International Ltd."), and of names
 * equally short the one used most ("freenet" over "Freenet"). Null when no
 * stored receipt spells it: the reading stands. Business meals are never a
 * spelling: a restaurant is named by its own till receipt.
 */
export function vendorSpelling(vendor: string | null, stored: readonly StoredItem[]): string | null {
  const read = vendor?.trim();
  if (!read) return null;
  const counts = new Map<string, number>();
  for (const row of stored) {
    const spelling = row.vendor?.trim();
    if (spelling && !row.meal) counts.set(spelling, (counts.get(spelling) ?? 0) + 1);
  }
  let best: { spelling: string; words: number; count: number } | null = null;
  for (const [spelling, count] of counts) {
    if (!spells(spelling, read, itemWords(spelling, stored))) continue;
    const words = nameWords(spelling).length;
    const better =
      !best ||
      words < best.words ||
      (words === best.words && (count > best.count || (count === best.count && (spelling.length < best.spelling.length || (spelling.length === best.spelling.length && spelling < best.spelling)))));
    if (better) best = { spelling, words, count };
  }
  return best?.spelling ?? null;
}

/**
 * The items the receipts of one vendor carry, the most used first (ties in
 * the order first seen), each wording once, at most `KNOWN_ITEMS_LIMIT`. A
 * receipt counts where its vendor is a spelling of the vendor (`spells`: with
 * or without the legal form, or the company that bills for the brand).
 */
export function rankItems(vendor: string | null, stored: readonly StoredItem[]): string[] {
  if (!vendor?.trim()) return [];
  const boughtAs = itemWords(vendor, stored);
  const counts = new Map<string, number>();
  for (const row of stored) {
    const item = row.item?.trim();
    if (!item || !row.vendor || !spells(vendor, row.vendor, boughtAs)) continue;
    counts.set(item, (counts.get(item) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([item, count], order) => ({ item, count, order }))
    .sort((a, b) => b.count - a.count || a.order - b.order)
    .map((e) => e.item)
    .slice(0, KNOWN_ITEMS_LIMIT);
}

/**
 * The word a vendor's receipts are first looked up by in the database. Every
 * spelling of a vendor starts with the same words (`vendorSpelling`), so
 * the first word is searched ("Apple" for "Apple Distribution International
 * Ltd."; the longest word would miss the shorter spellings). A first word
 * of one or two letters never makes a spelling on its own, so the second is
 * searched then ("Hosting" for "A2 Hosting LLC"). The exact test comes
 * afterwards. Null when there is no such word.
 */
export function vendorSearchWord(vendor: string | null): string | null {
  if (!vendor) return null;
  const words = vendor
    .replace(LEGAL_FORM_WORDS, ' ')
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w !== '');
  if (words.length === 0) return null;
  if (words[0].length >= 3) return words[0];
  return words[1] && words[1].length >= 2 ? words[1] : null;
}
