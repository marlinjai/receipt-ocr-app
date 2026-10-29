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
import type { StructuredReceiptFields } from '@/lib/einvoice';
import { linesFromInvoice } from './einvoice';
import { checkLines, sumGrossCents } from './lines';
import { MAX_ATTEMPTS, MAX_TRANSIENT_FAILURES, recordUnread, replaceReceiptLines, type LineItemsContext } from './store';

/** How many receipts one run from the receipts page reads: each is one model call, side by side, so the request answers well within a proxy's time limit; the page asks again. */
export const LINES_BATCH_LIMIT = 5;
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

type ReadingState = { outcome: string; attempts: number; transientFailures: number };

/**
 * Whether a receipt still needs its lines read: never read; failed and under
 * the attempt limit; or recorded without text and holding text now (a retake
 * or a new reading of the page brought it).
 */
function isOpen(reading: ReadingState | undefined, hasText: boolean): boolean {
  if (!reading) return true;
  if (reading.outcome === 'failed') return reading.attempts < MAX_ATTEMPTS && reading.transientFailures < MAX_TRANSIENT_FAILURES;
  return reading.outcome === 'no_text' && hasText;
}

/**
 * True when a failed call says something about the receipt, not about the
 * moment: an unusable answer, or a request the provider refused as such (a
 * 4xx other than authentication, payment, timeout, conflict and rate limit).
 * Those count towards the attempt limit; a call that did not get through is
 * counted apart (MAX_TRANSIENT_FAILURES in a row), so an outage never stops a
 * receipt but one that times out on every run does.
 */
function countsAgainstReceipt(err: unknown): boolean {
  if (err instanceof UnusableAnswerError) return true;
  const status = (err as { status?: unknown } | null)?.status;
  return typeof status === 'number' && status >= 400 && status < 500 && ![401, 402, 403, 408, 409, 429].includes(status);
}

/** The receipt's fields as an electronic invoice states them, from a stored file (XRechnung, ZUGFeRD); null for any other file. */
export type StructuredOf = (fileId: string) => Promise<StructuredReceiptFields | null>;

export interface BackfillOptions {
  limit?: number;
  /**
   * Reads a stored PDF or XML file as an electronic invoice. With it, an
   * electronic invoice stored before lines were kept takes its lines from its
   * XML (its stored text names no positions); without it, from its text.
   */
  structuredOf?: StructuredOf;
}

/**
 * One run for one company: read the lines of at most `limit` receipts that
 * have none yet. Never throws for a single receipt; a receipt that fails is
 * counted and left for the next run.
 */
export async function backfillReceiptLines(db: PrismaClient, ctx: LineItemsContext, readLines: LinesReader, options: BackfillOptions = {}): Promise<LinesBackfillResult> {
  const limit = Math.max(1, options.limit ?? LINES_BATCH_LIMIT);
  const result: LinesBackfillResult = { read: 0, addUp: 0, differ: 0, noLines: 0, noText: [], failed: 0, unavailable: false, remaining: 0, inputTokens: 0, outputTokens: 0 };
  const table = await tableContext(db, ctx.workspaceId);
  if (!table) return result;
  const { columns } = table;
  const id = (name: string) => columns.find((c) => c.name === name)?.id;
  const [nameId, vendorId, textId, grossId, currencyId] = [id('Name'), id('Vendor'), id('OCR Text'), id('Gross'), id('Currency')];
  const currencyOptions = currencyId ? (table.selectOptions.get(currencyId) ?? (await table.adapter.getSelectOptions(currencyId))) : [];
  const currencyOf = (row: Row) => (currencyId ? (currencyOptions.find((o) => o.id === row.cells[currencyId])?.name ?? null) : null);
  const nameOf = (row: Row) => (nameId ? text(row.cells[nameId]) : '') || 'Beleg ohne Namen';
  const textOf = (row: Row) => (textId ? text(row.cells[textId]) : '');

  const rows = await allReceiptRows(table.adapter, table.tableId, columns);
  const readingsOf = async (rowIds: string[]) =>
    new Map((await db.receiptItemReading.findMany({ where: { authWorkspaceId: ctx.workspaceId, rowId: { in: rowIds } }, select: { rowId: true, outcome: true, attempts: true, transientFailures: true } })).map((r) => [r.rowId, r]));
  const readings = await readingsOf(rows.map((r) => r.id));
  // Receipts never tried before those that failed, so one that keeps failing never blocks a batch; within each, newest first.
  const tried = (row: Row) => (readings.get(row.id)?.outcome === 'failed' ? 1 : 0);
  const open = rows
    .filter((row) => isOpen(readings.get(row.id), textOf(row) !== ''))
    .sort((a, b) => tried(a) - tried(b) || new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime() || (a.id < b.id ? -1 : 1));
  // Asked under the receipt's lock before a write: a receipt deleted during its model call gets nothing back.
  const stillThere = (rowId: string) => async () => {
    const row = await table.adapter.getRow(rowId);
    return row !== null && row.tableId === table.tableId && !row.archived;
  };
  const listed = new Map(rows.filter((row) => readings.get(row.id)?.outcome === 'no_text' && !textOf(row)).map((row) => [row.id, { rowId: row.id, name: nameOf(row) }]));

  const batch = open.slice(0, limit);
  // The stored PDF or XML file of each receipt of the batch, where one might be an electronic invoice.
  const invoiceFile = new Map<string, string>();
  if (options.structuredOf && batch.length > 0) {
    const files = await db.dtFile.findMany({ where: { rowId: { in: batch.map((r) => r.id) } }, select: { rowId: true, fileId: true, mimeType: true, metadata: true } });
    const uploaded = (f: (typeof files)[number]) => (f.metadata as { source?: unknown } | null)?.source === 'ocr-upload';
    for (const f of [...files].sort((a, b) => Number(uploaded(b)) - Number(uploaded(a)))) {
      if (!invoiceFile.has(f.rowId) && /pdf|xml/i.test(f.mimeType)) invoiceFile.set(f.rowId, f.fileId);
    }
  }
  /** The receipt's invoice fields; throws when its file could not be fetched (tried again on the next run, never read from its text instead). */
  const fieldsOf = async (row: Row): Promise<StructuredReceiptFields | null> => {
    const fileId = invoiceFile.get(row.id);
    if (!fileId || !options.structuredOf) return null;
    return options.structuredOf(fileId);
  };

  /** 'unusable' was recorded against the receipt; 'transient' was not (and is recorded by the caller where it writes nothing). */
  const ask = async (row: Row, fullText: string, gross: number | null): Promise<LinesAnswer | 'unusable' | 'transient' | 'unavailable'> => {
    try {
      const answer = await readLines({ vendor: (vendorId && text(row.cells[vendorId])) || null, fullText, gross, currency: currencyOf(row) });
      result.inputTokens += answer.usage.inputTokens;
      result.outputTokens += answer.usage.outputTokens;
      return answer;
    } catch (err) {
      if (err instanceof ClassifierUnavailableError) {
        result.unavailable = true;
        return 'unavailable';
      }
      // The message only: an error object of the client library can carry the request, and with it the text.
      console.error('[line-items] the lines could not be read:', err instanceof Error ? `${err.name}: ${err.message}` : 'unknown error');
      return countsAgainstReceipt(err) ? 'unusable' : 'transient';
    }
  };
  const recordFailure = async (row: Row, kind: 'failed' | 'transient', model: string | null = null) => {
    await recordUnread(db, ctx, row.id, kind, { source: 'backfill', model, rowExists: stillThere(row.id) }).catch((err) =>
      console.error('[line-items] recording a failed reading failed:', err instanceof Error ? err.name : 'error'),
    );
    result.failed++;
  };

  const tally = (lines: readonly { grossCents: number }[], check: ReturnType<typeof checkLines>) => {
    if (lines.length === 0) {
      result.noLines++;
      return;
    }
    result.read++;
    if (check && !check.addsUp) result.differ++;
    else result.addUp++;
  };

  const one = async (row: Row) => {
    if (result.unavailable) return;
    const gross = grossId ? number(row.cells[grossId]) : null;
    let fields: StructuredReceiptFields | null;
    try {
      fields = await fieldsOf(row);
    } catch (err) {
      console.error('[line-items] the stored file could not be fetched:', err instanceof Error ? err.name : 'error');
      await recordFailure(row, 'transient');
      return;
    }
    if (fields && fields.lines.length > 0) {
      // An electronic invoice: its lines are the XML's. The model is asked only for their kinds, from the
      // invoice's text that lists them. A call that did not get through writes nothing (the next run asks
      // again); after an unusable answer the XML's lines are stored as "Sonstiges", a person corrects them.
      const answer = await ask(row, fields.text, gross);
      if (answer === 'unavailable') return;
      if (answer === 'transient') {
        await recordFailure(row, 'transient');
        return;
      }
      const invoice = linesFromInvoice(fields, answer === 'unusable' ? null : answer.lines)!;
      const written = await replaceReceiptLines(
        db,
        ctx,
        row.id,
        { lines: invoice.lines, source: 'einvoice', linesNetCents: invoice.linesNetCents, totalNetCents: invoice.totalNetCents, model: answer === 'unusable' ? null : answer.model, usage: answer === 'unusable' ? null : answer.usage },
        { onlyIfUnread: true, rowExists: stillThere(row.id) },
      );
      if (written) tally(invoice.lines, checkLines({ lineCount: invoice.lines.length, linesSumCents: null, linesNetCents: invoice.linesNetCents, totalNetCents: invoice.totalNetCents }, gross));
      return;
    }
    const fullText = textOf(row);
    if (!fullText) {
      await recordUnread(db, ctx, row.id, 'no_text', { source: 'backfill', rowExists: stillThere(row.id) });
      listed.set(row.id, { rowId: row.id, name: nameOf(row) });
      return;
    }
    const answer = await ask(row, fullText, gross);
    if (answer === 'unavailable') return;
    if (answer === 'transient' || answer === 'unusable') {
      await recordFailure(row, answer === 'unusable' ? 'failed' : 'transient');
      return;
    }
    if (answer.lines === null) {
      await recordFailure(row, 'failed', answer.model);
      return;
    }
    const written = await replaceReceiptLines(db, ctx, row.id, { lines: answer.lines, source: 'backfill', textCut: answer.textCut, model: answer.model, usage: answer.usage }, { onlyIfUnread: true, rowExists: stillThere(row.id) });
    if (written) tally(answer.lines, checkLines({ lineCount: answer.lines.length, linesSumCents: sumGrossCents(answer.lines), linesNetCents: null, totalNetCents: null }, gross));
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

  // What is left: the receipts beyond this batch, and the ones of this batch that may be tried again.
  const after = await readingsOf(open.map((r) => r.id));
  result.remaining = open.filter((row) => isOpen(after.get(row.id), textOf(row) !== '')).length;
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

/** How many receipts the daily run reads across all companies: a bound on what one day may cost. */
export const DAILY_TOTAL_LIMIT = 120;

/**
 * The daily run: one bounded run per company, one company after the other,
 * at most DAILY_TOTAL_LIMIT receipts in all. A company that fails is logged
 * and the next one goes on.
 */
export async function dailyLinesBackfill(
  db: PrismaClient,
  readLines: LinesReader,
  options: Pick<BackfillOptions, 'structuredOf'> & { companies?: Array<{ workspaceId: string; tenantId: string | null }>; totalLimit?: number } = {},
): Promise<void> {
  let budget = options.totalLimit ?? DAILY_TOTAL_LIMIT;
  for (const company of options.companies ?? (await companiesWithReceipts(db))) {
    if (budget <= 0) break;
    try {
      const run = await backfillReceiptLines(db, company, readLines, { structuredOf: options.structuredOf, limit: Math.min(DAILY_LINES_LIMIT, budget) });
      if (run.unavailable) break;
      budget -= run.read + run.noLines + run.failed;
    } catch (err) {
      console.error('[line-items] the daily run failed for a company:', err instanceof Error ? err.name : 'error');
    }
  }
}
