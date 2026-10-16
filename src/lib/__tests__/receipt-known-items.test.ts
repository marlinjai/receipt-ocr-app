import { describe, expect, it, vi } from 'vitest';
import { knownItemsOfVendor } from '../receipt-known-items';

const COLUMNS = [
  { id: 'v', name: 'Vendor' },
  { id: 'i', name: 'Item' },
  { id: 'k', name: 'Row Kind' },
];

describe('knownItemsOfVendor', () => {
  it('asks the database for the vendor\'s longest word and keeps the same vendor only, without the row read again, archived rows or groups', async () => {
    const getRows = vi.fn().mockResolvedValue({
      items: [
        { id: 'a', cells: { v: 'Example Video Tools', i: 'Example Video Abo' } },
        { id: 'b', cells: { v: 'Example Video Tools Inc.', i: 'Example Video Abo' } },
        { id: 'self', cells: { v: 'Example Video Tools', i: 'Altes Wort' } },
        { id: 'gone', archived: true, cells: { v: 'Example Video Tools', i: 'Archiviert' } },
        { id: 'group', cells: { v: 'Example Video Tools', i: 'Gruppe', k: 'group' } },
        { id: 'c', cells: { v: 'Example Shop', i: 'Fremd' } },
      ],
      hasMore: false,
    });
    const items = await knownItemsOfVendor({ getColumns: async () => COLUMNS, getRows }, 't', 'Example Video Tools', 'self');
    expect(getRows).toHaveBeenCalledWith('t', { filters: [{ columnId: 'v', operator: 'contains', value: 'Example' }], limit: 250, offset: 0 });
    expect(items).toEqual(['Example Video Abo']);
  });

  it('pages through the rows', async () => {
    const getRows = vi
      .fn()
      .mockResolvedValueOnce({ items: [{ id: 'a', cells: { v: 'Muster', i: 'Eins' } }], hasMore: true })
      .mockResolvedValueOnce({ items: [{ id: 'b', cells: { v: 'Muster', i: 'Zwei' } }], hasMore: false });
    expect(await knownItemsOfVendor({ getColumns: async () => COLUMNS, getRows }, 't', 'Muster')).toEqual(['Eins', 'Zwei']);
    expect(getRows).toHaveBeenCalledTimes(2);
  });

  it('no vendor, no item column or a failing database: no known items, and the failure is logged', async () => {
    const getRows = vi.fn();
    expect(await knownItemsOfVendor({ getColumns: async () => COLUMNS, getRows }, 't', null)).toEqual([]);
    expect(await knownItemsOfVendor({ getColumns: async () => [COLUMNS[0]], getRows }, 't', 'Muster')).toEqual([]);
    expect(getRows).not.toHaveBeenCalled();
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const failing = vi.fn().mockRejectedValue(new Error('connection lost'));
    expect(await knownItemsOfVendor({ getColumns: async () => COLUMNS, getRows: failing }, 't', 'Muster')).toEqual([]);
    expect(log).toHaveBeenCalled();
    log.mockRestore();
  });
});
