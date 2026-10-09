import type { Column, FileReference, Row, SelectOption } from '@marlinjai/data-table-core';
import {
  MEAL_COLUMNS,
  consumptionKeyFromLabel,
  mealTypeKeyFromLabel,
} from '@/lib/receipts-constants';
import { firstColumnIdByName } from '@/lib/column-lookup';
import { placeFromReceiptText } from './place';
import { parseTaxLines } from './rules';
import { parseRotation } from './viewer-state';
import type { MealGuestEntry, MealRecord } from './types';

/**
 * The ONE mapper from a receipt row to the facts the meal rules work on.
 * Select cells hold option ids; the rules need option names, so they are
 * resolved here and nowhere else.
 */

export type SelectOptionsByColumn = Map<string, Pick<SelectOption, 'id' | 'name'>[]>;

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function textOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function numberOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Normalize a date cell (ISO string with or without time, or a Date) to `YYYY-MM-DD`. */
export function isoDay(value: unknown): string | null {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString().slice(0, 10);
  }
  if (typeof value !== 'string' || !value.trim()) return null;
  const direct = /^(\d{4}-\d{2}-\d{2})/.exec(value.trim());
  if (direct) return direct[1];
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString().slice(0, 10);
}

function isoTimestamp(value: unknown): string | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (typeof value !== 'string' || !value.trim()) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

export function rowToMealRecord(
  row: Pick<Row, 'id' | 'cells'>,
  columns: Pick<Column, 'id' | 'name'>[],
  selectOptions: SelectOptionsByColumn,
  guests: MealGuestEntry[],
): MealRecord {
  const byName = firstColumnIdByName(columns);
  const cell = (name: string): unknown => {
    const id = byName.get(name);
    return id ? row.cells[id] : undefined;
  };
  const optionName = (name: string): string | null => {
    const id = byName.get(name);
    if (!id) return null;
    const value = row.cells[id];
    if (typeof value !== 'string' || !value) return null;
    return selectOptions.get(id)?.find((o) => o.id === value)?.name ?? null;
  };

  const rawFiles = cell('Receipt Image');
  const files = Array.isArray(rawFiles)
    ? (rawFiles as FileReference[])
        .filter((f) => f && typeof f === 'object' && typeof f.fileId === 'string')
        .map((f) => ({
          refId: f.id,
          fileId: f.fileId,
          fileUrl: f.fileUrl,
          mimeType: f.mimeType,
          originalName: f.originalName,
          rotation: parseRotation((f.metadata as Record<string, unknown> | null | undefined)?.rotation),
        }))
    : [];

  return {
    rowId: row.id,
    name: textOrNull(cell('Name')),
    vendor: textOrNull(cell('Vendor')),
    date: isoDay(cell('Date')),
    category: optionName('Category'),
    zuordnung: optionName('Zuordnung'),
    mealType: mealTypeKeyFromLabel(optionName(MEAL_COLUMNS.mealType)),
    gross: numberOrNull(cell('Gross')),
    net: numberOrNull(cell('Net')),
    taxRate: numberOrNull(cell('Tax Rate')),
    currency: optionName('Currency') ?? 'EUR',
    fxRate: numberOrNull(cell('FX Rate')),
    occasion: text(cell(MEAL_COLUMNS.occasion)),
    place: text(cell(MEAL_COLUMNS.place)),
    host: text(cell(MEAL_COLUMNS.host)),
    tip: numberOrNull(cell(MEAL_COLUMNS.tip)),
    consumption: consumptionKeyFromLabel(optionName(MEAL_COLUMNS.consumption)),
    taxLines: parseTaxLines(cell(MEAL_COLUMNS.taxLines)),
    detailsAt: isoTimestamp(cell(MEAL_COLUMNS.detailsAt)),
    confidence: numberOrNull(cell('Confidence')),
    guests,
    files,
    placeSuggestion: placeFromReceiptText(text(cell('OCR Text')), textOrNull(cell('Vendor'))),
  };
}
