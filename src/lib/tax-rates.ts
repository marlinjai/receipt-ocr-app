import { firstColumnIdByName } from '@/lib/column-lookup';
import { parseTaxLines } from '@/lib/meals/rules';
import { MEAL_COLUMNS } from '@/lib/receipts-constants';

/**
 * The tax rates of a receipt, as a person reads them: "19 %", or
 * "19 % + 7 %" for a receipt that carries two (a restaurant bill with food
 * and drinks, a supermarket receipt).
 *
 * The number column "Tax Rate" can hold one rate only: the one that carries
 * most of the bill. That is right for sorting and filtering, and wrong as a
 * statement about a mixed receipt. This text column says what the receipt
 * says. It is derived, never typed by the reader's caller: from the receipt's
 * tax lines when there are any, else from the single rate. Every writer of the
 * rate or the tax lines goes through `withTaxRates`, so the two cannot drift.
 */
export const TAX_RATE_COLUMN = 'Tax Rate';
export const TAX_RATES_COLUMN = 'Tax Rates';

const RATE_FORMAT = new Intl.NumberFormat('de-DE', { maximumFractionDigits: 2 });

function formatRate(rate: number): string {
  return `${RATE_FORMAT.format(rate)} %`;
}

function numberOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * The rates of the tax lines, each once, the one with the largest net amount
 * first (so the text starts with what the number column shows). Without tax
 * lines: the single rate. Empty when neither is known.
 */
export function formatTaxRates(lines: ReadonlyArray<{ rate: number; net?: number | null }> | null | undefined, fallbackRate: number | null | undefined): string {
  const netByRate = new Map<number, number>();
  for (const line of lines ?? []) {
    if (typeof line.rate !== 'number' || !Number.isFinite(line.rate)) continue;
    netByRate.set(line.rate, (netByRate.get(line.rate) ?? 0) + (typeof line.net === 'number' && Number.isFinite(line.net) ? line.net : 0));
  }
  if (netByRate.size > 0) {
    return [...netByRate.entries()]
      .sort((a, b) => b[1] - a[1] || b[0] - a[0])
      .map(([rate]) => formatRate(rate))
      .join(' + ');
  }
  return typeof fallbackRate === 'number' && Number.isFinite(fallbackRate) ? formatRate(fallbackRate) : '';
}

/**
 * The cells of a write, with the rates text added whenever the write touches
 * the rate or the tax lines. `stored` is the row as it is now (omit for a new
 * row): what the write does not set is read from there. A write that sets the
 * rates text itself, or touches neither source, is returned unchanged, and so
 * is any write on a table that has no such column yet.
 */
export function withTaxRates<V>(
  columns: ReadonlyArray<{ id: string; name: string }>,
  cells: Record<string, V>,
  stored?: Record<string, unknown> | null,
): Record<string, V | string> {
  const ids = firstColumnIdByName(columns);
  const ratesId = ids.get(TAX_RATES_COLUMN);
  if (!ratesId || ratesId in cells) return cells;
  const rateId = ids.get(TAX_RATE_COLUMN);
  const linesId = ids.get(MEAL_COLUMNS.taxLines);
  const setsRate = rateId !== undefined && rateId in cells;
  const setsLines = linesId !== undefined && linesId in cells;
  if (!setsRate && !setsLines) return cells;
  const value = (id: string | undefined): unknown => (id === undefined ? null : id in cells ? cells[id] : (stored?.[id] ?? null));
  return { ...cells, [ratesId]: formatTaxRates(parseTaxLines(value(linesId)), numberOrNull(value(rateId))) };
}
