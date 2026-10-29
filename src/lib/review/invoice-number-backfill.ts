import 'server-only';
import type { PrismaClient } from '@prisma/client';
import type { Row } from '@marlinjai/data-table-core';
import { firstColumnIdByName } from '@/lib/column-lookup';
import { INVOICE_NUMBER_COLUMN, parseInvoiceNumber } from '@/lib/extraction/invoice-number';
import { companiesWithReceipts } from '@/lib/line-items/backfill';
import { allReceiptRows, tableContext } from '@/lib/meals/service';
import { ensureReceiptsTable } from '@/lib/receipts-table';
import { mergeDuplicates, type MergeContext } from './merge';

/**
 * Give receipts already in the app their invoice number, from their stored
 * text (plan docs/plans/2026-10-29-invoice-number-duplicates.md, decision 12),
 * then run the automatic pass so the pairs that now share a number are one.
 *
 * Deterministic only: the stored text is parsed (`parseInvoiceNumber`, the
 * same parser the upload uses), no model is asked and nothing is spent. An
 * electronic invoice's stored text names "Rechnungsnummer: ...", so it is read
 * the same way. A cell that holds a number already is left as it is (a person
 * may have typed it), and a number is never guessed: unknown stays empty.
 *
 * Every receipt looked at is marked (`receipt_reviews.invoice_number_read_at`),
 * so a second run reads nothing again and a number a person removed is not
 * filled back. A run cut off halfway leaves the receipts it had not marked for
 * the next run; reading one twice changes nothing.
 */

/** How many receipts one run looks at: parsing is cheap, the writes are what a run waits for. */
export const INVOICE_NUMBER_BATCH_LIMIT = 400;
/** The marks are written in parts of this size, so a run cut off loses at most one part's marks. */
const MARK_PART = 50;

export interface InvoiceNumberBackfillResult {
  /** Receipts whose stored text was looked at in this run. */
  looked: number;
  /** Of those, how many got a number from it. */
  found: number;
  /** Receipts the pass archived into another one after this run. */
  merged: number;
  /** Receipts still waiting for a run after this one. */
  remaining: number;
}

const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

async function markLooked(db: PrismaClient, ctx: MergeContext, rowIds: readonly string[], at: Date): Promise<void> {
  if (rowIds.length === 0) return;
  await db.receiptReview.updateMany({ where: { authWorkspaceId: ctx.workspaceId, rowId: { in: [...rowIds] } }, data: { invoiceNumberReadAt: at } });
  await db.receiptReview.createMany({
    data: rowIds.map((rowId) => ({ rowId, authWorkspaceId: ctx.workspaceId, authTenantId: ctx.tenantId, invoiceNumberReadAt: at })),
    skipDuplicates: true,
  });
}

/**
 * One run for one company: look at most `limit` receipts not looked at yet
 * (newest first), fill the empty number cells the text labels a number for,
 * then merge what is now the same invoice.
 */
export async function backfillInvoiceNumbers(
  db: PrismaClient,
  ctx: MergeContext,
  options: { limit?: number; now?: () => Date } = {},
): Promise<InvoiceNumberBackfillResult> {
  const limit = Math.max(1, options.limit ?? INVOICE_NUMBER_BATCH_LIMIT);
  const now = options.now ?? (() => new Date());
  const result: InvoiceNumberBackfillResult = { looked: 0, found: 0, merged: 0, remaining: 0 };
  let table = await tableContext(db, ctx.workspaceId);
  if (!table) return result;
  // A table the dashboard has not brought up to date since the column exists gets it first (idempotent, under the schema lock).
  if (!firstColumnIdByName(table.columns).has(INVOICE_NUMBER_COLUMN)) {
    await ensureReceiptsTable(table.adapter, ctx.workspaceId, { db, tenantId: ctx.tenantId });
    table = await tableContext(db, ctx.workspaceId);
    if (!table) return result;
  }
  const byName = firstColumnIdByName(table.columns);
  const numberId = byName.get(INVOICE_NUMBER_COLUMN);
  const textId = byName.get('OCR Text');
  const grossId = byName.get('Gross');
  if (!numberId || !textId) return result;

  const rows = (await allReceiptRows(table.adapter, table.tableId, table.columns)).filter((r) => !r.archived);
  const looked = new Set(
    (await db.receiptReview.findMany({ where: { authWorkspaceId: ctx.workspaceId, rowId: { in: rows.map((r) => r.id) }, invoiceNumberReadAt: { not: null } }, select: { rowId: true } })).map((r) => r.rowId),
  );
  const open = rows.filter((r) => !looked.has(r.id)).sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime() || (a.id < b.id ? -1 : 1));
  const batch = open.slice(0, limit);

  const readOne = async (row: Row): Promise<void> => {
    if (text(row.cells[numberId])) return;
    const gross = grossId ? Number(row.cells[grossId]) : NaN;
    const number = parseInvoiceNumber(text(row.cells[textId]), { creditNote: Number.isFinite(gross) && gross < 0 });
    if (!number) return;
    // Read again just before the write: a number a person typed meanwhile stays.
    const fresh = await table.adapter.getRow(row.id);
    if (!fresh || fresh.archived || text(fresh.cells[numberId])) return;
    await table.adapter.updateRow(row.id, { [numberId]: number });
    result.found++;
  };

  for (let at = 0; at < batch.length; at += MARK_PART) {
    const part = batch.slice(at, at + MARK_PART);
    const done: string[] = [];
    for (const row of part) {
      try {
        await readOne(row);
        done.push(row.id);
      } catch (err) {
        // Left unmarked: the next run looks at it again.
        console.error('[invoice-numbers] a receipt could not be read:', err instanceof Error ? err.name : 'error');
      }
    }
    await markLooked(db, ctx, done, now());
    result.looked += done.length;
  }
  result.remaining = open.length - result.looked;

  // The pairs that share a number now are one receipt; the same file was one before, and is merged here too.
  result.merged = (await mergeDuplicates(db, ctx)).merged.length;
  console.info('[invoice-numbers] backfill run', result);
  return result;
}

/** The daily run: every company in turn, one run each. A company that fails is logged and the next goes on. */
export async function dailyInvoiceNumberBackfill(db: PrismaClient, options: { companies?: MergeContext[] } = {}): Promise<void> {
  for (const company of options.companies ?? (await companiesWithReceipts(db))) {
    try {
      await backfillInvoiceNumbers(db, company);
    } catch (err) {
      console.error('[invoice-numbers] the daily run failed for a company:', err instanceof Error ? err.name : 'error');
    }
  }
}
