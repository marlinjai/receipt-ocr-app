import 'server-only';
import { prisma } from '@/lib/prisma';

/** The overview's editable notes block for a workspace (empty string if unset). */
export async function getNotes(workspaceId: string): Promise<string> {
  const row = await prisma.workspaceNotes.findUnique({ where: { authWorkspaceId: workspaceId } });
  return row?.body ?? '';
}

export async function setNotes(workspaceId: string, body: string): Promise<void> {
  await prisma.workspaceNotes.upsert({
    where: { authWorkspaceId: workspaceId },
    create: { authWorkspaceId: workspaceId, body },
    update: { body },
  });
}
