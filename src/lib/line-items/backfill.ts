/**
 * Give receipts already in the app their lines, from their stored text (plan
 * docs/plans/2026-10-26-receipt-line-items.md, decision 5). Modelled on the
 * item backfill (src/lib/receipt-items.ts), with three differences:
 *
 *  - The receipts are chosen here, from what has no reading yet, never named
 *    by the browser: a run per company reads at most a fixed number of
 *    receipts, newest first, and the next run goes on where it stopped.
 *  - Every receipt ends with a record (receipt_item_readings): lines, no
 *    lines, no stored text, or failed. So a run twice reads nothing twice, a
 *    receipt without text is listed instead of asked about again, and one
 *    whose answer was unusable (malformed, cut off, declined) is tried again on the next
 *    run, up to MAX_ATTEMPTS times. A call that did not get through (the
 *    provider down, a rate limit, a timeout) is not counted against the
 *    receipt: it is simply tried again, and a missing key stops the run.
 *  - The lines are written in one transaction with their record, and only
 *    where the receipt was not read meanwhile (a new reading of the page wins).
 *
 * Nothing on the receipt row changes. Logs carry counts and token usage only,
 * never a line's text.
 */

import type { PrismaClient } from '@prisma/client';
import type { Row } from '@marlinjai/data-table-core';
import { allReceiptRows, tableContext } from '@/lib/meals/service';
import { UnusableAnswerError, ClassifierUnavailableError, type LinesAnswer, type LinesInput } from '@/lib/receipt-classifier';
import { checkLines } from './lines';
import { MAX_ATTEMPTS, recordUnread, replaceReceiptLines, type LineItemsContext } from './store';

/** How many receipts one run from the receipts page reads: each is one model call, and the request has to answer in time. */
export const LINES_BATCH_LIMIT = 15;
/** How many receipts the daily run reads per company. */
export const DAILY_LINES_LIMIT = 40;
/** How many model calls run side by side. */
const SIDE_BY_SIDE = 5;

export type LinesReader = (input: LinesInput) => Promise<LinesAnswer>;

export interface LinesBackfillResult {
  /** Receipts whose lines were read and stored in this run. */
  read: number;
  /** Of those, how many add up to the receipt's total, and how many do not. */
  addUp: number;
  differ: number;
  /** Receipts the model found no lines on. */
  noLines: number;
  /** Receipts without stored text: they get no lines, and are listed. */
  noText: Array<{ rowId: string; name: string }>;
  /** Receipts whose reading failed in this run: they are tried again on the next. */
  failed: number;
  /** True when no language model is configured: the run stopped and nothing was counted against a receipt. */
  unavailable: boolean;
  /** Receipts still waiting for a run after this one (failed ones under the limit included). */
  remaining: number;
  inputTokens: number;
  outputTokens: number;
}

const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');
const number = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);

/** The receipts of a company that still need their lines read, newest first, and every receipt without text so far. */
async function pending(db: PrismaClient, workspaceId: string) {
  const ctx = await tableContext(db, workspaceId);
  if (!ctx) return null;
  const rows = await allReceiptRows(ctx.adapter, ctx.tableId, ctx.columns);
  const readings = await db.receiptItemReading.findMany({ where: { authWorkspaceId: workspaceId }, select: { rowId: true, outcome: true, attempts: true } });
  const byRow = new Map(readings.map((r) => [r.rowId, r]));
  const open = rows
    .filter((row) => {
      const r = byRow.get(row.id);
      return !r || (r.outcome === 'failed' && r.attempts < MAX_ATTEMPTS);
    })
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)) || (a.id < b.id ? -1 : 1));
  const noText = rows.filter((row) => byRow.get(row.id)?.outcome === 'no_text');
  return { ctx, open, noText };
}

/**
 * One run for one company: read the lines of at most `limit` receipts that
 * have none yet. Never throws for a single receipt; a receipt that fails is
 * counted and left for the next run.
 */
export async function backfillReceiptLines(db: PrismaClient, ctx: LineItemsContext, readLines: LinesReader, options: { limit?: number } = {}): Promise<LinesBackfillResult> {
  const limit = Math.max(1, options.limit ?? LINES_BATCH_LIMIT);
  const result: LinesBackfillResult = { read: 0, addUp: 0, differ: 0, noLines: 0, noText: [], failed: 0, unavailable: false, remaining: 0, inputTokens: 0, outputTokens: 0 };
  const found = await pending(db, ctx.workspaceId);
  if (!found) return result;
  const { columns } = found.ctx;
  const id = (name: string) => columns.find((c) => c.name === name)?.id;
  const [nameId, vendorId, textId, grossId, currencyId] = [id('Name'), id('Vendor'), id('OCR Text'), id('Gross'), id('Currency')];
  const currencyOptions = currencyId ? (found.ctx.selectOptions.get(currencyId) ?? (await found.ctx.adapter.getSelectOptions(currencyId))) : [];
  const currencyOf = (row: Row) => (currencyId ? (currencyOptions.find((o) => o.id === row.cells[currencyId])?.name ?? null) : null);
  const nameOf = (row: Row) => (nameId ? text(row.cells[nameId]) : '') || 'Beleg ohne Namen';
  const listed = new Map(found.noText.map((row) => [row.id, { rowId: row.id, name: nameOf(row) }]));

  const batch = found.open.slice(0, limit);
  const one = async (row: Row) => {
    const fullText = textId ? text(row.cells[textId]) : '';
    if (!fullText) {
      await recordUnread(db, ctx, row.id, 'no_text');
      listed.set(row.id, { rowId: row.id, name: nameOf(row) });
      return;
    }
    const gross = grossId ? number(row.cells[grossId]) : null;
    if (result.unavailable) return;
    let answer: LinesAnswer;
    try {
      answer = await readLines({ vendor: (vendorId && text(row.cells[vendorId])) || null, fullText, gross, currency: currencyOf(row) });
    } catch (err) {
      if (err instanceof ClassifierUnavailableError) {
        result.unavailable = true;
        return;
      }
      // The message only: an error object of the client library can carry the request, and with it the text.
      console.error('[line-items] the lines could not be read:', err instanceof Error ? `${err.name}: ${err.message}` : 'unknown error');
      // Only an unusable answer counts against the receipt; a call that did not get through is tried again freely.
      if (err instanceof UnusableAnswerError) await recordUnread(db, ctx, row.id, 'failed').catch(() => undefined);
      result.failed++;
      return;
    }
    result.inputTokens += answer.usage.inputTokens;
    result.outputTokens += answer.usage.outputTokens;
    if (answer.lines === null) {
      await recordUnread(db, ctx, row.id, 'failed', { source: 'backfill', model: answer.model }).catch(() => undefined);
      result.failed++;
      return;
    }
    const written = await replaceReceiptLines(db, ctx, row.id, { lines: answer.lines, source: 'backfill', textCut: answer.textCut, model: answer.model, usage: answer.usage }, { onlyIfUnread: true });
    if (!written) return;
    if (answer.lines.length === 0) {
      result.noLines++;
      return;
    }
    result.read++;
    const check = checkLines({ lineCount: answer.lines.length, linesSumCents: answer.lines.reduce((s, l) => s + l.grossCents, 0), linesNetCents: null, totalNetCents: null }, gross);
    if (check && !check.addsUp) result.differ++;
    else result.addUp++;
  };

  let next = 0;
  const worker = async () => {
    while (next < batch.length) {
      const row = batch[next++];
      try {
        await one(row);
      } catch (err) {
        console.error('[line-items] storing the lines failed:', err instanceof Error ? err.name : 'error');
        result.failed++;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(SIDE_BY_SIDE, batch.length) }, worker));

  // What is left: the receipts beyond this batch, and the ones of this batch that failed and may be tried again.
  const after = await db.receiptItemReading.findMany({ where: { authWorkspaceId: ctx.workspaceId, rowId: { in: found.open.map((r) => r.id) } }, select: { rowId: true, outcome: true, attempts: true } });
  const doneNow = new Map(after.map((r) => [r.rowId, r]));
  result.remaining = found.open.filter((row) => {
    const r = doneNow.get(row.id);
    return !r || (r.outcome === 'failed' && r.attempts < MAX_ATTEMPTS);
  }).length;
  result.noText = [...listed.values()];
  console.info('[line-items] backfill run', {
    read: result.read,
    addUp: result.addUp,
    differ: result.differ,
    noLines: result.noLines,
    noText: result.noText.length,
    failed: result.failed,
    unavailable: result.unavailable,
    remaining: result.remaining,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
  });
  return result;
}

/** The companies with a receipts table, for the daily run. */
export async function companiesWithReceipts(db: PrismaClient): Promise<Array<{ workspaceId: string; tenantId: string | null }>> {
  const tables = await db.dtTable.findMany({ where: { name: 'Receipts' }, select: { workspaceId: true, authTenantId: true } });
  const seen = new Set<string>();
  return tables.filter((t) => !seen.has(t.workspaceId) && seen.add(t.workspaceId)).map((t) => ({ workspaceId: t.workspaceId, tenantId: t.authTenantId }));
}

/**
 * The daily run: one bounded run per company, one company after the other.
 * A company that fails is logged and the next one goes on.
 */
export async function dailyLinesBackfill(db: PrismaClient, readLines: LinesReader): Promise<void> {
  for (const company of await companiesWithReceipts(db)) {
    try {
      await backfillReceiptLines(db, company, readLines, { limit: DAILY_LINES_LIMIT });
    } catch (err) {
      console.error('[line-items] the daily run failed for a company:', err instanceof Error ? err.name : 'error');
    }
  }
}
