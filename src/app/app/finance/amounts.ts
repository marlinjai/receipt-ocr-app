import { eurosToCents, formatCents } from '@/lib/tax/money';

/** Display and entry of amounts in the finance forms, in one place. */

export const euro = (cents: number) => `${formatCents(cents)} €`;

/**
 * A typed euro amount to cents; null when it is not an amount. Read the German
 * way: a comma is the decimal sign and points group thousands ("1.234,56",
 * "5.000"). A single point followed by one or two digits is taken as a decimal
 * point ("1234.56"), since nobody groups thousands that way.
 */
export function parseEuro(text: string): number | null {
  const trimmed = text.trim().replace(/\s|€/g, '');
  if (!trimmed) return null;
  let normalized = trimmed;
  if (trimmed.includes(',')) normalized = trimmed.replace(/\./g, '').replace(',', '.');
  else if (/^\d{1,3}(\.\d{3})+$/.test(trimmed)) normalized = trimmed.replace(/\./g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(normalized)) return null;
  const n = Number(normalized);
  return Number.isFinite(n) && n >= 0 ? eurosToCents(n) : null;
}

export const MONTHS = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];
