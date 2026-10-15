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
  /**
   * The day asked for, as YYYY-MM-DD, or null when the value names no day: then no receipt is on, after
   * or before it, and every receipt is "not" on it.
   */
  day: string | null;
}

/**
 * The day a date cell names, as YYYY-MM-DD, or null when it names none. Cells and filter values come as
 * text; a Date object (which the cell type allows) has lost the written day and is read in UTC.
 */
export function dayOf(value: CellValue | undefined): string | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString().slice(0, 10);
  if (typeof value !== 'string') return null;
  // Not trimmed: the per-year query and the year chips match the stored text from its first character too.
  const iso = /^(\d{4}-\d{2}-\d{2})/.exec(value);
  return iso ? iso[1] : null;
}

/**
 * Splits the filters of a list query: the date comparisons the app answers, and
 * everything else, which goes to the adapter as before. "Is" a day also becomes
 * a text match on the start of the stored date for the adapter, so the database
 * reads only that day's receipts (the day is validated, so it carries no
 * wildcard); it stays a date comparison as well, so the groups are kept or
 * dropped by what they hold, as for "after" and "before". A date comparison
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
    const day = dayOf(filter.value);
    if (filter.operator === 'equals' && day !== null) adapterFilters.push({ columnId: filter.columnId, operator: 'startsWith', value: day });
    dayFilters.push({ columnId: filter.columnId, operator: filter.operator as DayOperator, day });
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

/** True when a comparison on the date column bounds the years ("is", "after", "before", or one that names no day). */
export function boundsYears(filters: readonly DayFilter[], dateColumnId: string): boolean {
  return filters.some((f) => f.columnId === dateColumnId && f.operator !== 'notEquals');
}

/**
 * The years a list with date comparisons can hold receipts of, from the bounds
 * the comparisons on the date column set ("after 31 December 2024" cannot hold
 * a receipt of 2023), or null when they set none. The list then needs to read
 * only those years, through the same per-year query the year chips use.
 */
export function yearsWithin(filters: readonly DayFilter[], dateColumnId: string, years: readonly number[]): number[] | null {
  let from = -Infinity;
  let to = Infinity;
  let bounded = false;
  for (const filter of filters) {
    if (filter.columnId !== dateColumnId) continue;
    // A comparison with no day matches nothing, so no year can hold a receipt.
    if (filter.day === null && filter.operator !== 'notEquals') return [];
    if (filter.day === null) continue;
    const year = Number(filter.day.slice(0, 4));
    if (filter.operator === 'equals') {
      from = Math.max(from, year);
      to = Math.min(to, year);
      bounded = true;
    } else if (filter.operator === 'greaterThan' || filter.operator === 'greaterThanOrEquals') {
      from = Math.max(from, year);
      bounded = true;
    } else if (filter.operator === 'lessThan' || filter.operator === 'lessThanOrEquals') {
      to = Math.min(to, year);
      bounded = true;
    }
  }
  return bounded ? years.filter((y) => y >= from && y <= to) : null;
}

/** The most rows one list with date comparisons reads when it cannot be narrowed to years. */
export const EVERY_ROW_LIMIT = 20_000;

/**
 * Every row of a query, read page by page in the query's order. A row that a
 * new row pushes from one page onto the next while they are read is kept once;
 * a row deleted meanwhile can make the next one slip past, as in any paged
 * read, and the next reload shows it. Refuses a list longer than the limit
 * (the list then fails and says so) instead of reading on without end or
 * showing part of it as if it were all.
 */
export async function readEveryRow<T extends { id: string }>(
  readPage: (offset: number, limit: number) => Promise<{ items: T[]; hasMore: boolean }>,
  pageSize: number,
  limit = EVERY_ROW_LIMIT,
): Promise<T[]> {
  const seen = new Set<string>();
  const rows: T[] = [];
  for (let offset = 0; ; offset += pageSize) {
    if (offset >= limit) throw new Error(`More than ${limit} rows match; the list is refused rather than shown in part.`);
    const page = await readPage(offset, pageSize);
    for (const row of page.items) {
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      rows.push(row);
    }
    if (!page.hasMore || page.items.length === 0) return rows;
  }
}
