'use server';

import { ReceiptsAuthError, requireRowAccess } from '@/lib/auth-guards';
import { MissingTenantError, tenantIdForWorkspace } from '@/lib/auth-workspace';
import { prisma } from '@/lib/prisma';
import { LineItemsError, answerLineKind } from '@/lib/line-items/store';
import { loadReceiptLines, receiptVendor, type ReceiptLinesView } from '@/lib/line-items/service';

/**
 * Server actions of a receipt's lines in the receipt view. The company is the
 * one the receipt belongs to (resolved from the row and checked against the
 * session), never taken from the browser. Failures are returned with a stable
 * code, as everywhere in the app.
 */

export type LineItemsActionError = 'unauthorized' | 'forbidden' | 'not_found' | 'invalid_input' | 'failed';
export type LineItemsResult<T> = { ok: true; value: T } | { ok: false; error: LineItemsActionError };

function failure(e: unknown): { ok: false; error: LineItemsActionError } {
  if (e instanceof ReceiptsAuthError) return { ok: false, error: e.status === 401 ? 'unauthorized' : e.status === 404 ? 'not_found' : 'forbidden' };
  const status = (e as { status?: number })?.status;
  if (status === 401) return { ok: false, error: 'unauthorized' };
  if (status === 403) return { ok: false, error: 'forbidden' };
  if (e instanceof MissingTenantError) return { ok: false, error: 'forbidden' };
  if (e instanceof LineItemsError) return { ok: false, error: e.code === 'line_not_found' ? 'not_found' : 'invalid_input' };
  console.error('[line-items] action failed:', e instanceof Error ? e.name : 'error');
  return { ok: false, error: 'failed' };
}

/** The lines of one receipt, with the kinds a person gave and how they stand against the total. */
export async function getReceiptLines(rowId: string): Promise<LineItemsResult<ReceiptLinesView>> {
  try {
    const { workspaceId } = await requireRowAccess(String(rowId));
    const view = await loadReceiptLines(prisma, workspaceId, String(rowId));
    return view ? { ok: true, value: view } : { ok: false, error: 'not_found' };
  } catch (e) {
    return failure(e);
  }
}

/** Give a line a kind: remembered for its text at the receipt's shop. Answers with the receipt's lines afresh. */
export async function setReceiptLineKind(rowId: string, lineId: string, kind: string): Promise<LineItemsResult<ReceiptLinesView>> {
  try {
    const { session, workspaceId } = await requireRowAccess(String(rowId), 'receipts.row.write');
    const ctx = { workspaceId, tenantId: tenantIdForWorkspace(session, workspaceId) };
    // Only a line of this receipt; the answer is kept for the shop the row names now.
    await answerLineKind(prisma, ctx, String(lineId), kind, await receiptVendor(prisma, workspaceId, String(rowId)), { rowId: String(rowId) });
    const view = await loadReceiptLines(prisma, workspaceId, String(rowId));
    return view ? { ok: true, value: view } : { ok: false, error: 'not_found' };
  } catch (e) {
    return failure(e);
  }
}
