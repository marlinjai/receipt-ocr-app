import 'server-only';
import { ensureRealTable } from '@marlinjai/data-table-adapter-prisma';
import { safeColumnName, safeTableName } from '@marlinjai/data-table-adapter-shared';
import type { PrismaClient } from '@prisma/client';
import { rowKindColumnId } from '@/lib/receipts-kind';
import type { YearCount } from '@/lib/receipt-years';

/**
 * How many receipts each year has, without loading any row: the year chips of
 * the dashboard and the year the table opens on come from here. Groups are no
 * receipts and archived rows are not shown.
 */

export interface YearCounts {
  years: YearCount[];
  undated: number;
}

export async function yearCounts(db: PrismaClient, tableId: string, columns: ReadonlyArray<{ id: string; name: string }>): Promise<YearCounts> {
  const dateId = columns.find((c) => c.name === 'Date')?.id;
  if (!dateId) return { years: [], undated: 0 };
  const kindId = rowKindColumnId(columns);
  await ensureRealTable(db, tableId);
  const date = safeColumnName(dateId);
  const notGroup = kindId ? `AND COALESCE(${safeColumnName(kindId)}, '') <> 'group'` : '';
  const rows = await db.$queryRawUnsafe<Array<{ year: string | null; count: number }>>(
    `SELECT CASE WHEN ${date} ~ '^[0-9]{4}-' THEN substring(${date} from 1 for 4) END AS year, count(*)::int AS count
     FROM ${safeTableName(tableId)} WHERE _archived = 0 ${notGroup} GROUP BY 1`,
  );
  const years = rows
    .filter((r): r is { year: string; count: number } => r.year !== null)
    .map((r) => ({ year: Number(r.year), count: r.count }))
    .sort((a, b) => b.year - a.year);
  return { years, undated: rows.find((r) => r.year === null)?.count ?? 0 };
}

/** The ids of the groups that hold at least one receipt dated in one of the given years. */
export async function groupsHoldingReceipts(db: PrismaClient, tableId: string, dateColumnId: string, years: readonly number[]): Promise<Set<string>> {
  await ensureRealTable(db, tableId);
  const date = safeColumnName(dateColumnId);
  const rows = await db.$queryRawUnsafe<Array<{ parent_row_id: string }>>(
    `SELECT DISTINCT parent_row_id FROM ${safeTableName(tableId)}
     WHERE _archived = 0 AND parent_row_id IS NOT NULL AND substring(${date} from 1 for 4) = ANY($1::text[])`,
    years.map(String),
  );
  return new Set(rows.map((r) => r.parent_row_id));
}
