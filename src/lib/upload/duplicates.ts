import 'server-only';
import { PrismaAdapter } from '@marlinjai/data-table-adapter-prisma';
import type { PrismaClient } from '@prisma/client';
import { isoDay } from '@/lib/meals/record';
import { RECEIPTS_TABLE_NAME } from '@/lib/receipts-table';

/**
 * Duplicate detection for uploads, scoped to one workspace.
 *
 * Two checks, deliberately different in strength:
 *  - the SAME FILE (content hash) is certain and is checked before anything is
 *    uploaded;
 *  - the same RECEIPT photographed twice has a different hash, so after text
 *    recognition a soft check on vendor, date and total can only warn.
 */

export interface ExistingReceipt {
  rowId: string;
  name: string;
}

async function receiptsTable(db: PrismaClient, workspaceId: string) {
  const adapter = new PrismaAdapter({ prisma: db });
  const table = (await adapter.listTables(workspaceId)).find((t) => t.name === RECEIPTS_TABLE_NAME);
  if (!table) return null;
  const columns = await adapter.getColumns(table.id);
  return { adapter, tableId: table.id, columns };
}

function rowName(cells: Record<string, unknown>, columns: Array<{ id: string; name: string }>): string {
  const nameCol = columns.find((c) => c.name === 'Name');
  const vendorCol = columns.find((c) => c.name === 'Vendor');
  const name = nameCol ? cells[nameCol.id] : null;
  const vendor = vendorCol ? cells[vendorCol.id] : null;
  return (typeof name === 'string' && name.trim()) || (typeof vendor === 'string' && vendor.trim()) || 'Receipt';
}

/** A row of THIS workspace that already holds a file with this content hash. */
export async function findFileDuplicate(
  db: PrismaClient,
  workspaceId: string,
  sha256: string,
): Promise<ExistingReceipt | null> {
  const ctx = await receiptsTable(db, workspaceId);
  if (!ctx) return null;
  const refs = await db.dtFile.findMany({
    where: { metadata: { path: ['sha256'], equals: sha256 } },
    select: { rowId: true },
    take: 50,
  });
  for (const rowId of new Set(refs.map((r) => r.rowId))) {
    // Only rows of this workspace's own table count; a hit in another
    // workspace must stay invisible (it would leak that someone holds the file).
    const row = await ctx.adapter.getRow(rowId);
    if (row && row.tableId === ctx.tableId && !row.archived) {
      return { rowId, name: rowName(row.cells, ctx.columns) };
    }
  }
  return null;
}

export interface ReceiptIdentity {
  vendor: string | null;
  /** Any date form the Date cell can hold. */
  date: string | null;
  gross: number | null;
}

/**
 * Another row of this workspace with the same vendor, day and total. Needs all
 * three: with one of them missing there is no basis for a warning.
 */
export async function findSimilarReceipt(
  db: PrismaClient,
  workspaceId: string,
  identity: ReceiptIdentity,
  excludeRowId: string,
): Promise<ExistingReceipt | null> {
  const day = isoDay(identity.date);
  const vendor = identity.vendor?.trim().toLocaleLowerCase('de-DE');
  if (!day || !vendor || identity.gross === null || !Number.isFinite(identity.gross)) return null;
  const ctx = await receiptsTable(db, workspaceId);
  if (!ctx) return null;
  const col = (name: string) => ctx.columns.find((c) => c.name === name);
  const dateCol = col('Date');
  const vendorCol = col('Vendor');
  const grossCol = col('Gross');
  if (!dateCol || !vendorCol || !grossCol) return null;

  const cents = Math.round(identity.gross * 100);
  let offset = 0;
  const limit = 500;
  for (;;) {
    const page = await ctx.adapter.getRows(ctx.tableId, { limit, offset });
    for (const row of page.items) {
      if (row.id === excludeRowId || row.archived) continue;
      if (isoDay(row.cells[dateCol.id]) !== day) continue;
      const rowVendor = row.cells[vendorCol.id];
      if (typeof rowVendor !== 'string' || rowVendor.trim().toLocaleLowerCase('de-DE') !== vendor) continue;
      const rowGross = Number(row.cells[grossCol.id]);
      if (!Number.isFinite(rowGross) || Math.round(rowGross * 100) !== cents) continue;
      return { rowId: row.id, name: rowName(row.cells, ctx.columns) };
    }
    if (!page.hasMore || page.items.length === 0) break;
    offset += page.items.length;
  }
  return null;
}
