import { describe, expect, it, vi } from 'vitest';
import type { CellValue } from '@marlinjai/data-table-core';
import { fillReceiptItems, type ItemsAdapter } from '../receipt-items';
import { ROW_KIND_COLUMN, GROUP_KIND } from '../receipts-kind';

const COLUMNS = ['Name', 'Vendor', 'Item', 'Gross', 'Currency', 'Date', 'Category', 'OCR Text', ROW_KIND_COLUMN].map((name) => ({ id: `c-${name}`, name }));
const c = (name: string) => `c-${name}`;

function table(rows: Record<string, Record<string, CellValue>>) {
  const stored = new Map(Object.entries(rows).map(([id, byName]) => [id, Object.fromEntries(Object.entries(byName).map(([name, value]) => [c(name), value]))]));
  const adapter: ItemsAdapter = {
    getRow: async (id) => (stored.has(id) ? { id, tableId: 't1', cells: stored.get(id)! } : null),
    getColumns: async () => COLUMNS,
    getSelectOptions: async (columnId) =>
      columnId === c('Currency') ? [{ id: 'eur', name: 'EUR' }, { id: 'usd', name: 'USD' }] : columnId === c('Category') ? [{ id: 'meal', name: 'Bewirtung' }, { id: 'soft', name: 'Software & Lizenzen' }] : [],
    updateRow: async (id, cells) => {
      stored.set(id, { ...stored.get(id)!, ...cells });
    },
  };
  const cell = (id: string, name: string) => stored.get(id)![c(name)];
  return { adapter, cell };
}

const receipt = (extra: Record<string, CellValue> = {}): Record<string, CellValue> => ({
  Name: 'Example Software Ireland Ltd, 23,80 $, 01.02.2024',
  Vendor: 'Example',
  Gross: 23.8,
  Currency: 'usd',
  Date: '2024-02-01T00:00:00.000Z',
  Category: 'soft',
  'OCR Text': 'Example Plus subscription 23.80',
  ...extra,
});

describe('giving stored receipts what was bought', () => {
  it('reads the item from the stored text and builds the name from the row as it is now', async () => {
    const { adapter, cell } = table({ r1: receipt() });
    const read = vi.fn(async () => 'Example Plus');
    const [result] = await fillReceiptItems(adapter, 't1', ['r1'], read);
    expect(read).toHaveBeenCalledWith({ vendor: 'Example', fullText: 'Example Plus subscription 23.80' });
    expect(result).toEqual({ rowId: 'r1', outcome: 'filled', item: 'Example Plus', renamedTo: 'Example, Example Plus, 23,80 $, 01.02.2024' });
    expect(cell('r1', 'Item')).toBe('Example Plus');
    // The corrected vendor is in the name now; vendor, total and date were not read again.
    expect(cell('r1', 'Name')).toBe('Example, Example Plus, 23,80 $, 01.02.2024');
    expect(cell('r1', 'Vendor')).toBe('Example');
    expect(cell('r1', 'Gross')).toBe(23.8);
  });

  it('keeps an item the row already holds and asks no model for it', async () => {
    const { adapter, cell } = table({ r1: receipt({ Item: 'Jahresabo' }) });
    const read = vi.fn(async () => 'something else');
    const [result] = await fillReceiptItems(adapter, 't1', ['r1'], read);
    expect(read).not.toHaveBeenCalled();
    expect(result.outcome).toBe('kept');
    expect(cell('r1', 'Name')).toBe('Example, Jahresabo, 23,80 $, 01.02.2024');
  });

  it('leaves a name a person typed, and still stores the item', async () => {
    const { adapter, cell } = table({ r1: receipt({ Name: 'Abo für das Studio' }) });
    const [result] = await fillReceiptItems(adapter, 't1', ['r1'], async () => 'Example Plus');
    expect(result).toMatchObject({ outcome: 'filled', renamedTo: null });
    expect(cell('r1', 'Name')).toBe('Abo für das Studio');
    expect(cell('r1', 'Item')).toBe('Example Plus');
  });

  it('does not touch a meal, a group or a row of another table', async () => {
    const { adapter, cell } = table({
      meal: receipt({ Category: 'meal', Name: 'Gasthaus, 40,00 €, 01.02.2024' }),
      group: receipt({ [ROW_KIND_COLUMN]: GROUP_KIND, Name: 'Reise' }),
    });
    const read = vi.fn(async () => 'x item');
    const results = await fillReceiptItems(adapter, 't1', ['meal', 'group', 'gone'], read);
    expect(results.map((r) => r.outcome)).toEqual(['meal', 'not_found', 'not_found']);
    expect(read).not.toHaveBeenCalled();
    expect(cell('meal', 'Name')).toBe('Gasthaus, 40,00 €, 01.02.2024');
    expect(cell('group', 'Name')).toBe('Reise');
  });

  it('says so when there is no text or the model names nothing, and still brings the name up to date', async () => {
    const { adapter, cell } = table({ blank: receipt({ 'OCR Text': '' }), none: receipt() });
    const results = await fillReceiptItems(adapter, 't1', ['blank', 'none'], async () => null);
    expect(results.map((r) => r.outcome)).toEqual(['no_text', 'no_item']);
    expect(cell('blank', 'Name')).toBe('Example, 23,80 $, 01.02.2024');
    expect(cell('none', 'Item')).toBeUndefined();
  });

  it('leaves the row exactly as it was when the model cannot be asked, so it can be sent again', async () => {
    const { adapter, cell } = table({ r1: receipt() });
    const [result] = await fillReceiptItems(adapter, 't1', ['r1', 'r1'], async () => {
      throw new Error('rate limited');
    });
    expect(result).toEqual({ rowId: 'r1', outcome: 'failed', item: null, renamedTo: null });
    expect(cell('r1', 'Name')).toBe('Example Software Ireland Ltd, 23,80 $, 01.02.2024');
  });
});
