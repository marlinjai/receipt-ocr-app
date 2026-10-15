'use server';

import { auth } from '@/lib/auth';
import { ReceiptsAuthError, requireReceiptsSession } from '@/lib/auth-guards';
import { MissingTenantError, requireSessionTenantId, sessionWorkspaceId } from '@/lib/auth-workspace';
import { prisma } from '@/lib/prisma';
import { SpendingServiceError, loadSpending, setCounterpartyCategory, type SpendingContext, type SpendingView } from '@/lib/spending/service';

/**
 * Server actions of the spending overview. Like the finance actions: the
 * workspace is always the session's ACTIVE one and never taken from the
 * browser, writes pass the fail-closed `receipts.row.write` check, failures
 * are returned with a stable code, and every write answers with the freshly
 * computed view.
 */

export type SpendingActionError = 'unauthorized' | 'forbidden' | 'not_found' | 'invalid_input' | 'failed';

export type Result<T> = { ok: true; value: T } | { ok: false; error: SpendingActionError; detail?: string };

function failure(e: unknown): { ok: false; error: SpendingActionError; detail?: string } {
  if (e instanceof ReceiptsAuthError) {
    return { ok: false, error: e.status === 401 ? 'unauthorized' : e.status === 404 ? 'not_found' : 'forbidden' };
  }
  const status = (e as { status?: number })?.status;
  if (status === 401) return { ok: false, error: 'unauthorized' };
  if (status === 403) return { ok: false, error: 'forbidden' };
  if (e instanceof MissingTenantError) return { ok: false, error: 'forbidden' };
  if (e instanceof SpendingServiceError) return { ok: false, error: 'invalid_input', detail: e.code };
  console.error('[spending] action failed', e);
  return { ok: false, error: 'failed' };
}

/** A year a person can sensibly ask for; anything else falls back to the current year. */
function safeYear(year: unknown): number {
  const n = typeof year === 'number' ? year : Number(year);
  const current = new Date().getFullYear();
  return Number.isInteger(n) && n >= 2000 && n <= current + 1 ? n : current;
}

/** 1 to 12, or null for the whole year. */
function safeMonth(month: unknown): number | null {
  const n = typeof month === 'number' ? month : Number(month);
  return Number.isInteger(n) && n >= 1 && n <= 12 ? n : null;
}

async function writeContext(): Promise<SpendingContext> {
  const session = await auth.requireAction('receipts.row.write');
  const workspaceId = sessionWorkspaceId(session);
  return { workspaceId, tenantId: requireSessionTenantId(session, workspaceId) };
}

export async function getSpending(year: unknown, month: unknown): Promise<Result<SpendingView>> {
  try {
    const session = await requireReceiptsSession();
    return { ok: true, value: await loadSpending(prisma, sessionWorkspaceId(session), safeYear(year), safeMonth(month)) };
  } catch (e) {
    return failure(e);
  }
}

/** Give a counterparty a spending category (`category` null takes it back). */
export async function answerCategory(year: unknown, month: unknown, counterparty: unknown, category: unknown): Promise<Result<SpendingView>> {
  try {
    const ctx = await writeContext();
    await setCounterpartyCategory(prisma, ctx, { counterparty, category });
    return { ok: true, value: await loadSpending(prisma, ctx.workspaceId, safeYear(year), safeMonth(month)) };
  } catch (e) {
    return failure(e);
  }
}
