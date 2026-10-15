import 'server-only';

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { auth } from '@/lib/auth';
import { sessionMayAccessWorkspace } from '@/lib/auth-workspace';
import { resolveRowTableIds } from '@/lib/auth-guards';

/**
 * Workspace-ownership guard for the fileId proxy routes (/api/files/:id,
 * /api/upload/complete/:id, /api/ocr). The middleware already authenticated
 * the request; this closes the cross-company hole: a member of one receipts
 * workspace must not pull another company's invoice bytes by supplying a
 * foreign fileId.
 *
 * Ownership resolution: every file lives in the dt_files reference junction
 * (the Receipt Image column is a native file column). Every referencing
 * table's workspace is collected; access requires membership of at least one.
 *
 * The fresh-upload window: /api/ocr and /api/upload/complete run BEFORE
 * processReceipt creates the row, so a brand-new fileId has no reference yet.
 * An unreferenced fileId is allowed for any authenticated member: the id is
 * an unguessable random UUID that only the uploader's browser holds, and it
 * leaks nothing recorded in any workspace. The moment a row references the
 * file, ownership is enforced.
 *
 * Service-token callers stay unscoped (machine path, e.g. smoke tests), same
 * precedence as everywhere else. Fail-closed for everything else.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Returns null when the caller may access `fileId`, or a ready-to-send error
 * response otherwise.
 */
export async function guardFileAccess(
  req: NextRequest,
  fileId: string,
): Promise<NextResponse | null> {
  if (!UUID_RE.test(fileId)) {
    return NextResponse.json({ error: 'invalid file id' }, { status: 400 });
  }

  const principal = await auth.verifyRequest(req);
  if (principal.kind === 'service') return null;
  if (principal.kind !== 'user') {
    // Defense in depth: the middleware should have 401'd already.
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  // Dev bypass (development only): no real memberships to check against.
  if (principal.memberships.length === 0) return null;

  const workspaceIds = await workspacesReferencing(fileId);

  // Unreferenced = the fresh-upload window; see module docblock.
  if (workspaceIds.length === 0) return null;

  const session = {
    memberships: principal.memberships,
    activeWorkspace: principal.activeWorkspace,
  };
  const allowed = workspaceIds.some((id) => sessionMayAccessWorkspace(session, id));
  if (allowed) return null;

  // Same shape as an SB miss so foreign ids are indistinguishable from
  // nonexistent ones.
  return NextResponse.json({ error: 'not found' }, { status: 404 });
}

/**
 * The workspaces whose tables reference this file. Since the Receipt Image
 * column migrated to the native file type (2026-08-03), the file-reference
 * junction is the single source of truth: nothing records fileIds in cells
 * anymore.
 */
async function workspacesReferencing(fileId: string): Promise<string[]> {
  const fileRefs = await prisma.dtFile.findMany({ where: { fileId }, select: { rowId: true } });
  if (fileRefs.length === 0) return [];
  const resolved = await resolveRowTableIds(fileRefs.map((r) => r.rowId));
  const tableIds = [...new Set(resolved.values())];
  if (tableIds.length === 0) return [];
  const tables = await prisma.dtTable.findMany({ where: { id: { in: tableIds } }, select: { workspaceId: true } });
  return [...new Set(tables.map((t) => t.workspaceId))];
}

/**
 * Whether the caller may read the details of one file REFERENCE (its stored
 * rotation and file name), given the row that holds it. `guardFileAccess`
 * proves access to the file through SOME workspace; a file referenced from two
 * workspaces must still not hand one company the other's reference details.
 * Same precedence as the guard: service callers and the development bypass
 * are unscoped, everything else must be a member of the row's workspace.
 */
export async function fileReferenceOpenToRequest(req: NextRequest, rowId: string): Promise<boolean> {
  const principal = await auth.verifyRequest(req);
  if (principal.kind === 'service') return true;
  if (principal.kind !== 'user') return false;
  if (principal.memberships.length === 0) return true;
  const tableId = (await resolveRowTableIds([rowId])).get(rowId);
  if (!tableId) return false;
  const table = await prisma.dtTable.findUnique({ where: { id: tableId }, select: { workspaceId: true } });
  if (!table) return false;
  return sessionMayAccessWorkspace(
    { memberships: principal.memberships, activeWorkspace: principal.activeWorkspace },
    table.workspaceId,
  );
}

/**
 * The same rule for a server action that is handed a file id by the browser
 * and works for ONE workspace: the file must be fresh (referenced nowhere) or
 * referenced by that workspace. Without it, a receipt could be saved with
 * another company's file id, and its page read into the caller's row.
 */
export async function fileOpenToWorkspace(fileId: string, workspaceId: string): Promise<boolean> {
  if (!UUID_RE.test(fileId)) return false;
  const workspaceIds = await workspacesReferencing(fileId);
  return workspaceIds.length === 0 || workspaceIds.includes(workspaceId);
}
