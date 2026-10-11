import type { CellValue } from '@marlinjai/data-table-core';
import { ITEM_COLUMN } from '@/lib/receipt-name';
import { nameFromCells, storedNameIsBuilt } from '@/lib/receipt-name-cells';
import { MEAL_CATEGORY } from '@/lib/receipts-constants';
import { isGroupRow } from '@/lib/receipts-kind';

/**
 * Give stored receipts what was bought, and their name with it.
 *
 * Receipts read before the item existed have none. This is not a new reading
 * of the receipt: vendor, total, date and every decision on the row stay as
 * they are, because a person may have corrected them since. Only the item is
 * asked for, from the stored text, and only where the row holds none; then the
 * name is built again from the row's own cells, which also brings a name up to
 * date whose vendor was corrected before names followed their cells.
 *
 * The caller names the rows. Nothing is done to a row it did not name, so a
 * part of the table somebody is working on can be left out.
 */

/** How many rows one call takes: each is one model call, and the request has to answer in time. */
export const ITEM_BATCH_LIMIT = 15;
/** How many model calls run side by side. */
const SIDE_BY_SIDE = 5;

export type ItemOutcome =
  /** The item was read and stored. */
  | 'filled'
  /** The row already held an item: it stays. */
  | 'kept'
  /** A business meal is named by its restaurant. */
  | 'meal'
  /** No stored text to read the item from. */
  | 'no_text'
  /** The model found nothing it could name. */
  | 'no_item'
  /** Not a receipt of this table (unknown id, another workspace, a group). */
  | 'not_found'
  /** The model could not be asked; the row is unchanged and can be sent again. */
  | 'failed';

export interface ItemResult {
  rowId: string;
  outcome: ItemOutcome;
  item: string | null;
  /** The name after this call, when it was built again. */
  renamedTo: string | null;
}

interface StoredRow {
  id: string;
  tableId: string;
  archived?: boolean;
  cells: Record<string, CellValue>;
}

export interface ItemsAdapter {
  getRow(rowId: string): Promise<StoredRow | null>;
  getColumns(tableId: string): Promise<Array<{ id: string; name: string }>>;
  getSelectOptions(columnId: string): Promise<Array<{ id: string; name: string }>>;
  updateRow(rowId: string, cells: Record<string, CellValue>): Promise<unknown>;
}

export type ItemReader = (input: { vendor: string | null; fullText: string }) => Promise<string | null>;

const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

export async function fillReceiptItems(adapter: ItemsAdapter, tableId: string, rowIds: readonly string[], readItem: ItemReader): Promise<ItemResult[]> {
  const columns = await adapter.getColumns(tableId);
  const id = (name: string) => columns.find((c) => c.name === name)?.id;
  const [nameId, itemId, vendorId, textId, categoryId] = [id('Name'), id(ITEM_COLUMN), id('Vendor'), id('OCR Text'), id('Category')];
  const mealOptionId = categoryId ? ((await adapter.getSelectOptions(categoryId)).find((o) => o.name === MEAL_CATEGORY)?.id ?? null) : null;

  const one = async (rowId: string): Promise<ItemResult> => {
    const result = (outcome: ItemOutcome, item: string | null = null, renamedTo: string | null = null): ItemResult => ({ rowId, outcome, item, renamedTo });
    const row = await adapter.getRow(rowId);
    if (!row || row.tableId !== tableId || row.archived || isGroupRow(row, columns) || !itemId || !nameId) return result('not_found');
    if (categoryId && mealOptionId && row.cells[categoryId] === mealOptionId) return result('meal');

    const cells: Record<string, CellValue> = {};
    let outcome: ItemOutcome = 'kept';
    let item: string | null = text(row.cells[itemId]) || null;
    if (!item) {
      const fullText = textId ? text(row.cells[textId]) : '';
      if (!fullText) outcome = 'no_text';
      else {
        try {
          item = await readItem({ vendor: (vendorId && text(row.cells[vendorId])) || null, fullText });
        } catch (err) {
          // The message only: an error object of the client library can carry the request, and with it the text.
          console.error('[receipt-items] the item could not be read:', err instanceof Error ? `${err.name}: ${err.message}` : 'unknown error');
          return result('failed');
        }
        outcome = item ? 'filled' : 'no_item';
        if (item) cells[itemId] = item;
      }
    }
    // The model took its time: the row is read again, so a correction made meanwhile is
    // what the name is built from, and an item typed meanwhile stays.
    const now = (await adapter.getRow(rowId)) ?? row;
    if (cells[itemId] !== undefined && text(now.cells[itemId])) {
      delete cells[itemId];
      item = text(now.cells[itemId]);
      outcome = 'kept';
    }
    // The name from what the row holds now. A name a person typed stays.
    let renamedTo: string | null = null;
    if (await storedNameIsBuilt(adapter, columns, now.cells)) {
      const name = await nameFromCells(adapter, columns, { ...now.cells, ...cells });
      if (name && name !== now.cells[nameId]) {
        cells[nameId] = name;
        renamedTo = name;
      }
    }
    if (Object.keys(cells).length > 0) await adapter.updateRow(row.id, cells);
    return result(outcome, item, renamedTo);
  };

  const ids = [...new Set(rowIds)];
  const results: ItemResult[] = new Array(ids.length);
  let next = 0;
  const worker = async () => {
    while (next < ids.length) {
      const index = next++;
      results[index] = await one(ids[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(SIDE_BY_SIDE, ids.length) }, worker));
  return results;
}
