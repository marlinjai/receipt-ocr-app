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
 * Record that a receipt is a credit note and which invoice it corrects, and
 * link it where that invoice's receipt is found. Returns the linked row id,
 * or null when it is not linked (the review list then asks). A reading that
 * is no credit note removes an earlier reference of the row.
 */
export async function linkCreditNote(
  db: PrismaClient,
  adapter: ReferenceAdapter,
  tableId: string,
  ctx: ReferenceContext,
  rowId: string,
  /** Undefined for a reading that is no credit note; null for a credit note that names no invoice. */
  referencedInvoiceNumber: string | null | undefined,
): Promise<string | null> {
  if (referencedInvoiceNumber === undefined) {
    await db.receiptReference.deleteMany({ where: { rowId, authWorkspaceId: ctx.workspaceId } });
    return null;
  }
  const number = referencedInvoiceNumber?.trim() || null;
  const others = await db.receiptReference.findMany({ where: { authWorkspaceId: ctx.workspaceId }, select: { rowId: true } });
  const referencedRowId = number ? await findInvoiceRow(adapter, tableId, number, rowId, new Set(others.map((r) => r.rowId))) : null;
  await db.receiptReference.upsert({
    where: { rowId },
    create: { rowId, authWorkspaceId: ctx.workspaceId, authTenantId: ctx.tenantId, kind: 'credit_note', referencedInvoiceNumber: number, referencedRowId },
    update: { kind: 'credit_note', referencedInvoiceNumber: number, referencedRowId },
  });
  return referencedRowId;
}

/**
 * Bring the credit note links a stored receipt can change up to date: the
 * references whose invoice number this receipt's text carries, and those
 * already linked to it. Each is linked to the one receipt that now carries its
 * number (never another credit note or a negative row), or to none. Run after
 * any receipt is stored or read again, and after one is deleted, so an
 * invoice arriving after its credit note, a second carrier of the number, an
 * invoice read again with other text, and a credit note and its invoice
 * uploaded together all end in the same state. Without `changed` every
 * reference of the workspace is checked.
 */
export async function relinkCreditNotes(
  db: PrismaClient,
  adapter: ReferenceAdapter,
  tableId: string,
  ctx: ReferenceContext,
  changed?: { rowId: string; text: string },
): Promise<void> {
  const references = await db.receiptReference.findMany({ where: { authWorkspaceId: ctx.workspaceId } });
  if (references.length === 0) return;
  const creditNotes = new Set(references.map((r) => r.rowId));
  const affected = changed
    ? references.filter(
        (r) =>
          r.rowId !== changed.rowId &&
          (r.referencedRowId === changed.rowId || (r.referencedInvoiceNumber !== null && carriesInvoiceNumber(changed.text, r.referencedInvoiceNumber))),
      )
    : references;
  for (const reference of affected) {
    const found = reference.referencedInvoiceNumber ? await findInvoiceRow(adapter, tableId, reference.referencedInvoiceNumber, reference.rowId, creditNotes) : null;
    if (found !== reference.referencedRowId) {
      // updateMany: a reference deleted meanwhile is no reason to stop the others.
      await db.receiptReference.updateMany({ where: { rowId: reference.rowId, authWorkspaceId: ctx.workspaceId }, data: { referencedRowId: found } });
    }
  }
}
