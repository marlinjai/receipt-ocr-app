import type { PrismaClient } from '@prisma/client';
import type { CellValue, QueryOptions } from '@marlinjai/data-table-core';
import { isGroupRow } from '@/lib/receipts-kind';

/**
 * A credit note and the invoice it corrects.
 *
 * An electronic credit note names the invoice it refers to (BT-25, read in
 * src/lib/einvoice). The invoice is found among the workspace's stored
 * receipts by that number in their recognized text, as a whole token ("R-17"
 * is not inside "R-170"). Exactly one receipt carrying it is linked; none, or
 * several, keep the number only, and the review list asks for it.
 */

interface ReferenceAdapter {
  getColumns(tableId: string): Promise<Array<{ id: string; name: string; type?: string }>>;
  getRows(
    tableId: string,
    query?: QueryOptions,
  ): Promise<{ items: Array<{ id: string; archived?: boolean; cells: Record<string, CellValue> }>; hasMore: boolean }>;
}

const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** True when `text` carries `number` as a whole token, not as part of a longer number or word. */
export function carriesInvoiceNumber(text: string, number: string): boolean {
  const trimmed = number.trim();
  if (trimmed.length < 3) return false;
  return new RegExp(`(?<![\\p{L}\\p{N}/-])${escape(trimmed)}(?![\\p{L}\\p{N}]|[/-][\\p{L}\\p{N}])`, 'iu').test(text);
}

/**
 * The one stored receipt (other than `selfRowId`) whose text carries the
 * number; null for none or several. A credit note is never the invoice: rows
 * in `creditNotes`, and rows with a negative total, are passed over (a second
 * credit note for the same invoice names it too).
 */
export async function findInvoiceRow(
  adapter: ReferenceAdapter,
  tableId: string,
  number: string,
  selfRowId: string,
  creditNotes: ReadonlySet<string> = new Set(),
): Promise<string | null> {
  if (number.trim().length < 3) return null;
  const columns = await adapter.getColumns(tableId);
  const textId = columns.find((c) => c.name === 'OCR Text')?.id;
  const grossId = columns.find((c) => c.name === 'Gross')?.id;
  if (!textId) return null;
  const matches = new Set<string>();
  for (let offset = 0; ; ) {
    const page = await adapter.getRows(tableId, { filters: [{ columnId: textId, operator: 'contains', value: number.trim() }], limit: 200, offset });
    for (const row of page.items) {
      if (row.id === selfRowId || row.archived || isGroupRow(row, columns) || creditNotes.has(row.id)) continue;
      const gross = grossId ? Number(row.cells[grossId]) : NaN;
      if (Number.isFinite(gross) && gross < 0) continue;
      const text = row.cells[textId];
      if (typeof text === 'string' && carriesInvoiceNumber(text, number)) matches.add(row.id);
      if (matches.size > 1) return null;
    }
    if (!page.hasMore || page.items.length === 0) break;
    offset += page.items.length;
  }
  return matches.size === 1 ? [...matches][0] : null;
}

export interface ReferenceContext {
  workspaceId: string;
  tenantId: string | null;
}

/**
 * Record which invoice a credit note corrects, and link it where its receipt
 * is found. Returns the linked row id, or null when only the number is kept.
 * A reading that is no credit note (or names no invoice) removes an earlier
 * reference of the row.
 */
export async function linkCreditNote(
  db: PrismaClient,
  adapter: ReferenceAdapter,
  tableId: string,
  ctx: ReferenceContext,
  rowId: string,
  referencedInvoiceNumber: string | null,
): Promise<string | null> {
  if (!referencedInvoiceNumber?.trim()) {
    await db.receiptReference.deleteMany({ where: { rowId, authWorkspaceId: ctx.workspaceId } });
    return null;
  }
  const number = referencedInvoiceNumber.trim();
  const others = await db.receiptReference.findMany({ where: { authWorkspaceId: ctx.workspaceId }, select: { rowId: true } });
  const referencedRowId = await findInvoiceRow(adapter, tableId, number, rowId, new Set(others.map((r) => r.rowId)));
  await db.receiptReference.upsert({
    where: { rowId },
    create: { rowId, authWorkspaceId: ctx.workspaceId, authTenantId: ctx.tenantId, kind: 'credit_note', referencedInvoiceNumber: number, referencedRowId },
    update: { kind: 'credit_note', referencedInvoiceNumber: number, referencedRowId },
  });
  return referencedRowId;
}

/**
 * An invoice that arrives after its credit note: the credit notes of the
 * workspace still waiting for their invoice, whose number this receipt's text
 * carries, are linked to it, and their "credit note without invoice" doubt
 * ends. Returns the credit notes linked. A receipt that is itself a credit
 * note links nothing.
 */
export async function linkWaitingCreditNotes(db: PrismaClient, ctx: ReferenceContext, rowId: string, text: string): Promise<string[]> {
  if (!text.trim()) return [];
  const waiting = await db.receiptReference.findMany({ where: { authWorkspaceId: ctx.workspaceId, referencedRowId: null, NOT: { rowId } } });
  const linked: string[] = [];
  for (const reference of waiting) {
    if (!carriesInvoiceNumber(text, reference.referencedInvoiceNumber)) continue;
    await db.receiptReference.update({ where: { rowId: reference.rowId }, data: { referencedRowId: rowId } });
    const review = await db.receiptReview.findUnique({ where: { rowId: reference.rowId } });
    if (review?.flags.includes('credit_note')) {
      await db.receiptReview.update({ where: { rowId: reference.rowId }, data: { flags: review.flags.filter((f) => f !== 'credit_note') } });
    }
    linked.push(reference.rowId);
  }
  return linked;
}
