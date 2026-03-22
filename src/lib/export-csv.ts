import type { Column, Row, CellValue } from '@marlinjai/data-table-core';

/**
 * DATEV-compatible CSV column mapping.
 * Maps internal column names to DATEV headers.
 */
const DATEV_HEADERS = [
  'Datum',
  'Belegnummer',
  'Buchungstext',
  'Betrag Brutto',
  'Betrag Netto',
  'Steuersatz',
  'Konto',
  'Gegenkonto',
  'Kategorie',
  'Zuordnung',
] as const;

/**
 * Column name mapping from internal names to DATEV header positions.
 */
const COLUMN_NAME_MAP: Record<string, string> = {
  'Date': 'Datum',
  'Datum': 'Datum',
  'Name': 'Buchungstext',
  'Buchungstext': 'Buchungstext',
  'Gross': 'Betrag Brutto',
  'Brutto': 'Betrag Brutto',
  'Betrag Brutto': 'Betrag Brutto',
  'Total': 'Betrag Brutto',
  'Net': 'Betrag Netto',
  'Netto': 'Betrag Netto',
  'Betrag Netto': 'Betrag Netto',
  'Tax Rate': 'Steuersatz',
  'Steuersatz': 'Steuersatz',
  'Tax': 'Steuersatz',
  'Account': 'Konto',
  'Konto': 'Konto',
  'SKR03': 'Konto',
  'Counter Account': 'Gegenkonto',
  'Gegenkonto': 'Gegenkonto',
  'Category': 'Kategorie',
  'Kategorie': 'Kategorie',
  'Assignment': 'Zuordnung',
  'Zuordnung': 'Zuordnung',
};

/**
 * Format a date value as DD.MM.YYYY
 */
function formatDateDE(value: CellValue): string {
  if (!value) return '';
  const date = value instanceof Date ? value : new Date(String(value));
  if (isNaN(date.getTime())) return String(value);
  const day = String(date.getDate()).padStart(2, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const year = date.getFullYear();
  return `${day}.${month}.${year}`;
}

/**
 * Format a number with German locale (comma as decimal separator)
 */
function formatNumberDE(value: CellValue): string {
  if (value === null || value === undefined || value === '') return '';
  const num = typeof value === 'number' ? value : parseFloat(String(value));
  if (isNaN(num)) return String(value);
  return num.toFixed(2).replace('.', ',');
}

/**
 * Escape a CSV field value for semicolon-delimited CSV.
 * Wraps in quotes if the value contains semicolons, quotes, or newlines.
 */
function escapeCSVField(value: string): string {
  if (value.includes(';') || value.includes('"') || value.includes('\n') || value.includes('\r')) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

/**
 * Convert a cell value to a plain string.
 */
function cellToString(value: CellValue): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'boolean') return value ? 'Ja' : 'Nein';
  if (value instanceof Date) return formatDateDE(value);
  if (Array.isArray(value)) {
    return value.map((v) => (typeof v === 'string' ? v : (v as { displayValue?: string }).displayValue ?? '')).join(', ');
  }
  return String(value);
}

/**
 * Build a mapping from DATEV header to column ID, based on the table's columns.
 */
function buildColumnMapping(columns: Column[]): Record<string, string | null> {
  const mapping: Record<string, string | null> = {};
  for (const header of DATEV_HEADERS) {
    mapping[header] = null;
  }

  for (const col of columns) {
    const datevHeader = COLUMN_NAME_MAP[col.name];
    if (datevHeader && mapping[datevHeader] === null) {
      mapping[datevHeader] = col.id;
    }
  }

  return mapping;
}

/**
 * Determine if a DATEV header expects number formatting.
 */
function isNumberHeader(header: string): boolean {
  return header === 'Betrag Brutto' || header === 'Betrag Netto' || header === 'Steuersatz';
}

/**
 * Determine if a DATEV header expects date formatting.
 */
function isDateHeader(header: string): boolean {
  return header === 'Datum';
}

export interface ExportCSVOptions {
  columns: Column[];
  rows: Row[];
  filename?: string;
}

/**
 * Generate a DATEV-compatible CSV string from rows and columns.
 * Uses semicolon delimiter, German number formatting, and UTF-8 BOM.
 */
export function generateCSV(columns: Column[], rows: Row[]): string {
  const mapping = buildColumnMapping(columns);

  // Header row
  const headerLine = DATEV_HEADERS.map((h) => escapeCSVField(h)).join(';');

  // Data rows
  const dataLines = rows.map((row) => {
    const fields = DATEV_HEADERS.map((header) => {
      if (header === 'Belegnummer') {
        return escapeCSVField(row.id);
      }

      const colId = mapping[header];
      if (!colId) return '';

      const value = row.cells[colId];

      if (isDateHeader(header)) {
        return escapeCSVField(formatDateDE(value));
      }

      if (isNumberHeader(header)) {
        return escapeCSVField(formatNumberDE(value));
      }

      return escapeCSVField(cellToString(value));
    });

    return fields.join(';');
  });

  return [headerLine, ...dataLines].join('\r\n');
}

/**
 * Export rows as a DATEV-compatible CSV file and trigger browser download.
 */
export function exportCSV({ columns, rows, filename }: ExportCSVOptions): void {
  const csv = generateCSV(columns, rows);

  // UTF-8 BOM for Excel compatibility
  const BOM = '\uFEFF';
  const blob = new Blob([BOM + csv], { type: 'text/csv;charset=utf-8;' });

  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename ?? `export-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}
