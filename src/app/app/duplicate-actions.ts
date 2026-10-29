'use server';

import { ReceiptsAuthError, requireRowAccess } from '@/lib/auth-guards';
import { MissingTenantError, tenantIdForWorkspace } from '@/lib/auth-workspace';
import { prisma } from '@/lib/prisma';
import { MergeError, mergedInto, restoreMergedReceipt, type MergedReceipt } from '@/lib/review/merge';

/**
 * Server actions of the receipts the app archived as duplicates (plan
 * docs/plans/2026-10-29-invoice-number-duplicates.md): what was merged into a
 * receipt, and bringing one back. The company is the one the receipt belongs
 * to (resolved from the row and checked against the session), never taken
 * from the browser. Failures are returned with a stable code.
 */

export type DuplicateActionError = 'unauthorized' | 'forbidden' | 'not_found' | 'failed';
export type DuplicateResult<T> = { ok: true; value: T } | { ok: false; error: DuplicateActionError };

/** A merged receipt as the receipt view shows it: the date as text, so it crosses to the browser as it is. */
export type MergedReceiptView = Omit<MergedReceipt, 'mergedAt'> & { mergedAt: string };

function failure(e: unknown): { ok: false; error: DuplicateActionError } {
  if (e instanceof ReceiptsAuthError) return { ok: false, error: e.status === 401 ? 'unauthorized' : e.status === 404 ? 'not_found' : 'forbidden' };
  const status = (e as { status?: number })?.status;
  if (status === 401) return { ok: false, error: 'unauthorized' };
  if (status === 403) return { ok: false, error: 'forbidden' };
  if (e instanceof MissingTenantError) return { ok: false, error: 'forbidden' };
  if (e instanceof MergeError) return { ok: false, error: 'not_found' };
  console.error('[duplicates] action failed:', e instanceof Error ? e.name : 'error');
  return { ok: false, error: 'failed' };
}

const view = (list: MergedReceipt[]): MergedReceiptView[] => list.map((m) => ({ ...m, mergedAt: m.mergedAt.toISOString() }));

/** The receipts archived into this one, newest first. */
export async function getMergedReceipts(rowId: string): Promise<DuplicateResult<MergedReceiptView[]>> {
  try {
    const { workspaceId } = await requireRowAccess(String(rowId));
    return { ok: true, value: view(await mergedInto(prisma, workspaceId, String(rowId))) };
  } catch (e) {
    return failure(e);
  }
}

/**
 * "Wiederherstellen": the archived receipt comes back as a receipt of its own,
 * and the pair is recorded as different. Answers with what is still merged
 * into the kept receipt.
 */
export async function restoreMerged(keptRowId: string, mergedRowId: string): Promise<DuplicateResult<MergedReceiptView[]>> {
  try {
    // Access is checked on the kept receipt, the one on screen; the merge record must name it.
    const { session, workspaceId } = await requireRowAccess(String(keptRowId), 'receipts.row.write');
    const record = await prisma.receiptMerge.findFirst({ where: { rowId: String(mergedRowId), keptRowId: String(keptRowId), authWorkspaceId: workspaceId }, select: { rowId: true } });
    if (!record) return { ok: false, error: 'not_found' };
    await restoreMergedReceipt(prisma, { workspaceId, tenantId: tenantIdForWorkspace(session, workspaceId) }, record.rowId);
    return { ok: true, value: view(await mergedInto(prisma, workspaceId, String(keptRowId))) };
  } catch (e) {
    return failure(e);
  }
}
