import { describe, it, expect } from 'vitest';
import { isoDay, rowToMealRecord, type SelectOptionsByColumn } from '../record';
import { mealStatus } from '../rules';
import { GUEST_A } from './fixtures';

const COLUMNS = [
  'Name', 'Vendor', 'Gross', 'Net', 'Tax Rate', 'Date', 'Category', 'Zuordnung', 'Currency', 'FX Rate',
  'Confidence', 'Receipt Image', 'Meal Type', 'Occasion', 'Place', 'Tip', 'Host', 'Consumption',
  'Meal Details At', 'Tax Lines',
].map((name) => ({ id: `col-${name}`, name }));

const OPTIONS: SelectOptionsByColumn = new Map([
  ['col-Category', [{ id: 'cat-bew', name: 'Bewirtung' }, { id: 'cat-reise', name: 'Reisekosten' }]],
  ['col-Zuordnung', [{ id: 'z-g', name: 'Geschäftlich' }, { id: 'z-p', name: 'Privat' }]],
  ['col-Currency', [{ id: 'cur-eur', name: 'EUR' }, { id: 'cur-usd', name: 'USD' }]],
  ['col-Meal Type', [{ id: 'mt-ext', name: 'Geschäftsessen (extern)' }, { id: 'mt-none', name: 'Keine Bewirtung' }]],
  ['col-Consumption', [{ id: 'con-in', name: 'Vor Ort' }, { id: 'con-out', name: 'Außer Haus' }]],
]);

function row(cells: Record<string, unknown>) {
  const mapped: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(cells)) mapped[`col-${name}`] = value;
  return { id: 'row-1', cells: mapped as never };
}

describe('rowToMealRecord', () => {
  it('resolves select option ids to names and keys', () => {
    const record = rowToMealRecord(
      row({
        Name: 'Mittagessen',
        Vendor: 'Testlokal',
        Gross: 59.5,
        Date: '2025-03-14T00:00:00.000Z',
        Category: 'cat-bew',
        Zuordnung: 'z-g',
        Currency: 'cur-usd',
        'FX Rate': 0.92,
        'Meal Type': 'mt-ext',
        Occasion: 'Planung Messeauftritt',
        Place: 'Testlokal, Musterstadt',
        Tip: 5,
        Host: 'Inhaber Beispiel',
        Consumption: 'con-in',
        'Tax Lines': '[{"rate":19,"net":50,"tax":9.5}]',
        'Meal Details At': '2025-03-15T08:00:00.000Z',
        'Receipt Image': [
          { id: 'ref-1', rowId: 'row-1', columnId: 'c', fileId: 'f-1', fileUrl: '/api/files/f-1', originalName: 'a.jpg', mimeType: 'image/jpeg', position: 0 },
        ],
      }),
      COLUMNS,
      OPTIONS,
      [GUEST_A],
    );
    expect(record).toMatchObject({
      rowId: 'row-1',
      date: '2025-03-14',
      category: 'Bewirtung',
      zuordnung: 'Geschäftlich',
      currency: 'USD',
      fxRate: 0.92,
      mealType: 'business_meal_external',
      consumption: 'dine_in',
      tip: 5,
      taxLines: [{ rate: 19, net: 50, tax: 9.5 }],
      detailsAt: '2025-03-15T08:00:00.000Z',
      guests: [GUEST_A],
      files: [{ fileId: 'f-1', fileUrl: '/api/files/f-1', mimeType: 'image/jpeg', originalName: 'a.jpg' }],
    });
    expect(mealStatus(record)).toEqual({ kind: 'complete' });
  });

  it('a row with none of the meal cells maps to empty facts, without throwing', () => {
    const record = rowToMealRecord(row({ Category: 'cat-bew', Gross: 20, Date: '2025-01-02' }), COLUMNS, OPTIONS, []);
    expect(record).toMatchObject({
      mealType: null,
      occasion: '',
      place: '',
      host: '',
      tip: null,
      consumption: null,
      taxLines: null,
      detailsAt: null,
      currency: 'EUR',
      files: [],
    });
    expect(mealStatus(record).kind).toBe('incomplete');
  });

  it('an option id that no longer exists reads as unset, not as the raw id', () => {
    const record = rowToMealRecord(row({ Category: 'gone', 'Meal Type': 'gone' }), COLUMNS, OPTIONS, []);
    expect(record.category).toBeNull();
    expect(record.mealType).toBeNull();
  });

  it('tolerates a table that does not have the meal columns yet', () => {
    const record = rowToMealRecord(
      { id: 'r', cells: { 'col-Category': 'cat-bew' } as never },
      [{ id: 'col-Category', name: 'Category' }],
      OPTIONS,
      [],
    );
    expect(record.category).toBe('Bewirtung');
    expect(record.mealType).toBeNull();
  });
});

describe('isoDay', () => {
  it('normalizes strings and dates', () => {
    expect(isoDay('2025-03-14')).toBe('2025-03-14');
    expect(isoDay('2025-03-14T22:30:00.000Z')).toBe('2025-03-14');
    expect(isoDay(new Date('2025-03-14T10:00:00.000Z'))).toBe('2025-03-14');
    expect(isoDay('')).toBeNull();
    expect(isoDay('nonsense')).toBeNull();
    expect(isoDay(null)).toBeNull();
  });
});
