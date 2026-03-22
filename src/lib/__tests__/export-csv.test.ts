import { describe, it, expect } from 'vitest';
import { generateCSV } from '../export-csv';
import type { Column, Row } from '@marlinjai/data-table-core';

function makeColumn(overrides: Partial<Column> & { id: string; name: string; type: Column['type'] }): Column {
  return {
    tableId: 'table-1',
    position: 0,
    width: 150,
    isPrimary: false,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as Column;
}

function makeRow(id: string, cells: Record<string, unknown>): Row {
  return {
    id,
    tableId: 'table-1',
    cells: cells as Row['cells'],
    archived: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

const columns: Column[] = [
  makeColumn({ id: 'col-date', name: 'Date', type: 'date' }),
  makeColumn({ id: 'col-name', name: 'Name', type: 'text' }),
  makeColumn({ id: 'col-gross', name: 'Gross', type: 'number' }),
  makeColumn({ id: 'col-net', name: 'Net', type: 'number' }),
  makeColumn({ id: 'col-tax', name: 'Tax Rate', type: 'number' }),
  makeColumn({ id: 'col-account', name: 'Account', type: 'text' }),
  makeColumn({ id: 'col-counter', name: 'Gegenkonto', type: 'text' }),
  makeColumn({ id: 'col-category', name: 'Category', type: 'text' }),
  makeColumn({ id: 'col-assign', name: 'Zuordnung', type: 'text' }),
];

const rows: Row[] = [
  makeRow('row-001', {
    'col-date': '2024-03-15',
    'col-name': 'Office Supplies',
    'col-gross': 119.99,
    'col-net': 100.83,
    'col-tax': 19,
    'col-account': '4930',
    'col-counter': '1200',
    'col-category': 'Office',
    'col-assign': 'Q1-2024',
  }),
  makeRow('row-002', {
    'col-date': '2024-12-01',
    'col-name': 'Software License',
    'col-gross': 238.00,
    'col-net': 200.00,
    'col-tax': 19,
    'col-account': '4964',
    'col-counter': '1200',
    'col-category': 'Software',
    'col-assign': 'Q4-2024',
  }),
];

describe('generateCSV', () => {
  it('should produce correct DATEV headers with semicolon delimiters', () => {
    const csv = generateCSV(columns, rows);
    const headerLine = csv.split('\r\n')[0];
    expect(headerLine).toBe(
      'Datum;Belegnummer;Buchungstext;Betrag Brutto;Betrag Netto;Steuersatz;Konto;Gegenkonto;Kategorie;Zuordnung'
    );
  });

  it('should use semicolon as delimiter throughout', () => {
    const csv = generateCSV(columns, rows);
    const lines = csv.split('\r\n');
    for (const line of lines) {
      // Each line should have exactly 9 semicolons (10 fields)
      const semicolonCount = (line.match(/;/g) || []).length;
      expect(semicolonCount).toBe(9);
    }
  });

  it('should format dates as DD.MM.YYYY', () => {
    const csv = generateCSV(columns, rows);
    const dataLine = csv.split('\r\n')[1];
    const fields = dataLine.split(';');
    expect(fields[0]).toBe('15.03.2024');
  });

  it('should use German number formatting (comma as decimal separator)', () => {
    const csv = generateCSV(columns, rows);
    const dataLine = csv.split('\r\n')[1];
    const fields = dataLine.split(';');
    // Betrag Brutto
    expect(fields[3]).toBe('119,99');
    // Betrag Netto
    expect(fields[4]).toBe('100,83');
    // Steuersatz
    expect(fields[5]).toBe('19,00');
  });

  it('should use row ID as Belegnummer', () => {
    const csv = generateCSV(columns, rows);
    const dataLine = csv.split('\r\n')[1];
    const fields = dataLine.split(';');
    expect(fields[1]).toBe('row-001');
  });

  it('should map Name column to Buchungstext', () => {
    const csv = generateCSV(columns, rows);
    const dataLine = csv.split('\r\n')[1];
    const fields = dataLine.split(';');
    expect(fields[2]).toBe('Office Supplies');
  });

  it('should include all rows', () => {
    const csv = generateCSV(columns, rows);
    const lines = csv.split('\r\n');
    // 1 header + 2 data rows
    expect(lines.length).toBe(3);
  });

  it('should use CRLF line endings', () => {
    const csv = generateCSV(columns, rows);
    expect(csv).toContain('\r\n');
    // Should not have standalone \n without \r
    const withoutCRLF = csv.replace(/\r\n/g, '');
    expect(withoutCRLF).not.toContain('\n');
  });

  it('should handle empty rows array', () => {
    const csv = generateCSV(columns, []);
    const lines = csv.split('\r\n');
    expect(lines.length).toBe(1); // header only
  });

  it('should handle null cell values gracefully', () => {
    const rowWithNulls = makeRow('row-null', {
      'col-date': null,
      'col-name': null,
      'col-gross': null,
    });
    const csv = generateCSV(columns, [rowWithNulls]);
    const dataLine = csv.split('\r\n')[1];
    const fields = dataLine.split(';');
    expect(fields[0]).toBe(''); // null date
    expect(fields[2]).toBe(''); // null name
    expect(fields[3]).toBe(''); // null gross
  });

  it('should escape fields containing semicolons', () => {
    const rowWithSemicolon = makeRow('row-sc', {
      'col-name': 'Item; with semicolon',
    });
    const csv = generateCSV(columns, [rowWithSemicolon]);
    const dataLine = csv.split('\r\n')[1];
    expect(dataLine).toContain('"Item; with semicolon"');
  });
});
