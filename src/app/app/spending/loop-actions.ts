'use server';

import { auth } from '@/lib/auth';
import { ReceiptsAuthError, requireReceiptsSession } from '@/lib/auth-guards';
import { MissingTenantError, requireSessionTenantId, sessionWorkspaceId } from '@/lib/auth-workspace';
import { prisma } from '@/lib/prisma';
import { LoopServiceError, answerNoReceipt, confirmCandidate, loadLoopOverview, withdrawNoReceipt, type LoopOverview } from '@/lib/spending/loop-service';
import { runSpendingChecks, type ChecksRun } from '@/lib/spending/checks';
import { NotifyServiceError, devicePushState, forgetDeviceEverywhere, validVapidConfig, getNotifySettings, pushDeviceCount, removePushSubscription, savePushSubscription, type PushContext, listUnreadNotifications, markNotificationRead, saveNotifySettings, type NotificationView, type NotifySettings, type NotifyContext } from '@/lib/spending/notify/service';
import { berlinToday } from '@/lib/spending/period';
import { mailboxFor } from '@/lib/spending/mailbox/server';
import { MailCandidateError, dismissMailCandidate } from '@/lib/spending/mailbox/service';
import { linkReceiptToPayment } from '@/lib/spending/loop-service';
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
  /** The active company: a mail attachment is uploaded into it. */
  workspaceId: string;
  /** The expenses mailbox for this company: searched ('on'), not set up ('off'), or another company's ('other_company'). */
  mailbox: 'on' | 'off' | 'other_company';
  /** The server's public push key, for a device to switch push on; null when push is not set up on the server. */
  pushPublicKey: string | null;
  /** How many devices of this company have push switched on. */
  pushDevices: number;
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
  if (e instanceof MailCandidateError) return { ok: false, error: 'not_found', detail: e.code };
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
  const status = (await mailboxFor(prisma, workspaceId)).status();
  const mailbox = status.configured ? 'on' : status.reason === 'other_company' ? 'other_company' : 'off';
  return {
    loop,
    notifications,
    settings,
    canWrite,
    lastRun,
    workspaceId,
    mailbox,
    pushPublicKey: validVapidConfig()?.publicKey ?? null,
    pushDevices: canWrite ? await pushDeviceCount(prisma, workspaceId) : 0,
  };
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

/** "Not the invoice": set a found mail aside for good. */
export async function dismissMail(candidateId: unknown): Promise<ChecksResult<ChecksView>> {
  try {
    const ctx = await writeContext();
    await dismissMailCandidate(prisma, ctx, String(candidateId ?? ''));
    return { ok: true, value: await view(ctx.workspaceId, true) };
  } catch (e) {
    return failure(e);
  }
}

/**
 * The receipt just taken over from the mailbox (or found to be there already)
 * belongs to this payment: the owner chose the mail for it, so it is linked
 * right away instead of waiting for the reading to match.
 */
export async function linkTakenOver(paymentId: unknown, rowId: unknown): Promise<ChecksResult<ChecksView>> {
  try {
    const ctx = await writeContext();
    await linkReceiptToPayment(prisma, ctx, String(paymentId ?? ''), String(rowId ?? ''));
    return { ok: true, value: await view(ctx.workspaceId, true) };
  } catch (e) {
    return failure(e);
  }
}

/**
 * Link a receipt of this company to an open payment by hand, when no proposal
 * fits (another wording, another amount): the person chose it. For a payment
 * routed here from the company holding its account, this is the receiver's
 * own link (plan 2026-10-22, payments across companies); the receipt must be
 * this company's, the payment one still waiting here.
 */
export async function linkChosenReceipt(paymentId: unknown, rowId: unknown): Promise<ChecksResult<ChecksView>> {
  try {
    const ctx = await writeContext();
    await linkReceiptToPayment(prisma, ctx, String(paymentId ?? ''), String(rowId ?? ''));
    return { ok: true, value: await view(ctx.workspaceId, true) };
  } catch (e) {
    return failure(e);
  }
}

async function pushContext(): Promise<PushContext> {
  const session = await auth.requireAction('receipts.row.write');
  const workspaceId = sessionWorkspaceId(session);
  return { workspaceId, tenantId: requireSessionTenantId(session, workspaceId), userId: session.userId };
}

/** This device switched push on (or is renewing it): remember its subscription for the active company and this person. */
export async function enablePush(subscription: unknown): Promise<ChecksResult<ChecksView>> {
  try {
    const ctx = await pushContext();
    await savePushSubscription(prisma, ctx, subscription);
    return { ok: true, value: await view(ctx.workspaceId, true) };
  } catch (e) {
    return failure(e);
  }
}

/** This device switched push off. */
export async function disablePush(endpoint: unknown): Promise<ChecksResult<ChecksView>> {
  try {
    const ctx = await writeContext();
    await removePushSubscription(prisma, ctx, endpoint);
    return { ok: true, value: await view(ctx.workspaceId, true) };
  } catch (e) {
    return failure(e);
  }
}

/** What the server holds for this device: on for the active company, and whether other companies of this person still use it. */
export async function pushStateOfDevice(endpoint: unknown): Promise<ChecksResult<{ here: boolean; elsewhere: boolean }>> {
  try {
    return { ok: true, value: await devicePushState(prisma, await pushContext(), endpoint) };
  } catch (e) {
    return failure(e);
  }
}

/** Signing out: this device gets nothing more from any company of this person. Needs only the session, not the write permission. */
export async function forgetPushEverywhere(endpoint: unknown): Promise<ChecksResult<{ forgotten: number }>> {
  try {
    const session = await requireReceiptsSession();
    return { ok: true, value: { forgotten: await forgetDeviceEverywhere(prisma, session.userId, endpoint) } };
  } catch (e) {
    return failure(e);
  }
}
