import type { NormalizedRow, ImportableField } from './normalize';
import { CATEGORY_TO_KONTO } from '@/lib/receipts-constants';

/** The dt_rows cell values this importer produces (a subset of the adapter's CellValue). */
export type ImportCellValue = string | number | null;

export interface ColumnLike {
  id: string;
  name: string;
  type: string;
}

// Receipts columns that are `select` type: their text value must resolve to an
// option id before it can be stored.
const SELECT_FIELDS = new Set<ImportableField>(['Category', 'Status', 'Zuordnung', 'Currency', 'Project']);

/**
 * Build a `dt_rows` cell map (columnId -> value) from a normalized sheet row.
 *
 * - Select fields resolve their text to the matching option id (unknown -> null).
 * - Konto auto-fills from the Category->Konto mapping when it isn't mapped explicitly.
 * - FX Rate and a default Status option id are injected by the caller (they need
 *   async lookups / policy the pure builder shouldn't own).
 *
 * Only mapped fields (plus the derived Konto) are written, so unmapped columns
 * on an existing row are left untouched on re-import.
 */
export function buildCells(
  mapped: NormalizedRow,
  columns: ColumnLike[],
  optionIdByName: Record<string, Record<string, string>>,
  extra?: { fxRate?: number | null; statusOptionId?: string | null },
): Record<string, ImportCellValue> {
  const cells: Record<string, ImportCellValue> = {};
  const byName = new Map(columns.map((c) => [c.name, c]));

  const kontoMapped = mapped.Konto != null && String(mapped.Konto).trim() !== '';
  const konto = kontoMapped
    ? String(mapped.Konto)
    : typeof mapped.Category === 'string'
      ? (CATEGORY_TO_KONTO[mapped.Category] ?? null)
      : null;

  for (const col of columns) {
    const field = col.name as ImportableField;

    if (field === 'Konto') {
      if (konto != null) cells[col.id] = konto;
      continue;
    }
    if (!(field in mapped)) continue;

    const raw = mapped[field];
    if (SELECT_FIELDS.has(field)) {
      const name = raw == null ? '' : String(raw);
      cells[col.id] = name ? (optionIdByName[col.name]?.[name] ?? null) : null;
    } else {
      cells[col.id] = raw ?? null;
    }
  }

  const fxCol = byName.get('FX Rate');
  if (fxCol && extra?.fxRate != null) cells[fxCol.id] = extra.fxRate;

  const statusCol = byName.get('Status');
  if (statusCol && extra?.statusOptionId && cells[statusCol.id] == null) {
    cells[statusCol.id] = extra.statusOptionId;
  }

  return cells;
}
