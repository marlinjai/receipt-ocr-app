import { describe, expect, it, vi } from 'vitest';
import { knownVendor } from '../receipt-known-items';

const COLUMNS = [
  { id: 'v', name: 'Vendor' },
  { id: 'i', name: 'Item' },
  { id: 'c', name: 'Category' },
  { id: 'k', name: 'Row Kind' },
];
const getSelectOptions = async () => [
  { id: 'meal', name: 'Bewirtung' },
  { id: 'soft', name: 'Software' },
];

describe('knownVendor', () => {
  it("asks the database for the vendor's first word and keeps its spellings only, without the row read again, archived rows or groups", async () => {
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
    const known = await knownVendor({ getColumns: async () => COLUMNS, getRows, getSelectOptions }, 't', 'Example Video Tools', 'self');
    expect(getRows).toHaveBeenCalledWith('t', { filters: [{ columnId: 'v', operator: 'contains', value: 'Example' }], limit: 250, offset: 0 });
    expect(known).toEqual({ spelling: 'Example Video Tools', items: ['Example Video Abo'] });
  });

  it('a reading in the company form takes the spelling the stored receipts carry, with their items', async () => {
    const getRows = vi.fn().mockResolvedValue({
      items: [
        { id: 'a', cells: { v: 'Apple', i: 'iCloud+ 2 TB', c: 'soft' } },
        { id: 'b', cells: { v: 'Apple', i: 'iCloud+ 2 TB', c: 'soft' } },
        { id: 'c', cells: { v: 'Apple Distribution International Ltd.', i: 'iCloud+ mit 2 TB', c: 'soft' } },
      ],
      hasMore: false,
    });
    const known = await knownVendor({ getColumns: async () => COLUMNS, getRows, getSelectOptions }, 't', 'Apple Distribution International Ltd.');
    expect(getRows.mock.calls[0][1].filters[0].value).toBe('Apple');
    expect(known).toEqual({ spelling: 'Apple', items: ['iCloud+ 2 TB', 'iCloud+ mit 2 TB'] });
  });

  it("a restaurant's receipts are never the spelling of another vendor", async () => {
    const getRows = vi.fn().mockResolvedValue({
      items: [
        { id: 'a', cells: { v: 'Example Cafe', i: null, c: 'meal' } },
        { id: 'b', cells: { v: 'Example Cafe', i: null, c: 'meal' } },
        { id: 'c', cells: { v: 'Example', i: 'Team-Abo', c: 'soft' } },
      ],
      hasMore: false,
    });
    // "Example" has one receipt and "Example Cafe" two, but the cafe's are meals.
    expect(await knownVendor({ getColumns: async () => COLUMNS, getRows, getSelectOptions }, 't', 'Example')).toEqual({ spelling: 'Example', items: ['Team-Abo'] });
  });

  it('pages through the rows', async () => {
    const getRows = vi
      .fn()
      .mockResolvedValueOnce({ items: [{ id: 'a', cells: { v: 'Muster', i: 'Eins' } }], hasMore: true })
      .mockResolvedValueOnce({ items: [{ id: 'b', cells: { v: 'Muster', i: 'Zwei' } }], hasMore: false });
    expect(await knownVendor({ getColumns: async () => COLUMNS, getRows, getSelectOptions }, 't', 'Muster')).toEqual({ spelling: 'Muster', items: ['Eins', 'Zwei'] });
    expect(getRows).toHaveBeenCalledTimes(2);
  });

  it('no vendor, no item column or a failing database: nothing known, and the failure is logged', async () => {
    const getRows = vi.fn();
    const nothing = { spelling: null, items: [] };
    expect(await knownVendor({ getColumns: async () => COLUMNS, getRows, getSelectOptions }, 't', null)).toEqual(nothing);
    expect(await knownVendor({ getColumns: async () => [COLUMNS[0]], getRows, getSelectOptions }, 't', 'Muster')).toEqual(nothing);
    expect(getRows).not.toHaveBeenCalled();
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const failing = vi.fn().mockRejectedValue(new Error('connection lost'));
    expect(await knownVendor({ getColumns: async () => COLUMNS, getRows: failing, getSelectOptions }, 't', 'Muster')).toEqual(nothing);
    expect(log).toHaveBeenCalled();
    log.mockRestore();
  });
});
