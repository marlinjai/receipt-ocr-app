/**
 * What the pages show of a receipt's lines: the lines of one receipt for the
 * receipt view, and "Was gekauft" for the spending page. Reads only; the
 * receipt's row is read as it is now, so a corrected vendor or total counts
 * at once.
 */

import 'server-only';
import type { PrismaClient } from '@prisma/client';
import type { Row } from '@marlinjai/data-table-core';
import { allReceiptRows, tableContext, type TableContext } from '@/lib/meals/service';
import { isoDay } from '@/lib/meals/record';
import { checkLines, sumGrossCents, type LinesCheck } from './lines';
import { buildPurchasesOverview, type PurchasesOverview } from './overview';
import { pricingTotalsReader } from './reprice';
import { MAX_ATTEMPTS, loadKindAnswers, withAnswers, type LineSource, type ReadingOutcome, type StoredLine } from './store';

export interface ReceiptLinesView {
  lines: StoredLine[];
  /** How the lines were read; null when they never were. */
  /** `retried`: a failed reading the backfill will try again (under the attempt limit). */
  reading: { outcome: ReadingOutcome; source: LineSource; textCut: boolean; retried: boolean } | null;
  /** The lines against the receipt as it is now; null without lines or total. */
  check: LinesCheck | null;
  currency: string;
}

const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');
const number = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);

function cellReader(ctx: TableContext) {
  const id = (name: string) => ctx.columns.find((c) => c.name === name)?.id;
  const [vendorId, currencyId, fxId, dateId] = [id('Vendor'), id('Currency'), id('FX Rate'), id('Date')];
  const currencyOptions = currencyId ? (ctx.selectOptions.get(currencyId) ?? []) : [];
  const totalsOf = pricingTotalsReader(ctx.columns);
  return (row: Row) => ({
    vendor: vendorId ? text(row.cells[vendorId]) : '',
    totals: totalsOf(row),
    currency: (currencyId && currencyOptions.find((o) => o.id === row.cells[currencyId])?.name) || 'EUR',
    fxRate: fxId ? number(row.cells[fxId]) : null,
    date: dateId ? isoDay(row.cells[dateId]) : null,
  });
}

/** The lines of one receipt of the company, with the kinds a person gave; null when the row is no receipt of it. */
export async function loadReceiptLines(db: PrismaClient, workspaceId: string, rowId: string): Promise<ReceiptLinesView | null> {
  const ctx = await tableContext(db, workspaceId);
  if (!ctx) return null;
  const row = await ctx.adapter.getRow(rowId);
  if (!row || row.tableId !== ctx.tableId) return null;
  const cells = cellReader(ctx)(row);
  const [items, reading, answers] = await Promise.all([
    db.receiptItem.findMany({ where: { authWorkspaceId: workspaceId, rowId }, orderBy: { position: 'asc' } }),
    db.receiptItemReading.findUnique({ where: { rowId } }),
    loadKindAnswers(db, workspaceId),
  ]);
  const own = reading && reading.authWorkspaceId === workspaceId ? reading : null;
  return {
    lines: items.map((i) => withAnswers(i, cells.vendor, answers)),
    reading: own ? { outcome: own.outcome as ReadingOutcome, source: own.source as LineSource, textCut: own.textCut, retried: own.outcome === 'failed' && own.attempts < MAX_ATTEMPTS } : null,
    check: own ? checkLines(own, cells.totals) : null,
    currency: cells.currency,
  };
}

/** The vendor of a receipt as its row holds it now: the shop a kind answer is remembered for. */
export async function receiptVendor(db: PrismaClient, workspaceId: string, rowId: string): Promise<string | null> {
  const ctx = await tableContext(db, workspaceId);
  if (!ctx) return null;
  const row = await ctx.adapter.getRow(rowId);
  if (!row || row.tableId !== ctx.tableId) return null;
  return cellReader(ctx)(row).vendor || null;
}

/** "Was gekauft" of the company for a year or a month. */
export async function loadPurchases(db: PrismaClient, workspaceId: string, period: { year: number; month: number | null }): Promise<PurchasesOverview> {
  const ctx = await tableContext(db, workspaceId);
  if (!ctx) return buildPurchasesOverview([], period);
  const read = cellReader(ctx);
  const rows = (await allReceiptRows(ctx.adapter, ctx.tableId, ctx.columns)).map((row) => ({ row, cells: read(row) }));
  const inYear = rows.filter((r) => r.cells.date?.startsWith(`${period.year}-`));
  const rowIds = inYear.map((r) => r.row.id);
  const [items, answers] = await Promise.all([
    rowIds.length > 0 ? db.receiptItem.findMany({ where: { authWorkspaceId: workspaceId, rowId: { in: rowIds } }, orderBy: [{ rowId: 'asc' }, { position: 'asc' }] }) : Promise.resolve([]),
    loadKindAnswers(db, workspaceId),
  ]);
  const byRow = new Map<string, typeof items>();
  for (const item of items) byRow.set(item.rowId, [...(byRow.get(item.rowId) ?? []), item]);
  return buildPurchasesOverview(
    inYear.map(({ row, cells }) => {
      const lines = byRow.get(row.id);
      // A tip the lines include (a line of its own, `checkLines`) was paid too: the receipt counts with it, else it would show as less than its lines.
      const tipCents = lines ? (checkLines({ lineCount: lines.length, linesSumCents: sumGrossCents(lines), linesNetCents: null, totalNetCents: null }, cells.totals)?.tipCents ?? 0) : 0;
      return {
        rowId: row.id,
        date: cells.date,
        vendor: cells.vendor,
        grossCents: cells.totals.gross === null ? null : Math.round(cells.totals.gross * 100) + tipCents,
        currency: cells.currency,
        fxRate: cells.fxRate,
        lines: lines ? lines.map((i) => withAnswers(i, cells.vendor, answers)).map((l) => ({ text: l.text, grossCents: l.grossCents, quantity: l.quantity, kind: l.kind })) : null,
      };
    }),
    period,
  );
}
