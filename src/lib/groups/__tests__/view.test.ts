import { describe, expect, it } from 'vitest';
import type { Row } from '@marlinjai/data-table-core';
import { GROUP_WRITABLE_COLUMNS } from '@/lib/receipts-kind';
import { deleteWording, deletedWording, groupCellValue, groupsOf, receiptsInGroup, searchWithGroupReceipts, selectionKinds, sumOf } from '../view';
import { allRows, columnId, columns, dinner, emptyGroup, group, hotel, licence, orphan } from './fixture';

const column = (name: string) => columns.find((c) => c.name === name)!;
const inGroup = [hotel, dinner];

describe('what a group shows in the table', () => {
  it('the sum of its receipts in the amount columns, never its own stored value', () => {
    // The fixture's group carries 999 of its own; the table must show 140.
    expect(groupCellValue(group, inGroup, column('Gross'), columns)).toBe(140);
    expect(groupCellValue(group, inGroup, column('EUR Equivalent'), columns)).toBe(140);
    expect(groupCellValue(group, inGroup, column('Attributed EUR'), columns)).toBe(140);
  });

  it('an empty group shows 0', () => {
    expect(groupCellValue(emptyGroup, [], column('Gross'), columns)).toBe(0);
    expect(groupCellValue(emptyGroup, [], column('EUR Equivalent'), columns)).toBe(0);
  });

  it('sums to the cent', () => {
    const cents = (id: string, gross: number): Row => ({ ...hotel, id, cells: { ...hotel.cells, [columnId('Gross')]: gross } }) as Row;
    expect(groupCellValue(group, [cents('a', 0.1), cents('b', 0.2)], column('Gross'), columns)).toBe(0.3);
  });

  it('no gross sum when its receipts are in different currencies; the sums in euros stay', () => {
    const dollars = { ...dinner, cells: { ...dinner.cells, [columnId('Currency')]: 'opt_usd', [columnId('EUR Equivalent')]: 36 } } as Row;
    expect(groupCellValue(group, [hotel, dollars], column('Gross'), columns)).toBeNull();
    expect(groupCellValue(group, [hotel, dollars], column('EUR Equivalent'), columns)).toBe(136);
  });

  it('its own cell where it may carry a value', () => {
    for (const name of GROUP_WRITABLE_COLUMNS) expect(groupCellValue(group, inGroup, column(name), columns)).toBeUndefined();
  });

  it('nothing, read-only, in every other column', () => {
    for (const name of ['Net', 'Tax Rate', 'Date', 'Currency', 'FX Rate', 'Business Share %', 'Status']) {
      expect(groupCellValue(group, inGroup, column(name), columns), name).toBeNull();
    }
  });

  it('a receipt always shows its own cells, also when rows lie underneath it', () => {
    expect(groupCellValue(hotel, [dinner], column('Gross'), columns)).toBeUndefined();
    expect(groupCellValue(licence, [], column('Date'), columns)).toBeUndefined();
  });

  it('sumOf adds one column over receipts and ignores what is not a number', () => {
    expect(sumOf([hotel, dinner, licence, orphan], columnId('Gross'))).toBe(157);
    expect(sumOf([{ cells: { x: 'abc' } }, { cells: {} }], 'x')).toBe(0);
  });
});

describe('the groups and the selection', () => {
  it('lists the groups by name, never a receipt', () => {
    expect(groupsOf(allRows, columns)).toEqual([
      { id: 'emptyGroup', name: 'Leere Gruppe' },
      { id: 'group', name: 'Messe' },
    ]);
  });

  it('a group without a name still has a label, and an archived one is not offered', () => {
    const unnamed = { ...emptyGroup, id: 'u', cells: { ...emptyGroup.cells, [columnId('Name')]: ' ' } } as Row;
    const archived = { ...emptyGroup, id: 'a', archived: true } as Row;
    expect(groupsOf([unnamed, archived], columns)).toEqual([{ id: 'u', name: 'Gruppe ohne Namen' }]);
  });

  it('sorts a selection into receipts, groups, and receipts that lie in a group', () => {
    expect(selectionKinds(['group', 'hotel', 'licence', 'orphan', 'not-loaded'], allRows, columns)).toEqual({
      receiptIds: ['hotel', 'licence', 'orphan'],
      groupIds: ['group'],
      // The orphan points at a group that is gone: there is nothing to take it out of.
      inGroupIds: ['hotel'],
    });
  });

  it('lists the receipts of a group', () => {
    expect(receiptsInGroup('group', allRows, columns).map((r) => r.id)).toEqual(['hotel', 'dinner']);
    expect(receiptsInGroup('emptyGroup', allRows, columns)).toEqual([]);
  });
});

describe('a search that finds a group', () => {
  it('shows the group with its receipts, so its sum is not that of an empty group', () => {
    expect(searchWithGroupReceipts([group], allRows, columns).map((r) => r.id)).toEqual(['group', 'hotel', 'dinner']);
  });

  it('adds no row twice and keeps the order of the table', () => {
    expect(searchWithGroupReceipts([dinner, group, licence], allRows, columns).map((r) => r.id)).toEqual(['group', 'hotel', 'dinner', 'licence']);
  });

  it('a search that finds only receipts is left as it is', () => {
    expect(searchWithGroupReceipts([hotel, licence], allRows, columns).map((r) => r.id)).toEqual(['hotel', 'licence']);
  });
});

describe('the question before a delete', () => {
  it('receipts only: as before', () => {
    expect(deleteWording(1, 0, 0).title).toBe('1 Beleg endgültig löschen?');
    expect(deleteWording(3, 0, 0).confirmLabel).toBe('Endgültig löschen');
  });

  it('a group is dissolved and its receipts stay', () => {
    const w = deleteWording(0, 1, 2);
    expect(w.title).toBe('1 Gruppe auflösen?');
    expect(w.body).toBe('Die Gruppe wird entfernt. 2 Belege bleiben erhalten und stehen danach wieder einzeln in der Tabelle.');
    expect(w.confirmLabel).toBe('Gruppe auflösen');
    expect(deleteWording(0, 1, 1).body).toContain('1 Beleg bleibt erhalten und steht danach');
  });

  it('an empty group says so', () => {
    expect(deleteWording(0, 1, 0).body).toBe('Die Gruppe ist leer und wird entfernt.');
  });

  it('a selection of both names both, and only the receipts that were not selected stay', () => {
    const w = deleteWording(1, 1, 1);
    expect(w.title).toBe('1 Beleg endgültig löschen und 1 Gruppe auflösen?');
    expect(w.body).toContain('Das lässt sich nicht rückgängig machen.');
    expect(w.body).toContain('1 Beleg bleibt erhalten');
  });

  it('the outcome says which was which', () => {
    expect(deletedWording(2, 1)).toBe('2 Belege gelöscht. 1 Gruppe aufgelöst.');
    expect(deletedWording(0, 2)).toBe('2 Gruppen aufgelöst.');
    expect(deletedWording(0, 0)).toBe('');
  });
});
