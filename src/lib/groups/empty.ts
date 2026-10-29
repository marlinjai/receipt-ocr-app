import 'server-only';
import type { PrismaClient } from '@prisma/client';
import { deleteReceiptRows, tableContext } from '@/lib/meals/service';
import { rowKindColumnId } from '@/lib/receipts-kind';
import { emptyGroupIds } from './links';

/**
 * A group with no receipts left goes by itself, the way an empty group does in
 * Notion (the owner, 2026-10-29: "empty groups should delete themselves
 * automatically"). Every path that takes a receipt out of a group calls this
 * with the groups it touched: a move into another group, taking receipts out,
 * a delete, an archive. The automatic grouping calls it without candidates and
 * sweeps whatever a path outside these left behind.
 *
 * The group goes through the receipts' own delete, so everything that hangs off
 * a row id goes with it and an archived receipt that still pointed at it is put
 * at the top level. A group never carries a file; should one ever have one, the
 * delete refuses and the group stays. Returns the ids removed. A failure is
 * logged and never fails the request that emptied the group: the next sweep
 * finds it again.
 */
export async function removeEmptyGroups(db: PrismaClient, workspaceId: string, candidates?: readonly string[]): Promise<string[]> {
  if (candidates && candidates.length === 0) return [];
  try {
    const ctx = await tableContext(db, workspaceId);
    const kindId = ctx ? rowKindColumnId(ctx.columns) : null;
    if (!ctx || !kindId) return [];
    const ids = await emptyGroupIds(db, ctx.tableId, kindId, candidates);
    if (ids.length === 0) return [];
    const result = await deleteReceiptRows(db, { workspaceId, tenantId: null }, ids, { deleteStoredFile: refuseStoredFile });
    return result.done;
  } catch (e) {
    console.error('[groups] removing empty groups failed', e instanceof Error ? e.name : 'error');
    return [];
  }
}

/** A group has no stored file of its own; the delete is refused rather than a file of someone else's removed. */
async function refuseStoredFile(): Promise<void> {
  throw new Error('a group carries no stored file');
}
