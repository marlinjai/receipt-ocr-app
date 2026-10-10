'use server';

import { auth } from '@/lib/auth';
import { ReceiptsAuthError } from '@/lib/auth-guards';
import { sessionWorkspaceId } from '@/lib/auth-workspace';
import { prisma } from '@/lib/prisma';
import { GroupError, type GroupErrorCode } from '@/lib/groups/rules';
import { createGroup, moveIntoGroup, removeFromGroup } from '@/lib/groups/service';

/**
 * Server actions for groups in the receipts table ("Gruppen").
 *
 * The workspace is the session's ACTIVE one and is never taken from the
 * browser. Failures are RETURNED with a stable code, not thrown: a thrown
 * server-action error reaches the browser with its message stripped, and the
 * page has to say why nothing moved.
 */

export type GroupActionError = 'unauthorized' | 'forbidden' | 'failed' | GroupErrorCode;
export type GroupResult<T> = { ok: true; value: T } | { ok: false; error: GroupActionError };

function failure(e: unknown): { ok: false; error: GroupActionError } {
  if (e instanceof GroupError) return { ok: false, error: e.code };
  if (e instanceof ReceiptsAuthError) {
    return { ok: false, error: e.status === 401 ? 'unauthorized' : e.status === 404 ? 'row_not_found' : 'forbidden' };
  }
  const status = (e as { status?: number })?.status;
  if (status === 401) return { ok: false, error: 'unauthorized' };
  if (status === 403) return { ok: false, error: 'forbidden' };
  // Ids and codes only: no cell value reaches the log.
  console.error('[groups] action failed', e);
  return { ok: false, error: 'failed' };
}

async function writeWorkspace(): Promise<string> {
  return sessionWorkspaceId(await auth.requireAction('receipts.row.write'));
}

/** Create a group, with the given receipts in it. Returns the id of the group. */
export async function createReceiptGroup(name: string, memberRowIds: string[]): Promise<GroupResult<{ groupId: string }>> {
  try {
    return { ok: true, value: { groupId: await createGroup(prisma, await writeWorkspace(), name, memberRowIds) } };
  } catch (e) {
    return failure(e);
  }
}

/** Put receipts into a group. Returns how many were moved. */
export async function moveReceiptsIntoGroup(groupId: string, rowIds: string[]): Promise<GroupResult<{ moved: number }>> {
  try {
    return { ok: true, value: { moved: await moveIntoGroup(prisma, await writeWorkspace(), groupId, rowIds) } };
  } catch (e) {
    return failure(e);
  }
}

/** Take receipts out of their group. Returns how many were moved. */
export async function removeReceiptsFromGroup(rowIds: string[]): Promise<GroupResult<{ moved: number }>> {
  try {
    return { ok: true, value: { moved: await removeFromGroup(prisma, await writeWorkspace(), rowIds) } };
  } catch (e) {
    return failure(e);
  }
}
