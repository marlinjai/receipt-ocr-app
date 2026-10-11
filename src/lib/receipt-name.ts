/**
 * The name of a receipt: its vendor, what was bought, its total and its date,
 * in that order, as far as they are known
 * ("Musterwerk, Bürostuhl, 119,00 €, 14.03.2025").
 *
 * The name is put together from the cells the receipt holds and never written
 * by a language model: a name a model wrote could state a total the receipt
 * does not have. What was bought is the cell "Item", a few words and never the
 * list of line items (that made names long and different every time). Without
 * it a marketplace or a billing platform as the vendor says nothing about the
 * purchase ("Amazon, 106,24 €, 18.07.2024"). Pure, no server-only import: the
 * dashboard can build the same name in the browser.
 */

/** The column that holds what was bought. */
export const ITEM_COLUMN = 'Item';
/** How long the item may be: a few words, never a list. */
export const ITEM_MAX_LENGTH = 48;

export interface ReceiptNameParts {
  vendor: string | null | undefined;
  /** What was bought, in a few words. */
  item?: string | null;
  gross: number | null | undefined;
  /** ISO 4217 code; euros when missing. */
  currency?: string | null;
  /** ISO 8601 date or instant of the invoice day. */
  date: string | null | undefined;
}

/** The total as it is written in Germany: "1.234,50 €", "23,80 $". An unknown currency code is written out behind the number. */
export function formatTotal(gross: number, currency: string | null | undefined): string {
  const code = (currency || 'EUR').toUpperCase();
  try {
    // A plain space before the sign: the name is typed, searched and compared as ordinary text.
    return new Intl.NumberFormat('de-DE', { style: 'currency', currency: code }).format(gross).replace(/[\u00a0\u202f]/g, ' ');
  } catch {
    return `${new Intl.NumberFormat('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(gross)} ${code}`;
  }
}

/** The invoice day as "14.03.2025". The day is read from the text of the date, never moved by a time zone. */
export function formatDay(date: string): string | null {
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(date);
  if (iso) return `${iso[3]}.${iso[2]}.${iso[1]}`;
  const parsed = new Date(date);
  if (Number.isNaN(parsed.getTime())) return null;
  return `${String(parsed.getUTCDate()).padStart(2, '0')}.${String(parsed.getUTCMonth() + 1).padStart(2, '0')}.${parsed.getUTCFullYear()}`;
}

/**
 * The item as it is stored and shown: one line, no comma (the comma separates
 * the parts of the name), no closing punctuation, cut at a word. Null when
 * nothing usable is left.
 */
export function cleanItem(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  let item = value.replace(/\s+/g, ' ').replace(/\s*,\s*/g, ' ').replace(/[\s.;:!]+$/, '').trim();
  if (item.length > ITEM_MAX_LENGTH) {
    const cut = item.slice(0, ITEM_MAX_LENGTH + 1);
    item = cut.slice(0, cut.lastIndexOf(' ') > 12 ? cut.lastIndexOf(' ') : ITEM_MAX_LENGTH).trim();
  }
  return item.length >= 2 ? item : null;
}

const UNREADABLE_PREFIX = 'Nicht lesbar: ';
/** The way a built name ends: a total ("119,00 €", "23,80 $", "10,00 XXQ"), a day, or both. */
const BUILT_TAIL = /(?:\d{1,3}(?:\.\d{3})*,\d{2} \S{1,4}|\d{2}\.\d{2}\.\d{4})$/;

/**
 * True when a stored name was put together from the cells (or stands in for a
 * receipt nothing could be read from), so it may be built again when the cells
 * change. A name a person typed says something else and is left alone.
 */
export function nameIsBuilt(name: unknown): boolean {
  if (typeof name !== 'string') return true;
  const trimmed = name.trim();
  return trimmed === '' || trimmed.startsWith(UNREADABLE_PREFIX) || BUILT_TAIL.test(trimmed);
}

/** The name, or an empty string when neither vendor, total nor date is known (the caller then names the row after its file). */
export function receiptName(parts: ReceiptNameParts): string {
  const out: string[] = [];
  const vendor = parts.vendor?.trim();
  if (vendor) out.push(vendor);
  const item = cleanItem(parts.item);
  // A vendor that is its own product ("Notion", item "Notion") is said once.
  if (item && item.toLowerCase() !== vendor?.toLowerCase()) out.push(item);
  if (typeof parts.gross === 'number' && Number.isFinite(parts.gross)) out.push(formatTotal(parts.gross, parts.currency));
  const day = parts.date ? formatDay(parts.date) : null;
  if (day) out.push(day);
  return out.join(', ');
}
