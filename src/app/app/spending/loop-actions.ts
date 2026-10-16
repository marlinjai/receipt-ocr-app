'use server';

import { auth } from '@/lib/auth';
import { ReceiptsAuthError, requireReceiptsSession } from '@/lib/auth-guards';
import { MissingTenantError, requireSessionTenantId, sessionWorkspaceId } from '@/lib/auth-workspace';
import { prisma } from '@/lib/prisma';
import { LoopServiceError, answerNoReceipt, confirmCandidate, loadLoopOverview, withdrawNoReceipt, type LoopOverview } from '@/lib/spending/loop-service';
import { runSpendingChecks, type ChecksRun } from '@/lib/spending/checks';
import { NotifyServiceError, getNotifySettings, listUnreadNotifications, markNotificationRead, saveNotifySettings, type NotificationView, type NotifySettings, type NotifyContext } from '@/lib/spending/notify/service';
import { berlinToday } from '@/lib/spending/period';
import { PaymentServiceError } from '@/lib/tax/payments/service';

/**
 * Server actions of the missing-receipt loop and the notifications. Same
 * rules as every action here: the workspace is the session's active one,
 * writes pass the fail-closed `receipts.row.write` check, failures come back
 * with a stable code, and every write answers with the fresh view.
 */

export type ChecksActionError = 'unauthorized' | 'forbidden' | 'not_found' | 'invalid_input' | 'failed';
export type ChecksResult<T> = { ok: true; value: T } | { ok: false; error: ChecksActionError; detail?: string };

export interface ChecksView {
  loop: LoopOverview;
  /** The in-app queue; empty for a person who may not write (it is the owner's to act on and dismiss). */
  notifications: NotificationView[];
  settings: NotifySettings;
  canWrite: boolean;
  /** Set after "check now": what the run did. */
  lastRun: ChecksRun | null;
}

function failure(e: unknown): { ok: false; error: ChecksActionError; detail?: string } {
  if (e instanceof ReceiptsAuthError) return { ok: false, error: e.status === 401 ? 'unauthorized' : e.status === 404 ? 'not_found' : 'forbidden' };
  const status = (e as { status?: number })?.status;
  if (status === 401) return { ok: false, error: 'unauthorized' };
  if (status === 403) return { ok: false, error: 'forbidden' };
  if (e instanceof MissingTenantError) return { ok: false, error: 'forbidden' };
  if (e instanceof LoopServiceError) return { ok: false, error: e.code === 'payment_not_found' ? 'not_found' : 'invalid_input', detail: e.code };
  if (e instanceof NotifyServiceError) return { ok: false, error: e.code === 'notification_not_found' ? 'not_found' : 'invalid_input', detail: e.code };
  if (e instanceof PaymentServiceError) return { ok: false, error: 'invalid_input', detail: e.detail === null ? e.code : `${e.code}:${e.detail}` };
  console.error('[spending] checks action failed', e);
  return { ok: false, error: 'failed' };
}

async function writeContext(): Promise<NotifyContext> {
  const session = await auth.requireAction('receipts.row.write');
  const workspaceId = sessionWorkspaceId(session);
  return { workspaceId, tenantId: requireSessionTenantId(session, workspaceId) };
}

async function view(workspaceId: string, canWrite: boolean, lastRun: ChecksView['lastRun'] = null): Promise<ChecksView> {
  const [loop, notifications, settings] = await Promise.all([
    loadLoopOverview(prisma, workspaceId),
    canWrite ? listUnreadNotifications(prisma, workspaceId) : Promise.resolve([]),
    getNotifySettings(prisma, workspaceId),
  ]);
  return { loop, notifications, settings, canWrite, lastRun };
}

export async function getReceiptChecks(): Promise<ChecksResult<ChecksView>> {
  try {
    const session = await requireReceiptsSession();
    const canWrite = await auth.requireAction('receipts.row.write').then(
      () => true,
      () => false,
    );
    return { ok: true, value: await view(sessionWorkspaceId(session), canWrite) };
  } catch (e) {
    return failure(e);
  }
}

/** Run the loop now: notify about missing receipts, clear what is settled, retry failed deliveries. */
export async function checkNow(): Promise<ChecksResult<ChecksView>> {
  try {
    const ctx = await writeContext();
    const run = await runSpendingChecks(prisma, ctx, { today: berlinToday() });
    return { ok: true, value: await view(ctx.workspaceId, true, run) };
  } catch (e) {
    return failure(e);
  }
}

export async function confirmReceipt(paymentId: unknown, rowId: unknown): Promise<ChecksResult<ChecksView>> {
  try {
    const ctx = await writeContext();
    await confirmCandidate(prisma, ctx, String(paymentId ?? ''), String(rowId ?? ''));
    return { ok: true, value: await view(ctx.workspaceId, true) };
  } catch (e) {
    return failure(e);
  }
}

export async function sayNoReceipt(paymentId: unknown, reason: unknown): Promise<ChecksResult<ChecksView>> {
  try {
    const ctx = await writeContext();
    await answerNoReceipt(prisma, ctx, String(paymentId ?? ''), reason);
    return { ok: true, value: await view(ctx.workspaceId, true) };
  } catch (e) {
    return failure(e);
  }
}

export async function takeBackNoReceipt(paymentId: unknown): Promise<ChecksResult<ChecksView>> {
  try {
    const ctx = await writeContext();
    await withdrawNoReceipt(prisma, ctx, String(paymentId ?? ''));
    return { ok: true, value: await view(ctx.workspaceId, true) };
  } catch (e) {
    return failure(e);
  }
}

export async function readNotification(id: unknown): Promise<ChecksResult<ChecksView>> {
  try {
    const ctx = await writeContext();
    await markNotificationRead(prisma, ctx, String(id ?? ''));
    return { ok: true, value: await view(ctx.workspaceId, true) };
  } catch (e) {
    return failure(e);
  }
}

export async function saveNotificationSettings(input: unknown): Promise<ChecksResult<ChecksView>> {
  try {
    const ctx = await writeContext();
    await saveNotifySettings(prisma, ctx, input);
    return { ok: true, value: await view(ctx.workspaceId, true) };
  } catch (e) {
    return failure(e);
  }
}
