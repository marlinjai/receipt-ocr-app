import { describe, expect, it } from 'vitest';
import { GROUP_KIND, ROW_KIND_COLUMN, isGroupRow, receiptsOnly, rowKindColumnId, visibleColumns } from '@/lib/receipts-kind';
import { RECEIPT_IDS, allRows, columnId, columns, emptyGroup, group, hotel, orphan } from '@/lib/groups/__tests__/fixture';

describe('what a row of the receipts table is', () => {
  it('a row with the kind "group" is a group, with or without receipts underneath', () => {
    expect(isGroupRow(group, columns)).toBe(true);
    expect(isGroupRow(emptyGroup, columns)).toBe(true);
  });

  it('a row without a kind is a receipt, also inside a group and also when its group is gone', () => {
    expect(isGroupRow(hotel, columns)).toBe(false);
    expect(isGroupRow(orphan, columns)).toBe(false);
  });

  it('receiptsOnly leaves out the groups and keeps every receipt once, in order', () => {
    expect(receiptsOnly(allRows, columns).map((r) => r.id)).toEqual(RECEIPT_IDS);
  });

  it('a receipt is not made a group by having rows point at it', () => {
    const child = { ...hotel, id: 'part', parentRowId: 'licence' };
    expect(receiptsOnly([...allRows, child], columns).map((r) => r.id)).toEqual([...RECEIPT_IDS, 'part']);
  });

  it('on a table that has not received the kind column yet, every row is a receipt', () => {
    const before = columns.filter((c) => c.name !== ROW_KIND_COLUMN);
    expect(rowKindColumnId(before)).toBeNull();
    expect(isGroupRow(group, before)).toBe(false);
    expect(receiptsOnly(allRows, before)).toHaveLength(allRows.length);
  });

  it('only the exact kind makes a group: any other value is a receipt', () => {
    const odd = { ...hotel, cells: { ...hotel.cells, [columnId(ROW_KIND_COLUMN)]: 'Group' } };
    expect(isGroupRow(odd, columns)).toBe(false);
    expect(GROUP_KIND).toBe('group');
  });

  it('the kind column is not among the columns a person sees', () => {
    expect(visibleColumns(columns).some((c) => c.name === ROW_KIND_COLUMN)).toBe(false);
    expect(visibleColumns(columns)).toHaveLength(columns.length - 1);
  });
});
