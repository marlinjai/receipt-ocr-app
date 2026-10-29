import 'server-only';
import type { PrismaClient } from '@prisma/client';
import type { Column, Row } from '@marlinjai/data-table-core';
import { firstColumnIdByName } from '@/lib/column-lookup';
import { INVOICE_NUMBER_COLUMN, cleanInvoiceNumber, invoiceNumberKey } from '@/lib/extraction/invoice-number';
import { allReceiptRows, tableContext, type TableContext } from '@/lib/meals/service';
import { isoDay } from '@/lib/meals/record';
import { isGroupRow } from '@/lib/receipts-kind';
import { automaticDuplicate, sameInvoice, type AutomaticDuplicate, type ReviewSnapshot } from './reasons';

/**
 * The same receipt twice, settled without asking anybody (plan
 * docs/plans/2026-10-29-invoice-number-duplicates.md, decisions 2 and 5).
 *
 * Two receipts are one when they hold the very same file, or when the same
 * vendor issued both under the same invoice number (`automaticDuplicate`).
 * The pass keeps the more complete one and ARCHIVES the other: never a hard
 * delete. The archived receipt's payment links, meal guests and tax decision move to the
 * kept one (where it is not linked to the payment, lists the guest or holds a
 * decision already) and its files the kept one
 * lacks are added there as further references, so nothing it carried is out
 * of sight. Everything the merge changed is recorded (`receipt_merges`), and
 * `restoreMergedReceipt` undoes exactly that.
 *
 * A pair a person said is different ("Beide behalten", or a restore) is never
 * merged. The pass runs where receipts change (upload, retake, a new reading,
 * a person editing a number, the backfill, daily), never on a read.
 */

export interface MergeContext {
  workspaceId: string;
  tenantId: string | null;
}

export class MergeError extends Error {
  code: 'not_initialized' | 'not_merged';
  constructor(code: MergeError['code']) {
    super(code);
    this.name = 'MergeError';
    this.code = code;
  }
}

/** One receipt with what makes it the one to keep, worst to best compared in `keepFirst`. */
export interface MergeCandidate extends ReviewSnapshot {
  createdAt: Date;
  /** Payment links that name the receipt. */
  payments: number;
  inGroup: boolean;
  /** Of assignment and category, how many are filled. */
  decisions: number;
  files: number;
  /** A person's entries that hang off the receipt: meal guests, a tax decision. */
  personEntries: number;
  /** The number as printed, for the record. */
  invoiceNumber: string | null;
}

/**
 * Negative when `a` is the one to keep: more linked payments, in a group,
 * assignment and category filled, more files, more of a person's entries,
 * then the older, then the smaller id (decision 14).
 */
export function keepFirst(a: MergeCandidate, b: MergeCandidate): number {
  return (
    b.payments - a.payments ||
    Number(b.inGroup) - Number(a.inGroup) ||
    b.decisions - a.decisions ||
    b.files - a.files ||
    b.personEntries - a.personEntries ||
    a.createdAt.getTime() - b.createdAt.getTime() ||
    (a.rowId < b.rowId ? -1 : a.rowId > b.rowId ? 1 : 0)
  );
}

export interface PlannedMerge {
  rowId: string;
  keptRowId: string;
  reason: AutomaticDuplicate;
}

/**
 * Which receipts go into which, best first: each receipt goes into the first
 * kept one it is the same receipt as, else it is kept itself. Pure. With
 * `only`, the merges that touch none of those receipts are left out (the plan
 * is still made over every receipt, so it is the same plan either way).
 */
export function planMerges(
  candidates: readonly MergeCandidate[],
  distinct: ReadonlyMap<string, ReadonlySet<string>>,
  only?: ReadonlySet<string>,
): PlannedMerge[] {
  const kept: MergeCandidate[] = [];
  const out: PlannedMerge[] = [];
  for (const c of [...candidates].sort(keepFirst)) {
    let into: { keeper: MergeCandidate; reason: AutomaticDuplicate } | null = null;
    for (const keeper of kept) {
      const reason = automaticDuplicate(keeper, c, distinct);
      if (reason) {
        into = { keeper, reason };
        break;
      }
    }
    if (!into) {
      kept.push(c);
      continue;
    }
    if (!only || only.has(c.rowId) || only.has(into.keeper.rowId)) out.push({ rowId: c.rowId, keptRowId: into.keeper.rowId, reason: into.reason });
  }
  return out;
}

const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');
const numberOrNull = (value: unknown): number | null => {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

/** Content hashes of the files on the given rows, by row. */
async function hashesByRow(db: PrismaClient, rowIds: readonly string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (rowIds.length === 0) return out;
  const refs = await db.dtFile.findMany({ where: { rowId: { in: [...rowIds] } }, select: { rowId: true, metadata: true } });
  for (const ref of refs) {
    const meta = ref.metadata && typeof ref.metadata === 'object' && !Array.isArray(ref.metadata) ? (ref.metadata as Record<string, unknown>) : {};
    if (typeof meta.sha256 === 'string' && meta.sha256) out.set(ref.rowId, [...(out.get(ref.rowId) ?? []), meta.sha256]);
  }
  return out;
}

const countBy = (rows: ReadonlyArray<{ rowId: string | null }>) => {
  const out = new Map<string, number>();
  for (const r of rows) if (r.rowId) out.set(r.rowId, (out.get(r.rowId) ?? 0) + 1);
  return out;
};

/** The company's live receipts as the pass compares them. */
async function loadCandidates(db: PrismaClient, ctx: MergeContext, table: TableContext): Promise<{ candidates: MergeCandidate[]; distinct: Map<string, Set<string>> }> {
  const rows = await allReceiptRows(table.adapter, table.tableId, table.columns);
  const live = rows.filter((r) => !r.archived);
  const rowIds = live.map((r) => r.id);
  const [hashes, reviews, links, guests, decisions] = await Promise.all([
    hashesByRow(db, rowIds),
    db.receiptReview.findMany({ where: { authWorkspaceId: ctx.workspaceId, rowId: { in: rowIds } }, select: { rowId: true, distinctFrom: true } }),
    db.taxPaymentLink.findMany({ where: { authWorkspaceId: ctx.workspaceId, rowId: { in: rowIds } }, select: { rowId: true } }),
    db.mealGuest.findMany({ where: { authWorkspaceId: ctx.workspaceId, rowId: { in: rowIds } }, select: { rowId: true } }),
    db.taxItemDecision.findMany({ where: { authWorkspaceId: ctx.workspaceId, rowId: { in: rowIds } }, select: { rowId: true } }),
  ]);
  const payments = countBy(links);
  const guestCount = countBy(guests);
  const decided = new Set(decisions.map((d) => d.rowId));
  const candidates = live.map((row) => candidateOf(row, table.columns, hashes.get(row.id) ?? [], payments.get(row.id) ?? 0, (guestCount.get(row.id) ?? 0) + (decided.has(row.id) ? 1 : 0)));
  return { candidates, distinct: new Map(reviews.map((r) => [r.rowId, new Set(r.distinctFrom)])) };
}

function candidateOf(row: Row, columns: readonly Column[], fileHashes: string[], payments: number, personEntries: number): MergeCandidate {
  const byName = firstColumnIdByName(columns);
  const cell = (name: string): unknown => {
    const id = byName.get(name);
    return id ? row.cells[id] : undefined;
  };
  const files = cell('Receipt Image');
  const vendor = text(cell('Vendor'));
  const printed = cleanInvoiceNumber(cell(INVOICE_NUMBER_COLUMN));
  const filled = (name: string) => (byName.has(name) && text(cell(name)) !== '' ? 1 : 0);
  return {
    rowId: row.id,
    name: text(cell('Name')) || vendor || 'Beleg ohne Namen',
    vendor,
    date: isoDay(cell('Date')),
    gross: numberOrNull(cell('Gross')),
    net: numberOrNull(cell('Net')),
    taxRate: numberOrNull(cell('Tax Rate')),
    currency: 'EUR',
    hasText: text(cell('OCR Text')) !== '',
    hasFile: Array.isArray(files) && files.length > 0,
    fileHashes,
    invoiceKey: invoiceNumberKey(printed),
    invoiceNumber: printed,
    createdAt: new Date(row.createdAt),
    payments,
    inGroup: Boolean(row.parentRowId),
    decisions: filled('Zuordnung') + filled('Category'),
    files: Array.isArray(files) ? files.length : 0,
    personEntries,
  };
}

/** Archive one receipt into another, and record what changed. Null for a pair where either side is gone meanwhile. */
async function applyMerge(db: PrismaClient, ctx: MergeContext, table: TableContext, merge: PlannedMerge, invoiceNumber: string | null): Promise<{ fileAdded: boolean } | null> {
  const [row, kept] = await Promise.all([table.adapter.getRow(merge.rowId), table.adapter.getRow(merge.keptRowId)]);
  const live = (r: Row | null) => r !== null && r.tableId === table.tableId && !r.archived && !isGroupRow(r, table.columns);
  if (!live(row) || !live(kept)) return null;
  const imageColumnId = firstColumnIdByName(table.columns).get('Receipt Image') ?? null;

  // The payments of the archived receipt now document the kept one; a payment linked to both stays as it is.
  const keptPayments = new Set((await db.taxPaymentLink.findMany({ where: { rowId: merge.keptRowId }, select: { paymentId: true } })).map((l) => l.paymentId));
  const movable = (await db.taxPaymentLink.findMany({ where: { rowId: merge.rowId }, select: { id: true, paymentId: true } })).filter((l) => !keptPayments.has(l.paymentId));
  // The person's entries follow: a guest the kept receipt does not list moves over, and the tax decision moves
  // where the kept receipt has none (where both have one, the kept receipt's stands and the other stays on the archived row).
  const keptContacts = new Set((await db.mealGuest.findMany({ where: { rowId: merge.keptRowId }, select: { contactId: true } })).map((g) => g.contactId));
  const movableGuests = (await db.mealGuest.findMany({ where: { rowId: merge.rowId }, select: { id: true, contactId: true } })).filter((g) => g.contactId === null || !keptContacts.has(g.contactId));
  const archivedDecision = await db.taxItemDecision.findUnique({ where: { rowId: merge.rowId }, select: { id: true } });
  const movableDecision = archivedDecision && !(await db.taxItemDecision.findUnique({ where: { rowId: merge.keptRowId }, select: { id: true } })) ? archivedDecision : null;
  // Its files the kept receipt lacks go there too, as further references: the archived receipt keeps its own.
  const added: string[] = [];
  if (imageColumnId) {
    const keptRefs = await db.dtFile.findMany({ where: { rowId: merge.keptRowId }, select: { fileId: true, metadata: true } });
    const keptFiles = new Set(keptRefs.map((r) => r.fileId));
    const keptHashes = new Set(keptRefs.map((r) => (r.metadata as { sha256?: unknown } | null)?.sha256).filter((h): h is string => typeof h === 'string'));
    for (const ref of await table.adapter.getFileReferences(merge.rowId, imageColumnId)) {
      const hash = typeof ref.metadata?.sha256 === 'string' ? ref.metadata.sha256 : null;
      if (keptFiles.has(ref.fileId) || (hash && keptHashes.has(hash))) continue;
      const copy = await table.adapter.addFileReference({
        rowId: merge.keptRowId,
        columnId: imageColumnId,
        fileId: ref.fileId,
        fileUrl: ref.fileUrl,
        originalName: ref.originalName,
        mimeType: ref.mimeType,
        // Not "ocr-upload": a retake of the kept receipt swaps only its own capture, never this copy.
        metadata: { ...(ref.metadata ?? {}), source: 'merged-duplicate', mergedFromRowId: merge.rowId },
      });
      added.push(copy.id);
      keptFiles.add(ref.fileId);
    }
  }
  // The record first: a merge cut off after it can be restored, one cut off before it never happened. A pass that
  // plans the same merge again (the first one stopped midway) adds to the record, never replaces what it holds:
  // what the first run moved already sits on the kept receipt, and the restore must still move it back.
  const prior = await db.receiptMerge.findUnique({ where: { rowId: merge.rowId } });
  const sameKeeper = prior?.keptRowId === merge.keptRowId ? prior : null;
  const union = (before: readonly string[] | undefined, now: readonly string[]) => [...new Set([...(before ?? []), ...now])];
  const record = {
    keptRowId: merge.keptRowId,
    reason: merge.reason,
    invoiceNumber,
    movedPaymentLinkIds: union(sameKeeper?.movedPaymentLinkIds, movable.map((l) => l.id)),
    addedFileRefIds: union(sameKeeper?.addedFileRefIds, added),
    movedMealGuestIds: union(sameKeeper?.movedMealGuestIds, movableGuests.map((g) => g.id)),
    movedTaxDecisionId: movableDecision?.id ?? sameKeeper?.movedTaxDecisionId ?? null,
  };
  await db.receiptMerge.upsert({
    where: { rowId: merge.rowId },
    create: { rowId: merge.rowId, authWorkspaceId: ctx.workspaceId, authTenantId: ctx.tenantId, ...record },
    update: { ...record, mergedAt: new Date() },
  });
  if (movableGuests.length > 0) await db.mealGuest.updateMany({ where: { id: { in: movableGuests.map((g) => g.id) }, rowId: merge.rowId }, data: { rowId: merge.keptRowId } });
  if (movableDecision) await db.taxItemDecision.updateMany({ where: { id: movableDecision.id, rowId: merge.rowId }, data: { rowId: merge.keptRowId } });
  if (movable.length > 0) await db.taxPaymentLink.updateMany({ where: { id: { in: movable.map((l) => l.id) }, rowId: merge.rowId }, data: { rowId: merge.keptRowId } });
  // A credit note linked to the archived copy of its invoice now points at the kept one.
  await db.receiptReference.updateMany({ where: { authWorkspaceId: ctx.workspaceId, referencedRowId: merge.rowId }, data: { referencedRowId: merge.keptRowId } });
  await table.adapter.archiveRow(merge.rowId);
  return { fileAdded: record.addedFileRefIds.length > 0 };
}

/** A merge that happened, and whether the archived receipt's file now hangs on the kept one. */
export interface AppliedMerge extends PlannedMerge {
  fileAdded: boolean;
}

export interface MergeResult {
  merged: AppliedMerge[];
}

/**
 * The automatic pass for one company: every receipt that is the same receipt
 * as another (same file, same invoice) is archived into the more complete
 * one. With `only`, just the merges that touch those receipts. Never throws
 * for one pair: a failed pair is logged and the others go on.
 */
export async function mergeDuplicates(db: PrismaClient, ctx: MergeContext, options: { only?: readonly string[] } = {}): Promise<MergeResult> {
  const table = await tableContext(db, ctx.workspaceId);
  if (!table) return { merged: [] };
  const { candidates, distinct } = await loadCandidates(db, ctx, table);
  const byId = new Map(candidates.map((c) => [c.rowId, c]));
  const plan = planMerges(candidates, distinct, options.only ? new Set(options.only) : undefined);
  const merged: AppliedMerge[] = [];
  for (const merge of plan) {
    try {
      const applied = await applyMerge(db, ctx, table, merge, byId.get(merge.rowId)?.invoiceNumber ?? null);
      if (applied) merged.push({ ...merge, ...applied });
    } catch (err) {
      console.error('[merge] a duplicate could not be archived:', err instanceof Error ? err.name : 'error');
    }
  }
  if (merged.length > 0) console.info('[merge] duplicates archived', { sameFile: merged.filter((m) => m.reason === 'same_file').length, sameInvoice: merged.filter((m) => m.reason === 'same_invoice').length });
  return { merged };
}

/**
 * Run the pass for some receipts after they changed, without failing what
 * changed them: a failure is logged and the next run (daily, the backfill)
 * catches up. Returns each merge that touched them, by the archived receipt:
 * where it went, why, and whether its file was added there. A receipt can be
 * the kept one of a merge too (another receipt archived into it): see `touches`.
 */
export async function mergeAfterChange(db: PrismaClient, ctx: MergeContext, rowIds: readonly string[]): Promise<Map<string, AppliedMerge>> {
  try {
    const { merged } = await mergeDuplicates(db, ctx, { only: rowIds });
    return new Map(merged.map((m) => [m.rowId, m]));
  } catch (err) {
    console.error('[merge] the pass after a change failed:', err instanceof Error ? err.name : 'error');
    return new Map();
  }
}

/** True when one of the merges archived `rowId` or archived another receipt into it. */
export const touches = (merges: ReadonlyMap<string, AppliedMerge>, rowId: string): boolean => [...merges.values()].some((m) => m.rowId === rowId || m.keptRowId === rowId);

export interface ExistingCopy {
  rowId: string;
  name: string;
  reason: AutomaticDuplicate;
}

/**
 * At upload, before a row exists: the live receipt the arriving one is the same
 * invoice as (the same rule as the pass), the most complete of them where there
 * are several. Null when there is none.
 */
export async function findSameInvoice(
  db: PrismaClient,
  ctx: MergeContext,
  arriving: { vendor: string | null; gross: number | null; invoiceNumber: string | null },
): Promise<ExistingCopy | null> {
  const invoiceKey = invoiceNumberKey(arriving.invoiceNumber);
  if (!invoiceKey) return null;
  const table = await tableContext(db, ctx.workspaceId);
  if (!table) return null;
  const columnId = firstColumnIdByName(table.columns).get(INVOICE_NUMBER_COLUMN);
  if (!columnId) return null;
  const rows: Row[] = [];
  for (let offset = 0; ; ) {
    const page = await table.adapter.getRows(table.tableId, { filters: [{ columnId, operator: 'isNotEmpty', value: null }], limit: 500, offset, include: ['files'] });
    rows.push(...page.items);
    if (!page.hasMore || page.items.length === 0) break;
    offset += page.items.length;
  }
  const facts = { vendor: arriving.vendor ?? '', gross: arriving.gross, invoiceKey };
  const same = rows.filter((row) => !row.archived && !isGroupRow(row, table.columns)).map((row) => candidateOf(row, table.columns, [], 0, 0)).filter((c) => sameInvoice(c, facts));
  if (same.length === 0) return null;
  // The one a pass would keep: decided on what the rows show here; the payments are counted for the few found.
  const links = countBy(await db.taxPaymentLink.findMany({ where: { authWorkspaceId: ctx.workspaceId, rowId: { in: same.map((c) => c.rowId) } }, select: { rowId: true } }));
  const best = same.map((c) => ({ ...c, payments: links.get(c.rowId) ?? 0 })).sort(keepFirst)[0];
  return { rowId: best.rowId, name: best.name, reason: 'same_invoice' };
}

export interface MergedReceipt {
  rowId: string;
  name: string;
  reason: AutomaticDuplicate;
  invoiceNumber: string | null;
  mergedAt: Date;
}

/** The receipts archived into this one, newest first, for the kept receipt's view. */
export async function mergedInto(db: PrismaClient, workspaceId: string, keptRowId: string): Promise<MergedReceipt[]> {
  const records = await db.receiptMerge.findMany({ where: { authWorkspaceId: workspaceId, keptRowId }, orderBy: { mergedAt: 'desc' } });
  if (records.length === 0) return [];
  const table = await tableContext(db, workspaceId);
  if (!table) return [];
  const nameId = firstColumnIdByName(table.columns).get('Name');
  const vendorId = firstColumnIdByName(table.columns).get('Vendor');
  const out: MergedReceipt[] = [];
  for (const record of records) {
    const row = await table.adapter.getRow(record.rowId);
    // Only a receipt that is still archived in this table can be brought back.
    if (!row || row.tableId !== table.tableId || !row.archived) continue;
    const name = (nameId && text(row.cells[nameId])) || (vendorId && text(row.cells[vendorId])) || 'Beleg ohne Namen';
    out.push({ rowId: record.rowId, name, reason: record.reason === 'same_file' ? 'same_file' : 'same_invoice', invoiceNumber: record.invoiceNumber, mergedAt: record.mergedAt });
  }
  return out;
}

/**
 * Bring an archived duplicate back (decision 15): the receipt is live again,
 * the payment links, meal guests and tax decision the merge moved go back to it
 * where they still sit on the kept receipt, the file references the merge added to the kept receipt go,
 * and the pair is recorded as different, so no later pass archives it again.
 * Returns the kept receipt's id.
 */
export async function restoreMergedReceipt(db: PrismaClient, ctx: MergeContext, rowId: string): Promise<string> {
  const record = await db.receiptMerge.findFirst({ where: { rowId, authWorkspaceId: ctx.workspaceId } });
  if (!record) throw new MergeError('not_merged');
  const table = await tableContext(db, ctx.workspaceId);
  if (!table) throw new MergeError('not_initialized');
  const row = await table.adapter.getRow(rowId);
  if (!row || row.tableId !== table.tableId) throw new MergeError('not_merged');

  // The person's word first: should anything below fail, no pass archives the pair again meanwhile.
  await markDistinct(db, ctx, rowId, record.keptRowId);
  if (record.movedPaymentLinkIds.length > 0) {
    await db.taxPaymentLink.updateMany({ where: { id: { in: record.movedPaymentLinkIds }, rowId: record.keptRowId }, data: { rowId } });
  }
  if (record.movedMealGuestIds.length > 0) await db.mealGuest.updateMany({ where: { id: { in: record.movedMealGuestIds }, rowId: record.keptRowId }, data: { rowId } });
  if (record.movedTaxDecisionId) await db.taxItemDecision.updateMany({ where: { id: record.movedTaxDecisionId, rowId: record.keptRowId }, data: { rowId } });
  if (record.addedFileRefIds.length > 0) await db.dtFile.deleteMany({ where: { id: { in: record.addedFileRefIds }, rowId: record.keptRowId } });
  await table.adapter.unarchiveRow(rowId);
  await db.receiptMerge.deleteMany({ where: { rowId } });
  return record.keptRowId;
}

/** Two receipts are different purchases, stored on both (as "Beide behalten" does). */
export async function markDistinct(db: PrismaClient, ctx: MergeContext, rowId: string, otherRowId: string): Promise<void> {
  for (const [a, b] of [
    [rowId, otherRowId],
    [otherRowId, rowId],
  ]) {
    const existing = await db.receiptReview.findUnique({ where: { rowId: a }, select: { distinctFrom: true } });
    const distinctFrom = [...new Set([...(existing?.distinctFrom ?? []), b])];
    await db.receiptReview.upsert({
      where: { rowId: a },
      create: { rowId: a, authWorkspaceId: ctx.workspaceId, authTenantId: ctx.tenantId, distinctFrom },
      update: { distinctFrom },
    });
  }
}
