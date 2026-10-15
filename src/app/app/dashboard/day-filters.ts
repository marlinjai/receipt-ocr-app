import type { CellValue, Column, QueryFilter, Row } from '@marlinjai/data-table-core';
import { isGroupRow } from '@/lib/receipts-kind';

/**
 * The filter bar's date comparisons ("is", "after", "before"), answered by the
 * app instead of the table adapter. The adapter casts the stored date text to a
 * timestamp and compares it with a text parameter, which this database refuses
 * (and a stored date it cannot read, such as "letzten Sommer", would fail the
 * whole list even if it did not). Here a date is compared as the DAY it names,
 * read from the start of the stored text and never moved by a time zone, the
 * same rule the year chips use (`lib/receipt-years.ts`): an invoice of
 * 31 December 2024 is on that day whatever the clock of the server says.
 */

type DayOperator = 'equals' | 'notEquals' | 'greaterThan' | 'greaterThanOrEquals' | 'lessThan' | 'lessThanOrEquals';

const DAY_OPERATORS: ReadonlySet<string> = new Set<DayOperator>([
  'equals',
  'notEquals',
  'greaterThan',
  'greaterThanOrEquals',
  'lessThan',
  'lessThanOrEquals',
]);

const DATE_TYPES: ReadonlySet<string> = new Set(['date', 'created_time', 'last_edited_time']);

export interface DayFilter {
  columnId: string;
  operator: DayOperator;
  /** The day asked for, as YYYY-MM-DD, or null when the value names no day (then nothing matches). */
  day: string | null;
}

/** The day a date cell names, as YYYY-MM-DD, or null when it names none. */
export function dayOf(value: CellValue | undefined): string | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString().slice(0, 10);
  if (typeof value !== 'string') return null;
  const iso = /^(\d{4}-\d{2}-\d{2})/.exec(value.trim());
  return iso ? iso[1] : null;
}

/**
 * Splits the filters of a list query: the date comparisons the app answers, and
 * everything else, which goes to the adapter as before. A date comparison
 * without a value (the filter was just added and no day is picked yet) filters
 * nothing, as a filter without a value does in the filter bar.
 */
export function splitDayFilters(
  filters: readonly QueryFilter[] | undefined,
  columns: readonly Pick<Column, 'id' | 'type'>[],
): { dayFilters: DayFilter[]; adapterFilters: QueryFilter[] } {
  const types = new Map(columns.map((c) => [c.id, c.type as string]));
  const dayFilters: DayFilter[] = [];
  const adapterFilters: QueryFilter[] = [];
  for (const filter of filters ?? []) {
    if (!DATE_TYPES.has(types.get(filter.columnId) ?? '') || !DAY_OPERATORS.has(filter.operator)) {
      adapterFilters.push(filter);
      continue;
    }
    if (filter.value === null || filter.value === undefined || filter.value === '') continue;
    dayFilters.push({ columnId: filter.columnId, operator: filter.operator as DayOperator, day: dayOf(filter.value) });
  }
  return { dayFilters, adapterFilters };
}

function matchesDay(day: string | null, filter: DayFilter): boolean {
  // "is not" a day holds for a receipt without a readable date; every other comparison needs one.
  if (filter.operator === 'notEquals') return filter.day === null || day !== filter.day;
  if (day === null || filter.day === null) return false;
  switch (filter.operator) {
    case 'equals':
      return day === filter.day;
    case 'greaterThan':
      return day > filter.day;
    case 'greaterThanOrEquals':
      return day >= filter.day;
    case 'lessThan':
      return day < filter.day;
    case 'lessThanOrEquals':
      return day <= filter.day;
  }
}

/** True when the row passes every date comparison. ISO days compare correctly as text. */
export function matchesDayFilters(row: Pick<Row, 'cells'>, filters: readonly DayFilter[]): boolean {
  return filters.every((filter) => matchesDay(dayOf(row.cells[filter.columnId]), filter));
}

/**
 * The rows of a list that pass the date comparisons, in their order. A group has
 * no date of its own: it stays when it holds a receipt that passes, so that
 * receipt is still drawn inside it, and goes otherwise.
 */
export function applyDayFilters<T extends Pick<Row, 'id' | 'cells' | 'parentRowId'>>(
  rows: readonly T[],
  filters: readonly DayFilter[],
  columns: readonly Pick<Column, 'id' | 'name'>[],
): T[] {
  if (filters.length === 0) return [...rows];
  const kept = new Set<string>();
  const holding = new Set<string>();
  for (const row of rows) {
    if (isGroupRow(row, columns) || !matchesDayFilters(row, filters)) continue;
    kept.add(row.id);
    if (row.parentRowId) holding.add(row.parentRowId);
  }
  return rows.filter((row) => (isGroupRow(row, columns) ? holding.has(row.id) : kept.has(row.id)));
}
