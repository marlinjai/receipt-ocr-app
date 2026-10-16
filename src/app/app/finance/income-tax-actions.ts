'use server';

import { auth } from '@/lib/auth';
import { ReceiptsAuthError } from '@/lib/auth-guards';
import { MissingTenantError, requireSessionTenantId, sessionWorkspaceId } from '@/lib/auth-workspace';
import { prisma } from '@/lib/prisma';
import { IncomeTaxInputError } from '@/lib/tax/income-tax/input';

/** A save for another year than the one on screen would answer with a view that does not show it: refused. */
function sameYear(year: number, input: unknown): void {
  if ((input as { year?: unknown } | null)?.year !== year) throw new IncomeTaxInputError('invalid_year');
}
import {
  IncomeTaxServiceError,
  deleteReturnItem,
  deleteWageEntry,
  saveChurchMonths,
  saveFederalState,
  saveReturnItem,
  saveWageEntry,
  type IncomeTaxContext,
} from '@/lib/tax/income-tax/service';
import { RULE_YEARS } from '@/lib/tax/rules';
import { loadStatement, type StatementView } from '@/lib/tax/service';
import type { FinanceActionError, Result } from './actions';

/**
 * Server actions for wages, return items and the church tax months (the
 * income tax estimate). Same contract as the other finance actions: the
 * workspace is the session's active one, never taken from the browser;
 * writes pass `receipts.row.write`; failures come back as a stable code; every
 * write answers with the freshly computed statement, estimate included.
 */

function failure(e: unknown): { ok: false; error: FinanceActionError; detail?: string } {
  if (e instanceof ReceiptsAuthError) {
    return { ok: false, error: e.status === 401 ? 'unauthorized' : e.status === 404 ? 'not_found' : 'forbidden' };
  }
  const status = (e as { status?: number })?.status;
  if (status === 401) return { ok: false, error: 'unauthorized' };
  if (status === 403) return { ok: false, error: 'forbidden' };
  if (e instanceof MissingTenantError) return { ok: false, error: 'forbidden' };
  if (e instanceof IncomeTaxInputError) return { ok: false, error: 'invalid_input', detail: e.code };
  if (e instanceof IncomeTaxServiceError) {
    return e.code === 'wage_entry_taken' ? { ok: false, error: 'invalid_input', detail: e.code } : { ok: false, error: 'not_found', detail: e.code };
  }
  console.error('[finance] income tax action failed', e);
  return { ok: false, error: 'failed' };
}

function safeYear(year: unknown): number {
  const n = typeof year === 'number' ? year : Number(year);
  const current = new Date().getFullYear();
  const oldest = Math.min(...RULE_YEARS) - 10;
  return Number.isInteger(n) && n >= oldest && n <= current + 1 ? n : current;
}

async function write(year: number, run: (ctx: IncomeTaxContext) => Promise<unknown>): Promise<Result<StatementView>> {
  try {
    const session = await auth.requireAction('receipts.row.write');
    const workspaceId = sessionWorkspaceId(session);
    const ctx = { workspaceId, tenantId: requireSessionTenantId(session, workspaceId) };
    await run(ctx);
    return { ok: true, value: await loadStatement(prisma, ctx.workspaceId, safeYear(year)) };
  } catch (e) {
    return failure(e);
  }
}

/** Record a wage statement or pay slip (`wageId` null) or change one; checked by `validateWageInput`. */
export async function saveWage(year: number, wageId: string | null, input: unknown): Promise<Result<StatementView>> {
  return write(year, (ctx) => {
    sameYear(year, input);
    return saveWageEntry(prisma, ctx, wageId === null ? null : String(wageId), input);
  });
}

export async function removeWage(year: number, wageId: string): Promise<Result<StatementView>> {
  return write(year, (ctx) => deleteWageEntry(prisma, ctx, String(wageId)));
}

/** Record another item of the return (`itemId` null) or change one; checked by `validateReturnItemInput`. */
export async function saveTaxReturnItem(year: number, itemId: string | null, input: unknown): Promise<Result<StatementView>> {
  return write(year, (ctx) => {
    sameYear(year, input);
    return saveReturnItem(prisma, ctx, itemId === null ? null : String(itemId), input);
  });
}

export async function removeTaxReturnItem(year: number, itemId: string): Promise<Result<StatementView>> {
  return write(year, (ctx) => deleteReturnItem(prisma, ctx, String(itemId)));
}

/** The months church tax was due in a year (twelve flags), or null to clear the statement. */
export async function setChurchMonths(year: number, churchMonths: unknown): Promise<Result<StatementView>> {
  return write(year, (ctx) => saveChurchMonths(prisma, ctx, { year, churchMonths }));
}

export async function setFederalState(year: number, federalState: unknown): Promise<Result<StatementView>> {
  return write(year, (ctx) => saveFederalState(prisma, ctx, federalState));
}
