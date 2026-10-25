'use server';

import { auth } from '@/lib/auth';
import { ReceiptsAuthError, requireReceiptsSession } from '@/lib/auth-guards';
import { MissingTenantError, requireSessionTenantId, sessionWorkspaceId } from '@/lib/auth-workspace';
import { prisma } from '@/lib/prisma';
import { settleAfterOwnNames } from '@/lib/spending/loop-service';
import { SpendingServiceError, loadOwnNames, saveOwnNames } from '@/lib/spending/service';
import type { StatementView } from '@/lib/tax/service';
import { getStatement, type Result } from './actions';

/**
 * The owner's own names under Finanzen, Einstellungen (plan
 * docs/plans/2026-10-25-finance-groups.md, decision 3). The same list as on
 * Ausgaben (`SpendingSettings.ownNames`): the payments read counts a
 * counterparty carrying one of them as an own account where nobody answered
 * it, so a change here answers with the freshly computed statement. Like the
 * other finance actions the workspace is the session's ACTIVE one, writes pass
 * the fail-closed `receipts.row.write` check, and failures are returned with a
 * stable code.
 */

export interface OwnNamesView {
  names: string[];
  canWrite: boolean;
}

function failure(e: unknown): { ok: false; error: 'unauthorized' | 'forbidden' | 'not_found' | 'invalid_input' | 'failed'; detail?: string } {
  if (e instanceof ReceiptsAuthError) return { ok: false, error: e.status === 401 ? 'unauthorized' : e.status === 404 ? 'not_found' : 'forbidden' };
  const status = (e as { status?: number })?.status;
  if (status === 401) return { ok: false, error: 'unauthorized' };
  if (status === 403 || e instanceof MissingTenantError) return { ok: false, error: 'forbidden' };
  if (e instanceof SpendingServiceError) return { ok: false, error: 'invalid_input', detail: e.code };
  console.error('[finance] own names action failed', (e as Error)?.name ?? 'error');
  return { ok: false, error: 'failed' };
}

export async function getOwnNamesView(): Promise<Result<OwnNamesView>> {
  try {
    const session = await requireReceiptsSession();
    // Fail closed: any doubt about the permission shows the list read-only.
    const canWrite = await auth.requireAction('receipts.row.write').then(
      () => true,
      () => false,
    );
    return { ok: true, value: { names: await loadOwnNames(prisma, sessionWorkspaceId(session)), canWrite } };
  } catch (e) {
    return failure(e);
  }
}

/**
 * Add an own name or take one out (`{ add }` or `{ remove }`), as on Ausgaben:
 * the receipt messages about payments to the names leave the queue now
 * (`settledOwnName` says how many). Answers with the names as stored and the
 * statement of `year` (null when it could not be read after the change).
 */
export async function changeOwnNames(
  year: number,
  change: unknown,
): Promise<Result<{ names: string[]; settledOwnName: number; view: StatementView | null }>> {
  let names: string[];
  let settledOwnName = 0;
  try {
    const session = await auth.requireAction('receipts.row.write');
    const workspaceId = sessionWorkspaceId(session);
    names = await saveOwnNames(prisma, { workspaceId, tenantId: requireSessionTenantId(session, workspaceId) }, change);
    try {
      settledOwnName = await settleAfterOwnNames(prisma, workspaceId);
    } catch (e) {
      // The names are kept; the next run of the loop settles the same messages.
      console.error('[finance] settling messages after the own names changed failed', (e as Error)?.name ?? 'error');
    }
  } catch (e) {
    return failure(e);
  }
  // The names are saved either way: a statement that could not be read afterwards is null, never a failure of the change.
  const statement = await getStatement(year);
  return { ok: true, value: { names, settledOwnName, view: statement.ok ? statement.value : null } };
}
