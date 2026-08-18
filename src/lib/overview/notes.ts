import 'server-only';
import { prisma } from '@/lib/prisma';

/** The overview's editable notes block for a workspace (empty string if unset). */
export async function getNotes(workspaceId: string): Promise<string> {
  const row = await prisma.workspaceNotes.findUnique({ where: { authWorkspaceId: workspaceId } });
  return row?.body ?? '';
}

/**
 * `tenantId` is stamped on CREATE only. An update leaves it alone: the owning
 * company of an existing row is a fact about that row, not about whoever edits
 * it next, and rewriting it on every save would let a re-attribution slip in
 * silently. Backfill is the only thing that sets it on existing rows.
 */
export async function setNotes(
  workspaceId: string,
  body: string,
  tenantId: string | null,
): Promise<void> {
  await prisma.workspaceNotes.upsert({
    where: { authWorkspaceId: workspaceId },
    create: { authWorkspaceId: workspaceId, body, authTenantId: tenantId },
    update: { body },
  });
}
