'use server';

import { auth } from '@/lib/auth';
import { ReceiptsAuthError, requireReceiptsSession } from '@/lib/auth-guards';
import { MissingTenantError, requireSessionTenantId, sessionWorkspaceId } from '@/lib/auth-workspace';
import { prisma } from '@/lib/prisma';
import { BudgetServiceError, loadBudgetsView, saveBudget } from '@/lib/spending/budget-service';
import type { BudgetLine } from '@/lib/spending/budgets';
import { berlinToday } from '@/lib/spending/period';
import { timed } from '@/lib/timing';

/**
 * Server actions of the budgets. Same rules as every action here: the
 * workspace is the session's active one, writes pass the fail-closed
 * `receipts.row.write` check, failures come back with a stable code, and a
 * write answers with the fresh lines.
 */

export type BudgetActionError = 'unauthorized' | 'forbidden' | 'invalid_input' | 'failed';
export type BudgetResult<T> = { ok: true; value: T } | { ok: false; error: BudgetActionError; detail?: string };

export interface BudgetsView {
  lines: BudgetLine[];
  /** The month the lines are for, "YYYY-MM". */
  month: string;
  /** Counterparty names from the payments, to pick one for a budget. */
  counterparties: string[];
  canWrite: boolean;
}

function failure(e: unknown): { ok: false; error: BudgetActionError; detail?: string } {
  if (e instanceof ReceiptsAuthError) return { ok: false, error: e.status === 401 ? 'unauthorized' : 'forbidden' };
  const status = (e as { status?: number })?.status;
  if (status === 401) return { ok: false, error: 'unauthorized' };
  if (status === 403) return { ok: false, error: 'forbidden' };
  if (e instanceof MissingTenantError) return { ok: false, error: 'forbidden' };
  if (e instanceof BudgetServiceError) return { ok: false, error: 'invalid_input', detail: e.code };
  console.error('[spending] budget action failed', e);
  return { ok: false, error: 'failed' };
}

async function view(workspaceId: string, canWrite: boolean): Promise<BudgetsView> {
  const today = berlinToday();
  const { lines, counterparties } = await timed('budgets.view', () => loadBudgetsView(prisma, workspaceId, today, canWrite));
  return { lines, month: today.slice(0, 7), counterparties, canWrite };
}

/**
 * Whether this person may change budgets: a refusal of the write check means
 * read-only; any other failure (the check could not be asked) is an error,
 * never quietly read-only.
 */
async function mayWrite(): Promise<boolean> {
  try {
    await timed('auth.action', () => auth.requireAction('receipts.row.write'));
    return true;
  } catch (e) {
    const status = e instanceof ReceiptsAuthError ? e.status : (e as { status?: number })?.status;
    if (status === 403) return false;
    throw e;
  }
}

export async function getBudgets(): Promise<BudgetResult<BudgetsView>> {
  try {
    const session = await requireReceiptsSession();
    return { ok: true, value: await view(sessionWorkspaceId(session), await mayWrite()) };
  } catch (e) {
    return failure(e);
  }
}

/** Set, switch off or reset a budget (see `saveBudget`). */
export async function setBudget(input: unknown): Promise<BudgetResult<BudgetsView>> {
  try {
    const session = await timed('auth.action', () => auth.requireAction('receipts.row.write'));
    const workspaceId = sessionWorkspaceId(session);
    await saveBudget(prisma, { workspaceId, tenantId: requireSessionTenantId(session, workspaceId) }, input);
    return { ok: true, value: await view(workspaceId, true) };
  } catch (e) {
    return failure(e);
  }
}
