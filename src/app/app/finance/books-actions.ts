'use server';

import { auth } from '@/lib/auth';
import { ReceiptsAuthError, requireReceiptsSession } from '@/lib/auth-guards';
import { MissingTenantError, requireSessionTenantId, sessionWorkspaceId } from '@/lib/auth-workspace';
import { prisma } from '@/lib/prisma';
import { loadBooksMirrorView, pullBooksMirror, serverBooksPullDeps, type BooksMirrorView } from '@/lib/tax/books-pull/service';
import { loadStatement, type StatementView } from '@/lib/tax/service';
import type { Result } from './actions';

/**
 * Server actions of the Books mirror ("Einnahmen" tab): the state of the last
 * pull, and "Aus den Books abholen", which runs the same pull as the schedule
 * for the person's ACTIVE company only. Failures come back with a stable code;
 * a failed pull is also recorded, so the tab shows it after a reload.
 */

function failure(e: unknown): { ok: false; error: 'unauthorized' | 'forbidden' | 'failed' } {
  if (e instanceof ReceiptsAuthError) return { ok: false, error: e.status === 401 ? 'unauthorized' : 'forbidden' };
  const status = (e as { status?: number })?.status;
  if (status === 401) return { ok: false, error: 'unauthorized' };
  if (status === 403 || e instanceof MissingTenantError) return { ok: false, error: 'forbidden' };
  console.error('[books-pull] action failed', (e as Error)?.name ?? 'error');
  return { ok: false, error: 'failed' };
}

export async function getBooksMirrorView(): Promise<Result<BooksMirrorView>> {
  try {
    const session = await requireReceiptsSession();
    return { ok: true, value: await loadBooksMirrorView(prisma, sessionWorkspaceId(session)) };
  } catch (e) {
    return failure(e);
  }
}

/** "Aus den Books abholen": pull now, for the active company. */
export async function pullBooksNow(year: number): Promise<Result<{ view: StatementView; mirror: BooksMirrorView }>> {
  try {
    const session = await auth.requireAction('receipts.row.write');
    const workspaceId = sessionWorkspaceId(session);
    const ctx = { workspaceId, tenantId: requireSessionTenantId(session, workspaceId) };
    const outcome = await pullBooksMirror(prisma, serverBooksPullDeps(), { trigger: 'manual', ctx });
    const mirror = await loadBooksMirrorView(prisma, workspaceId);
    if (!outcome.ok) return { ok: false, error: 'invalid_input', detail: `books_pull:${outcome.code}` };
    return { ok: true, value: { view: await loadStatement(prisma, workspaceId, year), mirror } };
  } catch (e) {
    return failure(e);
  }
}
