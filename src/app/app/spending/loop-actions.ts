'use server';

import { auth } from '@/lib/auth';
import { ReceiptsAuthError, requireReceiptsSession } from '@/lib/auth-guards';
import { MissingTenantError, requireSessionTenantId, sessionWorkspaceId } from '@/lib/auth-workspace';
import { prisma } from '@/lib/prisma';
import { LoopServiceError, answerNoReceipt, closeBacklog, confirmCandidate, linkCertainReceipts, loadLoopOverview, paymentState, withdrawNoReceipt, type BacklogClosed, type LoopOverview } from '@/lib/spending/loop-service';
import { runSpendingChecks, type ChecksRun, INTERACTIVE_CLASSIFY_LIMIT } from '@/lib/spending/checks';
import { NotifyServiceError, devicePushState, forgetDeviceEverywhere, validVapidConfig, getNotifySettings, pushDeviceCount, removePushSubscription, savePushSubscription, type PushContext, listUnreadNotifications, markNotificationRead, saveNotifySettings, type NotificationView, type NotifySettings, type NotifyContext } from '@/lib/spending/notify/service';
import { berlinToday } from '@/lib/spending/period';
import { mailboxFor } from '@/lib/spending/mailbox/server';
import { MailCandidateError, dismissMailCandidate } from '@/lib/spending/mailbox/service';
import { linkReceiptToPayment, searchReceiptChoices } from '@/lib/spending/loop-service';
import { mailFoundSubject, missingReceiptSubject, type LoopState, type ReceiptChoice } from '@/lib/spending/loop';
import { PaymentServiceError } from '@/lib/tax/payments/service';
import { timed } from '@/lib/timing';

/**
 * Server actions of the missing-receipt loop and the notifications. Same
 * rules as every action here: the workspace is the session's active one,
 * writes pass the fail-closed `receipts.row.write` check, failures come back
 * with a stable code. An answer about one payment says what changed for that
 * payment (`CheckChange`); everything else answers with the fresh view.
 */

export type ChecksActionError = 'unauthorized' | 'forbidden' | 'not_found' | 'invalid_input' | 'failed';
export type ChecksResult<T> = { ok: true; value: T } | { ok: false; error: ChecksActionError; detail?: string };

export interface ChecksView {
  loop: LoopOverview;
  /** When this read started: it does not know a change the server made after that. */
  readAt: number;
  /** Closing the backlog takes what is open from before this day: the first of the running month, whose payments still count as new. */
  backlogBefore: string;
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

/** What one answer changed: that payment, instead of the whole view. */
export interface CheckChange {
  paymentId: string;
  /** Its state now; null when it no longer stands on this company's spending side. */
  state: LoopState | null;
  /** The receipt linked to it: from now on proposed to no other payment. */
  rowId: string | null;
  /** The messages about it that left the in-app queue, by subject. */
  settled: string[];
  /** When the change was made: an older read of the checks does not know it. */
  at: number;
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
  const session = await timed('auth.action', () => auth.requireAction('receipts.row.write'));
  const workspaceId = sessionWorkspaceId(session);
  return { workspaceId, tenantId: requireSessionTenantId(session, workspaceId) };
}

const changed = (paymentId: string, state: LoopState | null, settled: string[] = [], rowId: string | null = null): CheckChange => ({ paymentId, state, rowId, settled, at: Date.now() });

async function view(workspaceId: string, canWrite: boolean, lastRun: ChecksView['lastRun'] = null): Promise<ChecksView> {
  const readAt = Date.now();
  const [loop, notifications, settings] = await Promise.all([
    timed('checks.loop', () => loadLoopOverview(prisma, workspaceId)),
    canWrite ? timed('checks.notifications', () => listUnreadNotifications(prisma, workspaceId)) : Promise.resolve([]),
    timed('checks.settings', () => getNotifySettings(prisma, workspaceId)),
  ]);
  const status = (await timed('checks.mailbox', () => mailboxFor(prisma, workspaceId))).status();
  const mailbox = status.configured ? 'on' : status.reason === 'other_company' ? 'other_company' : 'off';
  return {
    loop,
    readAt,
    backlogBefore: `${berlinToday().slice(0, 7)}-01`,
    notifications,
    settings,
    canWrite,
    lastRun,
    workspaceId,
    mailbox,
    pushPublicKey: validVapidConfig()?.publicKey ?? null,
    pushDevices: canWrite ? await timed('checks.push', () => pushDeviceCount(prisma, workspaceId)) : 0,
  };
}

export async function getReceiptChecks(): Promise<ChecksResult<ChecksView>> {
  try {
    const session = await requireReceiptsSession();
    const canWrite = await timed('auth.action', () => auth.requireAction('receipts.row.write')).then(
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
    const run = await runSpendingChecks(prisma, ctx, { today: berlinToday(), classifyLimit: INTERACTIVE_CLASSIFY_LIMIT });
    return { ok: true, value: await view(ctx.workspaceId, true, run) };
  } catch (e) {
    return failure(e);
  }
}

export async function confirmReceipt(paymentId: unknown, rowId: unknown): Promise<ChecksResult<CheckChange>> {
  try {
    const ctx = await writeContext();
    const [payment, row] = [String(paymentId ?? ''), String(rowId ?? '')];
    await confirmCandidate(prisma, ctx, payment, row);
    return { ok: true, value: changed(payment, { state: 'has_receipt' }, [missingReceiptSubject(payment)], row) };
  } catch (e) {
    return failure(e);
  }
}

/** Links every certain proposal; the view's lists say what is left. */
export async function linkCertain(): Promise<ChecksResult<ChecksView>> {
  try {
    const ctx = await writeContext();
    await linkCertainReceipts(prisma, ctx);
    return { ok: true, value: await view(ctx.workspaceId, true) };
  } catch (e) {
    return failure(e);
  }
}

/** Closes what is open from before this month, and says what went where. */
export async function closeReceiptBacklog(): Promise<ChecksResult<ChecksView & { closed: BacklogClosed }>> {
  try {
    const ctx = await writeContext();
    const closed = await closeBacklog(prisma, ctx, `${berlinToday().slice(0, 7)}-01`);
    return { ok: true, value: { ...(await view(ctx.workspaceId, true)), closed } };
  } catch (e) {
    return failure(e);
  }
}

export async function sayNoReceipt(paymentId: unknown, reason: unknown): Promise<ChecksResult<CheckChange>> {
  try {
    const ctx = await writeContext();
    const payment = String(paymentId ?? '');
    return { ok: true, value: changed(payment, await answerNoReceipt(prisma, ctx, payment, reason), [missingReceiptSubject(payment)]) };
  } catch (e) {
    return failure(e);
  }
}

export async function takeBackNoReceipt(paymentId: unknown): Promise<ChecksResult<CheckChange>> {
  try {
    const ctx = await writeContext();
    const payment = String(paymentId ?? '');
    return { ok: true, value: changed(payment, await withdrawNoReceipt(prisma, ctx, payment)) };
  } catch (e) {
    return failure(e);
  }
}

/** The answer says when it happened: an older read of the checks still lists the message. */
export async function readNotification(id: unknown): Promise<ChecksResult<{ at: number }>> {
  try {
    const ctx = await writeContext();
    await markNotificationRead(prisma, ctx, String(id ?? ''));
    return { ok: true, value: { at: Date.now() } };
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

async function linked(ctx: NotifyContext, paymentId: string, rowId: string, options: { byHand?: boolean } = {}): Promise<CheckChange> {
  await linkReceiptToPayment(prisma, ctx, paymentId, rowId, options);
  return changed(paymentId, { state: 'has_receipt' }, [missingReceiptSubject(paymentId), mailFoundSubject(paymentId)], rowId);
}

/** "Not the invoice": set a found mail aside for good. */
export async function dismissMail(candidateId: unknown): Promise<ChecksResult<CheckChange>> {
  try {
    const ctx = await writeContext();
    const payment = await dismissMailCandidate(prisma, ctx, String(candidateId ?? ''));
    return { ok: true, value: changed(payment, await paymentState(prisma, ctx.workspaceId, payment)) };
  } catch (e) {
    return failure(e);
  }
}

/**
 * The receipt just taken over from the mailbox (or found to be there already)
 * belongs to this payment: the owner chose the mail for it, so it is linked
 * right away instead of waiting for the reading to match.
 */
export async function linkTakenOver(paymentId: unknown, rowId: unknown): Promise<ChecksResult<CheckChange>> {
  try {
    const ctx = await writeContext();
    return { ok: true, value: await linked(ctx, String(paymentId ?? ''), String(rowId ?? '')) };
  } catch (e) {
    return failure(e);
  }
}

/**
 * Link a receipt of this company to an open payment by hand, when no proposal
 * fits (another wording, another amount): the person chose it. For a payment
 * routed here from the company holding its account, this is the receiver's
 * own link (plan 2026-10-22, payments across companies); the receipt must be
 * this company's, the payment one still waiting here. A payment that got its
 * receipt in the meantime is refused with `already_has_receipt`.
 */
export async function linkChosenReceipt(paymentId: unknown, rowId: unknown): Promise<ChecksResult<CheckChange>> {
  try {
    const ctx = await writeContext();
    return { ok: true, value: await linked(ctx, String(paymentId ?? ''), String(rowId ?? ''), { byHand: true }) };
  } catch (e) {
    return failure(e);
  }
}

/** Search this company's receipts for one to link to an open payment by hand (name, vendor or amount). Read only. */
export async function findReceiptChoices(paymentId: unknown, text: unknown): Promise<ChecksResult<ReceiptChoice[]>> {
  try {
    const session = await requireReceiptsSession();
    return { ok: true, value: await searchReceiptChoices(prisma, sessionWorkspaceId(session), String(paymentId ?? ''), text) };
  } catch (e) {
    return failure(e);
  }
}

async function pushContext(): Promise<PushContext> {
  const session = await timed('auth.action', () => auth.requireAction('receipts.row.write'));
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
