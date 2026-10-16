import type { CellValue, QueryOptions } from '@marlinjai/data-table-core';
import { rankItems, vendorSearchWord, type StoredItem } from '@/lib/extraction/known-items';
import { ITEM_COLUMN } from '@/lib/receipt-name';
import { isGroupRow } from '@/lib/receipts-kind';

/**
 * The items a vendor's stored receipts already carry, for the reader to reuse
 * (see src/lib/extraction/known-items.ts). The database narrows the rows to
 * those whose vendor contains the vendor's longest word; `sameVendor` is the
 * exact test. A lookup that fails gives no known items: the receipt is still
 * read, its item worded afresh, and the failure is logged.
 */

interface KnownItemsAdapter {
  getColumns(tableId: string): Promise<Array<{ id: string; name: string; type?: string }>>;
  getRows(
    tableId: string,
    query?: QueryOptions,
  ): Promise<{ items: Array<{ id: string; archived?: boolean; cells: Record<string, CellValue> }>; hasMore: boolean }>;
}

/** No vendor has more receipts than this worth reading for its wordings. */
const ROW_LIMIT = 1000;
const PAGE = 250;

export async function knownItemsOfVendor(adapter: KnownItemsAdapter, tableId: string, vendor: string | null, excludeRowId?: string): Promise<string[]> {
  const word = vendorSearchWord(vendor);
  if (!word) return [];
  try {
    const columns = await adapter.getColumns(tableId);
    const vendorId = columns.find((c) => c.name === 'Vendor')?.id;
    const itemId = columns.find((c) => c.name === ITEM_COLUMN)?.id;
    if (!vendorId || !itemId) return [];
    const stored: StoredItem[] = [];
    for (let offset = 0; offset < ROW_LIMIT; offset += PAGE) {
      const page = await adapter.getRows(tableId, { filters: [{ columnId: vendorId, operator: 'contains', value: word }], limit: PAGE, offset });
      for (const row of page.items) {
        if (row.id === excludeRowId || row.archived || isGroupRow(row, columns)) continue;
        const v = row.cells[vendorId];
        const i = row.cells[itemId];
        stored.push({ vendor: typeof v === 'string' ? v : null, item: typeof i === 'string' ? i : null });
      }
      if (!page.hasMore || page.items.length === 0) break;
    }
    return rankItems(vendor, stored);
  } catch (err) {
    console.error('[known-items] the items of the vendor could not be read:', err instanceof Error ? `${err.name}: ${err.message}` : 'unknown error');
    return [];
  }
}
