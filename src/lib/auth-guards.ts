import 'server-only';

import type { AppSession } from '@marlinjai/auth-brain-nextjs';
import { prisma } from '@/lib/prisma';
import { auth, type ReceiptsAction } from '@/lib/auth';
import { sessionMayAccessWorkspace, sessionWorkspaceId } from '@/lib/auth-workspace';

export { sessionMayAccessWorkspace, sessionWorkspaceId };

/**
 * Server-action authorization for the data layer.
 *
 * The middleware is the outer fence (session + >=1 receipts workspace). These
 * helpers are the inner, per-resource checks at the boundary of every server
 * action that touches dt_* rows: the browser addresses resources by opaque
 * ids (tableId / rowId / columnId / viewId / optionId), so each id is
 * resolved server-side to its OWNING workspace and checked against the
 * verified membership set. A member of receipts-lola-stories can never read
 * or write receipts-marlinjai data by guessing ids.
 *
 * Fail-closed: no session, unknown resource, non-member workspace, and any
 * OpenFGA error all deny. The dev-bypass session (no memberships,
 * development only) is scoped to the local dev workspace instead.
 */

export class ReceiptsAuthError extends Error {
  readonly status: 401 | 403 | 404;
  constructor(status: 401 | 403 | 404) {
    super(status === 401 ? 'unauthorized' : status === 403 ? 'forbidden' : 'not_found');
    this.name = 'ReceiptsAuthError';
    this.status = status;
  }
}

/** True when this session is the development-only bypass (no memberships). */
function isDevBypass(session: AppSession): boolean {
  return session.memberships.length === 0;
}

/** The verified session, or a thrown 401. */
export async function requireReceiptsSession(): Promise<AppSession> {
  const session = await auth.getSession();
  if (!session) throw new ReceiptsAuthError(401);
  return session;
}


/**
 * Authorize access to a table. Read access = membership of the owning
 * workspace; pass a `write` action to additionally run the fail-closed
 * OpenFGA check (skipped for the dev bypass, which has no real workspace).
 */
export async function requireTableAccess(
  tableId: string,
  write?: ReceiptsAction,
): Promise<{ session: AppSession; workspaceId: string }> {
  const session = await requireReceiptsSession();
  const table = await prisma.dtTable.findUnique({
    where: { id: tableId },
    select: { workspaceId: true },
  });
  if (!table) throw new ReceiptsAuthError(404);
  if (!sessionMayAccessWorkspace(session, table.workspaceId)) {
    throw new ReceiptsAuthError(403);
  }
  if (write && !isDevBypass(session)) {
    await auth.requireAction(write, table.workspaceId);
  }
  return { session, workspaceId: table.workspaceId };
}

/** Resolve a row to its table and authorize like {@link requireTableAccess}. */
export async function requireRowAccess(rowId: string, write?: ReceiptsAction) {
  const row = await prisma.dtRow.findUnique({ where: { id: rowId }, select: { tableId: true } });
  if (!row) throw new ReceiptsAuthError(404);
  return requireTableAccess(row.tableId, write);
}

/** Resolve a column to its table and authorize. */
export async function requireColumnAccess(columnId: string, write?: ReceiptsAction) {
  const column = await prisma.dtColumn.findUnique({
    where: { id: columnId },
    select: { tableId: true },
  });
  if (!column) throw new ReceiptsAuthError(404);
  return requireTableAccess(column.tableId, write);
}

/** Resolve a select option to its column's table and authorize. */
export async function requireSelectOptionAccess(optionId: string, write?: ReceiptsAction) {
  const option = await prisma.selectOption.findUnique({
    where: { id: optionId },
    select: { columnId: true },
  });
  if (!option) throw new ReceiptsAuthError(404);
  return requireColumnAccess(option.columnId, write);
}

/** Resolve a file reference to its row's table and authorize. */
export async function requireFileRefAccess(fileRefId: string, write?: ReceiptsAction) {
  const ref = await prisma.dtFile.findUnique({ where: { id: fileRefId }, select: { rowId: true } });
  if (!ref) throw new ReceiptsAuthError(404);
  return requireRowAccess(ref.rowId, write);
}

/** Resolve a view to its table and authorize. */
export async function requireViewAccess(viewId: string, write?: ReceiptsAction) {
  const view = await prisma.dtView.findUnique({ where: { id: viewId }, select: { tableId: true } });
  if (!view) throw new ReceiptsAuthError(404);
  return requireTableAccess(view.tableId, write);
}
