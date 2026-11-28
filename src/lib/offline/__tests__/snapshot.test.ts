import { describe, expect, it } from 'vitest';
import type { Row } from '@marlinjai/data-table-core';
import { offlineReceipts } from '../snapshot';

const columns = ['Name', 'Vendor', 'Gross', 'FX Rate', 'EUR Equivalent', 'Date', 'Category', 'Status', 'Zuordnung', 'Currency', 'OCR Text'].map((name) => ({ id: `c-${name}`, name }));
const options = new Map([
  ['c-Category', [{ id: 'o-food', name: 'Lebensmittel' }]],
  ['c-Status', [{ id: 'o-pending', name: 'Pending' }, { id: 'o-odd', name: 'Später' }]],
  ['c-Zuordnung', [{ id: 'o-biz', name: 'Geschäftlich' }]],
  ['c-Currency', [{ id: 'o-chf', name: 'CHF' }]],
]);

function row(id: string, cells: Record<string, unknown>, archived = false): Row {
  return { id, tableId: 't', cells: Object.fromEntries(Object.entries(cells).map(([k, v]) => [`c-${k}`, v])), archived } as unknown as Row;
}

describe('offlineReceipts', () => {
  it('turns option ids into labels, says the status in German and leaves the receipt text behind', () => {
    const [r] = offlineReceipts(
      [row('r1', { Name: ' Coop ', Vendor: 'Coop AG', Gross: 12.5, 'FX Rate': 1.06, Date: '2026-11-02', Category: 'o-food', Status: 'o-pending', Zuordnung: 'o-biz', Currency: 'o-chf', 'OCR Text': 'secret text' })],
      columns,
      options,
    );
    expect(r).toEqual({ id: 'r1', date: '2026-11-02', name: 'Coop', vendor: 'Coop AG', gross: 12.5, currency: 'CHF', eur: 13.25, category: 'Lebensmittel', status: 'Offen', assignment: 'Geschäftlich' });
    expect(JSON.stringify(r)).not.toContain('secret');
  });

  it('keeps an unknown status as it is, and missing or broken values as null', () => {
    const [r] = offlineReceipts([row('r2', { Status: 'o-odd', Gross: 'twelve', Date: 'gestern', Category: 'o-gone' })], columns, options);
    expect(r).toMatchObject({ status: 'Später', gross: null, eur: null, date: null, category: null, name: null, currency: null });
  });

  it('prefers the computed euro amount, and takes a missing rate as euro', () => {
    const rows = [row('a', { Gross: 10, 'EUR Equivalent': 9.5, 'FX Rate': 2 }), row('b', { Gross: 10 })];
    expect(offlineReceipts(rows, columns, options).map((r) => r.eur).sort()).toEqual([10, 9.5].sort());
  });

  it('lists newest first, receipts without a date last, archived rows not at all', () => {
    const rows = [row('old', { Date: '2025-01-01' }), row('none', {}), row('new', { Date: '2026-03-01' }), row('gone', { Date: '2026-12-01' }, true)];
    expect(offlineReceipts(rows, columns, options).map((r) => r.id)).toEqual(['new', 'old', 'none']);
  });
});
