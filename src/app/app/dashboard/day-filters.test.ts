import { describe, expect, it } from 'vitest';
import type { Column, QueryFilter, Row } from '@marlinjai/data-table-core';
import { applyDayFilters, dayOf, matchesDayFilters, splitDayFilters } from './day-filters';
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
    expect(split([{ columnId: 'date', operator: 'equals', value: null }])).toEqual({ dayFilters: [], adapterFilters: [] });
    expect(split([{ columnId: 'date', operator: 'lessThan', value: '' }])).toEqual({ dayFilters: [], adapterFilters: [] });
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
    expect(pass('equals', '2025-01-02')).toEqual(['jan2']);
    expect(pass('equals', '2025-01-02T00:00:00.000Z')).toEqual(['jan2']);
  });

  it('"is not" keeps receipts without a readable date', () => {
    expect(pass('notEquals', '2025-01-01')).toEqual(['dec31', 'jan2', 'none', 'bad']);
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
