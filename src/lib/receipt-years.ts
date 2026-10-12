import type { CellValue, Column, Row } from '@marlinjai/data-table-core';
import { isGroupRow } from '@/lib/receipts-kind';

/**
 * The year filter of the receipts table: which years of the invoice date are
 * shown. Pure functions over the rows the dashboard has loaded, so the same
 * answer holds in the table, the board, the calendar and the CSV export.
 *
 * The year is the year of the invoice DAY as the cell says it, read from the
 * text of the date and never moved by a time zone (the same rule as the
 * receipt's name): an invoice of 31 December 2024 is 2024 whatever the
 * browser's clock says.
 *
 * No selection means no filter. A group is a container and is never filtered
 * on a date of its own: it is shown when at least one of its receipts is, and
 * then with those receipts only.
 */

type NamedColumn = Pick<Column, 'id' | 'name'>;

/** The address parameter that carries the choice, the same name the finance area uses for its year. */
export const YEAR_PARAM = 'jahr';

export interface YearSelection {
  years: ReadonlySet<number>;
  /** Receipts without a date. */
  undated: boolean;
}

export const NO_YEARS: YearSelection = { years: new Set(), undated: false };

export function hasYearFilter(selection: YearSelection): boolean {
  return selection.years.size > 0 || selection.undated;
}

/** The year of a date cell, or null when the cell holds no usable date. */
export function yearOfDate(value: CellValue | undefined): number | null {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.getUTCFullYear();
  if (typeof value !== 'string') return null;
  const iso = /^(\d{4})-\d{2}-\d{2}/.exec(value);
  if (iso) return Number(iso[1]);
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.getUTCFullYear();
}

export interface YearCount {
  year: number;
  count: number;
}

/** The years that have receipts, newest first, with how many; and how many receipts have no date. Groups are not counted. */
export function yearsOf(rows: readonly Row[], columns: readonly NamedColumn[]): { years: YearCount[]; undated: number } {
  const dateId = columns.find((c) => c.name === 'Date')?.id;
  const counts = new Map<number, number>();
  let undated = 0;
  for (const row of rows) {
    if (isGroupRow(row, columns)) continue;
    const year = dateId ? yearOfDate(row.cells[dateId]) : null;
    if (year === null) undated++;
    else counts.set(year, (counts.get(year) ?? 0) + 1);
  }
  const years = [...counts].map(([year, count]) => ({ year, count })).sort((a, b) => b.year - a.year);
  return { years, undated };
}

/** One click on a year: it joins the selection, or leaves it. */
export function toggleYear(selection: YearSelection, year: number): YearSelection {
  const years = new Set(selection.years);
  if (years.has(year)) years.delete(year);
  else years.add(year);
  return { years, undated: selection.undated };
}

/**
 * A click with Shift held: every year from the last one clicked to this one,
 * among the years that exist, joins the selection. Without an anchor it is a
 * plain click.
 */
export function selectYearRange(selection: YearSelection, anchor: number | null, year: number, available: readonly number[]): YearSelection {
  if (anchor === null) return toggleYear(selection, year);
  const [from, to] = anchor <= year ? [anchor, year] : [year, anchor];
  const years = new Set(selection.years);
  for (const y of available) if (y >= from && y <= to) years.add(y);
  return { years, undated: selection.undated };
}

export function toggleUndated(selection: YearSelection): YearSelection {
  return { years: selection.years, undated: !selection.undated };
}

/**
 * The rows the selection shows, in their order. Receipts are kept when their
 * year is selected (or they have no date and that is selected); a group when
 * at least one of its receipts is kept.
 */
export function filterByYears<T extends Row>(rows: readonly T[], columns: readonly NamedColumn[], selection: YearSelection): T[] {
  if (!hasYearFilter(selection)) return [...rows];
  const dateId = columns.find((c) => c.name === 'Date')?.id;
  const shown = (row: Row): boolean => {
    const year = dateId ? yearOfDate(row.cells[dateId]) : null;
    return year === null ? selection.undated : selection.years.has(year);
  };
  const keptReceipts = new Set<string>();
  const keptGroups = new Set<string>();
  for (const row of rows) {
    if (isGroupRow(row, columns) || !shown(row)) continue;
    keptReceipts.add(row.id);
    if (row.parentRowId) keptGroups.add(row.parentRowId);
  }
  return rows.filter((row) => (isGroupRow(row, columns) ? keptGroups.has(row.id) : keptReceipts.has(row.id)));
}

/** "2022-2024,2026" in the address: ranges of consecutive years are written as a range, "ohne" is the receipts without a date. */
export function formatYearParam(selection: YearSelection): string {
  const sorted = [...selection.years].sort((a, b) => a - b);
  const parts: string[] = [];
  for (let i = 0; i < sorted.length; ) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j++;
    parts.push(j > i ? `${sorted[i]}-${sorted[j]}` : String(sorted[i]));
    i = j + 1;
  }
  if (selection.undated) parts.push('ohne');
  return parts.join(',');
}

/** The selection an address names. Anything that is not a year, a range or "ohne" is ignored. */
export function parseYearParam(value: string | null | undefined): YearSelection {
  if (!value) return NO_YEARS;
  const years = new Set<number>();
  let undated = false;
  for (const part of value.split(',')) {
    const token = part.trim().toLowerCase();
    if (token === 'ohne') {
      undated = true;
      continue;
    }
    const range = /^(\d{4})(?:-(\d{4}))?$/.exec(token);
    if (!range) continue;
    const from = Number(range[1]);
    const to = range[2] ? Number(range[2]) : from;
    if (from < 1990 || to > 2100 || to < from || to - from > 40) continue;
    for (let y = from; y <= to; y++) years.add(y);
  }
  return { years, undated };
}
