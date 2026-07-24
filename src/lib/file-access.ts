import 'server-only';

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { safeColumnName, safeTableName } from '@marlinjai/data-table-adapter-shared';
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
 * Ownership resolution: receipt images are recorded as `/api/files/<id>` URL
 * strings inside dt_rows.cells (processReceipt writes a url cell, not a
 * dt_files reference), so we look in BOTH places: dt_files.file_id and a
 * cells-JSON containment scan. Every referencing table's workspace is
 * collected; access requires membership of at least one.
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

  // Every table that references this file, via dt_files or a URL cell. Rows
  // live in the legacy shared dt_rows OR in per-table physical tables once a
  // dt table is `migrated`, so BOTH layouts must be scanned — the dt_rows-only
  // scan silently found nothing for migrated rows, turning this check into an
  // allow-by-default for their files.
  const [fileRefs, cellRefs] = await Promise.all([
    prisma.dtFile.findMany({ where: { fileId }, select: { rowId: true } }),
    prisma.$queryRaw<Array<{ table_id: string }>>`
      SELECT DISTINCT table_id FROM dt_rows WHERE cells::text LIKE ${'%' + fileId + '%'}
    `,
  ]);

  const tableIds = new Set<string>(cellRefs.map((r) => r.table_id));
  if (fileRefs.length > 0) {
    const resolved = await resolveRowTableIds(fileRefs.map((r) => r.rowId));
    for (const tableId of resolved.values()) tableIds.add(tableId);
  }

  // URL cells on migrated tables (e.g. Receipt Image's /api/files/<id>): the
  // value sits in that table's physical url columns, not in dt_rows.
  const migrated = await prisma.dtTable.findMany({ where: { migrated: true }, select: { id: true } });
  for (const { id: tableId } of migrated) {
    if (tableIds.has(tableId)) continue;
    const urlCols = await prisma.dtColumn.findMany({
      where: { tableId, type: 'url' },
      select: { id: true },
    });
    if (urlCols.length === 0) continue;
    const clause = urlCols.map((c) => `${safeColumnName(c.id)} LIKE $1`).join(' OR ');
    const hits = await prisma
      .$queryRawUnsafe<unknown[]>(
        `SELECT 1 FROM ${safeTableName(tableId)} WHERE ${clause} LIMIT 1`,
        `%${fileId}%`,
      )
      .catch(() => [] as unknown[]);
    if (hits.length > 0) tableIds.add(tableId);
  }

  // Unreferenced = the fresh-upload window; see module docblock.
  if (tableIds.size === 0) return null;

  const tables = await prisma.dtTable.findMany({
    where: { id: { in: [...tableIds] } },
    select: { workspaceId: true },
  });
  const session = {
    memberships: principal.memberships,
    activeWorkspace: principal.activeWorkspace,
  };
  const allowed = tables.some((t) => sessionMayAccessWorkspace(session, t.workspaceId));
  if (allowed) return null;

  // Same shape as an SB miss so foreign ids are indistinguishable from
  // nonexistent ones.
  return NextResponse.json({ error: 'not found' }, { status: 404 });
}
