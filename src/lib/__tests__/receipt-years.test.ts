import { describe, expect, it } from 'vitest';
import type { Row } from '@marlinjai/data-table-core';
import { ROW_KIND_COLUMN, GROUP_KIND } from '../receipts-kind';
import {
  NO_YEARS,
  filterByYears,
  formatYearParam,
  hasYearFilter,
  parseYearParam,
  selectYearRange,
  toggleUndated,
  toggleYear,
  yearOfDate,
  yearsOf,
} from '../receipt-years';

const columns = [
  { id: 'c-date', name: 'Date' },
  { id: 'c-kind', name: ROW_KIND_COLUMN },
];

function row(id: string, date: unknown, extra: Partial<Row> = {}, kind?: string): Row {
  return { id, tableId: 't', cells: { 'c-date': date as never, ...(kind ? { 'c-kind': kind } : {}) }, ...extra } as Row;
}

const rows: Row[] = [
  row('a', '2025-03-01T00:00:00.000Z'),
  row('b', '2024-12-31T23:59:59.000Z'),
  row('c', new Date('2023-07-04T00:00:00.000Z')),
  row('d', null),
  row('e', '2024-01-01'),
  row('g', null, {}, GROUP_KIND),
  row('h', '2022-05-05T00:00:00.000Z', { parentRowId: 'g' }),
  row('i', '2025-05-05T00:00:00.000Z', { parentRowId: 'g' }),
];

describe('the year of a date cell', () => {
  it('is read from the text of the day, not moved by a time zone', () => {
    expect(yearOfDate('2024-12-31T23:30:00.000Z')).toBe(2024);
    expect(yearOfDate('2025-01-01T00:00:00.000Z')).toBe(2025);
    expect(yearOfDate(new Date('2021-06-15T00:00:00.000Z'))).toBe(2021);
  });

  it('is null for nothing usable', () => {
    expect(yearOfDate(null)).toBeNull();
    expect(yearOfDate('')).toBeNull();
    expect(yearOfDate('garbage')).toBeNull();
    expect(yearOfDate(42)).toBeNull();
    expect(yearOfDate(new Date('x'))).toBeNull();
  });
});

describe('the years a table has', () => {
  it('counts receipts per year, newest first, and the receipts without a date; a group is no receipt', () => {
    expect(yearsOf(rows, columns)).toEqual({
      years: [
        { year: 2025, count: 2 },
        { year: 2024, count: 2 },
        { year: 2023, count: 1 },
        { year: 2022, count: 1 },
      ],
      undated: 1,
    });
  });
});

describe('choosing years', () => {
  it('a click adds a year and a second click takes it out again', () => {
    const one = toggleYear(NO_YEARS, 2023);
    expect([...one.years]).toEqual([2023]);
    expect(hasYearFilter(one)).toBe(true);
    expect(hasYearFilter(toggleYear(one, 2023))).toBe(false);
  });

  it('shift selects the years between the last click and this one, only those that exist', () => {
    const available = [2025, 2024, 2023, 2022, 2021];
    const sel = selectYearRange(toggleYear(NO_YEARS, 2021), 2021, 2023, available);
    expect([...sel.years].sort()).toEqual([2021, 2022, 2023]);
    const backwards = selectYearRange(NO_YEARS, 2024, 2022, available);
    expect([...backwards.years].sort()).toEqual([2022, 2023, 2024]);
    expect([...selectYearRange(NO_YEARS, null, 2024, available).years]).toEqual([2024]);
    // 2023 does not exist: it cannot be selected by a range
    expect([...selectYearRange(NO_YEARS, 2025, 2021, [2025, 2024, 2021]).years].sort()).toEqual([2021, 2024, 2025]);
  });

  it('keeps the undated choice apart from the years', () => {
    const sel = toggleUndated(toggleYear(NO_YEARS, 2024));
    expect(sel.undated).toBe(true);
    expect(toggleYear(sel, 2024).undated).toBe(true);
  });
});

describe('filtering rows', () => {
  it('shows everything when nothing is chosen', () => {
    expect(filterByYears(rows, columns, NO_YEARS)).toHaveLength(rows.length);
  });

  it('shows the receipts of the chosen years in their order', () => {
    const shown = filterByYears(rows, columns, { years: new Set([2024]), undated: false });
    expect(shown.map((r) => r.id)).toEqual(['b', 'e']);
  });

  it('shows a group with the receipts of the chosen years only, and hides a group without any', () => {
    expect(filterByYears(rows, columns, { years: new Set([2022]), undated: false }).map((r) => r.id)).toEqual(['g', 'h']);
    expect(filterByYears(rows, columns, { years: new Set([2022, 2025]), undated: false }).map((r) => r.id)).toEqual(['a', 'g', 'h', 'i']);
    expect(filterByYears(rows, columns, { years: new Set([2023]), undated: false }).map((r) => r.id)).toEqual(['c']);
  });

  it('shows receipts without a date only when that is chosen', () => {
    expect(filterByYears(rows, columns, { years: new Set(), undated: true }).map((r) => r.id)).toEqual(['d']);
    expect(filterByYears(rows, columns, { years: new Set([2023]), undated: true }).map((r) => r.id)).toEqual(['c', 'd']);
  });
});

describe('the address', () => {
  it('writes consecutive years as a range and reads it back', () => {
    const sel = { years: new Set([2021, 2022, 2023, 2025]), undated: true };
    expect(formatYearParam(sel)).toBe('2021-2023,2025,ohne');
    const back = parseYearParam('2021-2023,2025,ohne');
    expect([...back.years].sort()).toEqual([2021, 2022, 2023, 2025]);
    expect(back.undated).toBe(true);
  });

  it('ignores what is not a year', () => {
    expect(hasYearFilter(parseYearParam('abc,12,2099999,2024-2020'))).toBe(false);
    expect([...parseYearParam(' 2024 , x ').years]).toEqual([2024]);
    expect(hasYearFilter(parseYearParam(null))).toBe(false);
    expect(formatYearParam(NO_YEARS)).toBe('');
  });
});
