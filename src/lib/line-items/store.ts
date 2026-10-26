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
import { sumGrossCents, textKey, vendorKey, type ReceiptLine } from './lines';

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
 * meanwhile; the return value says whether it was written.
 */
export async function replaceReceiptLines(db: PrismaClient, ctx: LineItemsContext, rowId: string, input: StoreLinesInput, options: { onlyIfUnread?: boolean } = {}): Promise<boolean> {
  return db.$transaction(async (tx) => {
    await lockRow(tx, rowId);
    const existing = await tx.receiptItemReading.findUnique({ where: { rowId }, select: { outcome: true, authWorkspaceId: true } });
    // A row id is unique across companies; a record of another company is never touched.
    if (existing && existing.authWorkspaceId !== ctx.workspaceId) return false;
    if (options.onlyIfUnread && settled(existing?.outcome)) return false;
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

/**
 * Record that a receipt's lines could not be read: it has no stored text, or
 * the model failed (counted, so the backfill stops after MAX_ATTEMPTS). Lines
 * that were read before stay: a failed reading never takes them away.
 */
export async function recordUnread(db: PrismaClient, ctx: LineItemsContext, rowId: string, outcome: 'no_text' | 'failed', meta: { source: LineSource; model?: string | null } = { source: 'backfill' }): Promise<void> {
  await db.$transaction(async (tx) => {
    await lockRow(tx, rowId);
    const existing = await tx.receiptItemReading.findUnique({ where: { rowId }, select: { outcome: true, attempts: true, authWorkspaceId: true } });
    if (existing && (existing.authWorkspaceId !== ctx.workspaceId || settled(existing.outcome))) return;
    const attempts = (existing?.attempts ?? 0) + (outcome === 'failed' ? 1 : 0);
    const data = { outcome, source: meta.source, lineCount: 0, linesSumCents: null, linesNetCents: null, totalNetCents: null, model: meta.model ?? null, attempts, readAt: new Date() };
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

/** Called by the row delete paths: a deleted receipt takes its lines and its reading with it. The kind answers stay: they belong to the shop. */
export async function deleteLinesForRows(db: Pick<PrismaClient, 'receiptItem' | 'receiptItemReading'>, rowIds: readonly string[]): Promise<void> {
  if (rowIds.length === 0) return;
  await db.receiptItem.deleteMany({ where: { rowId: { in: [...rowIds] } } });
  await db.receiptItemReading.deleteMany({ where: { rowId: { in: [...rowIds] } } });
}
