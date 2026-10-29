/**
 * Storing a receipt's lines (plan docs/plans/2026-10-26-receipt-line-items.md).
 *
 * Every write of lines goes through `replaceReceiptLines`: the old lines go,
 * the new ones come, and the reading record is written, in one transaction.
 * That is the one guarantee the plan asks for: a receipt never holds half its
 * lines, and a receipt read again holds only the new ones.
 *
 * A person's kind answers are not on the lines. They are kept per shop and
 * text (receipt_item_kind_answers) and stand over the read kind on read, so a
 * receipt read again keeps them for every line with the same text, and every
 * other receipt of the shop gets them too.
 */

import type { Prisma, PrismaClient } from '@prisma/client';
import { isPurchaseKind, type PurchaseKind } from './kinds';
import { priceLines, sumGrossCents, textKey, vendorKey, type PricingTotals, type ReceiptLine } from './lines';

export interface LineItemsContext {
  workspaceId: string;
  tenantId: string | null;
}

/** Where the lines came from: the reading of a new or re-read receipt, an electronic invoice's XML, or the backfill of a stored text. */
export type LineSource = 'reading' | 'einvoice' | 'backfill';
/**
 * 'lines': lines are stored. 'no_lines': the reading found none. 'no_text': the receipt has no stored
 * text to read them from. 'failed': the model could not be asked or answered nothing usable; tried again.
 */
export type ReadingOutcome = 'lines' | 'no_lines' | 'no_text' | 'failed';

/** How often the backfill tries a receipt whose reading failed before it stops asking. */
export const MAX_ATTEMPTS = 3;
/** How many calls in a row may not get through for one receipt (a timeout every time) before it is no longer asked about. */
export const MAX_TRANSIENT_FAILURES = 6;

export interface StoreLinesInput {
  lines: readonly ReceiptLine[];
  source: LineSource;
  /** An electronic invoice's lines are checked on net: their net sum and the invoice's net total. */
  linesNetCents?: number | null;
  totalNetCents?: number | null;
  textCut?: boolean;
  model?: string | null;
  usage?: { inputTokens: number; outputTokens: number } | null;
}

type Tx = Prisma.TransactionClient;

/** One receipt at a time: a backfill and a new reading of the same receipt never interleave their writes. */
async function lockRow(tx: Tx, rowId: string) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`receipt_items:${rowId}`}))`;
}

const settled = (outcome: string | undefined) => outcome === 'lines' || outcome === 'no_lines';

/**
 * Replace a receipt's lines and record the reading, in one transaction. With
 * `onlyIfUnread` (the backfill), nothing is written when the receipt was read
 * meanwhile. With `keepOverEmpty` (a new reading of the page), an empty list
 * never replaces lines that are stored: a blurry retake that shows no lines
 * says nothing against the lines read before. The return value says whether
 * it was written.
 */
export interface WriteOptions {
  /**
   * Asked under the receipt's lock, before anything is written: false when the receipt was deleted
   * meanwhile (a long model call), so no lines come back for a receipt that is gone. The delete path
   * removes the lines under the same lock after the row is gone.
   */
  rowExists?: () => Promise<boolean>;
}

export async function replaceReceiptLines(db: PrismaClient, ctx: LineItemsContext, rowId: string, input: StoreLinesInput, options: WriteOptions & { onlyIfUnread?: boolean; keepOverEmpty?: boolean } = {}): Promise<boolean> {
  return db.$transaction(async (tx) => {
    await lockRow(tx, rowId);
    if (options.rowExists && !(await options.rowExists())) return false;
    const existing = await tx.receiptItemReading.findUnique({ where: { rowId }, select: { outcome: true, authWorkspaceId: true } });
    // A row id is unique across companies; a record of another company is never touched.
    if (existing && existing.authWorkspaceId !== ctx.workspaceId) return false;
    if (options.onlyIfUnread && settled(existing?.outcome)) return false;
    if (options.keepOverEmpty && input.lines.length === 0 && existing?.outcome === 'lines') return false;
    await tx.receiptItem.deleteMany({ where: { authWorkspaceId: ctx.workspaceId, rowId } });
    if (input.lines.length > 0) {
      await tx.receiptItem.createMany({
        data: input.lines.map((l, position) => ({
          authWorkspaceId: ctx.workspaceId,
          authTenantId: ctx.tenantId,
          rowId,
          position,
          text: l.text,
          quantity: l.quantity,
          unitPriceCents: l.unitPriceCents,
          grossCents: l.grossCents,
          netCents: l.netCents,
          taxRate: l.taxRate,
          kind: l.kind,
        })),
      });
    }
    const data = {
      outcome: input.lines.length > 0 ? 'lines' : 'no_lines',
      source: input.source,
      lineCount: input.lines.length,
      linesSumCents: input.lines.length > 0 ? sumGrossCents(input.lines) : null,
      linesNetCents: input.linesNetCents ?? null,
      totalNetCents: input.totalNetCents ?? null,
      textCut: input.textCut ?? false,
      model: input.model ?? null,
      inputTokens: input.usage?.inputTokens ?? null,
      outputTokens: input.usage?.outputTokens ?? null,
      transientFailures: 0,
      readAt: new Date(),
    };
    await tx.receiptItemReading.upsert({
      where: { rowId },
      create: { rowId, authWorkspaceId: ctx.workspaceId, authTenantId: ctx.tenantId, attempts: 0, ...data },
      update: data,
    });
    return true;
  });
}

/** What `repriceStoredLines` did with one receipt. */
export type RepriceOutcome = 'rederived' | 'unchanged' | 'skipped';

/**
 * Settle again whether a receipt's stored lines are gross or net (`priceLines`),
 * from the stored lines and the row's figures as they are now; no model is
 * asked. For lines stored before prices before tax were told apart (an
 * invoice's net amounts taken as gross, which "Was gekauft" counted short by
 * the tax), and for net lines whose row was corrected since (their gross is
 * derived from the row's gross again). Under the receipt's lock, so it never
 * interleaves with a reading: a receipt read again meanwhile is priced as its
 * new lines stand. Idempotent: a second run finds nothing to change.
 *
 * Only the amounts and the reading's sums change: never the lines' texts or
 * kinds, nor when and how they were read (a confirmation in the review list
 * is weighed against the reading's time). An electronic invoice's lines are
 * its XML's and are left alone ('skipped'), as is a receipt without lines or
 * of another company.
 */
export async function repriceStoredLines(db: PrismaClient, ctx: LineItemsContext, rowId: string, totals: PricingTotals): Promise<RepriceOutcome> {
  return db.$transaction(async (tx) => {
    await lockRow(tx, rowId);
    const reading = await tx.receiptItemReading.findUnique({ where: { rowId }, select: { outcome: true, source: true, authWorkspaceId: true, linesSumCents: true, linesNetCents: true } });
    if (!reading || reading.authWorkspaceId !== ctx.workspaceId || reading.outcome !== 'lines' || reading.source === 'einvoice') return 'skipped';
    const items = await tx.receiptItem.findMany({ where: { authWorkspaceId: ctx.workspaceId, rowId }, orderBy: { position: 'asc' } });
    if (items.length === 0) return 'skipped';
    // The amounts as printed: the net of lines priced before tax, else the stored amount.
    const priorNet = items.every((i) => i.netCents !== null);
    const printed: ReceiptLine[] = items.map((i) => ({
      text: i.text,
      quantity: i.quantity,
      unitPriceCents: i.unitPriceCents,
      grossCents: priorNet ? i.netCents! : i.grossCents,
      netCents: null,
      taxRate: i.taxRate,
      kind: isPurchaseKind(i.kind) ? i.kind : 'other',
    }));
    // Lines settled as net once stay net where the row's figures say nothing against it.
    const priced = priceLines(printed, totals, priorNet ? true : null);
    const linesSumCents = sumGrossCents(priced.lines);
    const changed = items.filter((i, k) => i.grossCents !== priced.lines[k].grossCents || i.netCents !== priced.lines[k].netCents);
    if (changed.length === 0 && reading.linesSumCents === linesSumCents && reading.linesNetCents === priced.linesNetCents) return 'unchanged';
    for (const item of changed) {
      const line = priced.lines[items.indexOf(item)];
      await tx.receiptItem.update({ where: { id: item.id }, data: { grossCents: line.grossCents, netCents: line.netCents } });
    }
    await tx.receiptItemReading.update({ where: { rowId }, data: { linesSumCents, linesNetCents: priced.linesNetCents } });
    return 'rederived';
  });
}

/**
 * Record that a receipt's lines could not be read: it has no stored text
 * ('no_text'), the answer was unusable ('failed', counted towards
 * MAX_ATTEMPTS), or the call did not get through ('transient', counted apart
 * towards MAX_TRANSIENT_FAILURES and reset by any reading). Lines that were
 * read before stay: a failed reading never takes them away.
 */
export async function recordUnread(db: PrismaClient, ctx: LineItemsContext, rowId: string, outcome: 'no_text' | 'failed' | 'transient', meta: WriteOptions & { source: LineSource; model?: string | null } = { source: 'backfill' }): Promise<void> {
  await db.$transaction(async (tx) => {
    await lockRow(tx, rowId);
    if (meta.rowExists && !(await meta.rowExists())) return;
    const existing = await tx.receiptItemReading.findUnique({ where: { rowId }, select: { outcome: true, attempts: true, transientFailures: true, authWorkspaceId: true } });
    if (existing && (existing.authWorkspaceId !== ctx.workspaceId || settled(existing.outcome))) return;
    const attempts = (existing?.attempts ?? 0) + (outcome === 'failed' ? 1 : 0);
    const transientFailures = outcome === 'transient' ? (existing?.transientFailures ?? 0) + 1 : 0;
    const data = { outcome: outcome === 'no_text' ? 'no_text' : 'failed', source: meta.source, lineCount: 0, linesSumCents: null, linesNetCents: null, totalNetCents: null, model: meta.model ?? null, attempts, transientFailures, readAt: new Date() };
    await tx.receiptItemReading.upsert({ where: { rowId }, create: { rowId, authWorkspaceId: ctx.workspaceId, authTenantId: ctx.tenantId, ...data }, update: data });
  });
}

/** A person's kind answers of a company, by shop and text. */
export type KindAnswers = ReadonlyMap<string, PurchaseKind>;

export const answerKey = (vendor: string | null | undefined, text: string) => `${vendorKey(vendor)}|${textKey(text)}`;

export async function loadKindAnswers(db: PrismaClient, workspaceId: string): Promise<KindAnswers> {
  const rows = await db.receiptItemKindAnswer.findMany({ where: { authWorkspaceId: workspaceId }, select: { vendorKey: true, textKey: true, kind: true } });
  const out = new Map<string, PurchaseKind>();
  for (const r of rows) if (isPurchaseKind(r.kind)) out.set(`${r.vendorKey}|${r.textKey}`, r.kind);
  return out;
}

/** A stored line with the kind it counts under: a person's answer for its text at its shop, else the read kind. */
export interface StoredLine {
  id: string;
  rowId: string;
  position: number;
  text: string;
  quantity: number | null;
  unitPriceCents: number | null;
  grossCents: number;
  netCents: number | null;
  taxRate: number | null;
  readKind: PurchaseKind;
  kind: PurchaseKind;
  /** True when the kind is a person's answer. */
  answered: boolean;
}

type ItemRow = { id: string; rowId: string; position: number; text: string; quantity: number | null; unitPriceCents: number | null; grossCents: number; netCents: number | null; taxRate: number | null; kind: string };

export function withAnswers(item: ItemRow, vendor: string | null, answers: KindAnswers): StoredLine {
  const readKind: PurchaseKind = isPurchaseKind(item.kind) ? item.kind : 'other';
  const answer = answers.get(answerKey(vendor, item.text));
  return {
    id: item.id,
    rowId: item.rowId,
    position: item.position,
    text: item.text,
    quantity: item.quantity,
    unitPriceCents: item.unitPriceCents,
    grossCents: item.grossCents,
    netCents: item.netCents,
    taxRate: item.taxRate,
    readKind,
    kind: answer ?? readKind,
    answered: answer !== undefined && answer !== readKind,
  };
}

export class LineItemsError extends Error {
  constructor(readonly code: 'line_not_found' | 'invalid_kind' | 'no_vendor') {
    super(code);
    this.name = 'LineItemsError';
  }
}

/**
 * A person's kind for a line: remembered for the line's text at the receipt's
 * shop. Choosing the kind the line was read with takes the answer back.
 * `vendor` is the receipt's vendor as the row holds it now.
 */
export async function answerLineKind(db: PrismaClient, ctx: LineItemsContext, lineId: string, kind: unknown, vendor: string | null, options: { rowId?: string } = {}): Promise<{ rowId: string }> {
  if (!isPurchaseKind(kind)) throw new LineItemsError('invalid_kind');
  // A receipt without a vendor names no shop: an answer for it would apply to every receipt without one.
  if (!vendorKey(vendor)) throw new LineItemsError('no_vendor');
  // With `rowId`, only a line of that receipt: a line id of another receipt is not answered through this one.
  const line = await db.receiptItem.findFirst({ where: { id: lineId, authWorkspaceId: ctx.workspaceId, ...(options.rowId ? { rowId: options.rowId } : {}) }, select: { rowId: true, text: true, kind: true } });
  if (!line) throw new LineItemsError('line_not_found');
  const where = { authWorkspaceId_vendorKey_textKey: { authWorkspaceId: ctx.workspaceId, vendorKey: vendorKey(vendor), textKey: textKey(line.text) } };
  if (kind === line.kind) {
    await db.receiptItemKindAnswer.deleteMany({ where: { authWorkspaceId: ctx.workspaceId, vendorKey: vendorKey(vendor), textKey: textKey(line.text) } });
  } else {
    await db.receiptItemKindAnswer.upsert({
      where,
      create: { authWorkspaceId: ctx.workspaceId, authTenantId: ctx.tenantId, vendorKey: vendorKey(vendor), textKey: textKey(line.text), kind },
      update: { kind },
    });
  }
  return { rowId: line.rowId };
}

/**
 * Called by the row delete paths after the row is gone: a deleted receipt takes its lines and its
 * reading with it, under the receipt's lock, so a reading that was under way when the receipt was
 * deleted either finished before (and is removed here) or finds the row gone. The kind answers stay:
 * they belong to the shop.
 */
export async function deleteLinesForRows(db: PrismaClient, rowIds: readonly string[]): Promise<void> {
  for (const rowId of new Set(rowIds)) {
    await db.$transaction(async (tx) => {
      await lockRow(tx, rowId);
      await tx.receiptItem.deleteMany({ where: { rowId } });
      await tx.receiptItemReading.deleteMany({ where: { rowId } });
    });
  }
}
