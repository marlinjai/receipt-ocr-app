/**
 * Settling again, for every receipt of a company, whether its stored lines
 * are gross or net (`repriceStoredLines`). Lines read before prices before
 * tax were told apart hold an invoice's net amounts as gross: they made the
 * receipt "Positionen prüfen" and counted short by the tax in "Was gekauft".
 * No model is asked; the stored lines and the row's figures as they are now
 * are enough. A run twice changes nothing the second time. Run once per
 * company with `POST /api/receipts/lines/reprice`.
 */

import type { PrismaClient } from '@prisma/client';
import type { Column, Row } from '@marlinjai/data-table-core';
import { firstColumnIdByName } from '@/lib/column-lookup';
import { allReceiptRows, tableContext } from '@/lib/meals/service';
import { MEAL_COLUMNS } from '@/lib/receipts-constants';
import { TAX_RATE_COLUMN } from '@/lib/tax-rates';
import type { PricingTotals } from './lines';
import { repriceStoredLines, type LineItemsContext } from './store';

const number = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);

/** The figures of a receipt's row the lines are priced and checked with, in the receipt's currency. */
export function pricingTotalsReader(columns: readonly Pick<Column, 'id' | 'name'>[]): (row: Row) => PricingTotals {
  const ids = firstColumnIdByName(columns);
  const [grossId, netId, rateId, tipId] = [ids.get('Gross'), ids.get('Net'), ids.get(TAX_RATE_COLUMN), ids.get(MEAL_COLUMNS.tip)];
  return (row) => ({
    gross: grossId ? number(row.cells[grossId]) : null,
    net: netId ? number(row.cells[netId]) : null,
    taxRate: rateId ? number(row.cells[rateId]) : null,
    tip: tipId ? number(row.cells[tipId]) : null,
  });
}

export interface RepriceResult {
  /** Receipts with stored lines read from their page or text (an electronic invoice's lines are its XML's and are not looked at). */
  lookedAt: number;
  /** Of those, whose amounts or sums changed. */
  rederived: number;
  unchanged: number;
  /** Of those, whose write failed (logged): a run again tries them. */
  failed: number;
}

/** One run for one company. A receipt that fails is logged and counted; the run goes on. */
export async function repriceCompanyLines(db: PrismaClient, ctx: LineItemsContext): Promise<RepriceResult> {
  const result: RepriceResult = { lookedAt: 0, rederived: 0, unchanged: 0, failed: 0 };
  const table = await tableContext(db, ctx.workspaceId);
  if (!table) return result;
  const totalsOf = pricingTotalsReader(table.columns);
  const rows = await allReceiptRows(table.adapter, table.tableId, table.columns);
  const read = new Set(
    (await db.receiptItemReading.findMany({ where: { authWorkspaceId: ctx.workspaceId, outcome: 'lines', source: { not: 'einvoice' }, rowId: { in: rows.map((r) => r.id) } }, select: { rowId: true } })).map((r) => r.rowId),
  );
  for (const row of rows) {
    if (!read.has(row.id)) continue;
    try {
      const outcome = await repriceStoredLines(db, ctx, row.id, totalsOf(row));
      // 'skipped': read again from its XML (or deleted) since the list was loaded, no longer this run's business.
      if (outcome === 'skipped') continue;
      result.lookedAt++;
      if (outcome === 'rederived') result.rederived++;
      else result.unchanged++;
    } catch (err) {
      result.lookedAt++;
      result.failed++;
      console.error('[line-items] re-deriving the lines of a receipt failed:', err instanceof Error ? err.name : 'error');
    }
  }
  console.info('[line-items] reprice run', result);
  return result;
}
