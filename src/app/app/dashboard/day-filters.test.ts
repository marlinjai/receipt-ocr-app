import { describe, expect, it } from 'vitest';
import type { Column, QueryFilter, Row } from '@marlinjai/data-table-core';
import { applyDayFilters, boundsYears, dayOf, matchesDayFilters, readEveryRow, splitDayFilters, yearsWithin, type DayFilter } from './day-filters';
import { GROUP_KIND, ROW_KIND_COLUMN } from '@/lib/receipts-kind';

const columns = [
  { id: 'date', name: 'Date', type: 'date' },
  { id: 'name', name: 'Name', type: 'text' },
  { id: 'kind', name: ROW_KIND_COLUMN, type: 'text' },
] as Column[];

const row = (id: string, date: unknown, parentRowId?: string): Pick<Row, 'id' | 'cells' | 'parentRowId'> => ({
  id,
  cells: { date: date as string, name: id },
  parentRowId,
});
const group = (id: string): Pick<Row, 'id' | 'cells' | 'parentRowId'> => ({ id, cells: { kind: GROUP_KIND, name: id } });

const split = (filters: QueryFilter[]) => splitDayFilters(filters, columns);
const ids = (rows: Array<{ id: string }>) => rows.map((r) => r.id);

describe('the day a date cell names', () => {
  it('is read from the start of the text and never moved by a time zone', () => {
    expect(dayOf('2024-12-31T23:30:00.000Z')).toBe('2024-12-31');
    expect(dayOf('2024-12-31T00:30:00+02:00')).toBe('2024-12-31');
    expect(dayOf('2025-03-14')).toBe('2025-03-14');
    // Read from the first character, as the per-year query reads it.
    expect(dayOf(' 2025-03-14')).toBeNull();
    expect(dayOf(new Date('2025-03-14T00:00:00.000Z'))).toBe('2025-03-14');
  });

  it('is none for an empty or unreadable cell', () => {
    for (const value of [null, undefined, '', 'letzten Sommer', 14, new Date('nope')]) expect(dayOf(value as never)).toBeNull();
  });
});

describe('splitting the filters of a list query', () => {
  it('takes the date comparisons and leaves every other filter to the adapter', () => {
    const text = { columnId: 'name', operator: 'contains', value: 'x' } as QueryFilter;
    const empty = { columnId: 'date', operator: 'isEmpty', value: null } as QueryFilter;
    const after = { columnId: 'date', operator: 'greaterThan', value: '2025-01-31' } as QueryFilter;
    const { dayFilters, adapterFilters } = split([text, empty, after]);
    expect(adapterFilters).toEqual([text, empty]);
    expect(dayFilters).toEqual([{ columnId: 'date', operator: 'greaterThan', day: '2025-01-31' }]);
  });

  it('drops a date comparison that has no value yet: it filters nothing', () => {
    expect(split([{ columnId: 'date', operator: 'equals', value: null }])).toEqual({ dayFilters: [], adapterFilters: [], dayPrefixes: [] });
    expect(split([{ columnId: 'date', operator: 'lessThan', value: '' }])).toEqual({ dayFilters: [], adapterFilters: [], dayPrefixes: [] });
  });

  it('turns "is" a day into a text match on the start of the stored date, which the adapter answers in pages', () => {
    expect(split([{ columnId: 'date', operator: 'equals', value: '2025-01-02' }])).toEqual({
      // Still a date comparison too, so a group is kept or dropped by what it holds.
      dayFilters: [{ columnId: 'date', operator: 'equals', day: '2025-01-02' }],
      adapterFilters: [],
      dayPrefixes: [{ columnId: 'date', operator: 'startsWith', value: '2025-01-02' }],
    });
    // A value with a time is the day it names.
    expect(split([{ columnId: 'date', operator: 'equals', value: '2025-01-02T22:00:00.000Z' }]).dayPrefixes).toEqual([
      { columnId: 'date', operator: 'startsWith', value: '2025-01-02' },
    ]);
  });

  it('keeps a value that names no day, which then matches nothing', () => {
    const { dayFilters } = split([{ columnId: 'date', operator: 'equals', value: 'gestern' }]);
    expect(dayFilters).toEqual([{ columnId: 'date', operator: 'equals', day: null }]);
    expect(matchesDayFilters(row('a', '2025-01-01'), dayFilters)).toBe(false);
  });

  it('leaves comparisons on a column it does not know to the adapter', () => {
    const unknown = { columnId: 'gone', operator: 'greaterThan', value: '2025-01-01' } as QueryFilter;
    expect(split([unknown]).adapterFilters).toEqual([unknown]);
  });
});

describe('the comparisons', () => {
  const rows = [row('dec31', '2024-12-31T00:00:00.000Z'), row('jan1', '2025-01-01'), row('jan2', '2025-01-02T10:00:00.000Z'), row('none', null), row('bad', 'letzten Sommer')];
  const pass = (operator: QueryFilter['operator'], value: string) =>
    ids(rows.filter((r) => matchesDayFilters(r, split([{ columnId: 'date', operator, value }]).dayFilters)));

  it('"after" is strictly after the day, across the turn of the year', () => {
    expect(pass('greaterThan', '2024-12-31')).toEqual(['jan1', 'jan2']);
    expect(pass('greaterThanOrEquals', '2024-12-31')).toEqual(['dec31', 'jan1', 'jan2']);
  });

  it('"before" is strictly before the day, across the turn of the year', () => {
    expect(pass('lessThan', '2025-01-01')).toEqual(['dec31']);
    expect(pass('lessThanOrEquals', '2025-01-01')).toEqual(['dec31', 'jan1']);
  });

  it('"is" matches the whole day, whatever time is stored with it', () => {
    const on = (day: string | null): DayFilter[] => [{ columnId: 'date', operator: 'equals', day }];
    expect(ids(rows.filter((r) => matchesDayFilters(r, on('2025-01-02'))))).toEqual(['jan2']);
    expect(ids(rows.filter((r) => matchesDayFilters(r, on(null))))).toEqual([]);
  });

  it('"is not" keeps receipts without a readable date, and every receipt when the value names no day', () => {
    expect(pass('notEquals', '2025-01-01')).toEqual(['dec31', 'jan2', 'none', 'bad']);
    expect(pass('notEquals', 'gestern')).toEqual(ids(rows));
  });

  it('several comparisons make a range', () => {
    const { dayFilters } = split([
      { columnId: 'date', operator: 'greaterThan', value: '2024-12-30' },
      { columnId: 'date', operator: 'lessThan', value: '2025-01-02' },
    ]);
    expect(ids(rows.filter((r) => matchesDayFilters(r, dayFilters)))).toEqual(['dec31', 'jan1']);
  });
});

describe('a filtered list with groups', () => {
  const list = [group('g1'), row('in-g1', '2025-02-01', 'g1'), row('also-g1', '2024-02-01', 'g1'), group('g2'), row('in-g2', '2024-03-01', 'g2'), group('empty'), row('top', '2025-04-01')];

  it('keeps a group that holds a receipt that passes, and drops the others', () => {
    const { dayFilters } = split([{ columnId: 'date', operator: 'greaterThan', value: '2025-01-01' }]);
    expect(ids(applyDayFilters(list, dayFilters, columns))).toEqual(['g1', 'in-g1', 'top']);
  });

  it('is the list as it was without a date comparison', () => {
    expect(ids(applyDayFilters(list, [], columns))).toEqual(ids(list));
  });
});

describe('the years a list with date comparisons can hold', () => {
  const years = [2026, 2025, 2024, 2023, 2022];
  const f = (operator: DayFilter['operator'], day: string | null, columnId = 'date'): DayFilter => ({ columnId, operator, day });

  it('are one year for "is" a day', () => {
    expect(yearsWithin([f('equals', '2024-05-01')], 'date', years)).toEqual([2024]);
    expect(yearsWithin([f('equals', '2019-05-01')], 'date', years)).toEqual([]);
  });

  it('are bounded by "after" and "before" on the invoice date', () => {
    expect(yearsWithin([f('greaterThan', '2024-12-31')], 'date', years)).toEqual([2026, 2025, 2024]);
    expect(yearsWithin([f('lessThan', '2023-01-01')], 'date', years)).toEqual([2023, 2022]);
    expect(yearsWithin([f('greaterThanOrEquals', '2023-06-01'), f('lessThanOrEquals', '2024-02-01')], 'date', years)).toEqual([2024, 2023]);
  });

  it('are none when the bounds exclude each other or a comparison names no day', () => {
    expect(yearsWithin([f('greaterThan', '2025-01-01'), f('lessThan', '2024-01-01')], 'date', years)).toEqual([]);
    expect(yearsWithin([f('greaterThan', null)], 'date', years)).toEqual([]);
  });

  it('are only looked up when a comparison on the invoice date bounds them', () => {
    expect(boundsYears([f('notEquals', '2025-01-01')], 'date')).toBe(false);
    expect(boundsYears([f('greaterThan', '2025-01-01', 'paid')], 'date')).toBe(false);
    expect(boundsYears([f('lessThan', '2025-01-01')], 'date')).toBe(true);
    expect(boundsYears([f('equals', null)], 'date')).toBe(true);
  });

  it('are not bounded by "is not" or by another date column', () => {
    expect(yearsWithin([f('notEquals', '2025-01-01')], 'date', years)).toBeNull();
    expect(yearsWithin([f('notEquals', null)], 'date', years)).toBeNull();
    expect(yearsWithin([f('greaterThan', '2025-01-01', 'paid')], 'date', years)).toBeNull();
  });
});

describe('reading every row of a list', () => {
  const all = Array.from({ length: 7 }, (_, i) => ({ id: `r${i}` }));
  const pages = (items: Array<{ id: string }>) => async (offset: number, limit: number) => ({
    items: items.slice(offset, offset + limit),
    hasMore: offset + limit < items.length,
  });

  it('reads page after page in order', async () => {
    expect(ids(await readEveryRow(pages(all), 3))).toEqual(ids(all));
  });

  it('counts a row that moved between two pages once', async () => {
    // A row edited while the pages are read shows up at the end of one page and the start of the next.
    const shifted = [...all.slice(0, 3), all[2], ...all.slice(3)];
    expect(ids(await readEveryRow(pages(shifted), 3))).toEqual(ids(all));
  });

  it('refuses a list longer than its limit instead of reading on without end', async () => {
    const endless = async (offset: number, limit: number) => ({ items: Array.from({ length: limit }, (_, i) => ({ id: `e${offset + i}` })), hasMore: true });
    await expect(readEveryRow(endless, 10, 30)).rejects.toThrow('More than 30 rows match');
  });
});
