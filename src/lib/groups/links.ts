import 'server-only';
import { safeColumnName, safeTableName } from '@marlinjai/data-table-adapter-shared';
import type { Prisma, PrismaClient } from '@prisma/client';

/**
 * Reads and writes of the link between a receipt and the group it lies in.
 *
 * The link is the table's own system column `parent_row_id`. The table package
 * can create a row under a parent but has no call that moves an existing row,
 * so this module writes the column itself, on the physical table of the
 * workspace's Receipts table. Callers have authorized the table before.
 */

type Db = PrismaClient | Prisma.TransactionClient;

/** What the group rules need to know about a row, read in one query. */
export interface RowLink {
  id: string;
  parentRowId: string | null;
  archived: boolean;
  /** The row's kind cell, null on a receipt. */
  kind: string | null;
}

function placeholders(count: number, from = 1): string {
  return Array.from({ length: count }, (_, i) => `$${i + from}`).join(', ');
}

/** The given rows of one table, as far as they exist there. Ids that are no row of this table are simply missing. */
export async function readRowLinks(db: Db, tableId: string, kindColumnId: string, rowIds: readonly string[]): Promise<Map<string, RowLink>> {
  const ids = [...new Set(rowIds)];
  const out = new Map<string, RowLink>();
  if (ids.length === 0) return out;
  const rows = await db.$queryRawUnsafe<Array<{ id: string; parent_row_id: string | null; archived: number | boolean; kind: string | null }>>(
    `SELECT id, parent_row_id, _archived AS archived, ${safeColumnName(kindColumnId)} AS kind FROM ${safeTableName(tableId)} WHERE id IN (${placeholders(ids.length)})`,
    ...ids,
  );
  for (const r of rows) {
    out.set(r.id, { id: r.id, parentRowId: r.parent_row_id ?? null, archived: Number(r.archived) !== 0, kind: r.kind ?? null });
  }
  return out;
}

/**
 * Put the rows under `parentRowId`, or at the top level with null. A row that
 * is already there is not written, so repeating a move changes nothing.
 * Returns how many rows were written.
 */
export async function setParentRow(db: Db, tableId: string, rowIds: readonly string[], parentRowId: string | null): Promise<number> {
  const ids = [...new Set(rowIds)];
  if (ids.length === 0) return 0;
  return db.$executeRawUnsafe(
    `UPDATE ${safeTableName(tableId)} SET parent_row_id = $1::text, _updated_at = $2 WHERE id IN (${placeholders(ids.length, 3)}) AND parent_row_id IS DISTINCT FROM $1::text`,
    parentRowId,
    new Date().toISOString(),
    ...ids,
  );
}

/**
 * Release every row that lies under `parentRowId` to the top level. Runs
 * before a row is deleted, whatever its kind, so no row is left pointing at one
 * that is gone. Returns the ids released, so a failed delete can put them back
 * with `restoreChildRows`.
 */
export async function releaseChildRows(db: Db, tableId: string, parentRowId: string): Promise<string[]> {
  const rows = await db.$queryRawUnsafe<Array<{ id: string }>>(
    `UPDATE ${safeTableName(tableId)} SET parent_row_id = NULL, _updated_at = $1 WHERE parent_row_id = $2 RETURNING id`,
    new Date().toISOString(),
    parentRowId,
  );
  return rows.map((r) => r.id);
}

/** Put rows released by `releaseChildRows` back under their parent, when the parent's delete did not go through. */
export async function restoreChildRows(db: Db, tableId: string, parentRowId: string, childIds: readonly string[]): Promise<void> {
  if (childIds.length === 0) return;
  await db.$executeRawUnsafe(
    `UPDATE ${safeTableName(tableId)} SET parent_row_id = $1::text, _updated_at = $2 WHERE id IN (${placeholders(childIds.length, 3)}) AND parent_row_id IS NULL`,
    parentRowId,
    new Date().toISOString(),
    ...childIds,
  );
}
