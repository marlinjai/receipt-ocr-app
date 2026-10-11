import type { CellValue } from '@marlinjai/data-table-core';
import { ITEM_COLUMN, nameIsBuilt, receiptName, type ReceiptNameParts } from '@/lib/receipt-name';

/**
 * The name of a stored receipt, built from the cells it holds.
 *
 * The name is stored in a cell, so it does not change by itself when the
 * vendor, the item, the total, the currency or the date are corrected: a row
 * read as "Example Software Ireland Ltd" kept that in its name after its
 * vendor was shortened. Every write that touches one of those cells goes
 * through here and takes the name along, as long as the name is one that was
 * built (see `nameIsBuilt`): a name a person typed is theirs.
 */

/** The cells the name is built from. */
export const NAME_PART_COLUMNS: readonly string[] = ['Vendor', ITEM_COLUMN, 'Gross', 'Currency', 'Date'];

type NamedColumn = { id: string; name: string };
type OptionReader = { getSelectOptions(columnId: string): Promise<Array<{ id: string; name: string }>> };

const columnId = (columns: readonly NamedColumn[], name: string) => columns.find((c) => c.name === name)?.id;

/** True when a write changes a part of the name and does not set the name itself. */
export function touchesNameParts(columns: readonly NamedColumn[], cells: Record<string, unknown>): boolean {
  const nameId = columnId(columns, 'Name');
  if (!nameId || nameId in cells) return false;
  return NAME_PART_COLUMNS.some((name) => {
    const id = columnId(columns, name);
    return id !== undefined && id in cells;
  });
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function day(value: unknown): string | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  return text(value);
}

function total(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value);
  return null;
}

/** The parts of the name as the given cells hold them. Null when the currency cell names an option that no longer exists: then nothing can be said about the total. */
export async function namePartsFromCells(adapter: OptionReader, columns: readonly NamedColumn[], cells: Record<string, unknown>): Promise<ReceiptNameParts | null> {
  const cell = (name: string): unknown => {
    const id = columnId(columns, name);
    return id ? cells[id] : null;
  };
  const currencyId = columnId(columns, 'Currency');
  const currencyOption = currencyId ? text(cells[currencyId]) : null;
  let currency: string | null = null;
  if (currencyId && currencyOption) {
    currency = (await adapter.getSelectOptions(currencyId)).find((o) => o.id === currencyOption)?.name ?? null;
    // A total must never be renamed into euros because its currency could not be looked up.
    if (!currency) return null;
  }
  return { vendor: text(cell('Vendor')), item: text(cell(ITEM_COLUMN)), gross: total(cell('Gross')), currency, date: day(cell('Date')) };
}

/** The name the given cells make. Empty when they hold neither a vendor, an item, a total nor a date, or when the currency cannot be looked up. */
export async function nameFromCells(adapter: OptionReader, columns: readonly NamedColumn[], cells: Record<string, unknown>): Promise<string> {
  const parts = await namePartsFromCells(adapter, columns, cells);
  return parts ? receiptName(parts) : '';
}

/** True when the name the stored cells carry was built from them (see `nameIsBuilt`). */
export async function storedNameIsBuilt(adapter: OptionReader, columns: readonly NamedColumn[], stored: Record<string, unknown>): Promise<boolean> {
  const nameId = columnId(columns, 'Name');
  if (!nameId) return false;
  const parts = await namePartsFromCells(adapter, columns, stored);
  return parts !== null && nameIsBuilt(stored[nameId], parts);
}

/**
 * The write with the name added where it has to follow: the stored name was
 * built, and the cells after the write still make a name. Otherwise the write
 * as it came.
 */
export async function withFollowingName<T extends Record<string, CellValue>>(
  adapter: OptionReader,
  columns: readonly NamedColumn[],
  cells: T,
  stored: Record<string, unknown> | null | undefined,
): Promise<T> {
  const nameId = columnId(columns, 'Name');
  if (!nameId || !stored || !touchesNameParts(columns, cells) || !(await storedNameIsBuilt(adapter, columns, stored))) return cells;
  const name = await nameFromCells(adapter, columns, { ...stored, ...cells });
  if (!name || name === stored[nameId]) return cells;
  return { ...cells, [nameId]: name };
}
