import { describe, it, expect } from 'vitest';
import { buildCells, type ColumnLike } from './build-cells';
import type { NormalizedRow } from './normalize';

const COLUMNS: ColumnLike[] = [
  { id: 'c_vendor', name: 'Vendor', type: 'text' },
  { id: 'c_gross', name: 'Gross', type: 'number' },
  { id: 'c_date', name: 'Date', type: 'date' },
  { id: 'c_category', name: 'Category', type: 'select' },
  { id: 'c_konto', name: 'Konto', type: 'text' },
  { id: 'c_currency', name: 'Currency', type: 'select' },
  { id: 'c_fx', name: 'FX Rate', type: 'number' },
  { id: 'c_status', name: 'Status', type: 'select' },
];

const OPTIONS = {
  Category: { Bewirtung: 'opt_bew', Reisekosten: 'opt_reise' },
  Currency: { EUR: 'opt_eur', USD: 'opt_usd' },
  Status: { Pending: 'opt_pending', Imported: 'opt_imported' },
};

describe('buildCells', () => {
  it('maps values and resolves select options to ids', () => {
    const mapped: NormalizedRow = { Vendor: 'Anthropic', Gross: 1234.56, Date: '2026-07-20', Category: 'Bewirtung', Currency: 'USD' };
    const cells = buildCells(mapped, COLUMNS, OPTIONS);
    expect(cells.c_vendor).toBe('Anthropic');
    expect(cells.c_gross).toBe(1234.56);
    expect(cells.c_date).toBe('2026-07-20');
    expect(cells.c_category).toBe('opt_bew');
    expect(cells.c_currency).toBe('opt_usd');
  });

  it('auto-derives Konto from Category when Konto is not mapped', () => {
    const cells = buildCells({ Category: 'Bewirtung' }, COLUMNS, OPTIONS);
    expect(cells.c_konto).toBe('4650'); // CATEGORY_TO_KONTO['Bewirtung']
  });

  it('keeps an explicitly mapped Konto over the derived one', () => {
    const cells = buildCells({ Category: 'Bewirtung', Konto: '9999' }, COLUMNS, OPTIONS);
    expect(cells.c_konto).toBe('9999');
  });

  it('sets null for an unknown select value, and does not touch unmapped columns', () => {
    const cells = buildCells({ Category: 'DoesNotExist' }, COLUMNS, OPTIONS);
    expect(cells.c_category).toBeNull();
    expect('c_vendor' in cells).toBe(false); // Vendor wasn't mapped
    expect('c_gross' in cells).toBe(false);
  });

  it('injects fxRate and a default status option id', () => {
    const cells = buildCells({ Vendor: 'X' }, COLUMNS, OPTIONS, { fxRate: 1.08, statusOptionId: 'opt_imported' });
    expect(cells.c_fx).toBe(1.08);
    expect(cells.c_status).toBe('opt_imported');
  });

  it('does not override a mapped Status with the injected default', () => {
    const cells = buildCells({ Status: 'Pending' }, COLUMNS, OPTIONS, { statusOptionId: 'opt_imported' });
    expect(cells.c_status).toBe('opt_pending');
  });
});
