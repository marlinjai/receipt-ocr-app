import 'server-only';
import { PrismaAdapter } from '@marlinjai/data-table-adapter-prisma';
import type { PrismaClient } from '@prisma/client';
import { isoDay } from '@/lib/meals/record';
import { RECEIPTS_TABLE_NAME } from '@/lib/receipts-table';
import { isGroupRow } from '@/lib/receipts-kind';
import { INVOICE_NUMBER_COLUMN, invoiceNumberKey } from '@/lib/extraction/invoice-number';

/**
 * Duplicate detection for uploads, scoped to one workspace.
 *
 * Two checks, deliberately different in strength:
 *  - the SAME FILE (content hash) is certain and is checked before anything is
 *    uploaded;
 *    Identical files in one batch are caught too, because the upload queue runs
 *    one file at a time and each saved row carries its hash before the next
 *    file is checked. Across browser tabs it is a soft check; "upload anyway"
 *    is a deliberate way to hold the same file twice, so no uniqueness
 *    constraint backs it.
 *  - the same RECEIPT photographed twice has a different hash, so after text
 *    recognition a soft check on vendor, date and total can only warn. It
 *    warns only where one of the two has no invoice number: the same number is
 *    the same receipt and never saved twice, two different numbers are two
 *    invoices (plan docs/plans/2026-10-29-invoice-number-duplicates.md).
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

function shiftDay(day: string, delta: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
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
  return (await findFileCopies(db, sha256, [workspaceId])).get(workspaceId) ?? null;
}

/**
 * For each of the given workspaces, a live receipt there that holds a file with
 * this content hash. Workspaces NOT in the list are never looked at, so a
 * caller that passes only the session's own memberships can never learn that
 * somebody else holds the file.
 */
export async function findFileCopies(
  db: PrismaClient,
  sha256: string,
  workspaceIds: readonly string[],
): Promise<Map<string, ExistingReceipt>> {
  const found = new Map<string, ExistingReceipt>();
  const wanted = new Set(workspaceIds);
  if (wanted.size === 0) return found;
  const contexts = new Map<string, Awaited<ReturnType<typeof receiptsTable>>>();
  const context = async (workspaceId: string) => {
    if (!contexts.has(workspaceId)) contexts.set(workspaceId, await receiptsTable(db, workspaceId));
    return contexts.get(workspaceId) ?? null;
  };
  const pageSize = 50;
  let cursorId: string | undefined;
  // Page through every hash match: the first page may hold only copies in
  // workspaces that were not asked about.
  for (;;) {
    const refs = await db.dtFile.findMany({
      where: { metadata: { path: ['sha256'], equals: sha256 } },
      select: { id: true, rowId: true, columnId: true },
      orderBy: { id: 'asc' },
      ...(cursorId ? { cursor: { id: cursorId }, skip: 1 } : {}),
      take: pageSize,
    });
    const columnIds = [...new Set(refs.map((r) => r.columnId))];
    const columns = columnIds.length
      ? await db.dtColumn.findMany({ where: { id: { in: columnIds } }, select: { id: true, table: { select: { id: true, workspaceId: true } } } })
      : [];
    const workspaceOfColumn = new Map(columns.map((c) => [c.id, c.table.workspaceId]));
    const checked = new Set<string>();
    for (const ref of refs) {
      const workspaceId = workspaceOfColumn.get(ref.columnId);
      if (!workspaceId || !wanted.has(workspaceId) || found.has(workspaceId) || checked.has(ref.rowId)) continue;
      checked.add(ref.rowId);
      const ctx = await context(workspaceId);
      if (!ctx) continue;
      // Only a live receipt of that workspace's own receipts table counts.
      const row = await ctx.adapter.getRow(ref.rowId);
      if (row && row.tableId === ctx.tableId && !row.archived && !isGroupRow(row, ctx.columns)) {
        found.set(workspaceId, { rowId: ref.rowId, name: rowName(row.cells, ctx.columns) });
      }
    }
    if (refs.length < pageSize || found.size === wanted.size) return found;
    cursorId = refs[refs.length - 1].id;
  }
}

export interface ReceiptIdentity {
  vendor: string | null;
  /** Any date form the Date cell can hold. */
  date: string | null;
  gross: number | null;
  /** The invoice number as read; a candidate that has one too is never a look-alike. */
  invoiceNumber?: string | null;
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
  const numberCol = col(INVOICE_NUMBER_COLUMN);
  const numbered = invoiceNumberKey(identity.invoiceNumber) !== null;

  const cents = Math.round(identity.gross * 100);
  let offset = 0;
  const limit = 500;
  for (;;) {
    // The database narrows to the day plus a day either side (a cell may carry
    // a time or offset); the checks below stay the exact test (date, vendor
    // case, total in cents).
    const page = await ctx.adapter.getRows(ctx.tableId, {
      filters: [
        // Date objects, not strings: the Date column is a timestamp in the
        // database, and a string bound as text has no comparison with it (the
        // query then fails outright, which would silently disable this check).
        { columnId: dateCol.id, operator: 'greaterThanOrEquals', value: new Date(`${shiftDay(day, -1)}T00:00:00.000Z`) },
        { columnId: dateCol.id, operator: 'lessThanOrEquals', value: new Date(`${shiftDay(day, 1)}T23:59:59.999Z`) },
      ],
      limit,
      offset,
    });
    for (const row of page.items) {
      // A group is never a look-alike of a receipt, whatever its cells say.
      if (row.id === excludeRowId || row.archived || isGroupRow(row, ctx.columns)) continue;
      if (isoDay(row.cells[dateCol.id]) !== day) continue;
      const rowVendor = row.cells[vendorCol.id];
      if (typeof rowVendor !== 'string' || rowVendor.trim().toLocaleLowerCase('de-DE') !== vendor) continue;
      const rowGross = Number(row.cells[grossCol.id]);
      if (!Number.isFinite(rowGross) || Math.round(rowGross * 100) !== cents) continue;
      // Both numbered: the numbers decide, nobody is asked.
      if (numbered && numberCol && invoiceNumberKey(row.cells[numberCol.id]) !== null) continue;
      return { rowId: row.id, name: rowName(row.cells, ctx.columns) };
    }
    if (!page.hasMore || page.items.length === 0) break;
    offset += page.items.length;
  }
  return null;
}
