/**
 * Client-safe field definitions for the Sheets importer (no Node builtins, so
 * this can be imported by the mapping UI). The parsing/dedup logic that needs
 * `node:crypto` lives in `normalize.ts`, which re-exports these.
 */

// The Receipts fields an import can populate, with the value type used to parse
// the raw cell. Formula columns (EUR Equivalent, Attributed EUR), FX Rate, and
// OCR-only columns (Confidence, OCR Text, Receipt Image) are excluded: they are
// computed or scan-derived, never mapped from a sheet.
export const IMPORTABLE_FIELDS = {
  Name: 'text',
  Vendor: 'text',
  Gross: 'number',
  Net: 'number',
  'Tax Rate': 'number',
  Date: 'date',
  Category: 'text',
  Konto: 'text',
  Status: 'text',
  Zuordnung: 'text',
  Currency: 'text',
  'Business Share %': 'number',
  Project: 'text',
} as const;

export type ImportableField = keyof typeof IMPORTABLE_FIELDS;

/** Column mapping: Receipts field -> the sheet's header name for it. */
export type ColumnMapping = Partial<Record<ImportableField, string>>;

export type NormalizedRow = Partial<Record<ImportableField, string | number | null>>;

export const IMPORTABLE_FIELD_NAMES = Object.keys(IMPORTABLE_FIELDS) as ImportableField[];
