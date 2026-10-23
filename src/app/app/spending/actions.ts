'use server';

import { auth } from '@/lib/auth';
import { ReceiptsAuthError, requireReceiptsSession } from '@/lib/auth-guards';
import { MissingTenantError, membershipLabel, requireSessionTenantId, sessionWorkspaceId } from '@/lib/auth-workspace';
import { prisma } from '@/lib/prisma';
import { PaymentServiceError } from '@/lib/tax/payments/service';
import { unlinkRoutedPayment } from '@/lib/tax/payments/routing';
import { settleMovedPaymentsLater } from '@/lib/spending/settle-later';
import { settleMovedPayments } from '@/lib/spending/loop-service';
import {
  SpendingServiceError,
  loadSpending,
  markCounterpartyOwnAccount,
  removeCounterpartyCategory,
  saveOwnNames as saveOwnNamesOf,
  unmarkCounterpartyOwnAccount,
  setCounterpartyCategory,
  type SpendingContext,
  type SpendingView,
} from '@/lib/spending/service';
import { safeMonth, safeYear } from '@/lib/spending/period';

/**
 * Server actions of the spending overview. Like the finance actions: the
 * workspace is always the session's ACTIVE one and never taken from the
 * browser, writes pass the fail-closed `receipts.row.write` check, failures
 * are returned with a stable code, and every write answers with the freshly
 * computed view.
 */

export type SpendingActionError = 'unauthorized' | 'forbidden' | 'not_found' | 'invalid_input' | 'failed';

export type Result<T> = { ok: true; value: T } | { ok: false; error: SpendingActionError; detail?: string };

/**
 * The view plus whether this person may change answers here (the controls are
 * hidden otherwise), and the names of the other companies the view mentions
 * (the holder of a shared account, the receiver of private payments), as this
 * person knows them. A company the person is no member of has no name here.
 */
export type SpendingPageView = SpendingView & { canWrite: boolean; companies: Record<string, string> };

type Session = Awaited<ReturnType<typeof requireReceiptsSession>>;

function failure(e: unknown): { ok: false; error: SpendingActionError; detail?: string } {
  if (e instanceof ReceiptsAuthError) {
    return { ok: false, error: e.status === 401 ? 'unauthorized' : e.status === 404 ? 'not_found' : 'forbidden' };
  }
  const status = (e as { status?: number })?.status;
  if (status === 401) return { ok: false, error: 'unauthorized' };
  if (status === 403) return { ok: false, error: 'forbidden' };
  if (e instanceof MissingTenantError) return { ok: false, error: 'forbidden' };
  if (e instanceof SpendingServiceError) return { ok: false, error: 'invalid_input', detail: e.code };
  if (e instanceof PaymentServiceError) return { ok: false, error: 'invalid_input', detail: e.code };
  console.error('[spending] action failed', e);
  return { ok: false, error: 'failed' };
}

async function writeContext(): Promise<SpendingContext & { session: Session }> {
  const session = await auth.requireAction('receipts.row.write');
  const workspaceId = sessionWorkspaceId(session);
  return { workspaceId, tenantId: requireSessionTenantId(session, workspaceId), session };
}

/** The names of these companies as the person's memberships give them. */
function companyNames(session: Session, ids: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const id of ids) {
    const membership = session.memberships.find((m) => m.id === id);
    if (membership) out[id] = membershipLabel(membership, session.memberships);
  }
  return out;
}

async function view(session: Session, workspaceId: string, year: unknown, month: unknown, canWrite: boolean): Promise<SpendingPageView> {
  const loaded = await loadSpending(prisma, workspaceId, safeYear(year), safeMonth(month));
  const others = [...loaded.accounts.flatMap((a) => (a.sharedFrom ? [a.sharedFrom] : [])), ...loaded.sharedOut.map((s) => s.receiverWorkspaceId)];
  return { ...loaded, canWrite, companies: companyNames(session, others) };
}

export async function getSpending(year: unknown, month: unknown): Promise<Result<SpendingPageView>> {
  try {
    const session = await requireReceiptsSession();
    // Fail closed: any doubt about the permission (a denial, an unreachable check) shows the page read-only.
    const canWrite = await auth.requireAction('receipts.row.write').then(
      () => true,
      () => false,
    );
    return { ok: true, value: await view(session, sessionWorkspaceId(session), year, month, canWrite) };
  } catch (e) {
    return failure(e);
  }
}

/** Give a counterparty a spending category. */
export async function answerCategory(year: unknown, month: unknown, counterparty: unknown, category: unknown): Promise<Result<SpendingPageView>> {
  try {
    const ctx = await writeContext();
    await setCounterpartyCategory(prisma, ctx, { counterparty, category });
    return { ok: true, value: await view(ctx.session, ctx.workspaceId, year, month, true) };
  } catch (e) {
    return failure(e);
  }
}

/** Take a category answer back, by its stored key. */
export async function withdrawCategory(year: unknown, month: unknown, counterpartyKey: unknown): Promise<Result<SpendingPageView>> {
  try {
    const ctx = await writeContext();
    await removeCounterpartyCategory(prisma, ctx, counterpartyKey);
    return { ok: true, value: await view(ctx.session, ctx.workspaceId, year, month, true) };
  } catch (e) {
    return failure(e);
  }
}

/**
 * An own-account answer makes a counterparty's payments transfers, which never
 * go to the company receiving an account's private payments: a payment can
 * move between companies, so the message queues are settled after the answer.
 */
function settleMovedLater(ctx: { workspaceId: string }, counterparty: unknown): void {
  settleMovedPaymentsLater(prisma, ctx.workspaceId, { counterparty });
}

/** The counterparty is one of the owner's own accounts (see `markCounterpartyOwnAccount`). */
export async function markOwnAccount(year: unknown, month: unknown, counterparty: unknown): Promise<Result<SpendingPageView>> {
  try {
    const ctx = await writeContext();
    await markCounterpartyOwnAccount(prisma, ctx, counterparty);
    settleMovedLater(ctx, counterparty);
    return { ok: true, value: await view(ctx.session, ctx.workspaceId, year, month, true) };
  } catch (e) {
    return failure(e);
  }
}

/** Take an own-account answer back, by its stored key. */
export async function unmarkOwnAccount(year: unknown, month: unknown, counterpartyKey: unknown): Promise<Result<SpendingPageView>> {
  try {
    const ctx = await writeContext();
    await unmarkCounterpartyOwnAccount(prisma, ctx, counterpartyKey);
    settleMovedLater(ctx, counterpartyKey);
    return { ok: true, value: await view(ctx.session, ctx.workspaceId, year, month, true) };
  } catch (e) {
    return failure(e);
  }
}

/**
 * Keep the owner's own names (the whole list). Payments to them stop counting
 * as spending at once, and their "receipt missing" messages leave the queue
 * now rather than on the next run of the loop; a name taken out brings its
 * payments back as they were, without a second message.
 */
export async function saveOwnNames(year: unknown, month: unknown, names: unknown): Promise<Result<SpendingPageView>> {
  try {
    const ctx = await writeContext();
    await saveOwnNamesOf(prisma, ctx, names);
    try {
      await settleMovedPayments(prisma, ctx.workspaceId);
    } catch (e) {
      // The names are kept; the next run of the loop settles the same messages.
      console.error('[spending] settling messages after the own names changed failed', (e as Error)?.name ?? 'error');
    }
    return { ok: true, value: await view(ctx.session, ctx.workspaceId, year, month, true) };
  } catch (e) {
    return failure(e);
  }
}

/**
 * Take back the receipt linked here to a payment that another company holds
 * and routes here as private (plan 2026-10-22, payments across companies).
 * Only this company's own link goes; a payment that is not routed here is
 * refused like an unknown one.
 */
export async function unlinkRoutedReceipt(year: unknown, month: unknown, paymentId: unknown): Promise<Result<SpendingPageView>> {
  try {
    const ctx = await writeContext();
    if (typeof paymentId !== 'string' || !paymentId) return { ok: false, error: 'invalid_input', detail: 'link_not_found' };
    await unlinkRoutedPayment(prisma, ctx, paymentId);
    return { ok: true, value: await view(ctx.session, ctx.workspaceId, year, month, true) };
  } catch (e) {
    return failure(e);
  }
}
