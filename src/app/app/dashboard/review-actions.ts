'use server';

import { auth } from '@/lib/auth';
import { ReceiptsAuthError, requireReceiptsSession } from '@/lib/auth-guards';
import { sessionWorkspaceId, tenantIdForWorkspace } from '@/lib/auth-workspace';
import { prisma } from '@/lib/prisma';
import {
  ReviewError,
  confirmReceipt,
  keepBothReceipts,
  loadReviewQueue,
  type ReviewEntry,
} from '@/lib/review/service';

/**
 * Server actions of the review list ("Belege prüfen").
 *
 * The workspace is the session's ACTIVE one and is never taken from the
 * browser. Failures are RETURNED with a stable code, not thrown: a thrown
 * server-action error reaches the browser with its message stripped.
 */

export type ReviewActionError = 'unauthorized' | 'forbidden' | 'not_found' | 'not_initialized' | 'failed';
export type ReviewResult<T> = { ok: true; value: T } | { ok: false; error: ReviewActionError };

function failure(e: unknown): { ok: false; error: ReviewActionError } {
  if (e instanceof ReceiptsAuthError) {
    return { ok: false, error: e.status === 401 ? 'unauthorized' : e.status === 404 ? 'not_found' : 'forbidden' };
  }
  const status = (e as { status?: number })?.status;
  if (status === 401) return { ok: false, error: 'unauthorized' };
  if (status === 403) return { ok: false, error: 'forbidden' };
  if (e instanceof ReviewError) return { ok: false, error: e.code === 'row_not_found' ? 'not_found' : 'not_initialized' };
  console.error('[review] action failed', e);
  return { ok: false, error: 'failed' };
}

async function writeContext() {
  const session = await auth.requireAction('receipts.row.write');
  const workspaceId = sessionWorkspaceId(session);
  return { workspaceId, tenantId: tenantIdForWorkspace(session, workspaceId) };
}

/** Every receipt of the active workspace that needs a look, with the reasons. */
export async function getReviewQueue(): Promise<ReviewResult<ReviewEntry[]>> {
  try {
    const session = await requireReceiptsSession();
    return { ok: true, value: await loadReviewQueue(prisma, sessionWorkspaceId(session)) };
  } catch (e) {
    return failure(e);
  }
}

/** "Geprüft": the recorded doubts about this receipt are settled. Returns the queue as it is now. */
export async function confirmReceiptChecked(rowId: string): Promise<ReviewResult<ReviewEntry[]>> {
  try {
    if (typeof rowId !== 'string' || !rowId) return { ok: false, error: 'not_found' };
    const ctx = await writeContext();
    await confirmReceipt(prisma, ctx, rowId);
    return { ok: true, value: await loadReviewQueue(prisma, ctx.workspaceId) };
  } catch (e) {
    return failure(e);
  }
}

/** "Beide behalten": two look-alike receipts are different purchases. Returns the queue as it is now. */
export async function keepBothLookAlikes(rowId: string, otherRowId: string): Promise<ReviewResult<ReviewEntry[]>> {
  try {
    if (typeof rowId !== 'string' || typeof otherRowId !== 'string' || !rowId || !otherRowId) return { ok: false, error: 'not_found' };
    const ctx = await writeContext();
    await keepBothReceipts(prisma, ctx, rowId, otherRowId);
    return { ok: true, value: await loadReviewQueue(prisma, ctx.workspaceId) };
  } catch (e) {
    return failure(e);
  }
}
