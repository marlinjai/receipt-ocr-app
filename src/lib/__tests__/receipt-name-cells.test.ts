import { describe, expect, it } from 'vitest';
import { nameFromCells, touchesNameParts, withFollowingName } from '../receipt-name-cells';

const COLUMNS = ['Name', 'Vendor', 'Item', 'Gross', 'Currency', 'Date', 'Konto'].map((name) => ({ id: `c-${name}`, name }));
const adapter = { getSelectOptions: async () => [{ id: 'eur', name: 'EUR' }, { id: 'usd', name: 'USD' }] };
const stored = {
  'c-Name': 'Example Software Ireland Ltd, 23,80 $, 01.02.2024',
  'c-Vendor': 'Example Software Ireland Ltd',
  'c-Gross': 23.8,
  'c-Currency': 'usd',
  'c-Date': '2024-02-01T00:00:00.000Z',
};

describe('a name that follows its cells', () => {
  it('knows which writes change a part of the name', () => {
    expect(touchesNameParts(COLUMNS, { 'c-Vendor': 'Example' })).toBe(true);
    expect(touchesNameParts(COLUMNS, { 'c-Item': 'Plus' })).toBe(true);
    expect(touchesNameParts(COLUMNS, { 'c-Konto': '4806' })).toBe(false);
    // A write that sets the name itself is the person's word on the name.
    expect(touchesNameParts(COLUMNS, { 'c-Vendor': 'Example', 'c-Name': 'Mein Name' })).toBe(false);
  });

  it('builds the name from the cells, the currency by its option', async () => {
    expect(await nameFromCells(adapter, COLUMNS, { ...stored, 'c-Item': 'Example Plus' })).toBe('Example Software Ireland Ltd, Example Plus, 23,80 $, 01.02.2024');
    expect(await nameFromCells(adapter, COLUMNS, { 'c-Gross': '12', 'c-Date': new Date('2025-01-02T00:00:00.000Z') })).toBe('12,00 €, 02.01.2025');
    expect(await nameFromCells(adapter, COLUMNS, {})).toBe('');
  });

  it('takes the name along when the vendor, the total or the date is corrected', async () => {
    expect(await withFollowingName(adapter, COLUMNS, { 'c-Vendor': 'Example' }, stored)).toEqual({ 'c-Vendor': 'Example', 'c-Name': 'Example, 23,80 $, 01.02.2024' });
    expect(await withFollowingName(adapter, COLUMNS, { 'c-Gross': 106.24, 'c-Currency': 'eur' }, stored)).toEqual({
      'c-Gross': 106.24,
      'c-Currency': 'eur',
      'c-Name': 'Example Software Ireland Ltd, 106,24 €, 01.02.2024',
    });
  });

  it('leaves a typed name, a write that is not about the name, and a row it does not know', async () => {
    const typed = { ...stored, 'c-Name': 'Abo für das Studio' };
    expect(await withFollowingName(adapter, COLUMNS, { 'c-Vendor': 'Example' }, typed)).toEqual({ 'c-Vendor': 'Example' });
    expect(await withFollowingName(adapter, COLUMNS, { 'c-Konto': '4806' }, stored)).toEqual({ 'c-Konto': '4806' });
    expect(await withFollowingName(adapter, COLUMNS, { 'c-Vendor': 'Example' }, null)).toEqual({ 'c-Vendor': 'Example' });
  });

  it('never empties a name: cells that make none keep the one that is there', async () => {
    const onlyVendor = { 'c-Name': 'Nicht lesbar: scan.pdf', 'c-Vendor': 'Example' };
    expect(await withFollowingName(adapter, COLUMNS, { 'c-Vendor': '' }, onlyVendor)).toEqual({ 'c-Vendor': '' });
    expect(await withFollowingName(adapter, COLUMNS, { 'c-Gross': 5 }, onlyVendor)).toEqual({ 'c-Gross': 5, 'c-Name': 'Example, 5,00 €' });
  });
});
