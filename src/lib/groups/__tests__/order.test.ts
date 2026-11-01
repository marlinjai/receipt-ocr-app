import { describe, expect, it } from 'vitest';
import type { Column, Row } from '@marlinjai/data-table-core';
import { GROUP_POSITION_COLUMN, visibleColumns } from '@/lib/receipts-kind';
import { GroupError, assertCellsWritable } from '../rules';
import { inGroupOrder, orderWithin } from '../order';

const columns = [{ id: 'name', name: 'Name' }, { id: 'pos', name: GROUP_POSITION_COLUMN }] as Pick<Column, 'id' | 'name'>[];
const row = (id: string, parentRowId?: string, pos?: number | string | null) => ({ id, parentRowId, cells: { pos: pos ?? null } }) as unknown as Row;
const ids = (rows: Row[]) => rows.map((r) => r.id);

describe('orderWithin', () => {
  it('puts the named rows in the wanted order and leaves the others in their places', () => {
    expect(orderWithin(['a', 'hidden', 'b', 'c'], ['c', 'a', 'b'])).toEqual(['c', 'hidden', 'a', 'b']);
  });
  it('passes over a row that is not there', () => {
    expect(orderWithin(['a', 'b'], ['b', 'gone', 'a'])).toEqual(['b', 'a']);
  });
  it('an empty wish changes nothing', () => {
    expect(orderWithin(['a', 'b'], [])).toEqual(['a', 'b']);
  });
});

describe('inGroupOrder', () => {
  const rows = [row('g'), row('x', 'g', 2), row('loose'), row('y', 'g', 0), row('new', 'g'), row('z', 'g', 1)];

  it('orders the receipts of a group by place, in the slots they hold, and moves no other row', () => {
    expect(ids(inGroupOrder(rows, columns))).toEqual(['g', 'y', 'loose', 'z', 'x', 'new']);
  });
  it('a place may come as text', () => {
    expect(ids(inGroupOrder([row('a', 'g', '10'), row('b', 'g', '9')], columns))).toEqual(['b', 'a']);
  });
  it('a group nobody put in order stays in the order it came', () => {
    const plain = [row('a', 'g'), row('b', 'g'), row('c', 'g')];
    expect(ids(inGroupOrder(plain, columns))).toEqual(['a', 'b', 'c']);
  });
  it('an order just placed wins over the stored places, in that group only', () => {
    const two = [row('a', 'g', 0), row('b', 'g', 1), row('c', 'h', 1), row('d', 'h', 0)];
    expect(ids(inGroupOrder(two, columns, { groupId: 'g', order: ['b', 'a'] }))).toEqual(['b', 'a', 'd', 'c']);
  });
  it('a table without the column keeps the rows as they came', () => {
    expect(ids(inGroupOrder(rows, [{ id: 'name', name: 'Name' }]))).toEqual(ids(rows));
  });
});

describe('the place of a receipt as a column', () => {
  it('is never shown', () => {
    expect(visibleColumns(columns).map((c) => c.name)).toEqual(['Name']);
  });
  it('cannot be written through a cell', () => {
    expect(() => assertCellsWritable(columns, null, { pos: 3 })).toThrow(GroupError);
  });
});
