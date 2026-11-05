import type { CellValue, QueryOptions } from '@marlinjai/data-table-core';
import { rankItems, vendorSearchWord, vendorSpelling, type StoredItem } from '@/lib/extraction/known-items';
import { MEAL_CATEGORY } from '@/lib/receipts-constants';
import { ITEM_COLUMN } from '@/lib/receipt-name';
import { isGroupRow } from '@/lib/receipts-kind';

/**
 * What a vendor's stored receipts already say about it, for a new reading:
 * the spelling they carry (src/lib/extraction/known-items.ts, `vendorSpelling`)
 * and the items they were bought as (`rankItems`). One scan serves both. The
 * database narrows the rows to those whose vendor contains the vendor's
 * search word (`vendorSearchWord`); `sameVendorFamily` is the exact test. A
 * lookup that fails knows nothing: the receipt is still read, its vendor
 * spelled as read and its item worded afresh, and the failure is logged.
 */

interface KnownItemsAdapter {
  getColumns(tableId: string): Promise<Array<{ id: string; name: string; type?: string }>>;
  getRows(
    tableId: string,
    query?: QueryOptions,
  ): Promise<{ items: Array<{ id: string; archived?: boolean; cells: Record<string, CellValue> }>; hasMore: boolean }>;
  getSelectOptions(columnId: string): Promise<Array<{ id: string; name: string }>>;
}

/** No vendor has more receipts than this worth reading for its spellings and wordings. */
const ROW_LIMIT = 1000;
const PAGE = 250;

export interface KnownVendor {
  /** The spelling the vendor's stored receipts carry most, or null where none spells it (the reading stands). */
  spelling: string | null;
  /** The items they were bought as, the most used first. */
  items: string[];
}

const NOTHING_KNOWN: KnownVendor = { spelling: null, items: [] };

/** The stored receipts that may be the vendor's, as far as vendor, item and meal go. */
async function storedOfVendor(adapter: KnownItemsAdapter, tableId: string, vendor: string | null, excludeRowId?: string): Promise<StoredItem[]> {
  const word = vendorSearchWord(vendor);
  if (!word) return [];
  const columns = await adapter.getColumns(tableId);
  const vendorId = columns.find((c) => c.name === 'Vendor')?.id;
  const itemId = columns.find((c) => c.name === ITEM_COLUMN)?.id;
  const categoryId = columns.find((c) => c.name === 'Category')?.id;
  if (!vendorId || !itemId) return [];
  const mealOptionId = categoryId ? ((await adapter.getSelectOptions(categoryId)).find((o) => o.name === MEAL_CATEGORY)?.id ?? null) : null;
  const stored: StoredItem[] = [];
  for (let offset = 0; offset < ROW_LIMIT; offset += PAGE) {
    const page = await adapter.getRows(tableId, { filters: [{ columnId: vendorId, operator: 'contains', value: word }], limit: PAGE, offset });
    for (const row of page.items) {
      if (row.id === excludeRowId || row.archived || isGroupRow(row, columns)) continue;
      const v = row.cells[vendorId];
      const i = row.cells[itemId];
      const meal = mealOptionId !== null && categoryId !== undefined && row.cells[categoryId] === mealOptionId;
      stored.push({ vendor: typeof v === 'string' ? v : null, item: typeof i === 'string' ? i : null, meal });
    }
    if (!page.hasMore || page.items.length === 0) break;
  }
  return stored;
}

/**
 * The spelling and the items of the vendor a reading names. The items are
 * those of the spelling taken, so a receipt read as "Apple Distribution
 * International Ltd." is offered the items of the "Apple" receipts.
 */
export async function knownVendor(adapter: KnownItemsAdapter, tableId: string, vendor: string | null, excludeRowId?: string): Promise<KnownVendor> {
  try {
    const stored = await storedOfVendor(adapter, tableId, vendor, excludeRowId);
    if (stored.length === 0) return NOTHING_KNOWN;
    const spelling = vendorSpelling(vendor, stored);
    return { spelling, items: rankItems(spelling ?? vendor, stored) };
  } catch (err) {
    console.error('[known-items] the receipts of the vendor could not be read:', err instanceof Error ? `${err.name}: ${err.message}` : 'unknown error');
    return NOTHING_KNOWN;
  }
}
