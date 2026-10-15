'use server';

import { auth } from '@/lib/auth';
import { ReceiptsAuthError, requireReceiptsSession } from '@/lib/auth-guards';
import { MissingTenantError, requireSessionTenantId, sessionWorkspaceId } from '@/lib/auth-workspace';
import { prisma } from '@/lib/prisma';
import { PaymentServiceError, setCounterpartyTreatment } from '@/lib/tax/payments/service';
import {
  SpendingServiceError,
  loadSpending,
  removeCounterpartyCategory,
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

/** The view plus whether this person may change answers here (the controls are hidden otherwise). */
export type SpendingPageView = SpendingView & { canWrite: boolean };

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

async function writeContext(): Promise<SpendingContext> {
  const session = await auth.requireAction('receipts.row.write');
  const workspaceId = sessionWorkspaceId(session);
  return { workspaceId, tenantId: requireSessionTenantId(session, workspaceId) };
}

async function view(workspaceId: string, year: unknown, month: unknown, canWrite: boolean): Promise<SpendingPageView> {
  return { ...(await loadSpending(prisma, workspaceId, safeYear(year), safeMonth(month))), canWrite };
}

export async function getSpending(year: unknown, month: unknown): Promise<Result<SpendingPageView>> {
  try {
    const session = await requireReceiptsSession();
    // Fail closed: any doubt about the permission (a denial, an unreachable check) shows the page read-only.
    const canWrite = await auth.requireAction('receipts.row.write').then(
      () => true,
      () => false,
    );
    return { ok: true, value: await view(sessionWorkspaceId(session), year, month, canWrite) };
  } catch (e) {
    return failure(e);
  }
}

/** Give a counterparty a spending category. */
export async function answerCategory(year: unknown, month: unknown, counterparty: unknown, category: unknown): Promise<Result<SpendingPageView>> {
  try {
    const ctx = await writeContext();
    await setCounterpartyCategory(prisma, ctx, { counterparty, category });
    return { ok: true, value: await view(ctx.workspaceId, year, month, true) };
  } catch (e) {
    return failure(e);
  }
}

/** Take a category answer back, by its stored key. */
export async function withdrawCategory(year: unknown, month: unknown, counterpartyKey: unknown): Promise<Result<SpendingPageView>> {
  try {
    const ctx = await writeContext();
    await removeCounterpartyCategory(prisma, ctx, counterpartyKey);
    return { ok: true, value: await view(ctx.workspaceId, year, month, true) };
  } catch (e) {
    return failure(e);
  }
}

/**
 * The counterparty is one of the owner's own accounts (a credit card paid off
 * from the bank, a savings account): the same answer as in the payments tab,
 * so its payments stop counting as spending everywhere.
 */
export async function markOwnAccount(year: unknown, month: unknown, counterparty: unknown): Promise<Result<SpendingPageView>> {
  try {
    const ctx = await writeContext();
    await setCounterpartyTreatment(prisma, ctx, { counterparty, treatment: 'own_account' });
    return { ok: true, value: await view(ctx.workspaceId, year, month, true) };
  } catch (e) {
    return failure(e);
  }
}
