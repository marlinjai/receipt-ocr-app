/**
 * The name of a receipt: its vendor, its total and its date, in that order,
 * as far as they are known ("Musterwerk, 119,00 €, 14.03.2025").
 *
 * The name is put together from the cells the receipt holds, never from the
 * line items and never by a language model: a list of what was bought made
 * names long and different every time, and a name a model wrote could state a
 * total the receipt does not have. Pure, no server-only import: the dashboard
 * can build the same name in the browser.
 */

export interface ReceiptNameParts {
  vendor: string | null | undefined;
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

/** The name, or an empty string when neither vendor, total nor date is known (the caller then names the row after its file). */
export function receiptName(parts: ReceiptNameParts): string {
  const out: string[] = [];
  const vendor = parts.vendor?.trim();
  if (vendor) out.push(vendor);
  if (typeof parts.gross === 'number' && Number.isFinite(parts.gross)) out.push(formatTotal(parts.gross, parts.currency));
  const day = parts.date ? formatDay(parts.date) : null;
  if (day) out.push(day);
  return out.join(', ');
}
